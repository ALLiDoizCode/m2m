/**
 * Builds the connector's OWN kind:10032 `IlpPeerInfo` announcement from its
 * existing config (relay#37 / store#22).
 *
 * Everything advertised is DERIVED from the connector's `connector.yaml`:
 * - the locally-terminated routes' `ilpAddress` + `settlementAddresses`,
 * - the chain ids from `chainProviders`,
 * - the public BTP/HTTP/relay endpoints (operator overrides, since the
 *   connector can't infer its public hostname behind TLS termination).
 *
 * `settlementAddresses` keys are re-keyed from the config surface's bare chain
 * namespaces (`evm`) to the fully-qualified chain ids in `supportedChains`
 * (`evm:31337`) so the emitted event parses under `@toon-protocol/core`'s
 * `parseIlpPeerInfo` schema — see {@link normalizeSettlementAddressKeys} (#289).
 *
 * Per both issues, the node's route addresses ride along in the announcement
 * CONTENT (`routes: { publish, store }`) — NOT a core wire-type change. Since
 * the builder JSON-stringifies the whole object, these extra content fields
 * are carried through transparently.
 *
 * @module discovery/self-announce-builder
 */

import type { ConnectorConfig, RouteConfig, SelfAnnounceConfig } from '../config/types';
import type { IlpPeerInfo } from './ilp-peer-info-event';

/** Default asset advertised when not overridden. */
const DEFAULT_ASSET_CODE = 'USDC';
const DEFAULT_ASSET_SCALE = 6;

/**
 * Warn sink for announce-derivation anomalies (pino `logger.warn`-shaped).
 * Optional so the builder stays pure/log-free in tests and non-service callers.
 */
export type AnnounceWarnFn = (context: object, message: string) => void;

/** Out-of-band route hints carried in the announcement content. */
export interface IlpRouteHints {
  /** ILP address a client should PUBLISH (Nostr writes) to, e.g. `g.proxy.relay`. */
  publish: string;
  /** ILP address a client should STORE (blob uploads) to, e.g. `g.proxy.store`. */
  store: string;
}

/** The full announcement payload: an `IlpPeerInfo` plus out-of-band route hints. */
export type SelfAnnouncementInfo = IlpPeerInfo & { routes: IlpRouteHints };

/** A route is locally terminated iff it carries an `upstream`. */
function isTerminated(route: RouteConfig): boolean {
  return typeof route.upstream === 'string' && route.upstream.length > 0;
}

/** The advertised address for a route: its explicit `ilpAddress`, else its `prefix`. */
function routeAddress(route: RouteConfig): string {
  return route.ilpAddress ?? route.prefix;
}

/**
 * Resolve the publish/store route hints from the connector's routes.
 *
 * - publish: an explicit override, else the route ending in `.relay`, else the
 *   store address with its trailing `.store` swapped for `.relay`.
 * - store: an explicit override, else the DIRECT `.store` route (one not on the
 *   `.relay.` hop path), else any `.store` route, else the publish address with
 *   its trailing `.relay` swapped for `.store`.
 *
 * Mirrors the store entrypoint's `resolveAnnouncementRoutes`, generalized to
 * work from EITHER a relay-connector apex (terminates `.relay`) or a
 * store-connector apex (terminates `.store`).
 */
export function resolveRouteHints(
  routes: RouteConfig[],
  override?: SelfAnnounceConfig['routes']
): IlpRouteHints {
  const addresses = routes.map(routeAddress);

  const relayRoute = addresses.find((a) => a.endsWith('.relay'));
  const directStoreRoute =
    addresses.find((a) => a.endsWith('.store') && !a.includes('.relay.')) ??
    addresses.find((a) => a.endsWith('.store'));

  let publish = override?.publish ?? relayRoute;
  let store = override?.store ?? directStoreRoute;

  // Derive whichever side is still missing by swapping the sibling label.
  if (!publish && store) {
    publish = store.endsWith('.store') ? `${store.slice(0, -'.store'.length)}.relay` : store;
  }
  if (!store && publish) {
    store = publish.endsWith('.relay') ? `${publish.slice(0, -'.relay'.length)}.store` : publish;
  }

  // Final fallback: first configured route (keeps the field populated rather
  // than empty so a client always has SOMETHING to dial).
  const fallback = addresses[0] ?? '';
  return {
    publish: publish ?? fallback,
    store: store ?? fallback,
  };
}

