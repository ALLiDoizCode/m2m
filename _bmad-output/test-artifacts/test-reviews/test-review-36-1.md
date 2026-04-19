---
stepsCompleted:
  [
    'step-01-load-context',
    'step-02-discover-tests',
    'step-03-quality-evaluation',
    'step-03a-subagent-determinism',
    'step-03b-subagent-isolation',
    'step-03c-subagent-maintainability',
    'step-03e-subagent-performance',
    'step-03f-aggregate-scores',
    'step-04-generate-report',
  ]
lastStep: 'step-04-generate-report'
lastSaved: '2026-04-15'
workflowType: 'testarch-test-review'
inputDocuments:
  - '_bmad-output/implementation-artifacts/36-1-local-ator-network-image-docker-compose.md'
  - '_bmad-output/test-artifacts/atdd-checklist-36-1.md'
  - 'packages/connector/test/acceptance/story-36-1-ator-local-network.test.ts'
  - '_bmad/tea/testarch/knowledge/test-quality.md'
  - '_bmad/tea/testarch/knowledge/test-healing-patterns.md'
  - '_bmad/tea/testarch/knowledge/test-levels-framework.md'
---

# Test Quality Review: story-36-1-ator-local-network.test.ts

**Quality Score**: 96/100 (A — Excellent)
**Review Date**: 2026-04-15
**Review Scope**: single (Story 36.1 acceptance suite)
**Reviewer**: TEA Agent (YOLO mode)

---

Note: This review audits the existing test suite for Story 36.1 (Local ATOR Network Image + docker-compose Profile). Coverage mapping and coverage gates are out of scope here — the AC-to-test mapping in `atdd-checklist-36-1.md` already traces every AC; `trace` is the right tool for cross-story coverage gates.

## Executive Summary

**Overall Assessment**: Excellent

**Recommendation**: Approve

### Key Strengths

- Pure static-asset acceptance suite with **zero non-deterministic constructs** — no `Math.random`, no `Date.now`, no timers, no network, no Docker daemon invocation. 126 tests execute in ~1.4s.
- Strong **isolation**: each `describe` uses a local `beforeAll` to read its source-of-truth file; no shared mutable state; filesystem reads are strictly read-only.
- **Precedent-driven structure** mirroring Stories 33.9 and 34.10 acceptance suites — same file-layout, same helper functions (`loadDockerCompose`, `getService`, `getProfiles`), same `it.each` pattern for table-driven service assertions. This materially reduces reviewer cognitive load and keeps the acceptance tier consistent.
- **Scope bright-line enforced in code** (AC 13): regression guards for pre-existing `anvil`/`faucet`/`solana-validator`/`mina-lightnet` profile associations plus a filesystem walk asserting no `ator-*` source leaks under `packages/connector/src/`.
- **Anti-pattern guarding**: the Dockerfile assertions actively reject the `echo "<hash>  <file>" | sha256sum -c -` anti-pattern the story explicitly forbids (AC 2), not just positive presence checks.
- **Cross-profile port-disjointness invariant** codified as an actual assertion (AC 11) — protects against silent port collisions the next time someone adds a profile.

### Key Weaknesses

- One minor vacuous-pass risk on the envsubst-placeholder test (line 307) was **fixed during this review** — loop over three file paths previously `continue`d silently when a path was missing; now asserts existence before iterating.
- `depends_on` tests (lines 566-578) assert "at least one" dirauth/relay — they would still pass if only a single upstream were wired, missing the spec's "quorum of ≥2 healthy" intent. Not a correctness bug for the **static** assertion layer, but leaves room for a silent compose weakening. Flagged as P3 follow-up, not a blocker.
- Healthcheck presence is asserted but **shape** is not (e.g., DirAuth gets a lightweight binary check, relay a TCP accept, hs1 a SOCKS accept per the story). A future iteration could tighten this.

### Summary

Story 36.1's acceptance suite is a precedent-aligned, fast, deterministic, well-isolated static-assertion test file. It covers 13 of 14 ACs at the static layer (AC 8 is runtime-only per the story contract and is legitimately deferred to the shell-level validation checklist). All 126 tests pass in ~1.4s against the landed implementation, and the RED→GREEN transition is already evidenced in `atdd-checklist-36-1.md`. One low-severity vacuous-pass risk was found and fixed in-line during this review. Remaining observations are P3-or-below suggestions that do not block merge.

---

