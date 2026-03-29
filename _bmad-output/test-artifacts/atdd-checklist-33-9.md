---
stepsCompleted: ['step-01-preflight-and-context', 'step-02-generation-mode', 'step-03-test-strategy', 'step-04-generate-tests', 'step-04c-aggregate', 'step-05-validate-and-complete']
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-03-29'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/33-9-solana-local-development-infrastructure.md'
  - '_bmad/tea/testarch/knowledge/data-factories.md'
  - '_bmad/tea/testarch/knowledge/test-quality.md'
  - '_bmad/tea/testarch/knowledge/test-healing-patterns.md'
  - '_bmad/tea/testarch/knowledge/test-levels-framework.md'
  - 'packages/connector/jest.config.js'
  - 'packages/connector/test/integration/solana-subscription.test.ts'
  - 'packages/connector/test/integration/multi-hop-helpers.ts'
  - 'docker-compose.yml'
  - 'Makefile'
  - '.github/workflows/ci.yml'
---

# ATDD Checklist - Epic 33, Story 9: Solana Local Development Infrastructure

**Date:** 2026-03-29
**Author:** Jonathan
**Primary Test Level:** Integration (infrastructure verification / static analysis)

---

## Story Summary

Story 33.9 closes the infrastructure gap identified in the Epic 33 retrospective: Docker infrastructure for local Solana development was designed in architecture but never assigned as a deliverable. This story adds a Docker Compose service for Solana test validator with auto-deployed programs, Makefile targets, and CI pipeline migration.

**As a** developer working on Solana settlement features
**I want** a one-command local Solana validator with auto-deployed programs (matching the Anvil pattern)
**So that** I can run E2E integration tests against real blockchain infrastructure without mocks

---

## Acceptance Criteria

1. **AC 1: Docker Compose Service** -- Solana test validator runs as a Docker Compose service with `ghcr.io/beeman/solana-test-validator:latest`, ports 8899/8900, profile `solana`, `seccomp=unconfined`, health check within 30s
2. **AC 2: Program Auto-Deployment** -- Init script waits for validator, airdrops SOL, deploys `.so` files from mounted directory, logs program ID
3. **AC 3: Makefile Targets** -- `solana-up`, `solana-down`, `solana-logs` using `--profile solana`; existing `anvil-*` retrofitted to `--profile evm`
4. **AC 4: Subscription Tests Pass** -- T-33.7-05 and T-33.7-10 pass with `SOLANA_INTEGRATION=true` against local validator
5. **AC 5: Infra-Up/Infra-Down** -- `infra-up` starts both evm and solana profiles; `infra-down` stops all
6. **AC 6: EVM Regression** -- Existing Anvil-based EVM tests pass unchanged after profile migration
7. **AC 7: CI Pipeline** -- Solana integration job uses docker-compose instead of inline `services:` block; `solanalabs/solana` removed

---

## Failing Tests Created (RED Phase)

### Integration Tests (37 tests across 8 describe blocks)

**File:** `packages/connector/test/acceptance/story-33-9-solana-local-dev-infra.test.ts` (562 lines)

- **AC 1: Docker Compose Service -- Solana Test Validator** (9 tests)
  - **Status:** RED -- docker-compose.yml does not yet have a `solana-validator` service or profiles
  - **Verifies:** T-33.9-01, T-33.9-02 -- service definition, image, ports, profile, seccomp, health check, tmpfs, volume mount

- **AC 1 (profiles): Existing EVM services use "evm" profile** (2 tests)
  - **Status:** RED -- `profiles: [evm]` not yet added to anvil/faucet services
  - **Verifies:** profile migration for backward compatibility

- **AC 2: Program Auto-Deployment on Startup** (4 tests)
  - **Status:** RED -- init entrypoint script does not exist yet
  - **Verifies:** T-33.9-03 -- validator readiness wait, SOL airdrop, .so deployment, validator flags

- **AC 3: Makefile Targets** (9 tests)
  - **Status:** RED -- `solana-up`, `solana-down`, `solana-logs` targets not yet added; `anvil-*` not yet retrofitted with `--profile evm`
  - **Verifies:** T-33.9-04, T-33.9-05 -- new targets, retrofitted targets, .PHONY, help output

- **AC 5: Infra-Up / Infra-Down** (2 tests)
  - **Status:** RED -- `infra-up` and `infra-down` targets do not exist
  - **Verifies:** T-33.9-06, T-33.9-07 -- both profiles started/stopped together

- **AC 6: EVM Regression** (3 tests)
  - **Status:** RED -- will fail until profiles are added (service count check expects >= 3)
  - **Verifies:** T-33.9-08, T-33.9-11 -- anvil config preserved, faucet config preserved, structure valid

- **AC 7: CI Pipeline** (6 tests)
  - **Status:** RED -- CI still uses inline `services:` block with `solanalabs/solana:v2.1.0`
  - **Verifies:** T-33.9-12 -- inline service removed, docker-compose used, health check, teardown, no manual deploy