/**
 * Normalize `settlementAddresses` keys to the fully-qualified chain ids the
 * announcement lists in `supportedChains` (#289).
 *
 * The config surface (`RouteTermination.settlementAddresses`) keys addresses by
 * bare chain NAMESPACE (`evm` / `solana` / `mina`) because the x402 greeting
 * layer consumes it that way (issue #217) — that surface is unchanged. But
 * `@toon-protocol/core`'s `parseIlpPeerInfo` (published 1.6.0 and 2.0.0,
 * byte-identical on this section) REJECTS the whole kind:10032 event unless
 * every `settlementAddresses` key (a) is a 2–3 segment chain id (`evm:31337`)
 * and (b) is a member of `supportedChains`. A bare `evm` key therefore poisons
 * the ENTIRE announcement for every SDK client. So at announce time we re-key:
 *
 * - a bare namespace key expands to EVERY supported chain in that namespace
 *   (account addresses are namespace-wide on all three supported ecosystems);
 * - an already chain-qualified key passes through when it is in
 *   `supportedChains` (or when the node announces no `supportedChains` at all,
 *   since core skips the membership check when the field is omitted);
 * - a key that cannot be expressed schema-compliantly is dropped with a
 *   warning — losing one address beats losing the whole announcement.
 *
 * @param addresses - Merged chain → address map from the terminated routes.
 * @param supportedChains - The qualified chain ids the announcement advertises.
 * @param warn - Optional warn sink for dropped keys.
 * @returns A map whose keys all satisfy core's kind:10032 schema.
 */
export function normalizeSettlementAddressKeys(
  addresses: Record<string, string>,
  supportedChains: string[],
  warn?: AnnounceWarnFn
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, addr] of Object.entries(addresses)) {
    if (key.includes(':')) {
      // Already chain-qualified (e.g. `evm:31337`).
      if (supportedChains.length === 0 || supportedChains.includes(key)) {
        out[key] = addr;
      } else {
        warn?.(
          { event: 'self_announce_settlement_key_dropped', key, supportedChains },
          'Dropping settlementAddresses key not in supportedChains (would fail core kind:10032 parsing)'
        );
      }
      continue;
    }
    // Bare namespace key (config surface: `evm` / `solana` / `mina`): expand to
    // every supported chain in that namespace.
    const qualified = supportedChains.filter((chainId) => chainId.split(':')[0] === key);
    if (qualified.length === 0) {
      warn?.(
        { event: 'self_announce_settlement_key_dropped', key, supportedChains },
        'Dropping bare settlementAddresses key with no matching chainProviders chain id (cannot be announced schema-compliantly)'
      );
      continue;
    }
    for (const chainId of qualified) out[chainId] = addr;
  }
  return out;
}

/**
 * Build the connector's own kind:10032 announcement payload from its config.
 *
 * @param config - The full connector config (routes + chainProviders).
 * @param selfAnnounce - The `selfAnnounce` block (endpoints + overrides).
 * @param warn - Optional warn sink for derivation anomalies (dropped keys).
 * @returns An `IlpPeerInfo` augmented with out-of-band `routes` hints.
 */
export function buildSelfAnnouncementInfo(
  config: ConnectorConfig,
  selfAnnounce: SelfAnnounceConfig,
  warn?: AnnounceWarnFn
): SelfAnnouncementInfo {
  const terminated = config.routes.filter(isTerminated);

  // Primary + all ILP addresses: the locally-terminated routes (the apexes this
  // node IS). Fall back to all routes if nothing is terminated (forwarding-only
  // node still advertises where it routes).
  const sourceRoutes = terminated.length > 0 ? terminated : config.routes;
  const ilpAddresses = Array.from(new Set(sourceRoutes.map(routeAddress))).filter(Boolean);
  const ilpAddress = ilpAddresses[0] ?? '';

  // Supported chains from the chain providers (e.g. `evm:31337`).
  const supportedChains = (config.chainProviders ?? [])
    .map((p) => p.chainId)
    .filter((c): c is string => typeof c === 'string' && c.length > 0);

  // Merge per-route settlement addresses (chain → address) across terminated
  // routes. They share one settlement identity in the canonical deploys, so a
  // shallow merge is well-defined.
  const mergedAddresses: Record<string, string> = {};
  for (const route of sourceRoutes) {
    if (route.settlementAddresses) {
      for (const [chain, addr] of Object.entries(route.settlementAddresses)) {
        if (addr) mergedAddresses[chain] = addr;
      }
    }
  }

  // Re-key to the qualified chain ids in `supportedChains` so the announcement
  // parses under `@toon-protocol/core`'s kind:10032 schema (#289).
  const settlementAddresses = normalizeSettlementAddressKeys(
    mergedAddresses,
    supportedChains,
    warn
  );

  const routes = resolveRouteHints(config.routes, selfAnnounce.routes);

  const info: SelfAnnouncementInfo = {
    ilpAddress,
    ...(ilpAddresses.length > 1 ? { ilpAddresses } : {}),
    btpEndpoint: selfAnnounce.btpEndpoint ?? '',
    assetCode: selfAnnounce.assetCode ?? DEFAULT_ASSET_CODE,
    assetScale: selfAnnounce.assetScale ?? DEFAULT_ASSET_SCALE,
    ...(selfAnnounce.httpEndpoint ? { httpEndpoint: selfAnnounce.httpEndpoint } : {}),
    ...(selfAnnounce.relayUrl ? { relayUrl: selfAnnounce.relayUrl } : {}),
    ...(supportedChains.length > 0 ? { supportedChains } : {}),
    ...(Object.keys(settlementAddresses).length > 0 ? { settlementAddresses } : {}),
    routes,
  };

  return info;
}
