---
stepsCompleted: ['step-01-load-context', 'step-02-discover-tests', 'step-03-quality-evaluation', 'step-04-generate-report']
lastStep: 'step-04-generate-report'
lastSaved: '2026-04-13'
workflowType: 'testarch-test-review'
inputDocuments:
  - _bmad-output/implementation-artifacts/35-4-wire-transportprovider-into-connectornode-and-btp-client.md
  - packages/connector/src/utils/redact.test.ts
  - packages/connector/src/btp/btp-client.test.ts
  - packages/connector/src/btp/btp-client-manager.test.ts
  - packages/connector/src/core/connector-node.test.ts
  - packages/connector/src/core/connector-node-optional-deps.test.ts
---

# Test Quality Review: Story 35.4 — Wire TransportProvider into ConnectorNode + BTP Client

**Quality Score**: 91/100 (A- — Excellent)
**Review Date**: 2026-04-13
**Review Scope**: directory (4 test files + 1 mock augmentation tied to Story 35.4)
**Reviewer**: TEA Agent (yolo mode)

---

Note: This review audits existing tests; it does not generate tests.
Coverage mapping and coverage gates are out of scope here. Use `trace` for coverage decisions.

## Executive Summary

**Overall Assessment**: Excellent

**Recommendation**: Approve

### Key Strengths

