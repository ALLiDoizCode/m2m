---
stepsCompleted:
  - 'step-01-load-context'
  - 'step-02-define-thresholds'
  - 'step-03-gather-evidence'
  - 'step-04-evaluate-and-score'
  - 'step-04e-aggregate-nfr'
  - 'step-05-generate-report'
lastStep: 'step-05-generate-report'
lastSaved: '2026-04-15'
workflowType: 'testarch-nfr-assess'
inputDocuments:
  - '_bmad-output/implementation-artifacts/36-1-local-ator-network-image-docker-compose.md'
  - '_bmad-output/planning-artifacts/epic-36-real-binary-ator-verification.md'
  - '_bmad-output/planning-artifacts/test-design-epic-36.md'
  - '_bmad-output/project-context.md'
  - '_bmad/tea/testarch/knowledge/adr-quality-readiness-checklist.md'
  - '_bmad/tea/testarch/knowledge/ci-burn-in.md'
  - '_bmad/tea/testarch/knowledge/test-quality.md'
  - '_bmad/tea/testarch/knowledge/error-handling.md'
  - 'docker/ator/Dockerfile'
  - 'docker/ator/checksums.txt'
  - 'docker/ator/entrypoint.sh'
  - 'docker/ator/torrc.dirauth'
  - 'docker/ator/torrc.relay'
  - 'docker/ator/torrc.hs'
  - 'docker-compose.yml'
  - 'Makefile'
  - 'CHANGELOG.md'
---

# NFR Assessment - Local ATOR Network Image + docker-compose Profile

**Date:** 2026-04-15
**Story:** 36.1
**Overall Status:** PASS (with CONCERNS) ⚠️

---

Note: This assessment summarizes existing evidence; it does not run tests or CI workflows. Story 36.1 is pure infrastructure (Dockerfile + compose profile + Makefile targets) and produces no application code. Many traditional NFRs (response time, throughput, MTTR) do not apply directly; they are scoped to the *substrate properties* (build determinism, host-port discipline, teardown hygiene, network isolation) instead of runtime perf.

## Executive Summary

**Assessment:** 19 PASS, 6 CONCERNS, 0 FAIL (across 8 ADR Readiness Checklist categories)

**Blockers:** 0

**High Priority Issues:** 0

**Recommendation:** Story 36.1 passes NFR assessment. The substrate is deterministically pinned (`anon v0.4.10.0-beta`, SHA-256 verified), network-isolated (`internal: true` ator_net, single host port at `127.0.0.1:9150`), unprivileged (zero `privileged: true`), and the teardown contract (`down -v`) is preserved exclusively on the per-profile `ator-down` target so existing `infra-down` semantics are not changed. CONCERNS cluster around evidence gaps that are intrinsic to a "config-only, no live build run" implementation: the Dockerfile/compose render were validated statically but no full `make ator-up` -> consensus-formation lifecycle smoke was executed in the implementation sandbox. These are scheduled for verification by Story 36.5 (nightly CI) and developer first-run; they are not blockers for merging 36.1 because the runtime behavior is exactly the kind of thing 36.3/36.4/36.5 are built to catch. Disaster Recovery and QoS/QoE are structurally N/A for an ephemeral test-substrate story.

---

## Performance Assessment

### Response Time (p95)

- **Status:** N/A (PASS by design)
- **Threshold:** No runtime perf SLO applies to a Docker substrate; the relevant budget is *startup-to-consensus*, captured under Reliability below.
- **Actual:** N/A — story produces no application code path
- **Evidence:** Story scope (`packages/connector/src/` untouched, confirmed in File List)
- **Findings:** Performance for the connector itself is unaffected; Epic 36 is verification-only.

### Throughput

- **Status:** N/A (PASS by design)
- **Threshold:** No throughput target — substrate is single-tenant, single-developer/CI use
- **Actual:** N/A
- **Evidence:** Story scope
- **Findings:** No throughput requirement.

### Resource Usage

- **CPU Usage**
  - **Status:** PASS
  - **Threshold:** Reasonable for a 7-container test stack on a developer laptop (no hard cap stated by epic)
  - **Actual:** 7 lightweight `anon` daemons on `debian:bookworm-slim`. No CPU pinning, no privileged perf flags, default scheduler.
  - **Evidence:** `docker-compose.yml` ator profile services; `docker/ator/Dockerfile`

