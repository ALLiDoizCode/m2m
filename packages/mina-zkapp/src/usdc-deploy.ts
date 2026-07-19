/**
 * USDC deploy + admin-mint orchestration for the Mina devnet tooling.
 *
 * Moved here from `tools/mina/deploy-usdc-token.ts` / `tools/mina/fund-usdc.ts`
 * (the o1js duplicate-instance seam fix, issue #352) so ONE implementation is
 * shared by:
 *   - the jest smoke suite (`usdc-deploy.test.ts`, CJS via ts-jest — the ESM
 *     `mina-fungible-token` is transformed to CJS so o1js stays single-instance),
 *   - the pure-ESM CLI runners (`tools/mina/deploy-usdc-token.mts`,
 *     `tools/mina/fund-usdc.mts`) via the `dist-esm/` build, where o1js also
 *     stays single-instance (everything resolves the ESM `dist/node/index.js`).
 *
 * o1js is a DUAL package (ESM `dist/node/index.js` vs CJS `dist/node/index.cjs`)
 * whose `Snarky`/prover bindings are per-module-instance state: any process that
 * loads BOTH builds gets `TypeError: Cannot read properties of undefined
 * (reading 'run')` at the first gadget executed in the copy whose bindings were
 * never initialized. Keeping this module inside `packages/mina-zkapp` means both
 * build flavors (`dist/` CJS, `dist-esm/` ESM) exist for whichever modality a
 * consumer needs — never mix them in one process.
 *
 * @module usdc-deploy
 */

