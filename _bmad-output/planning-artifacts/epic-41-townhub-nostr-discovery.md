# Epic 41: TownHub Discovery via Nostr

**Date:** 2026-05-01
**Author:** Jonathan (with BMAD multi-agent roundtable)
**Status:** Draft
**Dependencies:** Epic 35 (ATOR `.anon` address provisioning), Epic 40 (operator's Nostr key derived from passkey-PRF)
**Type:** Greenfield — new discovery layer
**North-star tier served:** T3 (strategic) — closes the discovery gap so home-hosted nodes are reachable globally with no DNS, no IP, no centralised registry
**Cross-team:** Townhouse owns the kind:30400 NIP authoring; connector consumes whatever ships

---

## Executive Summary

The connector publishes its own node availability as kind:30400 Nostr events and consumes peer kind:30400 events to resolve ILP addresses to `.anon` URLs. Without this epic, home-hosted nodes are reachable only by operators who already know each other; with it, any connector can discover any other connector via the open Nostr relay set.

### Why this epic exists

The other four epics (35, 38, 39, 40) build the substrate for paid home hosting but leave one gap: how does a stranger's connector find your home-hosted `.anon` node? DNS doesn't apply (no public IP, no domain). A centralised registry would defeat the decentralisation premise. Nostr's append-only event log via kind:30400 is the open answer — operators publish, peers consume, nothing centralises.

### What's being built

- Kind:30400 publisher: on connector start, publish a signed availability event including `.anon` URL, ILP address prefix, supported event kinds, pricing rate, settlement chain hints.
- Kind:30400 consumer: subscribe to operator-configured relay set; cache events; resolve incoming ILP packet destinations against the cache.
- Reachability probes: probe `.anon` URLs from cached events; demote unhealthy nodes within a configurable window.
- Operator UI surface: "discover available nodes" view in admin dashboard.
- Relay configuration: per-operator relay set; sensible defaults; per-relay backoff on failure.

### What's NOT being built

- The kind:30400 NIP itself — Townhouse authors; connector consumes.
- Settlement-attestation receipts (separate kind, separate epic if pursued; research §"NIP-57 zap precedent").
- Web-of-trust / reputation scoring on discovered nodes (deferred).
- Operator-pays-for-relay-bandwidth flow (out of v1 scope).

---

## Architecture

### Event flow

```
Connector A (home, behind NAT)
  │
  │ on startup with transport.type='socks5' + hidden service active:
  │
  ├─ Build kind:30400 event:
  │    {
  │      kind: 30400,
  │      pubkey: <operator's passkey-derived Nostr pubkey>,
  │      created_at: <unix>,
  │      tags: [
  │        ["d", "<connector-instance-id>"],
  │        ["url", "<base32>.anon"],
  │        ["ilp", "g.toon.us1.relay-abc"],
  │        ["kinds", "1,3,7"],
  │        ["price", "10", "msats_per_kb"],
  │        ["settle", "evm", "solana"],
  │        ["expires", "<unix+24h>"]
  │      ],
  │      content: "<optional human-readable description>",
  │      sig: <Schnorr sig from passkey-derived Nostr key>
  │    }
  │
  └─ Publish to configured relay set
              │
              ▼
          Nostr relays
              │
              ▼
Connector B (anywhere)
  │
  │ subscribes to kind:30400 events with tag filters
  │
  └─ Cache; resolve ILP-prefix → .anon URL on incoming packet
```

### Cache model

- Events are NIP-33 replaceable (kind 30000-39999): same `(pubkey, "d"-tag)` replaces older `created_at`.
- Cache: SQLite-backed for restart survival; keyed by `(pubkey, d_tag)`; ordered by `created_at`.
- TTL: respect `expires` tag if present; default 24h since `created_at`.
- Reachability state: `(pubkey, d_tag) → { lastProbeOk, lastProbeAt, consecutiveFailures }`.

### Resolution flow

```
Incoming ILP PREPARE
  │
  ▼
Routing table lookup (existing): direct peer? local? next hop?
  │
  ▼ (if no direct peer matches destination ILP prefix)
  │
  ▼
TownHub cache lookup:
  query: SELECT * FROM townhub_cache WHERE ilp_prefix MATCHES <dest> AND lastProbeOk = true
  ORDER BY created_at DESC LIMIT 1
  │
  ▼ (if hit)
  │
  ▼
Open ILP-over-HTTP connection to <url>.anon via SocksTransportProvider (Epic 35)
  Sign request with RFC 9421 (Epic 38)
  Settle on chain inferred from `settle` tag intersection (Epic 39 Override 7)
```

---

## Stories

### Story 41.1: kind:30400 event schema + builder

**Goal.** Define the kind:30400 event shape and build/sign events from connector state.

**AC.**
- AC1: Event schema documented in `docs/protocol/townhub-kind-30400.md`; matches Townhouse's NIP draft.
- AC2: Builder function `buildAvailabilityEvent(state: ConnectorState, key: NostrSecKey): NostrEvent` — pure, fully testable.
- AC3: Required tags: `d` (instance id), `url` (`.anon` URL), `ilp` (prefix), `kinds`, `price`.
- AC4: Optional tags: `settle` (chain hints), `expires`, `content` (description).
- AC5: Schnorr-signed via Epic 40's derived Nostr key (`info: "nostr/secp256k1-schnorr/v1"`).

**Files.** `packages/connector/src/discovery/townhub-event-builder.ts`, `.test.ts`.

**Dependencies.** Epic 40 Story 40.4 (HKDF tree provides Nostr secp256k1 key).

---

### Story 41.2: Publisher — emit on startup + on `.anon` change

**Goal.** Publish the connector's kind:30400 event on connector start, and re-publish whenever `.anon` URL changes (rare; usually ATOR keypair rotation).

**AC.**
- AC1: Triggered on connector start when `transport.type: "socks5"` AND hidden service active.
- AC2: Re-published on `.anon` URL change (detected via Epic 35's hidden service lifecycle).
- AC3: Re-published periodically: default every 12h, configurable via `discovery.refreshIntervalMs`.
- AC4: Published to all configured relays in parallel; per-relay failure logged but doesn't block.
- AC5: Publish failures don't prevent connector from serving traffic — degrades to "discoverable only by direct peers."

**Files.** `packages/connector/src/discovery/publisher.ts`, `.test.ts`.

**Dependencies.** Story 41.1.

---

### Story 41.3: Consumer — relay subscription manager

**Goal.** Subscribe to kind:30400 events from operator-configured relays.

**AC.**
- AC1: Uses `nostr-tools` v2.x as the relay client (already a transitive dep candidate).
- AC2: REQ subscription with filter `{ kinds: [30400] }`; configurable additional filters via operator config.
- AC3: Per-relay backoff: exponential with jitter; max 60s.
- AC4: Per-relay state visible in admin metrics.
- AC5: Graceful disconnection / reconnection handling.

**Files.** `packages/connector/src/discovery/relay-subscription-manager.ts`, `.test.ts`.

---

### Story 41.4: Cache — persistent storage + restart survival

**Goal.** SQLite-backed cache that survives connector restart; honours NIP-33 replacement semantics.

**AC.**
- AC1: New table `townhub_cache` with columns: `pubkey`, `d_tag`, `created_at`, `expires_at`, `event_json`, `last_probe_ok`, `last_probe_at`, `consecutive_failures`.
- AC2: Primary key `(pubkey, d_tag)`; replacement: insert with `ON CONFLICT DO UPDATE WHERE excluded.created_at > existing.created_at`.
- AC3: TTL pruning: rows where `expires_at < now()` deleted via background sweeper (60s cadence).
- AC4: Migration provided (up + down).
- AC5: Cache survives connector restart and is queryable immediately.

**Files.** `packages/connector/src/db/schema/townhub-cache.sql`, `packages/connector/src/discovery/cache.ts`.

---

### Story 41.5: ILP-prefix resolver

**Goal.** Resolve an incoming ILP packet's destination address against the cache when no direct peer matches.

**AC.**
- AC1: `resolve(destination: string): ResolvedNode | null` — longest-prefix match against cached `ilp` tags.
- AC2: Filters to `last_probe_ok = true` results only.
- AC3: Returns `{ pubkey, d_tag, anonUrl, supportedChains }` or null.
- AC4: Hooks into existing routing handler at the "no direct peer" fallback point.

**Files.** `packages/connector/src/discovery/resolver.ts`; edits to existing `packages/connector/src/routing/`.

**Dependencies.** Story 41.4.

---

### Story 41.6: Reachability probe + health state machine

**Goal.** Probe cached `.anon` URLs; demote unhealthy nodes; restore on recovery.

**AC.**
- AC1: Probe schedule: every 5 minutes per cached node; jittered to spread load.
- AC2: Probe is a lightweight `OPTIONS` or `GET /.well-known/toon-availability` against the `.anon` URL via SocksTransportProvider.
- AC3: Health state machine: `healthy ↔ degraded ↔ unhealthy`. Three consecutive failures → unhealthy; three consecutive successes → healthy.
- AC4: `last_probe_ok` reflects current state for resolver use.
- AC5: Probe failures logged at DEBUG (not WARN — discovery probes are noisy and routine).

**Files.** `packages/connector/src/discovery/reachability-probe.ts`, `.test.ts`.

---

### Story 41.7: Operator UI — "discover available nodes"

**Goal.** Admin dashboard surface listing discovered nodes from the cache; operator can manually peer with one.

**AC.**
- AC1: New admin endpoint `GET /admin/api/townhub/nodes` returning paginated cache contents.
- AC2: Filter by chain support, kinds served, health state, price range.
- AC3: "Peer with this node" action: adds to direct-peer config (existing capability) using the discovered `.anon` URL.
- AC4: Auth: same `X-Api-Key` (or RFC 9421 once Epic 38 lands).

**Files.** Edits to `packages/connector/src/admin/`; admin UI work.

**Dependencies.** Story 41.4.

---

### Story 41.8: Relay configuration + per-relay backoff

**Goal.** Operator-specifiable relay set with sensible defaults and resilient backoff.

**AC.**
- AC1: Config block `discovery.relays`: array of WebSocket URLs.
- AC2: Sensible defaults: 5–7 well-known Nostr relays (community-curated; documented in `docs/operators/townhub-discovery.md`).
- AC3: Per-relay state: connected, last-success, consecutive-failures.
- AC4: Per-relay backoff: exponential with jitter; capped at 60s.
- AC5: Operator UI shows per-relay state.

**Files.** `packages/connector/src/discovery/relay-config.ts`; doc update.

---

### Story 41.9: Discovery coexists with direct peering — opt-in/opt-out reversibility test

**Goal.** Verify that enabling discovery (`discovery.publish: true` or active subscription) does NOT break existing direct-peer configuration; that disabling it cleanly returns to direct-only mode; that a peer reachable both via direct-peer config AND via discovery resolves to a single identity (no duplicate routing entries).

**AC.**
- AC1: Test: connector with three direct peers configured + discovery off → all three peers reachable; no kind:30400 events published or consumed.
- AC2: Test: enable discovery on the same connector → all three direct peers still reachable; discovery cache populates; no routing conflicts.
- AC3: Test: a peer happens to also publish kind:30400 → resolver detects overlap with direct-peer config; uses direct config (more specific); discovery cache row is informational only.
- AC4: Test: disable discovery → discovery cache continues serving for active connections during graceful shutdown; new connections route only via direct config.
- AC5: Test: re-enable discovery → cache rebuilt from fresh subscription; previously-known nodes re-discovered.
- AC6: Migration telemetry: `connector.migration.flag.discovery_publish.{accept,reject,error}` per Epic 43 Story 43.1.

**Files.** `packages/connector/test/integration/discovery.coexistence.spec.ts`.

**Dependencies.** Stories 41.4, 41.5, 41.7. Epic 43 Story 43.1.

---

## Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Discovery centralisation if relay set is too narrow | Medium | Medium | Operator-specifiable relays; default to diverse set; per-relay backoff |
| Event spam / DOS via fake kind:30400 | Low | Low | Cap cache size; require valid Nostr signature; rank by recent observed reachability |
| `.anon` URL probes leak hosting hints | Low | Medium | Probes go through SocksTransportProvider — never clearnet |
| NIP not finalised when epic ships | Medium | Medium | Townhouse owns; coordinate cutover; v1 of kind:30400 is provisional pending NIP ratification |
| Operator privacy: publishing kind:30400 reveals connector exists | High | Low (intended behaviour) | Document in operator docs; opt-in via `discovery.publish: true` |

---

## Definition of Done

- Connector behind NAT, started cold with no peer config, advertises itself as kind:30400 and becomes discoverable from a second connector with no prior knowledge of it.
- Both connectors peer over ATOR; ILP packets settle.
- Reachability probe correctly demotes unhealthy nodes within configured window.
- Cache survives connector restart.
- Operator UI shows discovered nodes and allows manual peering.
- Operator docs cover: relay configuration, what gets published, privacy posture, opt-out.
- Townhouse confirms kind:30400 NIP ratification path.

## Estimated Total Effort

9 stories. Estimate range: 1.5–2 sprints (3–4 weeks at 2-week cadence) for a single dedicated engineer.

## Test design

Separate doc `test-design-epic-41.md` (TBD). Real Nostr relay containers via `make infra-up` extension; test fixtures for kind:30400 events.