- **AC 4: Subscription Tests Compatible** (2 tests)
  - **Status:** GREEN (regression gate) -- existing test file already has correct structure
  - **Verifies:** T-33.9-09, T-33.9-10 -- SOLANA_INTEGRATION gate exists, T-33.7-05 and T-33.7-10 references present

---

## Data Factories Created

N/A -- This is an infrastructure-only story. Tests use file system reads and string matching to verify configuration files. No data factories are needed.

---

## Fixtures Created

N/A -- Tests use built-in `fs` and `path` modules to read project configuration files (docker-compose.yml, Makefile, ci.yml). The `js-yaml` package (available as transitive dependency) is used for structured YAML parsing of docker-compose.yml.

---

## Mock Requirements

N/A -- No external services are mocked. Tests read and parse real project configuration files.

---

## Required data-testid Attributes

N/A -- This is a backend infrastructure story with no UI components.

---

## Implementation Checklist

### Test Group: AC 1 -- Docker Compose Solana Service (9 tests)

**File:** `packages/connector/test/acceptance/story-33-9-solana-local-dev-infra.test.ts`

**Tasks to make these tests pass:**

- [ ] Add `solana-validator` service to `docker-compose.yml` with `ghcr.io/beeman/solana-test-validator:latest` image
- [ ] Configure ports: `8899:8899` (RPC), `8900:8900` (WebSocket)
- [ ] Add `profiles: [solana]` to solana-validator service
- [ ] Add `security_opt: [seccomp=unconfined]` for Agave v2+ io_uring
- [ ] Add health check: `curl -s http://localhost:8899/health` with 30s start_period
- [ ] Add `tmpfs: [/tmp/test-ledger]` for ledger performance
- [ ] Mount volume `./packages/solana-program/target/deploy:/programs`
- [ ] Run test: `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-33-9-solana-local-dev-infra.test.ts -t "AC 1: Docker Compose"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 2 hours

---

### Test Group: AC 1 (profiles) -- EVM Profile Migration (2 tests)

**Tasks to make these tests pass:**

- [ ] Add `profiles: [evm]` to `anvil` service in docker-compose.yml
- [ ] Add `profiles: [evm]` to `faucet` service in docker-compose.yml
- [ ] Run test: `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-33-9-solana-local-dev-infra.test.ts -t "AC 1 (profiles)"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

### Test Group: AC 2 -- Program Auto-Deployment (4 tests)

**Tasks to make these tests pass:**

- [ ] Write init entrypoint inline command or script that starts `solana-test-validator --reset --limit-ledger-size 50000000`
- [ ] Add readiness wait loop using `solana cluster-version` or health check
- [ ] Add `solana-keygen new --no-bip39-passphrase --force` and `solana airdrop 1000`
- [ ] Add loop to deploy all `.so` files from `/programs/` with non-fatal error handling
- [ ] Run test: `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-33-9-solana-local-dev-infra.test.ts -t "AC 2"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 2 hours

---

### Test Group: AC 3 -- Makefile Targets (9 tests)

**Tasks to make these tests pass:**

- [ ] Add `solana-up` target: `docker compose --profile solana up -d`
- [ ] Add `solana-down` target: `docker compose --profile solana down`
- [ ] Add `solana-logs` target: `docker compose --profile solana logs -f`
- [ ] Retrofit `anvil-up` to use `docker compose --profile evm up -d`
- [ ] Retrofit `anvil-down` to use `docker compose --profile evm down`
- [ ] Retrofit `anvil-logs` to use `docker compose --profile evm logs -f`
- [ ] Update `.PHONY` to include all new targets
- [ ] Update `help` target with new targets
- [ ] Run test: `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-33-9-solana-local-dev-infra.test.ts -t "AC 3"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 1 hour

---

### Test Group: AC 5 -- Infra-Up/Infra-Down (2 tests)

**Tasks to make these tests pass:**

- [ ] Add `infra-up` target: `docker compose --profile evm --profile solana up -d`
- [ ] Add `infra-down` target: `docker compose --profile evm --profile solana down`
- [ ] Run test: `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-33-9-solana-local-dev-infra.test.ts -t "AC 5"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

### Test Group: AC 6 -- EVM Regression (3 tests)

**Tasks to make these tests pass:**

- [ ] Verify anvil service image, ports, healthcheck unchanged after profile addition
- [ ] Verify faucet service depends_on and ports unchanged
- [ ] Verify docker-compose.yml has >= 3 services (anvil, faucet, solana-validator)
- [ ] Run test: `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-33-9-solana-local-dev-infra.test.ts -t "AC 6"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.5 hours (verification only)

---

### Test Group: AC 7 -- CI Pipeline Migration (6 tests)

**Tasks to make these tests pass:**

