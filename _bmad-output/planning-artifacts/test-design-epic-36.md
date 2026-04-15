---
stepsCompleted:
  - risk-assessment
  - strategy-per-story
  - cross-story-integration
  - regression-analysis
  - test-data-requirements
lastSaved: '2026-04-14'
revision: v1
epicRef: epic-36-real-binary-ator-verification.md
inputDocuments:
  - _bmad-output/planning-artifacts/test-design-epic-35.md
  - _bmad-output/planning-artifacts/epic-35-ator-overlay-transport.md
  - _bmad-output/auto-bmad-artifacts/epic-35-retro-2026-04-14.md
  - _bmad-output/auto-bmad-artifacts/epic-35-end-report.md
  - docs/ator-transport.md
  - packages/connector/test/integration/transport-socks5.test.ts
  - packages/connector/test/helpers/in-process-socks5-proxy.ts
---

# Test Design: Epic 36 -- Real-Binary ATOR Verification

**Date:** 2026-04-14
**Author:** Jonathan (generated with Claude)
**Status:** Draft v1

---

## Executive Summary

**Scope:** Risk-based test plan for Epic 36, covering 6 stories (36.1--36.6) that close the Epic 35 retrospective's top verification gap: the absence of any automated real-binary ATOR test in CI. Epic 36 delivers (1) a local ATOR network (3 DirAuth + 3 relays + 1 HS node) packaged as `docker-compose.anon.yml`, (2) a pinned audit of `@anyone-protocol/anyone-client` CLI flags, (3) a real-binary SOCKS5 integration test against that local ATOR network, (4) a hidden-service + managed-client real-binary test, (5) a nightly CI workflow (+ `workflow_dispatch`) with a `system-tor` fallback smoke job, and (6) documentation updates in `docs/ator-transport.md`.

**Epic Type:** Brownfield verification. No product code changes to `TransportProvider`, `SocksTransportProvider`, or the managed ATOR client are expected: Epic 36 is a **verification epic** that adds integration coverage, CI, and docs to exercise what Epic 35 already shipped. The dominant constraints are: (1) CI flake from real circuit construction, (2) platform coverage gap on `arm64` because ATOR `.deb` binaries target `amd64`, (3) cache-miss and time-budget pressure from circuit-build latency (~30--60s per test), (4) the in-process SOCKS5 helper from Epic 35 must be preserved as the contract test authority (renamed in 36.3), and (5) the real-binary path must remain opt-in (`ATOR_NIGHTLY=1`) so that `make test` stays fast and hermetic for developers.

**Architecture Constraints (Decided, Not Open):**

1. `docker-compose.anon.yml` uses ATOR v0.4.10.0-beta `.deb` packages (not source builds, not Dockerfile `FROM`-from-scratch).
2. Topology is fixed: 3 DirAuth + 3 relays + 1 hidden-service (HS) node. Smaller topologies cannot form a stable consensus.
3. `.deb` is the binary format; `.rpm`, `.tar.gz`, and `apk` are explicitly out of scope.
4. The existing in-process SOCKS5 helper (`packages/connector/test/helpers/in-process-socks5-proxy.ts`) stays as the **contract test** authority and is renamed to `socks5-contract.test.ts` in Story 36.3. Real-binary tests are the **integration layer** authority and do not replace the contract tests.
5. CI matrix is nightly + `workflow_dispatch`, Linux `amd64` + macOS `amd64`. `arm64` coverage is an explicit and documented gap.

**Risk Summary:**

- Total risks identified: 12
- Critical (score >= 8): 2
- High (score 5--7): 5
- Medium (score 3--4): 4
- Low (score 1--2): 1

**Coverage Summary:**

- Docker/compose lifecycle scenarios: 8
- Real-binary integration scenarios: 14
- CI workflow scenarios: 6
- Documentation scenarios: 6
- Contract-preservation regression scenarios: 5
- Estimated effort: 6--9 dev days (gated by CI iteration latency, not LOC)

---

## 1. Key Risks and Mitigating Tests

### Risk Matrix

