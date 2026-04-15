---
stepsCompleted:
  [
    'step-01-preflight-and-context',
    'step-02-generation-mode',
    'step-03-test-strategy',
    'step-04-generate-tests',
    'step-05-validate-and-complete',
  ]
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-04-15'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/36-1-local-ator-network-image-docker-compose.md'
  - '_bmad-output/planning-artifacts/epic-36-real-binary-ator-verification.md'
  - '_bmad-output/planning-artifacts/test-design-epic-36.md'
  - 'packages/connector/test/acceptance/story-33-9-solana-local-dev-infra.test.ts'
  - 'packages/connector/test/acceptance/story-34-10-mina-local-dev-infra.test.ts'
  - 'packages/connector/jest.acceptance.config.js'
  - 'docker-compose.yml'
  - 'Makefile'
  - 'CHANGELOG.md'
---

# ATDD Checklist — Epic 36, Story 36.1: Local ATOR Network Image + docker-compose Profile

**Date:** 2026-04-15
**Author:** Jonathan
**Primary Test Level:** Acceptance (static-asset assertions on docker/ator/ tree, docker-compose.yml ator profile, Makefile targets, CHANGELOG). Mode: **YOLO**.

---

## Story Summary

Story 36.1 delivers the **real-binary ATOR test substrate** that unblocks Stories 36.3/36.4/36.5. It introduces:

- A new `docker/ator/` tree (`Dockerfile`, `checksums.txt`, `entrypoint.sh`, three `torrc.*` templates) that builds a pinned `ator-testnet:v0.4.10.0-beta` image from the upstream `anon` Debian package with SHA-256 verification.
- A 7-service `ator` profile in `docker-compose.yml` (3 DirAuth + 3 relay + 1 HS node) on an internal-only `ator_net` bridge network, with a single host exposure for hs1's SOCKS5 listener on `127.0.0.1:9150`.
- Four new `Makefile` targets (`ator-up`, `ator-down`, `ator-logs`, `ator-test`) plus `infra-up` / `infra-down` extension and `help` text update.
- A one-line `CHANGELOG.md` Unreleased entry.

**As a** connector developer and nightly-CI maintainer,
**I want** a local ATOR network packaged as a docker-compose `ator` profile plus `make ator-*` targets,
**so that** Stories 36.3–36.5 have a deterministic real-binary substrate and developers can bring up the whole network with one command.

**Scope bright-line (AC 13):** Zero changes to `packages/connector/src/`, zero changes to `packages/connector/test/integration/`, zero changes to `docs/ator-transport.md`. The **only** production-surface test files permitted are new **acceptance**-level static-asset assertions (the precedent established by Stories 33.9 and 34.10).

---

## Acceptance Criteria

Full AC text lives in the story file. Summary (14 ACs, numbered 1–14 with AC 13 acting as the scope bright-line; note the story skips "AC 13" between AC 12 and AC 14 in table order but text numbering stays 1–14):

