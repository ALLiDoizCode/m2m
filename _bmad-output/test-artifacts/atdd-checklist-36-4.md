---
stepsCompleted:
  - 'step-01-preflight-and-context'
  - 'step-02-generation-mode'
  - 'step-03-test-strategy'
  - 'step-04c-aggregate'
  - 'step-05-validate-and-complete'
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-04-16'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/36-4-hidden-service-managed-client-real-binary-test.md'
  - 'packages/connector/test/integration/transport-ator-real-binary.test.ts'
  - 'packages/connector/src/transport/managed-anon-client.ts'
  - 'packages/connector/src/transport/socks-transport-provider.ts'
  - 'packages/connector/jest.config.js'
  - 'docker-compose.yml'
  - 'Makefile'
---

# ATDD Checklist - Epic 36, Story 36.4: Hidden-Service + Managed-Client Real-Binary Test

**Date:** 2026-04-16
**Author:** Jonathan
**Primary Test Level:** Integration (real-binary, env-gated)

---

## Story Summary

Story 36.4 exercises the managed `anon` lifecycle (ManagedAnonClient) and `.anon` hidden-service rendezvous end-to-end against the real `anon v0.4.10.0-beta` binary in the `make ator-up` stack. This closes the last two Epic 35 retro production-fidelity gaps: "managed-client lifecycle untested end-to-end" and ".anon hidden-service rendezvous untested".

**As a** connector developer and nightly-CI maintainer
**I want** an env-gated jest integration suite that exercises the managed-`anon` lifecycle and `.anon` hidden-service path against the real binary
**So that** the managed lifecycle and hidden-service rendezvous are proven against real infrastructure

---

## Acceptance Criteria

1. **AC 1**: New HS + managed-client suite lives at canonical path and is env-gated
2. **AC 2**: `make ator-test` runs the HS suite green end-to-end
3. **AC 3**: `make test` remains fast and the suite is silently skipped
4. **AC 4 (T-36.4-01)**: ManagedAnonClient starts real `anon` binary; SOCKS port opens within startupTimeoutMs
5. **AC 5 (T-36.4-02)**: `externalUrl: "auto"` resolves by reading `hs/hostname` file after HS publishes
6. **AC 6 (T-36.4-03)**: Second connector connects inbound via the resolved `.anon:port` URL
7. **AC 7 (T-36.4-04)**: No `.anon` hostname appears in any log line at INFO+ during the full run
8. **AC 8 (T-36.4-05)**: Killing the real `anon` process triggers `managed_anon_crash_detected` within one health-cache interval
9. **AC 9 (T-36.4-06)**: ManagedAnonClient.stop() completes within stopTimeoutMs under normal shutdown
10. **AC 10 (T-36.4-07)**: Hung SDK stop (simulated by SIGSTOP) logs timeout and connector shutdown proceeds
11. **AC 11 (T-36.4-08)**: BTP round-trip through `.anon` rendezvous completes successfully
12. **AC 12**: Managed config fixture exists
13. **AC 13**: Bright line preserved -- zero changes to transport source code
14. **AC 14**: CHANGELOG + sprint-status updates at story-done time

---

## Failing Tests Created (RED Phase)

### Integration Tests (10 tests)

**File:** `packages/connector/test/integration/transport-ator-hidden-service.test.ts` (~480 lines)

- **Test:** AC 3: env-gate self-check (file-level gate assertion)
  - **Status:** RED - Passes structurally (ungated); validates env-gate mechanism
  - **Verifies:** AC 3 -- file-level ATOR_NIGHTLY gate uses describe.skip pattern

- **Test:** AC 3: REAL_BINARY gate value matches env-var semantics
  - **Status:** RED - Passes structurally (ungated)
  - **Verifies:** AC 3 -- gate value consistency

- **Test:** AC 12: ator-managed-config.yaml exists
  - **Status:** RED - Will fail until fixture file created (now created)
  - **Verifies:** AC 12 -- managed config fixture existence

- **Test:** AC 12: fixture contains required transport block fields
  - **Status:** RED - Will fail until fixture content correct (now created)
  - **Verifies:** AC 12 -- fixture content validation

- **Test:** T-36.4-01: ManagedAnonClient starts real anon binary
  - **Status:** RED - Requires real `anon` binary + `ATOR_NIGHTLY=1`
  - **Verifies:** AC 4 -- managed client start, SOCKS port probe