| ID   | Risk                                                                        | Likelihood | Impact   | Score | Category    | Mitigating Tests                          |
| ---- | --------------------------------------------------------------------------- | ---------- | -------- | ----- | ----------- | ----------------------------------------- |
| R-01 | **CI flake from real circuit construction (consensus timing variance)**    | High       | High     | 9     | CI/RELIAB   | T-36.1-04, T-36.1-05, T-36.3-01, T-36.5-05 |
| R-02 | **Circuit-build latency exceeds CI time budget (>10 min per run)**         | Medium     | Critical | 8     | PERF/CI     | T-36.1-05, T-36.3-02, T-36.5-04           |
| R-03 | **macOS binary signing rejects unsigned ATOR `.deb` payload under Gatekeeper** | Medium   | High     | 7     | COMPAT      | T-36.5-06, T-36.5-07                      |
| R-04 | **`.anon` hidden service descriptor not published inside deadline**         | Medium     | High     | 7     | RELIAB      | T-36.1-07, T-36.4-03                      |
| R-05 | **ATOR testnet parameters drift from v0.4.10.0-beta (consensus break)**    | Medium     | High     | 6     | COMPAT      | T-36.1-02, T-36.1-04, T-36.5-03           |
| R-06 | **`arm64` coverage gap masks a platform-specific regression**              | Low        | High     | 5     | COMPAT      | Documented gap (no mitigating test)       |
| R-07 | **`anyone-client` CLI flag surface changes silently between SDK versions** | Medium     | Medium   | 5     | REGRESSION  | T-36.2-01, T-36.2-02, T-36.2-03           |
| R-08 | **Real-binary test leaks containers / ports between runs**                 | Medium     | Medium   | 5     | HYGIENE     | T-36.1-03, T-36.3-09, T-36.4-07           |
| R-09 | **In-process contract tests silently stop running after 36.3 rename**      | Low        | High     | 5     | REGRESSION  | T-REG-01, T-REG-02                        |
| R-10 | **Fail-closed behavior not re-verified at the real-binary layer**          | Medium     | Medium   | 4     | SECURITY    | T-36.3-06, T-36.3-07                      |
| R-11 | **`ATYP=0x03` (DOMAINNAME) silently rewritten to IPv4 by a future change** | Low        | High     | 4     | SECURITY    | T-36.3-04, T-36.3-05                      |
| R-12 | **Nightly failure artifacts not uploaded, debugging requires local repro** | Low        | Medium   | 2     | OPS         | T-36.5-08                                  |

### Risk Detail: Top 5

**R-01: CI Flake from Real Circuit Construction** (Score 9)
Consensus formation with 3 DirAuth + 3 relays is deterministic in *topology* but non-deterministic in *timing*. Voting rounds, descriptor uploads, and circuit selection each introduce jitter that compounds under CI runner load. A 30-second warm-up that works locally can occasionally miss the window on a noisy GitHub runner. Mitigation: a dedicated "consensus ready" gate (T-36.1-04) that polls DirAuth status rather than sleeping; test-level warm-up budget of 60s (T-36.3-01) with explicit retry on one specific class of startup failure; nightly job reports flake rate over trailing 7 runs as a retro input. No retries inside individual assertions -- flake is a real failure signal, not noise to be silenced.

**R-02: Circuit-Build Latency Exceeds CI Time Budget** (Score 8)
A cold stack takes ~30--60s to form consensus before the first circuit can be built. The hidden-service test (36.4) adds another ~30s for descriptor publication. If each real-binary test pays that cost independently, the nightly workflow easily blows past 10 minutes. Mitigation: the docker-compose stack is started **once per workflow run**, not per test (T-36.1-05). Tests share the stack via `beforeAll`/`afterAll` at the suite level and sequence their scenarios (T-36.3-02). The workflow budget is hard-capped at 25 minutes with a documented baseline of ~12 minutes.

**R-03: macOS Binary Signing Rejects Unsigned ATOR Payload** (Score 7)
ATOR `.deb` binaries are unsigned from the upstream Anyone Protocol release. On macOS, Gatekeeper and the xattr quarantine flag can block the binary even when invoked from inside a container (notably if the managed-client test spawns a locally-installed `anon` rather than going through Docker). Mitigation: the macOS matrix job runs only the Docker-isolated scenarios by default (T-36.5-06); a dedicated `system-tor` fallback job installs Tor via Homebrew and exercises the SOCKS path against real-Tor (T-36.5-07) so that macOS has at least one non-Docker path covered.

**R-04: Hidden Service Descriptor Not Published Inside Deadline** (Score 7)
HS descriptor publication requires the HS node to rendezvous with introduction points via the consensus. In a minimal 3-DirAuth/3-relay testnet this can take up to 90s. If the test asserts `externalUrl` availability too early, the assertion fails with a spurious "hostname not ready" error that looks like a product bug. Mitigation: T-36.1-07 polls the HS descriptor via `hs_desc` control-port command (or equivalent) up to 120s before declaring failure; T-36.4-03 separates "HS node started" from "HS descriptor published and fetchable" as two assertions with different deadlines.

**R-05: ATOR Testnet Parameters Drift** (Score 6)
ATOR v0.4.10.0-beta is not a frozen artifact. Protocol-relevant parameters (consensus algorithm, timing constants, TLS cert format) can shift between patch releases even when the SDK surface does not. Mitigation: the compose file pins the `.deb` version exactly (no `:latest`, no floating tags) (T-36.1-02); the nightly workflow records the pinned version in every run's artifact bundle (T-36.5-03); a version-bump is a deliberate PR, not a passive update.

