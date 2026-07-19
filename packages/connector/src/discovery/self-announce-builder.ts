/**
 * Builds the connector's OWN kind:10032 `IlpPeerInfo` announcement from its
 * existing config (relay#37 / store#22).
 *
 * Everything advertised is DERIVED from the connector's `connector.yaml`:
 * - the locally-terminated routes' `ilpAddress` + `settlementAddresses`,
 * - the chain ids from `chainProviders`,
 * - the per-chain channel parameters (`tokenNetworks` / `preferredTokens`)
 *   from the `chainProviders` entries — plus runtime-resolved EVM TokenNetwork
 *   contracts injected by the caller (see {@link deriveChainSettlementParams}),
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

import type {
  ChainProviderConfigEntry,
  ChildConfig,
  ConnectorConfig,
  PeerConfig,
  RouteConfig,
  SelfAnnounceConfig,
} from '../config/types';
import { isValidILPAddress } from '@toon-protocol/shared';
import { deriveApex } from '../config/child-expander';
import type { IlpCapabilityEntry, IlpPeerInfo, IlpRoutingInfo } from './ilp-peer-info-event';
import { normalizeCapabilityName } from './ilp-peer-info-event';

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
 * Resolution precedence per side (toon-meta#153 generalization):
 * 1. an explicit `selfAnnounce.routes` override;
 * 2. a `children` entry named `relay` (publish) / `store` (store), resolved to
 *    its expanded address `<apex>.<name>` — the first-class child-prefix
 *    binding replaces the label heuristics when present;
 * 3. the legacy suffix heuristics (backward compatible):
 *    - publish: the route ending in `.relay`, else the store address with its
 *      trailing `.store` swapped for `.relay`;
 *    - store: the DIRECT `.store` route (one not on the `.relay.` hop path),
 *      else any `.store` route, else the publish address with its trailing
 *      `.relay` swapped for `.store`.
 *
 * Mirrors the store entrypoint's `resolveAnnouncementRoutes`, generalized to
 * work from EITHER a relay-connector apex (terminates `.relay`) or a
 * store-connector apex (terminates `.store`).
 *
 * @param routes - The connector's configured routes.
 * @param override - Optional explicit `selfAnnounce.routes` overrides.
 * @param children - Optional `children` bindings (toon-meta#153).
 * @param apex - The node's apex (required to resolve child hints).
 */