- **Test:** T-36.4-02: externalUrl "auto" resolves via hs/hostname file
  - **Status:** RED - Requires real HS descriptor publication
  - **Verifies:** AC 5 -- hostname file poll, wss:// URL resolution

- **Test:** T-36.4-03: inbound .anon connection via HS rendezvous
  - **Status:** RED - Requires live .anon hidden service
  - **Verifies:** AC 6 -- Alice-to-Bob connection through .anon address

- **Test:** T-36.4-04: log hygiene -- no .anon hostnames at INFO+
  - **Status:** RED - Requires full suite run to populate log buffer
  - **Verifies:** AC 7 -- SEC-05 invariant at real-binary layer

- **Test:** T-36.4-05: crash detection after SIGKILL
  - **Status:** RED - Requires real anon process to kill
  - **Verifies:** AC 8 -- managed_anon_crash_detected event within CRASH_DETECT_BUDGET_MS

- **Test:** T-36.4-06: clean stop within stopTimeoutMs
  - **Status:** RED - Requires real managed client lifecycle
  - **Verifies:** AC 9 -- stop() budget, isRunning() false, no orphan process

- **Test:** T-36.4-07: hung stop (SIGSTOP) logs timeout; shutdown proceeds
  - **Status:** RED - Requires real process + SIGSTOP simulation
  - **Verifies:** AC 10 -- managed_anon_stop_timeout event, graceful degradation

- **Test:** T-36.4-08: BTP round-trip through .anon rendezvous
  - **Status:** RED - Requires live HS rendezvous path
  - **Verifies:** AC 11 -- byte-identical payload echo through .anon circuit

---

## Data Factories Created

N/A -- this story uses real infrastructure (docker compose stack, real `anon` binary) rather than generated test data. Test payloads are constructed inline with deterministic content.

---

## Fixtures Created

### Managed Config Fixture

**File:** `packages/connector/test/fixtures/ator-managed-config.yaml`

**Purpose:** Reference configuration for the managed-lifecycle test path. Documents the expected shape of a `managed: true` transport block with `externalUrl: "auto"` and `managedOptions`.

**Fields:** `type: socks5`, `managed: true`, `externalUrl: "auto"`, `socksProxy`, `managedOptions.hiddenServiceDir`, `managedOptions.hiddenServicePort`, `managedOptions.startupTimeoutMs`, `managedOptions.stopTimeoutMs`

---

## Mock Requirements

**None.** This is the real-binary integration layer -- the entire point is using the real `@anyone-protocol/anyone-client` SDK and real `anon` binary. Mocking is explicitly prohibited by the story (see Dev Notes: "DO NOT mock the anonFactory").

---

## Required data-testid Attributes

N/A -- backend integration test suite; no UI components.

---

## Implementation Checklist

### Test: T-36.4-01 -- ManagedAnonClient starts real anon binary

**File:** `packages/connector/test/integration/transport-ator-hidden-service.test.ts`

**Tasks to make this test pass:**

- [x] Create test file with env-gate skeleton (AC 1)
- [x] Implement realAnonFactory using `require('@anyone-protocol/anyone-client')`
- [x] Construct ManagedAnonClient with real factory, tempHsDir, budget constants
- [x] Assert start() resolves within MANAGED_STARTUP_BUDGET_MS
- [x] Assert isRunning() === true and TCP probe succeeds
- [ ] Verify with `ATOR_NIGHTLY=1 make ator-test`
- [ ] Test passes (green phase)

---

### Test: T-36.4-02 -- externalUrl auto-resolution

**File:** `packages/connector/test/integration/transport-ator-hidden-service.test.ts`

**Tasks to make this test pass:**

- [x] Configure ManagedAnonClient with hiddenServiceDir + hiddenServicePort
- [x] Implement waitForFile() with exponential backoff (NOT fixed sleep)
- [x] Assert hostname matches /^[a-z2-7]{56}\.anon$/
- [x] Construct SocksTransportProvider with resolveExternalUrlOnStart callback
- [x] Assert getExternalUrl() matches wss://<base32>.anon:<port>/btp
- [ ] Verify with `ATOR_NIGHTLY=1 make ator-test`
- [ ] Test passes (green phase)

---

### Test: T-36.4-03 -- Inbound .anon connection

**File:** `packages/connector/test/integration/transport-ator-hidden-service.test.ts`

**Tasks to make this test pass:**

- [x] Read Bob's .anon hostname from hs1 container
- [x] Alice connects via SocksProxyAgent through PROXY_URL to Bob's .anon address
- [x] Assert WebSocket connection succeeds through HS rendezvous
- [ ] Verify with `ATOR_NIGHTLY=1 make ator-test`
- [ ] Test passes (green phase)

