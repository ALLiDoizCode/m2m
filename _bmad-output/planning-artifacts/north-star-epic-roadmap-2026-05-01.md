# North-Star Epic Roadmap — Epics 38–42

**Date:** 2026-05-01
**Author:** Jonathan (with BMAD multi-agent roundtable)
**Status:** Draft — proposed for sequencing
**Related artifacts:** `connector-north-star-2026-05-01.md` (north star), `connector-directives-ilp-as-tcp-2026-05-01.md` (Tier 1 spec), `technical-http-sigs-webauthn-nostr-research-2026-05-01.md` (Tier 2 research), `technical-tor-onion-routing-research-2026-04-13.md` (ATOR transport research)

---

## Purpose

Translate the north-star goal into shippable epics. The north star (`connector-north-star-2026-05-01.md`) defines the destination; this roadmap defines the units of work that get there. Each epic is sized to fit the existing connector epic conventions (32–37) and is intended to be expanded into a full epic doc + test-design pair as it enters delivery.

The user's explicit asks were two: (a) epics that move the project toward the north star, and (b) an epic for ILP over HTTP. Both are covered below — ILP over HTTP is Epic 38 because it is on the critical path for Tier 1, Tier 2, and the eventual home-hosting acceptance test.

---

## North-star tier mapping

| Tier | What it cashes out to | Existing work | New epics |
|---|---|---|---|
| T1 — Mechanical | Local delivery pipeline (any HTTP service is a TOON node) | Directives doc spec | **38** + **39** |
| T2 — Architectural | One passkey, native signers per level | Research doc | **40** (depends on **38**) |
| T3 — Strategic | Paid home hosting end-to-end | Epic 35 (ATOR shipping) | **41** + **42** |

Three of the five new epics (38, 39, 40) directly build pipeline; two (41, 42) wire the pipeline to the home-hosting use case so the binary acceptance test in the north star can return "yes."

---

## Epic 38 — ILP-over-HTTP Transport + RFC 9421 Message Signatures

**Goal.** Add ILP-over-HTTP (RFC 0035) as a peer transport alongside the existing BTP-over-WebSocket, and sign every connector HTTP surface (admin API, peer-to-peer ILP-over-HTTP, connector→app local delivery) with RFC 9421 HTTP Message Signatures.

**Why this comes first.** Three downstream things need it: (a) the Tier 1 connector→app envelope wants signed delivery so unauthorized apps can't be spoofed; (b) the Tier 2 passkey-PRF derivation tree only matters once an HTTP-Sig key is consuming derived material; (c) home-hosted nodes peering over `.anon` addresses need message-level auth that survives the ATOR circuit re-termination.

**Dependencies.** Epic 35 (ATOR transport provider abstraction — used for the HTTP agent swap on outbound ILP-over-HTTP).

**Scope (in).**
- New peer transport: ILP-over-HTTP per RFC 0035, layered on the existing `TransportProvider` abstraction so it composes with `DirectTransport` and `SocksTransport`.
- RFC 9421 signer + verifier middleware (Hono-based, WinterCG-aligned per the research §3).
- `keyid` = RFC 7638 JWK SHA-256 thumbprint convention; algorithm allowlist (`ed25519`, `ecdsa-p256-sha256`).
- JWKS publication at `/.well-known/http-message-signatures-directory` (Meunier draft-05).
- Hybrid signing key tier: KMS-held org identity signs JWKS metadata; per-instance ephemerals sign actual requests (research §"Key-rotation architecture").
- Replay cache: bloom-filter front + Redis (or in-memory for single-instance), `(keyid, nonce)` keyed, ±60s clock-skew tolerance.
- `Content-Digest` (RFC 9530) over JCS-canonicalised JSON (RFC 8785) for bodied requests; raw bytes pre-parser to avoid re-encoding drift.
- Signing applied across three surfaces: admin API, peer ILP-over-HTTP egress, connector→app delivery.
- Migration: existing bearer/mTLS auth remains as a fallback during a soak window, configurable per-peer.

**Scope (out).**
- secp256k1 / Schnorr / `schnorr-secp256k1` algorithms (IANA gap; tracked separately as Phase 3 contribution).
- Passkey-derived signing keys (Epic 40 supplies these; Epic 38 supports any registered RFC 9421 algorithm including KMS-managed Ed25519).
- BTP-over-WebSocket signing changes; BTP claims continue to use the existing claim-signature path at the application layer.

