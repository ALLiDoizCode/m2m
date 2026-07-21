/**
 * kind:10032 `IlpPeerInfo` announcement builder (relay#37 / store#22).
 *
 * This is a deliberately MINIMAL, byte-for-byte mirror of
 * `@toon-protocol/core`'s `buildIlpPeerInfoEvent` + `IlpPeerInfo` wire type.
 *
 * Why a local mirror instead of importing from `@toon-protocol/core`?
 * The connector intentionally does NOT depend on `@toon-protocol/core`:
 * - `@toon-protocol/core@1.5.0` declares a `peerDependencies` entry on
 *   `@toon-protocol/connector` (a CIRCULAR dependency back onto this repo).
 * - It pins `@noble/hashes@^2` / `@scure/*@^2`, which conflict with this
 *   connector's `@noble@^1` tree — the exact conflict documented in
 *   `../wallet/mnemonic-keys.ts` (which re-implements key derivation for the
 *   same reason).
 * - It pulls a heavy, settlement-irrelevant transitive tree
 *   (`@ardrive/turbo-sdk`, `arweave`, `simple-git`).
 *
 * So, mirroring `mnemonic-keys.ts`'s precedent, we replicate just the tiny
 * kind:10032 builder here using `nostr-tools` (already a connector dependency,
 * the SAME `nostr-tools@^2.20.0` core uses), producing an identical signed
 * event. The wire format is: `kind: 10032`, `content: JSON.stringify(info)`,
 * an optional NIP-40 `["expiration", <unix>]` tag, signed via
 * `finalizeEvent`. Extra content fields (e.g. route hints) ride along inside
 * the JSON-stringified content WITHOUT any wire-type change — exactly as core
 * behaves (issue requirement: route hints go in CONTENT, not the wire type).
 *
 * @module discovery/ilp-peer-info-event
 */

import { finalizeEvent, type NostrEvent } from 'nostr-tools';
import { isValidILPAddress } from '@toon-protocol/shared';

/** kind:10032 — replaceable (10000-19999) ILP peer info announcement. */
export const ILP_PEER_INFO_KIND = 10032;

/** NIP-40 expiration tag name. */
export const EXPIRATION_TAG = 'expiration';

/**
 * A single reachable-prefix advertisement inside {@link IlpRoutingInfo}.
 */
export interface IlpRoutingPrefix {
  /** ILP address prefix this announcer can deliver locally (e.g. `g.proxy.relay`). */
  prefix: string;
  /**
   * Non-negative delivery cost for this prefix at the announcing node. Omitted
   * means `0` (a locally-terminated apex route). Consumers add per-hop costs on
   * top when computing multi-hop paths.
   */
  cost?: number;
}

/**
 * Link-state block carried inside the kind:10032 content (toon-meta#153).
 *
 * Rides along in the JSON-stringified content exactly like the `routes` hints —
 * NOT a wire-type change, fully optional and backward-compatible (parsers that
 * don't know the field ignore it; `parseRoutingInfo` never throws on garbage).
 */
export interface IlpRoutingInfo {
  /** Prefixes this node can deliver, with optional non-negative cost (default 0). */
  prefixes: IlpRoutingPrefix[];
  /**
   * Nostr pubkeys (64-char lowercase hex, x-only secp256k1) of this node's
   * direct ILP neighbors. Only neighbors whose pubkey is KNOWN are listed.
   */
  adjacency: string[];
}

/** 64-char lowercase-hex x-only pubkey (a Nostr pubkey). */
const NOSTR_PUBKEY_RE = /^[0-9a-f]{64}$/;

/**
 * Defensively parse the optional `routing` link-state block out of a
 * kind:10032 content object produced by SOMEONE ELSE.
 *
 * Never throws: any malformed shape returns `null`; malformed individual
 * entries (a non-string prefix, a negative cost, a non-hex adjacency entry)
 * are dropped while the well-formed remainder is kept. Prefix values are only
 * shape-checked here (non-empty string) — ILP-address validity is enforced at
 * route-install time by the routing table.
 *
 * @param content - The parsed (JSON) content of a kind:10032 event.
 * @returns The sanitized routing block, or `null` when absent/unusable.
 */
