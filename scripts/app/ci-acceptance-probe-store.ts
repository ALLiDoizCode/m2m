/**
 * Store-deploy CI acceptance probe — connector payment proxy in FRONT of the
 * Arweave DVM store (RouteTermination, route `g.connector.store`).
 *
 * Runs the SHARED `PaidRoundTripClient` against a connector edge (local OR
 * public TLS): a full paid ILP round-trip with on-chain EVM settlement carrying
 * a signed kind:5094 blob-storage job, asserting the FULFILL body reports the
 * Arweave `txId`, plus negative assertions. Prints PASS/FAIL lines and exits
 * non-zero on any failure.
 *
 * Invocation (mirror of ci-acceptance-probe.ts):
 *
 *   # Local store deploy (connector + store on 127.0.0.1):
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *   CONNECTOR_ILP_URL=http://localhost:3000/ilp \
 *   EVM_RPC_URL=https://evm-rpc.devnet.toonprotocol.dev \
 *   FAUCET_URL=https://faucet.devnet.toonprotocol.dev \
 *   STORE_PROBE_URL=http://localhost:3300/store \
 *     npx ts-node --project packages/connector/tsconfig.json \
 *     scripts/app/ci-acceptance-probe-store.ts
 *
 *   # Public edge: set DOMAIN to derive the https://…${DOMAIN} URLs.
 *
 * Env:
 *   DOMAIN            (required unless every explicit URL below is supplied)
 *   CONNECTOR_ILP_URL default https://connector.${DOMAIN}/ilp
 *   EVM_RPC_URL       default https://evm-rpc.${DOMAIN}
 *   FAUCET_URL        default https://faucet.${DOMAIN}
 *   STORE_PROBE_URL   default https://store.${DOMAIN}/store
 *                     (asserted UNREACHABLE — there is no public 3300 proxy)
 *
 * @module ci-acceptance-probe-store
 */

/* eslint-disable no-console */

import {
  PaidRoundTripClient,
  type ProbeStep,
} from '../../packages/connector/test/integration/paid-roundtrip-client';

interface ResolvedConfig {
  connectorIlpUrl: string;
  evmRpcUrl: string;
  faucetUrl: string;
  storeProbeUrl: string;
}

function resolveConfig(): ResolvedConfig {
  const domain = process.env.DOMAIN;
  const need = (
    explicit: string | undefined,
    derive: (d: string) => string,
    label: string
  ): string => {
    if (explicit) return explicit;
    if (!domain) {
      throw new Error(
        `Missing ${label}: set DOMAIN (to derive https://…\${DOMAIN}) or supply it explicitly via env.`
      );
    }
    return derive(domain);
  };

  return {
    connectorIlpUrl: need(
      process.env.CONNECTOR_ILP_URL,
      (d) => `https://connector.${d}/ilp`,
      'CONNECTOR_ILP_URL'
    ),
    evmRpcUrl: need(process.env.EVM_RPC_URL, (d) => `https://evm-rpc.${d}`, 'EVM_RPC_URL'),
    faucetUrl: need(process.env.FAUCET_URL, (d) => `https://faucet.${d}`, 'FAUCET_URL'),
    storeProbeUrl: need(
      process.env.STORE_PROBE_URL,
      (d) => `https://store.${d}/store`,
      'STORE_PROBE_URL'
    ),
  };
}

function printSteps(title: string, steps: ProbeStep[]): boolean {
  console.log(`\n=== ${title} ===`);
  let allOk = true;
  for (const step of steps) {
    const tag = step.ok ? 'PASS' : 'FAIL';
    const detail = step.detail ? ` — ${step.detail}` : '';
    console.log(`[${tag}] ${step.name}${detail}`);
    if (!step.ok) allOk = false;
  }
  return allOk;
}

async function main(): Promise<void> {
  const cfg = resolveConfig();
  console.log('[store acceptance probe] targeting connector edge:');
  console.log(`  connector /ilp  : ${cfg.connectorIlpUrl}`);
  console.log(`  evm rpc         : ${cfg.evmRpcUrl}`);
  console.log(`  faucet          : ${cfg.faucetUrl}`);
  console.log(`  store probe (—) : ${cfg.storeProbeUrl} (asserted unreachable)`);

  // relayWsUrl is intentionally omitted — the store round-trip verifies via the
  // FULFILL body, not a relay WS read.
  const client = new PaidRoundTripClient({
    connectorIlpUrl: cfg.connectorIlpUrl,
    evmRpcUrl: cfg.evmRpcUrl,
    faucetUrl: cfg.faucetUrl,
  });

  let allOk = true;
  try {
    await client.start();
    const roundTrip = await client.runPaidStoreRoundTrip();
    allOk = printSteps('paid store round-trip', roundTrip) && allOk;

    const negatives = await client.runStoreNegatives(cfg.storeProbeUrl);
    allOk = printSteps('negative assertions', negatives) && allOk;
  } finally {
    await client.stop();
  }

  console.log(`\n[store acceptance probe] OVERALL: ${allOk ? 'PASS' : 'FAIL'}`);
  if (!allOk) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('[store acceptance probe] FATAL:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