---

## 2. Test Strategy Per Story

### Story 36.1: Local ATOR Network Image + docker-compose

**Test Level:** Shell/Docker integration (compose lifecycle)
**Risk Focus:** R-01 (consensus timing), R-02 (time budget), R-05 (version pin), R-08 (hygiene)
**Estimate:** 3 points

| ID        | Scenario                                                                                                        | Type        | Priority |
| --------- | --------------------------------------------------------------------------------------------------------------- | ----------- | -------- |
| T-36.1-01 | `make ator-up` starts 7 containers (3 DirAuth + 3 relays + 1 HS) and exits 0                                    | Integration | P0       |
| T-36.1-02 | `docker-compose.anon.yml` pins ATOR `.deb` version exactly (v0.4.10.0-beta), no floating tags                   | Static      | P0       |
| T-36.1-03 | `make ator-down` tears down all containers, networks, and named volumes without leaking ports                   | Integration | P0       |
| T-36.1-04 | DirAuth quorum produces a fresh consensus document within 60s of `make ator-up`                                 | Integration | P0       |
| T-36.1-05 | Client SOCKS port on the HS node is reachable (TCP connect succeeds) within 90s of `make ator-up`               | Integration | P0       |
| T-36.1-06 | All 3 relays successfully register with the DirAuth quorum and appear in the consensus within 90s               | Integration | P0       |
| T-36.1-07 | HS node publishes a hidden-service descriptor fetchable via `hs_desc` within 120s                               | Integration | P0       |
| T-36.1-08 | `make ator-logs` streams combined stdout from all 7 containers without error                                    | Integration | P1       |