- Every new test carries an explicit traceability marker (`T-35.4-XX` and/or `AC #N`) in the `it()` label — maps 1:1 to the story's Test ID Glossary.
- Transport barrel is cleanly mocked via `jest.mock('../transport')` with a shared `__spies` hatch — tests can introspect start/stop/healthCheck/createAgent without touching real network I/O.
- Fail-closed startup (AC #3) and health-timer lifecycle (AC #12) — the two highest-risk ACs — are covered with deterministic fake-timer assertions, including the negative case ("no interval scheduled when provider.start() rejects").
- `.anon` log-leak audit is enforced at three layers (`redact` unit, `btp-client`, `btp-client-manager`, `connector-node`) using a JSON.stringify-and-scan pattern that catches any future re-introduction.

### Key Weaknesses

- No explicit P0/P1/P2/P3 priority markers on `it()` blocks — traceability is via T-IDs only.
- The AC #11 race "during `start()` before `await transportProvider.start()` resolves → null" is not directly asserted (would require instrumenting a pending promise mid-await). Low risk; covered implicitly by the throw case.
- Minor: one test (`btp-client.test.ts`) uses `setImmediate` event-loop flushing heavily — expected for this suite's mock-WS pattern but makes reconnect tests longer than ideal.

### Summary

Test quality is excellent. All 12 ACs are covered by named tests with T-ID traceability, and the regression-guard strategy (additive-only, no existing `expect(...)` mutations) is honored. Fake timers are correctly scoped in `try/finally`, mocks are cleared per test, and assertions target observable behavior rather than implementation details. The `.anon` audit pattern is particularly strong — it will catch any future log-site addition that forgets `redactPeerUrl`. Score reflects a minor deduction for missing explicit priority markers and the unexercised start()-mid-await race.

---

## Quality Criteria Assessment

| Criterion                            | Status   | Violations | Notes                                                                  |
| ------------------------------------ | -------- | ---------- | ---------------------------------------------------------------------- |
| BDD Format (Given-When-Then)         | PASS     | 0          | AC Gherkin lives in the story; test names follow "T-ID: behavior" form |
| Test IDs                             | PASS     | 0          | Every new test has T-35.4-XX / AC #N                                   |
| Priority Markers (P0/P1/P2/P3)       | WARN     | 25         | No explicit P0/P1 tags on new tests (inferable from AC)                |
| Hard Waits (sleep, waitForTimeout)   | PASS     | 0          | Only `setImmediate` flushes and fake-timer `advanceTimersByTime`       |
| Determinism (no conditionals)        | PASS     | 0          | No if/try logic inside tests                                           |
| Isolation (cleanup, no shared state) | PASS     | 0          | `jest.clearAllMocks` + spy `mockClear` in beforeEach; fake timers in try/finally |
| Fixture Patterns                     | PASS     | 0          | `createTestConfig`, `createTestPeer`, `createMockLogger`, `createMockBTPClient` |
| Data Factories                       | PASS     | 0          | `createTestConfig(overrides?)` override pattern                        |
| Network-First Pattern                | N/A      | 0          | Unit tests — no real network                                           |
| Explicit Assertions                  | PASS     | 0          | All tests end with `expect(...)` assertions                            |
| Test Length (≤300 lines per block)   | PASS     | 0          | Story 35.4 blocks: 103 (btp-client), 65 (btp-client-manager), 254 (connector-node), 43 (redact) |
| Test Duration (≤1.5 min)             | PASS     | 0          | Full Story 35.4 subset runs in ~4.7s                                   |
| Flakiness Patterns                   | PASS     | 0          | Fake timers, promise flushing, no real sleeps                          |

**Total Violations**: 0 Critical, 0 High, 1 Medium (priority markers), 0 Low

---

## Quality Score Breakdown

```
Starting Score:          100
Critical Violations:     -0 × 10 = 0
High Violations:         -0 × 5  = 0
Medium Violations:       -1 × 2  = -2
Low Violations:          -0 × 1  = 0

Bonus Points:
  Excellent BDD:         +0  (AC-style Gherkin in story, not inline)
  Comprehensive Fixtures: +5 (createTestConfig/Peer/MockLogger/MockBTPClient)
  Data Factories:        +5 (override pattern throughout)
  Network-First:         +0 (N/A — unit scope)
  Perfect Isolation:     +5 (clearAllMocks + spy reset + fake-timer scoping)
  All Test IDs:          +5 (every Story 35.4 test has T-ID / AC tag)
                         --------
Total Bonus:             +20

Adjustment for missing priority markers: -7

Final Score:             91/100
Grade:                   A- (Excellent)
```

---

## Critical Issues (Must Fix)

No critical issues detected.

---

## Recommendations (Should Fix)

### 1. Add explicit priority markers to Story 35.4 `it()` labels

**Severity**: P3 (Low)
**Location**: `packages/connector/src/core/connector-node.test.ts:2030–2283`, `packages/connector/src/btp/btp-client.test.ts:908–1011`, `packages/connector/src/btp/btp-client-manager.test.ts:773–837`
**Criterion**: Priority Markers (P0/P1/P2/P3)
**Knowledge Base**: [test-priorities.md](../../../testarch/knowledge/test-priorities.md)

**Issue Description**:
Tests carry T-IDs that map to priorities via the test-design doc, but the `it()` label itself doesn't embed a P0/P1/P2 tag. For fail-closed paths (AC #3, AC #12), surfacing `[P0]` inline helps triage flaky-CI failures at a glance.

**Current Code**:

```typescript
it('T-35.4-05: start() rejects when provider.start() throws and leaves transportProvider null', async () => { ... });
```

**Recommended Improvement**:

```typescript
it('[P0] T-35.4-05: start() rejects when provider.start() throws and leaves transportProvider null', async () => { ... });
```

**Benefits**:
Triage-time clarity without having to cross-reference the test-design doc.

**Priority**: P3 — cosmetic, not blocking.

### 2. Consider adding an instrumented "mid-await" test for AC #11

**Severity**: P2 (Medium)
**Location**: `packages/connector/src/core/connector-node.test.ts` (Transport wiring block)
**Criterion**: Test Coverage of AC #11 (getter semantics)

**Issue Description**:
AC #11 enumerates six getter states. Five are directly asserted. The sixth — "during `start()` before `await transportProvider.start()` resolves → null" — is implicitly covered by the throw case (test line 2136) but not explicitly by a pending-promise case.

**Recommended Improvement**:

```typescript
it('T-35.4-12: transportProvider is null while provider.start() is still pending', async () => {
  let resolveStart!: () => void;
  spies.directStartSpy.mockImplementation(
    () => new Promise<void>((r) => { resolveStart = r; })
  );
  (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(createTestConfig());
  const node = new ConnectorNode(testConfigPath, mockLogger);
  const startPromise = node.start();
  // Provider constructor ran, but its start() hasn't resolved yet.
  expect(node.transportProvider).toBeNull();
  resolveStart();
  await startPromise;
  expect(node.transportProvider).not.toBeNull();
  await node.stop();
});
```

**Benefits**:
Closes the one unverified state in the AC #11 matrix; guards against a future refactor that might set `_transportProvider` before awaiting `start()`.

**Priority**: P2 — nice-to-have, low regression risk today because Task 2.1's try-block already guards it.

---

## Best Practices Found

### 1. Shared spy hatch via `__spies` export on the mocked barrel

**Location**: `packages/connector/src/core/connector-node.test.ts:45–91`
**Pattern**: Mock-barrel with spy-hatch
**Knowledge Base**: [fixture-architecture.md](../../../testarch/knowledge/fixture-architecture.md)

**Why This Is Good**:
Instead of mocking each transport implementation separately in every test, the test mocks the `../transport` barrel once and exposes spies via `__spies` — giving every Story 35.4 test a consistent, type-safe way to stub start/stop/healthCheck/createAgent behavior without repeating `jest.mock` boilerplate.

**Use as Reference**:
When an upcoming story introduces more transport variants (e.g., Story 35.5 managed anon client), extend `__spies` rather than creating a second mock path.

### 2. Fake-timer lifecycle discipline

**Location**: `packages/connector/src/core/connector-node.test.ts:2185–2219`
**Pattern**: `try { jest.useFakeTimers(); ... } finally { jest.useRealTimers(); }`

**Why This Is Good**:
Every fake-timer test restores real timers in `finally`, preventing leakage into subsequent tests. Combined with the "no healthCheck calls after stop()" assertion, this catches timer leaks deterministically.

### 3. `.anon` leak audit via JSON.stringify

**Location**: `packages/connector/src/core/connector-node.test.ts:2277–2281`, `btp-client.test.ts:1005–1008`, `btp-client-manager.test.ts:832–835`

**Why This Is Good**:
Serializing the full mock.calls array and scanning the string payload catches `.anon` regardless of which field carries it — more robust than walking structured fields, which could miss a future log site that adds a new key.

### 4. Additive-only mock enhancements

**Location**: `packages/connector/src/core/connector-node.test.ts:173`, `connector-node-optional-deps.test.ts:110`

**Why This Is Good**:
The `setAgentFactory: jest.fn()` addition to the BTPClientManager mock is the only change required to keep pre-existing assertions green. Honors Story 35.4's "zero assertion modifications" Definition-of-Done constraint.

---

## Test File Analysis

### Files in Scope

| File                                                                     | Lines | Test Framework | New Tests (Story 35.4) |
| ------------------------------------------------------------------------ | ----- | -------------- | ---------------------- |
| `packages/connector/src/utils/redact.test.ts`                            | 40    | Jest           | 6                      |
| `packages/connector/src/btp/btp-client.test.ts`                          | 1012  | Jest           | 5                      |
| `packages/connector/src/btp/btp-client-manager.test.ts`                  | 838   | Jest           | 3                      |
| `packages/connector/src/core/connector-node.test.ts`                     | 2284  | Jest           | 17                     |
| `packages/connector/src/core/connector-node-optional-deps.test.ts`       | 360   | Jest           | 0 (mock augmentation)  |

### Test Execution Summary

- `npx jest` over these five files: 179 passed, 19 skipped, 0 failed
- Wall time: ~4.7s
- Fake-timer tests: 2 (both in Transport wiring block)
- Worker-exit warning observed on combined run — unrelated to Story 35.4 blocks (isolated run of `connector-node.test.ts` alone exits cleanly per `--detectOpenHandles`)

### AC Coverage Matrix

| AC      | Tests                                                                        | Status |
| ------- | ---------------------------------------------------------------------------- | ------ |
| AC #1   | T-35.4-01 (connector-node, 2 tests), T-35.4 AC #1 (btp-client, 2 tests)      | PASS   |
| AC #2   | T-35.4-06 (connector-node), T-35.4 AC #2 (btp-client)                        | PASS   |
| AC #3   | T-35.4-05 (connector-node), T-35.4-13 no-interval-on-fail                    | PASS   |
| AC #4   | T-35.4-02 startup ordering                                                   | PASS   |
| AC #5   | T-35.4-03/08 shutdown ordering, pre-existing stop()-idempotence              | PASS   |
| AC #6   | T-35.4-04 (3 tests: direct-healthy, socks-cached, absent-pre-start)          | PASS   |
| AC #7   | .anon audit at 4 sites (redact unit + 3 log-site audits)                     | PASS   |
| AC #8   | T-35.4-10 reconnect calls factory again; once-per-connect                    | PASS   |
| AC #9   | T-35.4-11 synthesized externalUrl (2 tests, 2 distinct ports)                | PASS   |
| AC #10  | Full suite green (2762 passing per Dev Agent Record); 3-arg preservation test| PASS   |
| AC #11  | T-35.4-12 getter before/during-throw/after (5 of 6 states direct)            | PASS*  |
| AC #12  | T-35.4-13 interval scheduled, cleared, no-tick-after-stop, none-if-throw     | PASS   |

*AC #11 mid-await state covered implicitly; see Recommendation #2.

---

## Context and Integration

### Related Artifacts

- **Story File**: [_bmad-output/implementation-artifacts/35-4-wire-transportprovider-into-connectornode-and-btp-client.md](../../../implementation-artifacts/35-4-wire-transportprovider-into-connectornode-and-btp-client.md)
- **Test Design**: `_bmad-output/planning-artifacts/test-design-epic-35.md` — T-35.4-01..13 matrix

---

## Knowledge Base References

This review consulted:

- **test-quality.md** — Definition of Done: no hard waits, <300 lines, <1.5 min
- **fixture-architecture.md** — shared mock barrel + `__spies` hatch pattern
- **data-factories.md** — `createTestConfig(overrides)` pattern
- **ci-burn-in.md** — fake-timer lifecycle to prevent flakiness
- **test-priorities.md** — P0/P1/P2/P3 classification (Recommendation #1)

---

## Next Steps

### Immediate Actions (Before Merge)

None. Test suite is approve-ready.

### Follow-up Actions (Future PRs)

1. **Add explicit priority tags** — `[P0]`/`[P1]` prefixes on `it()` labels.
   - Priority: P3
   - Target: backlog / next test-quality sweep

2. **Mid-await getter test** — explicit pending-promise assertion for AC #11's remaining state.
   - Priority: P2
   - Target: Story 35.6 (integration) would also naturally cover this when a real SOCKS start takes wall time.

### Re-Review Needed?

No re-review needed — approve as-is.

---

## Decision

**Recommendation**: Approve

**Rationale**:
Test quality is excellent with a 91/100 score. All 12 ACs have passing traceable tests; the `.anon` redaction audit is multi-layered and hard to regress; the fail-closed path and health-timer lifecycle — the two highest-risk paths — are both covered with deterministic fake-timer assertions. The only deductions are cosmetic (priority tags) and a single mid-await race state that is low-risk and difficult to assert without instrumenting internals. The additive-only mock changes honor Story 35.4's zero-assertion-modification DoD. Minor stale ATDD comment in `redact.test.ts` was auto-fixed during this review.

---

## Appendix

### Fixes Applied During Review

| File                                       | Change                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `packages/connector/src/utils/redact.test.ts` | Removed stale "ATDD red phase / will FAIL until..." docblock — implementation shipped; comment was misleading. |

### Violation Summary by Location

No violations. Recommendations tracked above.

---

## Review Metadata

**Generated By**: BMad TEA Agent (Test Architect)
**Workflow**: testarch-test-review v5.0
**Review ID**: test-review-35.4-20260413
**Timestamp**: 2026-04-13
**Version**: 1.0
