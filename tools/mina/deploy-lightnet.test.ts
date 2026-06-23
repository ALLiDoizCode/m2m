/* eslint-disable no-console */
/**
 * One-shot live deploy of USDC FungibleToken to the Mina lightnet at
 * https://mina.devnet.toonprotocol.dev/graphql
 *
 * Run via:
 *   MINA_DEPLOYER_KEY=<sk> MINA_USDC_ADMIN_KEY=<sk> \
 *   npx jest --config tools/mina/jest.config.js --testPathPattern=scratchpad/deploy-lightnet
 *
 * Set MINA_USDC_TOKEN_KEY and MINA_USDC_ADMIN_CONTRACT_KEY to pin addresses
 * across re-runs (optional).
 */

import { AccountUpdate, Bool, Mina, PrivateKey, fetchAccount } from 'o1js';
import {
  FungibleTokenAdmin,
  USDC_DECIMALS_U8,
  usdcDeployProps,
} from '../../packages/mina-zkapp/src/usdc-token';
import { UsdcChannelToken } from '../../packages/mina-zkapp/src/usdc-channel-token';

const LIGHTNET_URL = 'https://mina.devnet.toonprotocol.dev/graphql';

jest.setTimeout(300000); // 5 min — lightnet proof=none so prove() is instant

describe('Deploy USDC token to Mina lightnet', () => {
  it('deploys and prints addresses', async () => {
    const network = Mina.Network({ mina: LIGHTNET_URL, archive: LIGHTNET_URL });
    Mina.setActiveInstance(network);

    const deployerKey = PrivateKey.fromBase58(process.env.MINA_DEPLOYER_KEY!);
    const adminKey = PrivateKey.fromBase58(process.env.MINA_USDC_ADMIN_KEY!);
    const tokenKey = process.env.MINA_USDC_TOKEN_KEY
      ? PrivateKey.fromBase58(process.env.MINA_USDC_TOKEN_KEY)
      : PrivateKey.random();
    const adminContractKey = process.env.MINA_USDC_ADMIN_CONTRACT_KEY
      ? PrivateKey.fromBase58(process.env.MINA_USDC_ADMIN_CONTRACT_KEY)
      : PrivateKey.random();

    console.log('Deployer:      ', deployerKey.toPublicKey().toBase58());
    console.log('Admin auth:    ', adminKey.toPublicKey().toBase58());
    console.log('Token addr:    ', tokenKey.toPublicKey().toBase58());
    console.log('Admin contract:', adminContractKey.toPublicKey().toBase58());
    console.log('Network:       ', LIGHTNET_URL);

    // Compile zkApps to cache verification keys (required before deploy)
    console.log('Compiling FungibleTokenAdmin...');
    await FungibleTokenAdmin.compile();
    console.log('Compiling UsdcChannelToken...');
    await UsdcChannelToken.compile();
    console.log('Compilation done.');

    // Fetch deployer account to ensure it exists and is funded
    const { account } = await fetchAccount({ publicKey: deployerKey.toPublicKey() });
    console.log('Deployer balance:', account?.balance?.toString(), 'nanomina');
    expect(account).toBeTruthy();

    // Deploy directly (not via deployUsdcToken helper) to set an explicit fee.
    // Mina lightnet requires a non-zero fee even with PROOF_LEVEL=none.
    const admin = new FungibleTokenAdmin(adminContractKey.toPublicKey());
    const token = new UsdcChannelToken(tokenKey.toPublicKey());

    const tx = await Mina.transaction(
      { sender: deployerKey.toPublicKey(), fee: 1_000_000_000 }, // 1 MINA
      async () => {
        AccountUpdate.fundNewAccount(deployerKey.toPublicKey(), 3);
        await admin.deploy({ adminPublicKey: adminKey.toPublicKey() });
        await token.deploy(usdcDeployProps);
        await token.initialize(adminContractKey.toPublicKey(), USDC_DECIMALS_U8, Bool(false));
      }
    );
    await tx.prove();
    const pendingTx = await tx.sign([deployerKey, adminContractKey, tokenKey]).send();
    console.log('Transaction hash:', pendingTx.hash);
    await pendingTx.wait();
    console.log('Transaction confirmed.');

    const tokenAddress = tokenKey.toPublicKey().toBase58();
    const tokenId = token.deriveTokenId().toString();

    console.log('\n=== DEPLOY RESULT ===');
    console.log('tokenAddress:', tokenAddress);
    console.log('tokenId:     ', tokenId);
    console.log('adminContractAddress:', adminContractKey.toPublicKey().toBase58());
    console.log('adminAuthority:      ', adminKey.toPublicKey().toBase58());
    process.stderr.write(`TOKEN_SK=${tokenKey.toBase58()}\n`);
    process.stderr.write(`ADMIN_CONTRACT_SK=${adminContractKey.toBase58()}\n`);

    expect(tokenAddress).toMatch(/^B62/);
    expect(tokenId).toMatch(/^\d+$/);
  });
});
