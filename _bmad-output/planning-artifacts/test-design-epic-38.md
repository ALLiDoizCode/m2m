---
stepsCompleted: [1, 2, 3, 4, 5, 6]
inputDocuments:
  - epic-38-ilp-over-http-rfc9421.md
  - technical-http-sigs-webauthn-nostr-research-2026-05-01.md
workflowType: 'test-design'
research_topic: 'Test design for Epic 38 — ILP-over-HTTP + RFC 9421'
date: '2026-05-01'
---

# Test Design: Epic 38 — ILP-over-HTTP Transport + RFC 9421 HTTP Message Signatures

**Date:** 2026-05-01
**Author:** Jonathan (with BMAD multi-agent roundtable)
**Status:** Draft
**Source epic:** `epic-38-ilp-over-http-rfc9421.md`

---

## Executive Summary

Epic 38 introduces two new surfaces (ILP-over-HTTP peer transport; RFC 9421 message signing across admin/peer/app), one new dependency tier (KMS for org identity), one new state surface (replay cache), and re-points the connector→app delivery body. Every one of those is a place where signature verification can silently break under realistic deployment topologies.

The dominant test risks are not cryptographic — `@noble/curves` is audited and the algorithms are IETF-standard. The risks are **integration-shape**: gateway header rewrites, JSON re-encoding, JWKS cache staleness, clock skew, replay-cache topology under concurrency, and key-tier rotation under load. The negative-path matrix from research §"Integration Challenges" is the spine of this test plan.

Mock-free per `CLAUDE.md` — all integration tests run against real chain containers via `make infra-up`, real Hono servers, real `@noble/curves` signing, real Redis (or in-memory for single-instance), real KMS (LocalStack for KMS in CI; AWS KMS in staging).

---

## 1. Key Risks and Mitigating Tests

### Risk Matrix

| Risk ID | Risk | Likelihood | Severity | Mitigating tests |
|---|---|---|---|---|
| R-01 | Gateway header rewrites break covered-component validation | High | High | Story 38.3 + 38.10 negative path; Story 38.12 nightly with realistic gateway fixtures |
| R-02 | JCS canonicalization drift between sender/receiver | Medium | High | Story 38.8 RFC 8785 vector compliance; raw-bytes digest pre-parser tests |
| R-03 | KMS outage during ephemeral rotation | Low | High | Story 38.5 chaos test (LocalStack pause); Story 38.6 24h overlap window verification |
| R-04 | Replay cache exhaustion (DoS) | Low | Medium | Story 38.7 bounded cache + bloom front; rate-limit per `keyid` test |
| R-05 | Clock-skew false-rejects | Medium | Low | Story 38.3 ±60s tolerance test; ±300s grace test; NTP-drift simulation |
| R-06 | Algorithm allowlist bypassed via unrecognized `alg` value | Low | Catastrophic | Story 38.3 negative path: unsupported alg → reject before sig verify |
| R-07 | `keyid` collision via non-thumbprint `keyid` schemes | Low | High | Story 38.4 enforces RFC 7638 thumbprint; reject non-conforming `keyid` |
| R-08 | JWKS staleness propagates revoked keys | Medium | Medium | Story 38.4 short Cache-Control test; revocation drill |
| R-09 | Mixed bilateral pair (one peer `rfc9421`, one `mtls`) silently drops requests | Medium | High | Story 38.10 `"either"` mode test; Epic 43 cross-version matrix |
| R-10 | Per-instance ephemeral key persisted to disk by accident | Low | Catastrophic | Story 38.6 process-memory-only assertion; static analysis lint |

### Risk Detail: Top 5

**R-01 (Gateway header rewrites).** Production deployments routinely sit behind Cloudflare, Kong, Envoy, or AWS ALB — all of which rewrite headers (`X-Forwarded-*`, normalize Host, drop hop-by-hop). RFC 9421's covered-component list MUST select only headers the gateway is contractually stable on. Test harness includes a "hostile gateway" middleware that rewrites `Host` → `X-Forwarded-Host`, drops `Content-Length`, normalizes `Content-Type`. Verifier must succeed when only `@authority`, `@method`, `@path`, `content-digest` are covered (preferred per research) and fail loudly when `Host` is in the cover.

