---
stepsCompleted:
  [
    'step-01-load-context',
    'step-02-discover-tests',
    'step-03-map-criteria',
    'step-04-analyze-gaps',
    'step-05-gate-decision',
  ]
lastStep: 'step-05-gate-decision'
lastSaved: '2026-04-14'
workflowType: 'testarch-trace'
mode: 'yolo'
inputDocuments:
  - '_bmad-output/implementation-artifacts/35-7-documentation-deployment-guide-and-config-reference.md'
  - '_bmad-output/test-artifacts/atdd-checklist-35-7.md'
  - '_bmad-output/planning-artifacts/epic-35-ator-overlay-transport.md'
  - '_bmad-output/planning-artifacts/test-design-epic-35.md'
gate_type: story
decision_mode: deterministic
---

# Traceability Matrix -- Story 35.7: Documentation -- Deployment Guide and Config Reference

**Date:** 2026-04-14
**Author:** Jonathan
**Story Status (source of truth):** done
**Mode:** YOLO (non-interactive)
**Story type:** Documentation-only (AC 11 forbids new runtime tests)

---

## 1. Scope and Posture

Story 35.7 is the documentation-closing story of Epic 35. It ships:

1. New file: `docs/ator-transport.md` (operator-facing deployment guide)
2. README.md entry under Privacy Transport (AC 9)
3. `docs/architecture/source-tree.md` transport/ annotation (AC 9)
4. `sprint-status.yaml` status transition to `done` (AC 11 permitted delta)

AC 11 is a **hard freeze** on `packages/`, `Makefile`, `package.json`, and any test file. The ATDD checklist at `_bmad-output/test-artifacts/atdd-checklist-35-7.md` is the canonical validation artifact for the prose ACs. Runtime ACs (3, 6, 7, 8, 10, 11) lean on automation already shipped by Stories 35.1--35.6 (no new test code permitted).

The traceability posture therefore differs from a code-producing story: for each AC we record (a) which existing automated test -- if any -- enforces the underlying invariant, and (b) which static/doc artifact evidences the prose deliverable.

---

## 2. Evidence Inventory (Discovery)

Existing automation consulted as coverage for runtime invariants referenced by the docs:

| Artifact | Role |
|----------|------|
| `packages/connector/src/transport/transport-security.test.ts` | SEC-03 (socks5:// triple-rejection), SEC-04 (agent `shouldLookup === false`), SEC-05 (`.anon` redaction) |
| `packages/connector/test/integration/transport-socks5.test.ts` | SEC-01 (DNS-leak / ATYP=DOMAIN at proxy), SEC-02 (fail-closed on proxy down), INT-05/06 (BTP over SOCKS agent, direct unchanged) |
| `packages/connector/src/transport/socks-transport-provider.test.ts` | Provider unit-level behaviour (startup / agent shape) |
| `packages/connector/src/transport/managed-anon-client.test.ts` | Story 35.5 managed-client lifecycle, WARN-on-crash (AC5) |
| `packages/connector/src/config/config-loader.ts` (non-Zod hand-rolled `validateTransport` / `validateSocks5Transport` / `validateManagedOptions`) | Source of verbatim `ConfigurationError` strings cited by AC 3 and AC 6 |
| `packages/connector/src/core/connector-node.ts` (`HealthStatus`, `_transportHealthIntervalMs ?? 30000`) | AC 7 health-endpoint shape and INT-03 seam |
| `docs/ator-transport.md` (509 lines, all 9 ToC sections present) | Primary prose deliverable (AC 1--8) |
| `README.md` L599 link | AC 9 cross-reference |
| `docs/architecture/source-tree.md` L36, L44 | AC 9 cross-reference |
| `_bmad-output/test-artifacts/atdd-checklist-35-7.md` | Canonical static-validation checklist for prose ACs |

No new runtime tests were authored (correct posture -- AC 11 prohibits).

---

## 3. Requirements-to-Evidence Matrix

Legend: **Full** = invariant fully enforced and/or prose verifiably present; **Partial** = prose present but depends on reviewer cross-check; **None** = no evidence (gap).

| AC | Validation ID | Type | Enforcing Automation (existing) | Prose/Static Evidence | Coverage |
|----|---------------|------|--------------------------------|-----------------------|----------|
| 1  | T-35.7-DOC-01 | Structural (doc ToC + YAML validity) | `config-loader.test.ts` (existing, via Story 35.3 coverage of `validateTransport`) -- any YAML example must round-trip through this real loader | `docs/ator-transport.md` lines 16--34 (ToC), 9 required sections confirmed at lines 36, 49, 112, 245, 258, 294, 314, 374, 468 | **Full** |
| 2  | T-35.7-DOC-02 | Cross-ref (install paths) | `managed-anon-client.test.ts` covers managed-path semantics (Story 35.5); optionalDependency gating in `packages/connector/package.json` | `docs/ator-transport.md` §Installation (lines 49--111) documents both managed and external paths, cites Node >= 22.11.0 and R-005 platform caveats | **Full** |
| 3  | T-35.7-DOC-03 | Schema-accurate config reference | `config-loader.ts` `validateTransport`/`validateSocks5Transport`/`validateManagedOptions` (existing automation asserts all field-level error strings) | §Connector Configuration (lines 112--244) enumerates every `TransportConfig` field with verbatim `ConfigurationError` strings (confirmed by spot-grep: lines 145/147 match `config-loader.ts` lines 750/755 verbatim); Examples A/B/C present | **Full** |
| 4  | T-35.7-DOC-04 | Substance (privacy model) | N/A -- prose traceable to epic §Security Analysis; not independently automatable | §Privacy Model (lines 258--293) preserves three-layer stack, honest non-protections, Cross-Layer Attack Surface table | **Full (per ATDD checklist)** |
| 5  | T-35.7-DOC-05 | Substance (perf/timeout) | N/A -- ranges come from epic §Performance Characteristics | §Performance and Timeout Tuning (lines 294--313) reproduces latency table, ranged PREPARE-timeout recommendation, mixed-topology note, cites config keys from `types.ts` | **Full (per ATDD checklist)** |
| 6  | T-35.7-DOC-06 | Verbatim-quote (troubleshooting) | `transport-security.test.ts` (SEC-03/04/05), `transport-socks5.test.ts` (SEC-01/02), `managed-anon-client.test.ts` (Story 35.5 AC5 WARN) enforce the underlying runtime invariants | §Troubleshooting (lines 374--467) covers all 5 failure modes (DNS leak, SOCKS down, managed crash, .anon rotation, socks5h misconfig); verbatim-quote audit recorded in ATDD checklist | **Full** |
| 7  | T-35.7-DOC-07 | Shape-match (health endpoint) | `connector-node.test.ts` (existing) asserts `HealthStatus.transport` shape; INT-03 seam (`transportHealthIntervalMs`) is an intentional test-only ctor param with 30000 default in `connector-node.ts` | §Operational Monitoring (lines 314--373) renders sample response and documents `transportHealthIntervalMs` as test-only, 30000 ms default | **Full** |
| 8  | T-35.7-DOC-08 | Traceability (security claims) | Every cited T-ID (SEC-01..05, INT-03/05/06, R-005, R-006) is enforced by a test in `src/transport/*.test.ts` or `test/integration/transport-socks5.test.ts` | §Security Model (lines 468--509) cites file:line or T-ID for each claim (per ATDD-checklist post-dev audit) | **Full** |
| 9  | T-35.7-DOC-09 | Link integrity | N/A | README.md L599 link present; source-tree.md L36/L44 transport annotation present and links back; CLAUDE.md Key Entry Points row still accurate | **Full** |
| 10 | T-35.7-DOC-10 | Tooling (format + render) | `npm run format:check` (prettier, existing tooling) -- verified by dev per story task 11 | Story Dev Agent Record records green format:check | **Full** |
| 11 | T-35.7-REG-01 | Regression gate | Full existing test suite via `make test`; `npm run build` | Per Story tasks 11 and 12 (marked complete), `make test` green with unchanged test count; git diff scoped to permitted deltas (docs + sprint-status + story file) | **Full** |

---

## 4. Coverage Summary

- **ACs covered Full:** 11 / 11
- **ACs covered Partial:** 0
- **ACs uncovered:** 0
- **New tests authored this story:** 0 (intentional -- AC 11 forbids)
- **Pre-existing tests leveraged:** `transport-security.test.ts`, `transport-socks5.test.ts`, `socks-transport-provider.test.ts`, `managed-anon-client.test.ts`, `direct-transport-provider.test.ts`, `config-loader.test.ts`, `connector-node.test.ts`
- **T-IDs from test-design-epic-35.md referenced but not independently re-tested (correct):** SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, INT-03, INT-05, INT-06, R-005, R-006

### Uncovered ACs

**None.** Per the explicit request in the invocation, any AC without test coverage would be listed here; every AC has either (a) an existing automated test that enforces the underlying runtime invariant, or (b) a static-validation procedure recorded in the ATDD checklist -- which is the appropriate coverage level for a documentation story under AC 11's test-file freeze.

### Why no new runtime tests is the correct answer

AC 11 declares byte-for-byte regression on `packages/**`, `Makefile`, `package.json`, and every test file. Adding any new `*.test.ts` file or touching an existing one would itself violate AC 11 and fail the story. Coverage for docs-prose ACs (1, 2, 4, 5, 9) is inherently static; coverage for runtime invariants referenced by the docs (3, 6, 7, 8, 10, 11) is satisfied by automation already in the tree from Stories 35.1--35.6.

---

## 5. Risk Posture

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Doc drifts from `config-loader.ts` error strings over future refactors | Medium | Low (operator grep-miss) | Verbatim-quote posture + future ATDD for any config-loader story should include a doc-audit step |
| Epic 35 security claims soften if epic is later edited | Low | Medium | Claims are traced by file:line / T-ID in the doc itself; audit trail remains |
| Health-endpoint shape changes without doc update | Low | Medium | Any future story touching `HealthStatus.transport` should trigger a 35.7-style doc follow-up; rely on code review |
| Prose error in `.anon` sample log leaks hostname (SEC-05 self-counterexample) | Low | Medium | ATDD checklist's "Do NOT" list flagged this; manual review per Dev Agent Record |

None of these risks are blocking; all are post-merge maintenance concerns appropriate for a documentation artifact.

---

## 6. Gate Decision (Deterministic, Story-Level)

### Decision rules applied

- AC uncovered count: 0 -> not FAIL
- Partial coverage count: 0 -> not CONCERNS
- AC 11 regression verified (existing tests unchanged, sprint-status flipped, diff scoped) -> not FAIL
- ATDD checklist YOLO-signed as READY-FOR-DEV and all 12 story tasks checked off in the story file -> satisfied
- No new test files authored (correct posture, not a gap) -> not CONCERNS

### Gate: **PASS**

Story 35.7 meets its acceptance criteria with zero uncovered ACs. All runtime invariants referenced by the documentation remain enforced by the automation shipped in Stories 35.1--35.6. Prose ACs are validated via the canonical ATDD static-checklist artifact. The AC 11 regression freeze is honoured -- no new or modified test files, no `packages/**` changes, no `package.json` dependency changes.

---

## 7. Follow-ups / Recommendations (non-blocking)

1. When the next Epic 35 follow-up story touches `config-loader.ts` `validateTransport*` or `connector-node.ts` `HealthStatus`, add a "doc-audit" task to the ATDD checklist that greps the quoted strings in `docs/ator-transport.md` against the new source. This keeps verbatim quotes from drifting.
2. Epic-35 retrospective (currently "pending" per sprint-status.yaml) should adopt this trace as input; no other trace action required before that workflow runs.

---

## 8. Artifacts

- Trace output: `_bmad-output/test-artifacts/traceability/traceability-35-7.md` (this file)
- Source story: `_bmad-output/implementation-artifacts/35-7-documentation-deployment-guide-and-config-reference.md`
- ATDD checklist (canonical prose validator): `_bmad-output/test-artifacts/atdd-checklist-35-7.md`
- Primary deliverable under trace: `docs/ator-transport.md`
- Cross-ref deltas: `README.md` L599, `docs/architecture/source-tree.md` L36/L44
