// ---------------------------------------------------------------------------
// Solana faucet drip
// ---------------------------------------------------------------------------
// Mirrors infra/solana/fund-solana.sh, but in-process:
//   1. Transfer SOL to the recipient from the committed devnet treasury
//      authority (usdc-authority.json) — a plain treasury→recipient transfer,
//      same as the USDC leg below and the Mina `treasury-drip` mode. This
//      avoids `requestAirdrop`, whose public-devnet endpoint is per-IP
//      rate-limited and frequently dry for outside callers (issue #379). A
//      `requestAirdrop` call is kept as a fallback for when the treasury
//      itself runs low.
//   2. Transfer mock USDC from the committed devnet treasury authority
//      (usdc-authority.json) — auto-creating the recipient's associated token
//      account (ATA) if it does not exist yet.
//
// The treasury keypair + USDC mint are the SAME deterministic devnet identities
// seeded by infra/solana/create-usdc-mint.sh, so peers can hardcode them.
//
// SOLANA_SOL_AMOUNT default (toon-meta#258): the committed devnet treasury
// (AEPoA5xTTJY9SR8c5CfsemFGC5TmxQBe6Xf6wewEtnYa) has observed balances as low
// as ~0.45 SOL — it is NOT re-funded by the public airdrop (that is the whole
// problem this fix works around), only by an operator manually topping it up.
// A 2 SOL/drip default (the pre-#258 value) would exhaust it in ONE request
// and 500 every drip after; 0.03 SOL/drip is enough to open + operate a
// payment channel and gives the treasury ~15 drips before an operator needs to
// top it up. The per-address cooldown below (mirroring the Base Sepolia /
// Mina USDC legs) is what makes that budget last: without it, one address
// looping the endpoint could drain the whole treasury in seconds.
//
// Everything here is OPTIONAL: if SOLANA_FAUCET_KEYPAIR / the RPC are not
// configured (e.g. an EVM-only deploy), `createSolanaFaucet` returns null and
// the route answers a clear 503 instead of crashing the whole service.
//
// `drip()` (SOL + USDC, described above) has had no HTTP route since
// connector#898 retired the combined and native-SOL-only routes in favour of
// USDC-only (toon-meta#310 §4.6) — index.js now only ever calls
// `dripUsdcOnly()`. `drip()`/`dripInner()` are kept as library surface
// deliberately (#898's own commit message), so the SOL leg's correctness
// below still matters even though nothing currently serves it over HTTP.
import fs from 'fs';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, transfer } from '@solana/spl-token';
import { createDripLimiter } from './drip-limiter.js';

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'http://solana-validator:8899';
const SOLANA_USDC_MINT = process.env.SOLANA_USDC_MINT || '';
const SOLANA_FAUCET_KEYPAIR = process.env.SOLANA_FAUCET_KEYPAIR || '/keys/usdc-authority.json';
// 6 decimals — real-USDC standard, matches infra/solana/create-usdc-mint.sh.
const SOLANA_USDC_DECIMALS = Number(process.env.SOLANA_USDC_DECIMALS || '6');
// Conservative default — see the treasury-balance note above (toon-meta#258).
const SOLANA_SOL_AMOUNT = Number(process.env.SOLANA_SOL_AMOUNT || '0.03'); // SOL per drip
const SOLANA_USDC_AMOUNT = Number(process.env.SOLANA_USDC_AMOUNT || '1000'); // USDC per drip
// The drip amount in the unit every on-chain call and balance check uses.
const SOL_DRIP_LAMPORTS = Math.round(SOLANA_SOL_AMOUNT * LAMPORTS_PER_SOL);
// Solana's base fee is 5,000 lamports/signature; a treasury→recipient
// transfer signs once. Reserved on top of the drip amount when pre-checking
// the treasury can actually cover a transfer (issue #691).
const SOL_TRANSFER_FEE_BUFFER_LAMPORTS = 5000;
// Per-address cooldown (default 24h) — protects the low-balance SOL treasury
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

