/**
 * Paid round-trip client (issue #222, AC2 acceptance probe)
 *
 * A REUSABLE "payer" that drives a full paid ILP round-trip with on-chain EVM
 * settlement against a terminator edge — local OR remote (public TLS). It is the
 * shared code path exercised by:
 *
 *   - the local #221 e2e (`app-behind-terminator-e2e.test.ts`, AC3), pointed at
 *     127.0.0.1 compose ports, and
 *   - the #222 CI acceptance probe (`scripts/app-behind-terminator/ci-acceptance-probe.ts`),
 *     pointed at `https://terminator.${DOMAIN}/ilp` and friends on the public box.
 *
 * NOTHING here hardcodes localhost — every reachable endpoint is a constructor
 * parameter (`terminatorIlpUrl`, `evmRpcUrl`, `faucetUrl`, `relayWsUrl`).
 *
 * The client plays the PEER1 role from `ilp-http-settlement-e2e.test.ts`: it runs
 * a LOCAL `ConnectorNode` whose only EVM provider points at the (possibly remote)
 * anvil, auto-opens + funds an on-chain channel toward the terminator's
 * settlement address, then signs per-packet claims with a test-side
 * `PerPacketClaimService` over that node's real `channelManager` / `chainRegistry`
 * and delivers them to the terminator over HTTP (POST /ilp + claim header) —
 * byte-identical to what it would attach to a BTP write, but delivered to a peer
 * that we never BTP-connect to (a dead BTP url, exactly as the reference test
 * does with peer1→peer2 with peer2 offline-for-BTP).
 *
 * NO MOCKS. Reuses real `ConnectorNode`, `PerPacketClaimService`, and the
 * `serializePacket` / `deserializePacket` / `PacketType` wire primitives.
 *
 * @packageDocumentation
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import WebSocket from 'ws';
import Database from 'libsql';
// Import from the package root (not `nostr-tools/pure`): the root entry re-exports
// the `pure` signing primitives and resolves under the connector's classic
// `moduleResolution: node` (the `/pure` subpath only resolves under node16/bundler).
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools';
import { ConnectorNode } from '../../src/core/connector-node';
import { createLogger } from '../../src/utils/logger';
import type { ConnectorConfig } from '../../src/config/types';
import { PerPacketClaimService } from '../../src/settlement/per-packet-claim-service';
import {
  SENT_CLAIMS_TABLE_SCHEMA,
  SENT_CLAIMS_INDEXES,
} from '../../src/settlement/claim-sender-db-schema';
import {
  serializePacket,
  deserializePacket,
  PacketType,
  type ILPPreparePacket,
} from '@toon-protocol/shared';
import {
  ANVIL_CHAIN_ID,
  REGISTRY_ADDRESS,
  TOKEN_ADDRESS,
  PEER_PRIVATE_KEYS,
} from './multi-hop-helpers';

// ────────────────────────────────────────────────────────────────────────────
// Fixed Anvil identities (mirrors ilp-http-settlement-e2e + terminator.yaml)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The TERMINATOR's on-chain settlement key. The terminator config
 * (`scripts/app-behind-terminator/terminator.yaml`) signs/redeems channels with
 * Anvil ACCOUNT 0 (`keyId 0xac0974…ff80`); its address is account 0's address.
 * The client opens its on-chain channel TOWARD this address.
 */
export const TERMINATOR_EVM_ADDRESS =
  process.env.DEVNET_TERMINATOR_ADDR ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/**
 * The client's OWN settlement key — a funded Anvil account that is NOT account 0
 * (account 0 belongs to the terminator). `PEER_PRIVATE_KEYS[0]` = Anvil account 2
 * (address 0x3C44Cd…). It must be funded with USDC for channel deposits.
 *
 * Overridable via DEVNET_CLIENT_KEY / DEVNET_CLIENT_ADDR so the client can use a
 * freshly generated BIP-39 seed (the env pair must be the same wallet).
 */