1. **AC 1:** docker-compose.yml ator profile — exactly 7 services, all on `ator-testnet:v0.4.10.0-beta` (pinned), each with `profiles: [ator]` and role-appropriate healthcheck.
2. **AC 2:** Dockerfile based on `debian:bookworm-slim`, downloads the pinned `anon` `.deb`, verifies SHA-256 via `sha256sum -c` (hard fail), image < 200 MB.
3. **AC 3:** `entrypoint.sh` dispatches on `ANON_ROLE`, renders the right torrc via `envsubst`, forwards SIGTERM/SIGINT, exits 64 on unknown role.
4. **AC 4:** DirAuth quorum — `V3AuthVotingInterval=20s`, `TestingTorNetwork=1`, deterministic identity keys from `IDENTITY_SEED` cached in a named volume, consensus published within 60s.
5. **AC 5:** Relays — `ExitPolicy accept *:*` on internal-only network, `ORPort 9001`, `DirPort 9030`, sane `BandwidthRate`/`Burst`, visible in consensus within 90s.
6. **AC 6:** hs1 — HS + client (SOCKS5:9050) + relay roles combined, host binding `127.0.0.1:${ATOR_HS_SOCKS_PORT:-9150}:9050`, hostname file populated within 120s.
7. **AC 7:** `make ator-up/down/logs/test` targets; `ator-down` uses `-v`; `ator-test` derives `ATOR_SOCKS_PORT` from `docker compose port hs1 9050` and calls jest with `--passWithNoTests`.
8. **AC 8:** Clean teardown — zero residual containers/volumes/networks after `ator-down`.
9. **AC 9:** `infra-up` / `infra-down` include the `ator` profile; `infra-down` does **not** pass `-v` (preserves existing semantics).
10. **AC 10:** `make help` updated.
11. **AC 11:** No `privileged: true`, no host ports below 1024, internal-only network, only hs1 exposes a host port.
12. **AC 12:** `docker/ator/checksums.txt` — amd64 entry, arm64 handled explicitly (line or comment), provenance + source-URL comments, `sha256sum -c` compatible format.
13. **AC 13:** Docs-pointer reserved for Story 36.6 — no `docs/ator-transport.md`, no `packages/connector/src/`, no `packages/connector/test/integration/` changes. CHANGELOG gets one Unreleased line.
14. **AC 14:** Multi-arch explicit — `TARGETARCH` branch for amd64/arm64; arm64 build fails fast if no upstream `.deb`; Apple-Silicon `--platform linux/amd64` documented.

---

## ATDD Determination: Precedent-Driven Test-Level Selection

Story 36.1 is a **local-development infrastructure** story. Its direct analogs in the repo are Stories 33.9 (Solana local dev infra) and 34.10 (Mina local dev infra), both of which placed their acceptance tests at the **acceptance** level in `packages/connector/test/acceptance/story-XX-Y-*.test.ts` as static-asset YAML + Makefile + docs assertions. I mirror that pattern exactly.

**Why not E2E / integration?**

- AC 13 explicitly forbids changes to `packages/connector/test/integration/`. Integration tests are the 36.3/36.4 deliverables.
- AC 7's `ator-test` target itself uses `--passWithNoTests` precisely so no jest tests are added in this story; the green-phase for 36.1 lives in shell-level lifecycle smokes.
- The story's **Testing Standards Summary** is explicit: "The integration smokes are *not* jest tests — they are shell-level assertions that the story author runs before marking the story done."

**Why acceptance-level static assertions _are_ valid here:**

- AC 1, AC 2, AC 3, AC 7, AC 9, AC 10, AC 11, AC 12, AC 14 — **all statically verifiable** from the committed source: `docker-compose.yml`, `docker/ator/Dockerfile`, `docker/ator/checksums.txt`, `docker/ator/entrypoint.sh`, torrc templates, `Makefile`, `CHANGELOG.md`.
- AC 4 / AC 5 / AC 6's **structural** requirements (torrc keys, port numbers, healthcheck presence, internal network) are static; only their **runtime** requirements (consensus ready within 60s, relays visible within 90s, hostname within 120s, teardown-with-no-residue) are shell-level manual.
- AC 13's CHANGELOG + bright-line non-modification can be asserted.

The lifecycle smokes (AC 4 timing, AC 5 timing, AC 6 timing, AC 7 `ator-up` ≤ 30s, AC 8 teardown hygiene) remain shell-level manual per the story. They are reproducibly performed by the dev as part of task completion. This checklist documents them as validation procedures, not jest assertions.

---

## Acceptance Criteria Coverage

