/**
 * Permissionless SELF-MINT of rate-limited USDC on a Mina network — and the
 * live rejection smoke for the per-address daily mint cap.
 *
 * The public-devnet USDC token is gated by `RateLimitedUsdcAdmin`
 * (packages/mina-zkapp/src/usdc-rate-limited-admin.ts): ANY address can mint
 * to itself up to DAILY_MINT_CAP_USDC per ~day (480 slots), enforced by the
 * canMint proof + per-address mint-receipt account preconditions the LEDGER
 * checks at inclusion. No admin key is involved; the RECIPIENT signs (its
 * mint-receipt AU requires the recipient's signature).
 *
 * ── Self-mint ────────────────────────────────────────────────────────────────
 *   export MINA_FEE_PAYER_KEY=<base58 private key, FUNDED on devnet>
 *   export MINA_RECIPIENT_KEY=<base58 private key of the mint recipient>
 *   npx tsx tools/mina/self-mint-usdc.mts \
 *     --network https://api.minascan.io/node/devnet/v1/graphql \
 *     --token <tokenAddress base58> \
 *     --admin-contract <adminContractAddress base58> \
 *     --amount 1000 \
 *     [--first-mint]        # fund the recipient's token + receipt accounts (2 MINA)
 *
 * ── Rejection smoke (`--smoke`) ──────────────────────────────────────────────
 * End-to-end ON-CHAIN demonstration of the rate limit, run against a FRESH
 * recipient key generated in-process:
 *   1. build tx1 = self-mint of the full daily cap (funds 2 new accounts), and
 *      tx2 = a second self-mint — BOTH proved against the recipient's pre-mint
 *      (all-zero) receipt state, tx2 at fee-payer nonce + 1;
 *   2. send tx1, wait for inclusion, dump the on-chain receipt via GraphQL;
 *   3. send tx2 (stale) and capture the network-level rejection — its receipt
 *      preconditions (state = zeros) no longer hold, so the ledger fails the
 *      command at inclusion (precondition unsatisfied); include the raw error;
 *   4. re-dump balance + receipt (must be unchanged by tx2);
 *   5. additionally try to BUILD a third mint against the CURRENT receipt —
 *      the canMint circuit itself must refuse (daily-cap assertion), which is
 *      the in-proof half of the enforcement.
 * Evidence is printed and (with --out) persisted as JSON.
 *
 * Pure-ESM `.mts` via `npx tsx`, importing packages/mina-zkapp/dist-esm/ — the
 * single-o1js-instance modality (#352). Build first:
 *   npm run build:esm --workspace=packages/mina-zkapp
 *
 * @module self-mint-usdc
 */

/* eslint-disable no-console */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { fetchAccount, Mina, PrivateKey, PublicKey, TokenId } from 'o1js';

// Pure-ESM build of the zkApp lib (see header — never import src/ or dist/).
import { UsdcChannelToken } from '../../packages/mina-zkapp/dist-esm/usdc-channel-token.js';
import {
  DAILY_MINT_CAP_USDC,
  RateLimitedUsdcAdmin,
  RECEIPT_STATE_SLOT,
} from '../../packages/mina-zkapp/dist-esm/usdc-rate-limited-admin.js';
import { buildSelfMintTx } from '../../packages/mina-zkapp/dist-esm/usdc-deploy.js';

const DEFAULT_NETWORK = 'https://api.minascan.io/node/devnet/v1/graphql';

interface CliArgs {
  network: string;
  token: string;
  adminContract: string;
  amount: bigint;
  firstMint: boolean;
  smoke: boolean;
  out: string | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  let network = DEFAULT_NETWORK;
  let token = '';
  let adminContract = '';
  let amount = DAILY_MINT_CAP_USDC;
  let firstMint = false;
  let smoke = false;
  let out: string | undefined;

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
    } else if (arg === '--amount' && next) {
      amount = BigInt(next);
      i++;
    } else if (arg === '--first-mint') {
      firstMint = true;
    } else if (arg === '--smoke') {
      smoke = true;
    } else if (arg === '--out' && next) {
      out = next;
      i++;
    }
  }

  if (!network.startsWith('https://')) {
    console.error('Error: --network must use HTTPS. Received: ' + network);
    process.exit(1);
  }
  if (!token || !adminContract) {
    console.error('Error: --token and --admin-contract are required.');
    process.exit(1);
  }
  return { network, token, adminContract, amount, firstMint, smoke, out };
}

function requireKey(envVar: string): PrivateKey {
  const raw = process.env[envVar];
  if (!raw) {
    console.error(`Error: ${envVar} (base58 private key) is required.`);
    process.exit(1);
  }
  return PrivateKey.fromBase58(raw);
}

