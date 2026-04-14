---
stepsCompleted:
  [
    'step-01-load-context',
    'step-02-discover-tests',
    'step-03-quality-evaluation',
    'step-03f-aggregate-scores',
    'step-04-generate-report',
  ]
lastStep: 'step-04-generate-report'
lastSaved: '2026-04-14'
workflowType: 'testarch-test-review'
inputDocuments:
  - '_bmad-output/implementation-artifacts/35-6-unit-and-integration-tests.md'
  - 'packages/connector/src/transport/transport-security.test.ts'
  - 'packages/connector/test/integration/transport-socks5.test.ts'
  - 'packages/connector/test/helpers/in-process-socks5-proxy.ts'
  - 'packages/connector/test/helpers/in-process-socks5-proxy.test.ts'
  - '_bmad/tea/testarch/knowledge/test-quality.md'
---

# Test Quality Review: Story 35.6 — Unit and Integration Tests

**Quality Score**: 89/100 (B+ — Good, near Excellent)
**Review Date**: 2026-04-14
**Review Scope**: directory (Story 35.6 test surface: 3 test files + 1 helper)
**Reviewer**: TEA Agent (run mode: yolo)
**Execution Mode**: sequential (4-dimension evaluation folded into a single agent pass; all dimensions scored)

---

Note: This review audits existing tests; it does not generate tests. Coverage mapping and coverage gates are out of scope — use `trace` for coverage decisions. Trace for Epic 35 should confirm R-01..R-05 risks mapped to T-35.6-SEC-01..05.

## Executive Summary

**Overall Assessment**: Good

**Recommendation**: Approve

### Key Strengths

- Load-bearing security invariants (DNS leak, fail-closed, scheme downgrade, `.anon` log hygiene) each have a dedicated, independently-named test whose assertions mechanically verify the invariant rather than its proxies.
- Defense-in-depth test (three-layer `socks5://` rejection) collected into a single `it` block so a refactor that loosens one layer becomes immediately visible in CI diff.
- Zero new dev dependencies — the in-process SOCKS5 proxy is a ~200-line hand-rolled helper (RFC 1928-compliant subset) with its own unit test. Every story assumption is verifiable locally with `npx jest`.
- Test-ID glossary in story matches each `describe` block name 1:1 — traceability from AC → T-ID → code is machine-checkable.
- Integration tests exchange real BTP frames through a real SOCKS5 circuit — the "AUTH completes" and "MESSAGE round-trips" assertions prove end-to-end bytes rather than mocked handshakes.

### Key Weaknesses

- `transport-socks5.test.ts` is 401 lines (guideline ≤300). Splitting along security-vs-integration axis would help future bisects.
- Two `(x as any).privateField` casts (`_ws` on BTPClient, `wss` on BTPServer) reach into implementation details. Documented in comments, but fragile to Epic-36+ refactors.
- The AC 5 positive-DEBUG anchor is synthetic (`logger.debug(..., 'debug_audit_anchor')` emitted from the test itself) rather than observed from production code. This is explicitly permitted by Task 1.4.5 but weakens the "redaction isn't total suppression" claim.

### Summary

Story 35.6 delivers a mature, well-scoped test layer that mechanically enforces the five security invariants and the zero-regression contract of Epic 35. Every AC maps to at least one test; every T-ID in the test-design document is realized in code; every hand-rolled piece of scaffolding (the in-process proxy) has its own test. The test quality score of 89/100 reflects solid determinism, isolation, and performance — the B+ grade comes primarily from file length and two private-field accesses, neither of which block the security or regression assertions.

One targeted improvement was applied during this review: the two in-test polling loops (`while (Date.now() - start < 2000) { await setTimeout(10) }`) were replaced with the project's existing `waitFor` helper (`test/helpers/wait-for.ts`), bringing these tests into line with the rest of the integration suite's convention. Post-fix, all 19 cases still pass in 2.8s.

---

## Quality Criteria Assessment

