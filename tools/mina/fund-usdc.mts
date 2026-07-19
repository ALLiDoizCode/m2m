/**
 * Admin-mint USDC to a recipient on a Mina network — LEGACY (stock-admin
 * deploys ONLY, e.g. the lightnet box's local token).
 *
 * ⚠️  DOES NOT WORK against the CURRENT public-devnet USDC token
 * (infra/linode/endpoints.json "mina"): that token is gated by
 * `RateLimitedUsdcAdmin` — mints are permissionless but require the
 * RECIPIENT's signature and are capped per address per ~24h, and the admin
 * key holds pause/upgrade rights only (no mint monopoly). For that token use
 * `tools/mina/self-mint-usdc.mts` (or `infra/mina/fund-mina-usdc.sh`, which
 * wraps it; this CLI stays reachable via its `--admin-mint` legacy flag), or
 * the faucet's POST /api/mina/usdc-request treasury-transfer drip for
 * zero-MINA recipients (packages/faucet).
 *
 * Analogous to `infra/solana/fund-solana.sh` (SPL transfer from a treasury), but
 * Mina has no token CLI — minting requires o1js, so this is the funding core.
 *
 * The `FungibleTokenAdmin` gates `mint`; the admin AUTHORITY key
 * (`MINA_USDC_ADMIN_KEY`) must sign and must be a FUNDED account (it pays the
 * recipient's token-account creation fee on first mint — the #190 gotcha).
 *
 * Unlike the EVM faucet / Solana treasury (which transfer from a pre-funded
 * balance), here we MINT directly — simplest funding primitive for a devnet mock.
 *
 * ── Why this CLI is a PURE-ESM `.mts` (issue #352) ───────────────────────────
 * Same single-o1js-instance requirement as tools/mina/deploy-usdc-token.mts
 * (see its header): the ESM-only `mina-fungible-token` + o1js's dual CJS/ESM
 * build means any CJS-transpiled run (the old `npx ts-node`) loads TWO o1js
 * copies and `UsdcChannelToken.compile()` dies with `TypeError: Cannot read
 * properties of undefined (reading 'run')`. Run as ESM via `tsx`, importing the
 * pure-ESM `packages/mina-zkapp/dist-esm/` build:
 *     npm run build:esm --workspace=packages/mina-zkapp   # required first
 *
 * ── Live mint ────────────────────────────────────────────────────────────────
 *   export MINA_USDC_ADMIN_KEY=<base58 admin authority private key, FUNDED>
 *   npx tsx tools/mina/fund-usdc.mts \
 *     --network https://api.minascan.io/node/devnet/v1/graphql \
 *     --token <tokenAddress base58> \
 *     --admin-contract <adminContractAddress base58> \
 *     --recipient <recipient base58> \
 *     --amount 1000          # whole USDC (default 1000)
 *
 * ── Local smoke test ─────────────────────────────────────────────────────────
 *   Deploys a fresh USDC token then mints, on Mina.LocalBlockchain:
 *     npx tsx tools/mina/fund-usdc.mts --local
 *   The same flow is jest-tested in packages/mina-zkapp/src/usdc-deploy.test.ts
 *   (runs in CI).
 *
 * Epic: USDC settlement across all chains (connector#188), ticket #193; the
 * pure-ESM runner is the fix for the o1js UsdcChannelToken compile skew issue
 * (#352).
 *
 * @module fund-usdc
 */

/* eslint-disable no-console */

import { Mina, PrivateKey, PublicKey } from 'o1js';

// Pure-ESM build of the zkApp lib (npm run build:esm --workspace=packages/mina-zkapp).
// Importing src/ (or the CJS dist/) here would re-introduce the dual-o1js seam.
import { ONE_USDC } from '../../packages/mina-zkapp/dist-esm/usdc-token.js';
import { FungibleTokenAdmin } from '../../packages/mina-zkapp/dist-esm/usdc-token.js';
// The deployed USDC owner is `UsdcChannelToken` (Phase A). Its on-chain
// verification key is the SUBCLASS's, so we must instantiate/compile that exact
// class for mint proofs to be accepted on-chain. `mint` itself is inherited
// unchanged from `FungibleToken`.
import { UsdcChannelToken } from '../../packages/mina-zkapp/dist-esm/usdc-channel-token.js';
import { deployUsdcToken, mintUsdc } from '../../packages/mina-zkapp/dist-esm/usdc-deploy.js';

const DEFAULT_NETWORK = 'https://api.minascan.io/node/devnet/v1/graphql';
const DEFAULT_AMOUNT_USDC = 1000n;

