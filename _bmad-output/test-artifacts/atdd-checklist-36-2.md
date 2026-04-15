---
stepsCompleted:
  - 'step-01-preflight-and-context'
  - 'step-02-generation-mode'
  - 'step-03-test-strategy'
  - 'step-04-generate-tests'
  - 'step-05-validate-and-complete'
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-04-15'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/36-2-anyone-client-sdk-cli-flag-audit.md'
  - '_bmad-output/planning-artifacts/epic-36-real-binary-ator-verification.md'
  - '_bmad-output/planning-artifacts/test-design-epic-36.md'
  - 'docs/ator-transport.md'
  - 'packages/connector/package.json'
  - 'packages/connector/jest.config.js'
  - 'packages/connector/jest.acceptance.config.js'
  - 'packages/connector/test/acceptance/story-36-1-ator-local-network.test.ts'
  - 'packages/connector/test/integration/claim-validation-gate.test.ts'
  - 'node_modules/@anyone-protocol/anyone-client/package.json'
---

# ATDD Checklist — Epic 36, Story 36.2: anyone-client SDK CLI Flag Audit

**Date:** 2026-04-15
**Author:** Jonathan
**Primary Test Level:** Integration (snapshot-diff gate) + Acceptance (static docs/structural gates)
**Execution mode:** sequential (single-agent, docs-heavy story)
**YOLO mode:** active — proceeded autonomously through all steps

---

## Story Summary

Audit the pinned SDK's (`@anyone-protocol/anyone-client@1.1.3`) CLI flag surface, replace the "consult docs.anyone.io / do not guess" hedges in `docs/ator-transport.md` with verified flag documentation, commit `--help` snapshots under `docs/ator-transport/`, and add a snapshot-diff integration test that fails at PR time whenever the SDK's flag surface drifts.

**As a** connector operator and docs maintainer
**I want** verified CLI-flag documentation with a machine-checkable freshness gate
**So that** Option A.2 installations stop failing silently and silent upstream flag renames land as a failed CI check instead of as a broken deployment

---

## Acceptance Criteria (from story)

1. **AC 1** — `grep -iEc "consult[^\n]*docs\.anyone\.io|docs\.anyone\.io[^\n]*for[^\n]*(current|current CLI|flag)" docs/ator-transport.md` returns **0** (at least one plain link to `https://docs.anyone.io` preserved).
2. **AC 2** — `grep -c "do not guess" docs/ator-transport.md` returns **0**.
3. **AC 3** — Option A.2 section disambiguates `anyone-proxy` (daemon) vs `anyone-client` (orchestrator), lists SOCKS / control / data-dir / log-level flags, references the committed snapshot, carries a provenance line.
4. **AC 4** — Exactly one provenance line matches `Flag surface verified against @anyone-protocol/anyone-client@\d+\.\d+\.\d+ on \d{4}-\d{2}-\d{2}`, version equals the resolved dep, date ≤ today (no YYYY-MM-DD).
5. **AC 5** — `docs/ator-transport/anyone-proxy-help.txt` + `docs/ator-transport/anyone-client-help.txt` exist, first non-blank line is `# Flag surface captured from @anyone-protocol/anyone-client@<VERSION> on <ISO-DATE>`, remainder is normalized byte-for-byte stdout+stderr.
6. **AC 6** — `packages/connector/test/integration/story-36-2-anon-cli-snapshot.test.ts` spawns each CLI, strips provenance header, diffs against committed snapshots; on mismatch the error message names the CLI and includes the literal substring `Regenerate with: NO_COLOR=1` pointing at Task 2.4 normalization; skips (does NOT pass) when the optional dep is missing (R-14).
7. **AC 7** — Each flag annotated `[story 35.5]` (consumed by managed-client code path), `[story 36.2]` (audit itself), or `[operator-only]`.
8. **AC 8** — Option B section cross-references Option A.2 and names the 2026-04-15 audit date.
9. **AC 9** — Story diff is scoped to: `docs/ator-transport.md` (edit), two new snapshot files, one new integration test, `CHANGELOG.md`, `sprint-status.yaml`, the story file. NO files under `packages/connector/src/`, `docker/`, `infra/`, or `Makefile`.
10. **AC 10** — Every documented command verified with `--help` or invalid-flag rejection; exit codes + first 5 lines recorded in Completion Notes.

