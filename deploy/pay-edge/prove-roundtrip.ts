/**
 * pay-edge generic-backend proof
 * ==============================================================================
 * Drives a full PAID ILP round-trip through the pay-edge connector to the
 * GENERIC echo backend, and asserts the app's HTTP response comes back in the
 * ILP FULFILL — proving the backend is payment-oblivious. Then asserts an UNPAID
 * request is REJECTED (the app never sees it).
 *
 * It reuses the repo's battle-tested `PaidRoundTripClient` ONLY for wallet
 * funding + on-chain channel open (chain-agnostic), then signs a per-packet claim
 * and POSTs a GENERIC `POST /echo` HTTP envelope addressed to `g.connector.echo.*`.
 * Unlike the relay probe, success is proven by the FULFILL body itself (the echo),
 * so there is no app-specific read-back.
 *
 * Run (from the connector repo root):
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *   CONNECTOR_ILP_URL=http://127.0.0.1:3000/ilp \
 *   EVM_RPC_URL=https://evm-rpc.devnet.toonprotocol.dev \
 *   FAUCET_URL=https://faucet.devnet.toonprotocol.dev \
 *   npx ts-node --project packages/connector/tsconfig.json deploy/pay-edge/prove-roundtrip.ts
 *
 * If public DNS for devnet.toonprotocol.dev lags the live box, pin it for the
 * Node process by preloading dns-pin.js:
 *   ... ts-node --require ./deploy/pay-edge/dns-pin.js ...   (set DEVNET_IP)
 *
 * For a LOCAL proof against the repo's anvil+faucet, point EVM_RPC_URL /
 * FAUCET_URL at http://127.0.0.1:8545 and http://127.0.0.1:3500.
 */
/* eslint-disable no-console */
import Database from 'libsql';
import {
  PaidRoundTripClient,
  buildHttpEnvelope,
  CONNECTOR_PEER_ID,
} from '../../packages/connector/test/integration/paid-roundtrip-client';
import { PerPacketClaimService } from '../../packages/connector/src/settlement/per-packet-claim-service';
import {
  SENT_CLAIMS_TABLE_SCHEMA,
  SENT_CLAIMS_INDEXES,
} from '../../packages/connector/src/settlement/claim-sender-db-schema';
import { createLogger } from '../../packages/connector/src/utils/logger';
import {
  serializePacket,
  deserializePacket,
  PacketType,
  type ILPPreparePacket,
} from '@toon-protocol/shared';
import http from 'http';
import https from 'https';
import { URL } from 'url';

const ANVIL_CHAIN_ID = 31337;
const SETTLEMENT_CHAIN = `evm:${ANVIL_CHAIN_ID}`;
/** Must be covered by the connector.yaml route prefix `g.connector.echo`. */
const ECHO_DESTINATION = 'g.connector.echo.test';

