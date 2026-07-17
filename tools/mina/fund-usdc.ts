/**
 * Admin-mint USDC to a recipient on a Mina network (the Mina funding path).
 *
 * Analogous to `infra/solana/fund-solana.sh` (SPL transfer from a treasury), but
 * Mina has no token CLI — minting requires o1js, so this is the funding core.
 * `infra/mina/fund-mina-usdc.sh` is a thin wrapper that calls into this.
 *
 * The `FungibleTokenAdmin` gates `mint`; the admin AUTHORITY key
 * (`MINA_USDC_ADMIN_KEY`) must sign and must be a FUNDED account (it pays the
 * recipient's token-account creation fee on first mint — the #190 gotcha).
 *
 * Unlike the EVM faucet / Solana treasury (which transfer from a pre-funded
 * balance), here we MINT directly — simplest funding primitive for a devnet mock.
 *
 * ── Live mint ────────────────────────────────────────────────────────────────
 *   export MINA_USDC_ADMIN_KEY=<base58 admin authority private key, FUNDED>
 *   npx ts-node tools/mina/fund-usdc.ts \
 *     --network https://api.minascan.io/node/devnet/v1/graphql \
 *     --token <tokenAddress base58> \
 *     --admin-contract <adminContractAddress base58> \
 *     --recipient <recipient base58> \
 *     --amount 1000          # whole USDC (default 1000)
 *
 * ── Local smoke test ─────────────────────────────────────────────────────────
 *   Authoritative smoke test (shares one o1js via the jest CJS transform):
 *     npx jest --config tools/mina/jest.config.js
 *   The `--local` flag runs the same mint flow standalone, but only works when
 *   o1js is a single module instance (bundled); under bare ts-node the ESM/CJS
 *   split breaks it (see deploy-usdc-token.ts header). Prefer the jest suite.
 *     npx ts-node tools/mina/fund-usdc.ts --local
 *
 * Epic: USDC settlement across all chains (connector#188), ticket #193.
 *
 * @module fund-usdc
 */

/* eslint-disable no-console */

import { AccountUpdate, Bool, Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';

import {
  FungibleToken,
  FungibleTokenAdmin,
  ONE_USDC,
  USDC_DECIMALS_U8,
  usdcDeployProps,
} from '../../packages/mina-zkapp/src/usdc-token';
// The deployed USDC owner is `UsdcChannelToken` (Phase A). Its on-chain
// verification key is the SUBCLASS's, so we must instantiate/compile that exact
// class for mint proofs to be accepted on-chain. `mint` itself is inherited
// unchanged from `FungibleToken`.
import { UsdcChannelToken } from '../../packages/mina-zkapp/src/usdc-channel-token';

const DEFAULT_NETWORK = 'https://api.minascan.io/node/devnet/v1/graphql';
const DEFAULT_AMOUNT_USDC = 1000n;

/**
 * Fee (in nanomina) for the mint zkApp command. A zkApp command on the public
 * Mina devnet is rejected with "Insufficient fee" at the default (~0.001 MINA)
 * fee floor that `Mina.transaction` would otherwise pick — proof commands cost
 * more than plain payments. 0.1 MINA is the well-worn devnet zkApp fee and is
 * what the manual mint used. Override with MINA_TX_FEE (whole MINA) if the
 * mempool fee floor rises. 1 MINA = 1e9 nanomina.
 */
const MINT_FEE_NANOMINA = (() => {
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
  const admin = new FungibleTokenAdmin(adminContractKey.toPublicKey());
  const token = new UsdcChannelToken(tokenKey.toPublicKey());

  const deployTx = await Mina.transaction(deployer, async () => {
    AccountUpdate.fundNewAccount(deployer, 3);
    await admin.deploy({ adminPublicKey: adminAuthority });
    await token.deploy(usdcDeployProps);
    await token.initialize(adminContractKey.toPublicKey(), USDC_DECIMALS_U8, Bool(false));
  });
  await deployTx.prove();
  await deployTx.sign([deployer.key, adminContractKey, tokenKey]).send();

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

if (require.main === module) {
  void main().catch((err: unknown) => {
    console.error('USDC mint failed:', err);
    process.exit(1);
  });
}
