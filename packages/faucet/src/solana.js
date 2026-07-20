// ---------------------------------------------------------------------------
// Solana faucet drip
// ---------------------------------------------------------------------------
// Mirrors infra/solana/fund-solana.sh, but in-process:
//   1. requestAirdrop SOL to the recipient via the validator's faucet RPC.
//   2. Transfer mock USDC from the committed devnet treasury authority
//      (usdc-authority.json) — auto-creating the recipient's associated token
//      account (ATA) if it does not exist yet.
//
// The treasury keypair + USDC mint are the SAME deterministic devnet identities
// seeded by infra/solana/create-usdc-mint.sh, so peers can hardcode them.
//
// Everything here is OPTIONAL: if SOLANA_FAUCET_KEYPAIR / the RPC are not
// configured (e.g. an EVM-only deploy), `createSolanaFaucet` returns null and
// the route answers a clear 503 instead of crashing the whole service.
import fs from 'fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, transfer } from '@solana/spl-token';

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'http://solana-validator:8899';
const SOLANA_USDC_MINT = process.env.SOLANA_USDC_MINT || '';
const SOLANA_FAUCET_KEYPAIR = process.env.SOLANA_FAUCET_KEYPAIR || '/keys/usdc-authority.json';
// 6 decimals — real-USDC standard, matches infra/solana/create-usdc-mint.sh.
const SOLANA_USDC_DECIMALS = Number(process.env.SOLANA_USDC_DECIMALS || '6');
const SOLANA_SOL_AMOUNT = Number(process.env.SOLANA_SOL_AMOUNT || '2'); // SOL per drip
const SOLANA_USDC_AMOUNT = Number(process.env.SOLANA_USDC_AMOUNT || '1000'); // USDC per drip

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
// Deadline: a healthy full drip (airdrop + up to 3 treasury txs, 'confirmed'
// commitment at ~2.3 slots/s) completes in well under 15s; a single blockhash
// validity window (150 blocks) is ~65s. 90s ≥ one full window + margin, so the
// deadline can only fire when the chain genuinely stalls mid-drip.
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

  console.log(`✅ Solana faucet enabled: RPC ${SOLANA_RPC_URL}`);
  console.log(`   USDC mint:   ${mint.toBase58()}`);
  console.log(`   Treasury:    ${authority.publicKey.toBase58()}`);
  console.log(`   Per drip:    ${SOLANA_SOL_AMOUNT} SOL + ${SOLANA_USDC_AMOUNT} USDC`);

  return {
    rpcUrl: SOLANA_RPC_URL,
    mint: mint.toBase58(),
    treasury: authority.publicKey.toBase58(),
    solAmount: SOLANA_SOL_AMOUNT,
    usdcAmount: SOLANA_USDC_AMOUNT,

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

    async drip(address) {
      // Fail fast (~1.5–3s) with an honest VALIDATOR_STALLED error when the
      // validator is wedged, instead of burning 30–90s in confirmation waits
      // that end in a misleading "not confirmed in 30.00 seconds" 500.
      await assertSlotAdvancing(() => connection.getSlot('processed'));
      // Cap the whole drip so a MID-drip stall cannot hang the request queue.
      return withDeadline(dripInner(address), SOLANA_DRIP_DEADLINE_MS, 'Solana drip');
    },

    // USDC-only drip: a plain treasury→recipient token transfer with NO SOL
    // airdrop. The TREASURY (not the recipient) pays the tx fee + ATA rent, so
    // this works even when the public devnet airdrop is dry/rate-limited and even
    // if the recipient currently holds 0 SOL. Use it for addresses already funded
    // with SOL (mirrors the Mina `/api/mina/usdc-request` USDC-only leg).
    async dripUsdcOnly(address) {
      await assertSlotAdvancing(() => connection.getSlot('processed'));
      return withDeadline(usdcOnlyInner(address), SOLANA_DRIP_DEADLINE_MS, 'Solana USDC drip');
    },
  };

  // Airdrop SOL to the recipient and confirm it (blockhash/lastValidBlockHeight
  // strategy — tied to actual chain progress, not a 30s wall clock; issue #277).
  async function airdropSol(recipient) {
    const lamports = Math.round(SOLANA_SOL_AMOUNT * LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash('confirmed');
    const airdropSig = await connection.requestAirdrop(recipient, lamports);
    await connection.confirmTransaction(
      {
        signature: airdropSig,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      'confirmed'
    );
    console.log(`  📤 Airdropped ${SOLANA_SOL_AMOUNT} SOL: ${airdropSig}`);
    return airdropSig;
  }

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

  // Full drip: SOL + USDC — but the USDC leg is DECOUPLED from the airdrop. The
  // airdrop is SKIPPED when the recipient is already funded, and a FAILED airdrop
  // (public devnet dry / rate-limited) no longer aborts the request: the USDC
  // transfer still runs (it is funded by the treasury, not this airdrop). USDC
  // drips as long as the treasury holds SOL (fees) + USDC.
  async function dripInner(address) {
    const recipient = new PublicKey(address);

    // Skip the airdrop when the recipient already holds enough SOL to transact.
    const SKIP_AIRDROP_LAMPORTS = Math.round(0.02 * LAMPORTS_PER_SOL);
    const startBalance = await connection.getBalance(recipient, 'confirmed');

    let sol;
    if (startBalance >= SKIP_AIRDROP_LAMPORTS) {
      console.log(
        `  ⏭️  Recipient holds ${startBalance / LAMPORTS_PER_SOL} SOL — skipping airdrop`
      );
      sol = {
        skipped: true,
        reason: 'recipient already funded',
        balanceSol: String(startBalance / LAMPORTS_PER_SOL),
      };
    } else {
      try {
        const signature = await airdropSol(recipient);
        sol = { signature, amount: String(SOLANA_SOL_AMOUNT) };
      } catch (err) {
        // Airdrop unavailable (public devnet airdrop dry / rate-limited). Do NOT
        // abort — the USDC leg is treasury-funded and independent of this drip.
        console.log(`  ⚠️  Airdrop unavailable (${err.message}); continuing to the USDC transfer`);
        sol = { skipped: true, reason: 'airdrop unavailable', error: String(err.message || err) };
      }
    }

    const usdc = await transferUsdc(recipient);
    return { sol, usdc };
  }

  // USDC-only body — a treasury→recipient transfer with no airdrop leg at all.
  async function usdcOnlyInner(address) {
    const recipient = new PublicKey(address);
    const usdc = await transferUsdc(recipient);
    return { sol: { skipped: true, reason: 'usdc-only route' }, usdc };
  }
}