- [ ] Remove `services:` block with `solanalabs/solana:v2.1.0` from CI solana-integration job
- [ ] Add step: `docker compose --profile solana up -d`
- [ ] Add health check wait step polling `localhost:8899/health`
- [ ] Add teardown step: `docker compose --profile solana down` with `if: always()`
- [ ] Remove manual `solana program deploy` step (init entrypoint handles it)
- [ ] Remove `Install Solana CLI tools` step (not needed with docker-compose approach)
- [ ] Run test: `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-33-9-solana-local-dev-infra.test.ts -t "AC 7"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 2 hours

---

### Test Group: AC 4 -- Subscription Tests (2 tests, GREEN regression gate)

**Tasks to make these tests pass:**

- [ ] No implementation needed -- these are regression gates verifying existing test structure
- [ ] After infrastructure is up, run: `SOLANA_INTEGRATION=true npx jest test/integration/solana-subscription.test.ts --verbose`
- [ ] Verify T-33.7-05 and T-33.7-10 pass against local validator

**Estimated Effort:** 0.5 hours (manual verification)

---

## Running Tests

```bash
# Run all acceptance tests for this story (all skipped in RED phase)
npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-33-9-solana-local-dev-infra.test.ts --verbose

# Run specific test group
npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-33-9-solana-local-dev-infra.test.ts -t "AC 1: Docker Compose"

# Run subscription integration tests after infra is up
SOLANA_INTEGRATION=true npx jest test/integration/solana-subscription.test.ts --verbose

# Run EVM regression tests after profile migration
EVM_INTEGRATION=true npx jest test/integration/multi-hop-e2e.test.ts --verbose
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 37 tests written and skipped (describe.skip)
- Tests verify configuration files (docker-compose.yml, Makefile, ci.yml)
- Tests use YAML parsing for structured docker-compose validation
- Tests use regex matching for Makefile and CI workflow validation
- Implementation checklist created mapping tests to infrastructure tasks

**Verification:**

- All 37 tests run and are skipped as expected
- Test file compiles without type errors
- Tests are designed to pass once infrastructure is implemented

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. **Start with AC 1** -- Add solana-validator service to docker-compose.yml
2. **Add profiles** -- Add `profiles: [evm]` to anvil/faucet, `profiles: [solana]` to solana-validator
3. **Write init script** -- Inline entrypoint matching the Anvil pattern
4. **Add Makefile targets** -- solana-up/down/logs, infra-up/down, retrofit anvil-*
5. **Migrate CI** -- Replace inline services block with docker-compose approach
6. **Verify EVM regression** -- Run existing EVM tests unchanged
7. **Verify Solana subscription tests** -- Run with SOLANA_INTEGRATION=true

**Key Principles:**

- One acceptance criterion at a time
- Remove `describe.skip` to `describe` as implementation progresses
- Run tests frequently for immediate feedback
- Use implementation checklist as roadmap

---

### REFACTOR Phase (DEV Team - After All Tests Pass)

**DEV Agent Responsibilities:**

1. Verify all 37 tests pass (green phase complete)
2. Smoke test: `make solana-up` / `make solana-down` manually
3. Smoke test: `make infra-up` / `make infra-down` manually
4. Verify `make anvil-up` still works with profile-based docker-compose
5. Run full test suite: `npm test` to confirm no regressions
6. Push to test branch and verify CI solana-integration job passes

---

## Next Steps

1. **Share this checklist and failing tests** with the dev workflow (manual handoff)
2. **Run failing tests** to confirm RED phase: all 37 tests skipped
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

**Command:** `npx jest --config='{}' --preset=ts-jest --testEnvironment=node packages/connector/test/acceptance/story-33-9-solana-local-dev-infra.test.ts --verbose`

**Results:**

```
Test Suites: 1 skipped, 0 of 1 total
Tests:       37 skipped, 37 total
Snapshots:   0 total
Time:        3.065 s
```

**Summary:**

- Total tests: 37
- Passing: 0 (expected)
- Skipped: 37 (expected -- describe.skip used for RED phase)
- Status: RED phase verified

---

## Notes

- **Infrastructure-only story** -- No new business logic tests needed; tests verify configuration files
- **js-yaml dependency** -- Used for structured docker-compose.yml parsing; available as transitive dependency (installed via other packages)
- **Acceptance tests run separately** -- `jest.config.js` excludes `test/acceptance/` by design; use explicit path or custom config
- **AC 4 tests are regression gates** -- They verify existing test file structure, not new functionality. Actual subscription test execution requires running Docker infrastructure.
- **Profile backward compatibility** -- Once profiles are added, `docker compose up -d` with no profile flag starts NO services. All Makefile targets must specify `--profile`.

---

## Contact

**Questions or Issues?**

- Ask in team standup
- Refer to `docs/solana-deployment.md` for Solana deployment documentation
- Consult `_bmad/tea/testarch/knowledge` for testing best practices

---

**Generated by BMad TEA Agent** - 2026-03-29
