/**
 * Mina zkApp Devnet Deployment Script
 *
 * Compiles and deploys the PaymentChannel zkApp to a Mina network.
 * Outputs the deployed zkApp address and verification key hash.
 *
 * Usage:
 *   npx ts-node tools/mina/deploy-zkapp.ts \
 *     --network https://api.minascan.io/node/devnet/v1/graphql \
 *     --deployer-key <base58-private-key>
 *
 * The deployer key can also be provided via the MINA_DEPLOYER_KEY environment
 * variable to avoid exposing it in process arguments (visible via `ps`).
 *
 * Prerequisites:
 *   - npm run build --workspace=packages/mina-zkapp
 *   - Funded deployer account on the target network
 *
 * Story 34.3 -- Epic 34: Mina Protocol Payment Channel Provider
 *
 * @module deploy-zkapp
 */

/* eslint-disable no-console */

import { Mina, PrivateKey, AccountUpdate } from 'o1js';
import { PaymentChannel } from '../../packages/mina-zkapp/dist/PaymentChannel';

interface DeployArgs {
  network: string;
  deployerKey: string;
}

function parseArgs(): DeployArgs {
  const args = process.argv.slice(2);
  let network = '';
  let deployerKey = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--network' && next) {
      network = next;
      i++;
    } else if (arg === '--deployer-key' && next) {
      deployerKey = next;
      i++;
    }
  }

  // Fall back to environment variable for deployer key (safer than CLI args)
  if (!deployerKey) {
    deployerKey = process.env['MINA_DEPLOYER_KEY'] ?? '';
  }

  if (!network) {
    console.error('Error: --network <graphql-url> is required');
    process.exit(1);
  }
  if (!network.startsWith('https://')) {
    console.error(
      'Error: --network must use HTTPS to protect transaction data in transit.\n' +
        '  Received: ' +
        network
    );
    process.exit(1);
  }
  if (!deployerKey) {
    console.error(
      'Error: --deployer-key <base58-private-key> is required\n' +
        '  Alternatively, set MINA_DEPLOYER_KEY environment variable'
    );
    process.exit(1);
  }

  return { network, deployerKey };
}

async function main(): Promise<void> {
  const { network, deployerKey } = parseArgs();

  console.log(`Connecting to Mina network: ${network}`);
  const Network = Mina.Network({ mina: network });
  Mina.setActiveInstance(Network);

  console.log('Compiling PaymentChannel zkApp circuit...');
  const compileStart = Date.now();
  const { verificationKey } = await PaymentChannel.compile();
  const compileTime = Date.now() - compileStart;
  console.log(`Compilation complete in ${(compileTime / 1000).toFixed(1)}s`);
  console.log(`Verification key hash: ${verificationKey.hash.toString()}`);

  // Generate zkApp keypair
  const zkAppKey = PrivateKey.random();
  const zkAppAddress = zkAppKey.toPublicKey();
  console.log(`zkApp address: ${zkAppAddress.toBase58()}`);

  // Deploy
  const deployer = PrivateKey.fromBase58(deployerKey);
  const deployerPublicKey = deployer.toPublicKey();
  console.log(`Deployer address: ${deployerPublicKey.toBase58()}`);

  console.log('Deploying zkApp...');
  const zkApp = new PaymentChannel(zkAppAddress);
  const tx = await Mina.transaction(deployerPublicKey, async () => {
    AccountUpdate.fundNewAccount(deployerPublicKey);
    await zkApp.deploy();
  });
  await tx.prove();
  tx.sign([deployer, zkAppKey]);
  const pendingTx = await tx.send();

  console.log(`Transaction sent: ${pendingTx.hash}`);
  console.log('Waiting for transaction inclusion...');
  await pendingTx.wait();

  console.log('\n=== Deployment Complete ===');
  console.log(`zkApp address:          ${zkAppAddress.toBase58()}`);
  console.log(`Verification key hash:  ${verificationKey.hash.toString()}`);
  console.log(`Network:                ${network}`);

  // Output the private key to stderr so it does not leak into piped stdout
  // or CI log artifacts. Operators should redirect stderr to a secure file.
  console.error(
    `\n[SENSITIVE] zkApp private key: ${zkAppKey.toBase58()}\nSave this key securely. It is needed for future upgrades.`
  );
}

void main().catch((err: unknown) => {
  console.error('Deployment failed:', err);
  process.exit(1);
});