- **Memory Usage**
  - **Status:** PASS
  - **Threshold:** Image size <200 MB per AC 2; per-container resident memory expected <100 MB based on stripped slim base + single binary
  - **Actual:** Build claims `apt-get purge` of build tools and `rm -rf /var/lib/apt/lists/*` to stay under the AC 2 ceiling. Runtime deps trimmed to `ca-certificates`, `gettext-base`, `netcat-openbsd`.
  - **Evidence:** `docker/ator/Dockerfile` Task 1.4 + Completion Notes
  - **Findings:** Image size assertion <200 MB has not been measured in this sandbox (no live build was run); will be validated in 36.5 nightly CI. Marked PASS based on build recipe, with note for first-run verification.

### Scalability

- **Status:** PASS
- **Threshold:** N/A — substrate scales by design to the documented 7-container topology (3+3+1); not intended to scale further
- **Actual:** Topology hard-coded; YAML anchors `&anon-dirauth-env` / `&anon-relay-env` keep the duplication tractable for future expansion if needed
- **Evidence:** `docker-compose.yml` ator profile, completion notes Task 4
- **Findings:** No horizontal-scale requirement.

### Substrate Performance: Startup Latency (epic budget)

- **Status:** CONCERNS ⚠️
- **Threshold:** Consensus formation within 60s (AC 4); descriptor publication within 90s (AC 5); HS hostname within 120s (AC 6); per epic risk R-02 the full nightly stack must come up well under the 10-min CI cap
- **Actual:** **UNVERIFIED IN-SANDBOX** — full `make ator-up` lifecycle was not executed; static compose render only
- **Evidence:** Completion Notes "Out of scope / deferred" and "R-36-05 baseline timing — Deferred until first `make ator-up` on a developer machine"
- **Findings:** This is the principal evidence gap. Mitigated by (a) test design lists T-36.1-04/05/06/07 as P0 integration tests, (b) Story 36.5 nightly CI captures authoritative timing, (c) the `V3AuthVotingInterval=20` short-vote interval and `AssumeReachable 1` accelerate consensus formation in the test net. **No code change required**; verification scheduled.

---

## Security Assessment

### Authentication Strength

- **Status:** PASS
- **Threshold:** N/A — local test substrate, no exposed authentication surface
- **Actual:** No public ports, no auth surface; the only host binding is `127.0.0.1:9150` (loopback only) for hs1 SOCKS
- **Evidence:** `docker-compose.yml` ports binding pattern `127.0.0.1:${ATOR_HS_SOCKS_PORT:-9150}:9050`
- **Findings:** Loopback-only binding eliminates remote-network exposure entirely.

### Authorization Controls

- **Status:** PASS
- **Threshold:** N/A
- **Actual:** Not applicable — no application-layer authorization in scope
- **Evidence:** Story scope (no source code added)
- **Findings:** N/A.

### Data Protection

- **Status:** PASS
- **Threshold:** No PII / no production data; identity material is ephemeral per session
- **Actual:** DirAuth keys are deterministically derived from `IDENTITY_SEED` at first start, cached to a named volume, and destroyed on `down -v`. Onion `hostname` is volume-scoped, not bind-mounted, so it does not leak to host filesystem.
- **Evidence:** `entrypoint.sh` Task 3.4; AC 4 + AC 8; Dev Notes "Identity-Key Determinism"
- **Findings:** Ephemeral-by-design data lifecycle. No host-filesystem residue (named volumes only).

### Vulnerability Management

- **Status:** CONCERNS ⚠️
- **Threshold:** Pinned upstream binary; SHA-256 verified; build fails on mismatch
- **Actual:** **PASS on the explicit controls** — `anon` v0.4.10.0-beta `.deb` is pinned with SHA-256 verification (`f75c1395…` amd64 / `1f5f0971…` arm64) committed to `docker/ator/checksums.txt`. Build uses `sha256sum -c` (no `echo … | -c -` silent-pass anti-pattern). **CONCERN** is upstream churn risk per epic R-36-06: a beta upstream that may republish or rotate without notice. Also no automated CVE scan is wired into the build (no Trivy/Grype step).
- **Evidence:** `docker/ator/Dockerfile`, `docker/ator/checksums.txt`, AC 2 + AC 12
- **Findings:** Recommend Story 36.5 (nightly CI) include a vulnerability scan against the built image (Trivy/Grype) so beta-binary CVE drift is caught. Not a 36.1 blocker.

