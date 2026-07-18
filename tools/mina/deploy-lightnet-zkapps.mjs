// ───────────────────────────────────────────────────────────────────────────
// Deploy BOTH Mina zkApps (USDC FungibleToken + PaymentChannel) to a Mina
// LIGHTNET in ONE pure-ESM process (single o1js instance — required: o1js is a
// dual package and the FungibleToken provers/circuit cache are per-instance
// static state; a CJS/ESM split breaks proving). Mirrors the deploy sequences in
// tools/mina/deploy-usdc-token.mts + tools/mina/deploy-zkapp.ts, but imports the
// COMPILED ESM token+channel classes from packages/mina-zkapp/dist-esm/ (built by
// `node packages/mina-zkapp/scripts/build-esm.mjs`) so o1js stays single-instance.
//
// Used by infra/linode-node/provision-mina-lightnet.sh during `/deploy-devnet up`:
// the lightnet RESETS on every box recreate, so the zkApps must be (re)deployed
// each provisioning. Funding comes from the o1labs accounts-manager
// (GET /acquire-account returns a fresh funded genesis keypair) — NO manual
// faucet top-up. Requires glibc (o1js proving) — runs in node:22-bookworm, NOT
// node:22-alpine (musl).
//
// Env:
//   MINA_GRAPHQL_URL            lightnet graphql (e.g. https://mina.devnet.../graphql)
//   MINA_DEPLOYER_KEY           funded fee payer for the USDC deploy (base58 priv)
//   MINA_USDC_ADMIN_KEY         funded USDC mint authority (base58 priv)
//   MINA_CHANNEL_DEPLOYER_KEY   funded fee payer for the channel deploy (defaults to deployer)
//   MINA_TX_FEE                 whole-MINA zkapp tx fee (default 0.2)
//   OUT                         json output path (addresses + tokenId + keys)
//
// Output JSON shape (consumed by provision-mina-lightnet.sh):
//   { usdc: { tokenAddress, tokenId, adminContractAddress, adminAuthority, decimals },
//     paymentChannel: { zkAppAddress, vkHash },
//     sensitive: { tokenKey, adminContractKey, channelZkAppKey } }
import { AccountUpdate, Bool, Mina, PrivateKey, UInt8, UInt64 } from 'o1js';
import {
  FungibleTokenAdmin,
  usdcDeployProps,
} from '../../packages/mina-zkapp/dist-esm/usdc-token.js';
import { UsdcChannelToken } from '../../packages/mina-zkapp/dist-esm/usdc-channel-token.js';
import { PaymentChannel } from '../../packages/mina-zkapp/dist-esm/PaymentChannel.js';
import { writeFileSync } from 'node:fs';

const GQL = process.env.MINA_GRAPHQL_URL;
const OUT = process.env.OUT || 'lightnet-zkapps.json';
const USDC_DECIMALS_U8 = UInt8.from(6);

function wholeToNano(w) {
  const [a, b = ''] = String(w).split('.');
  return BigInt(a || '0') * 1_000_000_000n + BigInt((b + '000000000').slice(0, 9) || '0');
}
const FEE = UInt64.from(wholeToNano(process.env.MINA_TX_FEE || '0.2'));

async function waitInclusion(pending, label) {
  console.log(`  [${label}] tx sent: ${pending.hash}; waiting for inclusion...`);
  try {
    await pending.wait({ maxAttempts: 90, interval: 5000 });
    console.log(`  [${label}] INCLUDED`);
  } catch (e) {
    console.log(`  [${label}] wait() error (may still land): ${e.message}`);
  }
}

async function main() {
  if (!GQL) throw new Error('MINA_GRAPHQL_URL required');
  Mina.setActiveInstance(Mina.Network({ mina: GQL }));

  const deployer = PrivateKey.fromBase58(process.env.MINA_DEPLOYER_KEY);
  const adminAuthority = PrivateKey.fromBase58(process.env.MINA_USDC_ADMIN_KEY);
  const channelDeployer = PrivateKey.fromBase58(
    process.env.MINA_CHANNEL_DEPLOYER_KEY || process.env.MINA_DEPLOYER_KEY
  );
  const deployerPub = deployer.toPublicKey();

  console.log('=== Compiling circuits (single o1js instance) ===');
  let t0 = Date.now();
  await FungibleTokenAdmin.compile();
  await UsdcChannelToken.compile();
  const { verificationKey: pcVk } = await PaymentChannel.compile();
  console.log(`Compiled in ${((Date.now() - t0) / 1000).toFixed(1)}s; PaymentChannel vk ${pcVk.hash.toString()}`);

  // ── USDC token (admin + token + initialize, 6dp) ───────────────────────────
  const adminContractKey = PrivateKey.random();
  const tokenKey = PrivateKey.random();
  const admin = new FungibleTokenAdmin(adminContractKey.toPublicKey());
  const token = new UsdcChannelToken(tokenKey.toPublicKey());

  console.log('\n=== Deploying USDC token ===');
  const usdcTx = await Mina.transaction({ sender: deployerPub, fee: FEE }, async () => {
    AccountUpdate.fundNewAccount(deployerPub, 3);
    await admin.deploy({ adminPublicKey: adminAuthority.toPublicKey() });
    await token.deploy(usdcDeployProps);
    await token.initialize(adminContractKey.toPublicKey(), USDC_DECIMALS_U8, Bool(false));
  });
  await usdcTx.prove();
  await usdcTx.sign([deployer, adminContractKey, tokenKey]).send().then((p) => waitInclusion(p, 'usdc'));
  const tokenId = token.deriveTokenId().toString();
  console.log(`  USDC token ${tokenKey.toPublicKey().toBase58()} tokenId ${tokenId}`);

  // ── PaymentChannel (bare template) ─────────────────────────────────────────
  console.log('\n=== Deploying PaymentChannel ===');
  const channelDeployerPub = channelDeployer.toPublicKey();
  const zkAppKey = PrivateKey.random();
  const zkApp = new PaymentChannel(zkAppKey.toPublicKey());
  const pcTx = await Mina.transaction({ sender: channelDeployerPub, fee: FEE }, async () => {
    AccountUpdate.fundNewAccount(channelDeployerPub);
    await zkApp.deploy();
  });
  await pcTx.prove();
  await pcTx.sign([channelDeployer, zkAppKey]).send().then((p) => waitInclusion(p, 'channel'));

  const result = {
    network: GQL,
    usdc: {
      tokenAddress: tokenKey.toPublicKey().toBase58(),
      tokenId,
      adminContractAddress: adminContractKey.toPublicKey().toBase58(),
      adminAuthority: adminAuthority.toPublicKey().toBase58(),
      decimals: 6,
    },
    paymentChannel: { zkAppAddress: zkAppKey.toPublicKey().toBase58(), vkHash: pcVk.hash.toString() },
    sensitive: {
      tokenKey: tokenKey.toBase58(),
      adminContractKey: adminContractKey.toBase58(),
      channelZkAppKey: zkAppKey.toBase58(),
    },
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
  console.log('\n=== DEPLOY COMPLETE ===');
  console.log(JSON.stringify({ ...result, sensitive: '[written to OUT]' }, null, 2));
}

main().catch((e) => {
  console.error('DEPLOY FAILED:', e);
  process.exit(1);
});