| AC   | Nature                   | Coverage in `story-36-1-ator-local-network.test.ts`                                                                                          | Shell-level validation (dev runs manually) |
| ---- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1    | Static (compose)         | ✅ 7 services present, pinned image, `profiles: [ator]`, healthchecks, named volumes, per-role env vars                                      | `docker compose --profile ator config` renders |
| 2    | Static (Dockerfile)      | ✅ debian:bookworm-slim FROM, `ARG TARGETARCH`, upstream URL, `sha256sum -c`, no `echo …` anti-pattern, apt clean, COPY entrypoint + torrcs | `docker build` smoke; `anon --version` prints `0.4.10.0-beta` |
| 3    | Static (entrypoint.sh)   | ✅ shebang, strict mode, role dispatch, `envsubst`, `exec anon`, SIGTERM/SIGINT trap, `exit 64` on unknown role                              | Role dispatch end-to-end in live container |
| 4    | Static + Runtime         | ✅ Static: torrc.dirauth has `V3AuthVotingInterval 20`, `TestingTorNetwork 1`, `AuthoritativeDirectory`, `V3AuthoritativeDirectory`, DirAuthority | Runtime: `docker exec dirauth1 cat /var/lib/anon/cached-consensus*` non-empty within 60s |
| 5    | Static + Runtime         | ✅ Static: torrc.relay has `ORPort 9001`, `DirPort 9030`, `ExitRelay 1`, `ExitPolicy accept *:*`, `BandwidthRate`, `BandwidthBurst`           | Runtime: relays visible in consensus within 90s |
| 6    | Static + Runtime         | ✅ Static: torrc.hs has `SOCKSPort 9050`, `HiddenServiceDir`, `HiddenServicePort 5000 127.0.0.1:5000`, `ORPort` (combined role); hs1 compose binds `127.0.0.1:9150:9050` | Runtime: `/var/lib/anon/hs/hostname` populated within 120s |
| 7    | Static (Makefile)        | ✅ `ator-up`, `ator-down -v`, `ator-logs -f`, `ator-test` with `ATOR_NIGHTLY=1`, `ATOR_SOCKS_PORT` derived via `docker compose port hs1 9050`, fail-fast on empty port, `--passWithNoTests` | Live `make ator-up && make ator-test` exit 0 |
| 8    | Runtime                  | — (shell-level only)                                                                                                                         | `make ator-up && make ator-down` → zero containers/volumes/networks |
| 9    | Static (Makefile)        | ✅ `infra-up` has all four `--profile` flags; `infra-down` has all four but **no** `-v`                                                       | Live `make infra-up` starts all four stacks |
| 10   | Static (Makefile)        | ✅ `help` mentions `ator-up`, `ator-down`, `ator-logs`, `ator-test`, and ATOR in All-Chains section                                           | `make help` visually clean                 |
| 11   | Static (compose)         | ✅ No `privileged: true` in ator services; all host bindings ≥ 1024; only hs1 exposes a port; `ator_net` has `internal: true`; all ator services on `ator_net`; cross-profile port disjointness | n/a                                        |
| 12   | Static (checksums.txt)   | ✅ File exists; source URL comment; provenance `# Verified against upstream release on YYYY-MM-DD`; amd64 entry in sha256sum -c format; arm64 handled; strict line format | n/a                                        |
| 13   | Static + regression      | ✅ CHANGELOG Unreleased references Story 36.1; no leak filenames under `packages/connector/src/`; pre-existing evm/solana/mina services preserved | Dev diff check: only permitted files changed |
| 14   | Static (Dockerfile)      | ✅ Dockerfile mentions `TARGETARCH`, `amd64`, `arm64`                                                                                         | `docker build --platform linux/arm64` smoke (may fail fast per AC 14) |

---

## Failing Tests Created (RED Phase)

### Acceptance Tests (126 tests)

**File:** `packages/connector/test/acceptance/story-36-1-ator-local-network.test.ts` (~810 lines, 126 tests across 16 `describe` blocks)

Each `describe` maps to one or more ACs:

- **AC 2** — `docker/ator/Dockerfile — pinned .deb with SHA-256 verification` (11 tests)
- **AC 12** — `docker/ator/checksums.txt — provenance + sha256sum -c compatible` (7 tests)
- **AC 3** — `docker/ator/entrypoint.sh — role dispatch + signal forwarding` (8 tests)
- **AC 3** — `torrc templates — one per role` (4 tests)
- **AC 4** — `torrc.dirauth — DirAuth quorum configuration` (7 tests)
- **AC 5** — `torrc.relay — mixed guard/middle/exit on internal network` (5 tests)
- **AC 6** — `torrc.hs — hidden service + client + relay` (4 tests)
- **AC 1** — `docker-compose.yml ator profile — 7 services, pinned image` (49 tests, many table-driven via `it.each`)
- **AC 6 / AC 11** — `hs1 host exposure + port hygiene` (5 tests)
- **AC 5** — `dependency ordering: relays depend on dirauths; hs1 depends on relays` (4 tests)
- **AC 11** — `ator port bindings do not collide with evm/solana/mina` (1 test)
- **AC 7** — `Makefile ator-up / ator-down / ator-logs / ator-test targets` (8 tests)
- **AC 9** — `infra-up / infra-down include --profile ator` (2 tests)
- **AC 10** — `make help lists the new ATOR targets` (5 tests)
- **AC 9** — `pre-existing profiles unchanged (regression)` (4 tests, table-driven)
- **AC 13** — `CHANGELOG + scope bright-line` (2 tests)
- **AC 14** — `multi-arch posture is explicit in Dockerfile` (1 test)

All 126 tests are authored against state that **does not yet exist** in the repo (`docker/ator/` tree absent, ator-profile services absent in compose, `ator-*` make targets absent, CHANGELOG Unreleased entry absent). They fail for the **right reason** (missing implementation), not for test-construction bugs. Verified by running the suite against the current tree — see "Initial Test Run" below.

### Integration / Shell-Level Tests

**None created in this story.** Per story Testing Standards + AC 13 bright-line, the shell-level lifecycle smokes live in the dev's manual validation checklist below, and the jest-level real-binary suites arrive in Stories 36.3 (SOCKS5) and 36.4 (HS + managed client).

---

## Shell-Level Validation Checklist (Dev runs before marking story done)

These map to the Integration Smoke and Lifecycle Smoke items from the story's Testing Standards Summary. None are automated in this story.

### Build smoke (AC 2, AC 14)

- [ ] `docker build --platform linux/amd64 -t ator-testnet:v0.4.10.0-beta docker/ator/` → exit 0
- [ ] `docker run --rm --platform linux/amd64 ator-testnet:v0.4.10.0-beta anon --version` → stdout contains `0.4.10.0-beta`
- [ ] `docker image inspect ator-testnet:v0.4.10.0-beta --format '{{.Size}}'` → < 200 MB
- [ ] `docker build --platform linux/arm64 -t ator-testnet:v0.4.10.0-beta docker/ator/` → exit 0 **if** arm64 `.deb` published upstream, else fails fast with clear error referencing `checksums.txt` (not silent skip)

### Lifecycle smoke (AC 7, AC 4, AC 5, AC 6)

- [ ] `make ator-up` → exit 0 within 30s
- [ ] Within 60s of `ator-up`: `docker exec dirauth1 ls -la /var/lib/anon/ | grep -i consensus` shows a non-empty `cached-consensus*` file **and/or** `docker compose --profile ator logs dirauth1 | grep -iE 'consensus published|successfully opened a circuit'` matches (record the exact matched pattern in Completion Notes)
- [ ] Within 90s of `ator-up`: `docker exec dirauth1 cat /var/lib/anon/cached-consensus*` (verify exact filename) contains `r relay1`, `r relay2`, `r relay3` lines
- [ ] Within 120s of `ator-up`: `docker exec hs1 cat /var/lib/anon/hs/hostname` returns a 56-char base32 string. Record the observed TLD (`.anon` vs `.onion`) in Completion Notes
- [ ] `docker compose port hs1 9050` returns `127.0.0.1:9150` (or the `ATOR_HS_SOCKS_PORT` override)
- [ ] From host: `nc -z 127.0.0.1 9150` → success

### Teardown hygiene (AC 8, AC 11)

