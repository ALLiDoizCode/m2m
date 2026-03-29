# Story 34.10: Mina Local Development Infrastructure

Status: ready-for-dev

<!-- Infrastructure story to close the gap identified in Epic 34 retrospective:
     Docker infrastructure for local Mina development was designed in architecture
     but never assigned as a deliverable to any story. -->

## Story

As a developer working on Mina settlement features,
I want a one-command local Mina lightnet with funded accounts and archive node (matching the Anvil pattern),
so that I can run E2E integration tests against real Mina blockchain infrastructure without mocks.

**Epic:** 34 — Mina Protocol Payment Channel Provider
**Priority:** P0 (higher confidence gap than Solana — mock-only provider tests have no real o1js execution)
**Estimated effort:** 2–3 dev days
**Dependencies:** Story 34.3 (Mina zkApp builds), Story 34.8 (test stubs exist), Story 33.9 (Docker Compose profiles pattern)

## Acceptance Criteria

### AC 1: Docker Compose Service — Mina Lightnet

```gherkin
Scenario: Mina lightnet runs as a Docker Compose service
  Given the project docker-compose.yml
  When I run `make mina-up`
  Then a Mina local network container starts using image `o1labs/mina-local-network:o1js-main`
  And the container exposes GraphQL on port 3085, accounts manager on port 8181, and explorer on port 8282
  And the archive PostgreSQL is remapped to port 5433 (avoiding conflicts with local Postgres on 5432)
  And the container uses Docker Compose profile `mina`
  And the container is allocated 4-8 GB RAM via `deploy.resources.limits.memory`
  And the health check passes within 180 seconds using the accounts manager endpoint
```

### AC 2: Funded Account Acquisition

```gherkin
Scenario: Test accounts are available via lightnet accounts manager
  Given the Mina lightnet container is healthy
  When I request `curl -s http://localhost:8181/acquire-account`
  Then the response contains a JSON object with `pk` (B62 prefix), `sk` (EKE prefix), and `balance` fields
  And the account has sufficient balance (≥ 1000 MINA) for test transactions
  And multiple sequential requests return distinct funded accounts
```

### AC 3: Makefile Targets

```gherkin
Scenario: Makefile provides mina-up, mina-down, mina-logs targets
  Given the project Makefile
  When I run `make mina-up`
  Then it executes `docker compose --profile mina up -d`
  And when I run `make mina-down` it executes `docker compose --profile mina down`
  And when I run `make mina-logs` it executes `docker compose --profile mina logs -f`
```

### AC 4: Lightnet Test Un-Skipped (T-34.8-18)

```gherkin
Scenario: Docker-gated Mina lightnet test passes against local network
  Given the Mina lightnet is running via `make mina-up`
  And the network has reached SYNCED status
  When I run `MINA_INTEGRATION=true npx jest test/integration/mina-lightnet.test.ts`
  Then T-34.8-18 (archive node event retrieval) passes
  And the test acquires funded accounts from the accounts manager
  And the test completes within 120 seconds (lightnet block time ~20s)
```

### AC 5: Infra-Up Updated with Mina Profile

```gherkin
Scenario: All-chain infrastructure includes Mina
  Given the project Makefile
  When I run `make infra-up`
  Then all Docker Compose profiles (evm, solana, mina) start
  And when I run `make infra-down` all profiles stop
```

### AC 6: EVM and Solana Regression

```gherkin
Scenario: Existing EVM and Solana tests are not broken by docker-compose changes
  Given the updated docker-compose.yml with Mina service
  When I run `make anvil-up` followed by EVM integration tests
  Then all EVM E2E tests pass unchanged
  And when I run `make solana-up` followed by Solana integration tests
  Then all Solana subscription tests pass unchanged
```

### AC 7: CI Pipeline — Mina Integration Job

```gherkin
Scenario: CI runs Mina lightnet integration tests
  Given the updated CI workflow
  When the mina-integration job runs on main branch pushes
  Then it starts Mina lightnet via docker compose
  And waits for the health check to pass (up to 180 seconds)
  And runs the lightnet tests with MINA_INTEGRATION=true
  And tears down the infrastructure on completion
```

### AC 8: Readiness Helper — waitForMinaReady()

```gherkin
Scenario: Test helper provides Mina readiness check matching Anvil pattern
  Given a test file that imports the readiness helper
  When `waitForMinaReady()` is called
  Then it polls `http://localhost:8181/acquire-account` until the accounts manager responds
  And it polls `http://localhost:3085/graphql` until the GraphQL endpoint responds
  And it times out after 180 seconds with a descriptive error
  And the polling interval is 2 seconds (slower than Anvil due to Mina startup time)
