# Story 33.9: Solana Local Development Infrastructure

Status: ready-for-dev

<!-- Infrastructure story to close the gap identified in Epic 33 retrospective:
     Docker infrastructure for local Solana development was designed in architecture
     but never assigned as a deliverable to any story. -->

## Story

As a developer working on Solana settlement features,
I want a one-command local Solana validator with auto-deployed programs (matching the Anvil pattern),
so that I can run E2E integration tests against real blockchain infrastructure without mocks.

**Epic:** 33 — Solana Payment Channel Provider
**Priority:** P1
**Estimated effort:** 1–2 dev days
**Dependencies:** Story 33.3 (Solana program builds via `cargo build-sbf`), Story 33.7 (test stubs exist)

## Acceptance Criteria

### AC 1: Docker Compose Service — Solana Test Validator

```gherkin
Scenario: Solana validator runs as a Docker Compose service
  Given the project docker-compose.yml
  When I run `make solana-up`
  Then a Solana test validator container starts using image `ghcr.io/beeman/solana-test-validator:latest`
  And the container exposes JSON-RPC on port 8899 and WebSocket on port 8900
  And the container uses Docker Compose profile `solana`
  And the container includes `security_opt: seccomp=unconfined` (required for Agave v2+ io_uring)
  And the health check passes within 30 seconds using `curl -s http://localhost:8899/health`
```

### AC 2: Program Auto-Deployment on Startup

```gherkin
Scenario: Payment channel program deploys automatically on container startup
  Given the Solana program binary exists at `packages/solana-program/target/deploy/payment_channel.so`
  When the Solana validator container starts
  Then the init script waits for validator readiness via `solana cluster-version`
  And airdrops 1000 SOL to the default keypair
  And deploys all `.so` files from the mounted `target/deploy/` directory
  And the deployed program ID is logged to stdout
```

### AC 3: Makefile Targets

```gherkin
Scenario: Makefile provides solana-up, solana-down, solana-logs targets
  Given the project Makefile
  When I run `make solana-up`
  Then it executes `docker compose --profile solana up -d`
  And when I run `make solana-down` it executes `docker compose --profile solana down`
  And when I run `make solana-logs` it executes `docker compose --profile solana logs -f`
```

### AC 4: Subscription Test Un-Skipped (T-33.7-05, T-33.7-10)

```gherkin
Scenario: Docker-gated Solana subscription tests pass against local validator
  Given the Solana validator is running via `make solana-up`
  And the payment channel program is deployed
  When I run `SOLANA_INTEGRATION=true npx jest test/integration/solana-subscription.test.ts`
  Then T-33.7-05 (account subscription fires on claim) passes
  And T-33.7-10 (graceful shutdown unsubscribes watchers) passes
  And all tests complete within 60 seconds
```

### AC 5: Infra-Up / Infra-Down Convenience Targets

```gherkin
Scenario: All-chain infrastructure can be started/stopped with one command
  Given the project Makefile
  When I run `make infra-up`
  Then all Docker Compose profiles (evm, solana) start
  And when I run `make infra-down` all profiles stop
```

### AC 6: EVM Regression — Anvil Tests Still Pass

```gherkin
Scenario: Existing Anvil-based EVM tests are not broken by docker-compose changes
  Given the updated docker-compose.yml with Solana service and profiles
  When I run `make anvil-up` followed by `EVM_INTEGRATION=true npx jest test/integration/multi-hop-e2e.test.ts`
  Then all existing EVM E2E tests pass unchanged
```

### AC 7: CI Pipeline — Solana Integration Job Uses Docker Compose

```gherkin
Scenario: CI runs Solana integration tests using docker-compose instead of inline service
  Given the updated CI workflow
  When the solana-integration job runs
  Then it uses `docker compose --profile solana up -d` to start infrastructure
  And waits for the health check to pass
  And deploys the program binary
  And runs the subscription tests with SOLANA_INTEGRATION=true
  And tears down with `docker compose --profile solana down`
```

## Tasks / Subtasks

- [ ] Task 1: Add Solana service to docker-compose.yml (AC: 1, 2)
  - [ ] 1.1 Add Docker Compose profile `solana` to existing services (add profile `evm` to anvil and faucet)
  - [ ] 1.2 Define `solana-validator` service with `ghcr.io/beeman/solana-test-validator:latest` image
  - [ ] 1.3 Configure ports: `8899:8899` (RPC), `8900:8900` (WebSocket)
  - [ ] 1.4 Add `security_opt: seccomp=unconfined` for Agave v2+ io_uring support
  - [ ] 1.5 Mount `./packages/solana-program/target/deploy:/programs` volume
  - [ ] 1.6 Write init entrypoint script: start validator → wait ready → airdrop → deploy .so files
  - [ ] 1.7 Configure health check: `curl -s http://localhost:8899/health` with 30s start_period, 10s interval
  - [ ] 1.8 Add `--limit-ledger-size 50000000` and `--reset` flags to validator startup

