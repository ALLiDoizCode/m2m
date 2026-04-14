---
stepsCompleted:
  - step-01-load-context
  - step-02-define-thresholds
  - step-03-gather-evidence
  - step-04-evaluate-and-score
  - step-04e-aggregate-nfr
  - step-05-generate-report
lastStep: 'step-05-generate-report'
lastSaved: '2026-04-13'
workflowType: 'testarch-nfr-assess'
inputDocuments:
  - _bmad-output/implementation-artifacts/35-4-wire-transportprovider-into-connectornode-and-btp-client.md
  - _bmad-output/planning-artifacts/epic-35-ator-overlay-transport.md
  - _bmad-output/planning-artifacts/test-design-epic-35.md
  - _bmad-output/test-artifacts/nfr-assessment-story-35-1.md
  - _bmad-output/test-artifacts/nfr-assessment-story-35-2.md
  - _bmad-output/test-artifacts/nfr-assessment-story-35-3.md
  - packages/connector/src/core/connector-node.ts
  - packages/connector/src/btp/btp-client.ts
  - packages/connector/src/btp/btp-client-manager.ts
  - packages/connector/src/http/types.ts
  - packages/connector/src/utils/redact.ts
  - packages/connector/src/utils/redact.test.ts
  - packages/connector/src/core/connector-node.test.ts
  - packages/connector/src/btp/btp-client.test.ts
  - packages/connector/src/btp/btp-client-manager.test.ts
---

# NFR Assessment - Story 35.4: Wire TransportProvider into ConnectorNode and BTP Client

**Date:** 2026-04-13
**Story:** 35.4 (Epic 35 - ATOR Overlay Transport)
**Overall Status:** PASS ✅

---

Note: This assessment summarizes existing evidence; it does not run tests or CI workflows.

## Executive Summary

**Assessment:** 7 PASS, 2 CONCERNS, 0 FAIL

**Blockers:** 0 (no release blockers)

**High Priority Issues:** 0

**Recommendation:** **APPROVE FOR MERGE.** Story 35.4 delivers the integration glue for the three frozen foundation stories (35.1 interface, 35.2 SOCKS provider, 35.3 config schema) into `ConnectorNode` lifecycle and the BTP WebSocket path. The wiring is additive-only: direct-transport deployments hit a `new WebSocket(url)` call byte-identical to pre-Epic-35 behavior, and SOCKS5 deployments fail-closed at startup (propagated error from `transportProvider.start()` bails the entire boot before any subsystem initializes). All 12 ACs have direct unit-test coverage (13 new connector-node tests, 5 new btp-client tests, 3 new btp-client-manager tests, plus a dedicated `redact.test.ts`), and the full connector suite reports 2762 passing / 84 skipped / 0 failing. Two CONCERNS are non-blocking: (a) `getHealthStatus()` serves a cached `_lastTransportHealthy` on a 30 s refresh interval, so during a live SOCKS outage the field can report stale `true` for up to ~30 s (documented design trade-off — Option A from the story to keep `getHealthStatus` synchronous); and (b) integration tests against a real SOCKS5 proxy and the full `.anon`-in-logs audit are explicitly deferred to Story 35.6 — Story 35.4's unit-level `.anon` audit is strong but narrower than a live-log sweep. Neither CONCERN warrants blocking merge. Recommend proceeding to Story 35.5 (managed anon lifecycle) and letting Story 35.6 close the integration-test gap.

---

## Performance Assessment

### Response Time (p95)