- [ ] `make ator-down` → exit 0
- [ ] `docker compose --profile ator ps -a --format json` → `[]`
- [ ] `docker volume ls --filter label=com.docker.compose.project=$(docker compose config --format json | jq -r .name) --filter label=com.docker.compose.project.profile=ator` → 0 volumes (or equivalent query given compose label semantics)
- [ ] `docker network ls --filter name=ator_net` → 0 networks
- [ ] Static `grep -n 'privileged' docker-compose.yml` → no match in any ator service block

### `make ator-test` smoke (AC 7)

- [ ] `make ator-up && make ator-test` → exit 0 with "no tests found" (expected until 36.3 lands)
- [ ] `make ator-test` run **without** prior `ator-up` → exits non-zero with "run `make ator-up` first"

---

## Data Factories Created

**None.** Story 36.1 introduces pure static-assertion tests against committed YAML / Dockerfile / Makefile content. No runtime entities exist to fake.

---

## Fixtures Created

**None.** No Playwright / Jest fixtures needed — the test file uses `describe` + `beforeAll(() => loadFileContent(...))` per the precedent in 33.9 / 34.10.

---

## Mock Requirements

**None.** No external services are exercised. The Docker daemon is never invoked by the jest suite.

---

## Required data-testid Attributes

**N/A.** No UI.

---

## Implementation Checklist

The story's Tasks 1–7 are already a precise implementation roadmap. The checklist below maps each failing test family to the task(s) that will green it.

### Test family: AC 2 (Dockerfile) → 11 tests

**Tasks to green:**

- [ ] Task 1.1 — Create `docker/ator/` directory
- [ ] Task 1.2 — Write multi-arch `Dockerfile` on `debian:bookworm-slim` with `ARG TARGETARCH` and `sha256sum -c` hard-fail verification
- [ ] Task 1.3 — Install runtime deps (`libevent-2.1-7`, `ca-certificates`, `libssl3`, `gettext-base` for `envsubst`)
- [ ] Task 1.4 — Purge build tools, `apt-get clean`, `rm -rf /var/lib/apt/lists/*`
- [ ] Run: `cd packages/connector && npx jest --config jest.acceptance.config.js test/acceptance/story-36-1-ator-local-network.test.ts -t 'AC 2'` → all green
- [ ] ✅ AC 2 complete

**Estimated effort:** ~3h

### Test family: AC 12 (checksums.txt) → 7 tests

**Tasks to green:**

- [ ] Task 1.5 — Author `docker/ator/checksums.txt` with amd64 SHA-256 recorded from the ATOR GitHub release page
- [ ] Task 1.6 — Record provenance comment (`# Verified against upstream release on YYYY-MM-DD`) and source URL pattern
- [ ] Handle arm64: if published, add the checksum line; if not, add the `R-36-03`-tagged comment gap note
- [ ] Run: `...-t 'AC 12'` → all green
- [ ] ✅ AC 12 complete

**Estimated effort:** ~1h (most time: confirming exact upstream filename + SHA)

### Test family: AC 3 (entrypoint + torrc template presence) → 12 tests

**Tasks to green:**

- [ ] Task 2.1 — Author `docker/ator/torrc.dirauth`
- [ ] Task 2.2 — Author `docker/ator/torrc.relay`
- [ ] Task 2.3 — Author `docker/ator/torrc.hs`
- [ ] Task 3.1 — Author `docker/ator/entrypoint.sh` with `set -eu` + role dispatch
- [ ] Task 3.2 — Use `envsubst < /etc/anon/torrc.$ANON_ROLE.tmpl > /etc/anon/torrc`, then `exec anon -f /etc/anon/torrc`
- [ ] Task 3.3 — Signal trap (mirror `infra/solana/entrypoint.sh`)
- [ ] Task 3.5 — `exit 64` on unknown role
- [ ] Run: `...-t 'AC 3'` → all green
- [ ] ✅ AC 3 complete

**Estimated effort:** ~3h

### Test family: AC 4 (torrc.dirauth keys) → 7 tests

**Tasks to green:**

