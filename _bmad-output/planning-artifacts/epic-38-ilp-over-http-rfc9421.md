# Epic 38: ILP-over-HTTP Transport + RFC 9421 HTTP Message Signatures

**Date:** 2026-05-01
**Author:** Jonathan (with BMAD multi-agent roundtable)
**Status:** Draft
**Dependencies:** Epic 35 (TransportProvider abstraction is the hook for HTTP peer transport agent swap)
**Type:** Greenfield — new peer transport + new authentication layer
**North-star tier served:** T1 (mechanical), unblocks T2 (passkey-PRF consumes RFC 9421 surface)
**Roadmap reference:** `north-star-epic-roadmap-2026-05-01.md`

---

## Executive Summary

Add ILP-over-HTTP (RFC 0035) as a peer transport alongside the existing BTP-over-WebSocket, and sign every connector HTTP surface — admin API, peer-to-peer ILP-over-HTTP, connector→app local delivery — with RFC 9421 HTTP Message Signatures. The result: cryptographically authenticated HTTP across the entire connector surface, gateway-survivable, audit-friendly, with a `keyid` convention that aligns with Cloudflare/SeatGeek/OpenAI deployments.

### Why this comes first

Three downstream things need it:

- **T1 (Local delivery):** the v2 envelope to the app wants signed delivery so unauthorized apps can't be spoofed and signed connector responses can't be forged.
- **T2 (Passkey-PRF):** the derived Ed25519 key from one passkey ceremony only matters once an HTTP-Sig consumer exists.
- **T3 (Home hosting):** nodes peering over ATOR `.anon` addresses need message-level auth that survives circuit re-termination — mTLS spans one TCP connection; RFC 9421 spans the application boundary.

### What's being built

- Peer transport: ILP-over-HTTP (RFC 0035) layered on existing `TransportProvider` abstraction so it composes cleanly with `DirectTransport` and `SocksTransport`.
- RFC 9421 signer + verifier middleware (Hono-based, WinterCG-aligned per research §3).
- JWKS at `/.well-known/http-message-signatures-directory` (Meunier draft-05).
- `keyid` = RFC 7638 JWK SHA-256 thumbprint.
- Hybrid signing key tier: KMS-held org identity signs JWKS metadata; per-instance ephemerals sign actual requests.
- Replay cache: bloom-filter front + Redis backend (regional, fail-closed on cross-region).
- `Content-Digest` (RFC 9530) over JCS (RFC 8785) for bodied requests.
- Three signed surfaces: admin API, peer ILP-over-HTTP egress, connector→app delivery.
- Migration path: existing bearer/mTLS auth remains as fallback during a configurable soak window.

---

## Architecture

### Layering

```
┌──────────────────────────────────────────────────────────────┐
│  APPLICATION    Connector (admin API, ILP routing, app link)│
├──────────────────────────────────────────────────────────────┤
│  AUTH           RFC 9421 signer/verifier middleware          │
│                 ├─ keyid = RFC 7638 JWK SHA-256 thumbprint   │
│                 ├─ alg = ed25519 | ecdsa-p256-sha256 only    │
│                 └─ created/expires/nonce + replay cache      │
├──────────────────────────────────────────────────────────────┤
│  TRANSPORT      TransportProvider abstraction (Epic 35)      │
│                 ├─ DirectTransportProvider                   │
│                 ├─ SocksTransportProvider (ATOR/Tor)         │
│                 └─ HttpPeerTransport (NEW — RFC 0035)        │
├──────────────────────────────────────────────────────────────┤
│  KEY TIER       Hybrid: KMS org-identity + per-instance      │
│                 ephemeral. Ephemerals signed by org via JWKS │
└──────────────────────────────────────────────────────────────┘
```

### Signed surfaces