/** Raw GraphQL account query — independent on-chain evidence for the smoke log. */
async function gqlAccount(
  endpoint: string,
  publicKey: string,
  tokenIdB58: string
): Promise<{ balance?: string; nonce?: string; zkappState?: string[] } | null> {
  const query = `query { account(publicKey: "${publicKey}", token: "${tokenIdB58}") {
    balance { total } nonce zkappState } }`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as {
    data?: { account?: { balance?: { total: string }; nonce?: string; zkappState?: string[] } };
  };
  const account = body.data?.account;
  if (!account) return null;
  return {
    balance: account.balance?.total,
    nonce: account.nonce ?? undefined,
    zkappState: account.zkappState ?? undefined,
  };
}

/** Decode a GraphQL zkappState array into the mint-receipt fields. */
function decodeReceipt(zkappState: string[] | undefined): {
  windowStart: string;
  mintedInWindow: string;
} {
  return {
    windowStart: zkappState?.[RECEIPT_STATE_SLOT.windowStart] ?? '0',
    mintedInWindow: zkappState?.[RECEIPT_STATE_SLOT.mintedInWindow] ?? '0',
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const feePayer = requireKey('MINA_FEE_PAYER_KEY');
  const feePayerPub = feePayer.toPublicKey();

  console.log(`Connecting to Mina network: ${args.network}`);
  Mina.setActiveInstance(Mina.Network({ mina: args.network }));

  console.log('Compiling RateLimitedUsdcAdmin + UsdcChannelToken circuits...');
  const t0 = Date.now();
  await RateLimitedUsdcAdmin.compile();
  await UsdcChannelToken.compile();
  console.log(`Compilation complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const token = new UsdcChannelToken(PublicKey.fromBase58(args.token));
  const adminTokenId = TokenId.derive(PublicKey.fromBase58(args.adminContract));
  const adminTokenIdB58 = TokenId.toBase58(adminTokenId);
  const usdcTokenIdB58 = TokenId.toBase58(token.deriveTokenId());

  // Fee payer nonce (also proves the account exists + is funded).
  const feePayerAccount = await fetchAccount({ publicKey: feePayerPub }, args.network);
  if (feePayerAccount.account === undefined) {
    throw new Error(`fee payer account not found/funded: ${feePayerPub.toBase58()}`);
  }
  const baseNonce = Number(feePayerAccount.account.nonce.toString());
  console.log(`Fee payer ${feePayerPub.toBase58()} nonce=${baseNonce}`);

  if (!args.smoke) {
    const recipient = requireKey('MINA_RECIPIENT_KEY');
    const recipientPub = recipient.toPublicKey();
    console.log(`Self-minting ${args.amount} USDC to ${recipientPub.toBase58()}...`);
    const tx = await buildSelfMintTx({
      token,
      feePayer: feePayerPub,
      recipient: recipientPub,
      wholeUsdc: args.amount,
      signers: [feePayer, recipient],
      fundNewAccounts: args.firstMint ? 2 : 0,
    });
    const pending = await tx.send();
    console.log(`Sent: ${pending.hash} — waiting for inclusion...`);
    await pending.wait({ maxAttempts: 90, interval: 20_000 });
    const balance = await gqlAccount(args.network, recipientPub.toBase58(), usdcTokenIdB58);
    console.log(`Included. Recipient USDC balance: ${balance?.balance ?? '0'} base units`);
    return;
  }

  // ── Rejection smoke ────────────────────────────────────────────────────────
  const recipient = PrivateKey.random();
  const recipientPub = recipient.toPublicKey();
  const evidence: Record<string, unknown> = {
    network: args.network,
    tokenAddress: args.token,
    adminContractAddress: args.adminContract,
    recipient: recipientPub.toBase58(),
    recipientKey: recipient.toBase58(), // throwaway, devnet-only
    dailyCapUsdc: DAILY_MINT_CAP_USDC.toString(),
  };
  console.log(`\n=== Rate-limit rejection smoke ===`);
  console.log(`Fresh recipient: ${recipientPub.toBase58()}`);

  // 1. Build BOTH txs against the recipient's pre-mint (all-zero) receipt.
  console.log(`Building tx1 (mint ${DAILY_MINT_CAP_USDC} USDC = full daily cap)...`);
  const tx1 = await buildSelfMintTx({
    token,
    feePayer: feePayerPub,
    recipient: recipientPub,
    wholeUsdc: DAILY_MINT_CAP_USDC,
    signers: [feePayer, recipient],
    fundNewAccounts: 2, // recipient token account + mint-receipt account
    nonce: baseNonce,
  });
  console.log('Building tx2 (second mint, proved against the SAME pre-mint receipt)...');
  const tx2 = await buildSelfMintTx({
    token,
    feePayer: feePayerPub,
    recipient: recipientPub,
    wholeUsdc: 100n,
    signers: [feePayer, recipient],
    fundNewAccounts: 0,
    nonce: baseNonce + 1,
  });

  // 2. First mint: must land and write the receipt.
  const pending1 = await tx1.send();
  evidence['tx1'] = { hash: pending1.hash, amountUsdc: DAILY_MINT_CAP_USDC.toString() };
  console.log(`tx1 sent: ${pending1.hash} — waiting for inclusion...`);
  await pending1.wait({ maxAttempts: 90, interval: 20_000 });
  const balanceAfter1 = await gqlAccount(args.network, recipientPub.toBase58(), usdcTokenIdB58);
  const receiptAfter1 = await gqlAccount(args.network, recipientPub.toBase58(), adminTokenIdB58);
  evidence['afterTx1'] = {
    usdcBalance: balanceAfter1?.balance ?? '0',
    receipt: decodeReceipt(receiptAfter1?.zkappState),
  };
  console.log(
    `tx1 INCLUDED. balance=${balanceAfter1?.balance} base units,` +
      ` receipt=${JSON.stringify(decodeReceipt(receiptAfter1?.zkappState))}`
  );

  // 3. Stale second mint: the ledger must reject it (receipt preconditions).
  console.log('\nSubmitting tx2 (stale receipt preconditions: state = zeros)...');
  let tx2Outcome: Record<string, unknown>;
  try {
    const pending2 = await tx2.send();
    console.log(`tx2 accepted into mempool: ${pending2.hash} — awaiting the FAILURE...`);
    try {
      await pending2.wait({ maxAttempts: 90, interval: 20_000 });
      tx2Outcome = { hash: pending2.hash, outcome: 'INCLUDED-APPLIED (UNEXPECTED!)' };
      console.error('!!! tx2 was applied — the rate limit DID NOT hold.');
      process.exitCode = 1;
    } catch (waitErr) {
      tx2Outcome = {
        hash: pending2.hash,
        outcome: 'rejected at inclusion',
        error: String(waitErr),
      };
      console.log(`tx2 REJECTED at inclusion:\n${String(waitErr)}`);
    }
  } catch (sendErr) {
    tx2Outcome = { outcome: 'rejected at submission', error: String(sendErr) };
    console.log(`tx2 REJECTED at submission:\n${String(sendErr)}`);
  }
  evidence['tx2'] = tx2Outcome;

  // 4. Balance + receipt unchanged by tx2.
  const balanceAfter2 = await gqlAccount(args.network, recipientPub.toBase58(), usdcTokenIdB58);
  const receiptAfter2 = await gqlAccount(args.network, recipientPub.toBase58(), adminTokenIdB58);
  evidence['afterTx2'] = {
    usdcBalance: balanceAfter2?.balance ?? '0',
    receipt: decodeReceipt(receiptAfter2?.zkappState),
  };
  console.log(
    `\nPost-tx2 balance=${balanceAfter2?.balance} base units (must equal post-tx1),` +
      ` receipt=${JSON.stringify(decodeReceipt(receiptAfter2?.zkappState))}`
  );

  // 5. In-proof half: building a fresh over-cap mint against CURRENT state
  //    must fail inside canMint (daily-cap assertion).
  console.log('\nBuilding tx3 against the CURRENT receipt (must fail in-circuit)...');
  try {
    await buildSelfMintTx({
      token,
      feePayer: feePayerPub,
      recipient: recipientPub,
      wholeUsdc: 100n,
      signers: [feePayer, recipient],
      fundNewAccounts: 0,
      nonce: baseNonce + 1,
    });
    evidence['tx3Build'] = { outcome: 'BUILT (UNEXPECTED!)' };
    console.error('!!! tx3 built — the in-proof cap check DID NOT fire.');
    process.exitCode = 1;
  } catch (buildErr) {
    evidence['tx3Build'] = { outcome: 'refused in-circuit', error: String(buildErr) };
    console.log(`tx3 build refused in-circuit:\n${String(buildErr)}`);
  }

  if (args.out) {
    const outPath = path.resolve(args.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(evidence, null, 2) + '\n');
    console.log(`\nSmoke evidence persisted → ${outPath}`);
  }
  console.log('\nRate-limit rejection smoke COMPLETE.');
}

void main().catch((err: unknown) => {
  console.error('self-mint-usdc failed:', err);
  process.exit(1);
});