- [ ] Task 2.1 — torrc.dirauth has `V3AuthVotingInterval 20`, `TestingTorNetwork 1`, `AuthoritativeDirectory 1`, `V3AuthoritativeDirectory 1`, `ORPort`, `DirPort`, `ControlPort`, `DirAuthority` lines
- [ ] Task 3.4 — Identity-key minting from `IDENTITY_SEED` on empty volume
- [ ] Run: `...-t 'AC 4'` → all green
- [ ] Shell smoke: consensus within 60s
- [ ] ✅ AC 4 complete

**Estimated effort:** ~3h (dirauth voting config is the trickiest part)

### Test family: AC 5 (torrc.relay + dependency ordering) → 9 tests

**Tasks to green:**

- [ ] Task 2.2 — `ORPort 9001`, `DirPort 9030`, `ExitRelay 1`, `ExitPolicy accept *:*`, `BandwidthRate`, `BandwidthBurst`
- [ ] Task 4.7 — Relays depend_on dirauths; hs1 depends_on relays
- [ ] Run: `...-t 'AC 5'` → all green
- [ ] Shell smoke: relays visible in consensus within 90s
- [ ] ✅ AC 5 complete

**Estimated effort:** ~1.5h

### Test family: AC 6 + AC 11 (torrc.hs + hs1 exposure + privilege invariants) → 9 tests

**Tasks to green:**

- [ ] Task 2.3 — `SOCKSPort 9050`, `HiddenServiceDir`, `HiddenServicePort 5000 127.0.0.1:5000`, combined `ORPort`
- [ ] Task 4.5 — `ator_net` bridge with `internal: true`
- [ ] Task 4.6 — hs1 exposes `127.0.0.1:${ATOR_HS_SOCKS_PORT:-9150}:9050`
- [ ] Run: `...-t 'AC 6'` and `...-t 'AC 11'` → all green
- [ ] Shell smoke: hostname within 120s; `nc -z 127.0.0.1 9150` succeeds
- [ ] ✅ AC 6 + AC 11 complete

**Estimated effort:** ~2h

### Test family: AC 1 (compose profile services) → 49 tests

**Tasks to green:**

- [ ] Task 4.1 — Seven service blocks using `&anon-base` YAML anchor
- [ ] Task 4.2 — Per-service environment (`ANON_ROLE`, `NICKNAME`, `ORPORT`, `DIRPORT`, `CONTROL_PORT` where applicable, per-service unique `IDENTITY_SEED` on dirauths)
- [ ] Task 4.3 — Named `/var/lib/anon` volumes
- [ ] Task 4.4 — Role-appropriate healthchecks
- [ ] Task 4.5 — Attach all seven services to `ator_net`
- [ ] Run: `...-t 'docker-compose.yml ator profile'` → all green
- [ ] ✅ AC 1 complete

**Estimated effort:** ~4h (compose authoring dominates)

### Test family: AC 7 + AC 9 + AC 10 (Makefile) → 15 tests

**Tasks to green:**

- [ ] Task 5.1–5.4 — `ator-up`, `ator-down -v`, `ator-logs -f`, `ator-test` with `ATOR_NIGHTLY=1`, `ATOR_SOCKS_PORT` derivation, fail-fast, `--passWithNoTests`
- [ ] Task 5.6 — `infra-up` + `infra-down` append `--profile ator` (no `-v` on infra-down)
- [ ] Task 5.7 — `help` text updated
- [ ] Task 5.1 — `.PHONY` registrations
- [ ] Run: `...-t 'Makefile'` and `...-t 'infra-up'` and `...-t 'help'` → all green
- [ ] Shell smoke: dry-run `make -n ator-up ator-down ator-logs ator-test infra-up infra-down help`
- [ ] ✅ AC 7 + AC 9 + AC 10 complete

**Estimated effort:** ~2h

### Test family: AC 13 + AC 14 (CHANGELOG + multi-arch + regression) → 7 tests

**Tasks to green:**