---

### Test: T-36.4-04 -- Log hygiene (SEC-05)

**File:** `packages/connector/test/integration/transport-ator-hidden-service.test.ts`

**Tasks to make this test pass:**

- [x] Create Pino destination that buffers all log entries
- [x] Pass buffered logger to all managed clients and providers
- [x] Scan buffer for .anon substrings in entries at level >= 30 (INFO)
- [x] Assert zero matches with explicit SEC-05 violation message
- [ ] Verify with `ATOR_NIGHTLY=1 make ator-test`
- [ ] Test passes (green phase)

---

### Test: T-36.4-05 -- Crash detection

**File:** `packages/connector/test/integration/transport-ator-hidden-service.test.ts`

**Tasks to make this test pass:**

- [x] Start managed client with real factory
- [x] Find anon PID via pgrep -f filtered by hiddenServiceDir
- [x] SIGKILL the process
- [x] Poll healthCheck() within CRASH_DETECT_BUDGET_MS
- [x] Assert managed_anon_crash_detected in log buffer at WARN level
- [x] Assert healthCheck() returns false post-crash
- [ ] Verify with `ATOR_NIGHTLY=1 make ator-test`
- [ ] Test passes (green phase)

---

### Test: T-36.4-06 -- Clean stop

**File:** `packages/connector/test/integration/transport-ator-hidden-service.test.ts`

**Tasks to make this test pass:**

- [x] Start managed client, assert isRunning()
- [x] Call stop(), assert resolves within MANAGED_STOP_BUDGET_MS
- [x] Assert isRunning() === false
- [x] Assert no orphan anon process via pgrep
- [ ] Verify with `ATOR_NIGHTLY=1 make ator-test`
- [ ] Test passes (green phase)

---

### Test: T-36.4-07 -- Hung stop (SIGSTOP)

**File:** `packages/connector/test/integration/transport-ator-hidden-service.test.ts`

**Tasks to make this test pass:**

- [x] Start managed client, find PID
- [x] SIGSTOP the process to freeze it
- [x] Call stop(), assert resolves within MANAGED_STOP_BUDGET_MS + 2s grace
- [x] Assert managed_anon_stop_timeout in log buffer at WARN
- [x] Assert isRunning() === false
- [x] afterEach: SIGCONT + SIGKILL cleanup (CRITICAL -- frozen processes persist)
- [ ] Verify with `ATOR_NIGHTLY=1 make ator-test`
- [ ] Test passes (green phase)

---

### Test: T-36.4-08 -- BTP round-trip through .anon rendezvous

**File:** `packages/connector/test/integration/transport-ator-hidden-service.test.ts`

**Tasks to make this test pass:**

- [x] Read Bob's .anon hostname from hs1 container
- [x] Alice connects via SOCKS proxy to Bob's .anon address
- [x] Send ILP PREPARE-shaped payload
- [x] Assert byte-identical echo within RENDEZVOUS_ROUNDTRIP_BUDGET_MS
- [ ] Verify with `ATOR_NIGHTLY=1 make ator-test`
- [ ] Test passes (green phase)

---

## Running Tests

