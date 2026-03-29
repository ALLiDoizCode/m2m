---
stepsCompleted: ['step-01-preflight-and-context', 'step-02-generation-mode', 'step-03-test-strategy', 'step-04-generate-tests', 'step-04c-aggregate', 'step-05-validate-and-complete']
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-03-29'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/34-10-mina-local-development-infrastructure.md'
  - '_bmad/tea/testarch/knowledge/data-factories.md'
  - '_bmad/tea/testarch/knowledge/test-quality.md'
  - '_bmad/tea/testarch/knowledge/test-healing-patterns.md'
  - '_bmad/tea/testarch/knowledge/test-levels-framework.md'
  - 'packages/connector/jest.config.js'
  - 'packages/connector/test/integration/mina-lightnet.test.ts'
  - 'packages/connector/test/integration/multi-hop-helpers.ts'
  - 'packages/connector/test/integration/solana-subscription.test.ts'
  - 'packages/connector/test/acceptance/story-33-9-solana-local-dev-infra.test.ts'
  - 'docker-compose.yml'
  - 'Makefile'
  - '.github/workflows/ci.yml'
  - 'CLAUDE.md'
---

# ATDD Checklist - Epic 34, Story 10: Mina Local Development Infrastructure

**Date:** 2026-03-29
**Author:** Jonathan
**Primary Test Level:** Integration (infrastructure verification / static analysis)

---

## Story Summary

Story 34.10 closes the infrastructure gap identified in the Epic 34 retrospective: Docker infrastructure for local Mina development was designed in architecture but never assigned as a deliverable. This story adds a Docker Compose service for Mina lightnet with funded accounts and archive node, Makefile targets, a readiness helper, lightnet test un-skipping, and CI pipeline integration.

**As a** developer working on Mina settlement features
**I want** a one-command local Mina lightnet with funded accounts and archive node (matching the Anvil pattern)
**So that** I can run E2E integration tests against real Mina blockchain infrastructure without mocks

---

## Acceptance Criteria

1. **AC 1: Docker Compose Service -- Mina Lightnet** -- `o1labs/mina-local-network:o1js-main` image, ports 3085/8181/8282/5433, profile `mina`, 4-8 GB RAM, health check within 180s
2. **AC 2: Funded Account Acquisition** -- Accounts available via `http://localhost:8181/acquire-account` with B62/EKE keys and >= 1000 MINA balance
3. **AC 3: Makefile Targets** -- `mina-up`, `mina-down`, `mina-logs` using `--profile mina`
4. **AC 4: Lightnet Test Un-Skipped (T-34.8-18)** -- Environment-gated with `MINA_INTEGRATION=true`, uses `waitForMinaReady()`, `acquireFundedAccount()`, `releaseFundedAccount()`
5. **AC 5: Infra-Up Updated with Mina Profile** -- `infra-up` starts all three profiles (evm, solana, mina); `infra-down` stops all
6. **AC 6: EVM and Solana Regression** -- Existing EVM and Solana tests pass unchanged after docker-compose changes
7. **AC 7: CI Pipeline -- Mina Integration Job** -- Docker-based job on main pushes, 10-minute timeout, health check wait, teardown with `if: always()`
8. **AC 8: Readiness Helper** -- `waitForMinaReady()` polls accounts manager (non-mutating) and GraphQL, 180s timeout, 2s interval

---

## Failing Tests Created (RED Phase)

### Integration Tests (61 tests across 12 describe blocks)

**File:** `packages/connector/test/acceptance/story-34-10-mina-local-dev-infra.test.ts` (531 lines)

- **AC 1: Docker Compose Service -- Mina Lightnet** (14 tests)
  - **Status:** RED -- docker-compose.yml does not yet have a `mina-lightnet` service
  - **Verifies:** T-34.10-01, T-34.10-02 -- service definition, image, ports, profile, memory, health check timing, restart policy

- **AC 2: Funded Account Acquisition helpers** (5 tests)
  - **Status:** RED -- `mina-helpers.ts` does not exist yet
  - **Verifies:** T-34.10-03 -- helper file exists with `acquireFundedAccount`, `releaseFundedAccount`, correct endpoints

- **AC 3: Makefile Targets** (5 tests)
  - **Status:** RED -- `mina-up`, `mina-down`, `mina-logs` targets not yet added
  - **Verifies:** T-34.10-04, T-34.10-05 -- new targets, .PHONY, help output

- **AC 3 (isolation): Mina target isolation** (2 tests)
  - **Status:** RED -- targets do not exist yet
  - **Verifies:** Mina targets do not reference evm/solana profiles