- [ ] Task 2: Add Makefile targets (AC: 3, 5)
  - [ ] 2.1 Add `solana-up` target: `docker compose --profile solana up -d`
  - [ ] 2.2 Add `solana-down` target: `docker compose --profile solana down`
  - [ ] 2.3 Add `solana-logs` target: `docker compose --profile solana logs -f`
  - [ ] 2.4 Add `infra-up` target: `docker compose --profile evm --profile solana up -d`
  - [ ] 2.5 Add `infra-down` target: `docker compose --profile evm --profile solana down`
  - [ ] 2.6 Retrofit existing `anvil-up`/`anvil-down`/`anvil-logs` to use `--profile evm`
  - [ ] 2.7 Update `make help` with new targets

- [ ] Task 3: Verify Solana subscription tests pass (AC: 4)
  - [ ] 3.1 Run `make solana-build` to ensure `payment_channel.so` exists
  - [ ] 3.2 Run `make solana-up` and verify health check passes
  - [ ] 3.3 Run `SOLANA_INTEGRATION=true npx jest test/integration/solana-subscription.test.ts --verbose`
  - [ ] 3.4 Verify T-33.7-05 and T-33.7-10 pass (fix any connection/timeout issues)
  - [ ] 3.5 Verify the non-Docker unit tests in the same file still pass without `SOLANA_INTEGRATION`

- [ ] Task 4: EVM regression verification (AC: 6)
  - [ ] 4.1 Verify `make anvil-up` still works with new profile-based docker-compose
  - [ ] 4.2 Run `EVM_INTEGRATION=true npx jest test/integration/multi-hop-e2e.test.ts` and confirm all pass
  - [ ] 4.3 Verify `make anvil-down` stops only EVM services

- [ ] Task 5: Update CI workflow (AC: 7)
  - [ ] 5.1 Update `solana-integration` job to use `docker compose --profile solana up -d` instead of inline service definition
  - [ ] 5.2 Add health check wait step before running tests
  - [ ] 5.3 Add teardown step (`docker compose --profile solana down`) in `if: always()` block
  - [ ] 5.4 Verify CI job passes on a test branch

## Dev Notes

### Critical: Docker Compose Profiles

The architecture specifies Docker Compose profiles for selective chain startup. Currently, `docker-compose.yml` has no profiles — `anvil-up` starts everything. This story must:

1. Add `profiles: [evm]` to the existing `anvil` and `faucet` services
2. Add `profiles: [solana]` to the new Solana service
3. Retrofit `anvil-up` / `anvil-down` to use `--profile evm`

**Backward compatibility:** `docker compose up -d` with no profile flag will start **no services** once profiles are added. This is a breaking change. The Makefile targets must always specify `--profile`.

### Solana Validator Init Script Pattern

Follow the Anvil entrypoint pattern. The Solana init script should:

```bash
#!/bin/sh
solana-test-validator --reset --limit-ledger-size 50000000 &
VALIDATOR_PID=$!

# Wait for readiness
until solana cluster-version --url http://localhost:8899 2>/dev/null; do
  sleep 1
done

# Fund default keypair
solana airdrop 1000 --url http://localhost:8899

# Deploy all programs from /programs
for so_file in /programs/*.so; do
  [ -f "$so_file" ] && solana program deploy "$so_file" --url http://localhost:8899
done

wait $VALIDATOR_PID
```

### Docker Image: beeman vs solanalabs

The architecture specifies `ghcr.io/beeman/solana-test-validator:latest` which provides multi-arch (amd64 + arm64) support for Apple Silicon Macs. The CI currently uses `solanalabs/solana:v2.1.0` which is amd64-only. Use `beeman` for docker-compose (developer laptops) and keep `solanalabs` for CI (ubuntu runners) unless the CI job is migrated to use docker-compose (AC 7).

### security_opt: seccomp=unconfined

Required for Agave v2+ (the Solana validator runtime) which uses Linux `io_uring` system calls. Without this, the validator will crash with `EPERM` errors on syscall filtering. This is a Docker-specific requirement — native installs are unaffected.

### Existing Test References

- `packages/connector/test/integration/solana-subscription.test.ts` — the tests to un-skip (T-33.7-05, T-33.7-10)
- `packages/connector/test/integration/multi-hop-helpers.ts` — the EVM pattern to follow for readiness checks
- `.github/workflows/ci.yml` lines 385-459 — the existing CI job to migrate

### Coding Standards Reminders

- **Named exports only** — no default exports
- **No modifications to test logic** — this story only provides infrastructure; the test assertions in `solana-subscription.test.ts` should not change
- **Health check before tests** — follow the `waitForAnvilReady()` pattern from `multi-hop-helpers.ts`

## Preconditions

- Rust toolchain + Solana CLI installed (for `cargo build-sbf`)
- Docker Desktop running with sufficient resources
- `packages/solana-program/target/deploy/payment_channel.so` built via `make solana-build`

## Out of Scope

- Writing new E2E test cases (this story is infrastructure only)
- Modifying test assertions in `solana-subscription.test.ts`
- Solana devnet deployment (Story 33.8, already complete)
- Token-2022 program support (deferred)
- Mina lightnet infrastructure (separate story)
- Performance benchmarking of validator startup time