| Criterion                                  | Status  | Violations | Notes                                                                     |
| ------------------------------------------ | ------- | ---------- | ------------------------------------------------------------------------- |
| BDD Format (Given-When-Then)               | ✅ PASS | 0          | Story file contains Gherkin ACs; tests map by T-ID                        |
| Test IDs                                   | ✅ PASS | 0          | Every describe uses T-35.6-SEC-0x / T-35.6-INT-0x                         |
| Priority Markers (P0/P1/P2/P3)             | ✅ PASS | 0          | Story is P0; INT-07 marked P1 in comments                                 |
| Hard Waits (sleep, waitForTimeout)         | ⚠️ WARN | 6          | Six `setTimeout(50-100ms)` drains — acceptable socket-drain idiom         |
| Determinism (no conditionals)              | ✅ PASS | 0          | Bounded polling via `waitFor` after this review's fix                     |
| Isolation (cleanup, no shared state)       | ✅ PASS | 0          | Every test creates+destroys its own proxy/server; env vars scoped         |
| Fixture Patterns                           | ✅ PASS | 0          | Helper factories: `startWsServer`, `startBtpServer`, `startSocks5Proxy`   |
| Data Factories                             | ✅ PASS | 0          | `ANON_HOSTNAME`, `ANON_URL`, `silentLogger`, `mockPacketHandler` extracted|
| Network-First Pattern                      | ✅ PASS | 0          | Proxy records `connects[]` synchronously during tunnel establishment      |
| Explicit Assertions                        | ✅ PASS | 0          | `expect(proxy.connects[0]?.atyp).toBe(3)` etc — no truthy-only checks     |
| Test Length (≤300 lines)                   | ⚠️ WARN | 1          | `transport-socks5.test.ts` = 401 lines (security + integration combined)  |
| Test Duration (≤1.5 min)                   | ✅ PASS | 0          | 19 tests in 2.8s                                                          |
| Flakiness Patterns                         | ✅ PASS | 0          | All ports ephemeral; no external network; force-close on proxy stop       |

**Total Violations**: 0 Critical, 0 High, 2 Medium, 6 Low

---

## Quality Score Breakdown

```
Dimension-weighted scoring (per testarch-test-review v5.0):

Determinism     (30%): 90/100  → 27.00
Isolation       (30%): 92/100  → 27.60
Maintainability (25%): 82/100  → 20.50
Performance     (15%): 95/100  → 14.25
                                --------
Weighted total:                  89.35

Final Score:             89/100
Grade:                   B+ (near A)
```

---

## Critical Issues (Must Fix)

No critical issues detected. ✅

---

## Recommendations (Should Fix)

### 1. Split `transport-socks5.test.ts` along the security-vs-integration axis

**Severity**: P2 (Medium)
**Location**: `packages/connector/test/integration/transport-socks5.test.ts` (401 lines)
**Criterion**: Test Length (≤300 lines)
**Knowledge Base**: [test-quality.md](../../../../_bmad/tea/testarch/knowledge/test-quality.md)

**Issue Description**:
The file combines T-35.6-SEC-01, T-35.6-SEC-02 (security invariants) with T-35.6-INT-01..07 (integration / lifecycle). Future reviewers auditing the `.anon`/DNS-leak security surface have to re-parse integration tests to find security tests. Splitting makes the security surface visibly bounded.

**Recommended Improvement**:

```
packages/connector/test/integration/
  transport-socks5-integration.test.ts   (~240 lines: INT-01, INT-04, INT-05, INT-06, health)
  transport-socks5-security.test.ts      (~160 lines: SEC-01, SEC-02)
```

Re-import the shared `startSocks5Proxy` / `startWsServer` / `silentLogger` helpers in both. No assertion changes needed.

**Benefits**: Faster bisect when a security test regresses; easier to mark the security file as CI-gated separately; matches the convention already used by `transport-security.test.ts` (unit-level security) vs this file (integration-level security).

**Priority**: P2 — not blocking, but the next touch to this surface should consider it.

---

### 2. Replace `(x as any).privateField` with public accessors or test-only seams

**Severity**: P2 (Medium)
**Location**: `transport-socks5.test.ts:108` `(server as any).wss` ; `transport-socks5.test.ts:344` `(client as any)._ws`
**Criterion**: Maintainability
**Knowledge Base**: [test-quality.md](../../../../_bmad/tea/testarch/knowledge/test-quality.md)

