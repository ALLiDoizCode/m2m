/**
 * Permissionless MINT of rate-limited USDC to an ARBITRARY recipient on a Mina
 * network — the recipient does NOT sign.
 *
 * The public-devnet USDC token is gated by `PermissionlessRateLimitedUsdcAdmin`
 * (packages/mina-zkapp/src/usdc-permissionless-admin.ts): ANY fee payer can mint
 * to ANY address up to DAILY_MINT_CAP_USDC per recipient per ~day (480 slots),
 * enforced by the `canMint` proof + a per-recipient mint-receipt BALANCE
 * precondition the LEDGER checks at inclusion. No admin key and no recipient key
 * are involved — only the fee payer signs + pays. This is what powers a webpage
 * where a connected wallet mints to a typed-in address, and any third-party /
 * on-chain caller minting to an address.
 *
 * ── Mint to a recipient ──────────────────────────────────────────────────────
 *   export MINA_FEE_PAYER_KEY=<base58 private key, FUNDED on devnet>
 *   npx tsx tools/mina/mint-usdc.mts <recipient-b58> [amount] \
 *     [--token <tokenAddress>] [--admin-contract <adminContractAddress>] \
 *     [--network https://api.minascan.io/node/devnet/v1/graphql] \
 *     [--first-mint | --no-first-mint]   # override auto-detection
 *
 * `amount` defaults to DAILY_MINT_CAP_USDC (whole USDC). `--token` /
 * `--admin-contract` default to infra/mina/usdc-token.json. On a recipient's
 * FIRST mint the fee payer funds 2 new accounts (recipient token account + mint
 * receipt); auto-detected by probing the recipient's token account, overridable.
 *
 * Pure-ESM `.mts` via `npx tsx`, importing packages/mina-zkapp/dist-esm/ — the
 * single-o1js-instance modality (#352). Build first:
 *   npm run build:esm --workspace=packages/mina-zkapp
 *
 * @module mint-usdc
 */

/* eslint-disable no-console */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchAccount, Mina, PrivateKey, PublicKey, TokenId } from 'o1js';

// Pure-ESM build of the zkApp lib (see header — never import src/ or dist/).
import { UsdcChannelToken } from '../../packages/mina-zkapp/dist-esm/usdc-channel-token.js';
import {
  DAILY_MINT_CAP_USDC,
  PermissionlessRateLimitedUsdcAdmin,
} from '../../packages/mina-zkapp/dist-esm/usdc-permissionless-admin.js';
import { buildMintTx } from '../../packages/mina-zkapp/dist-esm/usdc-deploy.js';

const DEFAULT_NETWORK = 'https://api.minascan.io/node/devnet/v1/graphql';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOKEN_RECORD = path.resolve(HERE, '../../infra/mina/usdc-token.json');

interface CliArgs {
  recipient: string;
  amount: bigint;
  network: string;
  token: string;
  adminContract: string;
  firstMint: boolean | undefined; // undefined => auto-detect
  out: string | undefined;
}

async function parseArgs(argv: string[]): Promise<CliArgs> {
  let recipient = '';
  let amount = DAILY_MINT_CAP_USDC;
  let network = DEFAULT_NETWORK;
  let token = '';
  let adminContract = '';
  let firstMint: boolean | undefined;
  let out: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--network' && next) (network = next), i++;
    else if (arg === '--token' && next) (token = next), i++;
    else if (arg === '--admin-contract' && next) (adminContract = next), i++;
    else if (arg === '--out' && next) (out = next), i++;
    else if (arg === '--first-mint') firstMint = true;
    else if (arg === '--no-first-mint') firstMint = false;
    else if (arg.startsWith('--')) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(1);
    } else positionals.push(arg);
  }

  recipient = positionals[0] ?? '';
  if (positionals[1] !== undefined) amount = BigInt(positionals[1]);

  if (!recipient) {
    console.error('Usage: mint-usdc.mts <recipient-b58> [amount] [--token ..] [--admin-contract ..]');
    process.exit(1);
  }
  if (!network.startsWith('https://')) {
    console.error('Error: --network must use HTTPS. Received: ' + network);
    process.exit(1);
  }

  // Fill token / admin-contract from the pinned deploy record if not passed.
  if (!token || !adminContract) {
    try {
      const rec = JSON.parse(await fs.readFile(DEFAULT_TOKEN_RECORD, 'utf8')) as {
        tokenAddress?: string;
        adminContractAddress?: string;
      };
      token ||= rec.tokenAddress ?? '';
      adminContract ||= rec.adminContractAddress ?? '';
    } catch {
      /* fall through to the required-arg check */
    }
  }
  if (!token || !adminContract) {
    console.error(
      'Error: --token and --admin-contract are required (or present in infra/mina/usdc-token.json).'
    );
    process.exit(1);
  }
  return { recipient, amount, network, token, adminContract, firstMint, out };
}

