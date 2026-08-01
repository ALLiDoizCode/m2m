/**
 * Environment/config surface for the announcer sidecar (connector#681).
 *
 * Every variable an orchestrator must set to wire this into the apex box's
 * docker-compose is enumerated here, with the exact default each falls back
 * to when unset — see this module's exported `ENV_VARS` for the full list,
 * and the package README for the human-readable version.
 *
 * @module config
 */

import { readFileSync } from 'node:fs';

export interface AnnouncerConfig {
  /** Base URL of the Rust client edge to POLL. NEVER advertised — internal only. */
  rustEdgeUrl: string;
  /** Relay WebSocket URL(s) this sidecar publishes the announce to. */
  relayUrls: string[];
  /** The dedicated announce identity's 32-byte Nostr secret key (NIP-06-derived or otherwise). */
  secretKey: Uint8Array;

  ilpAddress: string;
  ilpAddresses: string[];
  routePublish: string;
  routeStore: string;
  probeRoutes: string[];

  httpEndpoint: string;
  btpEndpoint: string;
  relayPublicUrl?: string;

  assetCode: string;
  assetScale: number;
  solanaChainId: string;

  refreshIntervalSecs: number;
  ttlSeconds: number;
  edgePollTimeoutMs: number;
  publishTimeoutMs: number;

  healthPort: number;
}

/** The full set of environment variables this sidecar reads, for `--help`-style documentation. */
export const ENV_VARS = [
  'ANNOUNCER_RUST_EDGE_URL',
  'ANNOUNCER_RELAY_URLS',
  'ANNOUNCER_IDENTITY_SECRET_KEY_HEX',
  'ANNOUNCER_IDENTITY_SECRET_KEY_FILE',
  'ANNOUNCER_ILP_ADDRESS',
  'ANNOUNCER_ILP_ADDRESSES',
  'ANNOUNCER_ROUTE_PUBLISH',
  'ANNOUNCER_ROUTE_STORE',
  'ANNOUNCER_PROBE_ROUTES',
  'ANNOUNCER_HTTP_ENDPOINT',
  'ANNOUNCER_BTP_ENDPOINT',
  'ANNOUNCER_RELAY_PUBLIC_URL',
  'ANNOUNCER_ASSET_CODE',
  'ANNOUNCER_ASSET_SCALE',
  'ANNOUNCER_SOLANA_CHAIN_ID',
  'ANNOUNCER_REFRESH_INTERVAL_SECS',
  'ANNOUNCER_TTL_SECS',
  'ANNOUNCER_EDGE_POLL_TIMEOUT_MS',
  'ANNOUNCER_PUBLISH_TIMEOUT_MS',
  'ANNOUNCER_HEALTH_PORT',
  'LOG_LEVEL',
] as const;

const DEFAULT_REFRESH_INTERVAL_SECS = 300;
const DEFAULT_ILP_ADDRESS = 'g.toon';
const DEFAULT_HTTP_ENDPOINT = 'https://proxy.devnet.toonprotocol.dev/rust/ilp';
const DEFAULT_BTP_ENDPOINT = 'wss://proxy.devnet.toonprotocol.dev/rust/ilp/btp';
const DEFAULT_SOLANA_CHAIN_ID = 'solana:devnet';

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function resolveSecretKey(env: NodeJS.ProcessEnv): Uint8Array {
  const hex = env.ANNOUNCER_IDENTITY_SECRET_KEY_HEX;
  const file = env.ANNOUNCER_IDENTITY_SECRET_KEY_FILE;
  if (hex && file) {
    throw new Error(
      'Set exactly one of ANNOUNCER_IDENTITY_SECRET_KEY_HEX / ANNOUNCER_IDENTITY_SECRET_KEY_FILE, not both'
    );
  }
  const raw = hex ?? (file ? readFileSync(file, 'utf8') : undefined);
  if (!raw) {
    throw new Error(
      'No announce identity configured: set ANNOUNCER_IDENTITY_SECRET_KEY_HEX or ANNOUNCER_IDENTITY_SECRET_KEY_FILE'
    );
  }
  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(
      'ANNOUNCER_IDENTITY_SECRET_KEY_HEX/FILE must be exactly 64 hex chars (a 32-byte secp256k1 secret key)'
    );
  }
  return Uint8Array.from(Buffer.from(trimmed, 'hex'));
}

/**
 * Derive the publish/store route hints, mirroring the retired connector's
 * `resolveRouteHints` suffix heuristic (`.relay` -> publish, `.store` ->
 * store), with explicit overrides always winning.
 */
