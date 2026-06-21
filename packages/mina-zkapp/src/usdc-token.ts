/**
 * USDC token for the TOON devnet on Mina.
 *
 * Mina has no native ERC-20 — a fungible token is defined by a token-owner zkApp.
 * Rather than hand-roll token logic, we use the audited `mina-fungible-token`
 * standard (Mina Foundation): a `FungibleToken` contract gated by a
 * `FungibleTokenAdmin` contract.
 *
 * USDC is configured at **6 decimals** to match the EVM `MockERC20` and the
 * Solana SPL mint, so a payment-channel claim's base-unit amount means the same
 * thing on every chain (1 USDC = 1_000_000 base units) — no cross-chain decimal
 * normalization required.
 *
 * Deploy sequence (see usdc-token.test.ts / the devnet deploy script):
 *   1. deploy a `FungibleTokenAdmin` with `{ adminPublicKey }` (the mint authority)
 *   2. deploy a `FungibleToken` with `usdcDeployProps`
 *   3. `token.initialize(adminContract.address, USDC_DECIMALS_U8, Bool(false))`
 *   4. `token.mint(recipient, amount)` — signed by the admin authority
 *
 * The PaymentChannel zkApp settles in this token by referencing its
 * `token.deriveTokenId()` (the Mina token id) — see the token-aware channel work.
 *
 * @module usdc-token
 */

import { Bool, UInt8 } from 'o1js';
import { FungibleToken, FungibleTokenAdmin } from 'mina-fungible-token';

export { FungibleToken, FungibleTokenAdmin };

/** Human-facing token symbol. */
export const USDC_SYMBOL = 'USDC';

/** Decimals — 6, matching real USDC + the EVM/Solana mocks. */
export const USDC_DECIMALS = 6;
export const USDC_DECIMALS_U8 = UInt8.from(USDC_DECIMALS);

/** 1 USDC expressed in base units (10 ** decimals). */
export const ONE_USDC = 10n ** BigInt(USDC_DECIMALS);

/** zkappUri source reference for the deployed token account. */
export const USDC_SRC =
  'https://github.com/toon-protocol/connector/blob/main/packages/mina-zkapp/src/usdc-token.ts';

/**
 * Deploy props for the USDC `FungibleToken`. `allowUpdates: true` keeps the
 * verification key upgradeable (devnet convenience; reconsider for mainnet).
 */
export const usdcDeployProps = {
  symbol: USDC_SYMBOL,
  src: USDC_SRC,
  allowUpdates: true,
};

/** `startPaused` flag for `initialize` — start live (unpaused) on the devnet. */
export const USDC_START_UNPAUSED = Bool(false);
