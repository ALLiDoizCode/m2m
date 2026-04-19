---
stepsCompleted:
  [
    'step-01-preflight-and-context',
    'step-02-generation-mode',
    'step-03-test-strategy',
    'step-04-generate-tests',
    'step-04c-aggregate',
    'step-05-validate-and-complete',
  ]
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-04-16'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/36-6-docs-deployment-guide-update.md'
  - '_bmad-output/project-context.md'
  - 'docs/ator-transport.md'
---

# ATDD Checklist - Epic 36, Story 36.6: Documentation + Deployment-Guide Update

**Date:** 2026-04-16
**Author:** Jonathan
**Primary Test Level:** Acceptance (file-content validation)

---

## Story Summary

Story 36.6 updates `docs/ator-transport.md` to reflect the verified ground truth established by Stories 36.1--36.5. It adds a Verification Status section, a Local Development Network section, splits Prerequisites into operational vs development, expands Troubleshooting with real-binary failure modes, removes all remaining hedges, and cross-references every file path and CLI flag against the codebase.

**As a** connector operator or security reviewer
**I want** `docs/ator-transport.md` updated to reflect verified ground truth with Verification Status, Local Development Network, split Prerequisites, and real-binary Troubleshooting
**So that** the deployment guide is a single source of truth backed by nightly CI evidence

---

## Acceptance Criteria

1. **AC 1:** Zero remaining hedges -- no "consult docs.anyone.io" or "do not guess" matches in the guide
2. **AC 2:** Verification Status section exists with pinned ATOR binary version, nightly workflow link, real-binary test references
3. **AC 3:** Local Development Network section exists with 7-service topology, make targets, env vars, docker-compose profile
4. **AC 4:** Prerequisites split into operational vs development sub-sections
5. **AC 5:** Troubleshooting updated with at least 3 new real-binary failure modes
6. **AC 6:** Platform Matrix section exists and is consistent with nightly workflow
7. **AC 7:** All file paths and flags mentioned in the guide exist and work
8. **AC 8:** Zero src/ or test/ changes (documentation-only bright line)
9. **AC 9:** CHANGELOG + sprint-status updates

---

## Failing Tests Created (RED Phase)

### Acceptance Tests (41 tests -- 23 RED, 18 GREEN verification)

**File:** `packages/connector/test/acceptance/story-36-6-docs-deployment-guide-update.test.ts` (~605 lines)

**RED (23 tests -- fail until Story 36.6 implementation lands):**

- **Test:** contains a "Verification Status" heading
  - **Status:** RED -- section does not exist yet
  - **Verifies:** AC 2

- **Test:** names the pinned ATOR binary version v0.4.10.0-beta
  - **Status:** RED -- Verification Status section missing
  - **Verifies:** AC 2

- **Test:** links to the nightly workflow file
  - **Status:** RED -- Verification Status section missing
  - **Verifies:** AC 2

- **Test:** references the real-binary test files
  - **Status:** RED -- Verification Status section missing
  - **Verifies:** AC 2

- **Test:** states verification coverage areas
  - **Status:** RED -- Verification Status section missing
  - **Verifies:** AC 2

- **Test:** contains a "Local Development Network" heading
  - **Status:** RED -- section does not exist yet
  - **Verifies:** AC 3

- **Test:** describes the 7-service topology
  - **Status:** RED -- section missing
  - **Verifies:** AC 3

- **Test:** documents make ator-up/down/logs/test targets
  - **Status:** RED -- section missing
  - **Verifies:** AC 3

- **Test:** documents ATOR_NIGHTLY and ATOR_SOCKS_PORT env vars
  - **Status:** RED -- section missing
  - **Verifies:** AC 3

- **Test:** references docker-compose.yml ator profile
  - **Status:** RED -- section missing
  - **Verifies:** AC 3

- **Test:** references docker/ator/Dockerfile
  - **Status:** RED -- section missing
  - **Verifies:** AC 3

- **Test:** mentions the image tag ator-testnet:v0.4.10.0-beta
  - **Status:** RED -- section missing
  - **Verifies:** AC 3