export const CLIENT_PRIVATE_KEY = process.env.DEVNET_CLIENT_KEY ?? PEER_PRIVATE_KEYS[0]!;

/** Anvil account 2 address — the client's funded settlement wallet. */
export const CLIENT_EVM_ADDRESS =
  process.env.DEVNET_CLIENT_ADDR ?? '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

/** The peerId the client uses internally for the single terminator peer entry. */
export const TERMINATOR_PEER_ID = 'terminator';

/** The ILP address the relay store route terminates under (terminator.yaml). */
export const RELAY_STORE_DESTINATION = 'g.terminator.relay.store';

/**
 * Which chain the client settles on for this run: 'evm' (default) or 'solana'.
 * Selects the chainProvider + peer settlement address + channel-open chain. The
 * claim-signing and POST /ilp transport are chain-agnostic.
 */
export const DEVNET_CHAIN = process.env.DEVNET_CHAIN ?? 'evm';

/** The on-chain settlement chainId the claim/channel use for this run. */
const SETTLEMENT_CHAIN = DEVNET_CHAIN === 'solana' ? 'solana:devnet' : `evm:${ANVIL_CHAIN_ID}`;

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

export interface PaidRoundTripClientOptions {
  /** Terminator ILP-over-HTTP edge, e.g. `http://127.0.0.1:3000/ilp` or
   *  `https://terminator.example.com/ilp`. POST target for paid PREPAREs. */
  terminatorIlpUrl: string;
  /** EVM JSON-RPC the local ConnectorNode dials for channel ops, e.g.
   *  `http://127.0.0.1:8545` or `https://evm-rpc.example.com`. */
  evmRpcUrl: string;
  /** Faucet HTTP base (no trailing slash), e.g. `http://127.0.0.1:3500` or
   *  `https://faucet.example.com`. Used to fund the client's EVM wallet. */
  faucetUrl: string;
  /** Relay free-read Nostr WS endpoint, e.g. `ws://127.0.0.1:7100` or
   *  `wss://relay-ws.example.com`. Used to verify the stored write. */
  relayWsUrl: string;
  /** Local BTP server port for the client node (dead BTP url toward the peer is
   *  derived from this + 1; we never actually BTP-connect). Default: random. */
  localBtpPort?: number;
  /** Local admin/health ports base. Default: derived from localBtpPort. */
  localPortBase?: number;
  /** Log level for the embedded ConnectorNode. Default: 'warn'. */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

/** A single named assertion outcome the probe/test can report on. */
export interface ProbeStep {
  name: string;
  ok: boolean;
  detail?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ────────────────────────────────────────────────────────────────────────────
// Remote-aware funding (generalizes multi-hop-helpers.fundPeerAccounts, which
// hardcodes localhost). Parameterized on faucet + RPC URLs.
// ────────────────────────────────────────────────────────────────────────────

/** USDC is 6-decimal since #188/#195. Skip funding above this floor. */
const MIN_USDC_BALANCE = BigInt('10000') * BigInt(10 ** 6);

/** Read an ERC-20 balance via raw `eth_call` (no ethers dependency). */
async function getTokenBalanceRemote(rpcUrl: string, address: string): Promise<bigint> {
  const selector = '0x70a08231'; // balanceOf(address)
  const calldata = selector + address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [{ to: TOKEN_ADDRESS, data: calldata }, 'latest'],
      id: 1,
    }),
  });
  const data = (await response.json()) as { result?: string };
  // `0x`/empty means no contract code / reverted; `BigInt('0x')` throws (#104).
  if (!data.result || data.result === '0x') return 0n;
  return BigInt(data.result);
}

/**
 * Fund a single EVM address with USDC via a (possibly remote) faucet, checking
 * the balance against a (possibly remote) RPC. Idempotent: skips if already at
 * the minimum balance. Mirrors `multi-hop-helpers.fundPeerAccounts` but with the
 * URLs parameterized so it works against the public box.
 */
