/**
 * o1js PROVER WORKER — all heavy zk work runs here, off the main thread.
 *
 * ── CONCURRENCY CONTRACT (critical) ──────────────────────────────────────────
 * o1js keeps a single global prover context; running two async o1js operations
 * concurrently corrupts it ("The global context managed by o1js reached an
 * inconsistent state … Running async o1js operations in parallel is not
 * supported"). The worker's `onmessage` is invoked per message and each handler
 * is async, so two messages — e.g. the connect-triggered `compile` STILL IN
 * FLIGHT when the user clicks mint → `buildAndProve` (which used to kick off its
 * OWN compile) — would run two `compile()`s in parallel and trigger exactly that
 * error. (Root-caused + reproduced: both stacks sat inside `.compile()` at once.)
 *
 * We prevent it with TWO guarantees:
 *   1. `enqueue()` — a strict serial queue. EVERY o1js job runs one-at-a-time in
 *      arrival order; a new job never starts until the previous has settled.
 *   2. `compileOnce()` — compile is memoized to ONE shared promise, so a second
 *      trigger awaits the SAME compile instead of starting another. On failure
 *      the memo resets so a later retry can recompile from scratch.
 * So compile runs exactly once, prove always runs after compile has fully
 * settled, and no two o1js ops ever overlap — regardless of UI message timing.
 *
 * `buildAndProve` reproduces the CLI's `buildMintTx` EXACTLY:
 * `Mina.transaction({ sender: feePayer, fee }, () => { fundNewAccount?;
 * token.mint(recipient, amount) })` → `tx.prove()`. The recipient does NOT sign;
 * the fee payer (connected Auro wallet) signs later. We return the PROVEN tx JSON
 * for Auro to sign + broadcast. Same construction + same o1js/mina-fungible-token
 * versions as tools/mina/mint-usdc.mts, so the proof the on-chain admin accepts.
 */

import { AccountUpdate, fetchAccount, Mina, PublicKey, TokenId, UInt64 } from 'o1js';
import { FungibleToken } from 'mina-fungible-token';

// Import the tsc-PRECOMPILED contract classes (see scripts/build-zkapp.mjs).
// esbuild (Vite) cannot lower o1js's @method decorators; these are already
// lowered to plain JS by tsc, so Vite only bundles JS from here on.
import { UsdcChannelToken } from './zkapp-compiled/usdc-channel-token.js';
import { PermissionlessRateLimitedUsdcAdmin } from './zkapp-compiled/usdc-permissionless-admin.js';
import { ONE_USDC } from './zkapp-compiled/usdc-token.js';

import { NETWORK_GRAPHQL, TOKEN_ADDRESS, ADMIN_CONTRACT_ADDRESS } from './config';
import type { WorkerRequest, WorkerResponse } from './protocol';

/** zkApp devnet fee: 0.1 MINA in nanomina (mirrors MINT_FEE_NANOMINA). */
const MINT_FEE_NANOMINA = 100_000_000n;

function post(msg: WorkerResponse) {
  (self as unknown as Worker).postMessage(msg);
}

// ── Strict serial queue: every o1js job runs one at a time, in order ──────────
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  // Run `job` only after the previous settles (fulfilled OR rejected), so one
  // failed job never blocks the queue and jobs never overlap.
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

// ── Compile exactly once (memoized shared promise) ────────────────────────────
let compilePromise: Promise<void> | null = null;
let networkSet = false;

function ensureNetwork() {
  if (networkSet) return;
  Mina.setActiveInstance(Mina.Network({ mina: NETWORK_GRAPHQL }));
  networkSet = true;
}

async function doCompile(): Promise<void> {
  ensureNetwork();
  // Route token.mint's admin call through the DEPLOYED permissionless circuit.
  FungibleToken.AdminContract = PermissionlessRateLimitedUsdcAdmin;
  post({ id: 0, kind: 'progress', stage: 'compiling', message: 'Compiling admin circuit…' });
  await PermissionlessRateLimitedUsdcAdmin.compile();
  post({ id: 0, kind: 'progress', stage: 'compiling', message: 'Compiling token circuit…' });
  await UsdcChannelToken.compile();
}