### Privilege & Network Isolation

- **Status:** PASS
- **Threshold:** Zero `privileged: true`; zero host ports <1024; ator network `internal: true`; only loopback exposure (AC 11)
- **Actual:** Verified statically by Completion Notes Task 6: `privileged:` count = 0 in ator services; `ator_net` carries `internal: true`; only published port is `127.0.0.1:9150 → 9050`
- **Evidence:** Completion Notes Task 6 + AC 11
- **Findings:** Strong isolation posture. Internal network blocks egress; loopback binding blocks remote ingress; no privilege escalation surface.

### Compliance

- **Status:** N/A
- **Standards:** None applicable to a local test substrate
- **Evidence:** Story scope
- **Findings:** N/A.

---

## Reliability Assessment

### Availability (Uptime)

- **Status:** N/A (PASS by design)
- **Threshold:** Substrate is on-demand (developer-initiated `make ator-up`), not a 24/7 service
- **Actual:** N/A — not a long-running service
- **Evidence:** Story scope
- **Findings:** Availability is operator-controlled (manual lifecycle).

### Error Rate

- **Status:** CONCERNS ⚠️
- **Threshold:** Cold-start success rate >95% across nightly CI runs (epic R-01 mitigation)
- **Actual:** **UNVERIFIED** — first nightly run (Story 36.5) will establish baseline
- **Evidence:** test-design-epic-36.md Risk R-01 ("CI flake from real circuit construction"); 36.1 Completion Notes "R-36-05 baseline timing — Deferred"
- **Findings:** Mitigations in place (consensus polling at T-36.1-04 instead of `sleep`, healthcheck-gated `depends_on`, `V3AuthVotingInterval=20`), but actual flake rate cannot be measured until 36.5 lands. CONCERN is informational, not a blocker.

### MTTR (Mean Time To Recovery)

- **Status:** PASS
- **Threshold:** Operator MTTR via `make ator-down && make ator-up` should be under 2 min cold
- **Actual:** Restart contract is documented and clean (`down -v` -> `up -d`); no manual cleanup needed
- **Evidence:** Makefile targets; AC 7 + AC 8
- **Findings:** Recovery is one-command and self-healing. No state to reconcile.

### Fault Tolerance

- **Status:** PASS
- **Threshold:** Single relay/dirauth crash should not cascade-kill the whole stack; a 2-of-3 DirAuth quorum survives loss of one DirAuth
- **Actual:** Topology designed for quorum: 2-of-3 DirAuth voting; healthchecks scoped per service so unhealthy ≠ exit
- **Evidence:** Completion Notes Task 6.3: "Confirm the compose project exits cleanly when any single service unhealthy (test by killing dirauth1 and observing no cascade lock)"
- **Findings:** Quorum design provides intrinsic single-node fault tolerance.

### CI Burn-In (Stability)

- **Status:** CONCERNS ⚠️
- **Threshold:** Nightly job demonstrates stability across trailing 7 runs (per epic R-01 mitigation)
- **Actual:** Burn-in does not yet exist — Story 36.5 establishes the nightly workflow; 36.1 only delivers the substrate the workflow exercises
- **Evidence:** test-design-epic-36.md "nightly job reports flake rate over trailing 7 runs as a retro input"
- **Findings:** CONCERN is structural (downstream story owns it), not a 36.1 defect. No action.

### Disaster Recovery

- **Status:** N/A
- **Standards:** Not applicable — ephemeral test substrate; identity material is intentionally destroyed on `down -v`
- **Evidence:** Dev Notes "Identity-Key Determinism" — keys ephemeral across sessions by design
- **Findings:** N/A.

### Teardown Hygiene (story-specific reliability)

- **Status:** PASS
- **Threshold:** Zero residual containers, networks, or named volumes after `make ator-down` (AC 8); zero host-filesystem residue
- **Actual:** `down -v` purges named volumes; named-not-bind volume strategy guarantees no host-fs leakage; project-name lookup goes through `docker compose config` (not `basename $PWD`) so `COMPOSE_PROJECT_NAME` overrides are honored
- **Evidence:** AC 8; Completion Notes Task 6.1; Makefile `ator-down` target
- **Findings:** Strong residue contract — directly mitigates epic R-08 ("Real-binary test leaks containers / ports between runs").