export function parseRoutingInfo(content: unknown): IlpRoutingInfo | null {
  if (!content || typeof content !== 'object') return null;
  const routing = (content as Record<string, unknown>).routing;
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) return null;

  const raw = routing as Record<string, unknown>;
  if (!Array.isArray(raw.prefixes) || !Array.isArray(raw.adjacency)) return null;

  const prefixes: IlpRoutingPrefix[] = [];
  for (const entry of raw.prefixes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { prefix, cost } = entry as Record<string, unknown>;
    if (typeof prefix !== 'string' || prefix.length === 0) continue;
    if (cost === undefined) {
      prefixes.push({ prefix });
    } else if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
      prefixes.push({ prefix, cost });
    }
    // A present-but-invalid cost drops the entry (cannot trust its metric).
  }

  const adjacency: string[] = [];
  for (const entry of raw.adjacency) {
    if (typeof entry === 'string' && NOSTR_PUBKEY_RE.test(entry)) {
      adjacency.push(entry);
    }
  }

  return { prefixes, adjacency };
}

/**
 * A single capability advertisement inside the kind:10032 `capabilities`
 * directory (toon-meta#153, connector-control-plane.md §4).
 *
 * Capabilities live in an open `os.<capability>` namespace with a closed
 * standardized core (`os.put`, `os.get`, `os.send`, `os.transfer`, `os.swap`,
 * `os.run`). The relay is the control plane mapping capability → address; the
 * resolved `address` is an ordinary routable ILP prefix, so from the data
 * plane's perspective a capability lookup never happened — ILP stays
 * address-only.
 */
export interface IlpCapabilityEntry {
  /**
   * Namespaced capability name — a human handle like `os.put` or any
   * `os.<name>` (the namespace is open; pay-to-write is the Sybil brake).
   * Bare names (no `os.` prefix, e.g. `nostr-relay`) are allowed for
   * forward-compat but the `os.*` namespace is the documented convention.
   * Names are case-insensitive handles and are normalized to lowercase both
   * when announced and when parsed (see {@link normalizeCapabilityName}).
   */
  capability: string;
  /** Flat, routable ILP address where the capability is served (the plane bridge). */
  address: string;
  /** Optional price to invoke (atomic units, non-negative decimal string). */
  price?: string;
  /**
   * Optional content address / URI of the capability's interface descriptor
   * (e.g. `sha256:ab01…`). Names are for humans; hashes are for binding — two
   * providers advertising the same descriptor hash are interchangeable.
   */
  schema?: string;
}

/**
 * Capability name grammar: a dot-namespaced handle (`os.put`, `os.my-thing`)
 * or a bare label (`nostr-relay`) — alphanumeric start, then alphanumerics,
 * `.`, `_`, `-`. Case-insensitive; names normalize to lowercase.
 */
export const CAPABILITY_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** Non-negative decimal price string (atomic units) — mirrors route `price`. */
const CAPABILITY_PRICE_RE = /^\d+$/;

/**
 * Normalize a capability name: trim + lowercase. Returns `null` when the
 * result does not satisfy {@link CAPABILITY_NAME_PATTERN} (names are
 * case-insensitive human handles; the canonical wire form is lowercase).
 *
 * @param name - The raw capability name.
 * @returns The normalized (lowercase) name, or `null` when malformed.
 */