```bash
# Run all failing tests for this story (requires live ator stack)
ATOR_NIGHTLY=1 ATOR_SOCKS_PORT=$(docker compose port hs1 9050 | awk -F: '{print $2}') \
  npx jest --testPathPattern transport-ator-hidden-service

# Run via Makefile (recommended -- handles port resolution)
make ator-test

# Run only the ungated tests (no ator stack required)
npx jest --testPathPattern transport-ator-hidden-service

# Run with verbose output for debugging
ATOR_NIGHTLY=1 ATOR_SOCKS_PORT=... npx jest --verbose --testPathPattern transport-ator-hidden-service

# Verify fast-feedback is not regressed
make test
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All tests written and failing (env-gated tests skip without ator stack; real-binary tests require live infrastructure)
- Managed config fixture created with auto-cleanup
- Log hygiene assertion infrastructure built (buffered Pino destination)
- Process management helpers created (findAnonPid, SIGSTOP/SIGCONT/SIGKILL patterns)
- Implementation checklist created

**Verification:**

- Ungated tests (AC 3, AC 12) pass immediately (structural checks)
- Gated tests (T-36.4-01 through T-36.4-08) skip when ATOR_NIGHTLY is unset
- When ATOR_NIGHTLY=1 with live stack, tests exercise real binary (RED until stack + SDK available)

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. Ensure `@anyone-protocol/anyone-client` SDK is installed
2. Run `make ator-up` to bring up the test network
3. Run `make ator-test` and verify all 8 gated tests pass
4. Address any failures (likely: HS descriptor publish timing, process management edge cases)
5. Run `make test` and verify zero regression (all gated tests skip cleanly)

**Key Principles:**

- One test at a time (start with T-36.4-01 which is foundational)
- If T-36.4-01 fails, all downstream tests will also fail (managed client is prerequisite)
- HS descriptor publication (T-36.4-02) is the longest single wait -- be patient

---

### REFACTOR Phase (DEV Team - After All Tests Pass)

**DEV Agent Responsibilities:**

1. Consider extracting shared helpers to `packages/connector/test/helpers/ator-compose-helpers.ts` (DRY with transport-ator-real-binary.test.ts)
2. Review process management helpers for robustness
3. Ensure afterAll cleanup is bulletproof (no orphan processes)
4. Update CHANGELOG.md and sprint-status.yaml (AC 14)

---

## Next Steps

1. **Run ungated tests** to confirm structural assertions pass: `npx jest --testPathPattern transport-ator-hidden-service`
2. **Start ator stack**: `make ator-up`
3. **Run full suite**: `make ator-test`
4. **Verify fast-feedback**: `make test` (should show 8 skipped tests from this suite)
5. **When all tests pass**, update CHANGELOG.md and sprint-status.yaml
6. **Consider helper extraction** for DRY-up before Story 36.5

---

## Knowledge Base References Applied

This ATDD workflow consulted the following knowledge and context:

- **Story 36.4 spec** -- acceptance criteria, task breakdown, dev notes, anti-patterns
- **Story 36.3 test file** (`transport-ator-real-binary.test.ts`) -- env-gate pattern, REPO_ROOT, execCompose, waitForHealthy, socksConnect, trackProvider, settled-flag patterns
- **ManagedAnonClient source** (`managed-anon-client.ts`) -- AnonSdkHandle interface, AnonFactoryOptions, factory pattern, start/stop lifecycle, healthCheck, crash detection events
- **SocksTransportProvider source** (`socks-transport-provider.ts`) -- constructor validation, resolveExternalUrlOnStart callback, managed client integration, healthCheck chain
- **docker-compose.yml** -- hs1 container config, SOCKS port mapping, HS directory paths
- **Makefile** -- ator-test target, ATOR_NIGHTLY/ATOR_SOCKS_PORT contract
- **jest.config.js** -- test roots, timeout, path patterns

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest --testPathPattern transport-ator-hidden-service`

**Expected Results (without ATOR_NIGHTLY):**

```
 PASS  packages/connector/test/integration/transport-ator-hidden-service.test.ts
  AC 3: HS suite is silently skipped when ATOR_NIGHTLY is unset
    ✓ the file-level gate uses process.env.ATOR_NIGHTLY === "1" + describe.skip
    ✓ REAL_BINARY gate value matches the env-var semantics exactly
  AC 12: managed config fixture exists
    ✓ ator-managed-config.yaml exists at the expected path
    ✓ fixture contains required transport block fields
  Hidden-service + managed-client real-binary ATOR integration (Story 36.4, ...)
    ○ skipped T-36.4-01 through T-36.4-08 (8 tests)

Tests: 8 skipped, 4 passed, 12 total
```

**Summary:**

- Ungated tests: 4 passing (structural assertions)
- Gated tests: 8 skipped (env-gate working correctly)
- Status: RED phase verified (gated tests cannot pass without live infrastructure)

---

## Notes

- The test uses the hs1 container from the docker-compose ator profile for the .anon rendezvous path (fallback approach from Dev Notes) rather than spawning a managed `anon` binary on the host. This is simpler and avoids the complexity of configuring a host-side binary to join the test network's DirAuth quorum.
- Process management (findAnonPid) uses pgrep filtered by the unique temp directory path to avoid matching unrelated anon instances.
- The SIGSTOP test (T-36.4-07) has critical cleanup requirements -- afterEach ALWAYS runs SIGCONT + SIGKILL. A frozen process persists until machine reboot if not cleaned up.
- Log hygiene (T-36.4-04) uses a buffered Pino destination that captures all structured log entries for post-hoc scanning. The regex anchors on the `.anon` TLD pattern to avoid false positives from the word "anon" in other contexts.

---

**Generated by BMad TEA Agent** - 2026-04-16