export async function fundEvmAddress(
  faucetUrl: string,
  rpcUrl: string,
  address: string
): Promise<void> {
  const balance = await getTokenBalanceRemote(rpcUrl, address);
  if (balance >= MIN_USDC_BALANCE) return;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${faucetUrl.replace(/\/$/, '')}/api/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      if (response.ok) {
        lastError = undefined;
        break;
      }
      const err = (await response.json().catch(() => ({}))) as { message?: string };
      lastError = new Error(
        `Faucet funding failed for ${address}: ${err.message ?? response.statusText}`
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    if (attempt < 2) await sleep(1000 * (attempt + 1));
  }
  if (lastError) throw lastError;
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP helper that works for http:// AND https:// (raw OER body, raw headers)
// ────────────────────────────────────────────────────────────────────────────

interface RawHttpResponse {
  status: number;
  body: Buffer;
}

/** POST a raw Buffer body to an arbitrary http(s) URL and return raw bytes. */
function postRaw(
  url: string,
  body: Buffer,
  headers: Record<string, string>
): Promise<RawHttpResponse> {
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: parsed.protocol,
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

// ────────────────────────────────────────────────────────────────────────────
// Inner HTTP envelope (relay#24 store contract — POST /write, body {event})
// ────────────────────────────────────────────────────────────────────────────

/** Build the literal HTTP/1.1 request envelope the terminator reverse-proxies. */
export function buildHttpEnvelope(
  method: string,
  target: string,
  headers: Array<[string, string]>,
  body: string
): Buffer {
  const CRLF = '\r\n';
  const head = [`${method} ${target} HTTP/1.1`, ...headers.map(([n, v]) => `${n}: ${v}`)].join(
    CRLF
  );
  return Buffer.concat([Buffer.from(head + CRLF + CRLF, 'latin1'), Buffer.from(body)]);
}

/**
 * Sign a Nostr kind:1 event with an ephemeral secret key using the SAME crypto
 * the repo already depends on (`nostr-tools/pure` — schnorr over secp256k1; this
 * is what produces a sig the relay verifies when RELAY_DEV_MODE=false). Returns
 * the finalized event (has `id`, `pubkey`, `sig`).
 */
export function signEphemeralKind1Event(content: string): Event {
  const sk = generateSecretKey();
  // `getPublicKey(sk)` is implied by finalizeEvent; exposed here only if a caller
  // wants the pubkey. Kept as a no-op reference so the import is meaningful.
  void getPublicKey;
  return finalizeEvent(
    {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content,
    },
    sk
  );
}

/** Build the `POST /write` envelope carrying a signed kind:1 event. */
export function buildStoreWriteEnvelope(event: Event): Buffer {
  return buildHttpEnvelope(
    'POST',
    '/write',
    [
      ['Host', 'relay'],
      ['Content-Type', 'application/json'],
    ],
    JSON.stringify({ event })
  );
}

// ────────────────────────────────────────────────────────────────────────────
// WS read verification (relay#24: EVENT[2] is a TOON-encoded STRING)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Open the relay free-read WS, REQ kind:1, read until EOSE, and assert that some
 * `["EVENT","<subId>",<toonString>]` frame's <toonString> substring-contains
 * `id: <eventId>`. relay#24 emits the EVENT payload as a TOON-encoded STRING — do
 * NOT JSON.parse it; substring-match the raw string.
 *
 * Resolves true if found before EOSE (or a final fallback timeout), else false.
 */
export function verifyEventStoredViaWs(
  relayWsUrl: string,
  eventId: string,
  timeoutMs = 15_000
): Promise<boolean> {
  return new Promise((resolve) => {
    const subId = 'ac3';
    let settled = false;
    const ws = new WebSocket(relayWsUrl);
    const finish = (found: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(found);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', subId, { kinds: [1] }]));
    });

    ws.on('message', (data: WebSocket.RawData) => {
      const raw = data.toString();
      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        return; // not a NIP-01 frame we understand
      }
      if (!Array.isArray(frame)) return;
      const [kind, sub, payload] = frame as [string, string, unknown];
      if (sub !== subId) return;
      if (kind === 'EVENT' && typeof payload === 'string') {
        // relay#24: payload is a TOON-encoded STRING, substring-match by id.
        if (payload.includes(`id: ${eventId}`)) {
          finish(true);
        }
      } else if (kind === 'EOSE') {
        // Stored-state replay complete and our event was not seen. Give late
        // EVENTs a brief grace window before declaring not-found.
        setTimeout(() => finish(false), 1_000);
      }
    });

    ws.on('error', () => finish(false));
  });
}

