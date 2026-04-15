---
stepsCompleted: ['step-01-preflight-and-context', 'step-02-identify-targets', 'step-03-generate-tests', 'step-04-validate-and-summarize']
lastStep: 'step-04-validate-and-summarize'
lastSaved: '2026-04-15'
story: '36.2'
artifact: '_bmad-output/implementation-artifacts/36-2-anyone-client-sdk-cli-flag-audit.md'
mode: 'yolo'
---

# Story 36.2 Automation Coverage Summary

## Coverage Assessment (pre-automation)

| AC    | Covered before this run                                                           | File                                                                        |
| ----- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| AC 1  | Yes — hedge-regex assertion                                                       | `test/acceptance/story-36-2-anyone-client-sdk-cli-flag-audit.test.ts`       |
| AC 2  | Yes — `do not guess` count assertion                                              | same                                                                        |
| AC 3  | Yes — Option A.2 disambiguation + key-flag + snapshot-link assertions             | same                                                                        |
| AC 4  | Yes — provenance regex + resolved-version equality + non-future date              | same                                                                        |
| AC 5  | Yes — snapshot existence, header shape, trailing newline, no abs paths, no ANSI   | same                                                                        |
| AC 6  | Yes — snapshot-diff gate (integration) + canary-hint static check (acceptance)   | `test/integration/story-36-2-anon-cli-snapshot.test.ts` + acceptance file   |
| AC 7  | Yes — `[story 35.5]` / `[story 36.2]` / `[operator-only]` tokens + option names   | acceptance file                                                             |
| AC 8  | Yes — Option B presence, audit date, Option A.2 back-link                         | acceptance file                                                             |
| AC 9  | Partial — static "no source tagged Story 36.2" tripwire + CHANGELOG tracer        | acceptance file (shell-level git-log check remains Task 7.5 manual)         |
| AC 10 | **GAP — excluded from acceptance suite as "shell-level, Task 7.6"**               | —                                                                           |

## Gap Identified

**AC 10 (Operator-verbatim smoke)** had zero automated coverage. The acceptance
test file explicitly excluded it (see the header comment "AC 10
operator-verbatim command smoke → shell-level, Task 7.6"). Story completion
recorded AC 10 evidence in Completion Notes as a one-shot dev-run, but nothing
in CI would catch a regression where a documented operator command stopped
being syntactically valid on an SDK bump — the very drift class Epic 36 exists
to prevent.

## Test Added

**New file:** `packages/connector/test/integration/story-36-2-operator-command-smoke.test.ts`

Three `it()` blocks, each invoking a documented command from
`docs/ator-transport.md` §Option A.2 "Example commands" block verbatim via
`spawnSync` with `NO_COLOR=1` and a 10 s timeout:

1. `anyone-proxy --help` — asserts the CLI is reachable, exit status is
   non-null (no daemon hang), and some output was produced.
2. `anyone-client --help` — asserts non-zero exit and either the
   `ERR_PARSE_ARGS_UNKNOWN_OPTION` fingerprint or a proper usage screen on
   exit-0 (future-proof: if the SDK ships real `--help` support the test
   still passes; the snapshot-diff gate catches the behavior change).
3. `anyone-client --bogus-flag` — the exact recipe the docs show for
   "validate flag syntax without starting the daemon"; asserts non-zero
   exit with the `parseArgs` rejection fingerprint.

### Design decisions mirrored from the sibling integration file

- Identical R-14 capability probe (`require.resolve(...)` → `describeIfSdk`)
  so the suite skips explicitly on optional-dep-missing CI legs rather than
  silently passing.
- Identical CLI-path resolution (walk up from the SDK's installed
  `package.json`) so npm workspace hoisting doesn't break the probe.
- Explicit `test.skip` fallthrough when SDK is absent so the CI log shows
  the skip reason rather than "0 tests" for the file.
- `NO_COLOR=1` + 10 s `spawnSync` timeout to prevent daemon-boot hangs.

### Deliberately NOT invoked

- Bare `npx anyone-proxy` (starts a real SOCKS5 daemon).
- `anyone-client -s 9050 -o 9001 -v` (starts the full client daemon).
  Both belong to Story 36.3's real-binary integration scope — AC 10
  explicitly forbids booting the real daemon as a syntactic-validity proof.

## Validation

- `npx jest --config packages/connector/jest.config.js --testPathPattern 'story-36-2-operator-command-smoke'`
  → **3 passed, 0 failed** (1.2 s).
- Lint-safe (mirrors existing `eslint-disable` directives from the sibling
  integration test; same code patterns).

## Pre-existing issue observed (out of scope)

`packages/connector/test/integration/story-36-2-anon-cli-snapshot.test.ts`
is currently **failing deterministically** (5/5 runs) for the `anyone-proxy`
case on the current checkout. The diff is blank-line structural:

```
--- expected (committed) ---
[proxychains] config file found: ...
                                         ← extra blank
[proxychains] preloading ...
```

The committed snapshot has an extra blank line between the first two
`[proxychains]` lines that the live output does not produce. The story's
Dev Agent Record claims "15/15 pass after continuation-line fold", but the
current normalization does not dedupe blank lines. This is pre-existing
unrelated to Story 36.2's AC 10 gap and is **not** addressed here; flag to
the story author / reviewer.

## Files changed in this run

Created:

- `packages/connector/test/integration/story-36-2-operator-command-smoke.test.ts`
- `_bmad-output/test-artifacts/automation-summary.md` (this file — overwritten)

Modified: none.
Deleted: none.

## Step Summary

- **Status:** Complete — AC 10 gap filled; all 10 ACs now have at least one automated gate.
- **Duration:** ~10 minutes (single-pass YOLO, no iteration cycles).
- **What changed:** One new integration test file covering AC 10 (three `spawnSync`-based command smoke checks). Automation summary doc updated.
- **Key decisions:**
  - Filled gap as a **new integration test file**, not as additional `it()` blocks inside the existing snapshot-diff test — keeps responsibilities separate (snapshot drift vs operator-command syntactic validity) and matches the story's own classification of AC 10 as a shell-level concern promoted into integration.
  - Mirrored R-14 skip semantics, CLI resolution, `NO_COLOR=1` env, and 10 s timeout from the sibling snapshot test so the two integration files behave identically on optional-dep-missing legs.
  - Kept AC 10 assertions future-proof: if a future SDK adds real `--help` support the test still passes (exit 0 + usage screen accepted), while the snapshot-diff gate catches the behavior change and forces a re-audit.
- **Issues found & fixed:** None fixed in this run. **Found** a pre-existing deterministic failure in `story-36-2-anon-cli-snapshot.test.ts` (blank-line dedupe gap in `normalize()`) that contradicts the Dev Agent Record's "15/15 pass" claim; flagged in this summary for story author.
- **Remaining concerns:**
  - AC 9's git-log file-list check (Task 7.5) remains manual; no in-jest path to the story-start SHA. The acceptance file's "source tagged Story 36.2" tripwire is the best asymmetric guard available.
  - Pre-existing `story-36-2-anon-cli-snapshot.test.ts` failure should be triaged by the story author before the epic closes.
- **Migrations:** None. The new file is additive; no changes to jest config, no changes to `package.json`, no changes to CI config. `testMatch: '**/*.test.ts'` already discovers the new file.
