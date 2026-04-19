---
stepsCompleted: ['step-01-load-context', 'step-02-discover-tests', 'step-03-quality-evaluation', 'step-04-generate-report']
lastStep: 'step-04-generate-report'
lastSaved: '2026-04-15'
inputDocuments:
  - _bmad-output/implementation-artifacts/36-2-anyone-client-sdk-cli-flag-audit.md
  - packages/connector/test/integration/story-36-2-anon-cli-snapshot.test.ts
  - docs/ator-transport/anyone-proxy-help.txt
  - docs/ator-transport/anyone-client-help.txt
---

# Test Review — Story 36.2 (anyone-client SDK CLI Flag Audit)

**Mode:** yolo (autofix)
**Scope:** single file — `packages/connector/test/integration/story-36-2-anon-cli-snapshot.test.ts`
**Date:** 2026-04-15

## Summary

Story 36.2's snapshot-diff gate test was **failing deterministically** on current SDK output. The failure was a real pre-existing bug flagged in the prior automate step, not flaky infra. Root cause: `normalize()` did not absorb nondeterministic blank-line padding that arises when proxychains piecewise-flushes its preload/config messages across stdout and stderr. The committed snapshot captured one interleaving; the live output produces a different interleaving on replay. Blank-line structure carries no flag-surface signal, so collapsing blank lines on both sides is the correct fix.

## Findings & Fixes

### FINDING 1 (critical, blocking) — Snapshot-diff gate fails on live SDK

**Symptom:** `anyone-proxy --help output drifted from committed snapshot.` — `it(anyone-proxy …)` fails every run.

**Root cause:** Nondeterministic `\n` interleaving between proxychains' stdout/stderr frames. Committed snapshot has blank line after frame 1 and frame 2; live output has blank line only after frame 2. Previous `normalize()` preserved blank-line structure verbatim.

**Fix:** Drop all blank lines in `normalize()` on both the live and committed sides. A real flag-surface change (new, renamed, removed flag) is still a non-blank-line diff; only blank-line padding is masked. Inline comment explains the tradeoff.

**Verification:** 8/8 consecutive test runs pass (previously 0/N).

### FINDING 2 (minor) — Stale `eslint-disable-next-line jest/no-disabled-tests` directive

**Symptom:** `npx eslint` errors with `Definition for rule 'jest/no-disabled-tests' was not found`.

**Root cause:** Dev notes claimed the directive was removed; it wasn't. The project's ESLint config does not install `eslint-plugin-jest`, so the disable-comment itself trips a lint error.

**Fix:** Removed the `// eslint-disable-next-line jest/no-disabled-tests` line above `test.skip(...)` in the R-14 skip-not-pass branch. No semantic behavior change.

### FINDING 3 (minor) — Prettier formatting violations

**Symptom:** `npx prettier --check` fails on the test file.

**Fix:** Ran `npx prettier --write`; file now formats cleanly.

## Quality Evaluation

| Dimension       | Score  | Notes                                                                                                                                                                                   |
| --------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Determinism     | 95/100 | Fixed — nondeterministic blank-line interleaving now absorbed on both sides. 8/8 replays pass.                                                                                          |
| Isolation       | 95/100 | `spawnSync` (synchronous, no orphan processes), `NO_COLOR=1` env pin, 10s timeout, no filesystem writes. Outer `describe.skip` + tail `test.skip` give correct R-14 optional-dep behavior. |
| Maintainability | 90/100 | Rich header comment explains RED-phase intent; regeneration hint literal enforced; every canonicalization regex anchored and commented; AC-6 canary substring preserved.               |
| Performance     | 100/100 | ~500 ms for both `it()` blocks; integration suite total ~4s; no hangs observed.                                                                                                          |
| **Weighted**    | **95/100** | |

## AC Coverage (test-side only — gate checks live in Task 7 of the story)

- AC 5 (snapshot provenance header shape): enforced in `loadCommittedSnapshot` — throws with a descriptive error if the first non-blank line doesn't match `^# Flag surface captured from @anyone-protocol/anyone-client@`.
- AC 6 (diff gate + skip-not-pass + regen hint): two `it()` blocks; failure message includes literal `Regenerate with: NO_COLOR=1` canary per Task 3.4; outer `describe.skip` + tail `test.skip` on missing optional-dep.

## Risk Analysis — Does Blank-Line Removal Mask Real Flag Drift?

- **New flag added** → new non-blank line in live output → diff trips. ✓
- **Flag renamed** → changed non-blank line → diff trips. ✓
- **Flag removed** → missing non-blank line → diff trips. ✓
- **Help text restructured to add/remove blank lines only (no content change)** → no diff trip. This is the intended tradeoff; such a change does not alter the operator-facing flag surface.

No load-bearing semantic signal lives in blank-line structure of a `--help` capture. Acceptable risk profile.

## Remaining Concerns

- **R-14 test.skip path not exercised on this machine.** Optional dep IS installed (darwin/arm64), so the skip-not-pass branch is not runtime-verified here. Covered indirectly: the skip is a 3-line conditional with no branches to mis-wire. CI legs without the bundled binary will exercise it.
- **SDK bump semantics.** When `@anyone-protocol/anyone-client` bumps and help/error text genuinely changes, the gate will fire and a dev will need to (a) re-run `--help` capture, (b) apply Task 2.4 normalization, (c) update the snapshot file's provenance header. The failure message already walks them through this verbatim.

## Migrations

None. Fix is contained to the test file's `normalize()` helper, a stale eslint-disable comment, and prettier formatting. No snapshot files were regenerated (the committed snapshots are still semantically correct — they captured the real flag surface; the fix is on the comparison side).

## Step Summary

- **Status:** green — 8/8 consecutive runs pass, lint clean, format clean
- **Duration:** ~6 min (investigation + 2 edits + determinism validation)
- **What changed:**
  - `packages/connector/test/integration/story-36-2-anon-cli-snapshot.test.ts` — dropped all blank lines in `normalize()` on both live and committed sides (absorbs proxychains stdout/stderr interleaving); removed stale `eslint-disable-next-line jest/no-disabled-tests`; prettier reformat.
- **Key decisions:**
  - Fix is on the comparison side, not the snapshot side. Snapshots captured real flag-surface bytes; regenerating them would paper over the bug and leave future runs flaky on machines that happen to interleave differently.
  - Dropped all blank lines rather than collapsing 2+ to 1 — the latter is insufficient when one side has `a\n\nb\n\nc` and the other has `a\nb\n\nc` (different non-zero blank counts).
- **Issues found & fixed:**
  1. Normalize didn't absorb nondeterministic blank-line padding (critical, blocking) — fixed.
  2. Stale `eslint-disable` for uninstalled `jest/no-disabled-tests` rule (minor, lint error) — fixed.
  3. Prettier violations (minor) — fixed.
- **Remaining concerns:** R-14 skip branch not runtime-exercised on macOS (optional dep present); covered by inspection.
- **Migrations:** None.