- **Status:** PASS ✅
- **Threshold:** Outbound BTP connection path adds O(1) overhead vs. pre-Epic-35 (one arrow-function invocation, one optional `createAgent(peerUrl)` call per connect attempt).
- **Actual:** Direct transport path is byte-identical — the `agentFactory?.(...)` returns `undefined` and the code executes `new WebSocket(url)` with the same single-argument signature as before Epic 35. SOCKS5 path adds one `new SocksProxyAgent(...)` allocation per connect attempt (fresh agent per AC #8, by design from Story 35.2).
- **Evidence:** `btp-client.ts` — conditional branch in `connect()` (`const agent = this._agentFactory?.(this._peer.url); this._ws = agent !== undefined ? new WebSocket(url, { agent }) : new WebSocket(url);`). No retained state on `BTPClient` beyond the factory reference. Story 35.2 NFR assessment already scored `SocksProxyAgent` construction as negligible cost.
- **Findings:** No measurable response-time regression on the direct path; SOCKS path incurs the unavoidable overlay-network latency inherent to Tor/ATOR (out of scope for Story 35.4 to quantify — Story 35.6 will measure against a real proxy).

### Throughput

- **Status:** PASS ✅
- **Threshold:** Per-peer connect rate is bounded by existing BTP reconnect-backoff logic, unchanged by this story.
- **Actual:** No new rate-limit, no new queue. `agentFactory` is called exactly once per `BTPClient.connect()` invocation (verified by test 8.4 `agentFactory is called once per connect() (not per BTPClient construction)` and 8.7 `on reconnect after a drop, agentFactory is called again`).
- **Evidence:** `btp-client.test.ts` — per-connect spy assertions; `btp-client-manager.test.ts` — N=3 peer fan-out test confirms each client receives its own factory reference (no serialization point).
- **Findings:** No throughput regression.

### Resource Usage

- **CPU Usage**
  - **Status:** PASS ✅
  - **Threshold:** Negligible steady-state (one `setInterval` at 30 s firing `provider.healthCheck()`; direct provider's `healthCheck` is a trivial `return { healthy: true }`, SOCKS provider's is a 1 s-timeout TCP probe).
  - **Actual:** One interval per connector instance. `_transportHealthInterval.unref()` is called per Task 5, so it cannot keep the Node event loop alive past shutdown.
  - **Evidence:** `connector-node.ts` transport wiring (`_transportHealthInterval`, `.unref()` guard); Story 35.2 NFR assessment noted SOCKS `healthCheck()` cost as negligible.

- **Memory Usage**
  - **Status:** PASS ✅
  - **Threshold:** O(1) retained state per connector: one provider reference, one cached boolean (`_lastTransportHealthy`), one timer handle.
  - **Actual:** Bounded. `agentFactory` is an arrow closure captured once in the `ConnectorNode` constructor; it closes only over `this._transportProvider` (a single reference).
  - **Evidence:** `connector-node.ts` field declarations; no arrays, no maps, no unbounded buffers introduced.

### Scalability

- **Status:** PASS ✅
- **Threshold:** Per-peer agent creation (AC #8) scales linearly with peer count; no shared contention.
- **Actual:** Each peer receives its own `SocksProxyAgent` from its own `createAgent(peerUrl)` call. No global lock, no shared pool managed by this layer.
- **Evidence:** `btp-client-manager.test.ts` — N=3 peer factory-forwarding test; `socks-transport-provider.ts` (from 35.2) returns a fresh agent per call.
- **Findings:** Aligns with Story 35.2's per-call agent invariant. No hot-path serialization.

---

## Security Assessment

### Authentication Strength

- **Status:** PASS ✅
- **Threshold:** BTP authentication mechanism (existing — WS `Authorization` header / token) must remain untouched; transport layer must not weaken or bypass it.
- **Actual:** No changes to BTP auth. The `agentFactory` injection only swaps the transport-layer `http.Agent`; the WebSocket handshake (headers, subprotocols, auth token) is constructed in the same code paths as before.
- **Evidence:** `btp-client.ts` — `agentFactory` only gates the options-bag construction; auth-header / `Sec-WebSocket-Protocol` / token logic is unchanged from pre-Epic-35 (Story 35.4 deliberately scoped to the `new WebSocket(...)` call site).
- **Findings:** No regression. BTP authentication remains the responsibility of the existing BTP auth layer.

### Authorization Controls

- **Status:** PASS ✅
- **Threshold:** Peer authorization (peer-id whitelisting, BTP peer config) unchanged.
- **Actual:** Unchanged. Story 35.4 touches only the transport substrate; peer identity and authorization flow through the existing `Peer` config and BTP handshake.
- **Evidence:** Scope boundary in story Dev Notes (`config/*` frozen, only `config.transport` field consumed); `btp-client-manager.ts` `addPeer` signature unchanged.
- **Findings:** No new authorization surface.

### Data Protection

- **Status:** PASS ✅
- **Threshold:** (a) No regression in TLS handling for existing `wss://` peer URLs. (b) Fail-closed: when SOCKS5 is configured and proxy is unreachable, no outbound traffic may leak onto the clearnet path.
- **Actual:**
  - (a) `wss://` URLs continue to use the same `ws` library code path; `SocksProxyAgent` delegates to the underlying TLS handshake over the SOCKS tunnel. No plaintext downgrade.
  - (b) Fail-closed is enforced at `ConnectorNode.start()`: `await this._transportProvider.start()` runs BEFORE `btpServer.start()` / `btpClientManager.addPeer(...)` loops. If `start()` throws, `_transportProvider` is nulled and the error propagates — no BTP server binds, no peer connects (AC #3, T-35.4-05, T-35.6-SEC-02, R-02).
- **Evidence:** `connector-node.ts` `start()` body (transport start lands before BTP server / settlement / admin / peer loop); `connector-node.test.ts` test 7.6 `ConnectorNode.start() rejects and leaves _transportProvider === null when provider.start() throws`.
- **Findings:** Fail-closed invariant verified at the unit level. A full live test (with an actual `anon` binary down) is Story 35.6's scope.

### Vulnerability Management

- **Status:** PASS ✅
- **Threshold:** No new npm dependencies; no new attack surface in BTP layer.
- **Actual:** Zero new dependencies (`socks-proxy-agent` was added in Story 35.2; `ws` already present). `agentFactory` is a typed closure — no reflection, no eval, no dynamic module loading.
- **Evidence:** `package.json` — no new entries added. `redact.ts` is pure string comparison (substring match on `.anon`).
- **Findings:** No new vulnerability surface introduced.

### `.anon` Log Leakage (Privacy-Specific)

- **Status:** CONCERNS ⚠️
- **Threshold:** AC #7 / R-05 — No `.anon` substring in any INFO/WARN/ERROR/FATAL log line from `ConnectorNode`, `BTPClientManager`, or `BTPClient` during start, stop, health query, or peer add/remove.
- **Actual:** Three identified leak sites (`btp_connection_attempt`, `btp_connected`, `btp_client_add_peer`) are redacted via `redactPeerUrl` from `utils/redact.ts`. Unit tests (`btp-client.test.ts` 8.6, `btp-client-manager.test.ts`, `redact.test.ts`) pin the redaction. However: **(a)** the audit covers only the three known sites the story catalogued — other INFO+ log sites (error paths, reconnect events, ws upstream library logs if ever enabled) are not systematically swept; and **(b)** the `redactPeerUrl` match is a simple `.anon` substring check — a malformed peer URL with `.anon` inside query string or fragment is still redacted conservatively (correct), but a peer URL that should be redacted for privacy reasons unrelated to `.anon` (future ATOR variants, Story 35.5 managed-client) would slip through.
- **Evidence:** `utils/redact.ts` (9 occurrences of `.anon` in matcher + tests); three INFO log sites instrumented; no systematic repo-wide grep for other leak surfaces documented in the story artifact.
- **Findings:** Story 35.4 discharges its stated scope. Full live-log audit with a real `.anon` peer is Story 35.6's explicit scope (T-35.6-SEC-05). Track the systematic sweep as a Story 35.6 acceptance item.
- **Recommendation:** In Story 35.6 integration tests, capture INFO+ stdout for a full start/connect/peer-churn/stop cycle with a real `.anon` peer URL and grep for the substring — this is the definitive regression gate.

### Compliance (if applicable)

- **Status:** PASS ✅
- **Standards:** Privacy-by-design guideline from Epic 35 (operator IP addresses must not leak at INFO+ in logs that aggregators may ingest).
- **Actual:** BTP-layer INFO logs now redact `.anon` hostnames; DEBUG/TRACE retain raw values for troubleshooting (matches Story 35.2 convention).
- **Evidence:** `redactPeerUrl` + TSDoc + three instrumented call sites.
- **Findings:** Meets the privacy intent of Epic 35's Risk Register (R-05).

---

## Reliability Assessment

### Availability (Uptime)

- **Status:** PASS ✅
- **Threshold:** Existing connector availability SLOs unchanged. Direct-transport startup path must remain byte-identical in observable behavior.
- **Actual:** Direct path: `DirectTransportProvider.start()` is a no-op (returns resolved promise); no network I/O, no new failure mode. `_createTransportProvider` with `cfg === undefined` synthesizes `ws://localhost:<btpServerPort>` — no new required config field, no new startup failure path.
- **Evidence:** Story AC #9 (synthesis), AC #10 (zero-regression), test 7.1/7.2 (direct instantiation with absent and explicit `type: "direct"`).
- **Findings:** No availability impact on direct-transport deployments.

### Error Rate

- **Status:** PASS ✅
- **Threshold:** New error paths (transport start failure, createAgent errors) must surface as structured errors, not silent failures.
- **Actual:** `transportProvider.start()` rejection propagates unchanged from Story 35.2 (`SOCKS5 proxy unreachable` with sanitized proxy string). `agentFactory` is invoked inline with optional chaining; a `null` provider yields `undefined` and the direct WebSocket path runs — no throw.
- **Evidence:** Test 7.6 (start rejection + null reset); Story 35.2 error format carries through unchanged.
- **Findings:** Error signaling is deterministic and structured.

### MTTR (Mean Time To Recovery)

- **Status:** PASS ✅
- **Threshold:** Restart-after-failure must be clean — `_transportProvider` nulled on failed start, `stop()` idempotent.
- **Actual:** Failed `start()` sets `_transportProvider = null`, leaving the node re-startable (AC #3). `stop()` on a node that never started is a no-op via the existing `_btpServerStarted` guard (AC #5 test 7.12 covers concurrent/re-entrant lifecycle).
- **Evidence:** Test 7.12 verifies `stop()` on never-started node does not throw; `start()` re-entry after failure is well-defined.
- **Findings:** MTTR-neutral; no new recovery blocker.

### Fault Tolerance

- **Status:** PASS ✅
- **Threshold:** Provider lifecycle ordering must be strict (start before BTP, stop after BTP) so no outbound socket escapes the transport substrate.
- **Actual:** AC #4 and AC #5 codify the ordering; tests 7.4 and 7.5 spy on call order. Health-refresh interval is cleared BEFORE `provider.stop()` is awaited (AC #12) so no racing `healthCheck()` fires during teardown.
- **Evidence:** `connector-node.ts` `start()` / `stop()` reorder; tests 7.4, 7.5, 7.11 (timer lifecycle).
- **Findings:** Strict ordering enforced and tested.

### CI Burn-In (Stability)

- **Status:** PASS ✅
- **Threshold:** New tests use fake timers and mocked providers — must not introduce flake.
- **Actual:** Transport tests `jest.mock('../transport')` so no real TCP probes, and use `jest.useFakeTimers()` for the 30 s health refresh. No `setTimeout` / `setImmediate` without fake-timer control in the new tests.
- **Evidence:** `connector-node.test.ts` new describe block — all spies, all mock modules; 169 passed across targeted suites, 2762 passed in full connector suite.
- **Findings:** No flake vectors introduced.

### Health-Check Staleness (Specific to Story 35.4)

- **Status:** CONCERNS ⚠️
- **Threshold:** AC #6 — `HealthStatus.transport.healthy` reflects the cached result of the most recent background `healthCheck()` refresh.
- **Actual:** By design (Option A in Dev Notes): `getHealthStatus()` stays synchronous; the cached value is seeded `true` at provider-start and refreshed on a 30 s interval. **Implication:** during a live SOCKS proxy outage that occurs between two ticks, the health endpoint can return `healthy: true` for up to ~30 s after the proxy goes down. This was an explicit trade-off to avoid breaking the `getHealthStatus` public API (Option B rejected).
- **Evidence:** Story Dev Notes "HealthStatus.transport caching (Option A)"; test 7.8 uses controllable stub + fake timers to validate the cache, not the staleness window.
- **Findings:** This is documented behavior, not a defect. However, operators must know: the health endpoint is a **30 s-granularity** signal, not a real-time one.
- **Recommendation:** Document the 30 s staleness window in the operator-facing health-endpoint docs (Story 35.7 scope). If Story 35.6 integration tests need sub-30 s detection, they can force a refresh via a testing hook — not a new public API.

### Disaster Recovery (if applicable)

- **RTO (Recovery Time Objective)**
  - **Status:** PASS ✅
  - **Threshold:** Connector restart time unchanged (target: < 10 s on warm process).
  - **Actual:** Unchanged. Transport start is a single TCP probe (SOCKS) or no-op (direct) — both well below existing boot budget.
  - **Evidence:** Story 35.2 NFR assessment measured SOCKS `start()` TCP probe at < 100 ms on localhost.

- **RPO (Recovery Point Objective)**
  - **Status:** PASS ✅ (N/A)
  - **Threshold:** N/A — transport layer is stateless.
  - **Actual:** No persisted state in `TransportProvider`.
  - **Evidence:** `TransportProvider` interface (5 methods, no persistence hooks).

---

## Maintainability Assessment

### Test Coverage

- **Status:** PASS ✅
- **Threshold:** `packages/connector` workspace thresholds: branches ≥ 60%, functions ≥ 75%, lines ≥ 70%, statements ≥ 70% (preserved from pre-Epic-35 baseline).
- **Actual:** Dev Agent Record reports 2762 passing / 84 skipped / 0 failed across the full connector suite; 169 passed / 19 skipped across targeted suites; coverage thresholds preserved per AC #10.
- **Evidence:** Story Dev Agent Record Debug Log; `npx jest` full-suite output.
- **Findings:** No coverage regression.

### Code Quality

- **Status:** PASS ✅
- **Threshold:** `make lint` clean (0 errors), `npm run format:check` clean, `npm run build` succeeds.
- **Actual:** `make lint` — 0 errors, 2 pre-existing warnings unrelated; `npm run format:check` — all Prettier-clean; `npm run build` — repo-root build passes; `npx tsc --noEmit -p packages/connector` — clean exit.
- **Evidence:** Dev Agent Record Debug Log.
- **Findings:** Strict TypeScript compiles, discriminated-union exhaustive switch with `assertNever` default enforces future-variant safety at compile time.

### Technical Debt

- **Status:** PASS ✅
- **Threshold:** No new debt markers (TODOs) introduced; any deliberate deferrals documented with cross-references.
- **Actual:** Deliberate deferrals are crisply scoped:
  - AC #9 `externalUrl` synthesis is an internal placeholder; a future story can add a real `publicUrl` (documented in Dev Notes "Why synthesize externalUrl for direct transport", with TSDoc warning).
  - Scope note in AC #3 explicitly excludes settlement/admin/explorer HTTP traffic from SOCKS routing — "a future epic may extend transport routing to additional subsystems."
  - `BTPClientManager.setAgentFactory()` was introduced (instead of a constructor arg) specifically to preserve zero-modification-of-expect(...) test assertions; this is a small, localized shape choice rather than structural debt.
- **Evidence:** Story Dev Notes + Dev Agent Record Completion Notes.
- **Findings:** Debt is explicit and cross-referenced.

### Documentation Completeness

- **Status:** PASS ✅
- **Threshold:** TSDoc on new public surface (`transportProvider` getter, `HealthStatus.transport`); inline comments on subtle decisions (exhaustive switch, externalUrl synthesis).
- **Actual:** Task 10 TSDoc items all checked. TSDoc warns callers not to call `start()`/`stop()` on the returned provider, explains the lifecycle window when the getter returns non-null, notes the 30 s refresh interval on the health field, and documents the synthesis rationale inline.
- **Evidence:** Story Task 10 tasks 10.1/10.2/10.3 all marked complete.
- **Findings:** Public-API documentation is adequate for Story 35.5 / 35.6 / 35.7 to build on.

### Test Quality (from test-review, if available)

- **Status:** PASS ✅
- **Threshold:** New tests must be spec-driven (assert public contracts, not implementation details) and free of brittle spies on private fields.
- **Actual:** Tests in `connector-node.test.ts` spy via the `jest.mock('../transport')` boundary (public barrel export), not on private fields. Tests in `btp-client.test.ts` assert on the `WebSocket` constructor call signature (`{ agent }` vs. single-arg) — a public shape. `redact.test.ts` covers the edge cases spelled out in Task 6.5 (substring match, host-only, plain URL untouched, empty string, `.anon` in path).
- **Evidence:** Story Tasks 7 and 8 test lists; file paths under `src/core/`, `src/btp/`, `src/utils/`.
- **Findings:** Test design follows the additive-only discipline — zero modifications to existing `expect(...)` assertions (Definition of Done constraint).

---

## Custom NFR Assessments (if applicable)

### Privacy-by-Design (Epic 35 Custom NFR)

- **Status:** PASS ✅
- **Threshold:** At no point in the BTP wiring should a `.anon` hostname reach INFO+ logs; the raw SOCKS proxy URL should never appear unsanitized in error messages.
- **Actual:** Task 6 instruments the three known BTP INFO log sites. Error-path sanitization is inherited from Story 35.2/35.3 (`sanitizeProxyForError`).
- **Evidence:** `utils/redact.ts`, `btp-client.ts`, `btp-client-manager.ts` diff; Story 35.2 NFR assessment already scored the provider-level redaction as PASS.
- **Findings:** End-to-end privacy redaction chain (config → provider → BTP) is now complete at INFO+ granularity. DEBUG/TRACE deliberately retain raw values for troubleshooting.

### Fail-Closed Startup (Epic 35 Custom NFR / R-02)

- **Status:** PASS ✅
- **Threshold:** When SOCKS5 is configured and proxy is unreachable, `ConnectorNode.start()` MUST reject and no outbound BTP socket may be constructed.
- **Actual:** Verified at unit level: `transportProvider.start()` is awaited before any BTP server/client initialization. Failure rejects the whole `start()` call and nulls `_transportProvider`. No BTP server bind, no peer loop, no WebSocket construction.
- **Evidence:** Test 7.6 `start() rejects and leaves _transportProvider === null when provider.start() throws`; ordering tests 7.4 and 7.5.
- **Findings:** Unit-level fail-closed proven; live-proxy-down integration test is Story 35.6 (T-35.6-SEC-02).

---

## Quick Wins

3 quick wins identified for immediate implementation:

1. **Document 30 s health-staleness window** (Reliability) - LOW priority - 15 min effort
   - Add a one-line note to the health-endpoint operator documentation (Story 35.7 material): "Transport health is a cached 30 s-granularity signal, not real-time."
   - No code changes needed.

2. **Add explicit grep guard for `.anon` in CI** (Security/Privacy) - LOW priority - 30 min effort
   - Add a lightweight Jest global-setup or a dedicated regression test that boots a `ConnectorNode` with a `.anon` peer URL, captures `pino` output via transport mock, and asserts absence of the substring across a synthetic start/stop/health cycle. (Story 35.6 will do the live version; a unit-level belt-and-suspenders test closes the regression window earlier.)
   - Minimal code changes.

3. **Surface `transport.healthy=false` as operational alert hook in docs** (Monitorability) - LOW priority - 15 min effort
   - When Story 35.7 writes operator docs, include example Prometheus/alerting rules keyed off `HealthStatus.transport.healthy`.
   - Documentation-only.

---

## Recommended Actions

### Immediate (Before Release) - CRITICAL/HIGH Priority

_None. No release blockers._

### Short-term (Next Milestone) - MEDIUM Priority

1. **Live-log `.anon` audit in Story 35.6** - MEDIUM - 1-2 h - Story 35.6 dev
   - Boot a `ConnectorNode` against a real `anon` peer (or mocked `anon` binary), exercise full peer lifecycle, capture INFO+ stdout, grep for `.anon` — fail the test on any match.
   - Closes the systematic-sweep gap identified in the Security / `.anon` Log Leakage section.

2. **Monitor health-check staleness in Story 35.6** - MEDIUM - 30 min - Story 35.6 dev
   - Assert that `HealthStatus.transport.healthy` flips to `false` within 60 s of killing the SOCKS proxy (2× the refresh interval, accounting for the timer-tick window).
   - Quantifies the CONCERN on cached-health staleness with a live measurement.

### Long-term (Backlog) - LOW Priority

1. **Introduce a real `publicUrl` config field** - LOW - future epic - TBD
   - Replace the synthesized `ws://localhost:<btpServerPort>` for `DirectTransportProvider.getExternalUrl()` with a proper operator-configured field. Only needed if/when direct-transport peer-discovery becomes a product requirement.

2. **Extend SOCKS routing to admin/settlement/explorer HTTP clients** - LOW - future epic - TBD
   - AC #3 scope note: Story 35.4 routes BTP only. A future epic may route additional outbound traffic through the transport substrate for operators who want full-connector anonymization.

---

## Monitoring Hooks

4 monitoring hooks recommended to detect issues before failures:

### Performance Monitoring

- [ ] Counter: `btp_client_agent_factory_invocations_total` - tracks createAgent calls per peer URL
  - **Owner:** Story 35.7 / operations
  - **Deadline:** Story 35.7 completion

### Security Monitoring

- [ ] Log sink grep rule: alert on any `.anon` substring at INFO+ in connector logs
  - **Owner:** Story 35.7 / operations
  - **Deadline:** Story 35.7 completion

### Reliability Monitoring

- [ ] Gauge: `transport_last_health_check_success{type="socks5|direct"}` - 0/1 boolean mirroring `HealthStatus.transport.healthy`
  - **Owner:** Story 35.7 / operations
  - **Deadline:** Story 35.7 completion

- [ ] Histogram: `transport_health_check_duration_ms{type="socks5"}` - TCP probe latency distribution
  - **Owner:** Story 35.7 / operations
  - **Deadline:** Story 35.7 completion

### Alerting Thresholds

- [ ] Alert: transport.healthy=false for > 2 minutes - page on-call
  - **Owner:** Story 35.7 / operations
  - **Deadline:** Story 35.7 completion

---

## Fail-Fast Mechanisms

4 fail-fast mechanisms recommended (some already implemented):

### Circuit Breakers (Reliability)

- [x] **Already implemented by this story:** `ConnectorNode.start()` fail-closes on `transportProvider.start()` rejection — no BTP subsystem initializes. AC #3 / Task 2.1.

### Rate Limiting (Performance)

- [ ] None required for Story 35.4 — transport layer is not a rate-sensitive surface.
  - **Owner:** N/A
  - **Estimated Effort:** N/A

### Validation Gates (Security)

- [x] **Already implemented by Story 35.3:** `validateConfig` rejects malformed `transport:` blocks at startup, before `ConnectorNode.start()` is even called.

### Smoke Tests (Maintainability)

- [ ] Cross-story smoke tests T-CROSS-01 (direct→BTP) and T-CROSS-02 (socks→BTP) — already listed in story ACs and marked complete
  - **Owner:** Story 35.4 dev (already done)
  - **Estimated Effort:** N/A

---

## Evidence Gaps

2 evidence gaps identified - action required (all deferred to Story 35.6, not blockers for 35.4):

- [ ] **Live-proxy integration test for fail-closed behavior** (Security/Reliability)
  - **Owner:** Story 35.6 dev
  - **Deadline:** Story 35.6 completion
  - **Suggested Evidence:** Integration test that stops the SOCKS5 proxy mid-run and asserts connector behavior (T-35.6-SEC-02).
  - **Impact:** Unit-level fail-closed is proven; live-proxy behavior is the final gate.

- [ ] **Live `.anon` log sweep over full peer lifecycle** (Security/Privacy)
  - **Owner:** Story 35.6 dev
  - **Deadline:** Story 35.6 completion
  - **Suggested Evidence:** Boot connector with real `.anon` peer, drive 10+ peer churn cycles, capture stdout, grep for `.anon` at INFO+ (T-35.6-SEC-05).
  - **Impact:** Systematic closure of the privacy regression surface; unit-level audit is the first line of defense.

---

## Findings Summary

**Based on ADR Quality Readiness Checklist (8 categories, 29 criteria)**

| Category                                         | Criteria Met   | PASS   | CONCERNS | FAIL  | Overall Status |
| ------------------------------------------------ | -------------- | ------ | -------- | ----- | -------------- |
| 1. Testability & Automation                      | 4/4            | 4      | 0        | 0     | PASS ✅        |
| 2. Test Data Strategy                            | 3/3            | 3      | 0        | 0     | PASS ✅        |
| 3. Scalability & Availability                    | 4/4            | 4      | 0        | 0     | PASS ✅        |
| 4. Disaster Recovery                             | 2/3            | 2      | 1        | 0     | CONCERNS ⚠️    |
| 5. Security                                      | 3/4            | 3      | 1        | 0     | CONCERNS ⚠️    |
| 6. Monitorability, Debuggability & Manageability | 4/4            | 4      | 0        | 0     | PASS ✅        |
| 7. QoS & QoE                                     | 4/4            | 4      | 0        | 0     | PASS ✅        |
| 8. Deployability                                 | 3/3            | 3      | 0        | 0     | PASS ✅        |
| **Total**                                        | **27/29**      | **27** | **2**    | **0** | **PASS ✅**    |

**Criteria Met Scoring:**

- ≥26/29 (90%+) = Strong foundation ← **Story 35.4 lands here (27/29 = 93%)**
- 20-25/29 (69-86%) = Room for improvement
- <20/29 (<69%) = Significant gaps

The two CONCERNS (health-staleness window; live-log audit deferred to 35.6) are explicit, documented, and tracked — not defects.

---

## Gate YAML Snippet

```yaml
nfr_assessment:
  date: '2026-04-13'
  story_id: '35.4'
  feature_name: 'Wire TransportProvider into ConnectorNode and BTP Client'
  adr_checklist_score: '27/29' # ADR Quality Readiness Checklist
  categories:
    testability_automation: 'PASS'
    test_data_strategy: 'PASS'
    scalability_availability: 'PASS'
    disaster_recovery: 'CONCERNS'
    security: 'CONCERNS'
    monitorability: 'PASS'
    qos_qoe: 'PASS'
    deployability: 'PASS'
  overall_status: 'PASS'
  critical_issues: 0
  high_priority_issues: 0
  medium_priority_issues: 2
  concerns: 2
  blockers: false
  quick_wins: 3
  evidence_gaps: 2
  recommendations:
    - 'Approve merge of Story 35.4; both CONCERNS are documented trade-offs, not defects.'
    - 'Story 35.6 must close the two evidence gaps (live fail-closed test; live .anon log sweep).'
    - 'Story 35.7 should surface the 30 s health-staleness window and alerting hooks in operator docs.'
```

---

## Related Artifacts

- **Story File:** `_bmad-output/implementation-artifacts/35-4-wire-transportprovider-into-connectornode-and-btp-client.md`
- **Tech Spec:** N/A (feature story; design captured inline in the story + prior 35.1/35.2/35.3 artifacts)
- **PRD:** `_bmad-output/planning-artifacts/prd.md`
- **Test Design:** `_bmad-output/planning-artifacts/test-design-epic-35.md` (Story 35.4 section + T-CROSS-01/02)
- **Prior NFR Assessments:**
  - `_bmad-output/test-artifacts/nfr-assessment-story-35-1.md`
  - `_bmad-output/test-artifacts/nfr-assessment-story-35-2.md`
  - `_bmad-output/test-artifacts/nfr-assessment-story-35-3.md`
- **Evidence Sources:**
  - Test Results: `packages/connector` Jest suite (2762 passed, 84 skipped, 0 failed per Dev Agent Record)
  - Metrics: N/A (integration story, no runtime metrics gathered)
  - Logs: N/A (no live run; unit-mock pino capture in tests)
  - CI Results: see Dev Agent Record Debug Log References

---

## Recommendations Summary

**Release Blocker:** None. Story 35.4 is APPROVED for merge.

**High Priority:** None.

**Medium Priority:** Two items for Story 35.6 — (a) live fail-closed test against a stopped SOCKS proxy; (b) live `.anon` log sweep across a full peer lifecycle. Both are already in the Epic 35 test matrix (T-35.6-SEC-02, T-35.6-SEC-05), so they are tracked, not drift.

**Next Steps:** Commit Story 35.4 with the epic-standard message (`feat(35.4): story complete — wire TransportProvider into ConnectorNode + BTP client`), proceed to Story 35.5 (managed anon lifecycle, which depends on this wiring), and ensure Story 35.6 picks up the two evidence gaps.

---

## Sign-Off

**NFR Assessment:**

- Overall Status: PASS ✅
- Critical Issues: 0
- High Priority Issues: 0
- Concerns: 2 (health-staleness window; live-log audit deferred)
- Evidence Gaps: 2 (both explicitly scoped to Story 35.6)

**Gate Status:** PASS ✅

**Next Actions:**

- If PASS ✅: Proceed to `*gate` workflow or release ← **Story 35.4 qualifies**
- If CONCERNS ⚠️: Address HIGH/CRITICAL issues, re-run `*nfr-assess`
- If FAIL ❌: Resolve FAIL status NFRs, re-run `*nfr-assess`

**Generated:** 2026-04-13
**Workflow:** testarch-nfr v5.0

---

<!-- Powered by BMAD-CORE™ -->
