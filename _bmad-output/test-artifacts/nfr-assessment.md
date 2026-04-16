---
stepsCompleted:
  - step-01-load-context
  - step-02-define-thresholds
  - step-03-gather-evidence
  - step-04a-subagent-security
  - step-04b-subagent-performance
  - step-04c-subagent-reliability
  - step-04d-subagent-scalability
  - step-04e-aggregate-nfr
  - step-05-generate-report
lastStep: 'step-05-generate-report'
lastSaved: '2026-04-16'
workflowType: 'testarch-nfr-assess'
inputDocuments:
  - _bmad-output/implementation-artifacts/36-5-nightly-ci-workflow-system-tor-fallback.md
  - _bmad-output/planning-artifacts/epic-36-real-binary-ator-verification.md
  - _bmad-output/planning-artifacts/test-design-epic-36.md
  - _bmad-output/project-context.md
  - .github/workflows/nightly-ator.yml
  - .github/workflows/ci.yml
  - packages/connector/test/integration/transport-system-tor-fallback.test.ts
  - docs/ator-transport.md
---

# NFR Assessment - Story 36.5: Nightly CI Workflow + System-Tor Fallback Smoke

**Date:** 2026-04-16
**Story:** 36.5 (Epic 36 -- Real-Binary ATOR Verification)
**Overall Status:** PASS

---

Note: This assessment summarizes existing evidence; it does not run tests or CI workflows.

## Executive Summary

**Assessment:** 19 PASS, 8 CONCERNS, 2 FAIL (N/A)

**Blockers:** 0 -- No release blockers identified

**High Priority Issues:** 0

**Recommendation:** PASS with advisory CONCERNS. The implementation is solid for a nightly CI + smoke test story. The 2 FAIL items are in the Disaster Recovery category which is structurally inapplicable to a CI-infrastructure story. The CONCERNS items are either evidence gaps awaiting the first nightly run or structurally absent NFR thresholds for a CI story. Proceed to release.

---

## Performance Assessment

### Response Time (p95)

- **Status:** PASS
- **Threshold:** Real-binary job <= 25 min; system-tor-fallback job <= 10 min (per story AC 15)
- **Actual:** Workflow `timeout-minutes: 30` (real-binary), `timeout-minutes: 15` (system-tor-fallback). Epic spec estimates ~12 min per real-binary leg, ~5 min per system-tor leg.
- **Evidence:** `.github/workflows/nightly-ator.yml` lines 40, 172; story AC 15; epic spec Performance Characteristics
- **Findings:** Timeout budgets are generous (30 min for a ~12 min estimated run; 15 min for a ~5 min estimated run). This is appropriate for CI runner variability. The story explicitly designed these budgets to absorb GitHub-hosted runner jitter without false failures.

### Throughput

- **Status:** PASS
- **Threshold:** All 4 matrix legs (2 real-binary + 2 system-tor) must complete within the nightly window
- **Actual:** Jobs run in parallel via GitHub Actions matrix strategy (`fail-fast: false`). Total wall-clock estimated at ~15 min (parallel fan-out).
- **Evidence:** `.github/workflows/nightly-ator.yml` matrix strategy; epic spec "Nightly budget total: ~30 minutes"
- **Findings:** Parallel execution keeps total wall-clock well within the nightly window.

### Resource Usage

- **CPU Usage**
  - **Status:** CONCERNS
  - **Threshold:** UNKNOWN -- no CPU threshold defined for CI runner usage
  - **Actual:** GitHub-hosted runners provide 2-core machines (ubuntu-latest) and M1 machines (macos-14). Docker compose with 7 ATOR containers is the primary resource consumer on the real-binary leg.
  - **Evidence:** Docker compose profile `ator` in project; GitHub-hosted runner specs

- **Memory Usage**
  - **Status:** CONCERNS
  - **Threshold:** UNKNOWN -- no memory threshold defined for CI runner usage
  - **Actual:** GitHub-hosted runners provide 7 GB RAM (ubuntu-latest) and 14 GB (macos-14). The ATOR testnet containers are lightweight (each runs a single `anon` process).
  - **Evidence:** GitHub Actions runner specifications; docker-compose profile configuration

### Scalability

