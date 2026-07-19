/**
 * Deployed mock-USDC token coordinates (Mina DEVNET) + faucet policy constants.
 *
 * These pin the EXACT on-chain token this dApp mints. The verification-key
 * hashes the admin account enforces were produced by `o1js@2.14.0` +
 * `mina-fungible-token@1.1.0` (see package.json) compiling
 * `PermissionlessRateLimitedUsdcAdmin` + `UsdcChannelToken` — those versions are
 * pinned so the browser prover reproduces the SAME vk and the admin account
 * accepts the proof. Bumping either dependency changes the vk and the mint is
 * rejected on-chain.
 *
 * Source of truth: infra/mina/usdc-token.json on branch feat/permissionless-usdc-mint.
 */

/** The deployed FungibleToken (UsdcChannelToken) owner zkApp address. */
export const TOKEN_ADDRESS = 'B62qnZnmV3jADwYCpofKdbS23Z6vP89w7TC6rsXw9ejR53YfTwmKLsa';
/** The deployed PermissionlessRateLimitedUsdcAdmin contract address. */
export const ADMIN_CONTRACT_ADDRESS = 'B62qk3RsLgL38Vk7nDzGT3XHBjtzN9W9zz4A6WS2a6DhBMac9N8NKDs';
/** USDC token id (base10 Field) — where recipients hold their minted USDC. */
export const USDC_TOKEN_ID =
  '13195431355853976025555236213553162231466702378883981110250774386432112635553';
/**
 * Admin-derived token id (base58) — where per-recipient mint-RECEIPT accounts
 * live (TokenId.derive(adminContractAddress, defaultTokenId)). The daily
 * allowance is read as this account's packed BALANCE. Precomputed with o1js so
 * the allowance query needs no o1js on the main thread.
 */
export const ADMIN_TOKEN_ID_B58 = 'wwLYGJExaeGvWGqUThMiF8TpFyhuByCXh4SCKocCtRAQUQdsyq';

/** Devnet node GraphQL endpoint (proving context + account/receipt reads). */
export const NETWORK_GRAPHQL = 'https://api.minascan.io/node/devnet/v1/graphql';

/** 6-decimal token. */
export const USDC_DECIMALS = 6;
export const ONE_USDC = 10n ** BigInt(USDC_DECIMALS);
/** Per-recipient daily cap: 1000 whole USDC per ~24h (480-slot) window. */
export const DAILY_MINT_CAP_USDC = 1000n;
/** What the faucet button mints in one click. */
export const FAUCET_MINT_WHOLE_USDC = 1000n;
/** ~24h window length in Mina slots (3-min slots). Mirrors MINT_WINDOW_SLOTS. */
export const MINT_WINDOW_SLOTS = 480n;

/** minascan explorer helpers. */
export const MINASCAN_TX = (hash: string) => `https://minascan.io/devnet/tx/${hash}`;
export const MINASCAN_ACCOUNT = (addr: string) => `https://minascan.io/devnet/account/${addr}`;

export const AURO_URL = 'https://www.aurowallet.com/';
export const MINA_FAUCET_URL = 'https://faucet.minaprotocol.com';

/** Expected Auro network for devnet. Auro reports `networkID` like `mina:devnet`. */
export const EXPECTED_NETWORK_HINTS = ['devnet', 'testnet'];