**R-02 (JCS drift).** Two senders that JSON.stringify the same object can produce different bytes (key order, whitespace, unicode escape choices). Test fixtures from RFC 8785 §3 covering: nested objects, repeated keys, float canonicalization, surrogate pairs, BOM handling. Digest computed pre-parser on raw bytes — captured by middleware before any framework parses JSON.

**R-03 (KMS outage).** AWS KMS has had region-wide outages. Connector cannot block on KMS during ephemeral rotation; otherwise rotation deadline becomes a global SPOF. Test simulates LocalStack pause for 1 hour; existing JWKS continues serving from last-good state; alert fires at 24h before deadline; rotation succeeds when KMS recovers.

**R-04 (Replay cache DoS).** An attacker can flood with valid-looking signatures and unique nonces to exhaust replay cache memory. Cache must bound: bloom-filter front + Redis with TTL = clock-skew window + 5s. Per-`keyid` rate limit. Test: 1M unique nonces from one `keyid` per second; cache memory growth must stay bounded; legitimate traffic from other `keyid`s unaffected.

**R-09 (Mixed bilateral).** Epic 43 owns the cross-version matrix; this epic owns the `"either"` mode tests. Specifically: connector A configured `auth.peer.B.mode: "either"`, connector B configured `auth.peer.A.mode: "rfc9421"` — A's outbound MUST sign even though A also accepts unsigned (avoid asymmetric handshake mismatch).

---

## 2. Test Strategy Per Story

### Story 38.1: HttpPeerTransport

**Test type:** Integration (real Hono servers).
**Coverage:**
- Conformance suite shared with `DirectTransport` and `SocksTransport` — same TransportProvider interface methods, same return shapes.
- Inbound POST: valid OER ILP packet → routed to packet handler.
- Inbound POST: invalid Content-Type → 400 with documented error.
- Outbound POST through SocksTransportProvider → end-to-end via test ATOR network.
- Connection pooling: 100 concurrent outbound requests share connections; no socket exhaustion.
- Configurable timeout: 30s default; per-request override; timeout returns ILP T03.

**Fixtures:** `packages/connector/test/fixtures/http-peer-test-server.ts` (a minimal Hono ILP-over-HTTP receiver).

### Story 38.2: RFC 9421 signer

**Test type:** Unit + golden vectors.
**Coverage:**
- RFC 9421 §B golden vectors (all of them) → byte-exact match.
- Sign with each algorithm in allowlist (`ed25519`, `ecdsa-p256-sha256`).
- Sign with disallowed algorithm → throws before producing signature.
- Covered-component selection: include/exclude correct headers; signature base assembly per RFC 9421 §2.
- `created`, `expires`, `nonce`, `keyid` parameters present and correct.

**Fixtures:** `packages/connector/test/fixtures/rfc9421-golden-vectors.ts` (parsed from RFC 9421 §B).

### Story 38.3: RFC 9421 verifier middleware

**Test type:** Integration (real Hono server, real signer).
**Coverage:**
- Happy path: valid signature → request passes; handler called.
- Invalid signature → 401 `signature_invalid`; handler not called.
- Unknown `keyid` → 401 `keyid_unknown`; JWKS fetch attempted; failed fetch logged.
- Disallowed algorithm → 401 `alg_not_allowed`; signature NOT verified (cheap reject).
- Expired signature (`expires` past) → 401 `expired`.
- Clock skew within tolerance → pass.
- Clock skew outside ±60s but within ±300s grace → pass with metric tag.
- Clock skew outside ±300s → 401 `clock_skew`.
- Replayed nonce → 401 `replayed`.
- Digest mismatch → 401 `digest_mismatch`.
- All failures logged with sanitised metadata (no raw signature bodies; `keyid` truncated to 8 chars in logs).

**Fixtures:** Hostile-gateway middleware (R-01 mitigation); virtual clock for skew tests.

### Story 38.4: JWKS provider + well-known endpoint

