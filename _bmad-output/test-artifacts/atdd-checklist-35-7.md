---
stepsCompleted:
  [
    'step-01-preflight-and-context',
    'step-02-generation-mode',
    'step-03-test-strategy',
    'step-04-generate-tests',
    'step-05-validate-and-complete',
  ]
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-04-14'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/35-7-documentation-deployment-guide-and-config-reference.md'
  - '_bmad-output/planning-artifacts/epic-35-ator-overlay-transport.md'
  - '_bmad-output/planning-artifacts/test-design-epic-35.md'
  - 'packages/connector/src/config/types.ts'
  - 'packages/connector/src/config/config-loader.ts'
  - 'packages/connector/src/core/connector-node.ts'
  - 'packages/connector/src/transport/socks-transport-provider.ts'
  - 'packages/connector/src/transport/managed-anon-client.ts'
  - 'packages/connector/src/transport/socks-url.ts'
  - 'docs/solana-deployment.md'
  - 'docs/mina-deployment.md'
---

# ATDD Checklist — Epic 35, Story 35.7: Documentation — Deployment Guide and Config Reference

**Date:** 2026-04-14
**Author:** Jonathan
**Primary Test Level:** **Documentation validation (static + tooling).** Mode: YOLO.

---

## Story Summary

Story 35.7 is the **documentation-closing story** for Epic 35. It creates `docs/ator-transport.md` (operator-facing deployment guide + config reference + privacy/security model + troubleshooting) and minor cross-reference updates in `README.md` and `docs/architecture/source-tree.md`.

**AC 11 explicitly forbids any change under `packages/`, `Makefile`, `package.json`, or any test file.** The only permitted deltas are:

1. the new `docs/ator-transport.md`
2. doc cross-ref updates per AC 9
3. `sprint-status.yaml` status transition
4. Dev Agent Record fields on the story file itself

**Production surface area is frozen** by Stories 35.1–35.6 which are already green (see `atdd-checklist-35-{2..6}.md`). No new behaviour is introduced.

---

## ATDD Determination: Documentation-Only Story — No New Runtime Tests

Per ATDD step-01 prerequisite "Story approved with clear acceptance criteria" — **met**, but the ACs are not testable at the E2E/API/component level because:

| AC | Nature | Why not E2E/API/component test |
|----|--------|--------------------------------|
| AC 1 | Markdown section presence | Static markdown lint / manual render |
| AC 2 | Prose accuracy (managed vs external install path) | Reviewer cross-check; cites `package.json#optionalDependencies` |
| AC 3 | YAML example validity | **Uses the existing `ConfigLoader.validateTransport` — no new test code required; Story 35.3 already covers the loader. Evidence = manual programmatic load during dev.** |
| AC 4 | Prose accuracy (privacy model) | Reviewer cross-check against epic §Security Analysis |
| AC 5 | Prose accuracy (perf/timeout guidance) | Reviewer cross-check |
| AC 6 | Verbatim error-string quoting | **grep-match the quoted string in `packages/connector/src/transport/*.ts`** |
| AC 7 | Health-endpoint shape matches code | grep-match `HealthStatus` in `connector-node.ts` |
| AC 8 | Security-claim traceability | Reviewer cross-check against epic + test-design T-IDs |
| AC 9 | Link resolution | Link-checker / manual |
| AC 10 | Docs tooling gates | `npm run format:check`; markdown render |
| AC 11 | Zero runtime regression | `npm run build && make test` byte-for-byte identical test count |

**Generating new Jest/Playwright/API tests here would directly violate AC 11.** The correct ATDD output for a docs-closing story is a **validation checklist** whose "tests" are static-analysis procedures against the docs artefact.

This matches the pattern already established elsewhere in the project: pure-docs stories do not add runtime tests.

---

## Acceptance Criteria Coverage

