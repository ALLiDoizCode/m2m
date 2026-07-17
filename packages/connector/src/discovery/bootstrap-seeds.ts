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
 * nothing usable. Real, operated devnet endpoint(s); every entry is
 * probe-verified before being trusted (see `BootstrapService`).
 *
 * Deliberately a single devnet relay for now: a short honest list beats a
 * plausible-looking fake one (connector#289). Production/mainnet relay seeds
 * are future work, tracked alongside the production registry (issue #343
 * scoped this to devnet-real v0).
 */
export const FALLBACK_RELAY_SEEDS: readonly RelaySeed[] = [
  { relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev' },
];

/**
 * Devnet curator pubkey (BIP-340 x-only, 64-char lowercase hex) used to
 * verify the curated seed-registry manifest when `bootstrap.curatorPubkey` is
 * not pinned in config. This is the REAL v0 devnet curator key: the committed
 * manifest at `infra/linode-node/seeds/relays.json` is signed by it (see
 * `scripts/sign-seed-manifest.mjs` for the rotation tooling; the secret lives
 * outside the repo under `~/.toon-curator/`). Operators should still pin
 * `bootstrap.curatorPubkey` explicitly in config — config always wins over
 * this fallback. A production/mainnet curator key (with hardened custody) is
 * future work and will land with the production registry.
 */
export const FALLBACK_CURATOR_PUBKEY =
  '0342e0b25c7b41cbc36ec3b350bcecf378a386fec7a3c2d49e1dd0de1b1d735a';