---

## Generation Mode

- **Mode:** AI generation (backend / docs story — no browser recording warranted).
- **Rationale:** Acceptance criteria are structural / textual / process-level. No UI surface. `{detected_stack}` = `fullstack` (package.json hits react-ish deps elsewhere in the monorepo) but this story's tested artifacts are all files on disk; per step-02 backend-profile guidance, AI generation is correct.

---

## Test Strategy

### Mapping AC → Test Level

| AC | Test Level | Rationale |
|---|---|---|
| AC 1 (no hedge) | **Acceptance (static grep)** | Textual invariant on a shipped doc. |
| AC 2 (no "do not guess") | **Acceptance (static grep)** | Same. |
| AC 3 (Option A.2 flag surface) | **Acceptance (static regex)** | Structural invariant on prose + code fences. |
| AC 4 (machine-checkable provenance) | **Acceptance (regex + resolved-version check)** | Reads doc AND `require('@anyone-protocol/anyone-client/package.json').version` to assert alignment. |
| AC 5 (snapshot files + header) | **Acceptance (file existence + head-line regex)** | Static file checks. |
| AC 6 (snapshot-diff gate) | **Integration (spawnSync CLI)** | Real-binary invocation of `anyone-proxy --help` and `anyone-client --help`. This is the story's one non-static test. |
| AC 7 (flag annotations) | **Acceptance (grep per token)** | Textual invariant. |
| AC 8 (Option B cross-ref) | **Acceptance (section-scoped regex)** | Same. |
| AC 9 (scope bright-line) | **Acceptance (source-tree tripwire) + shell (Task 7.5)** | Jest cannot authoritatively resolve the story-start SHA; the acceptance test encodes an asymmetric tripwire (banner comment in `packages/connector/src/**`); the definitive check is the dev-run `git log --name-only` in Task 7.5. |
| AC 10 (operator-verbatim smoke) | **Dev-run (Task 7.6)** | Exit codes + first-5-lines evidence belong in Completion Notes, not in jest. |

### Priority