// Confirms a SOL delivery actually landed, rather than trusting a confirmed
// signature alone (issue #691): a live funding run saw the devnet faucet
// report success WITH a real transaction signature for 8 of 20 addresses
// while delivering 0 lamports. `sendAndConfirmTransaction`/
// `confirmTransaction` resolving does not, by itself, prove the recipient's
// balance moved — on the public devnet RPC (a load-balanced, multi-node
// endpoint since the self-hosted validator was retired 2026-07-19) the
// confirmation read and a balance read immediately after can be served by
// different backend nodes, so a fresh read can still lag the write it just
// confirmed. Polls briefly to absorb that lag before concluding the delivery
// genuinely did not happen. `getBalance` is an async () => number, injected
// so this is testable without a live RPC (mirrors `assertSlotAdvancing`
// above). Exported for tests.
export async function verifyDelivered(
  getBalance,
  floorLamports,
  { attempts = 5, intervalMs = 500 } = {}
) {
  let balance = await getBalance();
  for (let i = 1; i < attempts && balance < floorLamports; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    balance = await getBalance();
  }
  if (balance < floorLamports) {
    const err = new Error(
      `Transaction reported success but the recipient's balance is still ${balance} lamports, ` +
        `short of the expected ${floorLamports}-lamport floor — treating the delivery as ` +
        'unverified rather than reporting success.'
    );
    err.code = 'SOL_DELIVERY_UNVERIFIED';
    throw err;
  }
  return balance;
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
  // failure) — see the SOLANA_SOL_AMOUNT note above for why this matters here:
  // the treasury's SOL balance is small and NOT self-replenishing.
  const limiter = createDripLimiter({ cooldownMs: SOLANA_DRIP_COOLDOWN_MS });

  console.log(`✅ Solana faucet enabled: RPC ${SOLANA_RPC_URL}`);
  console.log(`   USDC mint:   ${mint.toBase58()}`);
  console.log(`   Treasury:    ${authority.publicKey.toBase58()}`);
  console.log(`   Per drip:    ${SOLANA_SOL_AMOUNT} SOL + ${SOLANA_USDC_AMOUNT} USDC`);
  console.log(`   Cooldown:    ${SOLANA_DRIP_COOLDOWN_MS / 3_600_000}h per address`);

  return {
    rpcUrl: SOLANA_RPC_URL,
    mint: mint.toBase58(),
    treasury: authority.publicKey.toBase58(),
    solAmount: SOLANA_SOL_AMOUNT,
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

  // Transfer SOL from the treasury to the recipient — the primary SOL-funding
  // path (issue #379). The TREASURY pays the tx fee, so this works regardless
  // of the public devnet airdrop's rate limits, mirroring `transferUsdc` below.
  // `startBalance` is the recipient's pre-transfer balance (read by the
  // caller); delivery is verified against it before the signature is trusted
  // (issue #691).
  async function transferSol(recipient, startBalance) {
    const latest = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({
      feePayer: authority.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: recipient,
        lamports: SOL_DRIP_LAMPORTS,
      })
    );
    const signature = await sendAndConfirmTransaction(connection, tx, [authority], {
      commitment: 'confirmed',
    });
    await verifyDelivered(
      () => connection.getBalance(recipient, 'confirmed'),
      startBalance + SOL_DRIP_LAMPORTS
    );
    console.log(`  📤 Transferred ${SOLANA_SOL_AMOUNT} SOL from treasury: ${signature}`);
    return signature;
  }

  // Airdrop SOL to the recipient and confirm it (blockhash/lastValidBlockHeight
  // strategy — tied to actual chain progress, not a 30s wall clock; issue #277).
  // Fallback only: used when the treasury itself can't cover the SOL transfer.
  // Delivery is verified the same way as the treasury path (issue #691).
  async function airdropSol(recipient, startBalance) {
    const latest = await connection.getLatestBlockhash('confirmed');
    const airdropSig = await connection.requestAirdrop(recipient, SOL_DRIP_LAMPORTS);
    await connection.confirmTransaction(
      {
        signature: airdropSig,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      'confirmed'
    );
    await verifyDelivered(
      () => connection.getBalance(recipient, 'confirmed'),
      startBalance + SOL_DRIP_LAMPORTS
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

  // Shared by both places dripInner falls back to requestAirdrop (treasury
  // pre-check failed, or the treasury transfer itself threw): attempts the
  // airdrop and reports either a verified delivery or an honest skip. Never
  // throws — the USDC leg below must still run regardless of this leg's
  // outcome. `treasuryBalanceLamports`, when given, surfaces WHY the
  // treasury path was skipped (issue #691's "surface treasury-low as an
  // explicit error") on both branches, not just the failure one.
  async function fallbackToAirdrop(recipient, startBalance, reason, treasuryBalanceLamports) {
    const treasuryKnown = treasuryBalanceLamports !== undefined;
    try {
      const signature = await airdropSol(recipient, startBalance);
      return {
        signature,
        amount: String(SOLANA_SOL_AMOUNT),
        source: 'airdrop-fallback',
        ...(treasuryKnown ? { fallbackReason: reason, treasuryBalanceLamports } : {}),
      };
    } catch (airdropErr) {
      // Neither path worked (e.g. treasury underfunded AND the public airdrop
      // is dry, or confirmed but undelivered on both). Do NOT throw — the
      // USDC leg is treasury-funded and independent of this leg.
      return {
        skipped: true,
        reason,
        error: String(airdropErr.message || airdropErr),
        ...(treasuryKnown ? { treasuryBalanceLamports } : {}),
      };
    }
  }

  // Full drip: SOL + USDC — but the USDC leg is DECOUPLED from the SOL leg. The
  // SOL leg is SKIPPED when the recipient is already funded, and a FAILED SOL
  // leg no longer aborts the request: the USDC transfer still runs (it is
  // funded by the treasury, independent of the SOL leg's outcome). USDC drips
  // as long as the treasury holds SOL (fees) + USDC.
  async function dripInner(address) {
    const recipient = new PublicKey(address);

    // Skip the SOL leg when the recipient already holds enough SOL to transact.
    const SKIP_AIRDROP_LAMPORTS = Math.round(0.02 * LAMPORTS_PER_SOL);
    const startBalance = await connection.getBalance(recipient, 'confirmed');

    let sol;
    if (startBalance >= SKIP_AIRDROP_LAMPORTS) {
      console.log(
        `  ⏭️  Recipient holds ${startBalance / LAMPORTS_PER_SOL} SOL — skipping SOL leg`
      );
      sol = {
        skipped: true,
        reason: 'recipient already funded',
        balanceSol: String(startBalance / LAMPORTS_PER_SOL),
      };
    } else {
      // Pre-flight: the treasury does not self-replenish (toon-meta#258), so
      // check it can actually cover this drip + its own fee BEFORE attempting
      // the transfer, rather than letting an underfunded treasury surface as
      // an opaque RPC error (issue #691).
      const treasuryBalance = await connection.getBalance(authority.publicKey, 'confirmed');
      if (treasuryBalance < SOL_DRIP_LAMPORTS + SOL_TRANSFER_FEE_BUFFER_LAMPORTS) {
        console.log(
          `  ⚠️  Treasury SOL balance (${treasuryBalance} lamports) can't cover a ` +
            `${SOL_DRIP_LAMPORTS}-lamport drip + fee — skipping the treasury transfer, ` +
            'trying requestAirdrop'
        );
        sol = await fallbackToAirdrop(
          recipient,
          startBalance,
          'treasury sol balance too low',
          treasuryBalance
        );
      } else {
        try {
          // Primary: a treasury→recipient SOL transfer, immune to the public
          // devnet airdrop's per-IP rate limit (issue #379).
          const signature = await transferSol(recipient, startBalance);
          sol = { signature, amount: String(SOLANA_SOL_AMOUNT), source: 'treasury' };
        } catch (err) {
          console.log(
            `  ⚠️  Treasury SOL transfer failed (${err.message}); falling back to requestAirdrop`
          );
          sol = await fallbackToAirdrop(recipient, startBalance, 'sol funding unavailable');
        }
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