import { AccountUpdate, Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';

import {
  FungibleToken,
  FungibleTokenAdmin,
  ONE_USDC,
  USDC_DECIMALS,
  USDC_DECIMALS_U8,
  USDC_START_UNPAUSED,
  usdcDeployProps,
} from './usdc-token';
// In-proof-enforcing USDC token owner (Phase A). Deploys EXACTLY like the stock
// `FungibleToken` (same usdcDeployProps / initialize), but ADDS the channel-bound
// `enableChannelEscrow` / `depositToChannel` / `settleFromChannel` methods so the
// PROOF (not the SDK) binds escrow payouts to the channel commitment.
import { UsdcChannelToken } from './usdc-channel-token';
// Rate-limited (per-address-per-day capped) admin flavors:
//  - RateLimitedUsdcAdmin              — recipient-SIGNED receipt (legacy).
//  - PermissionlessRateLimitedUsdcAdmin — NO recipient signature; any fee payer
//    mints to any address. The canonical public-devnet mint authority since the
//    permissionless-mint redeploy.
import { RateLimitedUsdcAdmin } from './usdc-rate-limited-admin';
import { PermissionlessRateLimitedUsdcAdmin } from './usdc-permissionless-admin';

/** Result of a USDC token deploy — the values to pin into endpoints.json. */
export interface UsdcDeployResult {
  /** Base58 address of the deployed `FungibleToken` (the USDC token-owner zkApp). */
  tokenAddress: string;
  /** Derived Mina token id (`token.deriveTokenId()`) for USDC. */
  tokenId: string;
  /** Base58 address of the `FungibleTokenAdmin` contract gating mints. */
  adminContractAddress: string;
  /** Base58 address of the admin AUTHORITY (the funded key that signs mints). */
  adminAuthority: string;
  /** 6. */
  decimals: number;
  network: string;
}

/**
 * Build and submit the atomic deploy transaction for the USDC admin + token
 * contracts. Returns the deploy result plus the contract instances so callers
 * (deploy CLI + smoke test) can reuse them for a follow-up mint.
 *
 * Shared by the live path and the local smoke test so the exact deploy sequence
 * is verified without a network.
 */
export async function deployUsdcToken(opts: {
  feePayer: PublicKey;
  /** Public key of the admin AUTHORITY (mint authority) — must be FUNDED. */
  adminAuthority: PublicKey;
  /** Account for the FungibleTokenAdmin contract. */
  adminContractKey: PrivateKey;
  /** Account for the FungibleToken contract. */
  tokenKey: PrivateKey;
  /** Signing keys (fee payer + the two contract account keys). */
  signers: PrivateKey[];
  network: string;
  /** zkApp tx fee in nanomina; defaults to MINT_FEE_NANOMINA (0.1 MINA). */
  feeNanomina?: bigint;
}): Promise<{
  result: UsdcDeployResult;
  token: UsdcChannelToken;
  admin: FungibleTokenAdmin;
}> {
  const admin = new FungibleTokenAdmin(opts.adminContractKey.toPublicKey());
  const token = new UsdcChannelToken(opts.tokenKey.toPublicKey());

  const tx = await Mina.transaction(
    { sender: opts.feePayer, fee: UInt64.from(opts.feeNanomina ?? MINT_FEE_NANOMINA) },
    async () => {
      // Three new accounts pay the account-creation fee: admin, token, circulation.
      AccountUpdate.fundNewAccount(opts.feePayer, 3);
      await admin.deploy({ adminPublicKey: opts.adminAuthority });
      await token.deploy(usdcDeployProps);
      await token.initialize(
        opts.adminContractKey.toPublicKey(),
        USDC_DECIMALS_U8,
        USDC_START_UNPAUSED // start unpaused
      );
    }
  );
  await tx.prove();
  await tx.sign(opts.signers).send();

  const result: UsdcDeployResult = {
    tokenAddress: opts.tokenKey.toPublicKey().toBase58(),
    tokenId: token.deriveTokenId().toString(),
    adminContractAddress: opts.adminContractKey.toPublicKey().toBase58(),
    adminAuthority: opts.adminAuthority.toBase58(),
    decimals: USDC_DECIMALS,
    network: opts.network,
  };

  return { result, token, admin };
}

/**
 * Fee (in nanomina) for the deploy and mint zkApp commands. A zkApp command on the public
 * Mina devnet is rejected with "Insufficient fee" at the default (~0.001 MINA)
 * fee floor that `Mina.transaction` would otherwise pick — proof commands cost
 * more than plain payments. 0.1 MINA is the well-worn devnet zkApp fee and is
 * what the manual mint used. Override with MINA_TX_FEE (whole MINA) if the
 * mempool fee floor rises. 1 MINA = 1e9 nanomina.
 */
export const MINT_FEE_NANOMINA = (() => {
  const whole = process.env['MINA_TX_FEE'];
  if (whole && Number.isFinite(Number(whole))) {
    // Parse "0.1" → 100_000_000 nanomina without floating point drift.
    const [w, f = ''] = String(whole).split('.');
    return BigInt(w || '0') * 1_000_000_000n + BigInt((f + '000000000').slice(0, 9) || '0');
  }
  return 100_000_000n; // 0.1 MINA
})();

/**
 * Admin-mint `wholeUsdc` USDC (whole tokens, scaled to 6-dp base units) to
 * `recipient`. The admin authority signs; the fee payer (default: the admin
 * authority) pays fees + the recipient token-account creation fee.
 *
 * Returns the recipient's post-mint balance (base units) as a string.
 */
export async function mintUsdc(opts: {
  token: FungibleToken;
  feePayer: PublicKey;
  recipient: PublicKey;
  wholeUsdc: bigint;
  /** Fee payer + admin authority signing keys. */
  signers: PrivateKey[];
  /** Whether the recipient's token account must be funded (true on first mint). */
  fundRecipient: boolean;
  /** zkApp tx fee in nanomina; defaults to MINT_FEE_NANOMINA (0.1 MINA). */
  feeNanomina?: bigint;
}): Promise<string> {
  const amount = UInt64.from(opts.wholeUsdc * ONE_USDC);
  const tx = await Mina.transaction(
    { sender: opts.feePayer, fee: UInt64.from(opts.feeNanomina ?? MINT_FEE_NANOMINA) },
    async () => {
      if (opts.fundRecipient) AccountUpdate.fundNewAccount(opts.feePayer, 1);
      await opts.token.mint(opts.recipient, amount);
    }
  );
  await tx.prove();
  await tx.sign(opts.signers).send();
  return (await opts.token.getBalanceOf(opts.recipient)).toString();
}

/**
 * Deploy the USDC token gated by the RATE-LIMITED admin contract
 * (`RateLimitedUsdcAdmin`) — the canonical shared-devnet flavor: anyone can
 * mint to themselves up to the per-address daily cap, enforced in-proof +
 * in-ledger; `adminAuthority` keeps only pause/upgrade rights (NOT a mint
 * monopoly), so it does not need to be funded for the token to be usable.
 *
 * Identical atomic deploy sequence to {@link deployUsdcToken} (admin + token +
 * initialize, 3 funded new accounts); only the admin contract class differs.
 * Also points `FungibleToken.AdminContract` at `RateLimitedUsdcAdmin` so any
 * later `token.mint(...)` in this process proves against the DEPLOYED admin
 * circuit (o1js resolves the admin prover through that static).
 */
export async function deployRateLimitedUsdcToken(opts: {
  feePayer: PublicKey;
  /** Public key of the PAUSE/UPGRADE authority (never needed for minting). */
  adminAuthority: PublicKey;
  /** Account for the RateLimitedUsdcAdmin contract. */
  adminContractKey: PrivateKey;
  /** Account for the FungibleToken contract. */
  tokenKey: PrivateKey;
  /** Signing keys (fee payer + the two contract account keys). */
  signers: PrivateKey[];
  network: string;
  /** zkApp tx fee in nanomina; defaults to MINT_FEE_NANOMINA (0.1 MINA). */
  feeNanomina?: bigint;
}): Promise<{
  result: UsdcDeployResult;
  token: UsdcChannelToken;
  admin: RateLimitedUsdcAdmin;
  /** Hash of the submitted deploy transaction (for the deploy record). */
  txHash: string;
}> {
  FungibleToken.AdminContract = RateLimitedUsdcAdmin;
  const admin = new RateLimitedUsdcAdmin(opts.adminContractKey.toPublicKey());
  const token = new UsdcChannelToken(opts.tokenKey.toPublicKey());

  const tx = await Mina.transaction(
    { sender: opts.feePayer, fee: UInt64.from(opts.feeNanomina ?? MINT_FEE_NANOMINA) },
    async () => {
      // Three new accounts pay the account-creation fee: admin, token, circulation.
      AccountUpdate.fundNewAccount(opts.feePayer, 3);
      await admin.deploy({ adminPublicKey: opts.adminAuthority });
      await token.deploy(usdcDeployProps);
      await token.initialize(
        opts.adminContractKey.toPublicKey(),
        USDC_DECIMALS_U8,
        USDC_START_UNPAUSED // start unpaused
      );
    }
  );
  await tx.prove();
  const pending = await tx.sign(opts.signers).send();

  const result: UsdcDeployResult = {
    tokenAddress: opts.tokenKey.toPublicKey().toBase58(),
    tokenId: token.deriveTokenId().toString(),
    adminContractAddress: opts.adminContractKey.toPublicKey().toBase58(),
    adminAuthority: opts.adminAuthority.toBase58(),
    decimals: USDC_DECIMALS,
    network: opts.network,
  };

  return { result, token, admin, txHash: pending.hash };
}

/** Options for building a permissionless (rate-limited) self-mint transaction. */
export interface SelfMintTxOptions {
  /** Token deployed with the RATE-LIMITED admin contract. */
  token: FungibleToken;
  feePayer: PublicKey;
  /** Mint recipient — must also SIGN (the mint-receipt AU requires it). */
  recipient: PublicKey;
  /** Whole USDC to mint (scaled to 6-dp base units). */
  wholeUsdc: bigint;
  /** Fee payer + RECIPIENT signing keys (no admin key involved). */
  signers: PrivateKey[];
  /**
   * New accounts this tx must fund: 2 on a recipient's FIRST mint (token
   * account + mint-receipt account), 0 afterwards.
   */
  fundNewAccounts?: number;
  /** zkApp tx fee in nanomina; defaults to MINT_FEE_NANOMINA (0.1 MINA). */
  feeNanomina?: bigint;
  /** Explicit fee-payer nonce override (for queueing txs before inclusion). */
  nonce?: number;
}

/**
 * Build + prove + sign (but do NOT send) a rate-limited self-mint transaction.
 *
 * Exposed separately from {@link selfMintUsdc} so callers can control send
 * ordering — e.g. the on-chain rejection smoke proves a second mint against
 * the PRE-first-mint receipt state, sends the first, then submits the stale
 * one and captures the ledger's app-state precondition failure.
 */
export async function buildSelfMintTx(
  opts: SelfMintTxOptions
): Promise<Mina.Transaction<true, true>> {
  // Route `token.mint`'s admin call through the rate-limited circuit (the
  // deployed admin account carries the RateLimitedUsdcAdmin verification key).
  FungibleToken.AdminContract = RateLimitedUsdcAdmin;
  const amount = UInt64.from(opts.wholeUsdc * ONE_USDC);
  const fundNewAccounts = opts.fundNewAccounts ?? 0;
  const tx = await Mina.transaction(
    {
      sender: opts.feePayer,
      fee: UInt64.from(opts.feeNanomina ?? MINT_FEE_NANOMINA),
      ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
    },
    async () => {
      if (fundNewAccounts > 0) AccountUpdate.fundNewAccount(opts.feePayer, fundNewAccounts);
      await opts.token.mint(opts.recipient, amount);
    }
  );
  const proven = await tx.prove();
  return proven.sign(opts.signers);
}

/**
 * Permissionless (rate-limited) self-mint: build, send, and return the
 * recipient's post-mint balance (base units) as a string. The recipient's key
 * signs the mint receipt; NO admin signature is involved.
 */
export async function selfMintUsdc(opts: SelfMintTxOptions): Promise<string> {
  const tx = await buildSelfMintTx(opts);
  await tx.send();
  return (await opts.token.getBalanceOf(opts.recipient)).toString();
}

// ─── Permissionless flavor (PermissionlessRateLimitedUsdcAdmin) ──────────────
// Same rate-limit policy, but the RECIPIENT never signs: any fee payer mints to
// any address. The receipt AU is authorized by the admin's `canMint` proof
// alone (increase-only packed-balance receipt; see usdc-permissionless-admin.ts).

/**
 * Deploy the USDC token gated by the FULLY PERMISSIONLESS rate-limited admin
 * (`PermissionlessRateLimitedUsdcAdmin`): any fee payer can mint to ANY address
 * up to the per-recipient daily cap, enforced in-proof + in-ledger, with NO
 * recipient signature. `adminAuthority` keeps only pause/upgrade rights (never
 * mints, need not be funded).
 *
 * Identical atomic deploy sequence to {@link deployUsdcToken} (admin + token +
 * initialize, 3 funded new accounts); only the admin contract class differs.
 * Also points `FungibleToken.AdminContract` at the permissionless admin so any
 * later `token.mint(...)` in this process proves against the DEPLOYED admin
 * circuit.
 */
export async function deployPermissionlessUsdcToken(opts: {
  feePayer: PublicKey;
  /** Public key of the PAUSE/UPGRADE authority (never needed for minting). */
  adminAuthority: PublicKey;
  /** Account for the PermissionlessRateLimitedUsdcAdmin contract. */
  adminContractKey: PrivateKey;
  /** Account for the FungibleToken contract. */
  tokenKey: PrivateKey;
  /** Signing keys (fee payer + the two contract account keys). */
  signers: PrivateKey[];
  network: string;
  /** zkApp tx fee in nanomina; defaults to MINT_FEE_NANOMINA (0.1 MINA). */
  feeNanomina?: bigint;
}): Promise<{
  result: UsdcDeployResult;
  token: UsdcChannelToken;
  admin: PermissionlessRateLimitedUsdcAdmin;
  /** Hash of the submitted deploy transaction (for the deploy record). */
  txHash: string;
}> {
  FungibleToken.AdminContract = PermissionlessRateLimitedUsdcAdmin;
  const admin = new PermissionlessRateLimitedUsdcAdmin(opts.adminContractKey.toPublicKey());
  const token = new UsdcChannelToken(opts.tokenKey.toPublicKey());

  const tx = await Mina.transaction(
    { sender: opts.feePayer, fee: UInt64.from(opts.feeNanomina ?? MINT_FEE_NANOMINA) },
    async () => {
      // Three new accounts pay the account-creation fee: admin, token, circulation.
      AccountUpdate.fundNewAccount(opts.feePayer, 3);
      await admin.deploy({ adminPublicKey: opts.adminAuthority });
      await token.deploy(usdcDeployProps);
      await token.initialize(
        opts.adminContractKey.toPublicKey(),
        USDC_DECIMALS_U8,
        USDC_START_UNPAUSED // start unpaused
      );
    }
  );
  await tx.prove();
  const pending = await tx.sign(opts.signers).send();

  const result: UsdcDeployResult = {
    tokenAddress: opts.tokenKey.toPublicKey().toBase58(),
    tokenId: token.deriveTokenId().toString(),
    adminContractAddress: opts.adminContractKey.toPublicKey().toBase58(),
    adminAuthority: opts.adminAuthority.toBase58(),
    decimals: USDC_DECIMALS,
    network: opts.network,
  };

  return { result, token, admin, txHash: pending.hash };
}

/** Options for building a permissionless mint-to-arbitrary-recipient transaction. */
export interface MintTxOptions {
  /** Token deployed with the PERMISSIONLESS admin contract. */
  token: FungibleToken;
  feePayer: PublicKey;
  /** Mint recipient — does NOT sign (any address). */
  recipient: PublicKey;
  /** Whole USDC to mint (scaled to 6-dp base units). */
  wholeUsdc: bigint;
  /** Signing keys — the FEE PAYER only (no recipient, no admin key). */
  signers: PrivateKey[];
  /**
   * New accounts this tx must fund: 2 on a recipient's FIRST mint (token
   * account + mint-receipt account), 0 afterwards. Paid by the fee payer.
   */
  fundNewAccounts?: number;
  /** zkApp tx fee in nanomina; defaults to MINT_FEE_NANOMINA (0.1 MINA). */
  feeNanomina?: bigint;
  /** Explicit fee-payer nonce override (for queueing txs before inclusion). */
  nonce?: number;
}

/**
 * Build + prove + sign (but do NOT send) a permissionless mint transaction to an
 * ARBITRARY recipient. Signed by the FEE PAYER only — the recipient never signs.
 *
 * Exposed separately from {@link mintUsdcPermissionless} so callers can control
 * send ordering (e.g. the on-chain rejection smoke proves a second mint against
 * the pre-first-mint receipt balance, sends the first, then submits the stale
 * one and captures the ledger's balance-precondition failure).
 */
export async function buildMintTx(opts: MintTxOptions): Promise<Mina.Transaction<true, true>> {
  // Route `token.mint`'s admin call through the permissionless circuit (the
  // deployed admin account carries the PermissionlessRateLimitedUsdcAdmin vk).
  FungibleToken.AdminContract = PermissionlessRateLimitedUsdcAdmin;
  const amount = UInt64.from(opts.wholeUsdc * ONE_USDC);
  const fundNewAccounts = opts.fundNewAccounts ?? 0;
  const tx = await Mina.transaction(
    {
      sender: opts.feePayer,
      fee: UInt64.from(opts.feeNanomina ?? MINT_FEE_NANOMINA),
      ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
    },
    async () => {
      if (fundNewAccounts > 0) AccountUpdate.fundNewAccount(opts.feePayer, fundNewAccounts);
      await opts.token.mint(opts.recipient, amount);
    }
  );
  const proven = await tx.prove();
  return proven.sign(opts.signers);
}

/**
 * Permissionless mint to an arbitrary recipient: build, send, and return the
 * recipient's post-mint balance (base units) as a string. The FEE PAYER signs;
 * NO recipient or admin signature is involved.
 */
export async function mintUsdcPermissionless(opts: MintTxOptions): Promise<string> {
  const tx = await buildMintTx(opts);
  await tx.send();
  return (await opts.token.getBalanceOf(opts.recipient)).toString();
}