- **Test:** contains an "Operational" prerequisites sub-section or label
  - **Status:** RED -- prerequisites not yet split
  - **Verifies:** AC 4

- **Test:** contains a "Development" prerequisites sub-section or label
  - **Status:** RED -- prerequisites not yet split
  - **Verifies:** AC 4

- **Test:** development prereqs include Docker and make ator-up
  - **Status:** RED -- development sub-section missing
  - **Verifies:** AC 4

- **Test:** development prereqs mention ATOR_NIGHTLY env var
  - **Status:** RED -- development sub-section missing
  - **Verifies:** AC 4

- **Test:** contains at least 3 new real-binary failure mode entries
  - **Status:** RED -- real-binary troubleshooting not yet added
  - **Verifies:** AC 5

- **Test:** each real-binary entry provides a diagnostic command or resolution
  - **Status:** RED -- insufficient code blocks for expanded troubleshooting
  - **Verifies:** AC 5

- **Test:** CHANGELOG.md under [Unreleased] mentions Story 36.6 or 36-6
  - **Status:** RED -- CHANGELOG entry not yet added
  - **Verifies:** AC 9

- **Test:** CHANGELOG entry references deployment guide or documentation update
  - **Status:** RED -- CHANGELOG entry not yet added
  - **Verifies:** AC 9

- **Test:** sprint-status.yaml has 36.6 status set to done
  - **Status:** RED -- status is still ready-for-dev
  - **Verifies:** AC 9

- **Test:** Table of Contents includes a Verification Status entry
  - **Status:** RED -- ToC not yet updated
  - **Verifies:** AC 2, AC 3

- **Test:** Table of Contents includes a Local Development Network entry
  - **Status:** RED -- ToC not yet updated
  - **Verifies:** AC 2, AC 3

**GREEN (18 tests -- pass now, verifying existing correct state):**

- contains no "consult docs.anyone.io" hedge phrase (AC 1 -- already clean)
- contains no "do not guess" hedge phrase (AC 1 -- already clean)
- contains no TBD/TODO/unverified hedging language (AC 1 -- already clean)
- operational prereqs include Node.js and npm (AC 4 -- already present)
- Troubleshooting section exists (AC 5 -- already present)
- contains a "Platform Matrix" heading (AC 6 -- added by 36.5)
- Platform Matrix references the nightly-ator.yml workflow file (AC 6)
- Platform Matrix covers ubuntu-latest and macos platforms (AC 6)
- Platform Matrix distinguishes real-binary vs system-tor-fallback coverage (AC 6)
- every backtick-enclosed project path resolves to an existing file (AC 7)
- nightly-ator.yml workflow file exists (AC 7)
- docker-compose.yml exists (AC 7)
- docker/ator/Dockerfile exists (AC 7)
- Makefile contains ator-up/down/logs/test targets (AC 7)
- referenced test files exist (AC 7)
- no file under packages/connector/src/ carries Story 36.6 tag (AC 8)
- no file under packages/connector/test/ (non-acceptance) carries Story 36.6 tag (AC 8)
- sprint-status.yaml retrospective status remains pending (AC 9)

---

## Data Factories Created

None required. This is a documentation-only story; tests perform static file content analysis using `fs.readFileSync` and regex matching. No runtime data generation needed.

---

## Fixtures Created

None required. Tests use a shared `extractSection()` helper function defined inline in the test file for extracting doc sections by heading. The `readDocs()` and `readIfExists()` lazy readers follow the existing pattern from `story-36-2-anyone-client-sdk-cli-flag-audit.test.ts`.

---

## Mock Requirements

None. Tests are pure filesystem compliance checks -- no HTTP, no Docker, no child processes.

---

## Required data-testid Attributes

Not applicable. No UI components involved.

---

## Implementation Checklist

### Test: Verification Status section (AC 2 -- 5 tests)

**File:** `packages/connector/test/acceptance/story-36-6-docs-deployment-guide-update.test.ts`

**Tasks to make these tests pass:**