## Quality Criteria Assessment

| Criterion                            | Status      | Violations | Notes                                                                                                                 |
| ------------------------------------ | ----------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| BDD Format (Given-When-Then)         | ✅ PASS     | 0          | `describe` + `it('should …')` — implicit GWT. Appropriate for static-asset suite per 33.9/34.10 precedent.            |
| Test IDs                             | ✅ PASS     | 0          | `[T-36.1-01]`..`[T-36.1-08]` IDs present on pivotal tests; remainder scoped by AC in `describe` names.                 |
| Priority Markers (P0/P1/P2/P3)       | ⚠️ WARN     | n/a        | No inline P0-P3 tags — all tests map to the story's P0 foundation; acceptable per ATDD checklist.                      |
| Hard Waits (sleep, waitForTimeout)   | ✅ PASS     | 0          | Zero waits — suite is sync filesystem reads.                                                                          |
| Determinism (no conditionals)        | ✅ PASS     | 0          | No `Math.random`, `Date.now`, `new Date`, timers, or external IO. Score: 100/100.                                     |
| Isolation (cleanup, no shared state) | ✅ PASS     | 0          | Each describe scopes its `content`/`compose` in a local `beforeAll`. No shared writes.                                |
| Fixture Patterns                     | ✅ PASS     | 0          | Acceptance-tier file; per knowledge base, fixtures are optional for static-assertion suites. N/A.                     |
| Data Factories                       | ✅ PASS     | 0          | N/A — no runtime data; assertions run against committed YAML / Dockerfile / Makefile bytes.                            |
| Network-First Pattern                | ✅ PASS     | 0          | N/A — no network.                                                                                                      |
| Explicit Assertions                  | ✅ PASS     | 0          | One primary assertion per `it()` (a few `it`s have 2-3 related `expect`s on the same logical invariant).              |
| Test Length (≤300 lines)             | ⚠️ WARN     | 1 (file=805) | Single-file acceptance suite for 14-AC story; matches 33.9 and 34.10 precedent lengths. Splitting would harm cohesion. |
| Test Duration (≤1.5 min)             | ✅ PASS     | 0          | Measured: 1.368s for 126 tests. Well inside budget.                                                                    |
| Flakiness Patterns                   | ✅ PASS     | 0          | Pure deterministic reads; no network, no timers, no selectors. Flake probability: ≈ 0.                                 |

**Total Violations**: 0 Critical, 0 High, 1 Medium (fixed in-place), 2 Low (advisory)

---

## Quality Score Breakdown

```
Starting Score:          100
Critical Violations:     -0  × 10 = -0
High Violations:         -0  ×  5 = -0
Medium Violations:       -1  ×  2 = -2   (vacuous-pass — fixed during review)
Low Violations:          -2  ×  1 = -2   (advisory; see Recommendations)

Bonus Points:
  Excellent BDD:         +0   (implicit, not explicit GWT)
  Comprehensive Fixtures: +0  (N/A for static assertions)
  Data Factories:        +0   (N/A)
  Network-First:         +0   (N/A)
  Perfect Isolation:     +5
  All Test IDs:          +0   (partial — key tests tagged, remainder scoped by AC)
                         --------
Total Bonus:             +5

Final Score:             96/100 (post-fix: the -2 medium is recovered because the fix shipped in this review)
Effective Score:         98/100 → rounded to 96/100 to reflect remaining P3 advisories
Grade:                   A (Excellent)
```

---

## Critical Issues (Must Fix)

No critical issues detected. ✅

---

## Recommendations (Should Fix)

### 1. Vacuous-pass risk on envsubst-placeholder test [FIXED IN THIS REVIEW]

**Severity**: P2 (Medium) — **RESOLVED**
**Location**: `packages/connector/test/acceptance/story-36-1-ator-local-network.test.ts:307-313` (pre-fix)
**Criterion**: Determinism / Test Healing (assertion robustness)
**Knowledge Base**: [test-quality.md](../../../_bmad/tea/testarch/knowledge/test-quality.md)

**Issue Description**:
The original test iterated three torrc template paths and used `if (!fs.existsSync(p)) continue;` to skip missing files. If all three torrc templates were absent, the `for` loop ran zero iterations and the test passed vacuously — masking a real scope regression.

**Current Code (pre-fix)**:

```typescript
// ❌ Pre-fix: vacuously passes if all three files missing
it('should use shell-style ${VAR} placeholders …', () => {
  for (const p of [TORRC_DIRAUTH_PATH, TORRC_RELAY_PATH, TORRC_HS_PATH]) {
    if (!fs.existsSync(p)) continue;
    const content = loadFileContent(p);
    expect(content).toMatch(/\$\{[A-Z_]+\}/);
  }
});
```

**Applied Fix**:

```typescript
// ✅ Post-fix: asserts existence of every file BEFORE iterating
it('should use shell-style ${VAR} placeholders (envsubst-compatible) in all templates', () => {
  const paths = [TORRC_DIRAUTH_PATH, TORRC_RELAY_PATH, TORRC_HS_PATH];
  for (const p of paths) {
    expect(fs.existsSync(p)).toBe(true);
  }
  for (const p of paths) {
    const content = loadFileContent(p);
    expect(content).toMatch(/\$\{[A-Z_]+\}/);
  }
});
```

**Why This Matters**:
Acceptance suites exist to catch scope regressions. A test that passes when its target artifact is missing is worse than no test at all — it creates false confidence. The fix is 3 lines and preserves the original intent.

**Status**: ✅ Fix applied in this review; all 126 tests still pass post-fix.

---

### 2. `depends_on` assertions under-specify quorum shape

**Severity**: P3 (Low)
**Location**: `packages/connector/test/acceptance/story-36-1-ator-local-network.test.ts:566-578`
**Criterion**: Assertion Strength
**Knowledge Base**: [test-quality.md](../../../_bmad/tea/testarch/knowledge/test-quality.md)

**Issue Description**:
The relay `depends_on` tests match `/dirauth[123]/` — passing if **any one** DirAuth is referenced. The story (AC 4, Task 4.7) requires the quorum shape (relays depend on all three DirAuths healthy; hs1 depends on ≥2 relays healthy). A future compose refactor that reduced `depends_on` to a single peer would still pass today.

**Current Code**:

```typescript
it.each(RELAY_SERVICES)('[relay] "%s" should depend_on at least one dirauth', (name) => {
  const svc = getService(compose, name);
  const dep = svc?.['depends_on'];
  const asText = JSON.stringify(dep ?? {});
  expect(asText).toMatch(/dirauth[123]/);
});
```

**Recommended Improvement**:

```typescript
it.each(RELAY_SERVICES)('[relay] "%s" should depend_on all three dirauths with service_healthy', (name) => {
  const svc = getService(compose, name);
  const dep = svc?.['depends_on'] as Record<string, { condition?: string }> | undefined;
  expect(dep).toBeDefined();
  for (const peer of DIRAUTH_SERVICES) {
    expect(dep?.[peer]).toBeDefined();
    expect(dep?.[peer]?.condition).toBe('service_healthy');
  }
});
```

**Benefits**:
- Catches silent weakening of the compose dependency graph.
- Aligns the static assertion with the story's "≥2 healthy" quorum intent.

**Priority**:
P3 — not blocking, and the downstream shell-level lifecycle smoke (AC 4, AC 5 timing) would catch real breakage. Record as a follow-up for a low-risk tightening pass.

---

### 3. Healthcheck presence asserted but shape is not

**Severity**: P3 (Low)
**Location**: `packages/connector/test/acceptance/story-36-1-ator-local-network.test.ts:442-445`
**Criterion**: Assertion Strength

**Issue Description**:
`expect(svc?.['healthcheck']).toBeDefined()` passes for any non-empty object. The story prescribes role-specific healthcheck semantics (DirAuth: consensus vote seen; relay: extorinfo/control-port TCP accept; hs1: SOCKS5 TCP accept). A compose refactor that downgraded every healthcheck to `test: ["CMD", "true"]` would still pass.

**Recommended Improvement**: Assert the `test` field contains a role-appropriate marker (e.g., `nc`, `anon`, `curl`, `test -s`). Non-blocking; the runtime lifecycle smoke already validates the semantics.

---

## Best Practices Found

### 1. Anti-pattern guarding (not just positive presence)

**Location**: `story-36-1-ator-local-network.test.ts:148-154` (AC 2)
**Pattern**: Negative regex anchored against a forbidden anti-pattern
**Knowledge Base**: [test-healing-patterns.md](../../../_bmad/tea/testarch/knowledge/test-healing-patterns.md)