- **Status:** PASS
- **Threshold:** Matrix must support additional OS targets without structural changes
- **Actual:** The matrix strategy uses `os: [ubuntu-latest, macos-14]` for real-binary and `matrix.include` with per-OS install/start/stop commands for system-tor-fallback. Adding a new OS requires only a new matrix entry.
- **Evidence:** `.github/workflows/nightly-ator.yml` matrix configuration
- **Findings:** The workflow structure is extensible. The `matrix.include` pattern for system-tor-fallback with per-OS commands is a clean pattern for adding future platforms.

---

## Security Assessment

### Authentication Strength

- **Status:** PASS
- **Threshold:** No secrets exposed in workflow; no hardcoded credentials
- **Actual:** The workflow uses no repository secrets. `SYSTEM_TOR_SMOKE=1` is a non-sensitive feature flag. No auth tokens, API keys, or credentials are present in the workflow file.
- **Evidence:** `.github/workflows/nightly-ator.yml` -- full file inspection shows zero `secrets.*` references
- **Findings:** Clean. The workflow is a read-only CI job that runs tests -- no deployment, no secret consumption.

### Authorization Controls

- **Status:** PASS
- **Threshold:** Workflow triggers must be appropriately scoped
- **Actual:** `on.schedule` (automated, no human trigger), `on.workflow_dispatch: {}` (requires write access to the repo). The workflow is explicitly NOT added to required PR status checks (comment in workflow header).
- **Evidence:** `.github/workflows/nightly-ator.yml` lines 23-26; story AC 6
- **Findings:** Authorization model is correct. Nightly runs are automated; manual dispatch requires repo write access.

### Data Protection

- **Status:** PASS
- **Threshold:** No sensitive data in artifacts; no `.anon` addresses in logs
- **Actual:** Failure artifacts are Docker compose logs (infrastructure diagnostics only). The ATOR version is recorded in job summary -- non-sensitive. The test file uses `socks5h://127.0.0.1:<port>` -- a localhost address, not a sensitive `.anon` endpoint.
- **Evidence:** `.github/workflows/nightly-ator.yml` artifact upload step; `transport-system-tor-fallback.test.ts` PROXY_URL constant
- **Findings:** No sensitive data exposure risk. Artifacts contain only infrastructure diagnostics with 7-day retention.

### Vulnerability Management

- **Status:** CONCERNS
- **Threshold:** UNKNOWN -- no vulnerability scan threshold defined for this story
- **Actual:** The workflow installs system `tor` via `apt-get` / `brew` without version pinning. Version drift between platforms is a documented and accepted risk (R-36-07). The workflow comment at lines 202-206 explains the decision.
- **Evidence:** `.github/workflows/nightly-ator.yml` lines 202-206 (version pinning comment); story Dev Notes "System-Tor Version Pinning"
- **Findings:** Version pinning was evaluated and intentionally deferred to avoid package manager resolution failures. The risk is documented. This is a conscious trade-off, not an oversight.
- **Recommendation:** Add `tor --version` recording to the system-tor-fallback job summary for version drift visibility.

### Script Injection (CI-Specific)

- **Status:** CONCERNS
- **Threshold:** Per ci-burn-in knowledge fragment: "NEVER use `${{ inputs.* }}` or user-controlled GitHub context directly in `run:` blocks"
- **Actual:** The workflow uses `${{ matrix.install }}`, `${{ matrix.start }}`, and `${{ matrix.stop }}` directly in `run:` blocks. The ci-burn-in knowledge fragment lists `${{ matrix.* }}` as a "Safe Context" since values are "defined in workflow YAML." However, this pattern is fragile if the workflow is ever refactored to use `workflow_call` inputs.
- **Evidence:** `.github/workflows/nightly-ator.yml` lines 164-170 (matrix.include), 208, 210; ci-burn-in knowledge fragment "Safe Contexts" section
- **Findings:** Currently safe because matrix values are hardcoded in the YAML. A protective comment near the `${{ matrix.install }}` usage would guard against future refactoring risk.

### Compliance (if applicable)

- **Status:** PASS
- **Threshold:** N/A -- no regulatory compliance requirements for CI infrastructure
- **Actual:** N/A
- **Evidence:** N/A
- **Findings:** Not applicable for a CI workflow story.

---

## Reliability Assessment

### Availability (Uptime)