export function normalizeCapabilityName(name: string): string | null {
  const normalized = name.trim().toLowerCase();
  return CAPABILITY_NAME_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Defensively parse the optional `capabilities` directory out of a kind:10032
 * content object produced by SOMEONE ELSE (toon-meta#153).
 *
 * Never throws, mirroring {@link parseRoutingInfo}: an absent or structurally
 * unusable block returns `[]`; malformed individual entries are dropped while
 * the well-formed remainder is kept (one bad entry never discards the whole
 * directory). Per entry:
 * - `capability` must be a string satisfying {@link CAPABILITY_NAME_PATTERN}
 *   (normalized to lowercase in the result);
 * - `address` must be a valid ILP address (`isValidILPAddress`);
 * - `price`, when present, must be a non-negative decimal string;
 * - `schema`, when present, must be a non-empty string.
 * A present-but-invalid optional field drops the entry (its terms cannot be
 * trusted), exactly like `parseRoutingInfo` treats an invalid `cost`.
 *
 * @param content - The parsed (JSON) content of a kind:10032 event.
 * @returns The sanitized capability entries (possibly empty), announcer order.
 */
export function parseCapabilityDirectory(content: unknown): IlpCapabilityEntry[] {
  if (!content || typeof content !== 'object') return [];
  const capabilities = (content as Record<string, unknown>).capabilities;
  if (!Array.isArray(capabilities)) return [];

  const entries: IlpCapabilityEntry[] = [];
  for (const entry of capabilities) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { capability, address, price, schema } = entry as Record<string, unknown>;

    if (typeof capability !== 'string') continue;
    const name = normalizeCapabilityName(capability);
    if (name === null) continue;

    if (typeof address !== 'string' || !isValidILPAddress(address)) continue;

    if (price !== undefined && (typeof price !== 'string' || !CAPABILITY_PRICE_RE.test(price))) {
      continue;
    }
    if (schema !== undefined && (typeof schema !== 'string' || schema.length === 0)) {
      continue;
    }

    entries.push({
      capability: name,
      address,
      ...(price !== undefined ? { price } : {}),
      ...(schema !== undefined ? { schema } : {}),
    });
  }
  return entries;
}

/**
 * ILP Peer Info — the kind:10032 content payload.
 *
 * Mirror of `@toon-protocol/core`'s `IlpPeerInfo` (subset used by the
 * connector's self-announce). Only the fields the connector populates are
 * declared; the index signature lets out-of-band content fields (e.g.
 * `routes`) ride along in the JSON content without a wire-type change.
 */
export interface IlpPeerInfo {
  /** Nostr pubkey of the peer (64-char hex). Optional; consumers can read `event.pubkey`. */
  pubkey?: string;
  /** Primary ILP address of the peer's connector (e.g. `g.proxy.relay`). */
  ilpAddress: string;
  /** All ILP addresses of this peer (one per terminated route). Defaults to `[ilpAddress]`. */
  ilpAddresses?: string[];
  /** BTP WebSocket endpoint URL for packet exchange (pay-per-event writes). */
  btpEndpoint: string;
  /** ILP-over-HTTP ingress URL (RFC-0035) for stateless one-shot writes. */
  httpEndpoint?: string;
  /** Public Nostr relay WS URL for FREE reads. */
  relayUrl?: string;
  /** Asset code for the peering relationship (e.g. `USDC`). */
  assetCode: string;
  /** Asset scale — number of decimal places (e.g. 6 for USDC). */
  assetScale: number;
  /** Supported settlement chain identifiers (e.g. `["evm:31337"]`). */
  supportedChains?: string[];
  /**
   * Maps chain identifier → the peer's settlement address on that chain. Keys
   * MUST be fully-qualified 2–3 segment chain ids (`evm:31337`, never bare
   * `evm`) and members of `supportedChains` when that field is present — core's
   * `parseIlpPeerInfo` rejects the whole event otherwise (#289).
   */
  settlementAddresses?: Record<string, string>;
  /**
   * Maps chain identifier → the settlement-contract address a client needs to
   * open a payment channel on that chain: the TokenNetwork contract on EVM
   * chains, the payment-channel PROGRAM id on Solana chains, and the payment
   * channel zkApp address on Mina chains. Keyed by the same fully-qualified
   * chain ids as `supportedChains`. (Core's published parser only requires an
   * object here; keys mirror `supportedChains` for consistency.)
   */
  tokenNetworks?: Record<string, string>;
  /**
   * Maps chain identifier → preferred token contract address: the ERC-20 token
   * on EVM chains, the SPL token MINT on Solana chains, and the token-owner
   * zkApp address on Mina chains.
   */
  preferredTokens?: Record<string, string>;
  /**
   * Out-of-band content ride-along: chain identifier → Mina token id (decimal
   * string) the payment channel opens on. The channel zkApp already rides
   * `tokenNetworks`; the fungible-token id is deployment-specific and has no
   * home in core's kind:10032 wire schema, so it is advertised here. A
   * standalone client derives its `minaChannel.tokenId` from this map. Absent
   * for native-MINA settlement.
   */
  minaTokenIds?: Record<string, string>;
  /**
   * Out-of-band content ride-along: chain identifier → JSON-RPC / GraphQL
   * endpoint the deployment KNOWS works. Lets a fresh client prefer the
   * deployment's own RPC over core's baked per-chain preset default (which can
   * be a stale/broken endpoint — e.g. Base Sepolia's `sepolia.base.org` LB
   * fails openChannel→setTotalDeposit).
   */
  chainRpcUrls?: Record<string, string>;
  /**
   * Optional link-state block (toon-meta#153): the prefixes this node can
   * deliver plus the Nostr pubkeys of its direct neighbors, consumed by peers'
   * route-learning services to compute multi-hop routes. Backward-compatible
   * content ride-along, never a wire-type change.
   */
  routing?: IlpRoutingInfo;
  /**
   * Optional capability directory (toon-meta#153, connector-control-plane.md
   * §4.3): how this node advertises capabilities in the open `os.<capability>`
   * namespace. The legacy `routes: { publish, store }` hints are the
   * degenerate two-entry case and are still emitted alongside for deployed
   * consumers. Backward-compatible content ride-along, never a wire-type
   * change; absent block = no capabilities.
   */
  capabilities?: IlpCapabilityEntry[];
  /** Allow out-of-band content fields (e.g. `routes`) to ride along in content. */
  [key: string]: unknown;
}

/** Options controlling how a kind:10032 announcement event is built. */
export interface BuildIlpPeerInfoOptions {
  /**
   * NIP-40 time-to-live, in seconds. When positive, the event carries an
   * `["expiration", created_at + ttlSeconds]` tag so a stale announcement from
   * an offline apex expires instead of lingering forever. Omit (or pass a
   * non-positive value) for a non-expiring event.
   */
  ttlSeconds?: number;
}

/**
 * Build and sign a kind:10032 Nostr event from `IlpPeerInfo` data.
 *
 * Byte-compatible with `@toon-protocol/core`'s `buildIlpPeerInfoEvent`:
 * `content` is `JSON.stringify(info)`, an optional NIP-40 `expiration` tag is
 * appended, and the event is signed with `finalizeEvent` (which sets `id`,
 * `pubkey`, `sig`, and computes `created_at`-bound serialization).
 *
 * @param info - The ILP peer info to serialize into the event content.
 * @param secretKey - The 32-byte Nostr secret key to sign with (NIP-06 key).
 * @param options - Optional build options (e.g. a NIP-40 `ttlSeconds`).
 * @returns A signed Nostr event.
 */
export function buildIlpPeerInfoEvent(
  info: IlpPeerInfo,
  secretKey: Uint8Array,
  options: BuildIlpPeerInfoOptions = {}
): NostrEvent {
  const createdAt = Math.floor(Date.now() / 1000);
  const tags: string[][] = [];
  if (options.ttlSeconds !== undefined && options.ttlSeconds > 0) {
    tags.push([EXPIRATION_TAG, String(createdAt + Math.floor(options.ttlSeconds))]);
  }

  return finalizeEvent(
    {
      kind: ILP_PEER_INFO_KIND,
      content: JSON.stringify(info),
      tags,
      created_at: createdAt,
    },
    secretKey
  );
}