export function resolveRouteHints(
  routes: RouteConfig[],
  override?: SelfAnnounceConfig['routes'],
  children?: ChildConfig[],
  apex?: string
): IlpRouteHints {
  const addresses = routes.map(routeAddress);

  // First-class children named 'relay'/'store' resolve to `<apex>.<name>`.
  const childHint = (name: string): string | undefined =>
    apex && children?.some((c) => c.name === name) ? `${apex}.${name}` : undefined;

  const relayRoute = childHint('relay') ?? addresses.find((a) => a.endsWith('.relay'));
  const directStoreRoute =
    childHint('store') ??
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
 * Per-chain settlement parameters derived from the `chainProviders` config —
 * the maps a standalone client needs to open a payment channel from the
 * announce alone (toon-client#378 consumes them).
 */
export interface ChainSettlementParams {
  /**
   * Chain id → settlement-contract address: the payment-channel PROGRAM id on
   * Solana chains, the payment channel zkApp address on Mina chains. EVM
   * TokenNetwork contracts are NOT config-derivable (the config carries only
   * the TokenNetworkRegistry; the TokenNetwork itself is an on-chain lookup) —
   * they arrive via the runtime `tokenNetworks` merge in
   * {@link buildSelfAnnouncementInfo}.
   */
  tokenNetworks: Record<string, string>;
  /**
   * Chain id → preferred token contract: the ERC-20 token on EVM chains, the
   * SPL token MINT on Solana chains, the token-owner zkApp on Mina chains.
   */
  preferredTokens: Record<string, string>;
}

/**
 * Derive per-chain `tokenNetworks` / `preferredTokens` announce maps from the
 * `chainProviders` config. Keys are the providers' `chainId`s — the exact
 * same identifiers `supportedChains` advertises, so the maps stay consistent
 * with the rest of the announcement. Entries the provider does not configure
 * (e.g. a Solana provider without a `tokenMint`) are omitted, never emitted
 * as empty strings.
 *
 * Per chain family:
 * - `evm`: `preferredTokens` = `tokenAddress` (the ERC-20 channel token). No
 *   config-derivable `tokenNetworks` entry — see {@link ChainSettlementParams}.
 * - `solana`: `tokenNetworks` = `programId` (the payment-channel program),
 *   `preferredTokens` = `tokenMint` (the SPL mint).
 * - `mina`: `tokenNetworks` = `zkAppAddress` (the payment channel zkApp),
 *   `preferredTokens` = `tokenAddress` (the token-owner zkApp), when set.
 *
 * @param chainProviders - The `chainProviders` config entries.
 * @returns The derived (possibly empty) chain-keyed maps.
 */
export function deriveChainSettlementParams(
  chainProviders: ChainProviderConfigEntry[] | undefined
): ChainSettlementParams {
  const tokenNetworks: Record<string, string> = {};
  const preferredTokens: Record<string, string> = {};

  for (const provider of chainProviders ?? []) {
    const chainId = provider.chainId;
    if (!chainId) continue;

    switch (provider.chainType) {
      case 'evm':
        if (provider.tokenAddress) preferredTokens[chainId] = provider.tokenAddress;
        break;
      case 'solana':
        if (provider.programId) tokenNetworks[chainId] = provider.programId;
        if (provider.tokenMint) preferredTokens[chainId] = provider.tokenMint;
        break;
      case 'mina':
        if (provider.zkAppAddress) tokenNetworks[chainId] = provider.zkAppAddress;
        if (provider.tokenAddress) preferredTokens[chainId] = provider.tokenAddress;
        break;
    }
  }

  return { tokenNetworks, preferredTokens };
}

/** Compressed secp256k1 pubkey: 02/03 parity byte + 32-byte x coordinate, hex. */
const COMPRESSED_PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/;

/**
 * Convert a peer's configured `nip59PublicKey` (compressed secp256k1, 66-char
 * hex with an 02/03 parity prefix) to its Nostr pubkey (the x-only 64-char
 * lowercase-hex coordinate — exactly the compressed key minus the parity
 * byte). Returns `null` for anything that isn't a valid compressed key.
 */
export function nip59KeyToNostrPubkey(nip59PublicKey: string | undefined): string | null {
  if (!nip59PublicKey || !COMPRESSED_PUBKEY_RE.test(nip59PublicKey)) return null;
  return nip59PublicKey.slice(2).toLowerCase();
}

/**
 * Derive the announcement's link-state `routing` block (toon-meta#153) from
 * the connector's config:
 *
 * - `prefixes`: the addresses of this node's OWN locally-delivered routes —
 *   terminated routes (`upstream` set) plus routes whose `nextHop` is this
 *   node itself (`nodeId` / `local`) — all at cost 0. Forwarding-only routes
 *   are deliberately NOT advertised: reachability THROUGH this node emerges
 *   from the adjacency graph, not from re-announcing someone else's prefixes.
 * - `adjacency`: the Nostr pubkeys of configured peers, for peers that declare
 *   a `nip59PublicKey`. Peers without a known pubkey are silently omitted
 *   (they simply don't contribute an edge).
 *
 * Returns `null` when the block would be empty (nothing to announce).
 */
export function buildRoutingInfo(config: ConnectorConfig): IlpRoutingInfo | null {
  const isLocallyDelivered = (route: RouteConfig): boolean =>
    isTerminated(route) || route.nextHop === config.nodeId || route.nextHop === 'local';

  const prefixes = Array.from(
    new Set(config.routes.filter(isLocallyDelivered).map(routeAddress))
  ).map((prefix) => ({ prefix, cost: 0 }));

  const adjacency = Array.from(
    new Set(
      (config.peers ?? [])
        .map((peer: PeerConfig) => nip59KeyToNostrPubkey(peer.nip59PublicKey))
        .filter((pubkey): pubkey is string => pubkey !== null)
    )
  );

  if (prefixes.length === 0 && adjacency.length === 0) return null;
  return { prefixes, adjacency };
}

/**
 * Capability advertised for the legacy `routes.publish` (relay write) hint.
 *
 * Naming: connector-control-plane.md §4.1 standardizes the closed core
 * (`os.put`/`os.get`/`os.send`/`os.transfer`/`os.swap`/`os.run`) but nowhere
 * assigns a core name to the relay-write hint, so per the open-namespace rule
 * we advertise it as `os.publish` — the hint's own established name — rather
 * than inventing core semantics for it.
 */
export const PUBLISH_HINT_CAPABILITY = 'os.publish';

/**
 * Capability advertised for the legacy `routes.store` (blob store) hint.
 *
 * Naming precedent: connector-control-plane.md §4.3's directory example maps
 * exactly this hint to `"capability": "os.store"` at the store address (and
 * §1 line 43 speaks of "capability `os.store`"), so we follow the doc rather
 * than remapping onto core `os.put`/`os.get`.
 */
export const STORE_HINT_CAPABILITY = 'os.store';

/**
 * Derive the announcement's `capabilities` directory (toon-meta#153,
 * connector-control-plane.md §4.3) from the connector's config:
 *
 * 1. **Explicit child capabilities** — every `children` entry carrying a
 *    `capability` field advertises `{ capability, address: <apex>.<name>,
 *    price?, schema? }`. These are the operator's explicit word and always
 *    win: a derived hint entry (2) is suppressed when an explicit entry
 *    already covers the same capability name OR the same address.
 * 2. **Derived legacy-hint mappings** — the resolved `routes` hints map
 *    publish → {@link PUBLISH_HINT_CAPABILITY} and store →
 *    {@link STORE_HINT_CAPABILITY} (see those constants for the naming
 *    rationale), carrying the matching child/route price when configured.
 *    The legacy `routes: { publish, store }` block itself is still emitted
 *    unchanged alongside — deployed consumers parse it.
 * 3. **Explicit `selfAnnounce.capabilities`** — operator-provided entries
 *    (validated at config load) appended after the derived ones.
 *
 * Entries whose capability name or address is invalid are skipped with a
 * warning (the builder stays pure — warn-sink pattern); capability names are
 * normalized to lowercase; the result is deduped by (capability, address),
 * first occurrence wins.
 *
 * @param config - The full connector config (children + routes).
 * @param selfAnnounce - The `selfAnnounce` block (hint overrides + explicit entries).
 * @param warn - Optional warn sink for skipped entries.
 * @returns The derived directory (possibly empty), in the order above.
 */
export function buildCapabilityDirectory(
  config: ConnectorConfig,
  selfAnnounce?: SelfAnnounceConfig,
  warn?: AnnounceWarnFn
): IlpCapabilityEntry[] {
  const apex = deriveApex(config);

  const makeEntry = (
    rawCapability: string,
    address: string,
    price: string | undefined,
    schema: string | undefined,
    source: string
  ): IlpCapabilityEntry | null => {
    const capability = normalizeCapabilityName(rawCapability);
    if (capability === null) {
      warn?.(
        { event: 'self_announce_capability_skipped', capability: rawCapability, source },
        'Skipping capability entry with a malformed capability name'
      );
      return null;
    }
    if (!isValidILPAddress(address)) {
      warn?.(
        { event: 'self_announce_capability_skipped', capability, address, source },
        'Skipping capability entry with an invalid ILP address'
      );
      return null;
    }
    return {
      capability,
      address,
      ...(price !== undefined ? { price } : {}),
      ...(schema !== undefined ? { schema } : {}),
    };
  };

  // 1. Explicit child capabilities: `<apex>.<name>` termination advertised
  //    under the operator-declared capability name.
  const childEntries: IlpCapabilityEntry[] = [];
  for (const child of config.children ?? []) {
    if (child.capability === undefined) continue;
    if (!apex) {
      warn?.(
        { event: 'self_announce_capability_skipped', capability: child.capability },
        'Skipping child capability: no apex is derivable to resolve its address'
      );
      continue;
    }
    const entry = makeEntry(
      child.capability,
      `${apex}.${child.name}`,
      child.price,
      child.schema,
      `child '${child.name}'`
    );
    if (entry) childEntries.push(entry);
  }

  // 3 (collected early so explicit entries can suppress derived ones).
  const explicitEntries: IlpCapabilityEntry[] = [];
  for (const raw of selfAnnounce?.capabilities ?? []) {
    const entry = makeEntry(raw.capability, raw.address, raw.price, raw.schema, 'selfAnnounce');
    if (entry) explicitEntries.push(entry);
  }

  // 2. Derived legacy-hint mappings — suppressed wherever an explicit entry
  //    already covers the capability name or the address (explicit wins).
  const explicit = [...childEntries, ...explicitEntries];
  const explicitCapabilities = new Set(explicit.map((e) => e.capability));
  const explicitAddresses = new Set(explicit.map((e) => e.address));

  const priceForAddress = (address: string): string | undefined => {
    if (apex) {
      const child = (config.children ?? []).find((c) => `${apex}.${c.name}` === address);
      if (child?.price !== undefined) return child.price;
    }
    return config.routes.find((r) => routeAddress(r) === address)?.price;
  };

  const hints = resolveRouteHints(config.routes, selfAnnounce?.routes, config.children, apex);
  const derivedEntries: IlpCapabilityEntry[] = [];
  for (const [capability, address] of [
    [PUBLISH_HINT_CAPABILITY, hints.publish],
    [STORE_HINT_CAPABILITY, hints.store],
  ] as const) {
    if (!isValidILPAddress(address)) continue; // e.g. the '' no-routes fallback
    if (explicitCapabilities.has(capability) || explicitAddresses.has(address)) continue;
    const price = priceForAddress(address);
    derivedEntries.push({ capability, address, ...(price !== undefined ? { price } : {}) });
  }

  // Dedupe by (capability, address), first occurrence wins.
  const seen = new Set<string>();
  const directory: IlpCapabilityEntry[] = [];
  for (const entry of [...childEntries, ...derivedEntries, ...explicitEntries]) {
    const key = `${entry.capability} ${entry.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    directory.push(entry);
  }
  return directory;
}

/**
 * Build the connector's own kind:10032 announcement payload from its config.
 *
 * @param config - The full connector config (routes + chainProviders).
 * @param selfAnnounce - The `selfAnnounce` block (endpoints + overrides).
 * @param warn - Optional warn sink for derivation anomalies (dropped keys).
 * @param runtimeTokenNetworks - Chain id → settlement-contract addresses that
 *   are only knowable at RUNTIME (the EVM TokenNetwork contract is resolved
 *   on-chain from the configured registry). Merged over the config-derived
 *   `tokenNetworks`; keys must use the same chain ids as `supportedChains`.
 * @returns An `IlpPeerInfo` augmented with out-of-band `routes` hints.
 */
export function buildSelfAnnouncementInfo(
  config: ConnectorConfig,
  selfAnnounce: SelfAnnounceConfig,
  warn?: AnnounceWarnFn,
  runtimeTokenNetworks?: Record<string, string>
): SelfAnnouncementInfo {
  const terminated = config.routes.filter(isTerminated);

  // Primary + all ILP addresses: the locally-terminated routes (the apexes this
  // node IS). Fall back to all routes if nothing is terminated (forwarding-only
  // node still advertises where it routes).
  const sourceRoutes = terminated.length > 0 ? terminated : config.routes;
  let ilpAddresses = Array.from(new Set(sourceRoutes.map(routeAddress))).filter(Boolean);

  // Apex aggregation (toon-meta#153): advertise only the apex upward. Every
  // address covered by the apex (equal to it or a strict descendant) collapses
  // to the apex; terminated routes NOT under the apex are still advertised
  // individually (uncovered standalone routes). Defaults on only when the
  // `children`/`apex` config surface is in use, so legacy configs keep
  // enumerating every terminated route unchanged.
  const apex = deriveApex(config);
  const aggregate =
    selfAnnounce.aggregate ??
    (config.apex !== undefined || (config.children !== undefined && config.children.length > 0));
  if (aggregate && apex) {
    const collapsed: string[] = [];
    for (const address of ilpAddresses) {
      const covered = address === apex || address.startsWith(`${apex}.`);
      const advertised = covered ? apex : address;
      if (!collapsed.includes(advertised)) {
        collapsed.push(advertised);
      }
    }
    // Apex first: it is the node's primary advertised identity.
    ilpAddresses = collapsed.includes(apex)
      ? [apex, ...collapsed.filter((a) => a !== apex)]
      : collapsed;
  }

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

  // Per-chain channel parameters (toon-client#378): config-derived Solana/Mina
  // entries, with runtime-resolved entries (the EVM TokenNetwork contract)
  // merged on top. Both are keyed by the same chain ids as `supportedChains`.
  const derivedParams = deriveChainSettlementParams(config.chainProviders);
  const tokenNetworks = { ...derivedParams.tokenNetworks, ...(runtimeTokenNetworks ?? {}) };
  const preferredTokens = derivedParams.preferredTokens;

  const routes = resolveRouteHints(config.routes, selfAnnounce.routes, config.children, apex);

  // Link-state block (toon-meta#153): own locally-delivered prefixes (cost 0)
  // + the Nostr pubkeys of configured peers, when known. Content ride-along.
  const routing = buildRoutingInfo(config);

  // Capability directory (toon-meta#153): the general form of the legacy
  // `routes` hints. Emitted ALONGSIDE them — deployed consumers still parse
  // the hints, new consumers read the directory. Content ride-along.
  const capabilities = buildCapabilityDirectory(config, selfAnnounce, warn);

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
    ...(Object.keys(tokenNetworks).length > 0 ? { tokenNetworks } : {}),
    ...(Object.keys(preferredTokens).length > 0 ? { preferredTokens } : {}),
    ...(routing ? { routing } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    routes,
  };

  return info;
}