function requireKey(envVar: string): PrivateKey {
  const raw = process.env[envVar];
  if (!raw) {
    console.error(`Error: ${envVar} (base58 private key) is required.`);
    process.exit(1);
  }
  return PrivateKey.fromBase58(raw);
}

/** Raw GraphQL balance query — independent on-chain evidence for the log. */
async function gqlBalance(endpoint: string, publicKey: string, tokenIdB58: string): Promise<string> {
  const query = `query { account(publicKey: "${publicKey}", token: "${tokenIdB58}") { balance { total } } }`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data?: { account?: { balance?: { total: string } } } };
  return body.data?.account?.balance?.total ?? '0';
}

async function main(): Promise<void> {
  const args = await parseArgs(process.argv.slice(2));
  const feePayer = requireKey('MINA_FEE_PAYER_KEY');
  const feePayerPub = feePayer.toPublicKey();
  const recipientPub = PublicKey.fromBase58(args.recipient);

  console.log(`Connecting to Mina network: ${args.network}`);
  Mina.setActiveInstance(Mina.Network({ mina: args.network }));

  console.log('Compiling PermissionlessRateLimitedUsdcAdmin + UsdcChannelToken circuits...');
  const t0 = Date.now();
  await PermissionlessRateLimitedUsdcAdmin.compile();
  await UsdcChannelToken.compile();
  console.log(`Compilation complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const token = new UsdcChannelToken(PublicKey.fromBase58(args.token));
  const usdcTokenIdB58 = TokenId.toBase58(token.deriveTokenId());

  // Fee payer must exist + be funded.
  const feePayerAccount = await fetchAccount({ publicKey: feePayerPub }, args.network);
  if (feePayerAccount.account === undefined) {
    throw new Error(`fee payer account not found/funded: ${feePayerPub.toBase58()}`);
  }

  // Auto-detect first mint by probing the recipient's USDC token account.
  let firstMint = args.firstMint;
  if (firstMint === undefined) {
    const recipientTokenAccount = await fetchAccount(
      { publicKey: recipientPub, tokenId: token.deriveTokenId() },
      args.network
    );
    firstMint = recipientTokenAccount.account === undefined;
  }
  const fundNewAccounts = firstMint ? 2 : 0;

  console.log(
    `Minting ${args.amount} USDC to ${recipientPub.toBase58()} ` +
      `(fee payer ${feePayerPub.toBase58()} signs; recipient does NOT sign; ` +
      `firstMint=${firstMint}, funds ${fundNewAccounts} new accounts)...`
  );
  const tx = await buildMintTx({
    token,
    feePayer: feePayerPub,
    recipient: recipientPub,
    wholeUsdc: args.amount,
    signers: [feePayer], // fee payer ONLY
    fundNewAccounts,
  });
  const pending = await tx.send();
  console.log(`Sent: ${pending.hash} — waiting for inclusion...`);
  await pending.wait({ maxAttempts: 90, interval: 20_000 });

  const balance = await gqlBalance(args.network, recipientPub.toBase58(), usdcTokenIdB58);
  console.log(`Included. Recipient USDC balance: ${balance} base units`);

  if (args.out) {
    const outPath = path.resolve(args.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(
      outPath,
      JSON.stringify(
        {
          network: args.network,
          tokenAddress: args.token,
          adminContractAddress: args.adminContract,
          recipient: recipientPub.toBase58(),
          amountUsdc: args.amount.toString(),
          txHash: pending.hash,
          recipientBalanceBaseUnits: balance,
        },
        null,
        2
      ) + '\n'
    );
    console.log(`Evidence persisted → ${outPath}`);
  }
}

void main().catch((err: unknown) => {
  console.error('mint-usdc failed:', err);
  process.exit(1);
});