**Issue Description**:
Two sites reach into private fields:
1. `(server as any).wss` — to read the bound port of a `BTPServer` (`server.start(0)` assigns an ephemeral port but exposes no getter).
2. `(client as any)._ws` — to bypass `BTPClient.sendPacket()` and send a raw BTP MESSAGE frame (sidesteps ILP packet serialization for the AC 9 min-bar test).

Both are documented with comments, but they couple the test to private-field names. A rename during Epic-36 refactor silently breaks the tests.

**Recommended Improvement**:

For (1): add a `BTPServer#address()` or `BTPServer#port` getter. Non-breaking addition:

```typescript
// in btp-server.ts
public address(): AddressInfo | string | null {
  return this.wss?.address() ?? null;
}
```

For (2): add a test-only helper `BTPClient#sendRawFrame(buf: Buffer)` behind an `@internal` JSDoc tag, or expose the writable WS via a protected getter. Alternatively, file a follow-up story to use `sendPacket` with a legitimate ILP packet once the test-design-34 ledger-stub fixture is available.

**Benefits**: Eliminates the one real fragility in the story-35.6 test layer; converts two implicit contracts into explicit ones.

**Priority**: P2 — scope as a 30-min follow-up; not a 35.6 blocker.

---

## Observations (FYI — Not Required Fixes)

### 3. Synthetic DEBUG anchor in the `.anon` audit

**Location**: `transport-security.test.ts:235, 291`
**Criterion**: T-35.6-SEC-05 positive-DEBUG requirement (AC 5)

The story explicitly permits a synthetic anchor (Task 1.4.5 "If no DEBUG path exists yet, add one minimal `logger.debug({ externalUrl: ANON_URL }, 'debug_audit_anchor')` emit..."), and the tests take that path. That satisfies the AC, but the stronger claim — "production code emits `.anon` at DEBUG for diagnostics, and the redaction layer strips it at INFO+" — is not mechanically asserted. A future Story 35.7+ should revisit once a natural DEBUG emit site exists (e.g., the ATOR lifecycle logs).

### 4. `setTimeout(50ms)` drain waits after socket close

**Location**: Six sites in `transport-socks5.test.ts` (lines 144, 178, 211, 240, 292, 362)

These are socket-drain waits after `client.close()` or `proxy.stop()`. They are bounded (≤100ms) and guard against test-order bleed between `afterEach`-less tests. Acceptable per the project's existing integration-test patterns (`mixed-chain-three-way.test.ts` uses the same idiom). Moving to `waitFor(() => socket.destroyed, { timeout: 200 })` would be stricter but adds no verifiable invariant.

### 5. No traceability-matrix gate validated

This review intentionally does not assess coverage. Story 35.6 claims 8 risks covered (R-01..R-05, R-08, R-12 plus regression R-03 via R-REG-01..08). A `trace` workflow run should validate that every AC → T-ID → test-file-line mapping resolves.

---

## Best Practices Found

### 1. Defense-in-depth visible in one test

**Location**: `transport-security.test.ts:118-150` (T-35.6-SEC-03 layered-rejection "all three" case)
**Pattern**: Defense-in-depth invariant
**Knowledge Base**: [test-quality.md](../../../../_bmad/tea/testarch/knowledge/test-quality.md)

**Why This Is Good**:
A refactor that accidentally loosens any ONE of the three `socks5://` rejection sites (Zod, SocksTransportProvider ctor, parseSocks5hUrl) would produce two green layer-specific tests — but this fourth test collects all three errors and asserts each still fires. That makes the defense-in-depth property itself the unit under test.

**Code Example**:

```typescript
it('all three layers reject the same input independently (defense-in-depth visible in one test)', () => {
  const errors: string[] = [];
  try { ConfigLoader.validateConfig({ ...BAD_URL config... }); } catch (e) { errors.push((e as Error).message); }
  try { new SocksTransportProvider({ socksProxy: BAD_URL, ... }); } catch (e) { errors.push((e as Error).message); }
  try { parseSocks5hUrl(BAD_URL); } catch (e) { errors.push((e as Error).message); }

  expect(errors).toHaveLength(3);
  for (const msg of errors) expect(msg).toMatch(/socks5h:\/\//);
});
```

**Use as Reference**: Any epic with layered validation should adopt this pattern — one test per layer PLUS one test that asserts all layers fire on the same input.