- [ ] Task 7.1 — Add one-line `## [Unreleased]` entry referencing Story 36.1
- [ ] Confirm `TARGETARCH`, `amd64`, `arm64` tokens in Dockerfile (covered by Task 1.2)
- [ ] Regression: do not touch anvil / faucet / solana-validator / mina-lightnet service definitions
- [ ] Task 7.3 — Verify `git diff` against `packages/connector/src/`, `docs/ator-transport.md`, `packages/connector/test/integration/` is empty
- [ ] Run: `...-t 'AC 13'` and `...-t 'AC 14'` and `...-t 'pre-existing profiles unchanged'` → all green
- [ ] ✅ AC 13 + AC 14 complete

**Estimated effort:** ~0.5h

**Total estimated effort:** ~20h engineering (~1.5–2 dev days), matching the story's 3-point estimate.

---

## Running Tests

```bash
# Run only Story 36.1 acceptance tests (this file)
cd packages/connector && npx jest --config jest.acceptance.config.js test/acceptance/story-36-1-ator-local-network.test.ts

# Run all acceptance tests (includes this file + 33.9 / 34.10 / etc.)
cd packages/connector && npm run test:acceptance

# Run a single AC family (e.g. AC 2 Dockerfile assertions)
cd packages/connector && npx jest --config jest.acceptance.config.js test/acceptance/story-36-1-ator-local-network.test.ts -t 'AC 2'

# Story-authoring workflow — after each task:
cd packages/connector && npx jest --config jest.acceptance.config.js test/acceptance/story-36-1-ator-local-network.test.ts
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete) ✅

- ✅ 126 failing tests authored in `packages/connector/test/acceptance/story-36-1-ator-local-network.test.ts`
- ✅ Tests fail for the right reason (missing `docker/ator/` tree, missing ator-profile services, missing Makefile targets, missing CHANGELOG entry) — not test bugs
- ✅ TypeScript compile-clean (verified via `npx jest --config jest.acceptance.config.js test/acceptance/story-36-1-ator-local-network.test.ts`)
- ✅ Precedent followed: identical structure to 33.9 / 34.10 acceptance tests

**Verification (see "Initial Test Run" below):**

- Suite runs in ~1.3s (pure static assertions, no IO beyond filesystem reads)
- 114 fail (assert against missing state), 12 pass (regression guards for unchanged pre-existing profile services + cross-profile port-disjointness trivially satisfied since no ator ports exist yet)

### GREEN Phase (DEV Team — Next Steps)

1. Pick one test family (start with AC 2 — Dockerfile, smallest blast radius)
2. Implement minimum to pass (`docker/ator/Dockerfile` + `checksums.txt`)
3. Run `npx jest ... -t 'AC 2'` → confirm family goes green
4. Move to next family in the order suggested by the implementation checklist
5. Run all shell-level smokes from the "Shell-Level Validation Checklist" section after the compose profile lands (AC 1 green)

### REFACTOR Phase

- After all 126 tests green + all shell-level smokes pass, run `make test` at repo root to confirm no regression in the pre-existing suite
- Confirm `git diff` against `packages/connector/src/`, `docs/ator-transport.md`, `packages/connector/test/integration/` is empty (AC 13 bright-line)
- Mark `sprint-status.yaml` Story 36.1 status → `done`

---

## Next Steps

1. Hand this checklist + the failing test file to the dev workflow (manual handoff, matches 33.9 / 34.10 pipeline)
2. Begin implementation using the per-family checklist above
3. After AC 2 green → AC 12 green → continue in listed order
4. After all families green, run shell-level smokes
5. After shell smokes green, update sprint-status.yaml (Task 7.2)

---

## Knowledge Base References Applied

| Fragment                      | Applied to Story 36.1?                                                       |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `data-factories.md`           | N/A — no runtime data in scope                                               |
| `component-tdd.md`            | N/A — no UI                                                                  |
| `test-quality.md`             | ✅ Deterministic (no timing-dependent assertions); one assertion per `it()`; Given-When-Then implicit in `describe` / `it` names; isolation via independent regex / YAML parse |
| `test-healing-patterns.md`    | ✅ Exact-string anchors (e.g. `ator-testnet:v0.4.10.0-beta`) + structured YAML parse (not fragile line-grep) — resists cosmetic reformatting |
| `test-levels-framework.md`    | ✅ Level chosen: **Acceptance** (static-asset assertions), per 33.9 / 34.10 precedent for local-dev-infra stories |
| `test-priorities-matrix.md`   | ✅ All 126 tests map to P0 ACs (foundation story; blocks 36.3 / 36.4 / 36.5)  |
| `ci-burn-in.md`               | N/A this story (CI wiring lands in 36.5)                                     |

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:**

```bash
cd packages/connector && npx jest --config jest.acceptance.config.js \
  test/acceptance/story-36-1-ator-local-network.test.ts
