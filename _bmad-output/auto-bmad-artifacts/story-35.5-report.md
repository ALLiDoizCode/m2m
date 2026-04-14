# Story 35.5 Report

## Overview
- **Story file**: `_bmad-output/implementation-artifacts/35-5-managed-ator-client-lifecycle.md`
- **Git start**: `25bb2c32c63ea6d0e03233f0fa32b07899f2006f`
- **Duration**: ~80 minutes pipeline wall-clock
- **Pipeline result**: success
- **Migrations**: None (pure TypeScript)

## What Was Built
Story 35.5 introduces the optional `ManagedAnonClient` lifecycle: when `transport.kind === 'socks'` and `managed: true`, the connector spawns and supervises an embedded ATOR daemon via the `@anyone-protocol/anyone-client` SDK (loaded as an optional dependency). The managed client starts/stops in-process with `SocksTransportProvider`, exposes a SOCKS5h port, supports hidden-service hosting with `externalUrl: 'auto'` resolution, and surfaces health-check failures as fail-closed BTP routing decisions.

## Acceptance Criteria Coverage
- [x] AC1: managed start sequencing (SDK start → port probe) — `managed-anon-client.test.ts` T-35.5-01, `socks-transport-provider.test.ts` ordering test
- [x] AC2: idempotent stop / cleanup — T-35.5-02
- [x] AC3: fail-closed propagation when SDK rejects — T-35.5-03
- [x] AC4: TCP probe failure short-circuits — T-35.5-04
- [x] AC5: healthCheck behavior + crash-detected WARN — T-35.5-05, integration tests
- [x] AC6: orphan process cleanup (logged) — T-35.5-06
- [x] AC7: managed:false gating — T-35.5-07
- [x] AC8: externalUrl 'auto' + hidden-service options — T-35.5-08, T-35.5-09 (with hostname regex hardening)
- [x] AC9: log hygiene (.anon never leaked at INFO+) — T-35.5-10
- [x] AC10: SDK-not-installed handling — T-35.5-08, connector-node wiring tests

Total: 10/10 ACs covered, 28 tests across 4 files.