interface RawResp {
  status: number;
  body: Buffer;
}
function postRaw(url: string, body: Buffer, headers: Record<string, string>): Promise<RawResp> {
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': body.length,
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Pull the inner HTTP response body out of a FULFILL `data` envelope. */
function fulfillBodyText(fulfillData: Buffer): string {
  const env = deserializePacket(fulfillData);
  // FULFILL.data is the serialized upstream HTTP response (status line + headers
  // + CRLFCRLF + body). Return the part after the header delimiter.
  const data = (env as { data: Buffer }).data;
  const idx = data.indexOf(Buffer.from('\r\n\r\n'));
  return idx === -1 ? data.toString('utf8') : data.subarray(idx + 4).toString('utf8');
}

async function main(): Promise<void> {
  const connectorIlpUrl = process.env.CONNECTOR_ILP_URL ?? 'http://127.0.0.1:3000/ilp';
  const evmRpcUrl = process.env.EVM_RPC_URL ?? 'https://evm-rpc.devnet.toonprotocol.dev';
  const faucetUrl = process.env.FAUCET_URL ?? 'https://faucet.devnet.toonprotocol.dev';

  console.log('[pay-edge proof] GENERIC backend paid round-trip');
  console.log(`  connector /ilp : ${connectorIlpUrl}`);
  console.log(`  evm rpc         : ${evmRpcUrl}`);
  console.log(`  faucet          : ${faucetUrl}`);
  console.log(`  destination     : ${ECHO_DESTINATION}\n`);

  // Reuse the proven client purely for funding + on-chain channel open. The
  // relayWsUrl is unused by us (no read-back) but required by the ctor.
  const client = new PaidRoundTripClient({
    connectorIlpUrl,
    evmRpcUrl,
    faucetUrl,
    relayWsUrl: 'ws://127.0.0.1:1', // unused: success is proven by the FULFILL body
    logLevel: (process.env.CLIENT_LOG_LEVEL as 'warn') ?? 'warn',
  });

  let ok = true;
  try {
    console.log('[pay-edge proof] funding wallet + opening on-chain channel toward connector…');
    await client.start();
    const node = (
      client as unknown as { node: { channelManager: unknown; chainRegistry: unknown } }
    ).node;
    const tokenId = client.settlementTokenId!;
    console.log(`[pay-edge proof] channel open; tokenId=${tokenId}\n`);

    // Build a claim signer over the embedded node's REAL channel context (same
    // construction the client does internally; node getters are public).
    const claimDb = new Database(':memory:') as unknown as import('better-sqlite3').Database;
    claimDb.exec(SENT_CLAIMS_TABLE_SCHEMA);
    for (const idx of SENT_CLAIMS_INDEXES) claimDb.exec(idx);
    const claimSvc = new PerPacketClaimService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node as any).chainRegistry,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node as any).channelManager,
      claimDb,
      createLogger('pay-edge-proof-claim', 'warn'),
      'paid-roundtrip-client',
      new Map([[CONNECTOR_PEER_ID, SETTLEMENT_CHAIN]])
    );

    // ── PAID round-trip ──────────────────────────────────────────────────────
    const claim = await claimSvc.generateClaimForPacket(CONNECTOR_PEER_ID, tokenId, 1000n);
    if (!claim) throw new Error('generateClaimForPacket returned null (no channel?)');

    const marker = `pay-edge-${Date.now()}`;
    const envelope = buildHttpEnvelope(
      'POST',
      '/echo',
      [
        ['Host', 'app'],
        ['Content-Type', 'application/json'],
      ],
      JSON.stringify({ hello: marker })
    );
    const prepare: ILPPreparePacket = {
      type: PacketType.PREPARE,
      destination: ECHO_DESTINATION,
      amount: 1000n,
      expiresAt: new Date(Date.now() + 60_000),
      data: envelope,
    };
    const res = await postRaw(connectorIlpUrl, serializePacket(prepare), {
      'ilp-peer-id': CONNECTOR_PEER_ID,
      'ilp-payment-channel-claim': claim.protocolData.data.toString('base64'),
    });

    const isFulfill =
      res.status === 200 && res.body.length > 0 && res.body[0] === PacketType.FULFILL;
    console.log(
      `[${isFulfill ? 'PASS' : 'FAIL'}] paid POST /ilp round-trips to FULFILL — HTTP ${res.status}, ILP type ${res.body[0]}`
    );
    ok = ok && isFulfill;

    if (isFulfill) {
      const body = fulfillBodyText(res.body);
      const echoed = body.includes(marker);
      console.log(
        `[${echoed ? 'PASS' : 'FAIL'}] FULFILL carries the backend echo — marker ${echoed ? 'found' : 'MISSING'} (${marker})`
      );
      // Show the X-TOON-* headers the connector injected (proves payer/amount visibility).
      const injected = ['x-toon-payer', 'x-toon-amount', 'x-toon-chain'].filter((h) =>
        body.toLowerCase().includes(h)
      );
      console.log(`        backend saw injected headers: ${injected.join(', ') || '(none)'}`);
      console.log(`        echo (truncated): ${body.replace(/\s+/g, ' ').slice(0, 240)}…`);
      ok = ok && echoed;
    }

    // ── UNPAID negative ──────────────────────────────────────────────────────
    const unpaidEnv = buildHttpEnvelope(
      'POST',
      '/echo',
      [
        ['Host', 'app'],
        ['Content-Type', 'application/json'],
      ],
      JSON.stringify({ unpaid: true })
    );
    const unpaidPrepare: ILPPreparePacket = {
      type: PacketType.PREPARE,
      destination: ECHO_DESTINATION,
      amount: 1000n,
      expiresAt: new Date(Date.now() + 60_000),
      data: unpaidEnv,
    };
    const unpaid = await postRaw(connectorIlpUrl, serializePacket(unpaidPrepare), {}); // no claim
    const rejected =
      unpaid.status === 200
        ? unpaid.body.length > 0 && unpaid.body[0] !== PacketType.FULFILL
        : unpaid.status >= 400;
    console.log(
      `[${rejected ? 'PASS' : 'FAIL'}] UNPAID POST /ilp is REJECTED (not FULFILLED) — HTTP ${unpaid.status}, ILP type ${unpaid.body[0]} (REJECT=${PacketType.REJECT})`
    );
    ok = ok && rejected;
  } finally {
    await client.stop();
  }

  console.log(`\n[pay-edge proof] OVERALL: ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('[pay-edge proof] FATAL:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