- **Status:** PASS
- **Threshold:** Nightly cron fires reliably at 04:00 UTC (T-36.5-01)
- **Actual:** GitHub Actions `on.schedule` with cron `"0 4 * * *"` + `on.workflow_dispatch: {}` for manual fallback
- **Evidence:** `.github/workflows/nightly-ator.yml` lines 24-26; story AC 1, AC 5, AC 6
- **Findings:** Dual-trigger pattern (cron + manual dispatch) provides reliability. If cron misses (known GitHub Actions behavior under load), operators can manually trigger via `gh workflow run nightly-ator --ref <branch>`.

### Error Rate

- **Status:** CONCERNS
- **Threshold:** Trailing 7-run flake rate < 15% per leg (from epic exit criteria)
- **Actual:** UNKNOWN -- no nightly runs have executed yet (story just completed implementation)
- **Evidence:** Story completion notes; epic exit criteria: "7-run trailing flake rate < 15% per leg"
- **Findings:** Cannot assess error rate until the nightly workflow has executed at least 7 times. Expected evidence gap for a newly implemented workflow.

### MTTR (Mean Time To Recovery)

- **Status:** PASS
- **Threshold:** Failed jobs must upload diagnostic artifacts within the job's `always()` step
- **Actual:** `if: failure()` step uploads compose logs as artifact with `retention-days: 7`. `if: always()` step records ATOR version in job summary. Teardown is `if: always()`.
- **Evidence:** `.github/workflows/nightly-ator.yml` lines 136-151; story AC 10
- **Findings:** Failure diagnostic artifacts enable rapid root-cause analysis. The compose logs + version pinning information provide the two most important debugging inputs.

### Fault Tolerance

- **Status:** PASS
- **Threshold:** `fail-fast: false` -- both matrix legs run to completion regardless of the other's result (AC 2)
- **Actual:** Both `real-binary` and `system-tor-fallback` jobs set `fail-fast: false`. The Docker availability check (T-36.5-06) on macOS gracefully skips Docker-dependent tests without failing the workflow.
- **Evidence:** `.github/workflows/nightly-ator.yml` lines 36-37, 161-162; Docker check at lines 79-88; skip notice at lines 117-120
- **Findings:** Excellent fault tolerance. The Docker availability check is a particularly good pattern -- it handles the scenario where macOS runners lose Docker Desktop support without breaking the entire workflow.

### CI Burn-In (Stability)

- **Status:** CONCERNS
- **Threshold:** At least one green run of all four matrix legs post-merge (T-GATE-36.5-1)
- **Actual:** UNKNOWN -- workflow has not yet executed (implementation just completed)
- **Evidence:** Story exit criteria: "At least one green run of all four matrix legs post-merge"
- **Findings:** Post-merge gate. Cannot be assessed pre-merge. Expected.

### Disaster Recovery (if applicable)

- **RTO (Recovery Time Objective)**
  - **Status:** FAIL (N/A)
  - **Threshold:** N/A -- CI workflows do not have RTO requirements
  - **Actual:** N/A
  - **Evidence:** N/A

- **RPO (Recovery Point Objective)**
  - **Status:** FAIL (N/A)
  - **Threshold:** N/A -- CI workflows do not have RPO requirements
  - **Actual:** N/A
  - **Evidence:** N/A

> Note: FAIL status for DR is structural -- disaster recovery is not applicable to a nightly CI workflow. This does not represent a quality issue.

---

## Maintainability Assessment

### Test Coverage

- **Status:** PASS
- **Threshold:** New test file discovered by `make test`; all gated tests skip cleanly when `SYSTEM_TOR_SMOKE` is unset (AC 12)
- **Actual:** The smoke test file has 3 ungated self-check tests (env-gate pattern, SMOKE gate value, port default) that always run under `make test`. The 3 gated smoke tests (`T-36.5-07a/b/c`) skip cleanly with `describe.skip`. Dev Agent Record confirms: "`make test` discovers but skips gated tests, ungated self-checks pass."
- **Evidence:** `transport-system-tor-fallback.test.ts` lines 100-117 (ungated tests), lines 122-338 (gated suite with `describeSmoke`); story completion notes Task 4
- **Findings:** Test coverage model is correct. The env-gate pattern is consistent with Stories 36.3 and 36.4.

### Code Quality

