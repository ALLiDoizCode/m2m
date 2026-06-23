/**
 * Local connector + relay, paid HTTP round-trip, settling on the LIVE Linode
 * EVM devnet, with a CLIENT identity derived from a freshly generated BIP-39
 * seed (DEVNET_CLIENT_KEY/ADDR) and the CONNECTOR settling under a seed-derived
 * key too (DEVNET_CONNECTOR_ADDR). Reads the stored event back over the relay
 * free-read WS.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *   DEVNET_CONNECTOR_ADDR=0x... DEVNET_CLIENT_KEY=0x... DEVNET_CLIENT_ADDR=0x... \
 *   CONNECTOR_ILP_URL=http://127.0.0.1:3000/ilp \
 *   EVM_RPC_URL=https://evm-rpc.devnet.toonprotocol.dev \
 *   FAUCET_URL=https://faucet.devnet.toonprotocol.dev \
 *   RELAY_WS_URL=ws://127.0.0.1:7100 \
 *   npx ts-node --project packages/connector/tsconfig.json scripts/devnet-roundtrip/devnet-run.ts
 */
/* eslint-disable no-console */
import {
  PaidRoundTripClient,
  type ProbeStep,
  CONNECTOR_EVM_ADDRESS,
  CLIENT_EVM_ADDRESS,
} from '../../packages/connector/test/integration/paid-roundtrip-client';

function printSteps(title: string, steps: ProbeStep[]): boolean {
  console.log(`\n=== ${title} ===`);
  let allOk = true;
  for (const s of steps) {
    console.log(`[${s.ok ? 'PASS' : 'FAIL'}] ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
    if (!s.ok) allOk = false;
  }
  return allOk;
}

async function main(): Promise<void> {
  const connectorIlpUrl = process.env.CONNECTOR_ILP_URL ?? 'http://127.0.0.1:3000/ilp';
  const evmRpcUrl = process.env.EVM_RPC_URL ?? 'https://evm-rpc.devnet.toonprotocol.dev';
  const faucetUrl = process.env.FAUCET_URL ?? 'https://faucet.devnet.toonprotocol.dev';
  const relayWsUrl = process.env.RELAY_WS_URL ?? 'ws://127.0.0.1:7100';

  console.log('[devnet e2e] local connector + relay, settling on LIVE Linode EVM devnet');
  console.log(`  connector /ilp : ${connectorIlpUrl}`);
  console.log(`  evm rpc         : ${evmRpcUrl}`);
  console.log(`  faucet          : ${faucetUrl}`);
  console.log(`  relay free-read : ${relayWsUrl}`);
  console.log(`  connector addr : ${CONNECTOR_EVM_ADDRESS} (seed-derived)`);
  console.log(`  client addr     : ${CLIENT_EVM_ADDRESS} (seed-derived)`);

  const client = new PaidRoundTripClient({
    connectorIlpUrl,
    evmRpcUrl,
    faucetUrl,
    relayWsUrl,
    logLevel: (process.env.CLIENT_LOG_LEVEL as 'info') ?? 'warn',
  });

  let allOk = true;
  try {
    console.log(
      '\n[devnet e2e] starting embedded payer node (opens on-chain channel toward connector)…'
    );
    await client.start();
    console.log(`[devnet e2e] channel open; tokenId=${client.settlementTokenId}`);
    const roundTrip = await client.runPaidRoundTrip();
    allOk = printSteps('paid round-trip (EVM)', roundTrip) && allOk;
    const negatives = await client.runNegatives();
    allOk = printSteps('negative assertions', negatives) && allOk;
  } finally {
    await client.stop();
  }

  console.log(`\n[devnet e2e] OVERALL: ${allOk ? 'PASS' : 'FAIL'}`);
  if (!allOk) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('[devnet e2e] FATAL:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