| Surface | Signer | Verifier | Notes |
|---|---|---|---|
| Admin API (operator → connector) | Operator's RFC 9421 client (Epic 40 will swap to passkey-derived) | Connector verifier middleware | Replaces bearer; operator identity per-request |
| Peer ILP-over-HTTP (connector → connector) | Connector ephemeral key | Peer connector verifier | Ephemeral signed by org identity in JWKS |
| Connector → app (local delivery v2 envelope) | Connector ephemeral key | App verifier (Townhouse-side) | Body is the v2 envelope from Epic 39 |

### JWKS topology

```
GET /.well-known/http-message-signatures-directory
{
  "keys": [
    { "kty": "OKP", "crv": "Ed25519", "x": "...", "kid": "<thumbprint>",
      "use": "sig", "alg": "ed25519",
      "x5c": [...]   // optional: org-identity chain anchoring
    },
    { "kty": "OKP", "crv": "Ed25519", "x": "...", "kid": "<thumbprint>",
      "use": "sig", "alg": "ed25519",
      "ext-issued-by": "<org-keyid>",   // ephemeral signed by org
      "ext-rotates-at": "2026-05-08T00:00Z"
    }
  ]
}
```

Cache-Control: ≤ 300 s. Overlap window for rotation: 7 days. Out-of-band sentinel revocation supported.

### Out of scope

- secp256k1 / Schnorr / `schnorr-secp256k1` algorithms (IANA gap; Architecture C; tracked as Phase 3 community contribution).
- Passkey-derived signing keys (Epic 40 supplies; Epic 38 supports any IANA-registered algorithm including KMS-managed Ed25519).
- BTP-over-WebSocket signing changes — BTP claims continue to use the existing claim-signature path at the application layer.
- Hybrid PQ algorithms (Phase 4 tracking).

---

## Stories

### Story 38.1: HttpPeerTransport — RFC 0035 ILP-over-HTTP egress + ingress

**Goal.** Implement ILP-over-HTTP per RFC 0035 as a third `TransportProvider` alongside `DirectTransportProvider` and `SocksTransportProvider`. Composes with both — egress through ATOR works without changes.

**Acceptance criteria.**
- AC1: `HttpPeerTransport implements TransportProvider`; passes the same conformance suite as the other two providers.
- AC2: Inbound endpoint at configurable path (default `/ilp/v1/packet`) accepts OER-encoded ILP packets via `POST` with `Content-Type: application/octet-stream`.
- AC3: Outbound POSTs to peer-configured URL using `http.Agent` from injected `TransportProvider` (so SOCKS still works).
- AC4: Connection pooling, keep-alive, configurable timeout (default 30s, ILP-aware).
- AC5: Routes to BTP-over-WebSocket peers continue to work unchanged when peer is BTP-configured.

**Files.** `packages/connector/src/transport/http-peer-transport.ts`, `packages/connector/src/transport/http-peer-transport.test.ts`.

**Dependencies.** Epic 35 `TransportProvider` (existing).

---

### Story 38.2: RFC 9421 signer module

**Goal.** Sign outbound HTTP requests with RFC 9421 using configured `keyid` + algorithm.

**Acceptance criteria.**
- AC1: Library: `dhensby/node-http-message-signatures` v1.x or vendored equivalent (decision in story planning).
- AC2: Covered components: `("@method" "@authority" "@path" "content-digest" "content-type" "content-length")` + parameters `created`, `expires` (60s default), `nonce`, `keyid`, `alg`.
- AC3: `Content-Digest` per RFC 9530 over raw bytes pre-parser (no JCS dependency for non-JSON; JCS for JSON bodies via story 38.8).
- AC4: Algorithm allowlist enforced at sign-time: `ed25519`, `ecdsa-p256-sha256` only.
- AC5: RFC 9421 §B golden vectors green as vitest fixtures.

**Files.** `packages/connector/src/auth/rfc9421/sign.ts`, `packages/connector/src/auth/rfc9421/sign.test.ts`, `packages/connector/test/fixtures/rfc9421-golden-vectors.ts`.

---