- **AC 4: Lightnet Test Un-Skipped** (6 tests)
  - **Status:** RED -- mina-lightnet.test.ts still uses `describe.skip` and has no helper wiring
  - **Verifies:** T-34.10-10, T-34.10-11 -- MINA_INTEGRATION gate, helper usage, no placeholder assertions

- **AC 5: Infra-Up with Mina Profile** (2 tests)
  - **Status:** RED -- `infra-up`/`infra-down` only include evm and solana profiles
  - **Verifies:** T-34.10-06, T-34.10-07 -- all three profiles started/stopped together

- **AC 6: EVM and Solana Regression** (4 tests)
  - **Status:** 3 GREEN (regression gates), 1 RED (service count check expects >= 4)
  - **Verifies:** T-34.10-08, T-34.10-09, T-34.10-12, T-34.10-13 -- existing configs preserved

- **AC 7: CI Pipeline -- Mina Integration Job** (10 tests)
  - **Status:** RED -- CI does not yet have a `mina-integration` job
  - **Verifies:** T-34.10-14 -- job definition, gating, docker-compose usage, health check, env vars, teardown, timeout, ci-status integration

- **AC 8: Readiness Helper** (8 tests)
  - **Status:** RED -- `mina-helpers.ts` does not exist yet
  - **Verifies:** T-34.10-15 -- function export, non-mutating polling, GraphQL polling, timeout, interval, error handling

- **Documentation Updates** (5 tests)
  - **Status:** RED -- CLAUDE.md and docker-compose comments not yet updated
  - **Verifies:** mina-up/down/logs in CLAUDE.md, docker-compose comment updates, infra-up description includes Mina

---

## Data Factories Created

N/A -- This is an infrastructure-only story. Tests use file system reads and string matching to verify configuration files. No data factories are needed.

---

## Fixtures Created

N/A -- Tests use built-in `fs` and `path` modules to read project configuration files (docker-compose.yml, Makefile, ci.yml, mina-helpers.ts, mina-lightnet.test.ts). The `js-yaml` package (available as transitive dependency) is used for structured YAML parsing of docker-compose.yml.

---

## Mock Requirements

N/A -- No external services are mocked. Tests read and parse real project configuration files.

---

## Required data-testid Attributes

N/A -- This is a backend infrastructure story with no UI components.

---

## Implementation Checklist

### Test Group: AC 1 -- Docker Compose Mina Lightnet Service (14 tests)

**File:** `packages/connector/test/acceptance/story-34-10-mina-local-dev-infra.test.ts`

**Tasks to make these tests pass:**

- [ ] Add `mina-lightnet` service to `docker-compose.yml` with `o1labs/mina-local-network:o1js-main` image
- [ ] Configure ports: `3085:3085` (GraphQL), `8181:8181` (accounts manager), `8282:8282` (explorer), `5433:5432` (archive PostgreSQL)
- [ ] Add `profiles: [mina]` to mina-lightnet service
- [ ] Add `deploy.resources.limits.memory: 8g`
- [ ] Add health check against accounts manager on port 8181 with `start_period: 120s`, `interval: 15s`, `timeout: 10s`, `retries: 10`
- [ ] Add `restart: unless-stopped` matching Anvil/Solana pattern
- [ ] Update docker-compose.yml usage comment to include `mina-up`, `mina-down`, `mina-logs`
- [ ] Run test: `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-34-10-mina-local-dev-infra.test.ts -t "AC 1: Docker Compose"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 1.5 hours

---

### Test Group: AC 2 -- Funded Account Acquisition Helpers (5 tests)

**Tasks to make these tests pass:**

- [ ] Create `packages/connector/test/integration/mina-helpers.ts`
- [ ] Implement `acquireFundedAccount()` calling `http://localhost:8181/acquire-account`
- [ ] Implement `releaseFundedAccount(publicKey)` calling `http://localhost:8181/release-account`
- [ ] Ensure both helpers reference correct port 8181
- [ ] Run test: `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-34-10-mina-local-dev-infra.test.ts -t "AC 2"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 1 hour

---

### Test Group: AC 3 -- Makefile Targets (7 tests including isolation)

**Tasks to make these tests pass:**

- [ ] Add `mina-up` target: `docker compose --profile mina up -d`
- [ ] Add `mina-down` target: `docker compose --profile mina down`
- [ ] Add `mina-logs` target: `docker compose --profile mina logs -f`
- [ ] Update `.PHONY` to include `mina-up mina-down mina-logs`
- [ ] Update `make help` with new Mina targets
- [ ] Run test: `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-34-10-mina-local-dev-infra.test.ts -t "AC 3"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

### Test Group: AC 4 -- Lightnet Test Un-Skipped (6 tests)

**Tasks to make these tests pass:**