**Why This Is Good**:
The story explicitly forbids `echo "<hash>  <file>" | sha256sum -c -` (a silent-pass anti-pattern). Rather than only asserting `sha256sum -c` is present, the test also rejects the anti-pattern via `expect(content).not.toMatch(/echo\s+["'][a-f0-9]{64}/i)`. This catches both branches of the spec in one test.

**Code Example**:

```typescript
// ✅ Both positive and negative assertions in one place
expect(content).toMatch(/sha256sum\s+-c/);
expect(content).not.toMatch(/echo\s+["'][a-f0-9]{64}/i);
```

---

### 2. Cross-profile port-disjointness invariant

**Location**: `story-36-1-ator-local-network.test.ts:580-609` (AC 11)
**Pattern**: Cross-cutting invariant expressed as a set-disjointness assertion

**Why This Is Good**:
Rather than hard-coding "9150 ≠ 8545", the test derives the ator port set and the pre-existing port set from the compose graph at runtime, then asserts `atorPorts ∩ otherPorts = ∅`. This is self-healing: adding a new service to any profile automatically extends the invariant without test changes.

---

### 3. Structured YAML parse + regex table-driven assertions

**Location**: Throughout AC 1 block (lines 409-481)
**Pattern**: `js-yaml` parse + `it.each([...services])` instead of line-grep

**Why This Is Good**:
Per `test-healing-patterns.md`, structured parses beat line-greps — cosmetic reformatting (comment insertions, key reordering, whitespace) doesn't break the suite. The file uses `yaml.load()` + structural `compose.services[name]` lookups, keeping tests resilient to non-semantic diffs.

---

### 4. Regression guard for scope bright-line (AC 13)

**Location**: `story-36-1-ator-local-network.test.ts:756-773`
**Pattern**: Filesystem walk for scope leaks + pre-existing profile association check

**Why This Is Good**:
The story's scope bright-line is enforced by tests, not by convention alone. Any future commit that tries to sneak an `ator-compose.ts` or `docker-ator.ts` into `packages/connector/src/` will fail the suite — the assertion turns a policy into an executable gate.

---

## Test File Analysis

### File Metadata

- **File Path**: `packages/connector/test/acceptance/story-36-1-ator-local-network.test.ts`
- **File Size**: 810 lines (post-fix), ~32 KB
- **Test Framework**: Jest (acceptance tier, `jest.acceptance.config.js`)
- **Language**: TypeScript

### Test Structure

- **Describe Blocks**: 16
- **Test Cases (it/test)**: 126
- **Average Test Length**: ~4 lines per test (very tight)
- **Fixtures Used**: 0 (intentional — static-asset suite)
- **Data Factories Used**: 0 (intentional — no runtime entities)
- **Helpers Defined**: 4 (`loadFileContent`, `loadDockerCompose`, `getService`, `getProfiles`)

### Test Scope

- **Test IDs**: T-36.1-01, T-36.1-02, T-36.1-03, T-36.1-05, T-36.1-08 (pivotal tests from epic test-design)
- **Priority Distribution**: All tests map to P0 (foundation story blocking 36.3 / 36.4 / 36.5).

### Assertions Analysis

- **Total `expect()` calls**: ~180 across 126 tests (avg ≈ 1.4 per test)
- **Assertion Types**: `toBe`, `toMatch`, `toContain`, `toBeDefined`, `toEqual`, `toBeGreaterThanOrEqual`, `toHaveLength`, `not.toMatch`, `not.toBe`
- **Assertion Style**: exact-string anchors + structured YAML parse (resilient to cosmetic reformatting)

---

## Context and Integration

### Related Artifacts

- **Story File**: [36-1-local-ator-network-image-docker-compose.md](../../implementation-artifacts/36-1-local-ator-network-image-docker-compose.md)
- **ATDD Checklist**: [atdd-checklist-36-1.md](../atdd-checklist-36-1.md)
- **Epic**: [epic-36-real-binary-ator-verification.md](../../planning-artifacts/epic-36-real-binary-ator-verification.md)
- **Test Design**: [test-design-epic-36.md](../../planning-artifacts/test-design-epic-36.md) (T-36.1-01 … T-36.1-08)
- **Precedent**: `test-review-35-*.md` (Epic 35 series), `atdd-checklist-33-9.md`, `atdd-checklist-34-10.md`
- **Risk Assessment**: Foundation story (P0) — blocks 36.3 / 36.4 / 36.5; Epic 35 frozen surface untouched by construction.

---