**Test type:** Integration.
**Coverage:**
- `GET /.well-known/http-message-signatures-directory` returns valid JWKS with current keys.
- `keyid` for every key matches RFC 7638 thumbprint (computed independently in test).
- `Cache-Control: max-age=300, public` set.
- Outbound JWKS client honours Cache-Control; refetches after expiry.
- JWKS fetch failure → metric incremented; existing cache continues serving.
- Revocation: key removed from JWKS; verifier rejects new requests with that `keyid` after Cache-Control expiry.

**Fixtures:** Test JWKS server with controllable response delays + failure modes.

### Story 38.5: KMS integration

**Test type:** Integration (LocalStack KMS in CI).
**Coverage:**
- Sign latency ≤ 50ms p99 for JWKS metadata sign.
- KMS unavailable → JWKS continues serving; alert metric fires; new ephemeral rotation deferred.
- KMS recovers → next rotation cycle succeeds; cache catches up.
- KMS provider abstraction: AWS KMS path (LocalStack), GCP KMS path (stub), Vault path (stub) — interface conformance test.

**Fixtures:** LocalStack docker-compose entry; KMS provider stubs.

### Story 38.6: Per-instance ephemeral key

**Test type:** Unit + integration.
**Coverage:**
- Key generated on startup using `node:crypto`.
- Key persisted in-memory only; static analysis CI lint (`grep -r "fs.write.*ephemeral"` returns no matches).
- Key rotation: new key generated 24h before expiry; both keys in JWKS during 24h overlap; old key removed at expiry.
- Org-identity signs ephemeral metadata; signature verifiable independently.
- Process restart → new ephemeral generated; old ephemeral garbage-collected.

### Story 38.7: Replay cache

**Test type:** Integration (real Redis + bloom).
**Coverage:**
- Bloom-filter sized correctly; ~1% FPR observed under load.
- Redis backend authoritative; bloom miss + Redis miss → accept.
- Bloom hit + Redis hit → reject (replay).
- Bloom hit + Redis miss → accept (false positive on bloom; expected).
- TTL = clock-skew window + 5s; entries expire as expected.
- Single-instance fallback: in-memory cache when no Redis configured.
- DoS test: 1M unique nonces from one `keyid`/sec; per-`keyid` rate limit fires; legitimate traffic unaffected.
- Memory bound: cache size capped; eviction LRU when bound reached.

**Fixtures:** Real Redis container via `make infra-up`.

### Story 38.8: Content-Digest + JCS

**Test type:** Unit + integration.
**Coverage:**
- RFC 8785 JCS test vectors (all) → byte-exact match.
- Digest computed on raw bytes pre-parser; middleware captures before body parse.
- For `Content-Type: application/json` → digest on JCS canonical form.
- For OER (ILP packets) → digest on raw octets.
- Mismatch detected → `digest_mismatch` error.
- Multibyte UTF-8 (emoji) handled correctly (bytes not codepoints).

### Story 38.9: Apply RFC 9421 to admin API

**Test type:** Integration.
**Coverage:**
- `auth.adminApi.mode: "rfc9421"` → bearer rejected with 401.
- `auth.adminApi.mode: "legacy"` → RFC 9421 ignored; bearer accepted.
- `auth.adminApi.mode: "either"` → both work bilaterally.
- Operator running existing tooling with bearer continues to work in `"either"` mode.
- Migration path: flip from `"either"` → `"rfc9421"` → no service interruption for properly-configured clients.

### Story 38.10: Apply RFC 9421 to peer ILP-over-HTTP

**Test type:** Integration (two-connector E2E).
**Coverage:**
- Connector A signs outbound; Connector B verifies → packet routes; ILP FULFILL returns.
- Connector B has unknown `keyid` for A → 401; routing layer reports peer unreachable.
- Mixed bilateral: A on `"either"`, B on `"rfc9421"` → A's outbound MUST sign (R-09); test asserts.
- Per-peer config: `auth.peer.<id>.mode` honoured per peer; not global.
- Migration: flip per-peer from `"mtls"` → `"either"` → `"rfc9421"` without service interruption.

### Story 38.11: Apply RFC 9421 to connector → app delivery

