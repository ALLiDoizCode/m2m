/**
 * #222 AC2 CI acceptance probe — REMOTE public TLS connector edge
 *
 * Runs the SHARED `PaidRoundTripClient` (the same code path the local #221 e2e
 * exercises) against the PUBLIC box, not localhost: a full paid ILP round-trip
 * with on-chain EVM settlement, plus negative assertions. Prints clear PASS/FAIL
 * lines and exits non-zero on any failure so the GitHub Actions job fails.
 *
 * Invocation (matches the repo's `tools/mina/*.ts` ts-node convention; an npm
 * alias is also provided — see `packages/connector/package.json`
 * "probe:connector-public"):
 *
 *   # From the connector workspace (ts-node + its tsconfig resolve test/src deps):
 *   DOMAIN=example.com \
 *     npx ts-node --project packages/connector/tsconfig.json \
 *     scripts/app/ci-acceptance-probe.ts
 *
 *   # Or via the npm alias (run from repo root):
 *   DOMAIN=example.com npm run probe:connector-public --workspace=packages/connector
 *
 * Env:
 *   DOMAIN                (required unless every explicit URL below is supplied)
 *   CONNECTOR_ILP_URL     default https://connector.${DOMAIN}/ilp
 *   EVM_RPC_URL           default https://evm-rpc.${DOMAIN}
 *   FAUCET_URL            default https://faucet.${DOMAIN}
 *   RELAY_WS_URL          default wss://relay-ws.${DOMAIN}
 *   RELAY_STORE_PROBE_URL default https://relay-store.${DOMAIN}/write
 *                         (asserted UNREACHABLE — there is no public 3100 proxy)
 *
 * @module ci-acceptance-probe
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
  relayWsUrl: string;
  relayStoreProbeUrl: string;
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
    relayWsUrl: need(process.env.RELAY_WS_URL, (d) => `wss://relay-ws.${d}`, 'RELAY_WS_URL'),
    relayStoreProbeUrl: need(
      process.env.RELAY_STORE_PROBE_URL,
      (d) => `https://relay-store.${d}/write`,
      'RELAY_STORE_PROBE_URL'
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
  console.log('[#222 acceptance probe] targeting REMOTE connector edge:');
  console.log(`  connector /ilp  : ${cfg.connectorIlpUrl}`);
  console.log(`  evm rpc         : ${cfg.evmRpcUrl}`);
  console.log(`  faucet          : ${cfg.faucetUrl}`);
  console.log(`  relay free-read : ${cfg.relayWsUrl}`);
  console.log(`  store probe (—) : ${cfg.relayStoreProbeUrl} (asserted unreachable)`);

  const client = new PaidRoundTripClient({
    connectorIlpUrl: cfg.connectorIlpUrl,
    evmRpcUrl: cfg.evmRpcUrl,
    faucetUrl: cfg.faucetUrl,
    relayWsUrl: cfg.relayWsUrl,
  });

  let allOk = true;
  try {
    await client.start();
    const roundTrip = await client.runPaidRoundTrip();
    allOk = printSteps('paid round-trip', roundTrip) && allOk;

    const negatives = await client.runNegatives(cfg.relayStoreProbeUrl);
    allOk = printSteps('negative assertions', negatives) && allOk;
  } finally {
    await client.stop();
  }

  console.log(`\n[#222 acceptance probe] OVERALL: ${allOk ? 'PASS' : 'FAIL'}`);
  if (!allOk) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('[#222 acceptance probe] FATAL:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