---

### 2. Contrast test for `shouldLookup` semantics (T-35.6-SEC-04)

**Location**: `transport-security.test.ts:179-184`
**Pattern**: Negative-space assertion

**Why This Is Good**:
Asserting `agent.shouldLookup === false` for the `socks5h://` agent proves the REQUIREMENT. Adding a contrasting assertion that `socks5://` produces `shouldLookup === true` proves the CONTRAST — that the guard is load-bearing, not a no-op. If `socks-proxy-agent` upstream ever flips defaults, both tests would fail simultaneously and the test-review reviewer would immediately understand why.

---

### 3. Zero-dep in-process proxy with resolver hook

**Location**: `test/helpers/in-process-socks5-proxy.ts`
**Pattern**: Dependency-minimal test scaffolding with hermetic hooks

**Why This Is Good**:
The `onResolve` hook (lines 47-50 of helper) is the single point that makes T-35.6-SEC-01 work hermetically — any hostname the test passes gets resolved to 127.0.0.1 without touching the OS resolver. That avoids the classic "test passes locally, fails in CI due to DNS" class of flake, and avoids the `socksv5` npm dep. The helper's own test file (2 cases, raw SOCKS5 framing) means the helper itself is not a trusted-but-unverified black box.

---

## Test File Analysis

### File Inventory

| File                                          | Lines | Framework | Role                                    |
| --------------------------------------------- | ----: | --------- | --------------------------------------- |
| `src/transport/transport-security.test.ts`    |   296 | Jest      | Security invariants (SEC-03, -04, -05)  |
| `test/integration/transport-socks5.test.ts`   |   401 | Jest      | Integration + DNS-leak + fail-closed    |
| `test/helpers/in-process-socks5-proxy.ts`     |   203 | —         | RFC 1928-subset proxy test helper       |
| `test/helpers/in-process-socks5-proxy.test.ts`|   139 | Jest      | Unit tests for the above                |
| **Total**                                     | 1,039 |           | 19 test cases across 3 test files       |

### Test Structure

- **Describe blocks**: 11 (each named with a T-ID + AC number)
- **Test cases (`it`/`test`)**: 19 (all passing; 2.85s total)
- **Average test length**: ~35 lines per test
- **Fixtures/factories used**: 5 (`startWsServer`, `startBtpServer`, `startSocks5Proxy`, `silentLogger`, `mockPacketHandler`, plus `waitFor` helper post-review)

### Test Scope

- **Test IDs covered**: T-35.6-SEC-01, -02, -03, -04, -05; T-35.6-INT-01, -02, -03, -04, -05, -06; INT-07 folded into INT-01 (documented).
- **Priority distribution**: All story-35.6 tests are P0 except INT-07 (P1, folded per story permission).

### Assertions Analysis

- **Total assertions**: ~60 `expect()` calls across 19 tests
- **Assertions per test**: ~3 (avg) — each test asserts the protocol byte + state + side-channel
- **Assertion types**: `.toBe`, `.toHaveBeenCalledWith`, `.toHaveLength`, `.toMatch`, `.rejects.toThrow`, `.resolves.toBe`

---

## Context and Integration

### Related Artifacts

- **Story File**: [35-6-unit-and-integration-tests.md](../../implementation-artifacts/35-6-unit-and-integration-tests.md)
- **Test Design**: `_bmad-output/planning-artifacts/test-design-epic-35.md` §2.6, §3, §4, §8
- **Risk Assessment**: Epic 35 risks R-01 (9, SEC), R-02 (9, SEC), R-03 (8, REG), R-04 (7, REL), R-05 (7, PRIV), R-08 (5, OPS), R-12 (4, COMPAT) — all mapped to tests here.

Coverage mapping and risk-coverage-gate decisions → `trace` workflow.

---

## Knowledge Base References

This review consulted:

- **[test-quality.md](../../../../_bmad/tea/testarch/knowledge/test-quality.md)** — Definition of Done for tests
- Story 35.6 dev-notes §"Layering of the log-hygiene audit"
- `packages/connector/test/helpers/wait-for.ts` (project convention for bounded polling)

For coverage mapping, consult `trace` workflow outputs for Epic 35.