- [ ] Add `## Verification Status` section near top of `docs/ator-transport.md`
- [ ] State pinned ATOR binary version: `v0.4.10.0-beta`
- [ ] Link to `.github/workflows/nightly-ator.yml`
- [ ] Reference `transport-ator-real-binary.test.ts` and `transport-ator-hidden-service.test.ts`
- [ ] State verification coverage: circuit build, HS rendezvous, managed lifecycle, DNS-at-proxy, cell fragmentation
- [ ] Run test: `npm run test:acceptance -w packages/connector -- --testPathPattern story-36-6`
- [ ] All 5 AC 2 tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: Local Development Network section (AC 3 -- 7 tests)

**File:** `packages/connector/test/acceptance/story-36-6-docs-deployment-guide-update.test.ts`

**Tasks to make these tests pass:**

- [ ] Add `## Local Development Network` section to `docs/ator-transport.md`
- [ ] Describe 7-service topology (3 DirAuth + 3 relay + 1 HS)
- [ ] Document `make ator-up`, `ator-down`, `ator-logs`, `ator-test` targets
- [ ] Document `ATOR_NIGHTLY=1` and `ATOR_SOCKS_PORT` env vars
- [ ] Reference `docker-compose.yml` ator profile and `ator-testnet:v0.4.10.0-beta` image
- [ ] Reference `docker/ator/Dockerfile`
- [ ] Run test: `npm run test:acceptance -w packages/connector -- --testPathPattern story-36-6`
- [ ] All 7 AC 3 tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: Prerequisites split (AC 4 -- 4 tests, 2 RED + 2 already GREEN)

**File:** `packages/connector/test/acceptance/story-36-6-docs-deployment-guide-update.test.ts`

**Tasks to make these tests pass:**

- [ ] Split Prerequisites section into "Operational Prerequisites" and "Development Prerequisites"
- [ ] Development prereqs: Docker, `make ator-up`, `ATOR_NIGHTLY=1`
- [ ] Operational prereqs: Node.js, npm, anon/tor, optional SDK (unchanged)
- [ ] Run test: `npm run test:acceptance -w packages/connector -- --testPathPattern story-36-6`
- [ ] All 4 AC 4 tests pass (green phase)

**Estimated Effort:** 0.25 hours

---

### Test: Troubleshooting real-binary failure modes (AC 5 -- 2 RED tests)

**File:** `packages/connector/test/acceptance/story-36-6-docs-deployment-guide-update.test.ts`

**Tasks to make these tests pass:**

- [ ] Add "Real-binary test suite failures" subsection with consensus, HS descriptor, circuit timeout entries
- [ ] Add "Docker / make ator-up issues" subsection with image build, port conflicts, container start entries
- [ ] Add "Nightly CI failures" subsection with workflow artifacts, manual re-run, macOS Docker entries
- [ ] Each entry names specific error/symptom and provides diagnostic command or resolution
- [ ] Run test: `npm run test:acceptance -w packages/connector -- --testPathPattern story-36-6`
- [ ] Both AC 5 tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: Table of Contents updates (2 RED tests)

**File:** `packages/connector/test/acceptance/story-36-6-docs-deployment-guide-update.test.ts`

**Tasks to make these tests pass:**

- [ ] Add "Verification Status" entry to Table of Contents
- [ ] Add "Local Development Network" entry to Table of Contents
- [ ] Verify anchor links work
- [ ] Run test: `npm run test:acceptance -w packages/connector -- --testPathPattern story-36-6`
- [ ] Both ToC tests pass (green phase)

**Estimated Effort:** 0.1 hours

---

### Test: CHANGELOG + sprint-status (AC 9 -- 3 RED tests)

**File:** `packages/connector/test/acceptance/story-36-6-docs-deployment-guide-update.test.ts`

**Tasks to make these tests pass:**

- [ ] Add entry under `## [Unreleased]` / `### Added` in `CHANGELOG.md` referencing Story 36.6
- [ ] Flip `epics.epic-36.stories.36.6.status` to `done` in `sprint-status.yaml`
- [ ] Do NOT flip retrospective status
- [ ] Run test: `npm run test:acceptance -w packages/connector -- --testPathPattern story-36-6`
- [ ] All 3 AC 9 tests pass (green phase)

