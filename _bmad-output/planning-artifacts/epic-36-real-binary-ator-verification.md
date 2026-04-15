# Epic 36: Real-Binary ATOR Verification

**Date:** 2026-04-15
**Author:** Jonathan
**Status:** Draft
**Branch (base):** `epic-35` (merged at `b18c5735`); Epic 36 branches from that tip
**Dependencies:** Epic 35 (ATOR Overlay Transport) — done
**Type:** Brownfield verification extension — no new product features, pure infrastructure to close the production-fidelity gap Epic 35 left behind
**ATOR binary pin:** `v0.4.10.0-beta` (authoritative: <https://github.com/anyone-protocol/ator-protocol/releases/tag/v0.4.10.0-beta>)

---

## Executive Summary

Epic 35 shipped the `TransportProvider` abstraction, a `SocksTransportProvider`, the managed-`anon` lifecycle, the YAML `transport:` block, and the deployment guide. It shipped **without ever running a single byte of BTP traffic through a real ATOR binary in CI.** Every existing integration test stops at an in-process SOCKS5 proxy stub: the SOCKS5 protocol handshake is exercised, but the circuit-build logic, hidden-service rendezvous, 514-byte cell fragmentation, DNS-at-proxy enforcement, and managed-client crash-recovery paths are **not** — they live entirely inside the real `anon` binary that Epic 35 never exercised.

The Epic 35 retro was explicit: "real-binary ATOR integration deferred to a nightly that doesn't exist yet" joined Mina proof-enabled tests and Docker-gated Solana as the third consecutive deferred integration. Epic 36 exists to close that gap specifically for ATOR — stand up a local ATOR network from official `v0.4.10.0-beta` Debian `.deb` packages, run the authoritative integration suite against it nightly, and remove the "consult docs.anyone.io — do not guess" hedges from the deployment guide that exist today only because no one on the team had ever watched a real circuit build succeed.

### What This Epic Does Not Do

Epic 36 is explicitly **not** a feature epic. No `TransportProvider` code path changes. No config-schema changes. No new operator-facing surface. If the existing implementation has a real-binary bug, Epic 36 will find it and file it; the fix lands in a follow-up epic unless it is a one-line blocker surfaced by verification itself.

### Why Now

Three compounding pressures:

1. **Deferred-integration stack is three epics deep.** Every additional epic that defers real-binary testing raises the one-time cost of standing up nightly infrastructure. Epic 35's retro named this explicitly as Team Agreement #4.
2. **The managed-client lifecycle in 35.5 has zero real-binary coverage.** It spawns, probes, and shuts down a binary that never actually existed in any test — the `ManagedAnonClient` tests all mocked `sdk.start()` / `sdk.stop()`. The crash-detection code path is therefore unverified against the thing it detects.
3. **Docs-drift risk is compounding.** The deployment guide at `docs/ator-transport.md` contains hedges ("consult docs.anyone.io — do not guess") that exist because the team could not verify the real CLI flag surface during Epic 35. Each additional epic that doesn't lock these in makes them harder to revisit.

### Production-Fidelity Gap Inventory (from Epic 35 retro §Known Gaps)

| # | Gap | How Epic 36 closes it |
|---|-----|------------------------|
| 1 | Real `anon` binary never exercised in CI | Story 36.1 stands up local network; 36.3–36.5 run tests against it |
| 2 | Managed-client lifecycle untested end-to-end | Story 36.4 runs managed lifecycle against real binary |
| 3 | `.anon` hidden-service rendezvous untested | Story 36.4 provisions real HS, peers through it |
| 4 | Circuit-build latency, cell fragmentation unverified at OS level | Story 36.3 exercises real BTP traffic through real circuit |
| 5 | DNS-leak prevention unverified beyond unit-level URL parsing | Story 36.3 captures SOCKS5 CONNECT `ATYP` bytes on real handshake |
| 6 | `anyone-client` SDK CLI flag surface unaudited | Story 36.2 pins exact flags in `docs/ator-transport.md` |
| 7 | System-`tor` fallback (R-005) documented but never tested | Story 36.5 runs fallback smoke on Linux + macOS |
| 8 | Deployment-guide hedges ("consult docs.anyone.io") | Story 36.6 removes all hedges with verified values |

---

## Architecture

### Local ATOR Network Topology

Epic 36 introduces a docker-compose profile `ator` that mirrors the existing `evm` / `solana` / `mina` profiles. The topology is the chutney minimum for a functional onion-routing network:

```
┌─────────────────────────────────────────────────────────────────┐
│  docker compose --profile ator up -d                            │
│  (brought up by `make ator-up`)                                 │
│                                                                 │
│  Directory Authorities (consensus quorum):                      │
│    dirauth1 ─┐                                                  │
│    dirauth2 ─┼─► shared consensus, voting interval shortened    │
│    dirauth3 ─┘   for test speed (V3AuthVotingInterval=20s)      │
│                                                                 │
│  Relays (non-exit, internal-only network):                      │
│    relay1 ──┐                                                   │
│    relay2 ──┼─► guard + middle + exit roles mixed               │
│    relay3 ──┘                                                   │
│                                                                 │
│  Hidden-service node (also a client):                           │
│    hs1    ──► hosts one .anon hidden service + SOCKS5 port      │
│               exposed to host on 127.0.0.1:<dynamic>            │
│                                                                 │
│  Container image: ator-testnet:v0.4.10.0-beta                   │
│    Base: debian:bookworm-slim                                   │
│    Installs: anon_0.4.10.0-beta-1_amd64.deb (or arm64)          │
│    Source: github.com/anyone-protocol/ator-protocol releases    │
└─────────────────────────────────────────────────────────────────┘
```

3 DirAuth + 3 relays + 1 HS node is the smallest topology that:

- Exercises consensus voting (DirAuth quorum = 2-of-3)
- Provides guard / middle / exit diversity (avoids single-relay shortcut paths)
- Supports at least one HS rendezvous (requires ≥3 hops + introduction point + rendezvous point)
- Mirrors the chutney reference topology so troubleshooting maps cleanly onto upstream Tor debugging knowledge

### How Tests Invoke the Network

Two distinct test layers, with a bright line between them:

```
┌──────────────────────────────────────────────────────────────┐
│  FAST LAYER — runs on every `make test`                      │
│                                                              │
│  test/helpers/in-process-socks5-proxy.ts  (existing, renamed)│
│  test/integration/socks5-contract.test.ts (renamed)          │
│                                                              │
│  Scope: SOCKS5 protocol contract — handshake bytes, ATYP,    │
│  error propagation. NOT a substitute for ATOR integration.   │
│  Runtime: milliseconds. No binary, no network, no Docker.    │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  REAL-BINARY LAYER — runs on `make ator-test` or nightly CI  │
│                                                              │
│  test/integration/transport-ator-real-binary.test.ts (new)   │
│  test/integration/transport-ator-hidden-service.test.ts (new)│
│                                                              │
│  Scope: real `anon v0.4.10.0-beta` network. Exercises        │
│  circuit build, HS rendezvous, cell fragmentation, managed   │
│  lifecycle, DNS-at-proxy at OS level.                        │
│  Runtime: 60–180s per test (circuit build dominates).        │
│  Requires: docker compose --profile ator up -d.              │
└──────────────────────────────────────────────────────────────┘
```

### Nightly vs Dev Loop

```
Dev loop (every commit, local `make test`):
  contract test (~ms) ─► catches SOCKS5 protocol regressions fast
  NO real binary involvement, NO Docker, NO slowdown of the main suite

Dev loop (opt-in, local `make ator-test`):
  docker compose --profile ator up -d  (~15s first run, ~5s warm)
  real-binary integration suite         (~3–8 min)
  docker compose --profile ator down

Nightly CI (GitHub Actions, cron 04:00 UTC + workflow_dispatch):
  matrix: [ubuntu-latest, macos-14]
  ├─ job A: real-binary suite with bundled anon v0.4.10.0-beta
  ├─ job B: system-tor fallback smoke (apt tor on Linux, brew tor on macOS)
  └─ aggregate: required status for merge on transport-touching PRs
```

**Explicitly NOT nightly-scheduled against ATOR mainnet.** The pinned-version local network is the authoritative test surface. Mainnet integration is out of scope (see §Out of Scope).

### Invocation Contract — Test Environment Variables

Real-binary tests detect their environment via two env vars:

| Variable | Effect |
|----------|--------|
| `ATOR_NIGHTLY=1` | Enables real-binary tests. Absent: suite is skipped with `test.skip("requires ATOR_NIGHTLY=1 and docker compose --profile ator")`. |
| `ATOR_SOCKS_PORT` | Host port exposing the hidden-service node's SOCKS5 listener. Defaults to whatever `docker compose port hs1 9050` returns. |

`make ator-test` sets both and invokes the suite. `make test` sets neither — real-binary tests remain skipped. This preserves "fast main suite" as an invariant.

---

## Integration Points

| Component | Interaction |
|-----------|-------------|
| `Makefile` | New targets: `ator-up`, `ator-down`, `ator-logs`, `ator-test`. `infra-up` / `infra-down` extended to include ATOR profile. |
| `docker-compose.yml` | New `ator` profile: 7 services (3 dirauth + 3 relay + 1 hs). Image: `ator-testnet:v0.4.10.0-beta`. |
| `docker/ator/Dockerfile` | New: installs `anon_0.4.10.0-beta_amd64.deb` / `arm64.deb` on `debian:bookworm-slim`. Multi-arch aware. |
| `docker/ator/torrc.*` | New: per-role config templates (dirauth / relay / hs). |
| `docs/ator-transport.md` | Update: CLI flag section pinned verbatim; hedges removed; verified topology documented; platform matrix added. |
| `packages/connector/test/helpers/in-process-socks5-proxy.ts` | **Renamed** to `socks5-contract-fixture.ts`. File-level doc block declares scope: "SOCKS5 protocol contract test, NOT ATOR integration." |
| `packages/connector/test/integration/transport-socks5.test.ts` | **Renamed** to `socks5-contract.test.ts`. |
| `packages/connector/test/integration/transport-ator-real-binary.test.ts` | New (Story 36.3). |
| `packages/connector/test/integration/transport-ator-hidden-service.test.ts` | New (Story 36.4). |
| `.github/workflows/nightly-ator.yml` | New: nightly + `workflow_dispatch` cron job; ubuntu-latest + macos-14 matrix. |

---

## Critical Implementation Rules

| Rule | Why |
|------|-----|
| Real-binary tests MUST be skipped when `ATOR_NIGHTLY` is unset | Preserves `make test` as a fast-feedback loop. Never silently pull a 3+ minute test into the default suite. |
| In-process fixture stays renamed as "contract test" | Every future reader must see at the filename level that it is NOT ATOR coverage. The rename is the non-negotiable clarity fix. |
| ATOR binary version is pinned (`v0.4.10.0-beta`) | Reproducibility. Upstream ATOR may ship breaking changes; pinning protects CI determinism. |
| Docker image tagged with binary version, not `latest` | Same reason — no silent upstream drift. |
| CI job timeout ≥ 30 minutes (per matrix leg) | Circuit build can take 60s; HS rendezvous another 30s; a 5-test suite legitimately eats 8–12 minutes and CI runners vary. |
| System-tor fallback tested, not just documented | Epic 35 R-005 exists as a risk mitigation that was never exercised. Story 36.5 fixes that. |
| Nightly job failure MUST block merge when triggered via `workflow_dispatch` on transport-touching PR | A transport-touching PR that skips real-binary verification would re-open the gap Epic 36 closed. |
| `.anon` addresses from the test HS never appear in CI logs at INFO+ | SEC-05 invariant from Epic 35 must survive into real-binary test output. |
| No ATOR mainnet calls from CI | Using mainnet would make nightlies dependent on third-party availability and leak CI IP into the real Anyone relay network. |

---

## Performance Characteristics

| Metric | Expected | Budget rationale |
|--------|----------|------------------|
| docker compose `ator-up` cold | ~15–25s | Image pull + DirAuth consensus bootstrap dominates. Warm start ~5s (images cached). |
| DirAuth consensus convergence | 30–60s | `V3AuthVotingInterval=20s` × 2 voting rounds. Tests wait for the first valid consensus before opening circuits. |
| First circuit build after consensus | 10–30s | Descriptor fetch + 3-hop path selection + TLS to guard. |
| HS publish + descriptor propagation | 30–90s | Introduction-point selection + HS descriptor upload to HSDir + replication. The HS-available wait is the longest single step. |
| Single BTP round-trip through real circuit | 400–900ms | Consistent with Epic 35 §Performance Characteristics (~400–700ms single-hop ILP). |
| Full real-binary suite runtime | 3–8 minutes | 5–8 tests × ~30–90s avg, dominated by circuit-build and HS-rendezvous setup. |
| CI job wall-clock per matrix leg | 10–15 minutes | Suite + docker lifecycle + setup / teardown + npm install. |
| Nightly slot budget total | ~30 minutes (2 legs, fan-out) | Well within a nightly budget; negligible if cron-scheduled at an off-peak hour. |

**Cache-warming strategy.** The docker image is built and pushed to `ghcr.io` by a separate weekly job, tagged `ator-testnet:v0.4.10.0-beta`. Nightly CI pulls the tag rather than rebuilding — saves 2–3 minutes per run and eliminates a class of Debian-mirror flakes.

---

## Risks and Mitigations

| ID | Risk | Likelihood | Impact | Severity | Mitigation |
|----|------|-----------|--------|----------|------------|
| R-36-01 | **CI flake from real circuit variability** — circuit build can intermittently exceed timeout under CI load | Medium | Medium | 6 | Generous per-test timeouts (3min floor); retry entire docker network on first failure; treat 3 consecutive nightly failures as a real break, not flake |
| R-36-02 | **macOS binary signing / Gatekeeper** blocks unsigned `anon` binary | Medium | High | 7 | Docker Desktop on macOS runs Linux containers — the `anon` binary never executes on the macOS host except when system-`tor` fallback (36.5) is exercised. `brew install tor` ships Homebrew-signed binaries, sidestepping Gatekeeper. |
| R-36-03 | **arm64 coverage gap** — pinned `.deb` may not ship arm64 | Medium | Medium | 6 | Dockerfile supports both arch tags; if ATOR release only ships amd64, Apple-silicon CI runners use `--platform linux/amd64` with Rosetta emulation (accept ~20% latency penalty). Document the constraint. |
| R-36-04 | **ATOR testnet vs mainnet drift** — pinned v0.4.10.0-beta diverges from deployed Anyone network | Low | Medium | 4 | Accepted trade-off. The purpose is CI reproducibility, not mainnet compatibility validation. Bump pin when ATOR ships a new stable and rerun the suite; treat mainnet as a separate manual-verification concern. |
| R-36-05 | **Circuit-build latency eats CI budget** — 5-test suite approaches 30min on slower runners | Medium | Medium | 6 | Parallelize tests that don't share state (HS rendezvous is sequential; circuit-build tests can parallelize). Cache warmed consensus between tests in the same run. |
| R-36-06 | **Upstream release artifact removed / moved** — ATOR deletes the pinned `.deb` | Low | High | 5 | Mirror the pinned `.deb` to a repo-internal artifact store on first successful build. Future runs pull from the mirror, not upstream. |
| R-36-07 | **System-tor version skew across platforms** — `apt tor` version on ubuntu-latest != `brew tor` on macos-14 | Medium | Low | 3 | Fallback smoke is a smoke — not a full suite. Accept that the fallback path is "works, not identical." Document version floor in platform matrix. |
| R-36-08 | **Privileged ports or network namespaces** — docker compose may require elevated permissions on CI | Low | High | 5 | All ATOR service ports are high-numbered (>1024) by config. `ator` profile never claims host privileged ports. Validated on a clean ubuntu-latest runner during Story 36.1. |
| R-36-09 | **Log volume from real-binary suite floods CI output** | Medium | Low | 3 | Test harness redirects `anon` stderr to per-container file; surfaces only on failure. Connector logs filtered to WARN+ unless `ATOR_VERBOSE=1`. |

---

## Security Analysis

### What Real-Binary Testing Proves That Contract Testing Cannot

Epic 35's in-process SOCKS5 fixture proves SOCKS5 protocol compliance — the client speaks the right handshake, the URL scheme is rejected when wrong, the `agent` option threads through to `ws`. It proves nothing about what happens once the handshake completes because the fixture has no circuit behind it. The following properties are only provable against a real binary:

| Property | Why contract test can't prove it |
|----------|----------------------------------|
| **514-byte cell fragmentation of large BTP frames** | In-process proxy passes bytes through a pipe; there is no cell layer to fragment at. A real circuit imposes the 514-byte frame; bugs in BTP frame splitting / reassembly surface here and only here. |
| **Hidden-service rendezvous end-to-end** | The HS protocol is entirely above SOCKS5 — it is an onion-routing application feature. The fixture doesn't speak HS. Bugs in HS descriptor publish, introduction-point selection, and rendezvous-point handshake are unreachable from contract tests. |
| **Circuit-rebuild behavior mid-BTP-session** | A real circuit can fail and rebuild transparently to the application. Testing that BTP survives a mid-session circuit teardown requires an actual circuit to tear down. |
| **DNS-leak verification at OS level** | Contract tests can verify the client sends `ATYP=0x03`. They cannot verify that no DNS query leaks through the host resolver during that call. Real-binary tests capture `tcpdump` on the loopback + host DNS port and confirm absence. |
| **Managed binary crash-recovery** | Story 35.5's `managed_anon_crash_detected` log event fires when the SDK reports the binary is gone. If the real binary has a failure mode the SDK doesn't detect (silent hang, zombie process, bound-but-unresponsive port), the contract path mocks miss it entirely. |
| **TLS fingerprint + relay handshake compatibility** | ATOR relays reject clients whose TLS hello doesn't match expectations. A fixture is always "valid"; a real binary may fail here due to an OS-level TLS stack mismatch. |

### Security Invariants Re-Verified Against Real Binary

Every SEC-* invariant from Epic 35 Story 35.6 is re-asserted in the real-binary suite:

- SEC-01 (SOCKS5 CONNECT uses `ATYP=0x03`): re-asserted via `tcpdump` capture in T-36.3-07
- SEC-02 (fail-closed when proxy unavailable): re-asserted against real binary that is stopped mid-suite (T-36.3-08)
- SEC-03 (`socks5h://` enforcement): re-asserted via real handshake (T-36.3-09)
- SEC-05 (no `.anon` in logs at INFO+): re-asserted on CI log output, including real HS hostnames generated during the run (T-36.4-04)

### What Epic 36 Does NOT Prove

In the interest of honesty:

- **ATOR mainnet interoperability.** The pinned local network may diverge from production Anyone relays.
- **Global-passive-adversary resistance.** Same as Epic 35; still out of scope.
- **Long-lived session stability** beyond test duration (hours / days of circuit churn).
- **HS descriptor rotation over time.** Tests exercise initial publish + retrieval; HS descriptor rotation policy is documented upstream and accepted as-is.

---

## Test Strategy

### Two-Tier Test Taxonomy

| Tier | Location | Authority for | Run when |
|------|----------|---------------|----------|
| **Contract** | `test/integration/socks5-contract.test.ts` (renamed) | SOCKS5 protocol compliance: handshake bytes, ATYP byte, scheme rejection, fast error propagation | Every `make test`; every PR |
| **Real-binary integration** | `test/integration/transport-ator-*.test.ts` (new) | End-to-end ATOR: circuit build, HS rendezvous, managed lifecycle, DNS-at-proxy at OS level | `make ator-test` locally; nightly CI; `workflow_dispatch` on transport-touching PRs |

**Bright line.** Contract tests never spawn a real `anon` binary. Real-binary tests never assert things the contract tests already cover — no duplication; each tier owns its scope.

### CI Platform Matrix

| Platform | Primary path | Fallback path | Rationale |
|----------|--------------|---------------|-----------|
| ubuntu-latest | bundled `anon v0.4.10.0-beta` via Docker | `apt-get install tor` on host | Linux is the authoritative platform; both paths must work |
| macos-14 (Apple Silicon) | bundled `anon v0.4.10.0-beta` via Docker Desktop (amd64 emulation acceptable) | `brew install tor` | Many operators run macOS for dev; Gatekeeper-signed system tor via Homebrew is the macOS fallback story |

No Windows. See §Out of Scope.

### Test ID Naming Convention

Test IDs follow the Epic 35 pattern: `T-36.X-NN` where X is story number and NN is a two-digit sequence. Real-binary tests additionally carry a `-RB` suffix in story-level design docs to distinguish them from any unit tests added in the same story.

---

## Stories

---

### Story 36.1: Local ATOR Network Image + docker-compose Profile

**Priority:** P0
**Estimate:** 3 points
**Dependencies:** None (can begin immediately on branch)

#### Description

Stand up a local ATOR network using the official `anon v0.4.10.0-beta` Debian `.deb` package inside a Docker image. Add the `ator` profile to `docker-compose.yml` with 3 DirAuth + 3 relay + 1 HS node. Add `make ator-up` / `ator-down` / `ator-logs` targets mirroring the existing `anvil-up` / `solana-up` / `mina-up` pattern. Extend `make infra-up` / `infra-down` to include the new profile.

#### Files

- `docker/ator/Dockerfile` — new, multi-arch base on `debian:bookworm-slim`
- `docker/ator/torrc.dirauth` — new, DirAuth role config
- `docker/ator/torrc.relay` — new, relay role config
- `docker/ator/torrc.hs` — new, HS + client role config
- `docker/ator/entrypoint.sh` — new, role-dispatching entrypoint
- `docker-compose.yml` — extend with `ator` profile (7 services)
- `Makefile` — add `ator-up`, `ator-down`, `ator-logs`, `ator-test` targets; extend `infra-up` / `infra-down`

#### Key Behaviors

- `make ator-up` brings up the full 7-service network; exits after `docker compose up -d` returns (not after consensus converges — that's the test's concern)
- `make ator-down` tears everything down cleanly including named volumes
- `make ator-logs` follows logs across all 7 containers
- Image tag pinned to `ator-testnet:v0.4.10.0-beta` (never `latest`)
- Health check on the HS container: SOCKS5 port accepts TCP within 90s of `ator-up` returning
- `.deb` package source verified against ATOR release checksums during image build

#### Acceptance Criteria

```gherkin
Given a fresh checkout on ubuntu-latest
When `make ator-up` is run
Then 7 containers start (3 dirauth, 3 relay, 1 hs)
And all containers reach a running state within 30s

Given the ator network is up
When `docker compose ps --profile ator` is inspected
Then all 7 services report a healthy state within 90s of startup

Given the ator network is up
When a host process opens a TCP connection to the hs container's SOCKS5 port
Then the connection is accepted

Given the ator network is running
When `make ator-down` is invoked
Then all 7 containers are stopped and removed
And all named volumes for the ator profile are removed

Given the Dockerfile build
When `docker build docker/ator/` is run
Then the anon_0.4.10.0-beta_amd64.deb file is installed
And its SHA-256 matches the value recorded in the ATOR GitHub release

Given `make infra-up`
When run with no arguments
Then the ator profile is included alongside evm, solana, and mina
```

---

### Story 36.2: anyone-client SDK CLI Flag Audit

**Priority:** P1
**Estimate:** 1 point
**Dependencies:** None (independent documentation audit)

#### Description

Audit the actual CLI flag surface of `@anyone-protocol/anyone-client@1.1.3` (the version pinned in Epic 35) against the real binary. Replace every "consult docs.anyone.io — do not guess" hedge in `docs/ator-transport.md` with the verbatim flag and its effect. Pin the flag surface as of the audited SDK version and note it explicitly.

#### Files

- `docs/ator-transport.md` — Installation §Option A and §Option B sections updated
- No source code changes

#### Key Behaviors

- Run `npx anyone-proxy --help` and `npx anyone-client --help` against the installed SDK
- Document every flag operators are likely to need: SOCKS port, control port, data directory, hidden-service config, log level
- Replace all "consult docs.anyone.io" hedges with verified values
- Add a "Flag surface verified against anyone-client@X.Y.Z on YYYY-MM-DD" provenance line

#### Acceptance Criteria

```gherkin
Given docs/ator-transport.md after this story lands
When the file is searched for "consult docs.anyone.io"
Then zero matches are returned

Given docs/ator-transport.md after this story lands
When the file is searched for "do not guess"
Then zero matches are returned

Given docs/ator-transport.md after this story lands
When §Installation Option A.2 is read
Then every flag shown in the example has been verified against `npx anyone-proxy --help` on the pinned SDK version
And a provenance line records the SDK version and audit date

Given an operator following the updated guide
When they run the documented commands verbatim against anyone-client@1.1.3
Then the commands succeed
```

---

### Story 36.3: Real-Binary SOCKS5 Integration Test

**Priority:** P0
**Estimate:** 3 points
**Dependencies:** Story 36.1

#### Description

Add the authoritative integration test that exercises `SocksTransportProvider` against a real `anon v0.4.10.0-beta` circuit. The test runs two connector instances (Alice and Bob), establishes a BTP WebSocket from Alice to Bob through the live ATOR circuit, completes the BTP `auth` exchange, and runs one full application-layer round-trip. As part of the same story, rename the in-process SOCKS5 fixture and test file to make their scope honest.

#### Files

- `packages/connector/test/helpers/in-process-socks5-proxy.ts` — **renamed** to `packages/connector/test/helpers/socks5-contract-fixture.ts`; file-level doc block declares scope ("SOCKS5 protocol contract test, NOT ATOR integration")
- `packages/connector/test/integration/transport-socks5.test.ts` — **renamed** to `packages/connector/test/integration/socks5-contract.test.ts`; file-level doc block updated
- `packages/connector/test/integration/transport-ator-real-binary.test.ts` — **new**
- Updates to any import sites that referenced the old filenames

#### Key Scenarios

| Test ID | Scope |
|---------|-------|
| T-36.3-01 | SocksTransportProvider starts against real network, probe passes |
| T-36.3-02 | Two connectors establish BTP WebSocket through real circuit |
| T-36.3-03 | BTP `auth` request + response completes end-to-end |
| T-36.3-04 | Application-layer round-trip (BTP message + ack) completes |
| T-36.3-05 | BTP frame >= 8KB fragments correctly across multiple cells |
| T-36.3-06 | SocksTransportProvider stops cleanly; no orphan sockets |
| T-36.3-07 | SOCKS5 CONNECT request uses `ATYP=0x03` (DOMAINNAME), verified via tcpdump on loopback |
| T-36.3-08 | Killing the SOCKS container mid-suite triggers fail-closed; provider rejects new connections |
| T-36.3-09 | `socks5://` config path (no `h`) is rejected before any real-binary interaction |

#### Acceptance Criteria

```gherkin
Given `make ator-up` has been run
And ATOR_NIGHTLY=1 is set
When `make ator-test` is invoked
Then transport-ator-real-binary.test.ts runs
And all tests T-36.3-01 through T-36.3-09 pass

Given ATOR_NIGHTLY is unset
When `make test` is invoked
Then transport-ator-real-binary.test.ts is skipped
And the skip reason is logged as "requires ATOR_NIGHTLY=1 and docker compose --profile ator"

Given the renamed files
When the codebase is searched for `in-process-socks5-proxy`
Then zero matches remain (all import sites updated)

Given socks5-contract-fixture.ts
When its file-level doc block is read
Then it explicitly states "SOCKS5 protocol contract test, NOT ATOR integration"

Given T-36.3-07 runs
When the tcpdump capture is parsed
Then the fourth byte of the SOCKS5 CONNECT request is 0x03
And no IPV4 (0x01) or IPV6 (0x04) ATYP value is observed
```

---

### Story 36.4: Hidden-Service + Managed-Client Real-Binary Test

**Priority:** P0
**Estimate:** 3 points
**Dependencies:** Story 36.1, Story 36.3

#### Description

Exercise the managed-`anon` lifecycle (Story 35.5) and `.anon` hidden-service path end-to-end against the real binary. The test configures a connector with `transport.managed: true` and `externalUrl: "auto"`, boots the connector, waits for the HS descriptor to become available in the local network, and verifies that a second connector can reach the first via its `.anon` address. This is the **only** test in the repo that exercises the managed lifecycle against anything real.

#### Files

- `packages/connector/test/integration/transport-ator-hidden-service.test.ts` — new
- `packages/connector/test/fixtures/ator-managed-config.yaml` — new, sample managed-config used by test

#### Key Scenarios

| Test ID | Scope |
|---------|-------|
| T-36.4-01 | ManagedAnonClient starts real `anon` binary; SOCKS port opens within startupTimeoutMs |
| T-36.4-02 | `externalUrl: "auto"` resolves by reading `hs/hostname` file after HS publishes |
| T-36.4-03 | Second connector connects inbound via the resolved `.anon:port` URL |
| T-36.4-04 | No `.anon` hostname appears in any log line at INFO+ during the full run |
| T-36.4-05 | Killing the real `anon` process triggers `managed_anon_crash_detected` event within one health-cache interval |
| T-36.4-06 | ManagedAnonClient.stop() completes within stopTimeoutMs under normal shutdown |
| T-36.4-07 | Hung SDK stop (simulated by SIGSTOP) logs `managed_anon_stop_timeout` and connector shutdown proceeds |
| T-36.4-08 | BTP round-trip through `.anon` rendezvous completes successfully |

#### Acceptance Criteria

```gherkin
Given the ator network is up and ATOR_NIGHTLY=1 is set
When the managed-lifecycle test suite runs
Then tests T-36.4-01 through T-36.4-08 all pass

Given a connector configured with externalUrl: "auto" and managed: true
When the connector starts against the real network
Then the resolved externalUrl matches the pattern `wss://<56-char-base32>.anon:<port>`
And the resolution happens after the HS descriptor is observably published to at least one HSDir

Given the full test suite output is collected
When it is scanned for `.anon` substrings in any structured log field at level >= INFO
Then zero matches are found

Given T-36.4-05 runs
When the real anon process receives SIGKILL
Then within 35s (one health-interval + grace) the structured log contains `event: "managed_anon_crash_detected"`
And `/health` reports `transport.healthy: false`
```

---

### Story 36.5: Nightly CI Workflow + System-Tor Fallback Smoke

**Priority:** P0
**Estimate:** 3 points
**Dependencies:** Stories 36.3, 36.4

#### Description

Add the GitHub Actions workflow that runs the real-binary suite nightly plus on `workflow_dispatch` for transport-touching PRs. Includes a Linux + macOS platform matrix. Adds a system-`tor` fallback smoke test on each platform that verifies `apt-get install tor` (Linux) or `brew install tor` (macOS) produces a SOCKS5 proxy the `SocksTransportProvider` accepts without modification — exercising Epic 35 R-005.

#### Files

- `.github/workflows/nightly-ator.yml` — new
- `packages/connector/test/integration/transport-system-tor-fallback.test.ts` — new (smoke-level, 2–3 scenarios)
- `docs/ator-transport.md` — add Platform Matrix section showing current nightly status per platform

#### Key Scenarios

| Test ID | Scope |
|---------|-------|
| T-36.5-01 | Nightly job runs on ubuntu-latest, pulls ATOR image, executes full 36.3 + 36.4 suite, passes |
| T-36.5-02 | Nightly job runs on macos-14, pulls ATOR image, executes full 36.3 + 36.4 suite, passes |
| T-36.5-03 | System-tor fallback smoke on Linux: `apt-get install tor`, SocksTransportProvider.start() succeeds |
| T-36.5-04 | System-tor fallback smoke on macOS: `brew install tor`, SocksTransportProvider.start() succeeds |
| T-36.5-05 | BTP round-trip through system-tor succeeds (smoke, one test only — no HS, no managed lifecycle) |
| T-36.5-06 | `workflow_dispatch` trigger is invocable from PR UI |

#### Workflow Shape

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
    # ... pull ator image from ghcr.io, docker compose up, make ator-test
  system-tor-fallback:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest
            install: "sudo apt-get install -y tor"
          - os: macos-14
            install: "brew install tor"
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    # ... install tor, start it, run fallback smoke test
```

#### Acceptance Criteria

```gherkin
Given the nightly workflow file is merged
When the cron schedule fires at 04:00 UTC
Then both real-binary jobs (ubuntu-latest, macos-14) execute
And both system-tor-fallback jobs (ubuntu-latest, macos-14) execute

Given at least one nightly run has executed post-merge
When the workflow history is inspected
Then at least one run shows all four jobs green

Given a PR that modifies files under packages/connector/src/transport/
When a maintainer triggers the workflow_dispatch
Then the full matrix runs against the PR branch
And the workflow status becomes a required check before merge

Given the system-tor fallback job
When it installs tor via apt (Linux) or brew (macOS)
And starts it on the default SOCKS port
And runs T-36.5-05
Then a BTP round-trip completes through the system tor proxy
And SocksTransportProvider.start() reports success
```

---

### Story 36.6: Documentation + Deployment-Guide Update

**Priority:** P1
**Estimate:** 1 point
**Dependencies:** Stories 36.1 through 36.5

#### Description

Update `docs/ator-transport.md` to reflect the new verified ground truth: local network topology, pinned binary version, nightly CI status, platform matrix. Remove every remaining hedge. Add a "Verification Status" section linking to the nightly workflow run history. Update the Prerequisites table to differentiate "required for operation" from "required for development (full nightly CI parity)."

#### Files

- `docs/ator-transport.md` — substantive edit
- No source code changes

#### Sections to Add or Update

1. **Verification Status** (new) — ATOR binary version pinned, nightly CI badge, last-green link
2. **Local Development Network** (new) — how to run `make ator-up` for local real-binary testing
3. **Platform Matrix** (new) — Linux / macOS support table with known constraints (arm64, Rosetta)
4. **Prerequisites** (update) — split operational vs development prerequisites
5. **Installation § Option A.2** (update) — flag surface pinned from Story 36.2
6. **Troubleshooting** (update) — add real-binary-specific failure modes surfaced during 36.3/36.4/36.5 development

#### Acceptance Criteria

```gherkin
Given docs/ator-transport.md after this story lands
When the file is searched for "consult docs.anyone.io"
Then zero matches are returned

Given the Verification Status section
When read by a security reviewer
Then it names the pinned ATOR binary version, links to the nightly workflow, and shows last-green date

Given the Platform Matrix section
When read by an operator planning a deployment
Then they can determine whether their platform is covered by nightly CI, fallback-only, or unsupported

Given the Local Development Network section
When followed by a developer
Then they can run `make ator-up` and execute the real-binary suite locally

Given the full guide
When cross-referenced against the source code and test files
Then every file path mentioned exists
And every flag shown works verbatim on anyone-client@1.1.3
```

---

## Epic-Level Acceptance Criteria

These MUST be satisfied at epic close. They are distinct from story-level ACs and are the gate for the epic retrospective.

```gherkin
Given Epic 36 is complete
When the nightly-ator workflow history is inspected
Then at least one run shows all four jobs green against a real ATOR circuit

Given the codebase at epic close
When searched for `in-process-socks5-proxy`
Then zero matches remain
And socks5-contract-fixture.ts exists
And its file-level doc block declares scope as "SOCKS5 protocol contract test, NOT ATOR integration"

Given the Epic 35 retrospective § "Key Remaining Gaps" items #1, #3, #4, #6
When cross-referenced against Epic 36 deliverables
Then each has at least one covering test (by T-ID) OR a pinned doc reference

Given docs/ator-transport.md at epic close
When searched for "consult docs.anyone.io" or "do not guess"
Then zero matches are returned

Given `make test` on a developer workstation without ATOR_NIGHTLY set
When run from a clean checkout
Then the main suite still runs in under its pre-epic-36 wall-clock budget
And real-binary tests are all skipped with a clear reason
```

---

## Dependencies

| Dependency | Version / Source | Epic-36 interaction |
|------------|------------------|---------------------|
| Epic 35 transport abstraction | `epic-35` branch merged at `b18c5735` | Verified, not modified |
| `@anyone-protocol/anyone-client` | 1.1.3 (pinned by Epic 35) | CLI flag surface audited (Story 36.2); no version bump |
| ATOR binary (`anon`) | **v0.4.10.0-beta** (pinned) | Installed via `.deb` in local network image |
| Docker + docker compose | v20.10+ (already required by `anvil` / `solana` / `mina` profiles) | New `ator` profile added |
| GitHub Actions | ubuntu-latest, macos-14 runners | Nightly workflow |
| system `tor` (fallback) | Linux: apt default; macOS: brew latest | Fallback smoke test |

---

## Out of Scope

Explicitly deferred to future epics or accepted as permanent out-of-scope:

- **Windows ATOR testing.** WSL2 would be the only viable path; no team members run Windows as a primary dev or deploy platform. Operators who deploy on Windows follow the Linux guide inside WSL2 at their own risk — not a gate on Epic 36.
- **ATOR mainnet integration testing.** The pinned-version local network is authoritative. Mainnet compatibility is verified manually when the ATOR pin bumps to a new stable, not on every commit.
- **Long-running stability / soak tests.** Circuit churn over hours / days is not in scope. The nightly suite is functional verification, not a 24h endurance run.
- **Performance regression baselines against real circuits.** Latency is documented (§Performance Characteristics) but not enforced as a CI gate. Real circuits are too variable under CI load for a useful regression threshold.
- **ATOR binary signing / supply-chain attestation beyond SHA-256 pinning.** `.deb` checksum verification is the floor; SLSA-style attestation of the ATOR release is upstream ATOR's concern, not this epic's.
- **Fixing any bugs found in Epic 35 code paths during real-binary verification.** If real-binary testing surfaces a latent Epic 35 bug, the bug is filed against a follow-up epic unless it is a one-line blocker that makes the verification suite un-landable.
- **Source code changes to `SocksTransportProvider`, `ManagedAnonClient`, or any transport-layer code.** Epic 36 is pure verification; any code change needed to make the verification suite pass is a red flag — file an issue, do not slip in a feature change.
- **Rewriting the Zod-migration debt called out in Epic 35 retro item #9.** Config validation remains hand-rolled. That is a separate process decision carried forward.

---

## Definition of Done

- [ ] `make ator-up` / `ator-down` / `ator-logs` / `ator-test` targets exist and work on ubuntu-latest and macos-14
- [ ] `docker-compose.yml` `ator` profile stands up 3 DirAuth + 3 relay + 1 HS, all based on pinned `anon v0.4.10.0-beta` image
- [ ] `make infra-up` / `infra-down` include the `ator` profile
- [ ] In-process SOCKS5 fixture renamed to `socks5-contract-fixture.ts`; test file renamed to `socks5-contract.test.ts`; all import sites updated
- [ ] Real-binary integration test (36.3) exists and passes against `make ator-up` network
- [ ] Hidden-service + managed-client real-binary test (36.4) exists and passes
- [ ] System-`tor` fallback smoke (36.5) exists and passes on Linux + macOS
- [ ] `.github/workflows/nightly-ator.yml` exists; cron + `workflow_dispatch` triggers configured
- [ ] At least one nightly run has completed green against real ATOR circuits post-merge
- [ ] `anyone-client` CLI flag audit (36.2) reflected verbatim in `docs/ator-transport.md`
- [ ] Every "consult docs.anyone.io" / "do not guess" hedge removed from `docs/ator-transport.md`
- [ ] Platform Matrix and Verification Status sections added to `docs/ator-transport.md`
- [ ] `make test` (without `ATOR_NIGHTLY=1`) runtime unchanged from pre-epic-36 baseline
- [ ] `.anon` addresses from the real test HS do not appear in any CI log at INFO+
- [ ] Every Epic 35 §Known Gaps item #1/#3/#4/#6 has a covering T-36.* test or pinned doc reference
- [ ] Code passes ESLint, Prettier, TypeScript strict; full test suite (incl. renamed contract tests) green
- [ ] Test coverage thresholds unchanged (branches 60%, functions 75%, lines 70%, statements 70%)
- [ ] Existing Epic 35 test suite passes without modification other than the renames

---

## Estimated Total Effort

| Story | Points | Description |
|-------|--------|-------------|
| 36.1 | 3 | Local ATOR network image + docker-compose profile + make targets |
| 36.2 | 1 | anyone-client CLI flag audit, docs hedges removed |
| 36.3 | 3 | Real-binary SOCKS5 integration test + in-process fixture rename |
| 36.4 | 3 | Hidden-service + managed-client real-binary test |
| 36.5 | 3 | Nightly CI workflow + system-tor fallback smoke |
| 36.6 | 1 | Docs + deployment-guide update |
| **Total** | **14** |

---

## Open Questions

The five architectural decisions listed in the epic brief are locked in and not re-opened here. Remaining questions that are genuine open items (to be resolved during story work, not planning):

1. **Image hosting:** `ghcr.io/anyone-protocol/` mirror vs self-hosted in the TOON org. Lean toward self-hosted for supply-chain independence but depends on org package quota.
2. **HSDir bootstrap wait strategy:** poll `hs/hostname` file vs poll descriptor via control port vs fixed sleep. Lean toward poll-with-backoff on the hostname file; control-port access adds surface area.
3. **Rosetta vs native arm64 on macos-14:** If ATOR ships only amd64 `.deb`, acceptable latency penalty under Rosetta needs a short empirical check during Story 36.1.
4. **Log-volume redirection specifics:** per-container files vs stdout-to-artifact vs in-test capture buffer. Lean toward per-container files surfaced as CI artifacts only on failure.
5. **Cache invalidation on upstream `.deb` churn:** if ATOR republishes `v0.4.10.0-beta` with a new checksum (it has happened with beta tags upstream), our mirror should refuse the bump and force a human-reviewed pin bump rather than silently follow.