### Story 38.3: RFC 9421 verifier middleware

**Goal.** Hono-based middleware that verifies inbound RFC 9421 signatures, looks up `keyid` in JWKS cache, enforces algorithm allowlist, applies replay cache and clock-skew.

**Acceptance criteria.**
- AC1: Middleware mountable on any Hono router; rejects with explicit 401 + structured error code on each failure mode.
- AC2: Failure modes return distinct error codes: `keyid_unknown`, `alg_not_allowed`, `signature_invalid`, `digest_mismatch`, `replayed`, `expired`, `clock_skew`.
- AC3: Clock skew tolerance: ±60s default, ±300s grace, configurable.
- AC4: Algorithm allowlist enforced before signature verification (cheap reject).
- AC5: Failures logged with sanitised metadata (no raw signature bodies, no `keyid` in plaintext past the first 8 chars).

**Files.** `packages/connector/src/auth/rfc9421/verify.ts`, `packages/connector/src/auth/rfc9421/verify.test.ts`.

**Dependencies.** Story 38.4 (JWKS provider), Story 38.7 (replay cache).

---

### Story 38.4: JWKS provider + `/.well-known/http-message-signatures-directory`

**Goal.** Publish JWKS at the well-known path; consume peer JWKS for verification.

**Acceptance criteria.**
- AC1: `GET /.well-known/http-message-signatures-directory` returns the connector's JWKS with all active keys.
- AC2: `keyid` for every key is RFC 7638 JWK SHA-256 thumbprint, deterministic.
- AC3: `Cache-Control: max-age=300, public` on the response.
- AC4: Outbound JWKS client honours `Cache-Control` and refreshes on miss.
- AC5: Failed JWKS fetch is logged + raises an alert metric (`ilp.sig.jwks.fetch.fail`).

**Files.** `packages/connector/src/auth/rfc9421/jwks-provider.ts`, `packages/connector/src/auth/rfc9421/jwks-client.ts`.

---

### Story 38.5: KMS integration for org-tier identity

**Goal.** Org identity key lives in KMS; signs JWKS metadata (the wrap that vouches for ephemerals); does NOT sign per-request traffic.

**Acceptance criteria.**
- AC1: KMS provider abstraction supports AWS KMS, GCP KMS, HashiCorp Vault Transit (one initial impl, others stubbed).
- AC2: Sign latency ≤ 50ms p99 for JWKS metadata sign (called rarely, ~once per ephemeral rotation).
- AC3: KMS unavailability degrades gracefully — existing JWKS continues serving until rotation deadline; alert at 24h before deadline.

**Files.** `packages/connector/src/auth/rfc9421/kms-provider.ts`, extends existing `key-rotation-manager.ts`.

---

### Story 38.6: Per-instance ephemeral key generator + lifecycle

**Goal.** Each connector instance generates its own ephemeral signing key on startup; advertised in JWKS as signed by the org identity; rotated on configurable cadence.

**Acceptance criteria.**
- AC1: Ephemeral key generated on startup using `node:crypto` (Ed25519 default).
- AC2: Key persisted in-memory only; never written to disk.
- AC3: Key lifecycle: 7-day default; configurable; new key generated 24h before expiry; both keys in JWKS during overlap window.
- AC4: Org-identity signs the ephemeral's metadata for JWKS publication.

**Files.** `packages/connector/src/auth/rfc9421/ephemeral-key-manager.ts`.

**Dependencies.** Story 38.5 (KMS for org sign).

---

### Story 38.7: Replay cache (bloom + Redis)

**Goal.** Per-`(keyid, nonce)` replay cache; bloom-filter front to elide ~99% of Redis lookups; regional, fail-closed on cross-region.