function deriveRouteHints(
  addresses: string[],
  overridePublish: string | undefined,
  overrideStore: string | undefined,
  primary: string
): { publish: string; store: string } {
  const relay = addresses.find((a) => a.endsWith('.relay'));
  const store =
    addresses.find((a) => a.endsWith('.store')) ?? addresses.find((a) => a.endsWith('.ario'));

  let publish = overridePublish ?? relay;
  let storeAddr = overrideStore ?? store;

  if (!publish && storeAddr) {
    publish = storeAddr.endsWith('.store')
      ? `${storeAddr.slice(0, -'.store'.length)}.relay`
      : storeAddr;
  }
  if (!storeAddr && publish) {
    storeAddr = publish.endsWith('.relay')
      ? `${publish.slice(0, -'.relay'.length)}.store`
      : publish;
  }

  return { publish: publish ?? primary, store: storeAddr ?? primary };
}

/** Load and validate the full config from `process.env` (or an injected map, for tests). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AnnouncerConfig {
  const ilpAddress = env.ANNOUNCER_ILP_ADDRESS ?? DEFAULT_ILP_ADDRESS;
  const explicitAddresses = splitCsv(env.ANNOUNCER_ILP_ADDRESSES);
  const ilpAddresses = explicitAddresses.length > 0 ? explicitAddresses : [ilpAddress];
  if (!ilpAddresses.includes(ilpAddress)) ilpAddresses.unshift(ilpAddress);

  const routes = deriveRouteHints(
    ilpAddresses,
    env.ANNOUNCER_ROUTE_PUBLISH,
    env.ANNOUNCER_ROUTE_STORE,
    ilpAddress
  );

  const probeRoutes = splitCsv(env.ANNOUNCER_PROBE_ROUTES);

  const refreshIntervalSecs = env.ANNOUNCER_REFRESH_INTERVAL_SECS
    ? Number(env.ANNOUNCER_REFRESH_INTERVAL_SECS)
    : DEFAULT_REFRESH_INTERVAL_SECS;
  if (!Number.isFinite(refreshIntervalSecs) || refreshIntervalSecs <= 0) {
    throw new Error('ANNOUNCER_REFRESH_INTERVAL_SECS must be a positive number');
  }
  const ttlSeconds = env.ANNOUNCER_TTL_SECS
    ? Number(env.ANNOUNCER_TTL_SECS)
    : refreshIntervalSecs * 2;

  const relayUrls = splitCsv(env.ANNOUNCER_RELAY_URLS);

  return {
    rustEdgeUrl: env.ANNOUNCER_RUST_EDGE_URL ?? 'http://connector-rust:4000',
    relayUrls,
    secretKey: resolveSecretKey(env),

    ilpAddress,
    ilpAddresses,
    routePublish: routes.publish,
    routeStore: routes.store,
    probeRoutes: probeRoutes.length > 0 ? probeRoutes : ilpAddresses,

    httpEndpoint: env.ANNOUNCER_HTTP_ENDPOINT ?? DEFAULT_HTTP_ENDPOINT,
    btpEndpoint: env.ANNOUNCER_BTP_ENDPOINT ?? DEFAULT_BTP_ENDPOINT,
    // Advertised for FREE READS, so it must be a public WS endpoint — never
    // an http(s) publish entry (those are the relay's PRIVATE write ingress,
    // see publisher.ts). Fall back to the first ws/wss publish URL only.
    relayPublicUrl:
      env.ANNOUNCER_RELAY_PUBLIC_URL ??
      relayUrls.find((u) => u.startsWith('ws://') || u.startsWith('wss://')),

    assetCode: env.ANNOUNCER_ASSET_CODE ?? 'USDC',
    assetScale: env.ANNOUNCER_ASSET_SCALE ? Number(env.ANNOUNCER_ASSET_SCALE) : 6,
    solanaChainId: env.ANNOUNCER_SOLANA_CHAIN_ID ?? DEFAULT_SOLANA_CHAIN_ID,

    refreshIntervalSecs,
    ttlSeconds,
    edgePollTimeoutMs: env.ANNOUNCER_EDGE_POLL_TIMEOUT_MS
      ? Number(env.ANNOUNCER_EDGE_POLL_TIMEOUT_MS)
      : 5000,
    publishTimeoutMs: env.ANNOUNCER_PUBLISH_TIMEOUT_MS
      ? Number(env.ANNOUNCER_PUBLISH_TIMEOUT_MS)
      : 5000,

    healthPort: env.ANNOUNCER_HEALTH_PORT ? Number(env.ANNOUNCER_HEALTH_PORT) : 8090,
  };
}