// ────────────────────────────────────────────────────────────────────────────
// The client
// ────────────────────────────────────────────────────────────────────────────

/**
 * Drives the full #222 paid round-trip. Lifecycle: `start()` (boots the embedded
 * node + opens the on-chain channel toward the terminator), then
 * `runPaidRoundTrip()` / `runNegatives()`, then `stop()`.
 */
export class PaidRoundTripClient {
  private node?: ConnectorNode;
  private claimSvc?: PerPacketClaimService;
  private tokenId?: string;
  private readonly opts: Required<
    Pick<PaidRoundTripClientOptions, 'terminatorIlpUrl' | 'evmRpcUrl' | 'faucetUrl' | 'relayWsUrl'>
  > & {
    localBtpPort: number;
    localPortBase: number;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
  };

  constructor(options: PaidRoundTripClientOptions) {
    const localBtpPort = options.localBtpPort ?? 40000 + Math.floor(Math.random() * 9000);
    this.opts = {
      terminatorIlpUrl: options.terminatorIlpUrl,
      evmRpcUrl: options.evmRpcUrl,
      faucetUrl: options.faucetUrl,
      relayWsUrl: options.relayWsUrl,
      localBtpPort,
      localPortBase: options.localPortBase ?? localBtpPort,
      logLevel: options.logLevel ?? 'warn',
    };
  }

  /** The on-chain channel tokenId discovered after start(); undefined before. */
  get settlementTokenId(): string | undefined {
    return this.tokenId;
  }

  private buildConfig(): ConnectorConfig {
    const { localBtpPort, localPortBase } = this.opts;
    const nodeId = 'paid-roundtrip-client';
    // The single peer represents the TERMINATOR. We never BTP-connect to it (the
    // url is a dead local port); the channel is opened on-chain toward its
    // settlement address and claims are delivered over HTTP — exactly as the
    // ilp-http-settlement reference does with peer2 offline-for-BTP.
    const deadUrl = `ws://127.0.0.1:${localBtpPort + 1}`;
    const peer =
      DEVNET_CHAIN === 'solana'
        ? {
            id: TERMINATOR_PEER_ID,
            url: deadUrl,
            authToken: '',
            settlementAddress: process.env.DEVNET_TERMINATOR_SOL_ADDR!,
            chain: 'solana:devnet',
          }
        : {
            id: TERMINATOR_PEER_ID,
            url: deadUrl,
            authToken: '',
            evmAddress: TERMINATOR_EVM_ADDRESS,
            chain: `evm:${ANVIL_CHAIN_ID}`,
          };
    const chainProvider =
      DEVNET_CHAIN === 'solana'
        ? {
            chainType: 'solana' as const,
            chainId: 'solana:devnet',
            rpcUrl: process.env.DEVNET_SOLANA_RPC!,
            programId: process.env.DEVNET_SOLANA_PROGRAM_ID!,
            keyId: process.env.DEVNET_CLIENT_SOL_KEY!,
            cluster: 'devnet',
            tokenMint: process.env.DEVNET_SOLANA_USDC_MINT!,
          }
        : {
            chainType: 'evm' as const,
            chainId: `evm:${ANVIL_CHAIN_ID}`,
            rpcUrl: this.opts.evmRpcUrl,
            registryAddress: REGISTRY_ADDRESS,
            keyId: CLIENT_PRIVATE_KEY,
            tokenAddress: TOKEN_ADDRESS,
            settlementOptions: {
              threshold: '5000',
              pollingIntervalMs: 100,
              settlementTimeoutSecs: 3600,
              initialDepositMultiplier: 2,
              ledgerSnapshotPath: `./data/ledger-paid-roundtrip-${localBtpPort}.json`,
            },
          };
    return {
      nodeId,
      btpServerPort: localBtpPort,
      healthCheckPort: localPortBase + 6,
      logLevel: this.opts.logLevel,
      environment: 'development',
      deploymentMode: 'standalone',
      adminApi: { enabled: true, port: localPortBase + 2, host: '127.0.0.1' },
      // No local delivery handler: this node only PAYS; it never terminates.
      peers: [peer],
      routes: [
        { prefix: `test.${nodeId}`, nextHop: nodeId },
        { prefix: `test.${TERMINATOR_PEER_ID}`, nextHop: TERMINATOR_PEER_ID },
      ],
      settlement: {
        connectorFeePercentage: 0.1,
        enableSettlement: true,
        tigerBeetleClusterId: 0,
        tigerBeetleReplicas: [],
        thresholds: { defaultThreshold: 5000n, pollingInterval: 100 },
      },
      chainProviders: [chainProvider],
    } as ConnectorConfig;
  }

