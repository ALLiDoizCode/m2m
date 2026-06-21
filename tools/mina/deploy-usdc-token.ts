/**
 * Deploy the USDC token-owner zkApp (mina-fungible-token) to a Mina network.
 *
 * Mina has no native ERC-20: a fungible token is defined by a token-owner zkApp.
 * We deploy `UsdcChannelToken` — the in-proof-enforcing token owner (a
 * `FungibleToken` subclass; Phase A) — as USDC at **6 decimals** (matching the EVM
 * MockERC20 + the Solana SPL mint) so a payment-channel claim's base-unit amount
 * means the same thing on every chain — no cross-chain decimal normalization
 * required. Deploy + initialize are byte-for-byte the stock `FungibleToken`
 * sequence; the subclass only ADDS the channel-bound escrow/deposit/settle methods.
 *
 * Because we PROXY the public Mina devnet (no self-hosted node), the token is
 * deployed ONCE to public devnet; its address + derived `tokenId` are then pinned
 * in `infra/linode/endpoints.json` (`mina.tokenAddress`, `mina.tokenId`). Minting
 * to peers is done by the admin authority via `infra/mina/fund-mina-usdc.sh`.
 *
 * The deploy sequence mirrors `packages/mina-zkapp/src/usdc-token.test.ts`:
 *   1. deploy a `FungibleTokenAdmin` with `{ adminPublicKey }` (the mint authority)
 *   2. deploy a `FungibleToken` with `usdcDeployProps`
 *   3. `token.initialize(adminContract.address, UInt8.from(6), Bool(false))`
 * all in one atomic transaction (funding 3 new accounts: admin, token, circulation).
 *
 * GOTCHA (from #190): the mint authority (`--admin-key` / MINA_USDC_ADMIN_KEY) must
 * be a FUNDED account — an unfunded admin key breaks account-creation-fee accounting
 * when minting. On a live deploy, fund both the deployer AND the admin authority
 * from the Mina devnet faucet (https://faucet.minaprotocol.com) first.
 *
 * ── Live deploy (public devnet) ──────────────────────────────────────────────
 *   Build the zkApp lib first so `mina-fungible-token` + o1js resolve:
 *     npm run build --workspace=packages/mina-zkapp   # (optional; we import src)
 *
 *   export MINA_DEPLOYER_KEY=<base58 private key, FUNDED on devnet>
 *   export MINA_USDC_ADMIN_KEY=<base58 private key, FUNDED on devnet>   # mint authority
 *   # optional: pin deterministic token/admin contract accounts across re-runs
 *   #   export MINA_USDC_TOKEN_KEY=<base58 private key>
 *   #   export MINA_USDC_ADMIN_CONTRACT_KEY=<base58 private key>
 *
 *   npx ts-node tools/mina/deploy-usdc-token.ts \
 *     --network https://api.minascan.io/node/devnet/v1/graphql \
 *     --out infra/mina/usdc-token.json
 *
 *   → prints + persists { tokenAddress, tokenId, adminContractAddress, adminAuthority }
 *     and (to stderr) the generated contract private keys. Pin tokenAddress/tokenId
 *     into infra/linode/endpoints.json.
 *
 * ── Local smoke test (no network, no funded key) ─────────────────────────────
 *   The authoritative smoke test is the jest suite (it compiles the ESM
 *   `mina-fungible-token` to CJS so it shares ONE o1js instance — required, else
 *   o1js throws "Must call Mina.setActiveInstance first" from a duplicate copy):
 *     npx jest --config tools/mina/jest.config.js
 *   It exercises the exported `deployUsdcToken` (6-dp deploy + tokenId) and
 *   `mintUsdc` (admin-mint) used by this script and fund-usdc.ts.
 *
 *   The `--local` flag below runs the same flow standalone, but ONLY works when
 *   o1js is loaded as a single module instance (e.g. a bundled build); under bare
 *   `ts-node` the ESM/CJS split breaks it. Prefer the jest suite.
 *     npx ts-node tools/mina/deploy-usdc-token.ts --local
 *
 * Epic: USDC settlement across all chains (connector#188), ticket #193.
 *
 * @module deploy-usdc-token
 */

