# Story 36.5: Nightly CI Workflow + System-Tor Fallback Smoke

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **connector maintainer and nightly-CI operator**,
I want **a GitHub Actions workflow (`.github/workflows/nightly-ator.yml`) that runs the real-binary ATOR suite (Stories 36.3 + 36.4) nightly on Linux + macOS, plus a system-`tor` fallback smoke test on each platform that proves `SocksTransportProvider` works with `apt-get install tor` (Linux) and `brew install tor` (macOS)**,
so that **transport-touching regressions are caught before merge, the Epic 35 R-005 system-tor fallback is exercised for the first time, and the three-epic stack of deferred real-binary integration is finally closed with automated nightly coverage on both primary platforms**.

**Epic:** 36 -- Real-Binary ATOR Verification
**Priority:** P0 (closes the nightly CI gap that is the raison d'etre of Epic 36)
**Estimated effort:** 3 points (~2 dev days; workflow YAML + fallback smoke test + docs update)
**Dependencies:** Story 36.1 (done) -- `make ator-up` / `ator-down` / `ator-test`, docker-compose `ator` profile. Story 36.3 (done) -- `transport-ator-real-binary.test.ts`. Story 36.4 (done) -- `transport-ator-hidden-service.test.ts`.

## Acceptance Criteria

> **Test-ID crosswalk (authoritative mapping).** The epic's Key Scenarios table (T-36.5-01..06) and the test-design document's table (T-36.5-01..09) define different T-ID numberings. This story's ACs follow the test-design document's T-IDs as the more granular and complete source. The epic's scenarios are covered but remapped. Preserve the T-ID mapping verbatim in the jest `describe`/`it` titles and workflow comments.
>
> | Sub-AC | T-ID (test-design) | Scenario (one-liner) |
> |-------:|-------------------:|----------------------|
> | AC 5 | T-36.5-01 | Nightly cron fires and triggers the workflow |
> | AC 6 | T-36.5-02 | `workflow_dispatch` allows manual runs |
> | AC 10 | T-36.5-03 | Every run records pinned ATOR `.deb` version in job summary/artifact |
> | AC 15 | T-36.5-04 | Workflow completes within 25-minute budget |
> | AC 2 | T-36.5-05 | Matrix includes Linux + macOS; both pass real-binary suite |
> | AC 16 | T-36.5-06 | macOS job skips non-Docker-isolated scenarios requiring unsigned `anon` |
> | AC 7-9 | T-36.5-07 | System-tor fallback job installs Tor and runs SOCKS contract suite |
> | AC 10 | T-36.5-08 | On failure, workflow uploads compose logs + version as artifacts |
> | AC 17 | T-36.5-09 | `arm64` coverage gap documented in workflow with retro link |

### AC 1: Nightly workflow file exists at canonical path

```gherkin
Given a freshly-merged Story 36.5
When the codebase is inspected at `.github/workflows/nightly-ator.yml`
Then the file exists
And it defines `on.schedule` with cron `"0 4 * * *"` (04:00 UTC daily)
And it defines `on.workflow_dispatch: {}` for manual triggers
And the workflow name is `nightly-ator`
```

> **Note:** The test-design document references `.github/workflows/ator-nightly.yml` (line 214). The epic spec is authoritative and uses `nightly-ator.yml`. Follow the epic.

### AC 2: Real-binary job matrix covers Linux + macOS (T-36.5-05)

```gherkin
Given the nightly-ator workflow
When its `real-binary` job is inspected
Then the strategy.matrix includes `os: [ubuntu-latest, macos-14]`
And `fail-fast: false` is set (both legs run to completion regardless of the other's result)
And `timeout-minutes: 30` is set per job
And each matrix leg:
  1. Checks out code
  2. Sets up Node.js 22.11.0
  3. Installs dependencies (`npm ci`)
  4. Builds shared + mina-zkapp packages
  5. Starts the ATOR network (`docker compose --profile ator up -d`)
  6. Waits for hs1 container health
  7. Runs `make ator-test` (which sets `ATOR_NIGHTLY=1` + `ATOR_SOCKS_PORT`)
  8. Tears down the ATOR network (`docker compose --profile ator down -v`)
```

### AC 3: System-tor fallback smoke job covers Linux + macOS (T-36.5-07)

```gherkin
Given the nightly-ator workflow
When its `system-tor-fallback` job is inspected
Then the strategy.matrix includes:
  - os: ubuntu-latest, install: "sudo apt-get update && sudo apt-get install -y tor"
  - os: macos-14, install: "brew install tor"
And `fail-fast: false` is set
And `timeout-minutes: 15` is set per job
And each matrix leg:
  1. Installs system tor via the platform-specific command
  2. Starts tor (systemctl on Linux, brew services on macOS, or manual start)
  3. Waits for SOCKS5 port 9050 to accept TCP (or `SYSTEM_TOR_PORT` override)
  4. Runs the system-tor fallback smoke test with `SYSTEM_TOR_SMOKE=1` env var
  5. Stops tor
```

> **Note on `apt-get update`:** The epic's workflow shape omits `apt-get update` but CI runners may have stale package lists. The `update` prefix is an intentional CI-hygiene addition, not a divergence from epic intent.

### AC 4: System-tor fallback smoke test file exists

```gherkin
Given `packages/connector/test/integration/transport-system-tor-fallback.test.ts`
When the file is inspected
Then it exists
And its file-level JSDoc declares scope: "System-tor fallback smoke -- requires SYSTEM_TOR_SMOKE=1 and a running system tor on localhost:9050"
And the top-level describe is gated by `const SMOKE = process.env.SYSTEM_TOR_SMOKE === '1'; (SMOKE ? describe : describe.skip)(...)`
And when `SYSTEM_TOR_SMOKE` is unset the test file loads cleanly and every test is skipped
And the test accepts `SYSTEM_TOR_PORT` env var override (default 9050) for platform portability
```

### AC 5: T-36.5-01 -- Nightly cron fires and triggers the workflow

```gherkin
Given the nightly workflow file is merged
When the cron schedule fires at 04:00 UTC
Then both real-binary jobs (ubuntu-latest, macos-14) execute
And both system-tor-fallback jobs (ubuntu-latest, macos-14) execute
```

### AC 6: T-36.5-02 -- workflow_dispatch is invocable

```gherkin
Given the nightly workflow is merged
When a maintainer runs `gh workflow run nightly-ator --ref <branch>`
Then the full matrix runs against the specified branch
```

### AC 7: T-36.5-03 -- SocksTransportProvider.start() succeeds with system tor

```gherkin
Given system tor is running on localhost:9050 (or SYSTEM_TOR_PORT)
And SYSTEM_TOR_SMOKE=1 is set
When the fallback smoke test constructs a SocksTransportProvider with socksProxy: 'socks5h://127.0.0.1:<port>'
And calls provider.start()
Then start() resolves without error
And provider.healthCheck() returns true
```

### AC 8: T-36.5-04 -- TCP round-trip through system tor SOCKS proxy succeeds (smoke)

```gherkin
Given SocksTransportProvider started successfully against system tor
When the test opens a SOCKS5-proxied TCP connection to a local echo server (NOT an external host -- keep it local)
Then the connection succeeds through the system tor SOCKS proxy
And data round-trips correctly
```

> **Scope:** This is a TCP-level smoke test, not a full BTP integration. It proves the SOCKS proxy path works with system tor. No HS, no managed lifecycle, no BTP auth, no ILP PREPARE/FULFILL.

### AC 9: T-36.5-05 -- SocksTransportProvider stops cleanly with system tor

```gherkin
Given SocksTransportProvider started successfully against system tor
When provider.stop() is called
Then it resolves without error
And healthCheck() returns false or the provider is in a stopped state
```

### AC 10: Failure artifacts uploaded on job failure (T-36.5-03, T-36.5-08)

```gherkin
Given the real-binary job fails
When the job's `always()` teardown step runs
Then compose logs are uploaded as a CI artifact (retention-days: 7)
And the pinned anon binary version (from docker image tag) is recorded in the job summary

Given any nightly run (pass or fail)
When the job summary is inspected
Then the pinned ATOR `.deb` version is recorded
```

### AC 11: docs/ator-transport.md updated with Platform Matrix

```gherkin
Given docs/ator-transport.md after this story lands
When the file is inspected
Then a "Platform Matrix" section exists showing:
  - ubuntu-latest: real-binary + system-tor fallback (covered by nightly)
  - macos-14: real-binary + system-tor fallback (covered by nightly)
  - arm64: documented gap with Rosetta emulation note
  - Windows: not supported (per Epic 36 Out of Scope)
And the section references the nightly workflow file path
```

### AC 12: `make test` remains fast and unaffected

```gherkin
Given a developer machine where SYSTEM_TOR_SMOKE is unset
When `make test` is invoked
Then transport-system-tor-fallback.test.ts is discovered but every test is skipped
And the skip reason is "requires SYSTEM_TOR_SMOKE=1 and a running system tor on localhost:9050"
And wall-clock for `make test` does NOT regress
```

### AC 13: Bright line preserved -- zero changes to transport source code

```gherkin
Given this story's diff at completion
When `git diff epic-36~1..HEAD -- 'packages/connector/src/**'` is inspected
Then zero substantive source-code changes exist
```

### AC 14: CHANGELOG + sprint-status updates

```gherkin
Given the story is ready to flip to done
When CHANGELOG.md under `## [Unreleased]` is read
Then there is a new line under `Added` referencing Story 36.5

Given `_bmad-output/implementation-artifacts/sprint-status.yaml`
When the story reaches done state
Then `epics.epic-36.stories.36.5.status` is set to `done`
```

### AC 15: T-36.5-04 -- Workflow completes within time budget

```gherkin
Given the nightly workflow runs on a standard GitHub-hosted runner
When the full matrix completes (all four jobs)
Then total wall-clock per real-binary leg is <= 25 minutes
And total wall-clock per system-tor-fallback leg is <= 10 minutes
```

### AC 16: T-36.5-06 -- macOS job handles Docker availability

```gherkin
Given the real-binary job on macos-14
When Docker Desktop is available
Then the job runs the full real-binary suite via `make ator-test`

Given Docker Desktop is NOT available on the macOS runner
When the real-binary job detects this
Then the job skips Docker-dependent tests with a clear skip message
And does NOT fail the entire workflow (fail-fast is false)
```

### AC 17: T-36.5-09 -- arm64 coverage gap documented in workflow

```gherkin
Given the nightly-ator.yml workflow file
When its comments are inspected
Then a comment documents the arm64 coverage gap
And links to Epic 36 retro follow-up for future arm64 CI coverage
```

## Tasks / Subtasks

- [x] **Task 1 -- Create `.github/workflows/nightly-ator.yml` (AC 1, AC 2, AC 3, AC 5, AC 6, AC 10, AC 15, AC 16, AC 17)**
  - [x] 1.1 Create workflow file with `name: nightly-ator`
  - [x] 1.2 Define triggers: `on.schedule` cron `"0 4 * * *"` + `on.workflow_dispatch: {}`
  - [x] 1.3 Define `real-binary` job:
    - Matrix: `os: [ubuntu-latest, macos-14]`, `fail-fast: false`
    - `timeout-minutes: 30`
    - Steps: checkout, setup-node 22.11.0, `npm ci` (use `nick-fields/retry@v3` per existing `ci.yml` pattern), build shared + mina-zkapp, `docker compose --profile ator up -d`, wait for hs1 health (poll `docker compose port hs1 9050` with retry loop, max 120s), `make ator-test`, teardown `docker compose --profile ator down -v` (in `if: always()`)
    - On failure: upload compose logs as artifact (`docker compose --profile ator logs > /tmp/ator-compose-logs.txt`) with `actions/upload-artifact@v4` and `retention-days: 7`
    - Always: record pinned anon binary version in job summary (T-36.5-03)
  - [x] 1.4 Define `system-tor-fallback` job:
    - Matrix `include` with per-OS install commands: `{ os: ubuntu-latest, install: "sudo apt-get update && sudo apt-get install -y tor" }`, `{ os: macos-14, install: "brew install tor" }`
    - `fail-fast: false`, `timeout-minutes: 15`
    - Steps: checkout, setup-node 22.11.0, `npm ci`, build shared + mina-zkapp, install tor via `${{ matrix.install }}`, start tor (Linux: `sudo systemctl start tor` or `tor &`; macOS: `brew services start tor` or `tor &`), wait for SOCKS5 port 9050 (TCP probe with retry, max 30s), run fallback smoke test with `SYSTEM_TOR_SMOKE=1`, stop tor, teardown
  - [x] 1.5 Add `arm64` coverage gap comment in the workflow file linking to Epic 36 retro follow-up (AC 17, T-36.5-09)
  - [x] 1.6 Add macOS Docker availability check (AC 16, T-36.5-06): macos-14 runners include Docker Desktop. Add a conditional step that checks `docker --version` and skips Docker-dependent steps if unavailable. Document decision in workflow comments. If Docker proves unreliable on macos-14, skip `real-binary` on macOS and rely on `system-tor-fallback` only.

- [x] **Task 2 -- Create system-tor fallback smoke test (AC 4, AC 7, AC 8, AC 9, AC 12)**
  - [x] 2.1 Create `packages/connector/test/integration/transport-system-tor-fallback.test.ts` with file-level JSDoc scope declaration
  - [x] 2.2 Add `SYSTEM_TOR_SMOKE` env gate: `const SMOKE = process.env.SYSTEM_TOR_SMOKE === '1'; (SMOKE ? describe : describe.skip)(...)`
  - [x] 2.3 Read `SYSTEM_TOR_PORT` env var with default 9050: `const TOR_PORT = parseInt(process.env.SYSTEM_TOR_PORT ?? '9050', 10);`
  - [x] 2.4 Implement T-36.5-07 scenario 1 (AC 7): construct `SocksTransportProvider` with `socksProxy: 'socks5h://127.0.0.1:${TOR_PORT}'` and a placeholder `externalUrl` (e.g., `'ws://127.0.0.1:0'`), call `start()`, assert resolves, assert `healthCheck()` returns true
  - [x] 2.5 Implement T-36.5-07 scenario 2 (AC 8): open a SOCKS5-proxied TCP connection through system tor to a local echo server (use `net.createServer` pattern from contract tests). Verify data round-trips correctly. Keep it local -- do NOT connect to external hosts through the tor exit network.
  - [x] 2.6 Implement T-36.5-07 scenario 3 (AC 9): call `provider.stop()`, assert resolves without error
  - [x] 2.7 Add `afterAll` cleanup: stop any started providers, close any open servers. Use `trackProvider()` pattern from Story 36.3.
  - [x] 2.8 Keep the smoke test minimal: 2-3 scenarios only. This is NOT a full integration suite -- it proves the fallback path works, not every BTP feature.

- [x] **Task 3 -- Update docs/ator-transport.md with Platform Matrix (AC 11)**
  - [x] 3.1 Add a "## Platform Matrix" section (or "### Platform Matrix" subsection under an appropriate parent heading)
  - [x] 3.2 Include a table with columns: Platform, Real-Binary Coverage, System-Tor Fallback, Notes
  - [x] 3.3 Rows: ubuntu-latest (nightly CI), macos-14 (nightly CI), arm64 (documented gap -- Rosetta emulation accepted, ~20% latency penalty), Windows (not supported -- see Epic 36 Out of Scope)
  - [x] 3.4 Reference the nightly workflow file path: `.github/workflows/nightly-ator.yml`

- [x] **Task 4 -- Baseline measurement + regression gate (AC 12, AC 13, AC 15)**
  - [x] 4.1 Run `make test` (no `SYSTEM_TOR_SMOKE`) and verify: wall-clock unchanged, new test file discovered but skipped, skip reason logged correctly
  - [x] 4.2 Run `make lint` and `npm run format:check`. Assert clean.
  - [x] 4.3 Verify `git diff epic-36~1..HEAD -- 'packages/connector/src/**'` shows zero new src/ edits

- [x] **Task 5 -- CHANGELOG + sprint-status update (AC 14)**
  - [x] 5.1 Add entry under `## [Unreleased]` in `CHANGELOG.md` under `Added`: "Nightly CI workflow (`nightly-ator.yml`) + system-tor fallback smoke test (Story 36.5)"
  - [x] 5.2 At story-done time, flip `epics.epic-36.stories.36.5.status` to `done`

## Dev Notes

### Entry / Exit Criteria (from test-design-epic-36.md)

**Entry:**
- Stories 36.3 and 36.4 exit criteria met (both done)
- GHCR / image mirror decision resolved (Open Question #1 in epic spec)
- Repo has `workflow_dispatch` permission model configured for transport-touching PRs

**Exit:**
- At least one green run of all four matrix legs (real-binary x {ubuntu-latest, macos-14}; system-tor x {ubuntu-latest, macos-14}) post-merge (T-GATE-36.5-1)
- Workflow wall-clock <= 25 min per leg; 7-run trailing flake rate < 15% per leg
- Failure artifact bundle (compose logs, version manifest) uploaded on any failed job
- `workflow_dispatch` trigger invocable from PR UI; manually verified once (T-GATE-36.5-2)
- Loud failure when `anyone-client` install fails on macOS (T-GATE-36.5-3, R-14 mitigation)

### Cross-Story Test References (from test-design-epic-36.md)

These cross-story tests from the test-design document are exercised by this story's workflow:

| T-ID | Stories | Scenario | Covered by |
|------|---------|----------|------------|
| T-CROSS-05 | 36.1, 36.5 | Nightly workflow runs `make ator-up` in a clean runner, consensus forms within 60s | real-binary job |
| T-CROSS-06 | 36.3, 36.5 | Real-binary SOCKS suite runs under nightly with failure artifacts uploaded on simulated failure | real-binary job + AC 10 |
| T-CROSS-07 | 36.5, 36.6 | System-Tor fallback passes on both platforms, matching documented fallback instructions | system-tor-fallback job |

### Why This Story Matters

This is the final integration story in Epic 36. Stories 36.3 and 36.4 proved the real-binary suite works locally via `make ator-test`. Story 36.5 promotes that suite to nightly CI so regressions are caught automatically. It also exercises the system-`tor` fallback (Epic 35 R-005) for the first time -- previously only documented, never tested.

### Bright Line: Zero `src/` Changes

Same as Stories 36.3 and 36.4: no `packages/connector/src/` edits. This story adds CI infrastructure and a new smoke test. If any source code changes are needed, file a follow-up issue.

### Key Technical Decisions

#### GitHub Actions Workflow Structure

The epic spec (§Architecture, "Nightly vs Dev Loop") defines the workflow shape:

```yaml
name: nightly-ator
on:
  schedule:
    - cron: "0 4 * * *"    # 04:00 UTC daily
  workflow_dispatch: {}
jobs:
  real-binary:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-14]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 30
  system-tor-fallback:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest
            install: "sudo apt-get update && sudo apt-get install -y tor"
          - os: macos-14
            install: "brew install tor"
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
```

Follow this shape exactly. The epic spec is authoritative for the workflow structure.

#### macOS Docker Availability

GitHub-hosted `macos-14` runners include Docker Desktop (Apple Silicon). Docker commands work directly. However, Docker performance on macOS runners is significantly slower than ubuntu-latest due to the Linux VM layer. Set generous timeouts.

If `macos-14` Docker support proves unreliable during implementation, fallback plan: skip the `real-binary` job on macOS and rely on `system-tor-fallback` only. Document this with a comment in the workflow.

#### System-Tor Fallback Test Design

The fallback smoke test is intentionally minimal (2-3 test scenarios). It proves:
1. `SocksTransportProvider.start()` succeeds with system tor's SOCKS5 proxy
2. A TCP connection through the proxy works (data round-trips)
3. `SocksTransportProvider.stop()` cleans up

It does NOT test: HS rendezvous, managed lifecycle, BTP auth, ILP PREPARE/FULFILL, large-frame fragmentation. Those belong to the real-binary suite.

The test uses `socks5h://127.0.0.1:9050` -- the standard system tor SOCKS port. If the port differs on a platform, the test should accept `SYSTEM_TOR_PORT` env var override (default 9050).

#### System-Tor Version Pinning

The test-design document (Open Question #5) recommends pinning `tor=0.4.8.*` (apt) and `tor@0.4.8` (brew) for Linux/macOS parity. Evaluate during implementation whether version pinning is feasible on both platforms without breaking package manager resolution. If pinning causes install failures on CI runners, fall back to unpinned `tor` and document the version drift risk with a comment in the workflow file referencing R-36-07 (system-tor version skew).

#### Env-Gate Pattern

Same pattern as Stories 36.3 and 36.4:
```typescript
const SMOKE = process.env.SYSTEM_TOR_SMOKE === '1';
const describeSmoke = SMOKE ? describe : describe.skip;
```

This ensures `make test` stays fast. The nightly workflow sets `SYSTEM_TOR_SMOKE=1`.

#### Failure Artifact Upload

On real-binary job failure, upload:
1. Docker compose logs: `docker compose --profile ator logs > /tmp/ator-compose-logs.txt`
2. Job summary with pinned `anon` binary version (from docker image tag)

Use `actions/upload-artifact@v4` with `if: failure()` condition. Use `retention-days: 7` to avoid artifact bloat.

#### Existing CI Pattern to Follow

The existing `ci.yml` provides patterns to reuse:
- `nick-fields/retry@v3` for `npm ci` retries (handles transient network failures)
- `actions/setup-node@v4` with `cache: 'npm'`
- Build shared + mina-zkapp before running tests
- `@libsql/linux-x64-gnu` install workaround on Linux
- `if: always()` for teardown steps

The Solana and Mina integration jobs in `ci.yml` (lines ~411-549) are the closest pattern for Docker-dependent CI jobs. Follow their structure for the real-binary job.

### Patterns from Previous Stories to Reuse

1. **Env-gate pattern** from 36.3/36.4: `const X = process.env.Y === '1'; (X ? describe : describe.skip)(...)`
2. **`trackProvider()` pattern** from 36.3: register all provider instances for belt-and-suspenders cleanup in `afterAll`
3. **TCP probe helper** -- for waiting on system tor's SOCKS port. Reuse the `probeTcpPort` function from `src/transport/probe-tcp-port.ts` if importable from tests, or inline a simple TCP probe.
4. **`SocksTransportProvider` construction** -- follow the same pattern as the real-binary tests: `new SocksTransportProvider({ socksProxy, externalUrl, logger })`

### TODO from Story 36.4 -- Helper DRY-up

Story 36.4 added a `TODO(36.5)` for extracting shared docker compose helpers to `packages/connector/test/helpers/ator-compose-helpers.ts`. If the nightly workflow uses `make ator-test` directly (recommended), this DRY-up may not be needed in this story. Evaluate during implementation -- if the fallback smoke test needs docker compose helpers, extract them.

### Anti-Patterns to Avoid

- **DO NOT** edit `packages/connector/src/transport/*.ts` -- bright-line violation
- **DO NOT** make the system-tor fallback test a comprehensive integration suite -- it's a smoke test (2-3 scenarios max)
- **DO NOT** use `always()` for the test execution step -- only use it for teardown
- **DO NOT** hardcode the system tor SOCKS port -- use `SYSTEM_TOR_PORT` env var defaulting to 9050
- **DO NOT** rely on tor being pre-installed on CI runners -- the workflow explicitly installs it
- **DO NOT** use `socks5://` anywhere -- always `socks5h://` (DNS leak prevention, enforced by `parseSocks5hUrl()`)
- **DO NOT** run the system-tor test against the tor exit network for external connections -- keep it local (use a local echo server or the provider's TCP probe only)
- **DO NOT** add the nightly workflow to the required status checks for all PRs -- it's nightly, not per-PR. `workflow_dispatch` is for manual transport-touching PR verification.
- **DO NOT** forget `@libsql/linux-x64-gnu` install workaround on Linux runners (see existing `ci.yml` for the pattern)

### What This Story Does Not Include

- Nightly runs against ATOR mainnet -- out of scope per epic §Out of Scope
- Windows CI coverage -- out of scope per epic §Out of Scope
- Long-running stability/soak tests -- out of scope
- Performance regression baselines -- latency documented but not enforced as CI gate
- Any `src/` code changes -- epic bright-line
- Full BTP integration through system tor -- smoke only, not full suite
- GHCR image build workflow (the weekly image-build job mentioned in epic §Performance Characteristics "Cache-warming strategy") -- that's an infrastructure concern, not this story's scope. If the image is not pre-built, the nightly builds it from the local Dockerfile.

### Project Structure Notes

File additions at completion:

```
.github/workflows/
  nightly-ator.yml                                          -> NEW

packages/connector/
  test/
    integration/
      transport-system-tor-fallback.test.ts                 -> NEW

docs/
  ator-transport.md                                          -> MODIFIED (Platform Matrix section)

CHANGELOG.md                                                 -> MODIFIED (36.5 entry)
_bmad-output/implementation-artifacts/sprint-status.yaml     -> MODIFIED (36.5 status)
```

Acceptable diff surface: new workflow file, new smoke test file, docs update, CHANGELOG, sprint-status, this story file. Zero `src/` edits.

### Testing Standards Summary

- Jest + ts-jest runner per existing `packages/connector/jest.config.*` -- NO new config entries
- Env-gate: `process.env.SYSTEM_TOR_SMOKE === '1'` (string comparison)
- Test naming: `T-36.5-NN` in describe/it titles maps 1:1 to epic test-design IDs and ACs in this story
- No `console.log` in test files
- All promises `await`'d; no floating promises
- `after*` hooks robust -- run even on test failure
- Smoke test is minimal: 2-3 scenarios, not a full integration suite

### Performance Envelope

From the epic spec:
- CI job wall-clock per matrix leg: 10-15 minutes (real-binary suite + docker lifecycle)
- System-tor fallback: < 5 minutes (install tor + 2-3 smoke tests)
- Nightly budget total: ~30 minutes (2 real-binary legs + 2 system-tor legs, fan-out parallel)

Workflow-level `timeout-minutes`:
- `real-binary` job: 30 minutes (generous for CI runner variability)
- `system-tor-fallback` job: 15 minutes

### References

- [Source: _bmad-output/planning-artifacts/epic-36-real-binary-ator-verification.md#story-365-nightly-ci-workflow--system-tor-fallback-smoke] -- acceptance criteria, file list, workflow shape, key scenarios
- [Source: _bmad-output/planning-artifacts/epic-36-real-binary-ator-verification.md#architecture] -- nightly vs dev loop; invocation contract; CI platform matrix
- [Source: _bmad-output/planning-artifacts/epic-36-real-binary-ator-verification.md#performance-characteristics] -- CI job wall-clock, nightly budget
- [Source: _bmad-output/planning-artifacts/epic-36-real-binary-ator-verification.md#risks-and-mitigations] -- R-36-01 (flake), R-36-02 (macOS signing), R-36-03 (arm64), R-36-07 (system-tor version skew)
- [Source: _bmad-output/planning-artifacts/test-design-epic-36.md#story-365-nightly-ci-workflow--system-tor-fallback-smoke] -- T-36.5-01..09 test IDs and approach
- [Source: _bmad-output/planning-artifacts/test-design-epic-36.md#story-365--nightly-ci-workflow--system-tor-fallback-smoke] -- entry/exit criteria
- [Source: _bmad-output/planning-artifacts/test-design-epic-36.md#story-365-ac-mapping] -- AC to test-ID gate mapping
- [Source: _bmad-output/implementation-artifacts/36-4-hidden-service-managed-client-real-binary-test.md] -- previous story: patterns to reuse, completion notes, TODO(36.5) for helper DRY-up
- [Source: _bmad-output/implementation-artifacts/36-3-real-binary-socks5-integration-test.md] -- env-gate pattern, docker compose helpers, trackProvider pattern
- [Source: .github/workflows/ci.yml] -- existing CI patterns: node setup, npm ci retry, shared/mina-zkapp build, Solana/Mina Docker integration job structure
- [Source: Makefile#ator-test] -- `make ator-test` target: sets `ATOR_NIGHTLY=1`, discovers `ATOR_SOCKS_PORT` dynamically from `docker compose port hs1 9050`
- [Source: packages/connector/src/transport/socks-transport-provider.ts] -- SocksTransportProvider constructor options, start(), stop(), healthCheck()
- [Source: packages/connector/src/transport/probe-tcp-port.ts] -- probeTcpPort(), waitForTcpPort() helpers
- [Source: docs/ator-transport.md] -- deployment guide; system tor fallback documented at lines ~132-137 and ~157
- [Source: _bmad-output/project-context.md] -- TypeScript strict mode, Jest testing rules, Pino logging format, transport provider patterns, CI gates

### Project Context Reference (from `_bmad-output/project-context.md`)

See `_bmad-output/project-context.md` for the always-on codebase rules:

- TypeScript monorepo (npm workspaces); strict mode; no `any`
- Lint via ESLint; format via Prettier; both MUST be clean before commit
- Test runner is jest + ts-jest per `packages/connector/jest.config.*`
- No `console.log` in source; test files tolerate `console` for local debugging only
- CHANGELOG.md entries follow Keep-a-Changelog conventions under `## [Unreleased]`
- Use "BLS" not "agent runtime" when referring to the local delivery handler component
- Commit format: `{type}({scope}): {description}` -- conventional commits

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context) -- claude-opus-4-6[1m]

### Debug Log References

None -- clean implementation with no blocking issues.

### Completion Notes List

- **Task 1 (AC 1, 2, 3, 5, 6, 10, 15, 16, 17):** Created `.github/workflows/nightly-ator.yml` with `name: nightly-ator`, `on.schedule` cron `"0 4 * * *"`, `on.workflow_dispatch: {}`. Two jobs: `real-binary` (matrix: ubuntu-latest + macos-14, fail-fast: false, timeout-minutes: 30) and `system-tor-fallback` (matrix include with per-OS install/start/stop commands, fail-fast: false, timeout-minutes: 15). Real-binary job includes Docker availability check (T-36.5-06), hs1 health wait, `make ator-test`, failure artifact upload (T-36.5-08), ATOR version in job summary (T-36.5-03), and always-teardown. arm64 gap documented in workflow header comment (T-36.5-09). System-tor-fallback job installs tor via apt/brew, starts it, waits for port 9050, runs smoke test with `SYSTEM_TOR_SMOKE=1`. Follows existing `ci.yml` patterns: `nick-fields/retry@v3` for npm ci, `actions/setup-node@v4`, `@libsql/linux-x64-gnu` workaround on Linux.
- **Task 2 (AC 4, 7, 8, 9, 12):** System-tor fallback smoke test file was already created by the ATDD pre-commit at `packages/connector/test/integration/transport-system-tor-fallback.test.ts`. File includes: `SYSTEM_TOR_SMOKE` env gate (describe.skip when unset), `SYSTEM_TOR_PORT` env var override (default 9050), three gated scenarios (T-36.5-07a: start + healthCheck, T-36.5-07b: TCP echo round-trip through SOCKS proxy, T-36.5-07c: stop), three ungated self-check tests (env-gate pattern, SMOKE gate value, port default). Verified: `make test` discovers but skips gated tests, ungated self-checks pass.
- **Task 3 (AC 11):** Added "Platform Matrix" section to `docs/ator-transport.md` with table covering ubuntu-latest, macos-14, arm64 (documented gap with Rosetta note), and Windows (not supported). References the nightly workflow file path.
- **Task 4 (AC 12, 13, 15):** Verified `make test` is unaffected (gated tests skip), `make lint` and `npm run format:check` pass clean, `git diff` shows zero `src/` edits (bright line preserved).
- **Task 5 (AC 14):** Added CHANGELOG.md entry under `## [Unreleased]` > `Added`. Updated `sprint-status.yaml` story 36.5 status to `done`.

### Change Log

| Date | Change |
|------|--------|
| 2026-04-16 | Code review #3: Fixed 1 issue (0 critical, 0 high, 1 medium, 0 low). Added missing `permissions` block to workflow (OWASP CI/CD-SEC-4). Full OWASP CI/CD security review completed -- no injection, auth, or credential issues. |
| 2026-04-16 | Code review #2: Fixed 3 issues (0 critical, 0 high, 1 medium, 2 low). PID-tracked `tor &` fallback cleanup, corrected Task 5 Completion Note status text. |
| 2026-04-16 | Code review #1: Fixed 4 issues (0 critical, 1 high, 1 medium, 2 low). Added missing `story-36-5-nightly-ci-validation.test.ts` to File List, corrected Completion Notes sprint-status claim, added `nc -z` portability comment. |
| 2026-04-16 | Story 36.5 implementation complete: nightly-ator.yml workflow, system-tor fallback smoke test (ATDD pre-written), docs Platform Matrix, CHANGELOG + sprint-status updates. |

### File List

| File | Action |
|------|--------|
| `.github/workflows/nightly-ator.yml` | NEW |
| `packages/connector/test/integration/transport-system-tor-fallback.test.ts` | EXISTING (ATDD pre-commit) |
| `packages/connector/test/integration/story-36-5-nightly-ci-validation.test.ts` | NEW (structural AC validation) |
| `docs/ator-transport.md` | MODIFIED (Platform Matrix section) |
| `CHANGELOG.md` | MODIFIED (36.5 entry) |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | MODIFIED (36.5 status) |
| `_bmad-output/implementation-artifacts/36-5-nightly-ci-workflow-system-tor-fallback.md` | MODIFIED (Dev Agent Record) |

## Code Review Record

### Review Pass #1

| Field | Value |
|-------|-------|
| **Date** | 2026-04-16 |
| **Reviewer Model** | Claude Opus 4.6 (1M context) |
| **Critical Issues** | 0 |
| **High Issues** | 1 |
| **Medium Issues** | 1 |
| **Low Issues** | 2 |
| **Total Issues** | 4 |
| **Outcome** | All issues fixed. No remaining concerns. |

### Review Pass #2

| Field | Value |
|-------|-------|
| **Date** | 2026-04-16 |
| **Reviewer Model** | Claude Opus 4.6 (1M context) |
| **Critical Issues** | 0 |
| **High Issues** | 0 |
| **Medium Issues** | 1 |
| **Low Issues** | 2 |
| **Total Issues** | 3 |
| **Outcome** | All issues fixed. Story is done. |

**Issues found and fixed:**

1. **MEDIUM -- Background tor process PID not tracked for cleanup.** The `system-tor-fallback` matrix `start` commands used `(tor &)` as a fallback but discarded the PID, making cleanup impossible if the `stop` step's `systemctl`/`brew services` command failed. Fixed: capture PID to `/tmp/tor.pid` and use `kill` as secondary fallback in stop commands.
2. **LOW -- Completion Note Task 5 stale status text.** The Completion Notes for Task 5 still said `status to 'review'` even though sprint-status.yaml and story Status were both `done`. Fixed: updated to `done`.
3. **LOW -- Stop-step cleanup for `tor &` fallback incomplete.** Related to issue #1 -- the stop commands only attempted service-manager stop, with no fallback for the raw background process case. Fixed as part of issue #1 by adding PID-based kill fallback.

### Review Pass #3

| Field | Value |
|-------|-------|
| **Date** | 2026-04-16 |
| **Reviewer Model** | Claude Opus 4.6 (1M context) |
| **Critical Issues** | 0 |
| **High Issues** | 0 |
| **Medium Issues** | 1 |
| **Low Issues** | 0 |
| **Total Issues** | 1 |
| **Outcome** | All issues fixed. Security review (OWASP CI/CD) completed. |

**Issues found and fixed:**

1. **MEDIUM -- Missing `permissions` block in workflow (OWASP CI/CD-SEC-4).** The `nightly-ator.yml` workflow did not declare a `permissions` block, inheriting the repository default token permissions (`write-all` for `schedule`/`workflow_dispatch` triggers). This violates the principle of least privilege. The existing `ci.yml` uses explicit `permissions` for security-sensitive jobs. Fixed: added top-level `permissions: { contents: read, actions: write }` restricting the GITHUB_TOKEN to read-only content access plus artifact upload capability.

**Security review (OWASP top 10 for CI/CD):**

- **OWASP CI/CD-SEC-1 (Insufficient Flow Control):** N/A -- workflow only triggers on schedule and manual dispatch, no PR-based triggers.
- **OWASP CI/CD-SEC-2 (Inadequate Identity and Access Management):** Pass -- no secrets consumed, no elevated permissions needed.
- **OWASP CI/CD-SEC-3 (Dependency Chain Abuse):** Acceptable -- third-party actions (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`, `nick-fields/retry@v3`) pinned to major versions, consistent with existing `ci.yml` pattern. SHA pinning would be stronger but is not the project convention.
- **OWASP CI/CD-SEC-4 (Poisoned Pipeline Execution):** Fixed -- `permissions` block added. All `${{ }}` expressions use author-controlled values only (`matrix.*`, `github.workflow`, `github.run_number`). No user-controlled inputs interpolated into `run:` scripts.
- **OWASP CI/CD-SEC-5 (Insufficient PBAC):** Pass -- no pipeline modifications possible from external sources.
- **OWASP CI/CD-SEC-6 (Insufficient Credential Hygiene):** Pass -- no secrets or credentials used in the workflow.
- **OWASP CI/CD-SEC-7 (Insecure System Configuration):** Pass -- standard GitHub-hosted runners.
- **OWASP CI/CD-SEC-8 (Ungoverned Usage of 3rd Party Services):** Pass -- only standard GitHub marketplace actions used.
- **Authentication/Authorization:** No flaws -- no auth mechanisms in scope.
- **Injection risks:** None -- no user-controlled data flows into shell commands or expressions.
