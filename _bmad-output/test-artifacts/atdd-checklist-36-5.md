---
stepsCompleted:
  [
    'step-01-preflight-and-context',
    'step-02-generation-mode',
    'step-03-test-strategy',
    'step-04c-aggregate',
    'step-05-validate-and-complete',
  ]
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-04-16'
workflowType: 'testarch-atdd'
inputDocuments:
  [
    '_bmad-output/implementation-artifacts/36-5-nightly-ci-workflow-system-tor-fallback.md',
    'packages/connector/jest.config.js',
    'packages/connector/test/integration/transport-ator-real-binary.test.ts',
    'packages/connector/test/integration/transport-ator-hidden-service.test.ts',
    'packages/connector/src/transport/socks-transport-provider.ts',
    'packages/connector/src/transport/probe-tcp-port.ts',
    '.github/workflows/ci.yml',
    'docs/ator-transport.md',
  ]
---

# ATDD Checklist - Epic 36, Story 36.5: Nightly CI Workflow + System-Tor Fallback Smoke

**Date:** 2026-04-16
**Author:** Jonathan
**Primary Test Level:** Integration (smoke)

---

## Story Summary

Story 36.5 adds a GitHub Actions nightly CI workflow (`nightly-ator.yml`) that runs the real-binary ATOR suite on Linux + macOS, plus a system-`tor` fallback smoke test on each platform that proves `SocksTransportProvider` works with `apt-get install tor` (Linux) and `brew install tor` (macOS).

**As a** connector maintainer and nightly-CI operator
**I want** a nightly workflow + system-tor fallback smoke test
**So that** transport-touching regressions are caught before merge, the Epic 35 R-005 system-tor fallback is exercised for the first time, and the three-epic stack of deferred real-binary integration is closed with automated nightly coverage on both primary platforms.

---

## Acceptance Criteria

Story 36.5 has 17 ACs mapped to 9 test-design T-IDs (T-36.5-01 through T-36.5-09). The ATDD scope covers the **testable code artifacts** -- the system-tor fallback smoke test (AC 4, AC 7, AC 8, AC 9, AC 12) and the env-gate self-check. The workflow YAML file (AC 1-3, AC 5-6, AC 10-11, AC 13-17) is infrastructure that is validated by structural inspection, not by jest tests.

### Testable ACs (covered by generated test file)

| AC  | T-ID       | Scenario                                                     | Test Level  |
| --- | ---------- | ------------------------------------------------------------ | ----------- |
| 4   | --         | System-tor fallback smoke test file exists with env gate     | Integration |
| 7   | T-36.5-07a | SocksTransportProvider.start() succeeds with system tor      | Integration |
| 8   | T-36.5-07b | TCP round-trip through system tor SOCKS proxy (local echo)   | Integration |
| 9   | T-36.5-07c | SocksTransportProvider.stop() cleans up with system tor      | Integration |
| 12  | --         | `make test` remains fast; new test file skipped when unset   | Integration |

### Infrastructure ACs (validated by workflow YAML inspection, not jest)

| AC     | T-ID       | Scenario                                              | Validation Method        |
| ------ | ---------- | ----------------------------------------------------- | ------------------------ |
| 1      | --         | Workflow file at canonical path with cron + dispatch   | File existence + YAML    |
| 2      | T-36.5-05  | Real-binary matrix: Linux + macOS                      | YAML structure           |
| 3      | T-36.5-07  | System-tor fallback matrix: Linux + macOS              | YAML structure           |
| 5      | T-36.5-01  | Nightly cron fires                                     | GitHub Actions           |
| 6      | T-36.5-02  | workflow_dispatch invocable                             | GitHub Actions           |
| 10     | T-36.5-08  | Failure artifacts uploaded                              | YAML `if: failure()`     |
| 11     | --         | docs/ator-transport.md Platform Matrix section          | Doc inspection           |
| 13     | --         | Zero src/ changes                                      | `git diff`               |
| 14     | --         | CHANGELOG + sprint-status updated                      | File inspection          |
| 15     | T-36.5-04  | Workflow within 25-min budget                           | Runtime measurement      |
| 16     | T-36.5-06  | macOS Docker availability handling                      | YAML conditional steps   |
| 17     | T-36.5-09  | arm64 coverage gap documented                           | Workflow comment          |

---

## Failing Tests Created (RED Phase)

### Integration Tests (6 tests: 3 ungated pass, 3 gated skip)

**File:** `packages/connector/test/integration/transport-system-tor-fallback.test.ts` (280 lines)

The test uses the **env-gate pattern** from Stories 36.3/36.4. When `SYSTEM_TOR_SMOKE` is unset, gated tests are skipped. When set to `1` without a running system tor, they fail (RED). When set to `1` with a running system tor, they pass (GREEN).

- **Test:** AC 4: env-gate self-check (file-level gate uses SYSTEM_TOR_SMOKE)
  - **Status:** GREEN (ungated, always runs) -- validates the gate itself
  - **Verifies:** Env-gate pattern is present and semantically correct