## Files Changed
**packages/connector/src/transport/** — `managed-anon-client.ts` (new), `socks-url.ts` (new), `probe-tcp-port.ts` (new), `socks-transport-provider.ts` (modified), `index.ts` (modified), `managed-anon-client.test.ts` (new), `socks-transport-provider.test.ts` (modified)
**packages/connector/src/core/** — `connector-node.ts` (modified, added managed-client wiring + hostname resolver + regex validation), `connector-node.test.ts` (modified)
**packages/connector/src/config/** — `types.ts` (modified, added `managedOptions` block + `externalUrl: 'auto'`), `config-loader.ts` (modified, path-traversal defenses), `transport-config.test.ts` (modified)
**Root** — `package.json` (added `@anyone-protocol/anyone-client@^1.1.3` to optionalDependencies)
**_bmad-output/** — story file, sprint-status.yaml, atdd-checklist-35-5.md, nfr-assessment-story-35-5.md, test-review-35-5.md, traceability-35-5.md

## Pipeline Steps

### Step 1: Story Create — success (~7m). Story file + sprint-status updated.
### Step 2: Story Validate — success (~6m). 10 issues fixed (test-ID glossary, schema design, AC alignment).
### Step 3: ATDD — success (~7m). 10 RED tests + ATDD checklist.
### Step 4: Develop — success (~60m). 3 new src files, 7 modified, all ACs implemented; 442/442 scoped tests green.
### Step 5: Post-Dev Artifact Verify — success. All Dev Agent Record fields populated.
### Step 6: Frontend Polish — skipped (backend-only).
### Step 7: Post-Dev Lint — success. 3 ESLint errors fixed (block-scoped eslint-disable).
### Step 8: Post-Dev Test — success. TEST_COUNT=3107.
### Step 9: NFR — PASS (7 PASS / 2 CONCERNS / 0 FAIL); concerns: externalUrl 'auto' stub, no npm audit on optional dep.
### Step 10: Test Automate — success. Added 6 integration tests in socks-transport-provider.test.ts.
### Step 11: Test Review — Approve (92/100, A-). 1 dead-code fix in connector-node.test.ts.
### Step 12: Code Review #1 — fixed 1C/2H/3M/3L (externalUrl 'auto' resolution; sdk.stop UnhandledRejection; anonrc clobber; error labels; healthCheck swallowing; path traversal hardening).
### Step 13: Review #1 Verify — Code Review Record section added.
### Step 14: Code Review #2 — fixed 0C/1H/1M/0L (hostname-file ENOENT race; ESM-only fallback).
### Step 15: Review #2 Verify — Pass #2 entry already present.
### Step 16: Code Review #3 — fixed 0C/1H/0M/0L (hostname-file content injection CWE-20/74/OWASP A03 — strict regex validation).
### Step 17: Review #3 Verify — 3 distinct review entries; status=done in both files.
### Step 18: Security Scan — semgrep clean (18 findings, all false positives within trust boundary).
### Step 19: Regression Lint — pass.
### Step 20: Regression Test — 3113 tests pass (+6 from baseline, no regression).
### Step 21: E2E — skipped (backend-only).
### Step 22: Trace — PASS gate, 0 uncovered ACs.

## Test Coverage
- ATDD: `managed-anon-client.test.ts` (10 tests)
- Automated: `socks-transport-provider.test.ts` (+6), `connector-node.test.ts` (+4), `transport-config.test.ts` (+7)
- All 10 ACs covered (P0: 5, P1: 5)
- Two LOW-severity residual gaps documented (hostname regex retry loop + anonrc first-boot-only flag) — defense-in-depth, not blocking
- **Test count**: post-dev 3107 → regression 3113 (delta: +6)

## Code Review Findings

| Pass | Critical | High | Medium | Low | Total Found | Fixed | Remaining |
|------|----------|------|--------|-----|-------------|-------|-----------|
| #1   | 1        | 2    | 3      | 3   | 9           | 9     | 0         |
| #2   | 0        | 1    | 1      | 0   | 2           | 2     | 0         |
| #3   | 0        | 1    | 0      | 0   | 1           | 1     | 0         |

## Quality Gates
- **Frontend Polish**: skipped (backend-only)
- **NFR**: PASS (2 non-blocking concerns documented)
- **Security Scan (semgrep)**: clean (no real findings; all 18 matches are false positives)
- **E2E**: skipped (backend-only)
- **Traceability**: PASS — `_bmad-output/test-artifacts/traceability/traceability-35-5.md`

## Known Risks & Gaps
- `externalUrl: 'auto'` end-to-end resolution wired with bounded-deadline polling + strict hostname regex; works for valid v2/v3 base32 hostnames. Symlink-based escape inside `hiddenServiceDir` treated as operator-trust territory.
- `@anyone-protocol/anyone-client` is an optional dependency without nightly `npm audit` coverage in CI — same gap as `o1js`/`nostr-tools`. Recommended follow-up before epic-35 retro.
- Real-binary nightly integration deferred per Task 7.2 (gated by `ATOR_BINARY_NIGHTLY=1` CI image, not yet provisioned).
- Two LOW-severity residual test gaps from trace: hostname regex retry loop + anonrc first-boot-only flag lack isolated unit tests (covered indirectly).
- Pre-existing Mina/Solana test flakes (6 tests) observed during full suite — unrelated to Story 35.5.

## TL;DR
Story 35.5 (Managed ATOR Client Lifecycle) shipped cleanly: 10/10 ACs covered by 28 tests, three code-review passes resolved 12 findings (1C/4H/4M/3L) including a hardening pass that added strict v2/v3 base32 hostname validation against a CWE-20/74 injection vector. Full regression at 3113 tests (+6 from baseline), lint and build clean, semgrep clean. No human action required; recommended follow-ups (nightly optional-dep audit, real-binary smoke gating) tracked for epic-35 retro.
