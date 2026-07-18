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
 * ── Why this CLI is a PURE-ESM `.mts` (issue #352) ───────────────────────────
 * o1js is a DUAL package: `require('o1js')` loads `dist/node/index.cjs` while
 * `import 'o1js'` loads `dist/node/index.js` — two separate module instances
 * whose `Snarky` bindings are per-instance state. `mina-fungible-token` is
 * ESM-ONLY, so any CJS-transpiled run of this tool (the old `npx ts-node`
 * invocation) loads BOTH o1js builds and `UsdcChannelToken.compile()` dies with
 * `TypeError: Cannot read properties of undefined (reading 'run')` at the first
 * gadget executed in the never-initialized copy. Running the whole graph as ESM
 * — this `.mts` via `tsx`, the zkApp classes from `packages/mina-zkapp/dist-esm/`
 * (the pure-ESM build the lightnet deployer + faucet already use) — keeps o1js
 * single-instance. `PaymentChannel` (tools/mina/deploy-zkapp.ts) never hit this
 * because it does not import `mina-fungible-token`.
 *
 * The deploy sequence mirrors `packages/mina-zkapp/src/usdc-deploy.test.ts`:
 *   1. deploy a `FungibleTokenAdmin` with `{ adminPublicKey }` (the mint authority)
 *   2. deploy a `FungibleToken` with `usdcDeployProps`
 *   3. `token.initialize(adminContract.address, UInt8.from(6), Bool(false))`
 * all in one atomic transaction (funding 3 new accounts: admin, token, circulation).
 *
 * GOTCHA (from #190): with the STOCK admin, the mint authority
 * (MINA_USDC_ADMIN_KEY) must be a FUNDED account — an unfunded admin key breaks
 * account-creation-fee accounting when minting. On a live deploy, fund both the
 * deployer AND the admin authority from the Mina devnet faucet
 * (https://faucet.minaprotocol.com) first.
 *
 * ── `--rate-limited` (the canonical shared-devnet flavor) ────────────────────
 * Deploys `RateLimitedUsdcAdmin` instead of the stock `FungibleTokenAdmin`:
 * ANY address can mint USDC to itself, capped per address per ~day IN-PROOF
 * (per-address mint-receipt accounts under the admin's token id; see
 * packages/mina-zkapp/src/usdc-rate-limited-admin.ts). The admin authority
 * keeps only pause/upgrade rights, never signs mints, and need NOT be funded —
 * pass its bare public key as MINA_USDC_ADMIN_PUBLIC (or fall back to
 * MINA_USDC_ADMIN_KEY). Self-mints: tools/mina/self-mint-usdc.mts.
 *
 * ── Live deploy (public devnet) ──────────────────────────────────────────────
 *   Build the pure-ESM zkApp lib first (required — this CLI imports dist-esm/):
 *     npm run build:esm --workspace=packages/mina-zkapp
 *
 *   export MINA_DEPLOYER_KEY=<base58 private key, FUNDED on devnet>
 *   export MINA_USDC_ADMIN_KEY=<base58 private key, FUNDED on devnet>   # mint authority
 *   # optional: pin deterministic token/admin contract accounts across re-runs
 *   #   export MINA_USDC_TOKEN_KEY=<base58 private key>
 *   #   export MINA_USDC_ADMIN_CONTRACT_KEY=<base58 private key>
 *
 *   npx tsx tools/mina/deploy-usdc-token.mts \
 *     --network https://api.minascan.io/node/devnet/v1/graphql \
 *     --out infra/mina/usdc-token.json
 *
 *   → prints + persists { tokenAddress, tokenId, adminContractAddress, adminAuthority }
 *     and (to stderr) the generated contract private keys. Pin tokenAddress/tokenId
 *     into infra/linode/endpoints.json.
 *
 * ── Compile-only dry run (no network, no keys, no funds) ─────────────────────
 *   Compiles FungibleTokenAdmin + UsdcChannelToken exactly as the live path does,
 *   prints timings + verification-key hashes, and exits. This is the CI/regression
 *   surface for the #352 duplicate-instance failure:
 *     npx tsx tools/mina/deploy-usdc-token.mts --compile-only
 *
 * ── Local smoke test (no network, no funded key) ─────────────────────────────
 *   Deploys + mints on Mina.LocalBlockchain (proofsEnabled: false):
 *     npx tsx tools/mina/deploy-usdc-token.mts --local
 *   The same flow is jest-tested in packages/mina-zkapp/src/usdc-deploy.test.ts
 *   (runs in CI).
 *
 * Epic: USDC settlement across all chains (connector#188), ticket #193; the
 * pure-ESM runner is the fix for the o1js UsdcChannelToken compile skew issue
 * (#352).
 *
 * @module deploy-usdc-token
 */

/* eslint-disable no-console */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';

// Pure-ESM build of the zkApp lib (npm run build:esm --workspace=packages/mina-zkapp).
// Importing src/ (or the CJS dist/) here would re-introduce the dual-o1js seam.
import {
  FungibleTokenAdmin,
  USDC_DECIMALS,
  ONE_USDC,
} from '../../packages/mina-zkapp/dist-esm/usdc-token.js';
import { UsdcChannelToken } from '../../packages/mina-zkapp/dist-esm/usdc-channel-token.js';
import { RateLimitedUsdcAdmin } from '../../packages/mina-zkapp/dist-esm/usdc-rate-limited-admin.js';
import {
  deployRateLimitedUsdcToken,
  deployUsdcToken,
  mintUsdc,
  selfMintUsdc,
} from '../../packages/mina-zkapp/dist-esm/usdc-deploy.js';
// Type-only import (erased at runtime — loads NO module, so no dual-o1js risk).
import type { UsdcDeployResult } from '../../packages/mina-zkapp/src/usdc-deploy';

const DEFAULT_NETWORK = 'https://api.minascan.io/node/devnet/v1/graphql';

interface CliArgs {
  network: string;
  out: string | undefined;
  local: boolean;
  compileOnly: boolean;
  /**
   * Deploy with the RATE-LIMITED admin (`RateLimitedUsdcAdmin`): anyone can
   * mint to themselves up to the per-address daily cap (enforced in-proof +
   * in-ledger); the admin authority keeps only pause/upgrade rights and does
   * NOT need to be funded. This is the canonical shared-devnet flavor since
   * the rate-limited mint redeploy (#352 follow-up).
   */
  rateLimited: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let network = '';
  let out: string | undefined;
  let local = false;
  let compileOnly = false;
  let rateLimited = false;

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
    } else if (arg === '--compile-only') {
      compileOnly = true;
    } else if (arg === '--rate-limited') {
      rateLimited = true;
    }
  }

  if (!local && !compileOnly) {
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

  return { network, out, local, compileOnly, rateLimited };
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

/**
 * Compile both circuits the live deploy needs (the admin flavor selected by
 * `--rate-limited` + the token), printing timing + vk hash for each. Shared by
 * `runLive` and the `--compile-only` dry run so the dry run exercises the
 * EXACT compile path that broke in the field (#352). Returns the vk hashes so
 * the live deploy can persist them in the deploy record.
 */
async function compileCircuits(rateLimited: boolean): Promise<Record<string, string>> {
  const adminEntry = rateLimited
    ? (['RateLimitedUsdcAdmin', RateLimitedUsdcAdmin] as const)
    : (['FungibleTokenAdmin', FungibleTokenAdmin] as const);
  console.log(`Compiling ${adminEntry[0]} + UsdcChannelToken circuits...`);
  const vkHashes: Record<string, string> = {};
  for (const [name, contract] of [adminEntry, ['UsdcChannelToken', UsdcChannelToken] as const]) {
    const t0 = Date.now();
    const { verificationKey } = await contract.compile();
    vkHashes[name] = verificationKey.hash.toString();
    console.log(
      `  ${name}.compile() ok in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
        ` — vk hash ${vkHashes[name]}`
    );
  }
  return vkHashes;
}

/** Local smoke test on Mina.LocalBlockchain — proves deploy + mint with no network. */
async function runLocal(args: CliArgs): Promise<void> {
  const flavor = args.rateLimited ? 'RATE-LIMITED' : 'admin-gated';
  console.log(
    `Local smoke test: deploying ${flavor} USDC on Mina.LocalBlockchain (proofsEnabled: false)\n`
  );
  const Local = await Mina.LocalBlockchain({ proofsEnabled: false });
  Mina.setActiveInstance(Local);
  const [deployer, recipient, adminAuthority] = Local.testAccounts;

  // Cache verification keys so deploy() can find them (cheap with proofs off).
  await (args.rateLimited ? RateLimitedUsdcAdmin.compile() : FungibleTokenAdmin.compile());
  await UsdcChannelToken.compile();

  const adminContractKey = PrivateKey.random();
  const tokenKey = PrivateKey.random();

  const deployOpts = {
    feePayer: deployer,
    adminAuthority,
    adminContractKey,
    tokenKey,
    signers: [deployer.key, adminContractKey, tokenKey],
    network: 'LocalBlockchain',
  };
  const { result, token } = args.rateLimited
    ? await deployRateLimitedUsdcToken(deployOpts)
    : await deployUsdcToken(deployOpts);

  const decimals = token.decimals.get().toString();
  if (decimals !== String(USDC_DECIMALS)) {
    throw new Error(`expected ${USDC_DECIMALS} decimals, got ${decimals}`);
  }
  console.log(`  ✓ deployed at ${decimals} decimals`);
  console.log(`  ✓ tokenAddress = ${result.tokenAddress}`);
  console.log(`  ✓ tokenId      = ${result.tokenId}`);

  const wholeUsdc = 1000n;
  const balance = args.rateLimited
    ? // Prove the PERMISSIONLESS path: recipient self-mints (no admin key).
      await selfMintUsdc({
        token,
        feePayer: deployer,
        recipient,
        wholeUsdc,
        signers: [deployer.key, recipient.key],
        fundNewAccounts: 2, // token account + mint-receipt account
      })
    : // Prove the admin authority can mint (the funding path).
      await mintUsdc({
        token,
        feePayer: deployer,
        recipient,
        wholeUsdc,
        signers: [deployer.key, adminAuthority.key],
        fundRecipient: true,
      });
  const amount = UInt64.from(wholeUsdc * ONE_USDC);
  if (balance !== amount.toString()) {
    throw new Error(`mint mismatch: ${balance} != ${amount.toString()}`);
  }
  const verb = args.rateLimited ? 'self-minted (permissionless)' : 'admin-minted';
  console.log(`  ✓ ${verb} 1,000 USDC to a recipient (balance ${balance})`);
  console.log('\nLocal smoke test PASSED.');
}

/**
 * Resolve the admin AUTHORITY public key for a live deploy. The rate-limited
 * admin never signs mints, so `--rate-limited` deploys accept a bare PUBLIC
 * key (MINA_USDC_ADMIN_PUBLIC) — the pause/upgrade private key can stay cold.
 * The stock flavor still requires the private key (MINA_USDC_ADMIN_KEY), which
 * must be FUNDED (it signs + pays on every mint — the #190 gotcha).
 */
function requireAdminAuthorityPublic(rateLimited: boolean): PublicKey {
  const pub = process.env['MINA_USDC_ADMIN_PUBLIC'];
  if (rateLimited && pub) return PublicKey.fromBase58(pub);
  return requireKey('MINA_USDC_ADMIN_KEY').toPublicKey();
}

/** Live deploy against a Mina GraphQL endpoint. */
async function runLive(args: CliArgs): Promise<void> {
  const deployer = requireKey('MINA_DEPLOYER_KEY');
  const adminAuthority = requireAdminAuthorityPublic(args.rateLimited);
  const adminContractKey = keyFromEnvOrRandom('MINA_USDC_ADMIN_CONTRACT_KEY');
  const tokenKey = keyFromEnvOrRandom('MINA_USDC_TOKEN_KEY');

  console.log(`Connecting to Mina network: ${args.network}`);
  const Network = Mina.Network({ mina: args.network });
  Mina.setActiveInstance(Network);

  const t0 = Date.now();
  const vkHashes = await compileCircuits(args.rateLimited);
  console.log(`Compilation complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const deployerPub = deployer.toPublicKey();
  const flavor = args.rateLimited ? 'RATE-LIMITED (permissionless mint)' : 'admin-gated';
  console.log(`Admin flavor:           ${flavor}`);
  console.log(`Deployer address:       ${deployerPub.toBase58()}`);
  console.log(`Admin authority:        ${adminAuthority.toBase58()}`);
  console.log(`Token account:          ${tokenKey.toPublicKey().toBase58()}`);
  console.log(`Admin contract account: ${adminContractKey.toPublicKey().toBase58()}`);

  console.log('Deploying USDC token (admin + token + initialize)...');
  const deployOpts = {
    feePayer: deployerPub,
    adminAuthority,
    adminContractKey,
    tokenKey,
    signers: [deployer, adminContractKey, tokenKey],
    network: args.network,
  };
  let result: UsdcDeployResult;
  let txHash: string | undefined;
  if (args.rateLimited) {
    ({ result, txHash } = await deployRateLimitedUsdcToken(deployOpts));
  } else {
    ({ result } = await deployUsdcToken(deployOpts));
  }

  printResult(result);
  if (txHash) console.log(`deployTx:             ${txHash}`);

  if (args.out) {
    const outPath = path.resolve(args.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const record = { ...result, ...(txHash ? { deployTx: txHash } : {}), vkHashes };
    await fs.writeFile(outPath, JSON.stringify(record, null, 2) + '\n');
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

function printResult(result: UsdcDeployResult): void {
  console.log('\n=== USDC Token Deployment Complete ===');
  console.log(`tokenAddress:         ${result.tokenAddress}`);
  console.log(`tokenId:              ${result.tokenId}`);
  console.log(`adminContractAddress: ${result.adminContractAddress}`);
  console.log(`adminAuthority:       ${result.adminAuthority}`);
  console.log(`decimals:             ${result.decimals}`);
  console.log(`network:              ${result.network}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.compileOnly) {
    const t0 = Date.now();
    await compileCircuits(args.rateLimited);
    console.log(
      `Compile-only run complete in ${((Date.now() - t0) / 1000).toFixed(1)}s (no network, nothing deployed).`
    );
  } else if (args.local) {
    await runLocal(args);
  } else {
    await runLive(args);
  }
}

void main().catch((err: unknown) => {
  console.error('USDC token deploy failed:', err);
  process.exit(1);
});