- **Test:** AC 4: SMOKE gate value matches env-var semantics exactly
  - **Status:** GREEN (ungated) -- runtime self-consistency check
  - **Verifies:** `SMOKE` variable matches `process.env.SYSTEM_TOR_SMOKE === '1'`

- **Test:** AC 4: SYSTEM_TOR_PORT defaults to 9050 when unset
  - **Status:** GREEN (ungated) -- validates default port
  - **Verifies:** Platform portability via env var override

- **Test:** T-36.5-07a: start() resolves without error and healthCheck() returns true
  - **Status:** RED (requires SYSTEM_TOR_SMOKE=1 + running tor)
  - **Verifies:** SocksTransportProvider works with system tor SOCKS5 proxy

- **Test:** T-36.5-07b: TCP round-trip through system tor SOCKS proxy to local echo server
  - **Status:** RED (requires SYSTEM_TOR_SMOKE=1 + running tor)
  - **Verifies:** Data flows correctly through the SOCKS proxy path

- **Test:** T-36.5-07c: provider.stop() resolves without error
  - **Status:** RED (requires SYSTEM_TOR_SMOKE=1 + running tor)
  - **Verifies:** Clean provider teardown with system tor

---

## Data Factories Created

N/A -- This is a smoke test for transport infrastructure. No domain entities or API contracts are involved. Test data is a simple `Buffer.from('hello-system-tor-fallback')` payload for the echo round-trip.

---

## Fixtures Created

N/A -- The test uses inline helpers (`tcpProbe`, `makeLogger`, `trackProvider`) following the established patterns from `transport-ator-real-binary.test.ts`. A `net.createServer` echo sidecar is spun up inline for the round-trip test. No shared fixture files were needed.

---

## Mock Requirements

None. This is a smoke test against a real system tor SOCKS5 proxy. No mocking is used -- the test exercises the actual `SocksTransportProvider` against a real SOCKS5 endpoint.

---

## Required data-testid Attributes

N/A -- Backend integration test; no UI components.

---

## Implementation Checklist

### Test: transport-system-tor-fallback.test.ts (all scenarios)

**File:** `packages/connector/test/integration/transport-system-tor-fallback.test.ts`

**Tasks to make the gated tests pass (GREEN phase):**

- [x] Create the test file with env-gate pattern (SYSTEM_TOR_SMOKE)
- [x] Implement T-36.5-07a: provider start + healthCheck scenario
- [x] Implement T-36.5-07b: local echo server + SOCKS-proxied TCP round-trip
- [x] Implement T-36.5-07c: provider stop scenario
- [x] Add afterAll cleanup with trackProvider pattern
- [x] Verify ungated tests pass under `make test`
- [x] Verify gated tests skip under `make test` (no SYSTEM_TOR_SMOKE)
- [x] Lint clean (`npx eslint`)
- [x] Format clean (`prettier --check`)
- [ ] Run with `SYSTEM_TOR_SMOKE=1` against running system tor (nightly CI or manual)

**Estimated Effort:** Test file itself: ~0.5 hours (complete). Full story (workflow + docs + CHANGELOG): ~2 days.

### Workflow: .github/workflows/nightly-ator.yml

**Tasks (not jest-testable -- infrastructure):**

- [ ] Create workflow file with `name: nightly-ator`
- [ ] Define triggers: schedule cron `"0 4 * * *"` + workflow_dispatch
- [ ] Define `real-binary` job with matrix `[ubuntu-latest, macos-14]`
- [ ] Define `system-tor-fallback` job with per-OS install commands
- [ ] Add failure artifact upload with `actions/upload-artifact@v4`
- [ ] Add arm64 coverage gap comment (T-36.5-09)
- [ ] Add macOS Docker availability check (T-36.5-06)
- [ ] Record pinned anon binary version in job summary (T-36.5-03)

### Documentation: docs/ator-transport.md

- [ ] Add Platform Matrix section (ubuntu-latest, macos-14, arm64 gap, Windows N/A)
- [ ] Reference nightly workflow file path

### Housekeeping

- [ ] CHANGELOG.md entry under `## [Unreleased]` > `Added`
- [ ] sprint-status.yaml: flip 36.5 status to `done`

---

## Running Tests