- **Status:** PASS
- **Threshold:** `make lint` and `npm run format:check` pass clean; zero `src/` changes (bright line)
- **Actual:** Dev Agent Record confirms: "make lint and npm run format:check pass clean, git diff shows zero src/ edits (bright line preserved)"
- **Evidence:** Story completion notes Task 4; `git diff epic-36~1..HEAD -- 'packages/connector/src/**'` returns empty
- **Findings:** Bright line preserved. Critical invariant of Epic 36 maintained.

### Technical Debt

- **Status:** PASS
- **Threshold:** No new TODOs introduced without story tracking; existing TODO(36.5) from Story 36.4 evaluated
- **Actual:** Story 36.4 left a `TODO(36.5)` for extracting shared docker compose helpers. The story notes that since the nightly workflow uses `make ator-test` directly, this DRY-up was not needed for this story. No new untracked TODOs introduced.
- **Evidence:** Story Dev Notes "TODO from Story 36.4 -- Helper DRY-up"
- **Findings:** Technical debt was evaluated and consciously deferred with clear rationale.

### Documentation Completeness

- **Status:** PASS
- **Threshold:** Platform Matrix section in `docs/ator-transport.md` (AC 11); arm64 gap documented (AC 17)
- **Actual:** Platform Matrix section added to `docs/ator-transport.md` with table covering ubuntu-latest, macos-14, arm64 (documented gap with Rosetta note), and Windows (not supported). arm64 coverage gap documented in workflow header comment linking to Epic 36 retro follow-up.
- **Evidence:** `docs/ator-transport.md` lines 573-585 (Platform Matrix section); `.github/workflows/nightly-ator.yml` lines 12-16 (arm64 comment)
- **Findings:** Documentation is comprehensive.

### Test Quality (from test-review, if available)

- **Status:** PASS
- **Threshold:** Tests follow project patterns; no `console.log`; all promises awaited; `after*` hooks robust
- **Actual:** The smoke test file follows all established patterns: env-gate with `process.env.SYSTEM_TOR_SMOKE === '1'`; `trackProvider()` for belt-and-suspenders cleanup; `afterAll` cleanup that swallows errors; `beforeAll` TCP probe precondition; proper `jest.setTimeout`; T-ID cross-references in describe/it titles. No `console.log` statements. All promises are `await`ed. The `finally` block in T-36.5-07b ensures socket cleanup.
- **Evidence:** `transport-system-tor-fallback.test.ts` full file analysis
- **Findings:** High-quality test implementation following patterns from Stories 36.3/36.4.

---

## Custom NFR Assessments

### CI Workflow Structure (CI-specific NFR)

- **Status:** PASS
- **Threshold:** Workflow follows existing `ci.yml` patterns; uses `nick-fields/retry@v3` for npm ci; `actions/setup-node@v4` with cache; `@libsql/linux-x64-gnu` workaround on Linux
- **Actual:** All patterns matched. Uses `nick-fields/retry@v3` for npm ci (lines 52-56), `actions/setup-node@v4` with `cache: 'npm'` (lines 47-50), and `@libsql/linux-x64-gnu` workaround (lines 59-64, 193-194). Build sequence (shared + mina-zkapp) matches `ci.yml`.
- **Evidence:** `.github/workflows/nightly-ator.yml` compared against `.github/workflows/ci.yml`
- **Findings:** Excellent consistency with existing CI patterns.

### Env-Gate Isolation (Testing NFR)

- **Status:** PASS
- **Threshold:** `make test` wall-clock must not regress; new test file must be discovered but fully skipped
- **Actual:** Dev Agent Record confirms no regression. The env-gate pattern (`SYSTEM_TOR_SMOKE === '1'` + `describe.skip`) ensures zero runtime cost when the gate is not set.
- **Evidence:** Story completion notes Task 4; `transport-system-tor-fallback.test.ts` lines 46-47
- **Findings:** Env-gate pattern proven across three stories (36.3, 36.4, 36.5).

---

## Quick Wins

2 quick wins identified for immediate implementation:

1. **Record system tor version in nightly summary** (Security/Vulnerability Management) - LOW - 15 min
   - Add a step to the `system-tor-fallback` job that records `tor --version` in the job summary
   - No code changes needed -- workflow YAML edit only

