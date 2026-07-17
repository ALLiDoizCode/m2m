/**
 * Hardcoded relay-seed fallback for cold-start bootstrap (toon-meta#153).
 *
 * Everything in the TOON network is discovered THROUGH a relay (kind:10032
 * `IlpPeerInfo` announcements), but a cold node needs an out-of-band seed to
 * reach its FIRST relay. The bootstrap resolution order is:
 *
 *   1. curated signed registry (`bootstrap.registryUrl`, refreshable data)
 *   2. persisted learned-peer cache (previous runs' verified relays)
 *   3. operator-configured seeds (`bootstrap.seeds`)
 *   4. **this list — the fallback of last resort**
 *
 * This constant exists ONLY so a brand-new node with no registry reachability,
 * no cache, and no config can still find one relay to sample-and-verify
 * against. It is intentionally tiny and MUST NOT grow into a de-facto
 * registry: connector#289 (a stale committed genesis-peer seed silently
 * poisoning discovery) is exactly the failure mode this design avoids by
 * making seeds refreshable data (registry + cache) rather than frozen config.
 * Every entry here is re-verified by the sample-and-verify probe before it is
 * trusted — nothing in this list is assumed live.
 *
 * @module discovery/bootstrap-seeds
 */

/**
 * A single out-of-band relay seed: the Nostr relay WS URL to bootstrap from,
 * and optionally the relay operator's Nostr pubkey (64-char lowercase hex) for
 * callers that want to pin the identity behind the endpoint.
 */
export interface RelaySeed {
  /** Nostr relay WebSocket URL (`wss://…`, `ws://…` allowed for local dev). */
  relayUrl: string;
  /** Optional relay operator Nostr pubkey (64-char lowercase hex). */
  pubkey?: string;
}

/**
 * FALLBACK OF LAST RESORT — well-known TOON relay seeds, tried only when the
 * signed registry, the learned-peer cache, and `bootstrap.seeds` all produced
 * nothing usable. Placeholder devnet/mainnet endpoints; every entry is
 * probe-verified before being trusted (see `BootstrapService`).
 */
export const FALLBACK_RELAY_SEEDS: readonly RelaySeed[] = [
  { relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev' },
  { relayUrl: 'wss://relay-ws-2.devnet.toonprotocol.dev' },
  { relayUrl: 'wss://relay-ws.toonprotocol.dev' },
];

/**
 * PLACEHOLDER curator pubkey (BIP-340 x-only, 64-char lowercase hex) used to
 * verify the curated seed-registry manifest when `bootstrap.curatorPubkey` is
 * not pinned in config. This value is NOT a real key: no genuine manifest will
 * verify against it, so operators consuming a real registry MUST pin the real
 * curator key via `bootstrap.curatorPubkey`. Replace before shipping a real
 * curated registry for v0 devnet.
 */
export const FALLBACK_CURATOR_PUBKEY =
  'c07a4e778ad24f0c8b48cd8ee63c2d7d1ab6a6f6f52c2f5f7a90d5f0ffb0000f';