function compileOnce(): Promise<void> {
  if (!compilePromise) {
    compilePromise = doCompile().catch((err) => {
      compilePromise = null; // allow a later retry to recompile
      throw err;
    });
  }
  return compilePromise;
}

async function buildAndProve(
  feePayerB58: string,
  recipientB58: string,
  wholeUsdc: bigint
): Promise<{ txJson: string; fundNewAccounts: number }> {
  await compileOnce(); // serialized: never overlaps the compile job
  ensureNetwork();
  FungibleToken.AdminContract = PermissionlessRateLimitedUsdcAdmin;

  const feePayer = PublicKey.fromBase58(feePayerB58);
  const recipient = PublicKey.fromBase58(recipientB58);
  const token = new UsdcChannelToken(PublicKey.fromBase58(TOKEN_ADDRESS));
  const usdcTokenId = token.deriveTokenId();

  post({ id: 0, kind: 'progress', stage: 'fetching', message: 'Reading on-chain state…' });
  // Mirror the CLI: fetch fee payer + the contracts + the recipient's USDC
  // token account (to decide first-mint funding). o1js's two-pass tx builder
  // auto-fetches the remaining witnessed accounts (receipt, network state).
  await fetchAccount({ publicKey: feePayer });
  await fetchAccount({ publicKey: PublicKey.fromBase58(TOKEN_ADDRESS) });
  await fetchAccount({ publicKey: PublicKey.fromBase58(TOKEN_ADDRESS), tokenId: usdcTokenId });
  await fetchAccount({ publicKey: PublicKey.fromBase58(ADMIN_CONTRACT_ADDRESS) });
  const recipientTokenAccount = await fetchAccount({ publicKey: recipient, tokenId: usdcTokenId });
  // Also warm the receipt account (admin-derived token id) into the fetch cache.
  const adminTokenId = TokenId.derive(PublicKey.fromBase58(ADMIN_CONTRACT_ADDRESS));
  await fetchAccount({ publicKey: recipient, tokenId: adminTokenId });

  // First mint to a fresh recipient funds 2 new accounts (USDC token account +
  // mint-receipt account); 0 if the token account already exists.
  const firstMint = recipientTokenAccount.account === undefined;
  const fundNewAccounts = firstMint ? 2 : 0;

  post({ id: 0, kind: 'progress', stage: 'building', message: 'Building mint transaction…' });
  const amount = UInt64.from(wholeUsdc * ONE_USDC);
  const tx = await Mina.transaction(
    { sender: feePayer, fee: UInt64.from(MINT_FEE_NANOMINA) },
    async () => {
      if (fundNewAccounts > 0) AccountUpdate.fundNewAccount(feePayer, fundNewAccounts);
      await token.mint(recipient, amount);
    }
  );

  post({
    id: 0,
    kind: 'progress',
    stage: 'proving',
    message: 'Generating zero-knowledge proof (this takes ~10–40s)…',
  });
  await tx.prove();

  // Do NOT sign here — the fee payer (Auro) signs in the wallet.
  return { txJson: tx.toJSON(), fundNewAccounts };
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  // Every handler goes through the serial queue → no two o1js ops ever overlap.
  if (req.kind === 'compile') {
    enqueue(() => compileOnce())
      .then(() => post({ id: req.id, kind: 'compiled' }))
      .catch((err) =>
        post({
          id: req.id,
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      );
  } else if (req.kind === 'buildAndProve') {
    enqueue(() => buildAndProve(req.feePayer, req.recipient, BigInt(req.wholeUsdc)))
      .then((r) =>
        post({ id: req.id, kind: 'proven', txJson: r.txJson, fundNewAccounts: r.fundNewAccounts })
      )
      .catch((err) =>
        post({
          id: req.id,
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      );
  }
};