  /**
   * Fund the client wallet, boot the embedded node, wait for the on-chain
   * channel toward the terminator to exist, and build the test-side claim signer.
   *
   * CONFIRM ON FIRST DEPLOY: that `channelManager.getChannelsForPeer()` is
   * populated by the node's auto-open path WITHOUT a live BTP peer. The reference
   * `ilp-http-settlement-e2e.test.ts` proves this for peer1→peer2 against LOCAL
   * anvil (peer2 BTP-offline); it must be confirmed once against the REMOTE anvil
   * (latency/confirmation timing may need a longer channel-open timeout).
   */
  async start(channelOpenTimeoutMs = 90_000): Promise<void> {
    // 1. Fund the client's EVM wallet from the (possibly remote) faucet, checking
    //    the balance against the (possibly remote) RPC.
    if (DEVNET_CHAIN === 'evm') {
      await fundEvmAddress(this.opts.faucetUrl, this.opts.evmRpcUrl, CLIENT_EVM_ADDRESS);
    }
    // (Solana wallets are funded out-of-band via the faucet before the run.)

    // 2. Boot the embedded payer node — it auto-opens + funds the channel.
    this.node = new ConnectorNode(
      this.buildConfig(),
      createLogger('paid-roundtrip-client', this.opts.logLevel)
    );
    await this.node.start();

    // 2b. Explicitly open + fund the on-chain channel toward the terminator. The
    //     auto-open-for-connected-peers path is gated on a live BTP connection,
    //     which this client deliberately does not have (claims ride HTTP). Against
    //     a real remote chain the auto-open never fires, so we trigger it directly.
    //     Idempotent: a pre-existing channel (e.g. local auto-open) is fine.
    const initialDeposit = process.env.DEVNET_INITIAL_DEPOSIT ?? '100000000'; // 100 USDC (6dp)
    try {
      await this.node.openChannel(
        DEVNET_CHAIN === 'solana'
          ? {
              peerId: TERMINATOR_PEER_ID,
              chain: 'solana:devnet',
              peerAddress: process.env.DEVNET_TERMINATOR_SOL_ADDR!,
              // Solana channel tokenId is the SPL mint.
              token: process.env.DEVNET_SOLANA_USDC_MINT!,
              initialDeposit,
            }
          : {
              peerId: TERMINATOR_PEER_ID,
              chain: `evm:${ANVIL_CHAIN_ID}`,
              peerAddress: TERMINATOR_EVM_ADDRESS,
              // The canonical tokenId is the resolved on-chain symbol (USDC), not
              // the public openChannel() default of 'AGENT'. Both sides must agree.
              token: process.env.DEVNET_TOKEN_ID ?? 'USDC',
              initialDeposit,
            }
      );
    } catch (err) {
      if (!/already exists/i.test(err instanceof Error ? err.message : String(err))) throw err;
    }

    // 3. Wait for the on-chain channel toward the terminator and capture tokenId.
    await waitForCondition(
      () =>
        Promise.resolve(
          (this.node!.channelManager?.getChannelsForPeer(TERMINATOR_PEER_ID).length ?? 0) > 0
        ),
      channelOpenTimeoutMs,
      'client auto-opens on-chain channel toward terminator'
    );
    this.tokenId = this.node!.channelManager!.getChannelsForPeer(TERMINATOR_PEER_ID)[0]!.tokenId;

    // 4. Build a test-side claim signer over the node's REAL channel context.
    //    libsql is a better-sqlite3-compatible drop-in at runtime (same cast the
    //    reference test uses).
    const claimDb = new Database(':memory:') as unknown as import('better-sqlite3').Database;
    claimDb.exec(SENT_CLAIMS_TABLE_SCHEMA);
    for (const idx of SENT_CLAIMS_INDEXES) claimDb.exec(idx);
    this.claimSvc = new PerPacketClaimService(
      this.node!.chainRegistry!,
      this.node!.channelManager!,
      claimDb,
      createLogger('paid-roundtrip-claim', this.opts.logLevel),
      'paid-roundtrip-client',
      new Map([[TERMINATOR_PEER_ID, SETTLEMENT_CHAIN]])
    );
  }

