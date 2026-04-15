# Decision: Story Validation Default Policy

**Status:** Accepted
**Date:** 2026-04-15
**Context:** Epic 35 retrospective action item #1 (carried 4 epics; Epic 34 team
agreement requires a decision after 3 epics carried).

## Background

`validate-next-story` (the BMAD story-validation pass) has been run on every
story across Epics 32-35. The retrospectives across those epics consistently
observed that:

- Validation found few defects on small, well-scoped stories (most ACs <= 6).
- Larger stories (AC count >= 8, or stories adding new subsystems / security
  surfaces) surfaced meaningful issues during validation (e.g., Story 35.2
  SOCKS5 implementation, Story 35.5 managed lifecycle).
- Running validation on every story was cited as process overhead with a
  diminishing return, contributing to the "carried 3+ epics" churn list.

## Decision

**Default: skip `validate-next-story` unless at least one of these triggers
applies.**

Run validation when any of the following is true:

1. **AC count >= 7.** Story-level complexity threshold; borderline stories
   should err toward validation.
2. **Security-sensitive surface.** Story introduces or materially modifies:
   - authentication / authorization
   - cryptographic primitives (signing, verification, key handling)
   - network-exposed endpoints (BTP server, HTTP, new transports)
   - settlement / value-moving code paths
   - child-process lifecycle, subprocess spawning, or privileged filesystem
     access
3. **New subsystem.** Story adds a new top-level subsystem or abstraction
   (e.g., new `Provider` interface, new chain integration, new managed
   lifecycle).
4. **Explicit opt-in.** The PM / SM requests validation for a specific story
   because of integration risk, unclear ACs, or cross-cutting scope.

Stories that do NOT meet any trigger skip validation by default. This covers
most docs stories, most single-file refactors, most test-only stories, and
most small config additions.

## Rationale

- The AC count and security-surface triggers track where validation has
  actually found issues across Epics 32-35.
- A hard default ("always run" or "never run") is wrong; the tool earns its
  keep on exactly the class of stories it was designed for (larger, riskier,
  architecturally novel). A rule that matches that class is strictly better
  than a binary default.
- This keeps the process cost proportional to risk and resolves the carried
  action item without throwing away a tool that has caught real issues.

## Enforcement

- Story creation (`bmad-bmm-create-story` / `auto-bmad:story`) should note in
  the story spec whether validation applies (one-line: "Validation: skipped
  (trigger: none)" or "Validation: required (trigger: AC count 9 + network
  surface)").
- Epic retrospectives should track validation outcomes on triggered stories
  and revisit the thresholds if the found-defect rate drops to zero for two
  consecutive epics on triggered stories.

## Review

Revisit this policy at the Epic 37 retrospective (two epics from now) with
aggregated data on:
- how often a trigger fired,
- how often validation found a defect,
- whether any skipped-by-default story later had a defect that validation
  would plausibly have caught.