**Test type:** Integration with reference verifier.
**Coverage:**
- `localDelivery.signing.enabled: true` → connector signs; app's reference verifier accepts.
- App refuses signed delivery with bad signature → connector retries per-spec or fails per-spec.
- Reference verifier middleware (`@toon-protocol/handler-rfc9421-middleware`) integrates with Hono and Express.
- v1 envelope + signing.enabled → still signs the v1 PaymentRequest body.
- v2 envelope + signing.enabled → signs the v2 toon-event body.

### Story 38.12: Stop-the-line + nightly extension

**Test type:** Workflow / CI configuration.
**Coverage:**
- Nightly workflow extended; new test cases run.
- Negative-path matrix per R-01 to R-10 covered in nightly.
- Stop-the-line policy: PR merges blocked when nightly red (existing policy applies).
- Operator docs include reproduction commands (`make infra-up` + specific test commands).

### Story 38.13: Migration telemetry slice

**Test type:** Integration with Epic 43 telemetry harness.
**Coverage:**
- Each flag emits counters per spec.
- Per-bilateral-peer attribution for peer mode flag.
- Decision protocol entries present in shared doc.
- Cross-version compat matrix entries (Epic 43 Story 43.2) cover this epic's flags.

---

## 3. Cross-Story Integration Tests

| Test | Asserts | Stories covered |
|---|---|---|
| `rfc9421.full-stack.spec.ts` | End-to-end: sign on egress (38.2) → transport (38.1) → JWKS resolve (38.4) → verify (38.3) → replay (38.7) → handler invoked. | 38.1–38.4, 38.7 |
| `key-rotation.spec.ts` | KMS-signed JWKS metadata → ephemeral rotates → 24h overlap → old key removed → no service interruption. | 38.5, 38.6, 38.4 |
| `mixed-bilateral.spec.ts` | Two-connector E2E with all combinations of admin + peer mode (`"rfc9421"`, `"mtls"`/`"legacy"`, `"either"`). | 38.9, 38.10, 38.13 |
| `nightly-acceptance.spec.ts` | Daily green run gates merges. | 38.12 (umbrella) |

---

## 4. Regression Analysis

### Regression Risk Assessment

| Existing surface | Regression risk | Mitigation |
|---|---|---|
| BTP-over-WebSocket peer protocol | Low (orthogonal) | Existing BTP test suite continues unchanged; not touched by this epic |
| Admin API existing bearer auth | High during transition | `"either"` mode default during soak; existing bearer test suite stays green; new RFC 9421 tests added alongside |
| Local delivery existing v1 envelope | Medium during signing rollout | `localDelivery.signing.enabled` defaults false; existing local-delivery tests run with signing off; new test variants run with signing on |
| Settlement chain providers | None (orthogonal) | Settlement tests unchanged |
| ATOR transport (Epic 35) | Low | HttpPeerTransport composes with SocksTransport; conformance suite asserts |

### Regression Test Matrix

- Run all existing Epic 32–37 test suites unchanged.
- Add new test suites for Epic 38 surfaces.
- Coverage threshold: no decrease in line/branch coverage for any pre-existing module touched by this epic.

---

## 5. Test Data Requirements

- RFC 9421 §B golden vectors (parsed and committed as fixtures).
- RFC 8785 JCS test vectors (parsed and committed as fixtures).
- Test JWKS server with controllable failure modes.
- Hostile-gateway middleware fixture (header rewrites, Content-Length drop, normalization).
- LocalStack KMS (added to `docker-compose.yml`).
- Real Redis container (already in `make infra-up`).
- Two-connector test harness (already exists in Epic 32 multi-hop helpers).

---

## 6. Test Environment and Infrastructure

### Dependencies (Test-Only)

- LocalStack (KMS service): added to `docker-compose.test.yml`.
- Redis: already present.
- Hono: already present (verifier middleware).
- `@noble/curves` v2.x: already a runtime dep.

### CI Pipeline Integration