```bash
# Run the env-gate self-check (always passes, no tor needed)
npx jest packages/connector/test/integration/transport-system-tor-fallback.test.ts --ci --verbose

# Run with system tor (requires tor installed and running on port 9050)
SYSTEM_TOR_SMOKE=1 npx jest packages/connector/test/integration/transport-system-tor-fallback.test.ts --ci --verbose

# Run with custom tor port
SYSTEM_TOR_SMOKE=1 SYSTEM_TOR_PORT=9150 npx jest packages/connector/test/integration/transport-system-tor-fallback.test.ts --ci --verbose

# Run full test suite (new test auto-discovered, gated tests skipped)
make test
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- Test file created with env-gate pattern
- 3 ungated self-check tests (always pass)
- 3 gated smoke tests (skip without tor, fail without implementation infra)
- `trackProvider()` cleanup pattern applied
- Local echo server for round-trip (no external network access)
- T-ID crosswalk in JSDoc header

**Verification:**

- `make test` runs cleanly: 3 pass, 3 skip (verified)
- `make lint` clean (verified)
- `npm run format:check` clean (verified)

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. Create `.github/workflows/nightly-ator.yml` (AC 1-3, 5-6, 10, 15-17)
2. Update `docs/ator-transport.md` with Platform Matrix (AC 11)
3. Update CHANGELOG.md (AC 14)
4. Update sprint-status.yaml (AC 14)
5. Verify `git diff epic-36~1..HEAD -- 'packages/connector/src/**'` shows zero src/ edits (AC 13)
6. Run nightly workflow manually via `gh workflow run nightly-ator` to verify (AC 6)

---

### REFACTOR Phase (After All Tests Pass)

- Evaluate TODO(36.5) from Story 36.4: extract shared docker compose helpers to `packages/connector/test/helpers/ator-compose-helpers.ts` if needed
- DRY up `tcpProbe` helper across transport-ator-real-binary.test.ts, transport-ator-hidden-service.test.ts, and transport-system-tor-fallback.test.ts

---

## Next Steps

1. **Share this checklist and failing tests** with the dev workflow (manual handoff)
2. **Run failing tests** to confirm RED phase: `npx jest transport-system-tor-fallback --ci --verbose`
3. **Begin implementation** of workflow YAML and docs using implementation checklist as guide
4. **When all tests pass**, refactor code for quality
5. **When refactoring complete**, update story status to 'done' in sprint-status.yaml

---

## Knowledge Base References Applied

This ATDD workflow consulted the following project-specific patterns:

- **transport-ator-real-binary.test.ts** -- Env-gate pattern (ATOR_NIGHTLY), trackProvider(), tcpProbe(), SocksTransportProvider construction, budget constants
- **transport-ator-hidden-service.test.ts** -- Env-gate pattern, managed client patterns, afterAll cleanup
- **socks-transport-provider.ts** -- Constructor options, start(), stop(), healthCheck() API surface
- **probe-tcp-port.ts** -- probeTcpPort() and waitForTcpPort() helpers (referenced but not imported to keep smoke test self-contained)
- **ci.yml** -- Existing CI patterns: nick-fields/retry, setup-node, build steps, Docker integration job structure
- **jest.config.js** -- Test runner configuration, testMatch patterns, timeout settings

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest packages/connector/test/integration/transport-system-tor-fallback.test.ts --ci --verbose`

**Results:**

```
PASS connector packages/connector/test/integration/transport-system-tor-fallback.test.ts
  AC 4: system-tor fallback test env-gate self-check
    ✓ the file-level gate uses process.env.SYSTEM_TOR_SMOKE === "1" + describe.skip when unset (1 ms)
    ✓ SMOKE gate value matches the env-var semantics exactly (1 ms)
    ✓ SYSTEM_TOR_PORT defaults to 9050 when unset
  System-tor fallback smoke (Story 36.5, ...)
    T-36.5-07a: SocksTransportProvider.start() succeeds with system tor
      ○ skipped start() resolves without error and healthCheck() returns true
    T-36.5-07b: TCP round-trip through system tor SOCKS proxy succeeds (smoke)
      ○ skipped data round-trips correctly through system tor SOCKS proxy to local echo server
    T-36.5-07c: SocksTransportProvider stops cleanly with system tor
      ○ skipped provider.stop() resolves without error

Test Suites: 1 passed, 1 total
Tests:       3 skipped, 3 passed, 6 total
```

**Summary:**

- Total tests: 6
- Passing: 3 (ungated self-checks)
- Skipped: 3 (gated smoke tests -- RED phase, require SYSTEM_TOR_SMOKE=1 + running tor)
- Status: RED phase verified (gated tests will fail without system tor infrastructure)

**Expected Failure Messages (when SYSTEM_TOR_SMOKE=1 but no tor running):**

- `System tor SOCKS proxy at 127.0.0.1:9050 not reachable -- install and start tor...`

---

## Notes

- The test deliberately uses a local echo server (`net.createServer` with `sock.pipe(sock)`) for the TCP round-trip, avoiding any external network access through the tor exit network. This keeps the test deterministic, fast, and safe for CI.
- The `SYSTEM_TOR_PORT` env var override (default 9050) enables platform portability -- if a CI runner has tor on a non-standard port, the test adapts.
- The `socks5h://` scheme is hardcoded (never `socks5://`) per the DNS leak prevention invariant enforced throughout Epic 35.
- The `trackProvider()` pattern from Story 36.3 ensures belt-and-suspenders cleanup in `afterAll` even if test assertions fail mid-suite.

---

## Contact

**Questions or Issues?**

- Refer to `_bmad-output/implementation-artifacts/36-5-nightly-ci-workflow-system-tor-fallback.md` for the full story spec
- Consult `docs/ator-transport.md` for the system tor fallback deployment guide
- See `_bmad-output/planning-artifacts/test-design-epic-36.md` for the T-ID authority

---

**Generated by BMad TEA Agent** - 2026-04-16