/* eslint-disable no-console */

import { promises as fs } from 'fs';
import * as path from 'path';

import { AccountUpdate, Bool, Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';

import {
  FungibleTokenAdmin,
  USDC_DECIMALS,
  USDC_DECIMALS_U8,
  ONE_USDC,
  usdcDeployProps,
} from '../../packages/mina-zkapp/src/usdc-token';
// In-proof-enforcing USDC token owner (Phase A). Deploys EXACTLY like the stock
// `FungibleToken` (same usdcDeployProps / initialize), but ADDS the channel-bound
// `enableChannelEscrow` / `depositToChannel` / `settleFromChannel` methods so the
// PROOF (not the SDK) binds escrow payouts to the channel commitment.
import { UsdcChannelToken } from '../../packages/mina-zkapp/src/usdc-channel-token';

const DEFAULT_NETWORK = 'https://api.minascan.io/node/devnet/v1/graphql';

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
 * Build (and, when `send` is true, submit) the atomic deploy transaction for the
 * USDC admin + token contracts. Returns the deploy result plus the contract
 * instances so callers (deploy + smoke test) can reuse them for a follow-up mint.
 *
 * Shared by the live path and the local smoke test so the exact deploy sequence
 * is verified without a network.
 */
export async function deployUsdcToken(opts: {
  feePayer: PublicKey;
  /** Private key of the admin AUTHORITY (mint authority) — must be FUNDED. */
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
      Bool(false) // start unpaused
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

interface CliArgs {
  network: string;
  out: string | undefined;
  local: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let network = '';
  let out: string | undefined;
  let local = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--network' && next) {
      network = next;
      i++;
    } else if (arg === '--out' && next) {
      out = next;
      i++;
    } else if (arg === '--local') {
      local = true;
    }
  }

  if (!local) {
    if (!network) network = DEFAULT_NETWORK;
    if (!network.startsWith('https://')) {
      console.error(
        'Error: --network must use HTTPS to protect transaction data in transit.\n' +
          '  Received: ' +
          network
      );
      process.exit(1);
    }
  }

  return { network, out, local };
}

/** Require a base58 private key from env, exiting with a clear message if absent. */
function requireKey(envVar: string): PrivateKey {
  const raw = process.env[envVar];
  if (!raw) {
    console.error(
      `Error: ${envVar} (base58 private key) is required for a live deploy.\n` +
        '  Both the deployer and the admin authority must be FUNDED on devnet.\n' +
        '  Fund them at https://faucet.minaprotocol.com before deploying.'
    );
    process.exit(1);
  }
  return PrivateKey.fromBase58(raw);
}

/** Optional pinned contract account key, else a fresh random one. */
function keyFromEnvOrRandom(envVar: string): PrivateKey {
  const raw = process.env[envVar];
  return raw ? PrivateKey.fromBase58(raw) : PrivateKey.random();
}

/** Local smoke test on Mina.LocalBlockchain — proves deploy + mint with no network. */
async function runLocal(): Promise<void> {
  console.log('Local smoke test: deploying USDC on Mina.LocalBlockchain (proofsEnabled: false)\n');
  const Local = await Mina.LocalBlockchain({ proofsEnabled: false });
  Mina.setActiveInstance(Local);
  const [deployer, recipient, adminAuthority] = Local.testAccounts;

  // Cache verification keys so deploy() can find them (cheap with proofs off).
  await FungibleTokenAdmin.compile();
  await UsdcChannelToken.compile();

  const adminContractKey = PrivateKey.random();
  const tokenKey = PrivateKey.random();

  const { result, token } = await deployUsdcToken({
    feePayer: deployer,
    adminAuthority,
    adminContractKey,
    tokenKey,
    signers: [deployer.key, adminContractKey, tokenKey],
    network: 'LocalBlockchain',
  });

  const decimals = token.decimals.get().toString();
  if (decimals !== String(USDC_DECIMALS)) {
    throw new Error(`expected ${USDC_DECIMALS} decimals, got ${decimals}`);
  }
  console.log(`  ✓ deployed at ${decimals} decimals`);
  console.log(`  ✓ tokenAddress = ${result.tokenAddress}`);
  console.log(`  ✓ tokenId      = ${result.tokenId}`);

  // Prove the admin authority can mint (the funding path).
  const amount = UInt64.from(1000n * ONE_USDC);
  const mintTx = await Mina.transaction(deployer, async () => {
    AccountUpdate.fundNewAccount(deployer, 1);
    await token.mint(recipient, amount);
  });
  await mintTx.prove();
  await mintTx.sign([deployer.key, adminAuthority.key]).send();

  const balance = await token.getBalanceOf(recipient);
  if (balance.toString() !== amount.toString()) {
    throw new Error(`mint mismatch: ${balance.toString()} != ${amount.toString()}`);
  }
  console.log(`  ✓ admin-minted 1,000 USDC to a recipient (balance ${balance.toString()})`);
  console.log('\nLocal smoke test PASSED.');
}

/** Live deploy against a Mina GraphQL endpoint. */
async function runLive(args: CliArgs): Promise<void> {
  const deployer = requireKey('MINA_DEPLOYER_KEY');
  const adminAuthority = requireKey('MINA_USDC_ADMIN_KEY');
  const adminContractKey = keyFromEnvOrRandom('MINA_USDC_ADMIN_CONTRACT_KEY');
  const tokenKey = keyFromEnvOrRandom('MINA_USDC_TOKEN_KEY');

  console.log(`Connecting to Mina network: ${args.network}`);
  const Network = Mina.Network({ mina: args.network });
  Mina.setActiveInstance(Network);

  console.log('Compiling FungibleTokenAdmin + UsdcChannelToken circuits...');
  const t0 = Date.now();
  await FungibleTokenAdmin.compile();
  await UsdcChannelToken.compile();
  console.log(`Compilation complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const deployerPub = deployer.toPublicKey();
  console.log(`Deployer address:       ${deployerPub.toBase58()}`);
  console.log(`Admin authority:        ${adminAuthority.toPublicKey().toBase58()}`);
  console.log(`Token account:          ${tokenKey.toPublicKey().toBase58()}`);
  console.log(`Admin contract account: ${adminContractKey.toPublicKey().toBase58()}`);

  console.log('Deploying USDC token (admin + token + initialize)...');
  const { result } = await deployUsdcToken({
    feePayer: deployerPub,
    adminAuthority: adminAuthority.toPublicKey(),
    adminContractKey,
    tokenKey,
    signers: [deployer, adminContractKey, tokenKey],
    network: args.network,
  });

  console.log('\n=== USDC Token Deployment Complete ===');
  console.log(`tokenAddress:         ${result.tokenAddress}`);
  console.log(`tokenId:              ${result.tokenId}`);
  console.log(`adminContractAddress: ${result.adminContractAddress}`);
  console.log(`adminAuthority:       ${result.adminAuthority}`);
  console.log(`decimals:             ${result.decimals}`);
  console.log(`network:              ${result.network}`);

  if (args.out) {
    const outPath = path.resolve(args.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(result, null, 2) + '\n');
    console.log(`\nPersisted deploy result → ${outPath}`);
  }

  console.log(
    '\nNext: pin tokenAddress + tokenId into infra/linode/endpoints.json' +
      ' (mina.tokenAddress / mina.tokenId) and re-run `devnet.sh endpoints`.'
  );

  // Contract account private keys to stderr only (never into piped stdout / CI logs).
  console.error(
    `\n[SENSITIVE] token account private key: ${tokenKey.toBase58()}` +
      `\n[SENSITIVE] admin contract private key: ${adminContractKey.toBase58()}` +
      '\nSave these securely if you need to upgrade the contracts later.'
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.local) {
    await runLocal();
  } else {
    await runLive(args);
  }
}

if (require.main === module) {
  void main().catch((err: unknown) => {
    console.error('USDC token deploy failed:', err);
    process.exit(1);
  });
}