- New nightly workflow target: `nightly-http-surface` extended (existing workflow per Epic 37).
- New unit-test target: `npm run test:rfc9421` runs Stories 38.2 + 38.3 + 38.4 + 38.7 + 38.8 vector tests in <60s.
- New integration target: `npm run test:rfc9421-integration` requires `make infra-up`; runs all integration tests in <10 minutes.

### Coverage Thresholds

- `packages/connector/src/auth/rfc9421/**/*.ts`: line coverage ≥ 95%, branch coverage ≥ 90% (new code, no excuse for low coverage).
- Existing modules touched: no decrease in coverage from baseline.

---

## 7. Test Execution Order

### Recommended Implementation Order

1. **Foundation:** Stories 38.2 + 38.4 + 38.8 (signer, JWKS, content-digest) — pure, no I/O dependencies. RFC golden vectors green first.
2. **Verifier:** Story 38.3 builds on 38.2 + 38.4 + 38.8.
3. **State:** Story 38.7 (replay cache) integrates with 38.3.
4. **Key tier:** Stories 38.5 + 38.6 (KMS + ephemeral) — independent of pipeline; can run in parallel with 1–3.
5. **Transport:** Story 38.1 (HttpPeerTransport) — independent infrastructure.
6. **Application:** Stories 38.9, 38.10, 38.11 — apply the verifier to surfaces; depend on 1–5.
7. **Telemetry:** Story 38.13 — instrumentation slice over the now-running flags.
8. **CI gates:** Story 38.12 — last, gates merges going forward.

### Test Dependency Graph

```
38.2 (signer)  ──┐
38.4 (JWKS)    ──┼─→ 38.3 (verifier) ──→ 38.7 (replay) ──┐
38.8 (digest)  ──┘                                        │
                                                          ├─→ 38.9 (admin)
38.5 (KMS)  ──→ 38.6 (ephemeral) ──┐                     ├─→ 38.10 (peer)  ──┐
                                    └─→ 38.4              ├─→ 38.11 (app)   ─┤
                                                          │                  │
38.1 (transport) ─────────────────────────────────────────┘                  │
                                                                              │
                                          38.13 (telemetry) ─────────────────┤
                                                                              │
                                                       38.12 (CI gates) ─────┘
```

---

## 8. Security Test Focus Areas

### Algorithm Allowlist Enforcement

- Bypass attempt: signature with `alg: "rsa-pss-sha512"` (registered but not allowed by connector policy) → reject before signature verification (cheap reject).
- Bypass attempt: signature with `alg: "schnorr-secp256k1"` (not in IANA registry) → reject as `alg_not_allowed`.

### `keyid` Convention Enforcement

- Non-thumbprint `keyid` (e.g., `keyid: "my-key-1"`) → reject as malformed JWKS or unknown keyid; never matched to actual key material.
- Thumbprint collision attempt: two keys producing same SHA-256 thumbprint → cryptographically infeasible; not testable, document assumption.

### Replay Window Boundary

- Signature created at `now - 60s` (boundary): accepted.
- Signature created at `now - 61s`: rejected `expired`.
- Signature created at `now + 60s` (clock ahead): accepted.
- Signature created at `now + 61s`: rejected as `clock_skew`.

### Log Sanitisation Audit

- Audit all log calls in `packages/connector/src/auth/rfc9421/**/*.ts` ensure no raw signature bodies or `Authorization` headers are logged.
- Static analysis: `grep -E "logger\.(info|warn|error|fatal).*\\\$\\{.*signature" packages/connector/src/auth/rfc9421` returns no matches.

---

## 9. Open Questions for Testing

1. **What's the canonical "hostile gateway" header set for R-01?** Cloudflare's behaviour is documented; AWS ALB and Kong vary. Recommend: capture three real gateway behaviours via a one-time integration probe, codify as test fixtures.
2. **Should we test against real AWS KMS in staging?** LocalStack covers most cases but has minor protocol differences. Recommend: nightly staging run against real AWS KMS + LocalStack in CI.
3. **Is the algorithm allowlist's policy file user-editable?** If operators add `rsa-v1_5-sha256` for legacy peer support, what's the test for that path?
4. **NIP-46 latency test for Architecture C readiness** — out of scope for Epic 38 since C is deferred; flag for future epic.
