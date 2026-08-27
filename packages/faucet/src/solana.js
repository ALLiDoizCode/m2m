// ---------------------------------------------------------------------------
// Solana faucet drip
// ---------------------------------------------------------------------------
// USDC only (owner decision, issue #945 — supersedes #691 and #258/#379's SOL
// leg entirely, not just hardens it): MINT mock USDC straight to the recipient,
// auto-creating their associated token account (ATA) if it does not exist yet.
// Treasury SOL is scarce and not self-replenishing (toon-meta#258); gas
// provisioning is not this faucet's job — recipients get SOL for fees from
// the chain's own faucet.
//
// MINT, not transfer. This faucet's keypair is the mint's own MINT AUTHORITY,
// so a drip coins fresh tokens rather than spending a finite balance, exactly
// like the Base Sepolia leg's ungated `mint()` (see base-sepolia.js). The
// keypair still pays every fee and the recipient's ATA rent, so it needs SOL —
// but it never needs USDC, and no one has to remember to top it up. The
// previous transfer-from-treasury shape is why the devnet leg sat dead: the
// 2026-07-18 mint's authority key was lost, so nobody could refill the
// treasury and nobody could mint. Whoever runs a box now creates the mint with
// `infra/linode-faucet/create-devnet-usdc-mint.sh`, which makes that box's own
// treasury the authority.
//
// Locally the same code path works unchanged: infra/solana/create-usdc-mint.sh
// seeds the deterministic local-validator mint with usdc-authority.json as its
// authority, and docker-compose.yml mounts exactly that keypair.
//
// Everything here is OPTIONAL: if SOLANA_FAUCET_KEYPAIR / the RPC are not
// configured (e.g. an EVM-only deploy), `createSolanaFaucet` returns null and
// the route answers a clear 503 instead of crashing the whole service.
import fs from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { createDripLimiter } from './drip-limiter.js';

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'http://solana-validator:8899';
const SOLANA_USDC_MINT = process.env.SOLANA_USDC_MINT || '';
const SOLANA_FAUCET_KEYPAIR = process.env.SOLANA_FAUCET_KEYPAIR || '/keys/usdc-authority.json';
// 6 decimals — real-USDC standard, matches infra/solana/create-usdc-mint.sh.
const SOLANA_USDC_DECIMALS = Number(process.env.SOLANA_USDC_DECIMALS || '6');
const SOLANA_USDC_AMOUNT = Number(process.env.SOLANA_USDC_AMOUNT || '1000'); // USDC per drip
// Per-address cooldown (default 24h). Nothing on-chain bounds a mint whose
// authority we hold, so this service-side window is the only thing standing
// between one address and unlimited mock USDC. Mirrors BASE_SEPOLIA_COOLDOWN_MS,
// which bounds the equally ungated Base Sepolia mint.
const SOLANA_DRIP_COOLDOWN_MS = Number(
  process.env.SOLANA_DRIP_COOLDOWN_MS || String(24 * 60 * 60 * 1000)
);

// ── Wedged-validator guards (issues #277 / #348) ────────────────────────────
// The devnet validator has a failure mode where block production HALTS while
// the RPC stays up and `/health` still answers "ok" (seen live: `getSlot`
// frozen for 15+ minutes at the same slot while the RPC kept accepting
// airdrop txs that could never land). Before this guard, a drip against a
// wedged validator burned 30–90s in confirmation waits and then 500'd with
// the misleading "Transaction was not confirmed in 30.00 seconds".
//
// Two defenses:
//  1. assertSlotAdvancing — a ~1.5–3s pre-flight probe that turns "validator
//     wedged" into an immediate, honest VALIDATOR_STALLED error (routed as 503).
//  2. withDeadline — a wall-clock cap on the whole drip so a validator that
//     wedges MID-drip cannot hang the request queue forever (the blockhash
//     expiry we otherwise rely on never fires when block height stops moving).
//
// Probe timing: the healthy devnet validator produces ~2.3 slots/s (observed
// via getRecentPerformanceSamples, ~138 slots/60s), so a live chain advances
// within one 1.5s probe interval essentially always; two intervals (3s) before
// declaring a stall is already very conservative.
const SLOT_PROBE_INTERVAL_MS = Number(process.env.SOLANA_SLOT_PROBE_INTERVAL_MS || '1500');
// Deadline: a healthy USDC drip (up to 2 txs — recipient ATA creation and the
// mint itself, plus a one-off `getMint` authority read — at 'confirmed' commitment,
// ~2.3 slots/s) completes in well under 15s; a single blockhash validity
// window (150 blocks) is ~65s. 90s ≥ one full window + margin, so the deadline
// can only fire when the chain genuinely stalls mid-drip.
const SOLANA_DRIP_DEADLINE_MS = Number(process.env.SOLANA_DRIP_DEADLINE_MS || '90000');