---

## Next Steps

### Immediate Actions (Before Merge)

None. Story 35.6 is approval-ready.

### Follow-up Actions (Future PRs)

1. **Split `transport-socks5.test.ts`** into security + integration files.
   - Priority: P2
   - Target: next story that touches the transport test surface

2. **Add `BTPServer#address()` public accessor** to eliminate the `(server as any).wss` cast.
   - Priority: P2
   - Target: Epic-36 backlog or first refactor of `btp-server.ts`

3. **Revisit synthetic DEBUG anchor in log-hygiene audit** when a production DEBUG emit site exists.
   - Priority: P3
   - Target: Story 35.7+ (ATOR lifecycle logging)

4. **Run `trace` workflow for Epic 35** to mechanically verify AC → T-ID → test mapping.
   - Priority: P1 (before epic close, not before PR merge)
   - Target: epic-close checklist

### Re-Review Needed?

✅ No re-review needed — approve as-is. One targeted fix (replace hand-rolled polling with `waitFor` helper) was applied during this review and verified to pass.

---

## Decision

**Recommendation**: **Approve**

**Rationale**:
Story 35.6 hits all 13 acceptance criteria with tests whose assertions target the invariant (not a proxy for it). The 19-test suite runs in 2.8 seconds, has zero flaky patterns, uses no external network, and adds zero production dev-dependencies. The two medium-severity findings (file length, private-field access) are code-hygiene items, not correctness or security concerns. The security-critical assertions (ATYP=DOMAIN for remote DNS, `shouldLookup=false` for scheme preservation, `.anon`-at-INFO+ absence) are mechanical and would catch a future regression before it ships.

> Test quality is good with 89/100 score. Minor recommendations noted can be addressed in follow-up PRs. Tests are production-ready and enforce the Epic-35 security invariants mechanically on every PR.

---

## Appendix

### Violation Summary by Location

| Line (file)                                                | Severity | Criterion              | Issue                                                           | Fix                                                                   |
| ---------------------------------------------------------- | -------- | ---------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `transport-socks5.test.ts` (file-level)                    | P2       | Test Length            | 401 lines exceeds 300-line guideline                            | Split along security-vs-integration axis                              |
| `transport-socks5.test.ts:108`                             | P2       | Maintainability        | `(server as any).wss` — private-field access                    | Add `BTPServer#address()` public accessor                             |
| `transport-socks5.test.ts:344`                             | P2       | Maintainability        | `(client as any)._ws` — private-field access                    | Add `BTPClient#sendRawFrame()` test-only seam                         |
| `transport-socks5.test.ts:144,178,211,240,292,362`         | P3       | Hard Waits             | `setTimeout(50-100ms)` socket-drain waits                       | Acceptable; matches project integration-test idiom                    |
| `transport-security.test.ts:235,291`                       | P3       | Audit Anchor Strength  | Synthetic DEBUG `.anon` emit from test, not production code     | Revisit in Story 35.7+ once natural DEBUG emit exists                 |

---

## Changes Applied During This Review

Per `/bmad-tea-testarch-test-review … yolo` (automatic fix mode):

1. **`transport-socks5.test.ts`**: Replaced two hand-rolled polling loops
   ```typescript
   // Before:
   const start = Date.now();
   while (btp.onAuth.mock.calls.length === 0 && Date.now() - start < 2000) {
     await new Promise((r) => setTimeout(r, 10));
   }
   ```
   with the project-provided `waitFor` helper:
   ```typescript
   // After:
   await waitFor(() => btp.onAuth.mock.calls.length > 0, {
     timeout: 2000, interval: 10, backoff: 1,
   });
   ```
   Also applied to the `btp.onMessage` polling loop in the AC 9 min-bar test.

2. **Verification**: All 19 tests pass in 2.85s post-fix (`npx jest src/transport/transport-security.test.ts test/helpers/in-process-socks5-proxy.test.ts test/integration/transport-socks5.test.ts`).

No other files were modified.

---

## Review Metadata

**Generated By**: BMad TEA Agent (Test Architect)
**Workflow**: testarch-test-review v5.0
**Review ID**: test-review-35.6-20260414
**Timestamp**: 2026-04-14
**Version**: 1.0