**Acceptance criteria.**
- AC1: Bloom-filter sized for 1M entries, ~1% FPR; resets when nonce window slides.
- AC2: Redis-backed authoritative state; TTL = clock-skew window + 5s safety.
- AC3: Single-instance fallback: in-memory cache if no Redis configured.
- AC4: On bloom miss + Redis cache miss, accept; on bloom hit, consult Redis; on Redis hit, reject as replay.
- AC5: Metrics: `ilp.sig.replay.bloom.{hit,miss}`, `ilp.sig.replay.redis.{hit,miss}`, `ilp.sig.replay.outcome.{accept,reject}`.

**Files.** `packages/connector/src/auth/rfc9421/replay-cache.ts`.

---

### Story 38.8: Content-Digest + JCS body canonicalisation

**Goal.** `Content-Digest: sha-256=:...:` over raw request body bytes; for JSON bodies, canonicalise per RFC 8785 (JCS) before digest to survive middleware re-encoding.

**Acceptance criteria.**
- AC1: Digest computed on raw bytes pre-parser (capture in middleware before body parse).
- AC2: For `Content-Type: application/json`, compute digest on JCS-canonicalised form; verifier same-side.
- AC3: For OER (ILP packets), digest on raw octets; no canonicalisation needed.
- AC4: Mismatch returns specific error code `digest_mismatch`.
- AC5: RFC 8785 JCS test vectors green.

**Files.** `packages/connector/src/auth/rfc9421/content-digest.ts`, `packages/connector/src/auth/rfc9421/jcs.ts`.

---

### Story 38.9: Apply RFC 9421 to admin API

**Goal.** All `/admin/*` requests require valid RFC 9421 signature (or fall back to existing `X-Api-Key` during soak window).

**Acceptance criteria.**
- AC1: Verifier middleware mounted on `/admin/*` router.
- AC2: Config flag `auth.adminApi.mode: "rfc9421" | "legacy" | "either"`; default `"either"` for migration.
- AC3: Existing `X-Api-Key` continues working when mode allows.
- AC4: Operator docs updated with the new auth path.

**Files.** Edit `packages/connector/src/http/admin-server.ts`; update `packages/connector/src/config/types.ts`.

**Dependencies.** Stories 38.3, 38.4, 38.7.

---

### Story 38.10: Apply RFC 9421 to peer ILP-over-HTTP egress

**Goal.** `HttpPeerTransport` egress signs every outbound packet POST; ingress verifies.

**Acceptance criteria.**
- AC1: Egress signs with the connector's ephemeral key.
- AC2: Ingress verifies via peer's JWKS; rejects unsigned/invalid packets at the transport layer (returns ILP F00).
- AC3: Per-peer config: `auth.peer.mode: "rfc9421" | "mtls" | "either"`; default per-peer.
- AC4: Mixed-mode bilateral works (one peer on RFC 9421, the other on mTLS) when both peers allow `"either"`.

**Files.** Edits to `packages/connector/src/transport/http-peer-transport.ts`.

**Dependencies.** Stories 38.1, 38.2, 38.3, 38.4, 38.7.

---

### Story 38.11: Apply RFC 9421 to connector → app local delivery

**Goal.** The connector's POST to the app (`LocalDeliveryClient.deliver()`) is signed; app-side verifier provided as Townhouse-published reference middleware.

**Acceptance criteria.**
- AC1: `LocalDeliveryClient` signs requests when `localDelivery.signing.enabled: true` (config flag, default false during migration).
- AC2: Connector publishes JWKS that apps can fetch; apps verify against it.
- AC3: Reference verifier published as `@toon-protocol/handler-rfc9421-middleware` npm package or equivalent, consumable by Townhouse's reference app. (New package name from the start; the legacy "bls" prefix is not introduced — see Epic 39 Story 39.15 for terminology rule.)
- AC4: Body is the v2 envelope from Epic 39 (or v1 for back-compat).

**Files.** Edits to `packages/connector/src/core/local-delivery-client.ts`; new `packages/handler-rfc9421-middleware/`.

**Dependencies.** Stories 38.2, 38.4. Soft dep on Epic 39 for the v2 envelope.

---