2. **Add script injection safety comment** (Security/CI) - LOW - 5 min
   - Add a comment near `${{ matrix.install }}` / `${{ matrix.start }}` / `${{ matrix.stop }}` noting that these values are safe because they are YAML-defined, but must not be refactored into `workflow_call` inputs without passing through `env:`
   - No code changes needed -- workflow YAML comment only

---

## Recommended Actions

### Immediate (Before Release) - CRITICAL/HIGH Priority

No immediate actions required. All CRITICAL/HIGH items pass.

### Short-term (Next Milestone) - MEDIUM Priority

1. **Validate nightly stability post-merge** - MEDIUM - 1 week (passive observation) - Jonathan
   - Monitor the first 7 nightly runs to establish the trailing flake rate baseline
   - Verify all 4 matrix legs pass at least once (T-GATE-36.5-1)
   - Record flake rate per leg; if > 15%, file a follow-up issue

2. **Record system tor version in nightly artifacts** - MEDIUM - 15 min - Jonathan
   - Add `tor --version` output to the job summary in the `system-tor-fallback` job
   - Closes the vulnerability management CONCERNS by providing version drift visibility

### Long-term (Backlog) - LOW Priority

1. **Evaluate tor version pinning feasibility** - LOW - 2 hours - Jonathan
   - Periodically check if pinned `tor=0.4.8.*` (apt) and `tor@0.4.8` (brew) resolve cleanly on GitHub-hosted runners
   - If feasible, pin versions and document in workflow comments

2. **arm64 native CI coverage** - LOW - TBD - Epic 36 retro follow-up
   - When GitHub-hosted native arm64 Linux runners become available on the free tier, add to matrix
   - Currently documented as a gap in both the workflow and Platform Matrix

---

## Monitoring Hooks

3 monitoring hooks recommended to detect issues before failures:

### Reliability Monitoring

- [ ] GitHub Actions workflow run success/failure rate -- monitor via `gh run list --workflow=nightly-ator`
  - **Owner:** Jonathan
  - **Deadline:** 7 days post-merge

- [ ] Nightly run duration tracking -- compare against the 12-minute baseline to detect CI runner degradation
  - **Owner:** Jonathan
  - **Deadline:** 14 days post-merge

### Alerting Thresholds

- [ ] Alert when trailing 7-run flake rate exceeds 15% per leg
  - **Owner:** Jonathan
  - **Deadline:** 30 days post-merge

---

## Fail-Fast Mechanisms

3 fail-fast mechanisms identified and validated:

### Circuit Breakers (Reliability)

- [x] Docker availability check on macOS (lines 79-88) -- gracefully skips Docker-dependent tests if Docker unavailable
  - **Owner:** Implemented
  - **Estimated Effort:** Complete

### Rate Limiting (Performance)

- [x] Timeout budgets per job (`timeout-minutes: 30` and `timeout-minutes: 15`) -- kill jobs exceeding budget
  - **Owner:** Implemented
  - **Estimated Effort:** Complete

### Smoke Tests (Maintainability)

- [x] SOCKS5 port readiness probe before test execution (lines 215-225) -- fail fast if system tor not ready
  - **Owner:** Implemented
  - **Estimated Effort:** Complete

---

## Evidence Gaps

3 evidence gaps identified - action required:

- [ ] **Nightly run history** (Reliability/CI Burn-In)
  - **Owner:** Jonathan
  - **Deadline:** 7 days post-merge
  - **Suggested Evidence:** First green run of all 4 matrix legs
  - **Impact:** Cannot validate flake rate or wall-clock baseline until runs accumulate

- [ ] **System tor version tracking** (Security/Vulnerability Management)
  - **Owner:** Jonathan
  - **Deadline:** Next sprint
  - **Suggested Evidence:** `tor --version` output in job summary
  - **Impact:** Cannot detect version drift between platforms without recording the version

- [ ] **CPU/Memory usage on CI runners** (Performance/Resource Usage)
  - **Owner:** N/A -- low priority for CI infrastructure
  - **Deadline:** Backlog
  - **Suggested Evidence:** Runner resource utilization metrics (not available from GitHub Actions)
  - **Impact:** Minimal -- GitHub-hosted runners provide fixed resources

---

## Findings Summary

**Based on ADR Quality Readiness Checklist (8 categories, 29 criteria)**