**Exit gate.**
- One peer pair runs end-to-end on RFC 0035 ILP-over-HTTP with RFC 9421 signatures on every request.
- Admin API authenticates connector operators via signed-HTTP (passkey-login wired separately, Epic 40).
- Connector→app local delivery POSTs are signed; v2 envelope (per directives doc) is the body.
- RFC 9421 §B golden vectors green in vitest; nightly HTTP-surface CI extended to include the new surfaces.
- Stop-the-line policy applies to the new surfaces.

**Story sketch (~10–12 stories).**
1. RFC 0035 ILP-over-HTTP peer transport (`HttpPeerTransport` extending `TransportProvider`).
2. RFC 9421 signer module (`packages/connector/src/auth/rfc9421/sign.ts`).
3. RFC 9421 verifier middleware (`packages/connector/src/auth/rfc9421/verify.ts`).
4. JWKS provider + `/.well-known/http-message-signatures-directory` route.
5. KMS integration for org-tier key (extends existing key-rotation-manager).
6. Per-instance ephemeral key generator + JWKS metadata signer.
7. Replay cache: in-memory bloom + Redis-backed regional cache.
8. `Content-Digest` integration; raw-body capture before JSON parser.
9. Algorithm allowlist + clock-skew enforcement.
10. Apply to admin API; deprecate bearer (configurable rollback).
11. Apply to peer ILP-over-HTTP egress.
12. Apply to connector→app local delivery (consumes Epic 39's v2 envelope).

**Risks.**
- Gateway header rewrites breaking covered-component validation (research §"Integration Challenges" #1). Mitigation: sign only headers gateway is contractually stable on; prefer `@authority` over `Host`.
- JCS canonicalisation drift between sender/receiver. Mitigation: vitest fixtures from RFC 8785; raw-bytes digest pre-parser.
- Replay cache exhaustion. Mitigation: bound cache; rate-limit per `keyid`.

**Test design.** Separate test-design doc (`test-design-epic-38.md`) — reuse the test-design template from epics 32–36. Negative-path matrix per the research §"Integration Challenges."

---

## Epic 39 — TOON Local Delivery Pipeline (Tier 1)

**Goal.** Implement the connector-directives doc as code. Make any HTTP service plus a `toon.json` a paid TOON node. Acceptance test: unmodified `strfry` runs as a TOON node with zero SDK imports.

**Why now.** This is the directives doc materialised. The spec is settled; what's needed is execution.

**Dependencies.** None hard-blocking. Composes well with Epic 38 (the v2 envelope ships under RFC 9421 in Epic 38) but can ship behind a feature flag without it.

**Scope (in).**
- Schema + storage migration: `local_delivery_nonces` table per directives §1 Override 2.
- `toon-config-provider.ts` with `fs.watch` + `snapshot()` API (gap 1 / hot reload).
- `toon-config-schema.ts`: strict zod, no `byKind` in v1.
- `toon-event-verifier.ts`: Schnorr verify isolated for unit testing.
- `nonce-store.ts`: three-phase commit (Phase 1 reserve → Phase 2 HTTP POST off lock → Phase 3 commit), idempotent replay returns `(status, empty body)` only.
- `nonce-store-pruner.ts`: 60-second sweep for in-flight reap + `dedupTtlSeconds` (default 300, range 60–3600).
- `pricing.ts`: full event JSON byte length per directives §1 Override 5; single-rate v1.
- `payment-headers.ts`: `X-TOON-*` header builder.
- `LocalDeliveryClient` extension: `accept_from` allowlist check, Schnorr verify, dedup-aware nonce check, pricing gate, `envelope: 'toon-event'` mode behind config flag.
- Embedded handler bypass (`setPacketHandler`) gets the same pre-stages; pipeline is the contract regardless of transport.
- Admin API extension for Override 7: `GET /admin/api/nodes/:pubkey/channels` (chain inference from `SettlementCoordinator`).

**Scope (out).**
- v1→v2 envelope auto-migration; v1 stays default until telemetry shows >90% v2 adoption.
- `byKind` tiered pricing; reserved for v2.
- Reference app implementation (Townhouse owns).

**Exit gate.**
- `acceptance.strfry.spec.ts`: unmodified `strfry` container, `toon.json`, zero SDK imports → ILP PREPARE → FULFILL with EVM settlement crossing threshold via `SettlementMonitor`.
- `nonce-store.concurrency.spec.ts` proves no global write lock (50 PREPAREs across 5 pubkeys complete in ~slowest-post-time + 100ms).
- Hot-reload, idempotency, TTL, crash-recovery tests all green.
- Acceptance test goes into nightly HTTP-surface CI from sprint 1.

**Story sketch (~12–14 stories).** One per file in directives §3 final file breakdown plus the acceptance test.

**Risks.** All material risks already identified in the directives doc §1 Overrides. SQLite-lock-across-HTTP is the largest; three-phase commit mitigates.

**Test design.** `test-design-epic-39.md`. Mock-free per `CLAUDE.md`; tests run against real chain containers via `make infra-up`.

---

## Epic 40 — Passkey-PRF Identity Root (Tier 2)

**Goal.** One passkey ceremony, processed through WebAuthn PRF + HKDF, deterministically derives every signing key the operator and connector need. No seed phrase typed by the operator; recovery via ≥2 passkeys at registration.

**Why this comes after 38.** The PRF-derived Ed25519 key is the *consumer* of the RFC 9421 signing surface. Epic 38 ships RFC 9421 with KMS-managed keys; Epic 40 swaps in passkey-derived keys as the default identity root for new operator registrations.

**Dependencies.** Epic 38 (RFC 9421 surface to consume the derived Ed25519 key). Soft dep on Epic 39 (the operator UI for registering a passkey is the same admin surface signed by Epic 38).

**Scope (in).**
- WebAuthn registration flow (SimpleWebAuthn v13.x): `create()` with PRF extension request; persist credential + `prf.salt`.
- Server-side PRF salt provisioning + storage (encrypted at rest).
- HKDF derivation tree: domain-separated `info` strings per derived key. Six derivations per the north-star Tier 2:
  - `info: "rfc9421/ed25519/v1"` → admin/peer/app HTTP-Sig
  - `info: "btp/secp256k1/v1"` → BTP claim signing
  - `info: "evm/secp256k1/v1"` → EVM settlement
  - `info: "solana/ed25519/v1"` → Solana settlement
  - `info: "mina/pallas-schnorr/v1"` → Mina settlement
  - `info: "nostr/secp256k1-schnorr/v1"` → Nostr event signing
- ≥2 passkeys at registration enforced (recovery principle P-7); seed-phrase fallback path shipped from day one.
- FIDO MDS3 service: weekly AAGUID validation, shared service (not per-process).
- Wire derived keys into existing flows: HTTP-Sig client (Epic 38), BTP claim signer (existing), settlement signers (existing per chain), Nostr event signer (Epic 41 / new).
- Admin UI: "register passkey" replaces "paste seed phrase" for new operator onboarding; existing operators get a migration path.

**Scope (out).**
- Architecture C (Nostr-key-as-RFC-9421-keyid). Separate Phase-3 standards-track contribution; not on this epic.
- Passkey portability cross-vendor (FIDO CXP/CXF still slipping; out of v1 scope).
- ML-DSA / PQ derivation. Tracked in Phase 4.

**Exit gate.**
- New operator runs `connector init`, registers a passkey + recovery passkey, sees all six derived keys provisioned without typing or copying any secret material.
- Settlement transactions on EVM/Solana/Mina sign with derived keys and confirm on-chain.
- Migration test: an existing operator with seed-phrase identity converts to passkey; old keys remain valid for the migration window.
- Recovery drill: device-lost simulation; second passkey unlocks all derivations.

**Story sketch (~10–12 stories).**
1. WebAuthn RP setup + SimpleWebAuthn integration.
2. PRF extension request + result handling on `create()` and `get()`.
3. Server-side PRF salt provisioning + at-rest encryption.
4. HKDF derivation library with domain-separated `info`.
5. Derived-key encrypted-at-rest storage (NIP-49-style ncryptsec1 wrapper, reusing `nip59-claim-wrapper.ts` patterns).
6. ≥2 passkey enforcement + recovery passkey UI.
7. Seed-phrase fallback (BIP-39) for users opting out of passkey-only.
8. FIDO MDS3 weekly-refresh service.
9. Wire derived Ed25519 into RFC 9421 client (Epic 38 hook).
10. Wire derived secp256k1 into BTP claim signer.
11. Wire derived chain keys into settlement signers (one story per chain).
12. Operator migration: seed-phrase → passkey-PRF.

**Risks.**
- PRF data-loss on single-credential users (research risk register, "Catastrophic"). Mitigation: enforce ≥2 credentials at registration.
- Edge runtime gap on secp256k1 (Cloudflare Workers, Vercel Edge). Mitigation: the connector runs on Node.js, not edge runtimes; admin UI does only client-side derivation.
- PRF-on-create not always available. Mitigation: register-then-immediately-authenticate flow per research.

**Test design.** `test-design-epic-40.md`. Chrome DevTools Protocol `WebAuthn.addVirtualAuthenticator` for passkey ceremonies in CI per research §3.

---

## Epic 41 — TownHub Discovery via Nostr (Tier 3 wiring)

**Goal.** Connector publishes its own node availability as kind:30400 Nostr events and consumes peer kind:30400 events to resolve ILP addresses to `.anon` URLs. Closes the discovery gap so a home-hosted node is reachable globally with no DNS, no IP, no centralised registry.

**Dependencies.** Epic 35 (ATOR `.anon` address provisioning), Epic 40 (operator's Nostr key derived from passkey-PRF).

**Scope (in).**
- Kind:30400 publisher: on connector start with `transport.type: "socks5"` + hidden service active, publish a kind:30400 event signed by operator's derived Nostr key. Event content: `.anon` URL, ILP address prefix, supported Nostr event kinds, pricing rate, settlement chain hints.
- Kind:30400 consumer: subscribe to TownHub relay set; resolve incoming ILP packets whose destination prefix doesn't match a directly-peered connector by querying the local kind:30400 cache.
- Cache invalidation: kind:30400 events are replaceable per NIP-33; cache honours `created_at` ordering.
- Reachability checks: probe `.anon` URLs from kind:30400 events; mark unhealthy peers as such; drop after configurable retry window.
- Operator UI: "discover available nodes" surface in admin dashboard (consumes the same kind:30400 cache).
- Relay configuration: operator-specifiable relay set; sensible defaults; per-relay backoff on failure.

**Scope (out).**
- Authoritative kind registration as a NIP. Townhouse owns the NIP authoring; connector consumes whatever ships.
- Settlement-attestation receipts (separate kind, separate epic if pursued; research §"NIP-57 zap precedent").
- Web-of-trust / reputation scoring on discovered nodes.

**Exit gate.**
- A connector behind NAT, started cold with no peer config, advertises itself as kind:30400, becomes discoverable from a second connector that also has no prior knowledge of it. Both peer over ATOR. ILP packets settle.
- Reachability probe correctly demotes unhealthy nodes within the configured window.
- Cache survives connector restart (persisted, not in-memory only).

**Story sketch (~6–8 stories).**
1. kind:30400 event schema + signing (uses Epic 40 Nostr key).
2. Publisher: emit on connector start + on `.anon` address change.
3. Consumer: relay subscription manager + persistent cache.
4. ILP-address-prefix → `.anon` URL resolver.
5. Reachability probe + health state machine.
6. Operator UI surface (admin dashboard).
7. Relay configuration + per-relay backoff.
8. Persistence + restart recovery.

**Risks.**
- Discovery centralisation if relay set is too narrow. Mitigation: operator-specifiable relays, default to a diverse set, per-relay backoff.
- Event spam / DOS via fake kind:30400. Mitigation: cap cache size; require valid Nostr signature; rank by recent observed reachability.

**Test design.** `test-design-epic-41.md`. Real Nostr relay containers via existing `make infra-up` extension.

---

## Epic 42 — Home-Hosting Acceptance End-to-End (the binary north-star test)

**Goal.** Compose Epics 35 + 38 + 39 + 40 + 41 into the single binary acceptance test from the north star: "a stranger, on a fresh laptop, with one passkey ceremony, deploys a docker container that becomes a paid TOON node receiving ILP packets, settling claims on three chains, signing everything with their own key, with no SDK code and no seed phrase to write down."

**Dependencies.** All four prior epics. This epic is the integration test, not new functionality.

**Scope (in).**
- Reference Pi-class deployment guide: `docs/operators/home-hosting.md`. Hardware shopping list, Docker Compose, ATOR + connector + reference app (strfry).
- End-to-end acceptance test in nightly HTTP-surface CI: containerised Pi-class environment (resource-limited Docker), unmodified strfry as the app, ATOR overlay, fresh passkey via virtual authenticator, ILP packet from a second connector, settlement on EVM (and ideally also Solana + Mina).
- Operator onboarding script: `connector home-init` walks through passkey registration, ATOR setup, kind:30400 publish, returns the `.anon` URL.
- Performance baseline: P50/P99 latency for the full path under representative load; published as a ratchet number.
- Rollback drill: simulate ATOR outage, app crash, passkey loss, connector restart — all should self-recover or fail safely.

**Scope (out).**
- Marketing / operator-recruitment activities.
- Hardware vendor partnerships.
- Custom Pi image / preconfigured SD card distribution.

**Exit gate.**
- The binary acceptance test from the north star answers "yes." Verified by the nightly CI run; verified by at least one external developer following `docs/operators/home-hosting.md` cold and reaching first-paid-packet within a documented time bound.

**Story sketch (~5–7 stories).**
1. Containerised Pi-class environment for CI (resource limits matching real Pi 4 / Pi 5).
2. End-to-end acceptance test: fresh passkey → ATOR up → strfry up → kind:30400 published → second-connector finds it → ILP packet settles on EVM.
3. Solana + Mina parity tests (deferrable to v2 if EVM-only is sufficient for v1 sign-off).
4. `connector home-init` operator script.
5. `docs/operators/home-hosting.md` reference deployment guide.
6. Performance baseline + ratchet metric in nightly CI.
7. Rollback drills (ATOR down, app crash, passkey loss).

**Risks.**
- Test takes too long to run nightly. Mitigation: parallelise; drop Solana/Mina from nightly if needed; keep them in weekly.
- Dependent epic slippage cascades. Mitigation: this epic ships last; its story is "wire what's already there."

**Test design.** `test-design-epic-42.md`. The acceptance test in this epic IS the test design — it's the load-bearing artifact.

---

## Sequencing

| Sprint window | Epics in flight | Notes |
|---|---|---|
| Sprint 1–2 | 38 (start), 39 (start) | Independent; can run in parallel. 39 ships v2 envelope; 38 wraps it in RFC 9421. |
| Sprint 3 | 38 (finish), 39 (finish), 40 (start) | 40 needs 38's RFC 9421 surface to plug derived Ed25519 in. |
| Sprint 4 | 40 (finish), 41 (start) | 41 needs 40's Nostr key derivation. |
| Sprint 5 | 41 (finish), 42 (full epic) | 42 is integration-only; ~1 sprint once dependencies are green. |

Total: ~5 sprints (~10 weeks at 2-week cadence) from current state to north-star binary acceptance test answering "yes." Slippage in any of 38/39/40 cascades to 42; 41 can shift independently because Townhouse does the NIP work in parallel.

Phase 3 contribution work (`schnorr-secp256k1` IANA registration) is **not** on this critical path. It's a deferred opportunity for Phase 3 of the north-star phased path; tracked as a community contribution, not a delivery sprint.

---

## What's NOT in this roadmap

To prevent scope creep at the planning level:

- **No new settlement chains.** EVM + Solana + Mina is the v1 set. New chains are separate epics gated on operator demand.
- **No mobile operator UX.** Admin runs on Node.js + browser; mobile is out of scope until passkey portability across iOS/Android stabilises (research §"long-term").
- **No DEX / swap integration.** Settlement runs on whatever chain the channel lives on; swap-and-settle is a future epic conditional on operator demand.
- **No managed-hosting offering.** The point is operators host themselves. A managed-hosting product is a separate go-to-market motion, not on this technical roadmap.

---

## Next steps

1. **Approve this roadmap.** Or push back on epic scope, dependencies, or sequencing before any individual epic gets expanded.
2. **Expand Epic 38 first.** Full epic doc + test-design pair, mirroring `epic-35-ator-overlay-transport.md` + `test-design-epic-35.md`. Target: 1 sprint of planning work to lock specs before code.
3. **Expand Epic 39 in parallel.** The directives doc supplies most of the content; this is mostly translation into epic format.
4. **Expand 40, 41, 42 as their predecessors near completion.** Each gets its own multi-agent roundtable and a paired test-design doc.
5. **Set up the binary north-star tracker.** A single dashboard line: "is the home-hosting acceptance test green?" — visible in admin UI from day one, even if it returns "no" until Epic 42 lands. Makes the goal radically observable.