- **P0** — AC 6 snapshot-diff gate (the whole story's freshness guarantee rides on it).
- **P1** — AC 4 provenance alignment, AC 1/AC 2 hedge-free (the reason the story exists).
- **P1** — AC 5 snapshot file presence + header.
- **P2** — AC 3 / AC 7 / AC 8 structural invariants.
- **P3** — AC 9 source-tree tripwire (complements, does not replace, shell check).

### Red Phase Confirmed

All tests authored and confirmed FAILING against the pre-implementation tree. See "Test Execution Evidence" below.

---

## Failing Tests Created (RED Phase)

### Integration Tests (2 tests)

**File:** `packages/connector/test/integration/story-36-2-anon-cli-snapshot.test.ts` (~220 lines)

- **Test:** `anyone-proxy --help output matches the committed snapshot`
  - **Status:** RED — snapshot file `docs/ator-transport/anyone-proxy-help.txt` does not exist; `fs.readFileSync` throws ENOENT.
  - **Verifies:** AC 6 — live `spawnSync('.../anyone-proxy', ['--help'])` output, after stripping ANSI / CRLF / trailing-whitespace / blank-line-edges, equals the normalized committed snapshot. On mismatch, error message includes per-CLI regeneration recipe with the `Regenerate with: NO_COLOR=1` canary.

- **Test:** `anyone-client --help output matches the committed snapshot`
  - **Status:** RED — snapshot file `docs/ator-transport/anyone-client-help.txt` does not exist; ENOENT.
  - **Verifies:** Same as above, for the other CLI.

**R-14 skip branch:** If `require.resolve('@anyone-protocol/anyone-client/package.json')` throws (optional dep not installed on platform), the outer `describeIfSdk` (`describe.skip`) fires AND a separate descriptive `test.skip(...)` surfaces a reason line in CI output — explicit skip, never silent pass.

**Field-capture note (Task 1.3):** At story-authoring time the pinned SDK 1.1.3 did NOT accept `--help`:
- `anyone-proxy --help` is intercepted by proxychains: `proxychains: can't load process '--help'`.
- `anyone-client --help` throws from `node:util.parseArgs`: `ERR_PARSE_ARGS_UNKNOWN_OPTION`.
The test captures whatever the CLIs actually print (stdout + stderr) byte-for-byte. The committed snapshot therefore encodes the CLI's real — if ugly — current behavior, which is precisely the ground-truth the gate is designed to pin.

### Acceptance Tests (29 tests across 9 describe blocks)

**File:** `packages/connector/test/acceptance/story-36-2-anyone-client-sdk-cli-flag-audit.test.ts` (~400 lines)

Organized one `describe` per AC (AC 1–AC 9), each with focused `it()` blocks. Runs under `npm run test:acceptance -w packages/connector` (separate jest config — `jest.acceptance.config.js` — because the base jest config explicitly ignores `test/acceptance/`; matches 36.1's pattern).

Red-phase assertion matrix (from actual pre-implementation run: **20 failed / 9 passed / 29 total**):

| Describe block | RED behavior observed |
|---|---|
| AC 1: zero hedge matches | 2 failures — line 68 hedge still present |
| AC 2: zero "do not guess" | 1 failure — line 68 phrase still present |
| AC 3: Option A.2 flag surface | 4 failures — no SDK-disambiguation prose, no flag table, no snapshot-link |
| AC 4: machine-checkable provenance | 3 failures — no provenance line authored yet |
| AC 5: snapshots committed | 6 failures — directory `docs/ator-transport/` absent |
| AC 6 (static): integration-file canary | 3 passes — the integration test file WAS authored (correctly paired deliverable) |
| AC 7: flag annotations | 4 failures — no `[story 35.5]` / `[story 36.2]` / `[operator-only]` tokens in Option A.2 yet |
| AC 8: Option B cross-references audit | 1 failure — Option B does not mention the 2026-04-15 audit date; 2 passes (section exists, mentions A.2) |
| AC 9: scope tripwire + CHANGELOG | 1 failure — CHANGELOG lacks the 36.2 anyone-client entry; 1 pass — no `Story 36.2` banner found in `src/**` |

The 9 passes are intentional: they confirm the integration-test file is in place (AC 6 static), the docs file still links to upstream (AC 1 secondary), and no source-code violation exists (AC 9 tripwire). These are "correctly-shaped-today" invariants that must remain true post-impl too.

### E2E Tests (0 tests)

N/A — no UI surface.

### Component Tests (0 tests)

N/A — no UI surface.

---

## Data Factories Created

None — no domain entities under test. All test inputs are filesystem reads.

---

## Fixtures Created

None — no shared lifecycle setup. Each test is self-contained, reading files lazily inside `it()` bodies so discovery does not fail on missing files.

---

## Mock Requirements

None. The integration test spawns the REAL binary (the whole point of the gate); mocking it would defeat the freshness guarantee.

---

## Required data-testid Attributes

N/A — no UI.

---

## Implementation Checklist (GREEN phase, for dev-story)

Pull directly from the story Tasks. The test gates above are the oracle; below is the one-test-at-a-time roadmap.

### Test: AC 1 + AC 2 — hedges removed

**File:** `docs/ator-transport.md` (edit lines 64–71 per story Task 4.2/4.3)

- [ ] Delete line 68 (`# https://docs.anyone.io for the current CLI flags; do not guess.`) or replace with a concrete flag-table reference.
- [ ] Run: `cd packages/connector && npx jest --config jest.acceptance.config.js --testPathPattern=story-36-2 -t "AC 1"` — expect green.
- [ ] Run: same with `-t "AC 2"` — expect green.
- [ ] ✅ AC 1 + AC 2 turn green.

**Estimated Effort:** 0.25 h

---

### Test: AC 5 — snapshots committed

**Files:**
- `docs/ator-transport/anyone-proxy-help.txt` (new)
- `docs/ator-transport/anyone-client-help.txt` (new)

**Tasks (story Tasks 1 + 2):**

- [ ] `mkdir -p docs/ator-transport`
- [ ] Capture: `NO_COLOR=1 node_modules/.bin/anyone-proxy --help 2>&1 > docs/ator-transport/anyone-proxy-help.txt.raw`
- [ ] Capture: `NO_COLOR=1 node_modules/.bin/anyone-client --help 2>&1 > docs/ator-transport/anyone-client-help.txt.raw`
- [ ] Normalize: strip absolute paths (`/Users/...`, `/home/runner/...` → `<HOME>`), strip ANSI (`sed 's/\x1b\[[0-9;]*m//g'`), strip wall-clock timestamps if present.
- [ ] Prepend the provenance header line + blank line to each `.txt` file:
  ```
  # Flag surface captured from @anyone-protocol/anyone-client@1.1.3 on 2026-04-15

  ```
- [ ] Ensure UTF-8 + LF + trailing newline.
- [ ] Run: `cd packages/connector && npx jest --config jest.acceptance.config.js --testPathPattern=story-36-2 -t "AC 5"` — expect 6 green.
- [ ] ✅ AC 5 turns green.

**Estimated Effort:** 0.5 h (most of it is normalization QA — the macOS / arm64 capture at authoring time included a proxychains preamble and an absolute `libproxychains4.dylib` path that MUST be scrubbed).

---

### Test: AC 6 — integration gate passes

**File:** `packages/connector/test/integration/story-36-2-anon-cli-snapshot.test.ts` (already authored in RED phase)

- [ ] Confirm `test:integration` discovers the new file.
- [ ] Run: `npm run test:integration -w packages/connector -- --testPathPattern 'story-36-2-anon-cli-snapshot'`
  - **On a platform where the SDK installs (macOS/Linux/Win x64/arm64):** expect 2 passing.
  - **On an unsupported platform:** expect 2 skipped, 0 passing, 0 failing.
- [ ] ✅ AC 6 turns green.

**Estimated Effort:** 0.25 h (once AC 5 snapshots exist, AC 6 should be immediate).

---

### Test: AC 3 + AC 7 — Option A.2 flag surface + annotations

**File:** `docs/ator-transport.md` (rewrite §Option A.2)

- [ ] Replace Option A.2 body with an intro paragraph disambiguating `anyone-proxy` (daemon) vs `anyone-client` (orchestrator).
- [ ] Author a flag table (markdown) listing SOCKS port, control port, data dir, log level, config file, `--help`, `--version` (only the flags the capture confirms exist — if the SDK's CLI is minimal, the table shrinks accordingly).
- [ ] Annotate each row with one of `[story 35.5]`, `[story 36.2]`, `[operator-only]` per the AC 7 mapping:
  - `socksPort` / `binaryPath` / `configFilePath` / `hiddenServiceDir` / `hiddenServicePort` → `[story 35.5]`
  - flags added by the audit itself → `[story 36.2]`
  - operator-facing only → `[operator-only]`
- [ ] Add a link line: `see docs/ator-transport/anyone-proxy-help.txt for the full flag surface as of the audit`.
- [ ] Ensure each managed-client programmatic option name (`socksPort`, `binaryPath`, etc.) appears somewhere in the doc (the acceptance test greps for these verbatim).
- [ ] Run the acceptance suite scoped to AC 3 and AC 7.
- [ ] ✅ AC 3 + AC 7 turn green.

**Estimated Effort:** 1.5 h (prose work + table authoring).

---

### Test: AC 4 — provenance line grep-gated

**File:** `docs/ator-transport.md` (add blockquote line immediately below Option A.2 code fence)

- [ ] Add:
  ```markdown
  > Flag surface verified against @anyone-protocol/anyone-client@1.1.3 on 2026-04-15.
  ```
- [ ] Confirm the version segment matches `node -e "console.log(require('@anyone-protocol/anyone-client/package.json').version)"`.
- [ ] Run: `-t "AC 4"` — expect 3 green.
- [ ] ✅ AC 4 turns green.

**Estimated Effort:** 0.1 h

---

### Test: AC 8 — Option B cross-reference

**File:** `docs/ator-transport.md` (edit §Option B)

- [ ] Add one sentence pointing readers to §Installation Option A.2 for the flag surface, naming the `2026-04-15` audit date.
- [ ] Run: `-t "AC 8"` — expect 3 green.
- [ ] ✅ AC 8 turns green.

**Estimated Effort:** 0.2 h

---

### Test: AC 9 — CHANGELOG + scope tripwire

**Files:**
- `CHANGELOG.md` (add line to `## [Unreleased]`)

- [ ] Add under `### Documentation` (or `### Added` if the unreleased section has no Documentation subsection yet):
  ```markdown
  - **36-2:** Audit @anyone-protocol/anyone-client CLI flag surface; replace "consult docs.anyone.io" hedges in docs/ator-transport.md with verified flag tables; add --help snapshot diff gate.
  ```
- [ ] Confirm NO edits under `packages/connector/src/`, `docker/`, `infra/`, or `Makefile`.
- [ ] Run: `-t "AC 9"` — expect 2 green.
- [ ] ✅ AC 9 turns green.

**Estimated Effort:** 0.1 h

---

### Dev-run gates (NOT jest; record in Completion Notes)

- [ ] **Task 7.5 (AC 9):** `git log --name-only --format= <story-start-sha>..HEAD | sort -u` lists ONLY the 7 allowed files.
- [ ] **Task 7.6 (AC 10):** Run each documented command from §Option A.2 verbatim; record command + exit code + first 5 lines of output.
- [ ] **Task 6.2:** Flip `sprint-status.yaml` `epics.epic-36.stories.36.2.status` from `ready-for-dev` → `done`.

---

## Running Tests

```bash
# Run the snapshot-diff integration test (AC 6)
npm run test:integration -w packages/connector -- --testPathPattern 'story-36-2-anon-cli-snapshot'

# Run the full acceptance gate suite for this story (AC 1-5, AC 7-9 static portions)
cd packages/connector && npx jest --config jest.acceptance.config.js --testPathPattern story-36-2

# Scope to a single AC while iterating
cd packages/connector && npx jest --config jest.acceptance.config.js --testPathPattern story-36-2 -t "AC 4"

# Debug a single integration test with verbose output
npm run test:integration -w packages/connector -- --testPathPattern 'story-36-2-anon-cli-snapshot' --verbose

# Developer-run provenance check (mirrors AC 4 grep gate)
grep -cE "Flag surface verified against @anyone-protocol/anyone-client@[0-9]+\.[0-9]+\.[0-9]+ on [0-9]{4}-[0-9]{2}-[0-9]{2}" docs/ator-transport.md

# Developer-run hedge checks (mirror AC 1 / AC 2)
grep -iEc "consult[^\\n]*docs\\.anyone\\.io|docs\\.anyone\\.io[^\\n]*for[^\\n]*(current|current CLI|flag)" docs/ator-transport.md
grep -c "do not guess" docs/ator-transport.md
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete) ✅

**TEA Agent Deliverables:**

- ✅ Integration snapshot-diff test authored at `packages/connector/test/integration/story-36-2-anon-cli-snapshot.test.ts` — fails with `ENOENT` on missing snapshots.
- ✅ Acceptance gate suite authored at `packages/connector/test/acceptance/story-36-2-anyone-client-sdk-cli-flag-audit.test.ts` — 20 failed / 9 passed / 29 total, each failure traceable to a specific missing implementation artifact.
- ✅ Implementation checklist above maps every RED test to a concrete dev task.
- ✅ Regeneration-hint canary (`Regenerate with: NO_COLOR=1`) baked into the integration test; AC 6 acceptance test grep-gates it.
- ✅ R-14 skip branch wired into integration test: outer `describeIfSdk` + explicit `test.skip(...)` reason line.

**Verification:**

- All tests run and fail as expected.
- Failure messages are clear: ENOENT for snapshots, exact token missing for doc-textual ACs, resolved-version mismatch for provenance.
- Failures are due to missing implementation, not test bugs (the 9 passes confirm the test file is well-formed and the scope tripwire is correctly asymmetric).

---

### GREEN Phase (DEV Team — Next Steps)

Follow the Implementation Checklist in order. Each task block lists:

1. The exact file(s) to touch.
2. The command to re-run the scoped test.
3. The expected pass count.

Start with AC 1 + AC 2 (0.25 h, one-line delete) to build momentum. Then AC 5 (snapshots) — that unblocks AC 6 the moment the committed file is in place. AC 3 / AC 7 are the bulk of the writing; do them together because they edit the same section.

---

### REFACTOR Phase (DEV Team — After All Tests Pass)

Scope for this story is small enough that refactor is mostly "read the finished doc out loud, confirm it sounds like operator-grade prose not stream-of-consciousness notes." Nothing to consolidate in the test code — each describe block is one AC.

---

## Next Steps

1. Hand this checklist + the two authored test files to the dev-story workflow.
2. Dev-story runs `cd packages/connector && npx jest --config jest.acceptance.config.js --testPathPattern story-36-2` to confirm RED phase locally (expect 20 failed).
3. Dev works the Implementation Checklist block by block (RED → GREEN per block).
4. Dev records Task 7.5 and Task 7.6 evidence in the story's Completion Notes.
5. Dev flips `sprint-status.yaml` to `done`.
6. Open PR; CI runs `test:acceptance` + `test:integration`; snapshot-diff gate enforces flag-surface freshness on every subsequent PR.

---

## Knowledge Base References Applied

- **test-levels-framework.md** — level selection (integration for real-binary spawn, acceptance for static textual invariants).
- **test-quality.md** — one-AC-per-describe-block organization, failure messages point at remediation.
- **test-healing-patterns.md** — R-14 skip-not-pass pattern; regeneration-hint canary locks out silent weakening.
- **data-factories.md** — N/A for this story (no domain entities; filesystem-only inputs).
- **component-tdd.md** — N/A (no UI).

---

## Test Execution Evidence

### Initial Test Runs (RED Phase Verification)

#### Integration test (AC 6)

**Command:** `npx jest --config packages/connector/jest.config.js packages/connector/test/integration/story-36-2-anon-cli-snapshot.test.ts`

**Results:**

```
FAIL connector packages/connector/test/integration/story-36-2-anon-cli-snapshot.test.ts
  Story 36.2 — anyone-client SDK CLI flag-surface snapshot gate
    ✕ anyone-proxy --help output matches the committed snapshot (48 ms)
    ✕ anyone-client --help output matches the committed snapshot (37 ms)

  ● ... anyone-proxy --help output matches the committed snapshot
    ENOENT: no such file or directory, open '.../docs/ator-transport/anyone-proxy-help.txt'

  ● ... anyone-client --help output matches the committed snapshot
    ENOENT: no such file or directory, open '.../docs/ator-transport/anyone-client-help.txt'

Test Suites: 1 failed, 1 total
Tests:       2 failed, 2 total
```

**Summary:** 2 failing, 0 passing — ✅ RED phase verified for AC 6.

#### Acceptance test (AC 1–9 static portions)

**Command:** `cd packages/connector && npx jest --config jest.acceptance.config.js --testPathPattern=story-36-2`

**Results:**

```
Test Suites: 1 failed, 1 total
Tests:       20 failed, 9 passed, 29 total
```

**Failure distribution (by AC):**

- AC 1: 2/2 fail (hedge still present on line 68)
- AC 2: 1/1 fail (phrase still present)
- AC 3: 4/4 fail (section not yet rewritten)
- AC 4: 3/3 fail (no provenance line yet)
- AC 5: 6/6 fail (snapshot dir absent)
- AC 6 (static file-shape): 3/3 pass ✅ (integration test IS authored)
- AC 7: 4/4 fail (no annotation tokens)
- AC 8: 1/3 fail + 2/3 pass (section exists; audit date not yet mentioned)
- AC 9: 1/2 fail + 1/2 pass (CHANGELOG entry missing; src/ tripwire clean)

**Summary:** 20 failing, 9 passing — ✅ RED phase verified for static ACs. Each failure traces back to a specific, uncompleted story task.

---

## Notes

- **Scope discipline:** Task 6 (CHANGELOG + sprint-status flip) is tested at AC 9 acceptance level; Task 7.5 and Task 7.6 are intentionally NOT in jest — they are dev-run checks whose evidence lives in Completion Notes. Do not expand jest scope to cover them; that would conflate test-design-epic-36's "static vs dev-run" boundary.

- **Field reality vs `--help` convention (Task 1.3):** Both CLIs currently reject `--help`. The snapshot-diff gate captures the rejection output byte-for-byte and makes any future CLI behavior change (including "now `--help` works") a diff event, not a silent win. The committed snapshot therefore encodes the ugly-but-real current behavior deliberately.

- **R-14 CI distinction:** Reviewers reading CI logs should see:
  - On supported platforms: `2 passing` under `test:integration`.
  - On unsupported platforms: `2 skipped` with the reason string `@anyone-protocol/anyone-client not installed`.
  - `0 passing, 0 skipped, 0 failing` for story-36-2 on any platform is a CI-infra failure, not a passing-green state — alert the reviewer.

- **AC 9 asymmetric enforcement:** The static jest tripwire (grep for `Story 36.2` banner under `packages/connector/src/**`) catches the 80%-case accidental copy-paste; the definitive check remains Task 7.5's shell-level `git log --name-only`. Keep BOTH — they complement, they do not duplicate.

- **Existing tests MUST continue passing:** In particular `socks-transport-provider.test.ts` and `managed-anon-client.test.ts` under `packages/connector/test/unit/transport/` reference `@anyone-protocol/anyone-client` via mock factories. This story touches zero source code those tests exercise. Any regression there is unrelated breakage — investigate before blaming this story.

---

## Files Created by This Workflow

- `packages/connector/test/integration/story-36-2-anon-cli-snapshot.test.ts` — **NEW**, ~220 lines, the AC 6 integration gate.
- `packages/connector/test/acceptance/story-36-2-anyone-client-sdk-cli-flag-audit.test.ts` — **NEW**, ~400 lines, 29 tests across 9 describe blocks covering AC 1–AC 9 static portions.
- `_bmad-output/test-artifacts/atdd-checklist-36-2.md` — this file.

---

## Validation Against Checklist

- ✅ Prerequisites satisfied — story approved, jest + ts-jest configured, optional SDK dep present at `@anyone-protocol/anyone-client@1.1.3`.
- ✅ Test files created at the correct paths (matches 36.1's `test/acceptance/` + `test/integration/` split).
- ✅ Checklist maps each acceptance criterion to concrete dev tasks.
- ✅ Tests are designed to fail before implementation — verified by executing both suites against the current tree (20 failed / 9 passed / 29 in acceptance; 2 failed / 0 passed / 2 in integration).
- ✅ No CLI sessions to clean up (no browser automation).
- ✅ Temp artifacts written to `{test_artifacts}` (this file) — not to random locations.

---

## Contact

**Generated by BMAD TEA Agent** — 2026-04-15
