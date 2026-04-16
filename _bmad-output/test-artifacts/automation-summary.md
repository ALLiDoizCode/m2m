---
stepsCompleted: ['step-01-preflight-and-context', 'step-02-identify-targets', 'step-03-generate-tests', 'step-04-validate-and-summarize']
lastStep: 'step-04-validate-and-summarize'
lastSaved: '2026-04-15'
story: '36.3'
artifact: '_bmad-output/implementation-artifacts/36-3-real-binary-socks5-integration-test.md'
mode: 'yolo'
---

# Story 36.3 Automation Coverage Summary

## Coverage Assessment (pre-automation)

| AC    | Covered before this run                                                              | File                                                               |
| ----- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| AC 1  | Yes — env-gated describe + file-level JSDoc disclaimer                               | `test/integration/transport-ator-real-binary.test.ts`             |
| AC 2  | N/A — requires live docker stack (infra test, not jest)                              | `make ator-test`                                                   |
| AC 3  | Partial — skip happens; no assertion of gate semantics or no-TCP-when-off            | same                                                               |
| AC 4  | Yes — gated T-36.3-01 block                                                          | same                                                               |
| AC 5  | Yes — gated T-36.3-02 block                                                          | same                                                               |
| AC 6  | Partial — scheme-reject existed but GATED + no `net.Socket` spy belt-and-suspenders | same                                                               |
| AC 7  | Yes — gated T-36.3-04 block                                                          | same                                                               |
| AC 8  | Yes — gated T-36.3-05 block                                                          | same                                                               |
| AC 9  | Yes — gated T-36.3-06 block                                                          | same                                                               |
| AC 10 | Yes — gated T-36.3-07 block (last-in-suite + afterAll restore)                       | same                                                               |
| AC 11 | Yes — gated T-36.3-08 (small + ≥8KB large-frame)                                    | same                                                               |
| AC 12 | Yes — gated T-36.3-09 (stop + throw-during-test)                                    | same                                                               |
| AC 13 | Partial — files renamed; JSDoc disclaimer asserted; **no grep audit gate**           | `test/integration/socks5-contract.test.ts` (disclaimer only)      |
| AC 14 | Yes — static disclaimer self-checks on both sides                                    | both suites                                                        |
| AC 15 | N/A — enforced by code review / git diff                                             | —                                                                  |
| AC 16 | N/A — CHANGELOG + sprint-status, reviewer-owned                                      | —                                                                  |

## Gaps Identified

Three concrete coverage gaps that could be filled by ungated jest tests (i.e., run under every `make test`, no `ATOR_NIGHTLY` required):

1. **AC 6 scheme-reject must be ungated + belt-and-suspenders.** The story AC explicitly states "this sub-case runs even on a degraded stack because it asserts fail-closed BEFORE any network activity (it is the only case in the suite that does not require a healthy circuit)." The pre-existing scheme-reject test was *inside* `describeRealBinary`, so it ran ONLY under `ATOR_NIGHTLY=1`. Also missing: the `net.Socket` spy belt-and-suspenders the AC calls for ("NO TCP connection to the SOCKS port is ever opened").

2. **AC 3 belt-and-suspenders.** The AC calls out an optional "spy on `net.connect` / `child_process.spawn`" check. At minimum, a static guard asserting the env-gate expression and `describe.skip` conditional pattern is load-bearing in the file.

3. **AC 13 grep audit.** The AC requires "a case-sensitive grep is performed for the string `in-process-socks5-proxy` → zero matches returned." Nothing in jest was asserting this, so a future accidental reintroduction of the old name via a copy-paste or a regenerated doc block would pass CI silently.

## Tests Added

All additions are in the existing file `packages/connector/test/integration/transport-ator-real-binary.test.ts`, placed OUTSIDE the `describeRealBinary` block so they run unconditionally:

### 1. `T-36.3-03 (AC 6): socks5:// scheme reject — SEC-03, network-free`

Two `it()` blocks under a dedicated describe:

- Installs a `jest.spyOn(net.Socket.prototype, 'connect')` spy in `beforeEach`; replaces with a no-op that counts calls and immediately emits `error` on any invocation — guarantees no real TCP is attempted even under a future regression.
- **Test 1:** `expect(() => new SocksTransportProvider({ socksProxy: 'socks5://...' }))` throws `/socks5h/i` AND `socketConnectCount === 0`.
- **Test 2:** same property via `try/catch` — proves the rejection is synchronous-within-construction, not deferred to a later tick.

### 2. `AC 3: real-binary suite is silently skipped when ATOR_NIGHTLY is unset`

Three `it()` blocks:

- **Test 1:** Reads the test file's own contents and asserts the guard expression `/process\.env\.ATOR_NIGHTLY\s*===\s*'1'/` AND the conditional `/REAL_BINARY\s*\?\s*describe\s*:\s*describe\.skip/` are both present — load-bearing patterns that MUST remain verbatim.
- **Test 2:** Re-evaluates `process.env.ATOR_NIGHTLY === '1'` in the test scope and asserts it matches the `REAL_BINARY` module constant. Drift between the module-load evaluation and runtime semantics fails fast.
- **Test 3:** Reads the repo `Makefile` and asserts both `ATOR_NIGHTLY=1` and `docker compose port hs1 9050` appear — the dynamic-port invocation contract (AC 3's explicit NOTE about dynamic host-port) cannot silently break.

### 3. `AC 13: zero stale references to pre-rename filenames in runtime code`

Two `it()` blocks driving a `grep -r` via `child_process.exec` over `packages/connector/`:

- Excludes `node_modules`, `dist`, `coverage`, and **this test file itself** (self-reference filter — the test legitimately names the old strings in its assertion literals).
- **Test 1:** zero matches for `in-process-socks5-proxy`.
- **Test 2:** zero matches for `transport-socks5.test`.

## Validation

```
npx jest --config packages/connector/jest.config.js \
  packages/connector/test/integration/transport-ator-real-binary.test.ts
```

- **Test Suites: 1 passed, 1 total**
- **Tests: 13 skipped, 8 passed, 21 total** (1.6 s)
- 8 passing = the 1 pre-existing ungated disclaimer + 7 new ungated tests.
- 13 skipped = the `describeRealBinary` gated tests (correct behavior with `ATOR_NIGHTLY` unset).
- `npx eslint packages/connector/test/integration/transport-ator-real-binary.test.ts` → clean.

## Design decisions

- **Placed new tests in the existing real-binary file**, outside the gated block, rather than creating a new test file. Rationale: the new tests are directly *about* the properties of the real-binary suite (its gate, its scheme-reject subcase, its sibling rename), and co-locating them keeps the AC→test mapping trivial. No new jest config entry; existing `**/*.test.ts` discovery picks them up (AC 15 compliance preserved).
- **Spy on `net.Socket.prototype.connect`, not `net.connect`.** The latter is a readonly module export and `jest.spyOn` can't replace it. The former is the real choke-point any SOCKS library eventually hits, so the spy is actually stricter than the AC's example.
- **AC 13 grep uses the local file's `__filename` for self-exclusion** rather than a path-pattern skip — robust to future directory reorganizations.
- **AC 3 Makefile check is non-blocking if `Makefile` isn't found** (guarded by `fs.existsSync`) so a repo-layout refactor doesn't flake the test. The runtime `beforeAll` inside the gated block is the stronger enforcement point.

## What this run did NOT do

- Did not touch `packages/connector/src/**` (AC 15 bright-line preserved).
- Did not add a new jest project / config entry (AC 15).
- Did not modify the existing gated tests (they cover AC 4, 5, 7–12 correctly under `ATOR_NIGHTLY=1`).
- Did not attempt to exercise AC 2 (requires live docker — deferred per story's Completion Notes to the nightly CI wiring in Story 36.5, with optional `docker/ator/Dockerfile` + `docker-compose.yml` sidecar edits flagged as follow-up).
- Did not change the `socks5-contract.test.ts` disclaimer check (already covered).

## Files changed in this run

Modified:

- `packages/connector/test/integration/transport-ator-real-binary.test.ts` — three new describe blocks (7 new tests) placed outside the gated block; no changes to pre-existing gated tests.
- `_bmad-output/test-artifacts/automation-summary.md` — this file (overwritten with Story 36.3 coverage summary).

Created: none.
Deleted: none.

## Step Summary

- **Status:** Complete — three concrete ungated coverage gaps filled (AC 3, AC 6 scheme-reject, AC 13 grep audit). All 16 ACs now have at least one automated gate or an explicit N/A justification (AC 2 requires live infra; AC 15/16 are reviewer/code-review owned).
- **Duration:** ~15 minutes (single-pass YOLO, one iteration cycle to fix `net.connect` spyOn-readonly error and grep self-hit).
- **What changed:** 7 new `it()` blocks across 3 new describe blocks in the existing real-binary test file. No source changes, no jest config changes, no new test files.
- **Key decisions:**
  - Co-located new tests with the real-binary file (shared subject matter, no new config entry — AC 15 compliant).
  - Used `net.Socket.prototype.connect` spy (stricter than the AC's `net.connect` example, and actually spyOn-able).
  - Self-excluded `__filename` in the AC 13 grep rather than path-pattern filtering — robust to future reorganizations.
  - Made the Makefile check tolerant of repo-layout changes (guarded by `fs.existsSync`).
- **Issues found & fixed:**
  - Initial `jest.spyOn(net, 'connect')` failed because `net.connect` is a read-only module export; switched to `net.Socket.prototype.connect`.
  - Initial AC 13 grep test self-matched the test file's assertion strings; added `__filename` exclusion.
- **Remaining concerns:**
  - **AC 2 (real end-to-end execution of the gated suite) is still unexercised.** The deferred `docker/ator/Dockerfile` (tcpdump) + `docker-compose.yml` (wss-echo sidecar) edits are prerequisites; Story 36.5 nightly CI wiring will be the first time the real-binary path is exercised unless a thin follow-up story lands first. Flagged in the Dev Agent Record by the implementing dev.
  - The gated tests in `describeRealBinary` have NOT been run green against a live stack in this automation pass — they compile and skip cleanly, which is what AC 1 / AC 3 demand, but their correctness against a real circuit is provable only under `make ator-up && make ator-test`.
- **Migrations:** None. All additions are jest-discovered by the existing `**/*.test.ts` pattern. No changes to `jest.config.js`, `jest.acceptance.config.js`, `package.json`, or CI config.