- [ ] Replace `describe.skip` with `MINA_INTEGRATION` environment variable gating in `mina-lightnet.test.ts`
- [ ] Import and call `waitForMinaReady()` in `beforeAll`
- [ ] Import and use `acquireFundedAccount()` for test account setup
- [ ] Import and use `releaseFundedAccount()` for `afterAll` cleanup
- [ ] Replace `expect.assertions(0)` with real test assertions for T-34.8-18
- [ ] Run test: `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-34-10-mina-local-dev-infra.test.ts -t "AC 4"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 2 hours

---

### Test Group: AC 5 -- Infra-Up with Mina Profile (2 tests)

**Tasks to make these tests pass:**

- [ ] Update `infra-up` target: `docker compose --profile evm --profile solana --profile mina up -d`
- [ ] Update `infra-down` target: `docker compose --profile evm --profile solana --profile mina down`
- [ ] Run test: `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-34-10-mina-local-dev-infra.test.ts -t "AC 5"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

### Test Group: AC 6 -- EVM and Solana Regression (4 tests, 3 GREEN)

**Tasks to make these tests pass:**

- [ ] After adding mina-lightnet service, verify service count >= 4
- [ ] Verify anvil, faucet, solana-validator configs unchanged
- [ ] Run test: `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-34-10-mina-local-dev-infra.test.ts -t "AC 6"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.5 hours (verification only)

---

### Test Group: AC 7 -- CI Pipeline Mina Integration Job (10 tests)

**Tasks to make these tests pass:**

- [ ] Add `mina-integration` job to `.github/workflows/ci.yml`
- [ ] Gate on `github.event_name == 'push' && github.ref == 'refs/heads/main'` (matching Solana pattern)
- [ ] Set `timeout-minutes: 10`
- [ ] Use `docker compose --profile mina up -d` to start lightnet
- [ ] Add health check wait loop polling `localhost:8181`
- [ ] Set `MINA_INTEGRATION: 'true'` environment variable
- [ ] Run `npx jest test/integration/mina-lightnet.test.ts --ci --verbose`
- [ ] Add teardown step with `if: always()` running `docker compose --profile mina down`
- [ ] Add `mina-integration` to `ci-status` job's `needs:` array
- [ ] Add log line for `needs.mina-integration.result` in ci-status summary
- [ ] Run test: `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-34-10-mina-local-dev-infra.test.ts -t "AC 7"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 2 hours

---

### Test Group: AC 8 -- Readiness Helper (8 tests)

**Tasks to make these tests pass:**

- [ ] Create `waitForMinaReady()` function in `packages/connector/test/integration/mina-helpers.ts`
- [ ] Poll accounts manager using `http://localhost:8181/list-acquired-accounts` (non-mutating)
- [ ] Poll GraphQL endpoint: `http://localhost:3085/graphql` with introspection query
- [ ] Set 180-second timeout with 2-second polling interval
- [ ] Throw descriptive error on timeout
- [ ] Run test: `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-34-10-mina-local-dev-infra.test.ts -t "AC 8"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 1 hour

---

### Test Group: Documentation Updates (5 tests)

**Tasks to make these tests pass:**

- [ ] Add `mina-up`, `mina-down`, `mina-logs` to CLAUDE.md (Local Mina Development section)
- [ ] Update "All-Chain Infrastructure" section to reference all three chains (EVM + Solana + Mina)
- [ ] Update docker-compose.yml usage comment to include Mina targets
- [ ] Run test: `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-34-10-mina-local-dev-infra.test.ts -t "Documentation"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

## Running Tests