| AC  | Validation ID       | Kind           | Procedure |
|-----|---------------------|----------------|-----------|
| 1   | T-35.7-DOC-01       | Structural     | Table of Contents contains all 9 required sections; every YAML fenced block passes `ConfigLoader.validateTransport` when dropped into a scratch `connector.yaml` |
| 2   | T-35.7-DOC-02       | Cross-ref      | Installation section covers BOTH managed (`@anyone-protocol/anyone-client` optionalDependency) and external (`anon` binary / system `tor`) paths, cites Story 35.5 AC10 gating, and Node.js `>= 22.11.0` from root `package.json#engines` |
| 3   | T-35.7-DOC-03       | Schema-accurate | Every `TransportConfig` field in `packages/connector/src/config/types.ts` is documented with description/type/default/required-when/verbatim `ConfigurationError` string; 3 worked examples (A direct, B external socks5, C managed+hidden-service) each load clean |
| 4   | T-35.7-DOC-04       | Substance      | Privacy Model section preserves three-layer stack + "What It Does NOT Protect Against" list + Cross-Layer Attack Surface table from epic §Security Analysis, including the "full stack compromise = critical" honest assessment |
| 5   | T-35.7-DOC-05       | Substance      | Perf/Timeout section reproduces epic §Performance Characteristics latency table; recommends ILP PREPARE timeout MINIMUM as a range with rationale; addresses mixed-topology (Story 35.6 AC12 / INT-07); cites actual config key names from `types.ts` |
| 6   | T-35.7-DOC-06       | Verbatim-quote | Every error-message quotation in Troubleshooting grep-matches a `throw new Error(...)` in `packages/connector/src/transport/*.ts` or a `ConfigurationError` in `config-loader.ts`. Covers: DNS-leak detection (SEC-01), SOCKS proxy down (SEC-02), managed-client crash (Story 35.5 AC5), `.anon` rotation (R-006), socks5h triple-rejection (SEC-03) |
| 7   | T-35.7-DOC-07       | Shape-match    | Operational Monitoring section's sample response body matches `HealthStatus` type in `packages/connector/src/core/connector-node.ts` (no invented fields); `transportHealthIntervalMs` documented as test-only ctor seam (INT-03); production default `30000` (source: `_transportHealthIntervalMs ?? 30000`) |
| 8   | T-35.7-DOC-08       | Traceability   | Every claim in Security Model section resolves to either (a) `file:line` in `packages/connector/src/transport/` or `packages/connector/src/config/`, or (b) T-ID from `test-design-epic-35.md` (SEC-01..05, INT-01..07, R-005, R-006) |
| 9   | T-35.7-DOC-09       | Link integrity | `README.md` links to `docs/ator-transport.md`; `docs/architecture/source-tree.md` transport/ entry accurate; `CLAUDE.md` Key Entry Points Epic 35 row still accurate; no dangling/broken links |
| 10  | T-35.7-DOC-10       | Tooling        | `npm run format:check` clean on modified markdown; GitHub render of tables/fences/admonitions looks correct |
| 11  | T-35.7-REG-01       | Regression     | `git diff` vs pre-story baseline is empty for everything except (a) `docs/ator-transport.md`, (b) AC 9 doc cross-refs, (c) `sprint-status.yaml`, (d) story-file Dev Agent Record. `npm run build && make test` PASS with unchanged test count vs baseline |

**All validations are static/review/tooling-based. No new `.test.ts` / `.test.tsx` / `.spec.ts` files are to be created.**

---

## Failing Tests Created

**None.** Creating new test files would violate AC 11 (Zero runtime regression — "NO changes to any file under packages/, Makefile, package.json, or tests").

**Rationale (recorded for audit):**

Story 35.7 is documentation-only. The epic's runtime invariants are already mechanically enforced by the test suite shipped in Story 35.6 (see `atdd-checklist-35-6.md`), which covers:

- SEC-01 (DNS-leak prevention / ATYP=DOMAIN)
- SEC-02 (fail-closed on SOCKS proxy down)
- SEC-03 (socks5:// triple-rejection: loader, constructor, helper)
- SEC-04 (agent `shouldLookup === false`)
- SEC-05 (`.anon` redaction at INFO+)
- INT-05 / INT-06 (BTP handshake over SocksProxyAgent; direct path unchanged)

Story 35.7's job is to **translate those mechanically-verified invariants into operator-facing prose** — not to re-verify them. The verification burden for 35.7 is therefore:

1. **Doc-to-code consistency** (AC 3, 6, 7): grep-match quoted error strings and field names into the real source files.
2. **Doc-to-epic consistency** (AC 4, 5, 8): prose substance must match `epic-35-ator-overlay-transport.md` §Security Analysis, §Performance Characteristics, §Critical Implementation Rules.
3. **Example YAML validity** (AC 3): each of Examples A/B/C pasted into a scratch file and loaded programmatically through `ConfigLoader.validateTransport` (hand-rolled, non-Zod) during dev. This exercises existing code; no new test.
4. **Tooling** (AC 10): `npm run format:check` + markdown render.
5. **Regression** (AC 11): `npm run build && make test` identical test count.

---

## Implementation Notes (for the dev agent picking up 35.7)

### Do

- Mirror `docs/solana-deployment.md` / `docs/mina-deployment.md` voice, heading rhythm, and `--` em-dash convention.
- Read `packages/connector/src/config/config-loader.ts` `validateTransport` / `validateSocks5Transport` / `validateManagedOptions` methods and **copy the `ConfigurationError` messages verbatim** into the AC 3 reference table and AC 6 troubleshooting section.
- Read `packages/connector/src/transport/socks-transport-provider.ts` `.start()` for the actual fail-closed error string and quote it verbatim in the Troubleshooting SOCKS-proxy-down subsection.
- Read `packages/connector/src/transport/socks-url.ts` for the third layer of the socks5h rejection chain (SEC-03 layer c).
- Read `packages/connector/src/core/connector-node.ts` `HealthStatus` type and render its `transport` subtree exactly as emitted — do NOT invent fields.
- During authoring, paste Examples A/B/C into a tmp `connector.yaml` and load via the config-loader (programmatic call or CLI) to confirm clean load. If rejected: fix the example, not the loader.
- After authoring, grep the doc against the source: for every quoted error string in the doc, `rg "<exact string>"` must hit in `packages/connector/src/`.

### Do NOT

- Do NOT add any new test files. AC 11 forbids it.
- Do NOT add any new config field, health-endpoint field, or npm dependency. Docs-only.
- Do NOT paraphrase `ConfigurationError` messages — operators will grep for the exact string.
- Do NOT put a `.anon` hostname in any sample log line in the doc (SEC-05 invariant applies to the doc itself).
- Do NOT soften epic §Security Analysis's honest "does not protect against" list (timing correlation, compromised entry+exit, ILP address destination leakage).
- Do NOT invoke Zod-style error messages — transport validation is hand-rolled in `config-loader.ts`.
- Do NOT claim `@anyone-protocol/anyone-client` is a hard dependency — it is `optionalDependencies` gated, per Story 35.5 AC10.

### Dev-time verification recipe (recorded here so the dev agent doesn't reinvent it)

```bash
# 1. Manual format + link sanity
npm run format:check -- docs/ator-transport.md README.md docs/architecture/source-tree.md

# 2. Verbatim-quote audit (AC 6) — pick each quoted error string in the doc
#    and confirm it exists in the source tree. Example:
rg 'transport.socksProxy must use socks5h:// scheme' packages/connector/src/

# 3. YAML example validation (AC 3) — for each of A/B/C:
#    drop into a tmp file and load via ConfigLoader (use an existing unit test
#    as a programmatic entry point, or the connector CLI loader).

# 4. Regression gate (AC 11)
npm run build && make test
git diff --stat main...HEAD   # should show only docs + sprint-status + story file
```

---

## Traceability to Test-Design

| Test-design T-ID | Covered by (existing, shipped by 35.2–35.6) | Doc section that references it |
|------------------|---------------------------------------------|--------------------------------|
| T-35.6-SEC-01    | `test/integration/transport-socks5.test.ts` | Troubleshooting §DNS leak detection |
| T-35.6-SEC-02    | `test/integration/transport-socks5.test.ts` | Troubleshooting §SOCKS proxy down |
| T-35.6-SEC-03    | `src/transport/transport-security.test.ts`  | Troubleshooting §socks5:// vs socks5h:// |
| T-35.6-SEC-04    | `src/transport/transport-security.test.ts`  | Privacy Model §Layer 1 |
| T-35.6-SEC-05    | `src/transport/transport-security.test.ts`  | Troubleshooting + Security Model §.anon logging invariant |
| T-35.6-INT-03    | (seam, test deferred)                       | Operational Monitoring §transportHealthIntervalMs is test-only |
| T-35.6-INT-05/06 | `test/integration/transport-socks5.test.ts` | Performance §baseline + regression posture |
| R-005            | Story 35.5 optional-dep gating              | Installation §platform caveats |
| R-006            | Story 35.5 hiddenServiceDir semantics       | Troubleshooting §.anon hostname rotation |

---

## Validation Gate Summary

| Gate | Status (pre-dev) | Post-dev criterion |
|------|------------------|--------------------|
| Doc structure (AC 1)            | PENDING | All 9 ToC sections present; YAML blocks load clean |
| Install-paths (AC 2)            | PENDING | Both managed + external documented; optionalDep gating cited |
| Config reference (AC 3)         | PENDING | All fields; 3 examples A/B/C load-clean; verbatim errors |
| Privacy model (AC 4)            | PENDING | Three layers + honest non-protections + attack-surface table |
| Perf/timeout (AC 5)             | PENDING | Table + ranged recommendations + config-key citations |
| Troubleshooting (AC 6)          | PENDING | All 5 failure modes; verbatim error strings |
| Monitoring (AC 7)               | PENDING | HealthStatus shape match; seam documented |
| Security model (AC 8)           | PENDING | Every claim traceable to file:line or T-ID |
| Cross-refs (AC 9)               | PENDING | README + source-tree + CLAUDE.md checked |
| Tooling (AC 10)                 | PENDING | format:check clean; render OK |
| Regression (AC 11)              | PENDING | `make test` unchanged count; diff scoped |

Overall: **READY FOR DEV.** No blocking issues; no new test scaffolding required.

---

## Completion

- Mode: YOLO
- Output written: `{test_artifacts}/atdd-checklist-35-7.md`
- New test files created: **0** (intentional — AC 11 forbids)
- Existing test suite referenced: `atdd-checklist-35-6.md` + `src/transport/transport-security.test.ts` + `test/integration/transport-socks5.test.ts` (unchanged)
- Next workflow: dev-story implementation against `_bmad-output/implementation-artifacts/35-7-documentation-deployment-guide-and-config-reference.md`