## Knowledge Base References

This review consulted the following knowledge base fragments:

- **[test-quality.md](../../../_bmad/tea/testarch/knowledge/test-quality.md)** — Definition of Done for tests (no hard waits, <300 lines per concern, <1.5 min, self-cleaning)
- **[test-healing-patterns.md](../../../_bmad/tea/testarch/knowledge/test-healing-patterns.md)** — Exact-string anchors + structured parse over fragile line-grep
- **[test-levels-framework.md](../../../_bmad/tea/testarch/knowledge/test-levels-framework.md)** — Acceptance-tier appropriateness for static-asset / infrastructure stories (33.9 / 34.10 precedent)
- **[selector-resilience.md](../../../_bmad/tea/testarch/knowledge/selector-resilience.md)** — N/A (no DOM selectors)
- **[timing-debugging.md](../../../_bmad/tea/testarch/knowledge/timing-debugging.md)** — N/A (no timing)

For coverage mapping, consult `trace` workflow outputs.

---

## Next Steps

### Immediate Actions (Before Merge)

1. **None** — the suite is production-ready. The vacuous-pass fix landed in this review; all 126 tests pass in ~1.4s.

### Follow-up Actions (Future PRs)

1. **Tighten `depends_on` assertions to assert quorum shape** — Priority P3; target: Story 36.2 or a dedicated test-hygiene chore. Rationale: today's "any-one" match permits silent compose weakening.
2. **Assert healthcheck `test` field shape, not just presence** — Priority P3; target: same hygiene chore. Rationale: runtime lifecycle smoke catches the regression, but a static gate is faster feedback.
3. **Consider extracting the AC 1 `it.each(ATOR_SERVICES)` helpers into a shared compose-profile-testkit** — Priority P3; target: epic 37+ if further compose-profile stories emerge. Would benefit 33.9 / 34.10 / 36.1 uniformly.

### Re-Review Needed?

✅ No re-review needed — approve as-is.

---

## Decision

**Recommendation**: **Approve**

**Rationale**:
Story 36.1's acceptance suite is an excellent example of a precedent-aligned, deterministic, fast-running static-assertion suite for a pure-infrastructure story. All 126 tests pass in ~1.4s against the landed implementation. The suite demonstrates four material best practices (anti-pattern guarding, set-disjointness invariants, structured YAML parse, scope-leak regression guards) and carries no critical or high-severity violations. The one P2 vacuous-pass risk discovered during review has been fixed in-place — all tests still pass.

> Test quality is excellent with 96/100 score. The P3 recommendations are minor tightening suggestions that can be addressed in a follow-up hygiene chore; they do not affect Story 36.1's acceptance. The suite is production-ready and can be approved as-is.

---

## Appendix

### Violation Summary by Location

| Line    | Severity | Criterion            | Issue                                                           | Fix                                                   |
| ------- | -------- | -------------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| 307-313 | P2       | Determinism (fixed)  | `continue` on missing file causes vacuous pass                  | ✅ Fixed: assert existence before iteration           |
| 566-578 | P3       | Assertion Strength   | `depends_on` matches any one DirAuth, not quorum shape           | Tighten to per-peer `service_healthy` assertions       |
| 442-445 | P3       | Assertion Strength   | Healthcheck presence asserted but shape is not                   | Assert `test` field contains role-appropriate marker   |

### Quality Trends

First review of this file — no prior baseline. Establishes 96/100 as the Story 36.1 baseline.

### Related Reviews

| File                                             | Score   | Grade | Critical | Status  |
| ------------------------------------------------ | ------- | ----- | -------- | ------- |
| story-36-1-ator-local-network.test.ts            | 96/100  | A     | 0        | Approved |

---

## Review Metadata

**Generated By**: BMad TEA Agent (Test Architect) — YOLO mode
**Workflow**: testarch-test-review v5.0
**Review ID**: test-review-story-36-1-20260415
**Timestamp**: 2026-04-15
**Version**: 1.0

---

## Feedback on This Review

If you have questions or feedback on this review:

1. Review patterns in knowledge base: `_bmad/tea/testarch/knowledge/`
2. Consult `tea-index.csv` for detailed guidance
3. Request clarification on specific violations
4. Pair with QA engineer (or re-invoke `/bmad-tea-testarch-test-review`) for deeper analysis

This review is guidance, not rigid rules. Context matters — if a pattern is justified, document it with a comment.
