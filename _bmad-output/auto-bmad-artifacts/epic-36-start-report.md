# Epic 36 Start Report

## Overview
- **Epic**: 36 — Real-Binary ATOR Verification
- **Git start**: `59b72a3d78a4a43532b9e8d972f2ee66ab01ca5b`
- **Duration**: ~12 minutes total (pipeline wall-clock)
- **Pipeline result**: success
- **Previous epic retro**: reviewed (epic-35-retro-2026-04-14.md)
- **Baseline test count**: 3147 (3063 passing + 84 skipped across Node + Rust)

## Previous Epic Action Items

| # | Action Item | Priority | Resolution |
|---|------------|----------|------------|
| 1 | Decide story-validation churn (4-epic carry limit) | Critical | Fixed — `_bmad-output/decisions/story-validation.md` records skip-unless-threshold default |
| 2 | npm audit gate for optional deps incl. `@anyone-protocol/anyone-client` | High | Fixed — `.github/workflows/ci.yml` extended with `--include=optional` |
| 3 | Nightly Docker/real-binary integration CI | High | Deferred — **in Epic 36 scope (story 36.5)** |
| 4 | Docs-drift CI gate between Zod schemas and markdown | Medium | Deferred — `_bmad-output/decisions/docs-drift-gate-deferred.md` (follow-up story) |
| 5 | Replace `BTPClient._ws` private access in INT-04 | Medium | Fixed — `sendRawFrameForTesting()` public seam + test refactor |
| 6 | Require `externalUrl` explicitly / fail-fast on `ws://localhost` in prod | Medium | Fixed — `config-loader.ts` production-mode loopback guard |
| 7 | Triage path-join at `connector-node.ts:1720` | Medium | Fixed — triaged closed with `// nosemgrep` rationale |
| 8–11 | Low-priority debt (cache tuning, Zod migration, npm audit backlog, `tokenMint` type) | Low | Deferred — tracked debt |
| 12 | Manual ATOR real-binary smoke test | Prep | Deferred — **Epic 36 scope (36.3/36.4)** |
| 13 | npm audit baseline with anyone-client installed | Prep | Addressed by #2 above |
| 14 | `make infra-up` cross-chain smoke | Prep | Deferred — out of scope for verification epic |
| 15 | Dry-fit 3rd TransportProvider | Prep | Deferred — design spike, not Epic 36 |
| 16 | Extract `ManagedSubsystem` primitive | Prep | Deferred — flagged for Epic 37 (would dilute verification signal) |
| 17 | Nightly integration pipeline design doc | Prep | Addressed by test-design-epic-36.md §10-12 |

## Baseline Status
- **Lint**: pass (1 rustfmt fix in `packages/solana-program/tests/security.rs`)
- **Tests**: 3147/3147 (0 failures, 84 intentional skips)
- **Migrations**: N/A (no DB migrations in this project)

## Epic Analysis
- **Stories**: 6 (36.1 Network image, 36.2 CLI flag audit, 36.3 Real-binary SOCKS5, 36.4 HS + managed, 36.5 Nightly CI + fallback, 36.6 Docs)
- **Oversized stories (>8 ACs)**: none (max 6 AC blocks)
- **Dependencies**: 36.1 → {36.3, 36.4} → 36.5 → 36.6; 36.2 independent (parallel); no cross-epic blockers (32–35 all done)
- **Design patterns**: ManagedSubsystem extraction explicitly deferred out of this epic — verification charter forbids source changes to Epic 35 code
- **Recommended story order**:
  - Wave 1 (parallel): 36.1 + 36.2
  - Wave 2 (parallel after 36.1): 36.3 + 36.4 (36.4 rebases on 36.3's rename commit)
  - Wave 3: 36.5 (gated on 36.3/36.4 local-green)
  - Wave 4: 36.6 (needs 36.2 + 36.5 outputs)

## Test Design
- **Epic test plan**: `_bmad-output/planning-artifacts/test-design-epic-36.md` (v1.1)
- **Key risks identified**: real-binary flakiness, anyone-client binary availability on macOS CI, hidden-service timing variability, nightly CI runtime budget, system-tor fallback correctness, docs-drift between Epic 35 guide and Epic 36 verified reality
- **Traceability**: 30 AC rows initialized NOT STARTED; epic-close trace gate enforces completeness

## Pipeline Steps

### Step 1: Previous Retro Check — success (~2m)
Extracted 11 action items + 7 prep tasks + 8 team agreements from epic-35-retro-2026-04-14.md. 55 code-review issues (52 fixed, 3 defensible-by-design Low).

### Step 2: Tech Debt Cleanup — success (~7m)
6 retro items resolved (1 critical, 1 high, 3 medium, 1 medium-deferred). Files: `_bmad-output/decisions/*.md`, `.github/workflows/ci.yml`, `btp-client.ts`, `transport-socks5.test.ts`, `config-loader.ts`, `connector-node.ts`.

### Step 3: Lint Baseline — success (~4m)
`make lint`, `npm run format:check`, `npm run build` (tsc typecheck), `cargo fmt --check` all green. Single rustfmt fix in `security.rs`. Cargo clippy intentionally excluded (not in project gate).

### Step 4: Test Baseline — success (~3m)
`make test` + `make solana-test` in parallel, no live infra required. 3147 tests passed. Two non-blocking observations: ethers retry timer keeping workers alive briefly, `TimeoutOverflowWarning` on ~90-day timer value (functionally benign).

### Step 5: Epic Overview Review — success (~2m)
All 6 stories within AC bounds. Parallel scheduling plan established. ManagedSubsystem extraction formally deferred to Epic 37.

### Step 6: Sprint Status Update — success
`epic-36.status`: pending → in-progress.

### Step 7: Test Design — success (~7m)
`test-design-epic-36.md` v1.1 with 14-risk register (added R-13 docs-drift, R-14 macOS binary availability), entry/exit per story, AC↔test-ID gate mapping, traceability stub.

## Ready to Develop
- [x] All critical retro actions resolved (story-validation decision recorded)
- [x] Lint and tests green (zero failures, 3147 total)
- [x] Sprint status updated (epic-36 in-progress)
- [x] Story order established (Wave 1: 36.1+36.2 parallel)
- [x] Test design published

## Next Steps
**Start Story 36.1** — Local ATOR Network Image + docker-compose. Concurrently dispatch **36.2** (anyone-client CLI flag audit, 1 point, fully independent docs-only work).

Notes for implementers:
- 36.1 may hit the epic's open Q3 (Rosetta vs native arm64 on macOS-14) — flag early if the `.deb` is amd64-only.
- Compose naming mismatch between test-design (`docker-compose.anon.yml`) and epic spec (`docker-compose.yml ator profile`) — spec is authoritative; reconcile in 36.1.
- 36.3 carries the contract-fixture rename; land that commit early so 36.4 can rebase without conflicts.
- Reject any PR that modifies `packages/connector/src/transport/**` source — verification-only epic.

---

## TL;DR
Epic 36 baseline is green (3147/3147 tests, lint clean), all critical + recommended previous-epic retro actions are resolved (6 fixed, 5 scope-deferred into Epic 36 stories, 5 low-priority tracked as debt), and a risk-based test plan covering all 6 stories is published at `test-design-epic-36.md`. Sprint status advanced to in-progress with Wave 1 (36.1 + 36.2 parallel) recommended as the starting point.