  /**
   * Execute the full paid round-trip:
   *   1. Sign a per-packet claim for the terminator channel.
   *   2. Build the inner `POST /write` envelope with a signed kind:1 event.
   *   3. POST the PREPARE (addressed `g.terminator.relay.store`) + claim header.
   *   4. Assert the response deserializes to FULFILL.
   *   5. Verify the write over the relay free-read WS (substring id match).
   *
   * Returns the ordered step results. Throws only on infrastructure faults
   * (never on a soft assertion — those land in the returned steps as ok:false).
   */
  async runPaidRoundTrip(): Promise<ProbeStep[]> {
    if (!this.claimSvc || !this.tokenId) {
      throw new Error('runPaidRoundTrip() called before start() completed');
    }
    const steps: ProbeStep[] = [];

    // 1. Sign claim.
    const claim = await this.claimSvc.generateClaimForPacket(
      TERMINATOR_PEER_ID,
      this.tokenId,
      1000n
    );
    steps.push({
      name: 'sign per-packet claim',
      ok: claim !== null,
      detail: claim ? undefined : 'generateClaimForPacket returned null (no channel?)',
    });
    if (!claim) return steps;

    // 2. Build the inner POST /write envelope with a signed kind:1 event.
    const event = signEphemeralKind1Event(`#222 acceptance probe ${new Date().toISOString()}`);
    const envelope = buildStoreWriteEnvelope(event);

    // 3. POST the PREPARE + claim header.
    const prepare: ILPPreparePacket = {
      type: PacketType.PREPARE,
      destination: RELAY_STORE_DESTINATION,
      amount: 1000n,
      expiresAt: new Date(Date.now() + 60_000),
      data: envelope,
    };
    const res = await postRaw(this.opts.terminatorIlpUrl, serializePacket(prepare), {
      'ilp-peer-id': TERMINATOR_PEER_ID,
      'ilp-payment-channel-claim': claim.protocolData.data.toString('base64'),
    });

    // 4. Assert FULFILL.
    let isFulfill = false;
    let outcomeDetail = `HTTP ${res.status}`;
    if (res.status === 200 && res.body.length > 0) {
      try {
        isFulfill = deserializePacket(res.body).type === PacketType.FULFILL;
        outcomeDetail = `HTTP 200, ILP type ${res.body[0]}`;
      } catch (err) {
        outcomeDetail = `HTTP 200 but undeserializable: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }
    steps.push({
      name: 'paid POST /ilp round-trips to FULFILL',
      ok: isFulfill,
      detail: outcomeDetail,
    });
    if (!isFulfill) return steps;

    // 5. WS-read verification.
    const stored = await verifyEventStoredViaWs(this.opts.relayWsUrl, event.id);
    steps.push({
      name: 'relay stored the write (WS free-read, id substring match)',
      ok: stored,
      detail: stored ? `found id: ${event.id}` : `id ${event.id} not seen before EOSE`,
    });

    return steps;
  }

  /**
   * Negative assertions:
   *   (a) The relay paid-write store (port 3100) is NOT publicly reachable. There
   *       is NO public subdomain proxying 3100 — it is simply never exposed; the
   *       only relay subdomain is the free-read WS (`relay-ws`). The strongest
   *       REMOTE proof is (b): an UNPAID write does not succeed. We additionally
   *       assert there is no reachable `relay-store.${DOMAIN}` HTTPS surface when a
   *       candidate URL is supplied.
   *   (b) An UNPAID POST /ilp (no claim header) is NOT fulfilled (REJECT or non-2xx).
   *
   * @param relayStoreProbeUrl Optional HTTPS URL that SHOULD NOT resolve to a
   *   working store (e.g. `https://relay-store.${DOMAIN}/write`). If reachable
   *   with 2xx, the check fails. Omit to skip the DNS/proxy posture sub-check.
   */
  async runNegatives(relayStoreProbeUrl?: string): Promise<ProbeStep[]> {
    const steps: ProbeStep[] = [];

    // (a) Optional: a public store surface must NOT answer 2xx.
    if (relayStoreProbeUrl) {
      let reachable2xx = false;
      let detail = 'no public store surface (connection refused / DNS failure) — expected';
      try {
        const r = await fetch(relayStoreProbeUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(5_000),
        });
        reachable2xx = r.ok;
        detail = `unexpectedly reachable: HTTP ${r.status}`;
      } catch {
        // Connection refused / DNS failure / timeout — the desired posture.
      }
      steps.push({
        name: 'relay paid-write store (3100) NOT publicly reachable',
        ok: !reachable2xx,
        detail,
      });
    }

    // (b) UNPAID POST /ilp must not FULFILL.
    const envelope = buildStoreWriteEnvelope(
      signEphemeralKind1Event(`#222 unpaid attempt ${new Date().toISOString()}`)
    );
    const prepare: ILPPreparePacket = {
      type: PacketType.PREPARE,
      destination: RELAY_STORE_DESTINATION,
      amount: 1000n,
      expiresAt: new Date(Date.now() + 60_000),
      data: envelope,
    };
    // No `ilp-payment-channel-claim` header — this is the unpaid attempt.
    const res = await postRaw(this.opts.terminatorIlpUrl, serializePacket(prepare), {});

    let notFulfilled: boolean;
    let detail: string;
    if (res.status === 200) {
      // The edge answers ILP-level outcomes as 200 + serialized REJECT. A FULFILL
      // would mean the unpaid write slipped through — that must NOT happen.
      notFulfilled = res.body.length > 0 && res.body[0] !== PacketType.FULFILL;
      detail = `HTTP 200, ILP type ${res.body[0]} (REJECT=${PacketType.REJECT})`;
    } else {
      // Any non-2xx is also a valid "not accepted" outcome.
      notFulfilled = res.status >= 400;
      detail = `HTTP ${res.status}`;
    }
    steps.push({ name: 'UNPAID POST /ilp is REJECTED (not FULFILLED)', ok: notFulfilled, detail });

    return steps;
  }

  /** Stop the embedded node (best-effort). */
  async stop(): Promise<void> {
    await this.node?.stop().catch(() => undefined);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Shared wait helper (kept local so this module is self-contained)
// ────────────────────────────────────────────────────────────────────────────

async function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs: number,
  description: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      /* keep polling */
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for: ${description} (${timeoutMs}ms)`);
}