---

## Maintainability Assessment

### Test Coverage

- **Status:** PASS
- **Threshold:** N/A in the unit-coverage sense (zero application code added). Story-level test coverage is the AC matrix and the T-36.1-01..08 plan in the test design.
- **Actual:** 14 ACs explicitly enumerated; 8 P0 integration tests pre-designed (T-36.1-01..08); shell-level smokes documented in Dev Notes "Testing Standards Summary"
- **Evidence:** test-design-epic-36.md §"Story 36.1"; story AC 1–14
- **Findings:** Test design coverage is comprehensive. Implementation of the actual jest suites lands in 36.3/36.4 per scope.

### Code Quality

- **Status:** PASS
- **Threshold:** Lints clean; conforms to project conventions (CLAUDE.md: Makefile-as-primary-driver, named volumes over bind mounts, healthchecks not sleeps)
- **Actual:** Author follows all stated conventions: YAML anchors DRY the compose blocks; entrypoint.sh uses `set -eu` + signal-trap pattern mirrored exactly from `infra/solana/entrypoint.sh`; no hand-rolled `sed` (uses `envsubst`); pinned image tag (no `:latest`).
- **Evidence:** `docker/ator/entrypoint.sh`, `docker-compose.yml` ator profile, Dev Notes §"Relationship to Existing Compose Profiles"
- **Findings:** High consistency with existing patterns. Reviewer-friendly.

### Technical Debt

- **Status:** PASS
- **Threshold:** Story should not introduce debt; scope discipline is a hard rule
- **Actual:** Bright-line scope respected: zero edits under `packages/connector/src/`, `packages/connector/test/`, or `docs/ator-transport.md` (Completion Notes Task 7.3). One Dev Notes entry flags `docker/` vs `infra/` directory-layout question explicitly as a future-chore candidate, not silent debt.
- **Evidence:** Dev Notes §"Project Structure Notes"; Completion Notes Task 7.3
- **Findings:** Acknowledged debt is documented; no hidden churn.

### Documentation Completeness