```

**Results:**

```
Test Suites: 1 failed, 1 total
Tests:       114 failed, 12 passed, 126 total
Snapshots:   0 total
Time:        ~1.3 s
```

**Summary:**

- Total tests: 126
- Passing: 12 (regression guards — pre-existing evm/solana/mina services unchanged; cross-profile port-disjointness trivially true because no ator ports exist yet)
- Failing: 114 (all against missing state — `docker/ator/` absent, ator profile services absent, ator-\* Make targets absent, CHANGELOG entry absent)
- Status: ✅ RED phase verified — tests fail for the right reason

**Sample failure messages (representative):**

- `ENOENT: no such file or directory, open '…/docker/ator/Dockerfile'` — AC 2, AC 3, AC 14 families
- `ENOENT: no such file or directory, open '…/docker/ator/checksums.txt'` — AC 12 family
- `expect(received).toBeDefined()  // getService(compose, 'dirauth1')` — AC 1 family
- `expect(received).toMatch(/^ator-up:[\s\S]*?docker\s+compose\s+--profile\s+ator\s+up\s+-d/m)` (received: existing Makefile, no ator targets) — AC 7 family
- `expect(unreleased).toMatch(/36\.1|Story\s+36\.1|ator.*local.*network|local ATOR/i)` (received: current Unreleased section has no 36.1 line) — AC 13 family

All failures are **missing-state** failures. None are test-authoring bugs.

---

## Notes

- **Precedent alignment:** This checklist and the test file are structurally a copy-and-adapt of `atdd-checklist-34-10.md` + `story-34-10-mina-local-dev-infra.test.ts`. The same pattern previously shipped 33.9 (Solana infra) and 34.10 (Mina infra). 36.1 is the ATOR/Tor analog.
- **AC 13 bright-line compliance:** the only files this ATDD workflow creates / modifies are (a) the new test file `packages/connector/test/acceptance/story-36-1-ator-local-network.test.ts` (permitted — `test/acceptance/` is NOT the forbidden `test/integration/`), and (b) this checklist at `_bmad-output/test-artifacts/atdd-checklist-36-1.md` (permitted — `_bmad-output/` is permitted per Task 7.3). No `packages/connector/src/`, no `docs/ator-transport.md`, no `test/integration/`, no `docker-compose.yml`, no `Makefile`, no `CHANGELOG.md` changes.
- **Runtime gaps left for dev's shell checklist:** AC 4 (consensus within 60s), AC 5 (relays visible within 90s), AC 6 (hostname within 120s), AC 7 (`ator-up` ≤ 30s), AC 8 (teardown residue) — all shell-level, as the story explicitly specifies.
- **Epic 35 frozen surface untouched:** by construction this story cannot regress 35.x behaviour — no `packages/connector/src/` changes.

---

## Contact

- **Story file:** `_bmad-output/implementation-artifacts/36-1-local-ator-network-image-docker-compose.md`
- **Epic:** `_bmad-output/planning-artifacts/epic-36-real-binary-ator-verification.md`
- **Test design:** `_bmad-output/planning-artifacts/test-design-epic-36.md` (T-36.1-01 … T-36.1-08)
- **Precedent:** `_bmad-output/test-artifacts/atdd-checklist-34-10.md`, `_bmad-output/test-artifacts/atdd-checklist-33-9.md`

---

**Generated by BMAD TEA Agent (atdd workflow, YOLO mode)** — 2026-04-15