// Probes `getSlot()` (an async () => number) until it advances past its first
// reading. Resolves with the advanced slot; throws VALIDATOR_STALLED after
// `probes` intervals with no movement. Exported for tests.
export async function assertSlotAdvancing(
  getSlot,
  { intervalMs = SLOT_PROBE_INTERVAL_MS, probes = 2 } = {}
) {
  const first = await getSlot();
  for (let i = 0; i < probes; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const next = await getSlot();
    if (next > first) return next;
  }
  const err = new Error(
    `Solana validator is not producing blocks (slot stuck at ${first} for ` +
      `${((probes * intervalMs) / 1000).toFixed(1)}s). The devnet validator needs ` +
      'operator attention — transactions cannot confirm until it advances.'
  );
  err.code = 'VALIDATOR_STALLED';
  throw err;
}

// Caps `promise` at `ms` wall-clock; rejection carries VALIDATOR_STALLED so the
// route maps it to a 503. Exported for tests.
export function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(
        `${label} did not complete within ${(ms / 1000).toFixed(0)}s — the validator ` +
          'likely stalled mid-drip (block production halted, so confirmations can never land).'
      );
      err.code = 'VALIDATOR_STALLED';
      reject(err);
    }, ms);
  });
  // No unref: the timer is always cleared when the drip settles, and while
  // pending it SHOULD keep the process alive (a deadline that silently never
  // fires because the loop drained would defeat the guard).
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function loadKeypair(path) {
  const raw = fs.readFileSync(path, 'utf8');
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

// Returns a faucet object, or null if Solana is not configured for this deploy.
export function createSolanaFaucet() {
  if (!SOLANA_USDC_MINT) {
    console.log('ℹ️  Solana faucet disabled: SOLANA_USDC_MINT not set.');
    return null;
  }
  if (!fs.existsSync(SOLANA_FAUCET_KEYPAIR)) {
    console.log(`ℹ️  Solana faucet disabled: keypair not found at ${SOLANA_FAUCET_KEYPAIR}.`);
    return null;
  }

  let mint;
  let authority;
  try {
    mint = new PublicKey(SOLANA_USDC_MINT);
    authority = loadKeypair(SOLANA_FAUCET_KEYPAIR);
  } catch (error) {
    console.error('❌ Solana faucet config invalid:', error.message);
    return null;
  }

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

  // Per-address off-chain cooldown (claim BEFORE the drip; released on
  // failure) — protects the treasury's USDC balance from being drained by
  // repeat requests from a single address.
  const limiter = createDripLimiter({ cooldownMs: SOLANA_DRIP_COOLDOWN_MS });

  console.log(`✅ Solana faucet enabled: RPC ${SOLANA_RPC_URL}`);
  console.log(`   USDC mint:   ${mint.toBase58()}`);
  console.log(`   Mint authority (this faucet): ${authority.publicKey.toBase58()}`);
  console.log(`   Per drip:    ${SOLANA_USDC_AMOUNT} USDC (freshly minted)`);
  console.log(`   Cooldown:    ${SOLANA_DRIP_COOLDOWN_MS / 3_600_000}h per address`);

  // Memoised result of the one on-chain check this leg cannot do at
  // construction: that `mint`'s authority really is our keypair, and that its
  // decimals match what we price a drip in. Deliberately NOT done in the
  // factory — `createSolanaFaucet` is synchronous and dials nothing, which is
  // what lets routes.test.js boot the whole server against an unreachable RPC
  // and lets solana-treasury.test.js point at 127.0.0.1:1. index.js kicks this
  // off once in the background at boot so a misconfigured box says so in its
  // logs immediately; a drip awaits it either way.
  let authorityCheck = null;

  async function assertMintAuthority() {
    if (!authorityCheck) {
      authorityCheck = (async () => {
        const info = await getMint(connection, mint);
        const actual = info.mintAuthority?.toBase58() ?? null;
        const ours = authority.publicKey.toBase58();
        if (actual !== ours) {
          const err = new Error(
            `${mint.toBase58()}'s mint authority is ${actual ?? 'none (minting is disabled forever)'}, ` +
              `not this faucet's keypair ${ours}. This leg mints on demand, so it can only serve a ` +
              'mint it is the authority of — create one with ' +
              'infra/linode-faucet/create-devnet-usdc-mint.sh and set SOLANA_USDC_MINT to it.'
          );
          err.code = 'MINT_AUTHORITY_MISMATCH';
          throw err;
        }
        if (info.decimals !== SOLANA_USDC_DECIMALS) {
          const err = new Error(
            `${mint.toBase58()} has ${info.decimals} decimals, but this faucet is configured for ` +
              `${SOLANA_USDC_DECIMALS} (SOLANA_USDC_DECIMALS). A drip would be off by ` +
              `10^${Math.abs(info.decimals - SOLANA_USDC_DECIMALS)}.`
          );
          err.code = 'MINT_AUTHORITY_MISMATCH';
          throw err;
        }
        return info;
      })().catch((error) => {
        // Never cache a failure caused by an unreachable RPC: that would pin a
        // transient outage as a permanent misconfiguration until restart. A
        // real mismatch is re-read on the next drip and fails again, cheaply.
        authorityCheck = null;
        throw error;
      });
    }
    return authorityCheck;
  }

  return {
    rpcUrl: SOLANA_RPC_URL,
    mint: mint.toBase58(),
    treasury: authority.publicKey.toBase58(),
    usdcAmount: SOLANA_USDC_AMOUNT,
    cooldownMs: SOLANA_DRIP_COOLDOWN_MS,
    // Mirrors base-sepolia.js's `mintMode: 'ungated-mint'`: says in /api/info
    // WHY this leg can never run dry, so an operator reading the capability map
    // does not go looking for a treasury balance that is not the mechanism.
    mintMode: 'faucet-is-mint-authority',
    assertMintAuthority,

    isValidAddress(address) {
      try {
        // PublicKey throws on a malformed base58 / wrong-length key.
        // eslint-disable-next-line no-new
        new PublicKey(address);
        return true;
      } catch {
        return false;
      }
    },

    // Per-address cooldown wrappers (route claims before enqueue, releases on
    // failure — mirrors the Base Sepolia leg). Addresses are
    // base58 Solana pubkeys, used as-is (unlike EVM's checksum normalization).
    claim(address) {
      return limiter.claim(address);
    },
    release(address) {
      limiter.release(address);
    },

    // USDC-only drip: fresh tokens minted straight to the recipient. THIS
    // FAUCET (not the recipient) pays the tx fee + ATA rent, so it works even
    // if the recipient holds 0 SOL — they get SOL for gas from the chain's own
    // faucet.
    async drip(address) {
      // Refuse before touching the chain if we are not this mint's authority:
      // every `mintTo` below would fail anyway, and the SPL error for it names
      // no address. Memoised, so this is one RPC read per process.
      await assertMintAuthority();
      // Fail fast (~1.5–3s) with an honest VALIDATOR_STALLED error when the
      // validator is wedged, instead of burning 30–90s in confirmation waits
      // that end in a misleading "not confirmed in 30.00 seconds" 500.
      await assertSlotAdvancing(() => connection.getSlot('processed'));
      // Cap the whole drip so a MID-drip stall cannot hang the request queue.
      return withDeadline(dripInner(address), SOLANA_DRIP_DEADLINE_MS, 'Solana drip');
    },

    // Release the RPC websocket @solana/web3.js holds under this faucet's
    // Connection. Teardown-only: the faucet's Connection is otherwise
    // unreachable from outside, and a websocket whose validator has already
    // gone away retries its reconnect forever, pinning the caller's event
    // loop — which is exactly the state an integration test is in after it
    // kills its disposable validator. A deliberate close beforehand is
    // final. No-op if the socket never connected.
    close() {
      try {
        connection._rpcWebSocket.close();
      } catch {
        // Never connected — nothing holding the loop, nothing to release.
      }
    },
  };

  // Mint fresh USDC to the recipient, auto-creating their ATA (this faucet is
  // the fee payer + rent payer, so the recipient needs no SOL for this leg).
  // There is no source ATA: the tokens do not exist until this call, which is
  // why the leg cannot run dry. Returns the `usdc` result object.
  async function mintUsdc(recipient) {
    const destAta = await getOrCreateAssociatedTokenAccount(
      connection,
      authority, // fee payer creates the recipient ATA if missing
      mint,
      recipient
    );

    const rawAmount = BigInt(Math.round(SOLANA_USDC_AMOUNT * 10 ** SOLANA_USDC_DECIMALS));
    const usdcSig = await mintTo(
      connection,
      authority, // fee payer
      mint,
      destAta.address,
      authority, // mint authority
      rawAmount
    );
    console.log(`  📤 Minted ${SOLANA_USDC_AMOUNT} USDC: ${usdcSig}`);
    return {
      signature: usdcSig,
      amount: String(SOLANA_USDC_AMOUNT),
      mint: mint.toBase58(),
      ata: destAta.address.toBase58(),
    };
  }

  // Drip body — one mint to the recipient, no other on-chain action.
  async function dripInner(address) {
    const recipient = new PublicKey(address);
    const usdc = await mintUsdc(recipient);
    return { usdc };
  }
}
