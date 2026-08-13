// ---------------------------------------------------------------------------
// Solana faucet drip
// ---------------------------------------------------------------------------
// USDC only (owner decision, issue #945 — supersedes #691 and #258/#379's SOL
// leg entirely, not just hardens it): transfer mock USDC from the committed
// devnet treasury authority (usdc-authority.json), auto-creating the
// recipient's associated token account (ATA) if it does not exist yet.
// Treasury SOL is scarce and not self-replenishing (toon-meta#258); gas
// provisioning is not this faucet's job — recipients get SOL for fees from
// the chain's own faucet.
//
// The treasury keypair + USDC mint are the SAME deterministic devnet identities
// seeded by infra/solana/create-usdc-mint.sh, so peers can hardcode them.
//
// Everything here is OPTIONAL: if SOLANA_FAUCET_KEYPAIR / the RPC are not
// configured (e.g. an EVM-only deploy), `createSolanaFaucet` returns null and
// the route answers a clear 503 instead of crashing the whole service.
import fs from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, transfer } from '@solana/spl-token';
import { createDripLimiter } from './drip-limiter.js';

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'http://solana-validator:8899';
const SOLANA_USDC_MINT = process.env.SOLANA_USDC_MINT || '';
const SOLANA_FAUCET_KEYPAIR = process.env.SOLANA_FAUCET_KEYPAIR || '/keys/usdc-authority.json';
// 6 decimals — real-USDC standard, matches infra/solana/create-usdc-mint.sh.
const SOLANA_USDC_DECIMALS = Number(process.env.SOLANA_USDC_DECIMALS || '6');
const SOLANA_USDC_AMOUNT = Number(process.env.SOLANA_USDC_AMOUNT || '1000'); // USDC per drip
// Per-address cooldown (default 24h) — protects the treasury's USDC balance
// from being drained by repeat requests from a single address. Mirrors
// BASE_SEPOLIA_COOLDOWN_MS / MINA_USDC_COOLDOWN_HOURS.
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
// Deadline: a healthy USDC drip (up to 3 treasury txs — source ATA creation,
// recipient ATA creation, the transfer itself — at 'confirmed' commitment,
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
  console.log(`   Treasury:    ${authority.publicKey.toBase58()}`);
  console.log(`   Per drip:    ${SOLANA_USDC_AMOUNT} USDC`);
  console.log(`   Cooldown:    ${SOLANA_DRIP_COOLDOWN_MS / 3_600_000}h per address`);

  return {
    rpcUrl: SOLANA_RPC_URL,
    mint: mint.toBase58(),
    treasury: authority.publicKey.toBase58(),
    usdcAmount: SOLANA_USDC_AMOUNT,
    cooldownMs: SOLANA_DRIP_COOLDOWN_MS,

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
    // failure — mirrors the Base Sepolia / Mina USDC legs). Addresses are
    // base58 Solana pubkeys, used as-is (unlike EVM's checksum normalization).
    claim(address) {
      return limiter.claim(address);
    },
    release(address) {
      limiter.release(address);
    },

    // USDC-only drip: a plain treasury→recipient token transfer. The
    // TREASURY (not the recipient) pays the tx fee + ATA rent, so this works
    // even if the recipient currently holds 0 SOL — recipients get SOL for
    // gas from the chain's own faucet (mirrors the Mina
    // `/api/mina/usdc-request` USDC-only leg).
    async drip(address) {
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

  // Transfer USDC from the treasury to the recipient, auto-creating the recipient
  // ATA (the treasury is the fee payer + rent payer, so the recipient needs no
  // SOL for this leg). Returns the `usdc` result object.
  async function transferUsdc(recipient) {
    const sourceAta = await getOrCreateAssociatedTokenAccount(
      connection,
      authority, // fee payer
      mint,
      authority.publicKey
    );
    const destAta = await getOrCreateAssociatedTokenAccount(
      connection,
      authority, // fee payer creates the recipient ATA if missing
      mint,
      recipient
    );

    const rawAmount = BigInt(Math.round(SOLANA_USDC_AMOUNT * 10 ** SOLANA_USDC_DECIMALS));
    const usdcSig = await transfer(
      connection,
      authority, // fee payer
      sourceAta.address,
      destAta.address,
      authority, // source token-account owner
      rawAmount
    );
    console.log(`  📤 Transferred ${SOLANA_USDC_AMOUNT} USDC: ${usdcSig}`);
    return {
      signature: usdcSig,
      amount: String(SOLANA_USDC_AMOUNT),
      mint: mint.toBase58(),
      ata: destAta.address.toBase58(),
    };
  }

  // Drip body — a treasury→recipient USDC transfer, no other on-chain action.
  async function dripInner(address) {
    const recipient = new PublicKey(address);
    const usdc = await transferUsdc(recipient);
    return { usdc };
  }
}