```

## Tasks / Subtasks

- [ ] Task 1: Add Mina lightnet service to docker-compose.yml (AC: 1, 2)
  - [ ] 1.1 Define `mina-lightnet` service with `o1labs/mina-local-network:o1js-main` image
  - [ ] 1.2 Configure ports: `3085:3085` (GraphQL), `8181:8181` (accounts manager), `8282:8282` (explorer)
  - [ ] 1.3 Remap archive PostgreSQL: `5433:5432` to avoid local Postgres conflicts
  - [ ] 1.4 Add `profiles: [mina]` to the service
  - [ ] 1.5 Set memory limit: `deploy.resources.limits.memory: 8g`
  - [ ] 1.6 Configure health check against accounts manager with `start_period: 120s`, `interval: 15s`, `timeout: 10s`, `retries: 10`
  - [ ] 1.7 Add `restart: unless-stopped` matching Anvil pattern

- [ ] Task 2: Add Makefile targets (AC: 3, 5)
  - [ ] 2.1 Add `mina-up` target: `docker compose --profile mina up -d`
  - [ ] 2.2 Add `mina-down` target: `docker compose --profile mina down`
  - [ ] 2.3 Add `mina-logs` target: `docker compose --profile mina logs -f`
  - [ ] 2.4 Update `infra-up` to include `--profile mina`
  - [ ] 2.5 Update `infra-down` to include `--profile mina`
  - [ ] 2.6 Update `make help` with new targets

- [ ] Task 3: Create Mina readiness helper (AC: 8)
  - [ ] 3.1 Create `waitForMinaReady()` in test helpers following `waitForAnvilReady()` pattern from `multi-hop-helpers.ts`
  - [ ] 3.2 Poll accounts manager: `http://localhost:8181/acquire-account` (HTTP 200 = ready)
  - [ ] 3.3 Poll GraphQL endpoint: `http://localhost:3085/graphql` with introspection query
  - [ ] 3.4 180-second timeout with 2-second polling interval
  - [ ] 3.5 Create `acquireFundedAccount()` helper that calls `/acquire-account` and returns `{ publicKey, privateKey, balance }`

- [ ] Task 4: Un-skip and verify mina-lightnet.test.ts (AC: 4)
  - [ ] 4.1 Run `make mina-up` and verify health check passes (allow 2-3 min startup)
  - [ ] 4.2 Change `describe.skip` to environment-variable gating: `const describeMina = process.env.MINA_INTEGRATION === 'true' ? describe : describe.skip`
  - [ ] 4.3 Wire test to use `waitForMinaReady()` in `beforeAll`
  - [ ] 4.4 Wire test to use `acquireFundedAccount()` for funded keypairs
  - [ ] 4.5 Run `MINA_INTEGRATION=true npx jest test/integration/mina-lightnet.test.ts --verbose`
  - [ ] 4.6 Verify T-34.8-18 passes — fix any connection, timeout, or assertion issues
  - [ ] 4.7 Verify all other Mina tests still pass without `MINA_INTEGRATION` set

- [ ] Task 5: Regression verification (AC: 6)
  - [ ] 5.1 Verify `make anvil-up` and EVM integration tests still pass
  - [ ] 5.2 Verify `make solana-up` and Solana integration tests still pass (if Story 33.10 is complete)
  - [ ] 5.3 Verify `make infra-up` starts all three chains
  - [ ] 5.4 Verify `make infra-down` stops all three chains cleanly

- [ ] Task 6: Add CI pipeline job (AC: 7)
  - [ ] 6.1 Add `mina-integration` job to `.github/workflows/ci.yml`
  - [ ] 6.2 Gate on `github.event_name == 'push' && github.ref == 'refs/heads/main'` (matching Solana pattern)
  - [ ] 6.3 Use `docker compose --profile mina up -d` with health check wait loop
  - [ ] 6.4 Set `MINA_INTEGRATION=true` environment variable
  - [ ] 6.5 Run `npx jest test/integration/mina-lightnet.test.ts --ci --verbose`
  - [ ] 6.6 Add teardown step with `if: always()` to stop containers
  - [ ] 6.7 Set job timeout to 10 minutes (Mina startup is slow)

