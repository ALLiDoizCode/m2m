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
}): Promise<{
  result: UsdcDeployResult;
  token: UsdcChannelToken;
  admin: FungibleTokenAdmin;
}> {
  const admin = new FungibleTokenAdmin(opts.adminContractKey.toPublicKey());
  const token = new UsdcChannelToken(opts.tokenKey.toPublicKey());

  const tx = await Mina.transaction(opts.feePayer, async () => {
    // Three new accounts pay the account-creation fee: admin, token, circulation.
    AccountUpdate.fundNewAccount(opts.feePayer, 3);
    await admin.deploy({ adminPublicKey: opts.adminAuthority });
    await token.deploy(usdcDeployProps);
    await token.initialize(
      opts.adminContractKey.toPublicKey(),
      USDC_DECIMALS_U8,
      USDC_START_UNPAUSED // start unpaused
    );
  });
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
 * Fee (in nanomina) for the mint zkApp command. A zkApp command on the public
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