### Story 38.12: Stop-the-line + nightly HTTP-surface CI extension

**Goal.** Nightly HTTP-surface workflow exercises the new RFC 9421 surfaces end-to-end; failures block merges per the existing stop-the-line policy.

**Acceptance criteria.**
- AC1: Nightly runs admin-API + peer + app surfaces against real chains via `make infra-up`.
- AC2: Negative-path matrix per research §"Integration Challenges" #1–5: gateway header rewrites, JSON re-encoding, clock skew, replay, malformed signature.
- AC3: Stop-the-line policy applies: PR merges blocked when nightly is red.
- AC4: Operator docs updated with reproduction commands.

**Files.** `.github/workflows/nightly-http-surface.yml` (existing — extended); `packages/connector/test/integration/rfc9421-*.test.ts`.

**Dependencies.** All prior stories in this epic.

---

### Story 38.13: Migration telemetry + flip-default decision protocol (this epic's slice)

**Goal.** Wire the three flags introduced by this epic (`auth.adminApi.mode`, `auth.peer.<id>.mode`, `localDelivery.signing.enabled`) into the migration telemetry from Epic 43 Story 43.1; document the flip-default decision protocol for these specific flags.

**Acceptance criteria.**
- AC1: Each flag emits `connector.migration.flag.<name>.{accept,reject,error}` counter with `value=<flag-value>` attribute.
- AC2: Per-bilateral-peer attribution for `auth.peer.<id>.mode` (counter tagged with peer ID).
- AC3: Decision protocol entry in `docs/operators/migration-decision-protocol.md` (created in Epic 43 Story 43.1) for each flag, with explicit thresholds: ≥ 90% adoption + success rate within 0.5% + ≥ 14 consecutive days.
- AC4: Cross-version compat matrix entries (Epic 43 Story 43.2) covering this epic's flags must be present before flip-default.
- AC5: Rollback procedure documented (Epic 43 Story 43.5) for each flag.

**Files.** Edits to the three flag sites; `docs/operators/migration-decision-protocol.md` (Epic 43 owns the doc; this story contributes the entries for these flags).

**Dependencies.** Epic 43 Stories 43.1, 43.2, 43.5 (this story is a thin slice of those for this epic's flags).

---

## Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Gateway header rewrites break covered-component validation | High | High | Sign only headers gateway is contractually stable on; prefer `@authority` over `Host`; document deployment topology |
| JCS canonicalisation drift between sender/receiver | Medium | High | Compute digest on raw bytes pre-parser; vitest fixtures from RFC 8785 |
| KMS outage during ephemeral rotation | Low | Medium | 24h overlap window; alert at 24h before expiry; manual rotation override |
| Replay cache exhaustion (DoS) | Low | Medium | Bound cache size; bloom front; rate-limit per `keyid` |
| Per-peer config drift between bilateral pairs | Medium | Medium | `"either"` mode default during migration; per-peer state visible in admin UI |

---

## Definition of Done

- All 12 stories shipped with tests green.
- One peer pair runs end-to-end on RFC 0035 ILP-over-HTTP with RFC 9421 signatures on every request.
- Admin API authenticates via signed-HTTP (passkey-login wired separately in Epic 40).
- Connector → app local delivery POSTs are signed; v2 envelope is the body.
- RFC 9421 §B golden vectors green; RFC 8785 JCS test vectors green.
- Nightly HTTP-surface CI extended to cover the new surfaces; stop-the-line applies.
- Operator docs updated for: bilateral peering with RFC 9421, KMS provisioning, ephemeral rotation operations, JWKS publication, migration from bearer/mTLS.

## Estimated Total Effort

13 stories. Estimate range: 2–3 sprints (4–6 weeks at 2-week cadence) for a single dedicated engineer; 1.5–2 sprints with two engineers. Story 38.13 is a thin instrumentation slice over Epic 43.

## Test design

Separate doc `test-design-epic-38.md` (TBD — created when this epic enters delivery).