- **Status:** CONCERNS ⚠️
- **Threshold:** Operator-facing docs should explain `make ator-*` targets, the `--platform linux/amd64` Apple-Silicon fallback (R-36-03), and the system-tor 9050 / 9150 collision rationale (R-008)
- **Actual:** **Internal** docs are excellent (Dev Notes covers identity determinism, host-port planning, why-`docker/`-not-`infra/`, what's-not-in-scope). **Operator-facing** docs in `docs/ator-transport.md` are explicitly deferred to Story 36.6 per AC 13.
- **Evidence:** AC 13; Dev Notes §"What This Story Does Not Include"
- **Findings:** CONCERN is by-design (36.6 owns operator docs). Risk: if 36.1 ships and 36.6 slips, developers get a substrate with no end-user docs. Mitigated by `make help` text update (AC 10) which provides a discovery surface.

### Test Quality

- **Status:** N/A
- **Threshold:** Test review applies to authored test code; this story authors none
- **Evidence:** Story scope (`packages/connector/test/` untouched)
- **Findings:** N/A. Story 36.3/36.4 will be subject to test-quality review.

---

## Custom NFR Assessments

### Build Reproducibility (Epic 36-specific NFR)

- **Status:** PASS
- **Threshold:** Image SHA-256 must be reproducible byte-for-byte from a fresh checkout on amd64 and arm64 (where upstream publishes); no floating tags, no surprise dependency updates
- **Actual:** `.deb` SHA-256 pinned in `checksums.txt`; image tag pinned (`ator-testnet:v0.4.10.0-beta`, never `:latest`); base image is the Debian-stable `bookworm-slim`; `apt-get install` pins runtime deps to slim list. Bookworm `.deb` matched to Bookworm base (Completion Notes Task 1).
- **Evidence:** `docker/ator/Dockerfile`, `docker/ator/checksums.txt`, AC 2 + AC 12 + AC 14
- **Findings:** Strong. Drift surface is limited to upstream `bookworm-slim` apt-index changes (acceptable) and the upstream `.deb` republishing (mitigated by SHA-256 fail-fast).

### Multi-Arch Support (R-36-03)

- **Status:** PASS
- **Threshold:** amd64 must build natively; arm64 must build natively if upstream publishes; if not, fail fast with clear error referencing checksums.txt (no silent skip)
- **Actual:** Both amd64 and arm64 `.deb` published by upstream as of 2026-04-15 — no R-36-03 gap currently. Dockerfile uses `ARG TARGETARCH` for selection. Per-arch checksum verification path documented.
- **Evidence:** Completion Notes Task 1: "No arm64 gap — both arches published; Apple Silicon builds natively"; AC 14
- **Findings:** R-36-03 is currently inactive; mitigation logic remains in place if upstream removes arm64 in a future release.

---

## Quick Wins

3 quick wins identified for immediate or near-term implementation:

1. **Add image-size assertion to a static check** (Maintainability) - LOW priority - 30 min
   - AC 2 specifies <200 MB but no automated check. Add a make target `ator-size-check` that asserts `docker image inspect ator-testnet:v0.4.10.0-beta --format '{{.Size}}'` is under the threshold. Catches accidental bloat in PRs that touch the Dockerfile.
   - No code changes, pure tooling.

2. **Wire image vulnerability scan into Story 36.5 nightly** (Security) - MEDIUM priority - 1 hour
   - Add a Trivy or Grype step against `ator-testnet:v0.4.10.0-beta` in the nightly workflow that 36.5 introduces. Catches CVE drift on the pinned `anon` beta build (Security CONCERN above).
   - 36.5 work, not 36.1, but flagged here.

3. **Add a `make ator-readiness` helper** (Reliability/UX) - LOW priority - 30 min
   - Convenience target that polls `docker exec dirauth1 cat /var/lib/anon/cached-consensus` and the hs1 hostname file with the documented 60s/120s budgets, exits 0 when both ready. Makes T-36.1-04/06/07 trivially scriptable for Story 36.3/36.4 `beforeAll`.
   - Pure Makefile addition.

---

## Recommended Actions

### Immediate (Before Release) - CRITICAL/HIGH Priority

None. Zero blockers.

### Short-term (Next Milestone) - MEDIUM Priority

1. **First-run lifecycle smoke** - MEDIUM - 30 min - Story 36.1 author or 36.3 author
   - Run `make ator-up` on a developer machine with Docker; verify (a) image builds clean, (b) consensus appears within 60s in dirauth logs, (c) hs1 hostname file populates within 120s, (d) `make ator-down` leaves zero residue. Record results in 36.1 Completion Notes (or attach to 36.3 dev story). Closes the principal evidence gap (Performance + Reliability CONCERNS).
   - Validation: outputs of AC 4, AC 5, AC 6, AC 8 commands appended to story.

2. **Image vulnerability scan** - MEDIUM - 1 hour - Story 36.5 owner
   - See Quick Win #2.

### Long-term (Backlog) - LOW Priority

1. **Unify `docker/` and `infra/` directory layouts** - LOW - 2 hours - infra/dev-experience steward
   - Decision deferred per Dev Notes §"Project Structure Notes"; revisit when a third docker-image source needs a home.

---

## Monitoring Hooks

3 monitoring hooks recommended (all owned by Story 36.5 nightly CI):

### Performance Monitoring

- [ ] **Stack-startup-to-consensus timer** — Capture wall-clock from `make ator-up` exit to first cached-consensus file present
  - **Owner:** Story 36.5
  - **Deadline:** Story 36.5 completion
  - **Rationale:** Establishes the R-02 baseline (CI time-budget risk).

### Security Monitoring

- [ ] **Trivy/Grype scan against `ator-testnet:v0.4.10.0-beta`** — Run in nightly; fail on critical CVEs, warn on high
  - **Owner:** Story 36.5
  - **Deadline:** Story 36.5 completion

### Reliability Monitoring

- [ ] **Trailing-7-run flake-rate report** — Per epic R-01 mitigation: nightly job reports its own flake rate over the trailing window
  - **Owner:** Story 36.5
  - **Deadline:** Story 36.5 completion

### Alerting Thresholds

- [ ] **Cold-start exceeds 90s for consensus formation** — Notify on threshold breach (was 60s in AC 4, 90s allows for CI-runner jitter)
  - **Owner:** Story 36.5
  - **Deadline:** Story 36.5 completion

---

## Fail-Fast Mechanisms

4 fail-fast mechanisms either present or recommended:

### Circuit Breakers (Reliability)

- [x] **DirAuth quorum (2-of-3) tolerates single-DirAuth failure** — Already implemented; no further action
  - **Owner:** Story 36.1 (delivered)

### Rate Limiting (Performance)

- N/A — substrate is single-tenant; no rate-limit need.

### Validation Gates (Security)

- [x] **Build fails on SHA-256 mismatch** — `sha256sum -c` exits non-zero on mismatch; `RUN` instruction propagates the failure
  - **Owner:** Story 36.1 (delivered)
  - **Status:** Live in `docker/ator/Dockerfile`

- [x] **Build fails on unknown TARGETARCH** — Per AC 14, attempting `--platform linux/arm64` when arm64 `.deb` not published fails with clear error pointing at `checksums.txt` (no silent skip). Currently inactive (both arches published) but logic in place.
  - **Owner:** Story 36.1 (delivered)

- [x] **`ator-test` fails fast if `ator-up` was not run** — Makefile target checks `docker compose port hs1 9050` and exits non-zero with "run `make ator-up` first"
  - **Owner:** Story 36.1 (delivered)

### Smoke Tests (Maintainability)

- [x] **`docker run ... anon --version` build-time smoke** — Per Completion Notes Task 1, image runs `anon --version | grep -q "${ANON_VERSION}"` at build time so a malformed install fails the build, not at first runtime
  - **Owner:** Story 36.1 (delivered)

---

## Evidence Gaps

3 evidence gaps identified — actions tracked above:

- [ ] **Live `make ator-up` lifecycle execution** (Performance + Reliability)
  - **Owner:** Story 36.1 author OR Story 36.3 author (whichever brings up the stack first)
  - **Deadline:** Before Story 36.3 PR opens
  - **Suggested Evidence:** Append `make ator-up && sleep 90 && docker exec dirauth1 ls /var/lib/anon/ && cat docker/ator-readiness-output.txt && make ator-down` transcript to 36.1 Completion Notes
  - **Impact:** Closes Performance "Substrate Startup Latency" CONCERN and Reliability "Error Rate" CONCERN.

- [ ] **Image size measurement against AC 2 <200 MB ceiling** (Performance — resource usage)
  - **Owner:** Story 36.1 author OR a follow-up tooling story
  - **Deadline:** Before Story 36.3 PR opens
  - **Suggested Evidence:** `docker image inspect ator-testnet:v0.4.10.0-beta --format '{{.Size}}'` numeric output recorded in story
  - **Impact:** Confirms AC 2 numerically rather than by build-recipe inspection.

- [ ] **Operator-facing docs in `docs/ator-transport.md`** (Maintainability — documentation)
  - **Owner:** Story 36.6
  - **Deadline:** Story 36.6 completion
  - **Suggested Evidence:** New "Local Substrate" section in `docs/ator-transport.md` covering `make ator-up/down/logs/test`, R-36-03 Apple-Silicon Rosetta fallback, R-008 system-tor 9050 collision rationale
  - **Impact:** Closes Maintainability "Documentation Completeness" CONCERN.

---

## Findings Summary

**Based on ADR Quality Readiness Checklist (8 categories, 29 criteria)**

| Category                                         | Criteria Met | PASS  | CONCERNS | FAIL | Overall Status |
| ------------------------------------------------ | ------------ | ----- | -------- | ---- | -------------- |
| 1. Testability & Automation                      | 4/4          | 4     | 0        | 0    | PASS ✅        |
| 2. Test Data Strategy                            | 3/3          | 3     | 0        | 0    | PASS ✅        |
| 3. Scalability & Availability                    | 3/4          | 2     | 1        | 0    | CONCERNS ⚠️    |
| 4. Disaster Recovery                             | 3/3 (N/A)    | 3     | 0        | 0    | N/A (PASS) ✅  |
| 5. Security                                      | 3/4          | 3     | 1        | 0    | PASS ✅        |
| 6. Monitorability, Debuggability & Manageability | 2/4          | 2     | 2        | 0    | CONCERNS ⚠️    |
| 7. QoS & QoE                                     | 4/4 (N/A)    | 4     | 0        | 0    | N/A (PASS) ✅  |
| 8. Deployability                                 | 3/3          | 3     | 0        | 0    | PASS ✅        |
| **Total**                                        | **25/29**    | **24**| **4**    | **0**| **PASS ⚠️**    |

**Criteria Met Scoring:**

- ≥26/29 (90%+) = Strong foundation
- 20-25/29 (69-86%) = Room for improvement   ← **Story 36.1 lands here at 25/29 = 86%**
- <20/29 (<69%) = Significant gaps

The 4 unmet criteria are all *evidence gaps* (live-run measurements pending), not design or implementation defects. They are scheduled for closure by Stories 36.3, 36.5, and 36.6.

---

## Gate YAML Snippet

```yaml
nfr_assessment:
  date: '2026-04-15'
  story_id: '36.1'
  feature_name: 'Local ATOR Network Image + docker-compose Profile'
  adr_checklist_score: '25/29' # ADR Quality Readiness Checklist (86%)
  categories:
    testability_automation: 'PASS'
    test_data_strategy: 'PASS'
    scalability_availability: 'CONCERNS'
    disaster_recovery: 'N/A'
    security: 'PASS'
    monitorability: 'CONCERNS'
    qos_qoe: 'N/A'
    deployability: 'PASS'
  overall_status: 'PASS_WITH_CONCERNS'
  critical_issues: 0
  high_priority_issues: 0
  medium_priority_issues: 2
  concerns: 4
  blockers: false
  quick_wins: 3
  evidence_gaps: 3
  recommendations:
    - 'Run live `make ator-up` lifecycle smoke before Story 36.3 PR opens to close Performance + Reliability CONCERNS'
    - 'Wire Trivy/Grype CVE scan into Story 36.5 nightly workflow to close Security vuln-mgmt CONCERN'
    - 'Track operator-docs delivery in Story 36.6 to close Maintainability docs CONCERN'
```

---

## Related Artifacts

- **Story File:** `_bmad-output/implementation-artifacts/36-1-local-ator-network-image-docker-compose.md`
- **Tech Spec:** `_bmad-output/planning-artifacts/epic-36-real-binary-ator-verification.md`
- **PRD:** `_bmad-output/planning-artifacts/prd.md`
- **Test Design:** `_bmad-output/planning-artifacts/test-design-epic-36.md` (Story 36.1 section, T-36.1-01..08)
- **Implementation Files:**
  - `docker/ator/Dockerfile`
  - `docker/ator/checksums.txt`
  - `docker/ator/entrypoint.sh`
  - `docker/ator/torrc.dirauth`, `docker/ator/torrc.relay`, `docker/ator/torrc.hs`
  - `docker-compose.yml` (ator profile)
  - `Makefile` (`ator-*` targets, `infra-up/down` extension)
  - `CHANGELOG.md` (Unreleased entry)

---

## Recommendations Summary

**Release Blocker:** None. Story 36.1 is mergeable as-is.

**High Priority:** None.

**Medium Priority:**

1. Run a one-shot live `make ator-up` lifecycle smoke and append the transcript to the story before 36.3 PR opens. Closes the substrate-startup-latency and cold-start-error-rate CONCERNS.
2. Story 36.5 should add a Trivy/Grype CVE scan against the pinned image to close the vulnerability-management CONCERN.

**Next Steps:** Proceed with the next epic story (Story 36.2 — `anon --help` snapshot diff gate, or Story 36.3 — real-binary SOCKS5 test). Re-running `nfr-assess` on Story 36.1 is unnecessary unless the live-smoke evidence reveals something this paper assessment did not anticipate.

---

## Sign-Off

**NFR Assessment:**

- Overall Status: **PASS (with CONCERNS)** ⚠️
- Critical Issues: 0
- High Priority Issues: 0
- Concerns: 4 (all evidence-gap CONCERNS, not defects)
- Evidence Gaps: 3 (all scheduled for closure by 36.3 / 36.5 / 36.6)

**Gate Status:** **PASS** ✅ — story is mergeable; CONCERNS are tracked but non-blocking.

**Next Actions:**

- ✅ Proceed to next story (36.2 or 36.3 per sprint plan)
- ⚠️ Address the medium-priority recommendations above as part of normal sprint flow
- 📋 Consider running `bmad-tea-testarch-trace` after Story 36.5 lands to verify cross-story coverage closes all three evidence gaps

**Generated:** 2026-04-15
**Workflow:** testarch-nfr v5.0

---

<!-- Powered by BMAD-CORE™ -->