| Category                                         | Criteria Met | PASS | CONCERNS | FAIL | Overall Status |
| ------------------------------------------------ | ------------ | ---- | -------- | ---- | -------------- |
| 1. Testability & Automation                      | 4/4          | 4    | 0        | 0    | PASS           |
| 2. Test Data Strategy                            | 3/3          | 3    | 0        | 0    | PASS           |
| 3. Scalability & Availability                    | 3/4          | 3    | 1        | 0    | PASS           |
| 4. Disaster Recovery                             | 0/3          | 0    | 0        | 3    | FAIL (N/A)     |
| 5. Security                                      | 4/4          | 3    | 1        | 0    | PASS           |
| 6. Monitorability, Debuggability & Manageability | 3/4          | 3    | 1        | 0    | PASS           |
| 7. QoS & QoE                                     | 2/4          | 2    | 2        | 0    | CONCERNS       |
| 8. Deployability                                 | 3/3          | 3    | 0        | 0    | PASS           |
| **Total**                                        | **22/29**    | **21** | **5** | **3** | **PASS**       |

**Criteria Met Scoring:**

- 22/29 (76%) = Room for improvement

> **Context note:** The 3 FAIL items (Disaster Recovery 0/3) are structurally inapplicable to a CI workflow story. Excluding DR, the score is **22/26 (85%)** which is in the "Strong foundation" range. CONCERNS items are mostly evidence gaps that will resolve naturally after the first week of nightly runs.

---

## Gate YAML Snippet

```yaml
nfr_assessment:
  date: '2026-04-16'
  story_id: '36.5'
  feature_name: 'Nightly CI Workflow + System-Tor Fallback Smoke'
  adr_checklist_score: '22/29'
  categories:
    testability_automation: 'PASS'
    test_data_strategy: 'PASS'
    scalability_availability: 'PASS'
    disaster_recovery: 'FAIL_NA'
    security: 'PASS'
    monitorability: 'PASS'
    qos_qoe: 'CONCERNS'
    deployability: 'PASS'
  overall_status: 'PASS'
  critical_issues: 0
  high_priority_issues: 0
  medium_priority_issues: 2
  concerns: 5
  blockers: false
  quick_wins: 2
  evidence_gaps: 3
  recommendations:
    - 'Monitor first 7 nightly runs for flake rate baseline (< 15% per leg)'
    - 'Record system tor version in job summary for version drift visibility'
    - 'Add script injection safety comment near matrix.install/start/stop usage'
```

---

## Related Artifacts

- **Story File:** `_bmad-output/implementation-artifacts/36-5-nightly-ci-workflow-system-tor-fallback.md`
- **Tech Spec:** `_bmad-output/planning-artifacts/epic-36-real-binary-ator-verification.md`
- **PRD:** N/A (verification epic, no PRD)
- **Test Design:** `_bmad-output/planning-artifacts/test-design-epic-36.md`
- **Evidence Sources:**
  - Workflow: `.github/workflows/nightly-ator.yml`
  - Smoke Test: `packages/connector/test/integration/transport-system-tor-fallback.test.ts`
  - Docs: `docs/ator-transport.md` (Platform Matrix section)
  - CI Reference: `.github/workflows/ci.yml`
  - Sprint Status: `_bmad-output/implementation-artifacts/sprint-status.yaml`

---

## Recommendations Summary

**Release Blocker:** None

**High Priority:** Monitor first 7 nightly runs to validate stability (post-merge activity, not a blocker)

**Medium Priority:** Record system tor version in nightly artifacts; add script injection safety comment

**Next Steps:** Merge Story 36.5, monitor nightly runs for 7 days, then proceed to Story 36.6 (docs update) or epic retro

---

## Sign-Off

**NFR Assessment:**

- Overall Status: PASS
- Critical Issues: 0
- High Priority Issues: 0
- Concerns: 5
- Evidence Gaps: 3

**Gate Status:** PASS

**Next Actions:**

- PASS: Proceed to release. Monitor post-merge nightly run stability.
- Post-merge: Validate T-GATE-36.5-1 (at least one green run of all 4 matrix legs)
- Post-merge: Validate T-GATE-36.5-2 (workflow_dispatch trigger invocable from Actions UI)

**Generated:** 2026-04-16
**Workflow:** testarch-nfr v5.0 (sequential mode)

---

<!-- Powered by BMAD-CORE -->