interface CliArgs {
  network: string;
  token: string;
  adminContract: string;
  recipient: string;
  amount: bigint;
  fundRecipient: boolean;
  local: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let network = '';
  let token = '';
  let adminContract = '';
  let recipient = '';
  let amount = DEFAULT_AMOUNT_USDC;
  let fundRecipient = true;
  let local = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--network' && next) {
      network = next;
      i++;
    } else if (arg === '--token' && next) {
      token = next;
      i++;
    } else if (arg === '--admin-contract' && next) {
      adminContract = next;
      i++;
    } else if (arg === '--recipient' && next) {
      recipient = next;
      i++;
    } else if (arg === '--amount' && next) {
      amount = BigInt(next);
      i++;
    } else if (arg === '--no-fund-recipient') {
      fundRecipient = false;
    } else if (arg === '--local') {
      local = true;
    }
  }

  if (!local) {
    if (!network) network = DEFAULT_NETWORK;
    for (const [flag, val] of [
      ['--token', token],
      ['--admin-contract', adminContract],
      ['--recipient', recipient],
    ] as const) {
      if (!val) {
        console.error(`Error: ${flag} <base58> is required for a live mint.`);
        process.exit(1);
      }
    }
    if (!network.startsWith('https://')) {
      console.error('Error: --network must use HTTPS. Received: ' + network);
      process.exit(1);
    }
  }

  return { network, token, adminContract, recipient, amount, fundRecipient, local };
}

/** Local smoke test: deploy a fresh USDC token then admin-mint to a recipient. */
async function runLocal(): Promise<void> {
  console.log('Local smoke test: minting USDC on Mina.LocalBlockchain (proofsEnabled: false)\n');
  const Local = await Mina.LocalBlockchain({ proofsEnabled: false });
  Mina.setActiveInstance(Local);
  const [deployer, recipient, adminAuthority] = Local.testAccounts;

  const adminContractKey = PrivateKey.random();
  const tokenKey = PrivateKey.random();

  const { token } = await deployUsdcToken({
    feePayer: deployer,
    adminAuthority,
    adminContractKey,
    tokenKey,
    signers: [deployer.key, adminContractKey, tokenKey],
    network: 'LocalBlockchain',
  });

  const wholeUsdc = 1000n;
  const balance = await mintUsdc({
    token,
    feePayer: deployer,
    recipient,
    wholeUsdc,
    signers: [deployer.key, adminAuthority.key],
    fundRecipient: true,
  });

  const expected = (wholeUsdc * ONE_USDC).toString();
  if (balance !== expected) {
    throw new Error(`mint mismatch: ${balance} != ${expected}`);
  }
  console.log(`  ✓ admin-minted ${wholeUsdc} USDC to recipient (balance ${balance})`);
  console.log('\nLocal smoke test PASSED.');
}

/** Live mint against a Mina GraphQL endpoint. */
async function runLive(args: CliArgs): Promise<void> {
  const adminRaw = process.env['MINA_USDC_ADMIN_KEY'];
  if (!adminRaw) {
    console.error(
      'Error: MINA_USDC_ADMIN_KEY (base58 admin authority private key) is required.\n' +
        '  It must be the FUNDED mint authority set at deploy time.'
    );
    process.exit(1);
  }
  const adminAuthority = PrivateKey.fromBase58(adminRaw);

  console.log(`Connecting to Mina network: ${args.network}`);
  const Network = Mina.Network({ mina: args.network });
  Mina.setActiveInstance(Network);

  console.log('Compiling FungibleTokenAdmin + UsdcChannelToken circuits...');
  await FungibleTokenAdmin.compile();
  await UsdcChannelToken.compile();

  const token = new UsdcChannelToken(PublicKey.fromBase58(args.token));
  // Bind the token to its admin contract so mint resolves the right authority.
  // (FungibleToken reads its admin from on-chain state; the address is informational
  // here, but we surface it for operator clarity.)
  const feePayer = adminAuthority.toPublicKey();
  const recipient = PublicKey.fromBase58(args.recipient);

  console.log(`Admin authority / fee payer: ${feePayer.toBase58()}`);
  console.log(`Token:                       ${args.token}`);
  console.log(`Admin contract:              ${args.adminContract}`);
  console.log(`Recipient:                   ${args.recipient}`);
  console.log(`Minting ${args.amount} USDC...`);

  const balance = await mintUsdc({
    token,
    feePayer,
    recipient,
    wholeUsdc: args.amount,
    signers: [adminAuthority],
    fundRecipient: args.fundRecipient,
  });

  console.log(`\nFunded ${args.recipient}: ${args.amount} USDC (balance ${balance} base units)`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.local) {
    await runLocal();
  } else {
    await runLive(args);
  }
}

void main().catch((err: unknown) => {
  console.error('USDC mint failed:', err);
  process.exit(1);
});