**Estimated Effort:** 0.1 hours

---

## Running Tests

```bash
# Run all acceptance tests for this story
npm run test:acceptance -w packages/connector -- --testPathPattern story-36-6

# Run with verbose output
npm run test:acceptance -w packages/connector -- --testPathPattern story-36-6 --verbose

# Run from connector package directory
cd packages/connector && npx jest --config jest.acceptance.config.js --testPathPattern story-36-6 --no-coverage
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 41 tests written (23 failing, 18 passing verification)
- No fixtures or factories needed (filesystem-only tests)
- No mock requirements (no HTTP/Docker/network)
- No data-testid requirements (no UI)
- Implementation checklist created

**Verification:**

- All 23 RED tests fail due to missing documentation sections, not test bugs
- All 18 GREEN tests pass, confirming existing correct state
- Failure messages are clear and actionable

---

### GREEN Phase (DEV Team -- Next Steps)

**DEV Agent Responsibilities:**

1. Add Verification Status section to docs/ator-transport.md (5 tests)
2. Add Local Development Network section (7 tests)
3. Split Prerequisites into operational/development (4 tests)
4. Expand Troubleshooting with real-binary failure modes (2 tests)
5. Update Table of Contents (2 tests)
6. Update CHANGELOG and sprint-status (3 tests)
7. Run `npx prettier --write docs/ator-transport.md` before committing
8. Run `make lint && npm run format:check` to verify clean
9. Verify `git diff` shows zero `packages/connector/src/**` and `packages/connector/test/**` edits (other than this acceptance test)

---

### REFACTOR Phase (DEV Team -- After All Tests Pass)

1. Verify all 41 tests pass (green phase complete)
2. Run `make test` to confirm no regressions
3. Verify the doc reads coherently as a whole (human review)

---

## Next Steps

1. Run failing tests to confirm RED phase: `npm run test:acceptance -w packages/connector -- --testPathPattern story-36-6`
2. Begin implementation using implementation checklist as guide
3. Work one section at a time (Verification Status -> Local Dev Network -> Prerequisites -> Troubleshooting -> ToC -> CHANGELOG/sprint-status)
4. When all tests pass, run `make lint && npm run format:check` and `make test`
5. When clean, manually update story status to 'done' in sprint-status.yaml

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `cd packages/connector && npx jest --config jest.acceptance.config.js --testPathPattern story-36-6 --no-coverage`

**Results:**

```
Test Suites: 1 failed, 1 total
Tests:       23 failed, 18 passed, 41 total
Snapshots:   0 total
Time:        1.49 s
```

**Summary:**

- Total tests: 41
- Passing: 18 (verification of existing correct state)
- Failing: 23 (new sections/updates not yet implemented)
- Status: RED phase verified

**Expected Failure Messages:**

- AC 2 (5 tests): "Verification Status" heading not found, section content missing
- AC 3 (7 tests): "Local Development Network" heading not found, section content missing
- AC 4 (2 tests): "Operational" and "Development" labels not found in Prerequisites
- AC 5 (2 tests): Insufficient real-binary failure mode indicators and code blocks
- AC 9 (3 tests): CHANGELOG missing 36-6 entry, sprint-status still ready-for-dev
- ToC (2 tests): New section names not found in Table of Contents

---

## Notes

- This is a documentation-only story. The acceptance tests are pure filesystem compliance checks using `fs.readFileSync` and regex matching. No runtime behavior is exercised.
- The test file follows the established pattern from `story-36-2-anyone-client-sdk-cli-flag-audit.test.ts` with lazy file readers and section extraction.
- AC 8 (no src/test changes) is validated by tripwire tests that scan for "Story 36.6" tags in source files. The acceptance test file itself lives in `test/acceptance/` which is explicitly excluded from the tripwire scan.
- 18 tests pass immediately because they verify already-correct state (hedges removed by 36.2, Platform Matrix added by 36.5, file paths exist).

---

**Generated by BMad TEA Agent** -- 2026-04-16