## Dev Notes

### Critical: Mina Startup Time

Mina lightnet takes **1-3 minutes** to reach `SYNCED` status. This is fundamentally different from Anvil (~5s) and Solana (~10s). The health check must account for this:

- `start_period: 120s` — Docker won't mark the container as unhealthy during initial sync
- `interval: 15s` — Don't spam the accounts manager during startup
- `retries: 10` — Allow up to 150s of post-start_period checks

The `waitForMinaReady()` helper in tests should use a **180-second timeout** with **2-second polling** (not 500ms like Anvil).

### Critical: Memory Requirements

The Mina lightnet image runs a full Mina daemon + archive node + accounts manager. It requires **4-8 GB RAM**. Docker Desktop users must have sufficient memory allocated. Add a comment in docker-compose.yml noting this requirement.

### PostgreSQL Port Conflict

The Mina lightnet image includes an archive node backed by PostgreSQL on port 5432. Many developers run local PostgreSQL on the same port. **Remap to 5433** in docker-compose:

```yaml
ports:
  - '3085:3085'   # GraphQL
  - '8181:8181'   # Accounts manager
  - '8282:8282'   # Explorer
  - '5433:5432'   # Archive PostgreSQL (remapped to avoid conflicts)
```

### Accounts Manager API

Unlike Anvil (pre-funded deterministic accounts) or Solana (airdrop), Mina lightnet uses an HTTP API to acquire funded accounts:

```bash
# Acquire a funded account
curl -s http://localhost:8181/acquire-account | jq
# → { "pk": "B62q...", "sk": "EKE...", "balance": "1000" }

# Release account when done (optional, frees it for reuse)
curl -s -X PUT http://localhost:8181/release-account -H 'Content-Type: application/json' \
  -d '{"pk": "B62q..."}'
```

The `acquireFundedAccount()` helper should handle acquisition in `beforeAll` and release in `afterAll`.

### Test Gating Pattern

Follow the Solana pattern — use environment variable gating, not `describe.skip`:

```typescript
const RUN_MINA_TESTS = process.env.MINA_INTEGRATION === 'true';
const describeMina = RUN_MINA_TESTS ? describe : describe.skip;
```

This is consistent with `SOLANA_INTEGRATION` and `EVM_INTEGRATION` patterns.

### Existing Test References

- `packages/connector/test/integration/mina-lightnet.test.ts` — the test to un-skip (T-34.8-18)
- `packages/connector/test/integration/multi-hop-helpers.ts` — `waitForAnvilReady()` pattern to follow
- `packages/connector/test/integration/solana-subscription.test.ts` — `SOLANA_INTEGRATION` gating pattern

### Mina-Specific: No Program Auto-Deploy

Unlike Anvil (deploys contracts on startup) and Solana (deploys .so from volume mount), the Mina lightnet does **not auto-deploy zkApps**. The test itself must deploy the zkApp as part of `beforeAll`:

1. Acquire funded account from accounts manager
2. Compile the zkApp (if not pre-compiled)
3. Deploy via transaction to the lightnet GraphQL endpoint

This is acceptable because the `mina-lightnet.test.ts` stub already includes deployment in its test flow. If startup cost becomes an issue, a future optimization could add an init container that pre-deploys the zkApp.

### Coding Standards Reminders

- **Named exports only** — no default exports
- **Test helper location** — place `waitForMinaReady()` and `acquireFundedAccount()` in a new file `test/integration/mina-helpers.ts` following the `multi-hop-helpers.ts` pattern
- **No modifications to existing mock tests** — the 44 active mock-based tests in `mina-provider.test.ts` etc. must continue to pass without `MINA_INTEGRATION`

## Preconditions

- Docker Desktop running with **at least 8 GB RAM** allocated
- Story 33.9 complete (Docker Compose profiles established) — or can be done in parallel if profiles are coordinated
- `packages/mina-zkapp` builds successfully via `make mina-build`

## Out of Scope

- Writing new E2E test cases beyond un-skipping T-34.8-18
- Un-skipping proof-enabled tests (`mina-proofs.test.ts`) — those require o1js in CI, not Docker infrastructure
- Mina devnet deployment (Story 34.9, already complete)
- Custom Mina Fungible Token support (deferred)
- Solana local infrastructure (Story 33.10, separate)
- zkApp auto-deployment on container startup (future optimization)
- Archive node query optimization