```bash
# Run all acceptance tests for this story
npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-34-10-mina-local-dev-infra.test.ts --verbose

# Run specific test group
npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-34-10-mina-local-dev-infra.test.ts -t "AC 1: Docker Compose"

# Run lightnet integration tests after infra is up
MINA_INTEGRATION=true npx jest test/integration/mina-lightnet.test.ts --verbose

# Run EVM regression tests after docker-compose changes
make anvil-up && npx jest test/integration/multi-hop-e2e.test.ts --verbose

# Run Solana regression tests after docker-compose changes
SOLANA_INTEGRATION=true npx jest test/integration/solana-subscription.test.ts --verbose
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 61 tests written and running (57 failing, 4 passing regression gates)
- Tests verify configuration files (docker-compose.yml, Makefile, ci.yml, mina-helpers.ts, mina-lightnet.test.ts, CLAUDE.md)
- Tests use YAML parsing for structured docker-compose validation
- Tests use regex matching for Makefile, CI workflow, and source code validation
- Implementation checklist created mapping tests to infrastructure tasks

**Verification:**

- 57 tests fail as expected (RED phase confirmed)
- 4 tests pass (regression gates for existing EVM/Solana infrastructure)
- Test file compiles without type errors
- Tests are designed to pass once infrastructure is implemented

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. **Start with AC 1** -- Add mina-lightnet service to docker-compose.yml
2. **Create helpers** -- Implement `mina-helpers.ts` with `waitForMinaReady()`, `acquireFundedAccount()`, `releaseFundedAccount()`
3. **Add Makefile targets** -- mina-up/down/logs, update infra-up/infra-down
4. **Un-skip lightnet test** -- Replace `describe.skip` with MINA_INTEGRATION gating, wire helpers, implement T-34.8-18
5. **Add CI job** -- `mina-integration` job matching Solana pattern
6. **Update documentation** -- CLAUDE.md, docker-compose comments
7. **Verify EVM/Solana regression** -- Run existing tests unchanged

**Key Principles:**

- One acceptance criterion at a time
- Run tests frequently for immediate feedback
- Use implementation checklist as roadmap

---

### REFACTOR Phase (DEV Team - After All Tests Pass)

**DEV Agent Responsibilities:**

1. Verify all 61 tests pass (green phase complete)
2. Smoke test: `make mina-up` / `make mina-down` manually
3. Smoke test: `make infra-up` / `make infra-down` manually
4. Verify `make anvil-up` still works after docker-compose changes
5. Verify `make solana-up` still works after docker-compose changes
6. Run full test suite: `npm test` to confirm no regressions
7. Push to test branch and verify CI mina-integration job passes

---

## Next Steps

1. **Share this checklist and failing tests** with the dev workflow (manual handoff)
2. **Run failing tests** to confirm RED phase: 57 tests failing, 4 passing
3. **Begin implementation** using implementation checklist as guide
4. **Work one AC at a time** (red -> green for each)
5. **When all tests pass**, refactor and verify CI pipeline
6. **When refactoring complete**, manually update story status to 'done' in sprint-status.yaml

---

## Knowledge Base References Applied

This ATDD workflow consulted the following knowledge fragments:

- **data-factories.md** -- Confirmed N/A for infrastructure story (no test data factories needed)
- **test-quality.md** -- Applied Given-When-Then structure, deterministic assertions, isolation principles
- **test-healing-patterns.md** -- Noted infrastructure tests are inherently deterministic (file reads, no timing issues)
- **test-levels-framework.md** -- Selected integration level for infrastructure verification (static analysis of config files)

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-34-10-mina-local-dev-infra.test.ts --verbose`

**Results:**

```
Test Suites: 1 failed, 1 total
Tests:       57 failed, 4 passed, 61 total
Snapshots:   0 total
Time:        3.233 s
```

**Summary:**

- Total tests: 61
- Passing: 4 (regression gates for existing EVM/Solana infrastructure)
- Failing: 57 (expected -- tests verify not-yet-implemented infrastructure)
- Status: RED phase verified

**Expected Failure Reasons:**

- AC 1 tests: `mina-lightnet` service does not exist in docker-compose.yml
- AC 2 tests: `mina-helpers.ts` file does not exist
- AC 3 tests: `mina-up`/`mina-down`/`mina-logs` Makefile targets do not exist
- AC 4 tests: `mina-lightnet.test.ts` still uses `describe.skip`, no helper wiring
- AC 5 tests: `infra-up`/`infra-down` only include evm and solana profiles
- AC 6 tests: Service count < 4 (missing mina-lightnet)
- AC 7 tests: No `mina-integration` CI job exists
- AC 8 tests: `mina-helpers.ts` file does not exist
- Documentation tests: CLAUDE.md missing mina targets, docker-compose comment not updated

---

## Notes

- **Infrastructure-only story** -- No new business logic tests needed; tests verify configuration files
- **js-yaml dependency** -- Used for structured docker-compose.yml parsing; available as transitive dependency
- **Acceptance tests run separately** -- `jest.config.js` excludes `test/acceptance/` by design; use explicit path or custom config
- **Mina startup time** -- Mina lightnet takes 1-3 minutes to reach SYNCED status, hence 120s start_period and 180s readiness timeout
- **Memory requirements** -- The Mina lightnet image requires 4-8 GB RAM; Docker Desktop users must allocate sufficient memory
- **PostgreSQL port conflict** -- Archive PostgreSQL remapped to 5433 to avoid conflicts with local Postgres on 5432
- **Accounts manager side effects** -- `/acquire-account` locks accounts; readiness polling must use `/list-acquired-accounts` instead
- **Pattern consistency** -- Follows the exact pattern established by Story 33.9 (Solana local dev infrastructure)

---

## Contact

**Questions or Issues?**

- Ask in team standup
- Refer to `docs/mina-deployment.md` for Mina deployment documentation
- Consult `_bmad/tea/testarch/knowledge` for testing best practices

---

**Generated by BMad TEA Agent** - 2026-03-29
