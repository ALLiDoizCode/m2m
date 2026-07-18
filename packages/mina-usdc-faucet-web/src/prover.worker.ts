/**
 * o1js PROVER WORKER — all heavy zk work runs here, off the main thread.
 *
 * Responsibilities:
 *   1. `compile` — point `FungibleToken.AdminContract` at the deployed
 *      permissionless admin, then compile BOTH circuits
 *      (`PermissionlessRateLimitedUsdcAdmin` then `UsdcChannelToken`). The
 *      compiled provers/vks are cached in this worker for the page's lifetime,
 *      so every subsequent mint reuses them (compile once per session).
 *   2. `buildAndProve` — reproduce the CLI's `buildMintTx` EXACTLY: a
 *      `Mina.transaction({ sender: feePayer, fee }, () => { fundNewAccount?;
 *      token.mint(recipient, amount) })`, then `tx.prove()`. The recipient does
 *      NOT sign; the fee payer (connected Auro wallet) signs later, in the
 *      wallet. We return the PROVEN tx as JSON for Auro to sign + broadcast.
 *
 * This is the browser twin of tools/mina/mint-usdc.mts — same construction, same
 * o1js + mina-fungible-token versions, so it produces a proof the on-chain admin
 * account (fixed vk hash) accepts.
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

let compiled = false;

function post(msg: WorkerResponse) {
  (self as unknown as Worker).postMessage(msg);
}

function ensureNetwork() {
  Mina.setActiveInstance(Mina.Network({ mina: NETWORK_GRAPHQL }));
}

async function compileCircuits(id: number) {
  ensureNetwork();
  if (compiled) {
    post({ id, kind: 'compiled' });
    return;
  }
  // Route token.mint's admin call through the DEPLOYED permissionless circuit.
  FungibleToken.AdminContract = PermissionlessRateLimitedUsdcAdmin;

  post({ id, kind: 'progress', stage: 'compiling', message: 'Compiling admin circuit…' });
  await PermissionlessRateLimitedUsdcAdmin.compile();

  post({ id, kind: 'progress', stage: 'compiling', message: 'Compiling token circuit…' });
  await UsdcChannelToken.compile();

  compiled = true;
  post({ id, kind: 'compiled' });
}

async function buildAndProve(
  id: number,
  feePayerB58: string,
  recipientB58: string,
  wholeUsdc: bigint
) {
  ensureNetwork();
  if (!compiled) await compileCircuits(id);
  // Keep the admin static pointed at the deployed circuit for this prove.
  FungibleToken.AdminContract = PermissionlessRateLimitedUsdcAdmin;

  const feePayer = PublicKey.fromBase58(feePayerB58);
  const recipient = PublicKey.fromBase58(recipientB58);
  const token = new UsdcChannelToken(PublicKey.fromBase58(TOKEN_ADDRESS));
  const usdcTokenId = token.deriveTokenId();

  post({ id, kind: 'progress', stage: 'fetching', message: 'Reading on-chain state…' });
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

  post({ id, kind: 'progress', stage: 'building', message: 'Building mint transaction…' });
  const amount = UInt64.from(wholeUsdc * ONE_USDC);
  const tx = await Mina.transaction(
    { sender: feePayer, fee: UInt64.from(MINT_FEE_NANOMINA) },
    async () => {
      if (fundNewAccounts > 0) AccountUpdate.fundNewAccount(feePayer, fundNewAccounts);
      await token.mint(recipient, amount);
    }
  );

  post({
    id,
    kind: 'progress',
    stage: 'proving',
    message: 'Generating zero-knowledge proof (this takes ~10–40s)…',
  });
  await tx.prove();

  // Do NOT sign here — the fee payer (Auro) signs in the wallet. Hand over the
  // proven tx JSON; Auro adds the fee-payer signature and broadcasts.
  post({ id, kind: 'proven', txJson: tx.toJSON(), fundNewAccounts });
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.kind === 'compile') {
      await compileCircuits(req.id);
    } else if (req.kind === 'buildAndProve') {
      await buildAndProve(req.id, req.feePayer, req.recipient, BigInt(req.wholeUsdc));
    }
  } catch (err) {
    post({
      id: req.id,
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