**Approach:** Shell-level tests invoked from a new `test/integration/ator-compose.sh` (or equivalent `.test.ts` wrapper that exec's the make targets). The compose file's health checks drive readiness polling. These are the foundation for every other real-binary test -- if 36.1 is flaky, nothing else in the epic works.

**Test File:** `packages/connector/test/integration/ator-compose.test.ts` + `infra/ator/docker-compose.anon.yml`

---

### Story 36.2: anyone-client SDK CLI Flag Audit

**Test Level:** Documentation + static check
**Risk Focus:** R-07 (flag drift)
**Estimate:** 1 point

| ID        | Scenario                                                                                                        | Type        | Priority |
| --------- | --------------------------------------------------------------------------------------------------------------- | ----------- | -------- |
| T-36.2-01 | `docs/ator-transport.md` pins exact `anyone-client` CLI flags used by the managed client (SDK vX.Y.Z)           | Doc review  | P0       |
| T-36.2-02 | CI smoke job runs `anon --help` against the pinned version and diffs against a committed snapshot               | Integration | P0       |
| T-36.2-03 | Each flag in the snapshot is annotated with the story that introduced it (35.5 or 36.x)                         | Doc review  | P1       |

**Approach:** The managed client depends on specific CLI flags. When the SDK upgrades, flags can be renamed, deprecated, or change default values. A committed `anon --help` snapshot + a diff gate catches this class of change at PR time rather than at operator time.

**Test File:** `packages/connector/test/integration/anon-cli-snapshot.test.ts` + `docs/ator-transport.md`

---

### Story 36.3: Real-Binary SOCKS5 Integration Test

**Test Level:** Integration (real ATOR stack from 36.1)
**Risk Focus:** R-01 (flake), R-02 (latency budget), R-09 (contract-vs-integration separation), R-10 (fail-closed at real layer), R-11 (ATYP=0x03)
**Estimate:** 3 points

| ID        | Scenario                                                                                                        | Type        | Priority |
| --------- | --------------------------------------------------------------------------------------------------------------- | ----------- | -------- |
| T-36.3-01 | Real circuit established: `SocksTransportProvider` with `socks5h://` to real ATOR stack opens a TCP tunnel      | Integration | P0       |
| T-36.3-02 | Circuit warm-up time budget is 60s; test fails explicitly (not times out silently) if exceeded                  | Integration | P0       |
| T-36.3-03 | BTP handshake (AUTH + ACK) completes over a real 3-hop circuit                                                  | Integration | P0       |
| T-36.3-04 | `tcpdump` / log-inspection on the HS container confirms `ATYP=0x03` (DOMAINNAME) in the SOCKS5 CONNECT          | Integration | P0       |
| T-36.3-05 | No `ATYP=0x01` (IPv4) or `ATYP=0x04` (IPv6) SOCKS requests observed for any `.anon` destination                 | Integration | P0       |
| T-36.3-06 | Kill one of the 3 relays -> subsequent circuit still builds (uses a different path)                             | Integration | P0       |
| T-36.3-07 | Kill all 3 relays simultaneously -> connector fails closed; no direct TCP fallback observed                     | Integration | P0       |
| T-36.3-08 | ILP application round-trip (PREPARE -> FULFILL) through real circuit succeeds within adjusted timeout           | Integration | P0       |
| T-36.3-09 | Teardown helper reliably kills any child processes spawned during the test, even on assertion failure           | Integration | P0       |
| T-36.3-10 | Existing in-process helper renamed from `transport-socks5.test.ts` to `socks5-contract.test.ts`, still green    | Regression  | P0       |
| T-36.3-11 | Contract test vs integration test are both required gates; neither subsumes the other                           | Static      | P0       |

**Approach:** This is the core value delivery of Epic 36. The test reuses the docker-compose stack from 36.1 via a suite-level `beforeAll`. `tcpdump` inside the HS container (or equivalent log capture) is the ground-truth oracle for the `ATYP=0x03` assertion -- the SDK could be wrong, the SOCKS library could be wrong, but the wire bytes cannot lie. The fail-closed test (T-36.3-07) kills relays via `docker kill` during an active session.

**Test File:** `packages/connector/test/integration/transport-socks5-real.test.ts`; contract file is renamed to `packages/connector/test/integration/socks5-contract.test.ts`.

---

### Story 36.4: Hidden-Service + Managed-Client Real-Binary Test

**Test Level:** Integration (real ATOR stack + managed `anon` client)
**Risk Focus:** R-02 (HS descriptor timing), R-04 (descriptor publication), R-08 (process hygiene)
**Estimate:** 3 points

| ID        | Scenario                                                                                                        | Type        | Priority |
| --------- | --------------------------------------------------------------------------------------------------------------- | ----------- | -------- |
| T-36.4-01 | Managed ATOR client starts, SOCKS proxy becomes available within 60s, HS descriptor published within 120s      | Integration | P0       |
| T-36.4-02 | HS hostname (`*.anon`) is minted and surfaced via `getExternalUrl()`                                            | Integration | P0       |
| T-36.4-03 | `externalUrl: "auto"` resolves to the minted `.anon` hostname at config-load time                               | Integration | P0       |
| T-36.4-04 | Inbound peer connection to the `.anon` hostname succeeds (a second managed client dials in through the stack)  | Integration | P0       |
| T-36.4-05 | Full managed lifecycle: start -> SOCKS ready -> HS published -> stop cleanly, no orphan `anon` process         | Integration | P0       |
| T-36.4-06 | `stop()` kills the `anon` process even if it is unresponsive (sends SIGTERM, escalates to SIGKILL after 10s)    | Integration | P0       |
| T-36.4-07 | `.anon` private key persists across restart when a key directory is configured (hostname does not rotate)       | Integration | P1       |
| T-36.4-08 | `.anon` hostname does rotate when key directory is absent (fresh key per run)                                   | Integration | P1       |

**Approach:** This story exercises the managed-client code path that Epic 35 could only mock. Two managed clients run simultaneously in CI: one hosts a `.anon` endpoint, one dials it. Process hygiene is asserted explicitly -- any orphan `anon` process at teardown is a P0 failure.

**Test File:** `packages/connector/test/integration/managed-ator-real.test.ts`

---

### Story 36.5: Nightly CI Workflow + System-Tor Fallback Smoke

**Test Level:** CI workflow (GitHub Actions)
**Risk Focus:** R-01 (flake tracking), R-02 (time budget), R-03 (macOS signing), R-05 (version pin), R-12 (artifacts)
**Estimate:** 3 points

| ID        | Scenario                                                                                                        | Type        | Priority |
| --------- | --------------------------------------------------------------------------------------------------------------- | ----------- | -------- |
| T-36.5-01 | Nightly schedule (cron) fires and triggers the workflow                                                         | CI          | P0       |
| T-36.5-02 | `workflow_dispatch` allows manual runs from GitHub UI and `gh workflow run`                                     | CI          | P0       |
| T-36.5-03 | Every run records the pinned ATOR `.deb` version in a job summary/artifact                                      | CI          | P0       |
| T-36.5-04 | Workflow completes within 25-minute budget under normal conditions (baseline target: ~12 min)                   | CI          | P0       |
| T-36.5-05 | Matrix includes Linux `amd64` and macOS `amd64`; both pass the shared real-binary suite                         | CI          | P0       |
| T-36.5-06 | macOS job skips non-Docker-isolated scenarios that would require a locally-installed unsigned `anon`            | CI          | P0       |
| T-36.5-07 | `system-tor` fallback job installs Tor (apt on Linux, brew on macOS) and runs the SOCKS contract suite against it | CI        | P0       |
| T-36.5-08 | On failure, workflow uploads compose logs, `tcpdump` capture, and `anon` binary version as artifacts            | CI          | P0       |
| T-36.5-09 | `arm64` coverage gap is documented in the workflow file with a comment linking to Epic 36 retro follow-up       | Doc review  | P1       |

**Approach:** A new `.github/workflows/ator-nightly.yml` defines the schedule, dispatch trigger, matrix, and artifact uploads. The workflow reuses the `make ator-up` / `make ator-down` targets from 36.1. The `system-tor` job is the safety net for the `arm64` and macOS-without-Docker cases.

**Test Files:** `.github/workflows/ator-nightly.yml` + workflow validation via `act` (locally) or a minimal smoke run in the PR that lands 36.5.

---

### Story 36.6: Docs + Deployment-Guide Update

**Test Level:** Documentation review (manual)
**Risk Focus:** documentation-completeness for operators running the nightly
**Estimate:** 1 point

| ID              | Scenario                                                                                            | Type       | Priority |
| --------------- | --------------------------------------------------------------------------------------------------- | ---------- | -------- |
| T-36.6-DOC-01   | `docs/ator-transport.md` documents how to run the local ATOR stack via `make ator-up`              | Doc review | P0       |
| T-36.6-DOC-02   | Deployment guide includes pinned SDK and `.deb` versions used by the nightly                       | Doc review | P0       |
| T-36.6-DOC-03   | Troubleshooting section covers "consensus did not form in 60s" and "HS descriptor not fetchable"    | Doc review | P1       |
| T-36.6-DOC-04   | `arm64` gap is documented with expected future resolution path                                      | Doc review | P1       |
| T-36.6-DOC-05   | `ATOR_NIGHTLY=1` gating env is documented (how to run real-binary tests locally)                    | Doc review | P0       |
| T-36.6-DOC-06   | System-Tor fallback is documented as a supported fallback (not just a CI artifact)                 | Doc review | P1       |

**Approach:** Docs review is manual. Acceptance is measured by reading `docs/ator-transport.md` and confirming every operator-facing behavior added in 36.1--36.5 is documented. No automated test.

---

## 3. Cross-Story Integration Tests

These tests verify behavior that spans multiple stories and cannot be tested in isolation.

| ID          | Stories Covered    | Scenario                                                                                                         | Type        | Priority |
| ----------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------- | -------- |
| T-CROSS-01  | 36.1, 36.3         | Fresh `make ator-up` -> real-binary SOCKS5 test suite passes end-to-end on first attempt                         | Integration | P0       |
| T-CROSS-02  | 36.1, 36.4         | Fresh `make ator-up` -> managed-client HS round-trip passes end-to-end on first attempt                          | Integration | P0       |
| T-CROSS-03  | 36.1, 36.3, 36.4   | Single stack lifecycle: compose up, run 36.3 suite, run 36.4 suite back-to-back, compose down cleanly            | Integration | P0       |
| T-CROSS-04  | 36.2, 36.4         | Managed client invokes only the CLI flags present in the 36.2 snapshot (no unpinned flags in the hot path)       | Integration | P0       |
| T-CROSS-05  | 36.1, 36.5         | Nightly workflow runs `make ator-up` in a clean runner and consensus forms within the documented 60s             | CI          | P0       |
| T-CROSS-06  | 36.3, 36.5         | Real-binary SOCKS suite runs under the nightly workflow with failure artifacts uploaded on simulated failure    | CI          | P1       |
| T-CROSS-07  | 36.5, 36.6         | System-Tor fallback job passes on both Linux and macOS, matching the documented fallback instructions            | CI          | P1       |

---

## 4. Regression Analysis

### Regression Risk Assessment

Epic 36 is a verification epic. In principle it should not modify product code. Two regression-shaped risks nonetheless apply:

1. **In-process contract tests** (the current `transport-socks5.test.ts`) are renamed in Story 36.3. A silent rename that drops the file from jest's discovery pattern would remove Epic 35's primary unit-layer coverage.
2. **Jest configuration** must gate real-binary suites behind `ATOR_NIGHTLY=1`. A misconfiguration that enables them in `make test` by default would slow developer loops dramatically and likely flake on machines without Docker.

### Regression Test Matrix

| ID       | Component                       | Scenario                                                                                                    | Risk     | Priority |
| -------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------- | -------- |
| T-REG-01 | Jest discovery                  | `socks5-contract.test.ts` (renamed from `transport-socks5.test.ts`) is discovered and runs in `make test`   | R-09     | P0       |
| T-REG-02 | Test count                      | Baseline test count (3052 passing from Epic 35) does not drop after 36.3 rename                             | R-09     | P0       |
| T-REG-03 | Default `make test`             | `make test` without `ATOR_NIGHTLY=1` does not attempt to start Docker and does not load real-binary suites  | R-02     | P0       |
| T-REG-04 | BTP regression                  | Epic 35 BTP tests remain green (T-35.6-INT-*) with the contract helper rename                               | R-09     | P0       |
| T-REG-05 | Epic 35 security invariants     | `socks5h://`-only, `.anon` log hygiene, fail-closed at config/provider layer all still pass unchanged       | security | P0       |

**Approach:** Regression is verified by running the existing test suite (`npm test`) after each story lands. The test count is tracked as a quality metric (Epic 35 finished at 3052). Any drop without a clear cause blocks merge.

---

## 5. Test Data Requirements

### Docker Compose Topology

The `infra/ator/docker-compose.anon.yml` file declares:

- `dirauth1`, `dirauth2`, `dirauth3` -- Directory Authority nodes with pre-generated authority identity keys checked into `infra/ator/dirauth-keys/` (or minted at `make ator-up` time into a gitignored volume, whichever the 36.1 implementation chooses).
- `relay1`, `relay2`, `relay3` -- relay nodes bootstrapped against the three DirAuths.
- `hsnode` -- hidden-service node that also exposes the client SOCKS port on a mapped host port (default `9150` to avoid colliding with a developer-installed Tor on `9050`).

### Hidden Service Test Keys

- `infra/ator/hs-keys/` -- fixture directory holding an HS v3 keypair used by the `hsnode` container for reproducible `.anon` hostnames in 36.4-07.
- A parallel "ephemeral" mode mints a fresh key per run for 36.4-08.

### Teardown Helpers

- `infra/ator/teardown.sh` -- kills every container in the compose project, removes the project's network, removes the project's named volumes, asserts no ATOR-related process remains on the host.
- Called from `afterAll` hooks in both `transport-socks5-real.test.ts` and `managed-ator-real.test.ts`, and from `make ator-down`.

### Test Configuration Objects

```typescript
// Real-binary SOCKS5 transport config (used by 36.3 suite)
const realBinaryConfig = {
  transport: {
    type: 'socks5' as const,
    socksProxy: 'socks5h://127.0.0.1:9150', // host-side mapped port of hsnode
    externalUrl: 'ws://peer-fixture.anon/btp',
    managed: false,
  },
};

// Managed real-binary config (used by 36.4 suite)
const managedRealBinaryConfig = {
  transport: {
    type: 'socks5' as const,
    managed: true,
    externalUrl: 'auto', // minted from HS keys at startup
    anonDataDir: '/tmp/ator-test/hs-keys',
  },
};
```

### ATOR Version Pin

```
# infra/ator/VERSION.txt
ANYONE_DEB_VERSION=0.4.10.0-beta
ANYONE_CLIENT_SDK=^x.y.z   # snapshotted in 36.2
```

Any change to either value is a deliberate PR.

---

## 6. Test Environment and Infrastructure

### Dependencies (Test-Only)

| Package / Tool        | Purpose                                                 | Required For             |
| --------------------- | ------------------------------------------------------- | ------------------------ |
| Docker Engine >= 24    | Run `docker-compose.anon.yml`                           | T-36.1-*, T-36.3-*, T-36.4-* |
| docker-compose v2      | Compose-file driver                                     | T-36.1-*, CI workflow     |
| `anyone-client` SDK    | Managed client spawning `anon` binary                   | T-36.4-*                 |
| `tcpdump` (inside HS)  | Wire-level ATYP assertion                               | T-36.3-04, T-36.3-05     |
| Tor (system install)   | `system-tor` fallback smoke                             | T-36.5-07                |
| GitHub Actions runners | Linux `amd64` + macOS `amd64`                           | T-36.5-*                 |

### Gating Strategy

Real-binary tests are gated by the `ATOR_NIGHTLY=1` environment variable, checked in a shared jest setup file:

```typescript
// packages/connector/test/integration/_ator-gate.ts
export const realBinaryDescribe =
  process.env.ATOR_NIGHTLY === '1' ? describe : describe.skip;
```

- `make test` (default) -> `ATOR_NIGHTLY` unset -> real-binary suites skipped.
- `ATOR_NIGHTLY=1 make test-integration` -> real-binary suites run.
- CI nightly workflow sets `ATOR_NIGHTLY=1` explicitly.

### Platform Matrix

| Platform       | Real-binary (Docker)      | System-Tor fallback      | Notes                                             |
| -------------- | ------------------------- | ------------------------ | ------------------------------------------------- |
| Linux amd64    | YES -- full 36.1/3/4 suite | YES -- contract suite    | Primary coverage                                  |
| macOS amd64    | YES -- full 36.1/3/4 suite | YES -- via Homebrew Tor  | R-03 mitigation: Docker isolates unsigned binary  |
| Linux arm64    | NO -- explicit gap         | NO                       | `.deb` amd64-only; tracked as follow-up action    |
| macOS arm64    | NO -- explicit gap         | NO                       | Tracked as follow-up action                       |
| Windows any    | NO -- out of scope         | NO                       | Project does not target Windows                   |

### CI Pipeline Integration

| Gate                         | Tests Included                                                          | When                  |
| ---------------------------- | ----------------------------------------------------------------------- | --------------------- |
| PR checks (existing)         | All unit + contract tests (including renamed `socks5-contract.test.ts`) | Every PR              |
| PR checks (existing)         | Full regression suite (Epic 35 + prior)                                 | Every PR              |
| Nightly workflow             | 36.1 compose lifecycle + 36.3 real SOCKS + 36.4 managed HS + 36.5 fallbacks | Nightly cron + workflow_dispatch |
| Nightly workflow artifacts   | Compose logs + tcpdump capture + version pin summary                    | On every run (failure mandatory, success optional) |

### Integration Test Environment Setup

```
beforeAll (suite-level, not per-test):
  1. make ator-up                         [<= 10s to start containers]
  2. wait-for-consensus --deadline=60s    [polls DirAuth status]
  3. wait-for-hs-descriptor --deadline=120s (36.4 only)
  4. capture tcpdump on hsnode (36.3 only)

beforeEach (per-test):
  - fresh SocksTransportProvider/ManagedATORClient instances
  - no new containers spawned

afterEach (per-test):
  - stop provider/client, assert no child process orphaned
  - assert no new containers left behind

afterAll (suite-level):
  1. stop tcpdump and archive capture
  2. make ator-down
  3. assert no ATOR-related process remains on host
  4. assert all project volumes/networks removed
```

### Gate Decision Thresholds

Same as Epic 35:

- **P0**: 100% pass rate. Any P0 failure blocks merge.
- **P1**: >= 80% pass rate. Known flakes must have an owning issue.
- **P2**: tracked but not blocking.

---

## 7. Test Execution Order

### Recommended Implementation Order

1. **Story 36.1** -- Local ATOR network + compose (foundation, blocks 36.3 and 36.4).
2. **Story 36.2** -- CLI flag audit (can parallelize with 36.1; blocks 36.4's flag-usage assertion).
3. **Story 36.3** -- Real-binary SOCKS5 test + contract rename (depends on 36.1).
4. **Story 36.4** -- HS + managed-client real-binary test (depends on 36.1, 36.2).
5. **Story 36.5** -- Nightly CI + system-Tor fallback (depends on 36.1, 36.3, 36.4).
6. **Story 36.6** -- Docs (depends on all above).

### Test Dependency Graph

```
T-36.1-* (compose lifecycle + consensus)
    |
    +-- T-36.2-* (flag snapshot, parallelizable)
    |
    +-- T-36.3-* (real SOCKS5, renames contract)
    |       |
    |       +-- T-REG-01..02 (contract rename doesn't break discovery)
    |
    +-- T-36.4-* (HS + managed client)
    |
    +-- T-36.5-* (nightly CI wiring)
            |
            +-- T-CROSS-05..07 (workflow-level cross-story)
```

---

## 8. Coverage Crosswalk: Epic 35 Retro "NOT Verified" Gaps

Every gap flagged in the Epic 35 retrospective that Epic 36 is chartered to close is mapped to a Test ID below. A gap without a T-ID mapping is explicitly out of scope for Epic 36.

| Epic 35 Retro Gap                                                                  | Mapped Test IDs                       | Story  | Status     |
| ---------------------------------------------------------------------------------- | ------------------------------------- | ------ | ---------- |
| No real-binary ATOR integration test in CI (Challenge #1, Gap #1)                  | T-36.1-01..08, T-36.3-01..11, T-36.5-01..09 | 36.1, 36.3, 36.5 | COVERED |
| Managed lifecycle never verified end-to-end against real ATOR (Challenge #1)       | T-36.4-01..08                         | 36.4   | COVERED    |
| ATOR real-binary deferred to "nightly that does not exist yet" (Insight #7)        | T-36.5-01, T-36.5-02, T-36.5-08       | 36.5   | COVERED    |
| SDK flag surface could change silently between versions (inferred from Gap list)   | T-36.2-01, T-36.2-02, T-36.2-03       | 36.2   | COVERED    |
| `ATYP=0x03` DNS-remote path only tested via in-process helper (Challenge #1)       | T-36.3-04, T-36.3-05                  | 36.3   | COVERED    |
| Fail-closed only tested via mocked proxy drop (Challenge #1)                       | T-36.3-06, T-36.3-07                  | 36.3   | COVERED    |
| `docs/ator-transport.md` has no "how to run it" for real binaries (implied)        | T-36.6-DOC-01, T-36.6-DOC-05          | 36.6   | COVERED    |
| `npm audit` gate for optional dep (Challenge #2)                                   | -- (no T-ID)                          | --     | OUT OF SCOPE -- separate action item in retro |
| AC #9 BTP-vs-ILP scope compromise (Challenge #3)                                   | T-36.3-08 (full ILP round-trip)       | 36.3   | COVERED    |
| Fragile `BTPClient._ws` private access in INT-04 (Challenge #4)                    | -- (no T-ID)                          | --     | OUT OF SCOPE -- separate action item |
| `externalUrl` placeholder `ws://localhost` footgun (Challenge #5)                  | -- (no T-ID)                          | --     | OUT OF SCOPE -- separate action item |
| 30s health-cache granularity (Challenge #6)                                        | -- (no T-ID)                          | --     | OUT OF SCOPE -- separate action item |
| Pre-existing path-join at `connector-node.ts:1720` (Challenge #7)                  | -- (no T-ID)                          | --     | OUT OF SCOPE |
| Docs-drift CI gate between schema and docs (Challenge #8)                          | -- (no T-ID)                          | --     | OUT OF SCOPE -- separate action item |
| Zod migration debt (Challenge #9)                                                  | -- (no T-ID)                          | --     | OUT OF SCOPE |
| `arm64` coverage (pre-existing platform gap)                                       | T-36.5-09 (documented, not tested)    | 36.5   | DOCUMENTED GAP |

Every retro gap in the "Challenge #1 -- No real-binary ATOR integration test" cluster has a mapped T-ID. Gaps flagged as OUT OF SCOPE are not regressions of Epic 36's charter; they belong to separate action items in the retro action list.

---

## 9. Security Test Focus Areas

Epic 35 delivered the security invariants (fail-closed, `socks5h://` only, no `.anon` at INFO+). Epic 36 re-verifies them at the real-binary layer, where the in-process helper could not reach.

### DNS-Remote (ATYP=0x03) Wire-Level Verification

The in-process SOCKS5 helper observes the `ATYP` byte in-process (trusted path). The real-binary path introduces a real SOCKS5 proxy in between, and the only trusted oracle is the wire. `tcpdump` on the HS container captures the SOCKS5 CONNECT bytes, and T-36.3-04 / T-36.3-05 assert both positive (only `ATYP=0x03` is seen) and negative (no `ATYP=0x01`/`0x04` leaks) properties.

### Fail-Closed Verification at the Real Transport Layer

- T-36.3-07: all 3 relays killed -> fail-closed (no direct fallback).
- T-36.3-06: single relay killed -> circuit rebuilds (fault-tolerant, not fail-closed-on-single-failure).

These two tests together distinguish "fails closed when circuits are impossible" from "fails closed on any blip" -- the product behavior is the former.

### Managed Client Process Isolation

- T-36.4-06: `stop()` reliably kills the `anon` process under adverse conditions.
- T-36.4-05: no orphan process remains after a clean shutdown.

Orphan processes are a resource leak and a security concern (stale SOCKS proxy exposed on a test machine).

---

## 10. Open Questions for Testing

1. **tcpdump inside container vs on host**: Capturing on `hsnode` is closest to the wire; capturing on the host bridge is simpler but adds `docker0` noise. Recommendation: install `tcpdump` in the `hsnode` image, capture to `/captures/`, copy out in `afterAll`.

2. **HS key persistence fixture**: Commit v3 HS keys to the repo, or mint at `make ator-up` time? Committing gives reproducible hostnames for T-36.4-07; minting avoids leaking a never-rotating test key. Recommendation: mint into a gitignored volume, snapshot the resulting hostname to a per-run artifact.

3. **Nightly workflow retention**: How many nightly run artifacts to retain (cost vs debuggability)? Recommendation: 30 days, 1 GB cap, oldest deleted first.

4. **Flake budget**: How to distinguish a real regression from ATOR testnet jitter? Recommendation: trailing 7-run flake rate published per story in the end-report; >= 2/7 failures on the same T-ID triggers a specific-scope review rather than a generic "flaky" tag.

5. **`system-tor` version pinning**: Homebrew and apt ship different Tor versions; should the fallback job pin a specific Tor minor? Recommendation: pin apt to `tor=0.4.8.*` and brew to `tor@0.4.8` for Linux/macOS parity in 36.5, bump deliberately.

6. **`arm64` closure plan**: The gap is documented, but is a future story in-scope for a hypothetical Epic 37 (rebuild ATOR from source for `arm64`), or is cross-compilation of the `.deb` preferable? Recommendation: raise to the Epic 36 retrospective rather than pre-committing now.
