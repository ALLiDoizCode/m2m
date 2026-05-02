# Epic 42: Home-Hosting Acceptance End-to-End

**Date:** 2026-05-01
**Author:** Jonathan (with BMAD multi-agent roundtable)
**Status:** Draft
**Dependencies:** Epics 35, 38, 39, 40, 41 — this epic composes them, does not introduce new functionality
**Type:** Integration epic — wires what already exists into the binary north-star acceptance test
**North-star tier served:** T3 (strategic) — answers the binary acceptance test "yes"

---

## Executive Summary

Compose Epics 35 (ATOR) + 38 (RFC 9421) + 39 (Local Delivery) + 40 (Passkey-PRF) + 41 (TownHub Nostr Discovery) into the single binary acceptance test from the north star:

> *Can a stranger, on a fresh laptop, with one passkey ceremony, deploy a docker container that becomes a paid TOON node receiving ILP packets, settling claims on three chains, signing everything with their own key, with no SDK code and no seed phrase to write down?*

If yes — the connector's strategic goal is met. If no — this epic's stories are not done.

This epic exists because building each capability is necessary but not sufficient. The acceptance test is end-to-end; it can only pass when every prior epic has shipped *and* they compose without integration bugs. Any new functionality required by this epic is a sign the prior epics under-scoped — that's the meta-test.

---

## Architecture (composition view)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Stranger's laptop                                                      │
│  ┌──────────────┐    one passkey ceremony    ┌──────────────────────┐   │
│  │ Browser admin├───────────────────────────▶│ Connector (Pi/Docker)│   │
│  │ UI (Epic 40) │                            │ + ATOR (Epic 35)     │   │
│  └──────────────┘                            │ + Local delivery     │   │
│                                              │   (Epic 39)          │   │
│                                              │ + RFC 9421 (Epic 38) │   │
│                                              │ + TownHub publish    │   │
│                                              │   (Epic 41)          │   │
│                                              └──────────┬───────────┘   │
│                                                         │               │
└─────────────────────────────────────────────────────────┼───────────────┘
                                                          │ .anon
                                                          ▼
                                              ┌─────────────────────┐
                                              │  ATOR overlay       │
                                              │  (Anyone Protocol)  │
                                              └──────────┬──────────┘
                                                         │
                                  ┌──────────────────────┼──────────────────────┐
                                  │                      │                      │
                                  ▼                      ▼                      ▼
                          ┌───────────────┐    ┌───────────────┐    ┌─────────────────┐
                          │ Nostr relays  │    │  Sender       │    │ Chains: EVM /   │
                          │ (TownHub      │    │  connector    │    │ Solana / Mina   │
                          │  Epic 41)     │    │  (anywhere)   │    │ (Epics 32-34)   │
                          └───────────────┘    └───────────────┘    └─────────────────┘
```

### What this epic owns (and only owns)

- A Pi-class containerised CI environment.
- The end-to-end acceptance test that exercises all four prior epics in one run.
- An operator onboarding script that walks a stranger through the steps.
- A reference deployment guide.
- A performance baseline + ratchet metric in nightly CI.
- Rollback drills for the most likely failure modes.

### What this epic does NOT own

- Any new connector features. If a feature is missing, it belongs in Epic 35/38/39/40/41.
- Marketing, operator-recruitment, or business-development activities.
- Hardware vendor partnerships or branded hardware bundles.
- Custom Pi disk images / preconfigured SD cards.
- Per-chain settlement implementation (already shipping in Epics 32–34).

---

## Stories

### Story 42.1: Containerised Pi-class CI environment

**Goal.** Add a docker-compose target that simulates a Pi-class environment (resource-limited Docker) to run the acceptance test in CI.

**AC.**
- AC1: New compose target `docker-compose.pi-class.yml`.
- AC2: Resource limits: 4 CPU cores, 4 GB RAM (Pi 4 / Pi 5 reference); enforced via `deploy.resources.limits`.
- AC3: Storage: ext4 volume; ~32 GB simulated SD card capacity.
- AC4: Network: simulated residential NAT (no public IP exposed).
- AC5: `make pi-class-up` / `make pi-class-down` Makefile targets.

**Files.** `docker-compose.pi-class.yml`; `Makefile` edits.

---

### Story 42.2: End-to-end acceptance test

**Goal.** Single test that exercises the full path: fresh passkey → ATOR up → strfry up → kind:30400 published → second connector finds it → ILP packet settles on EVM.

**AC.**
- AC1: Test name: `acceptance.home-hosting.spec.ts` in `packages/connector/test/integration/`.
- AC2: Steps:
  1. Boot a clean Pi-class connector instance.
  2. Provision a virtual WebAuthn authenticator (Chrome DevTools Protocol per Epic 40).
  3. Run `connector home-init` (Story 42.4) interactively via a test harness.
  4. Verify ATOR is up and `.anon` URL is reachable.
  5. Verify kind:30400 event is published to the test relay.
  6. Boot a second connector (sender) with a separate passkey.
  7. Sender connector subscribes to the test relay; finds the home node.
  8. Sender opens an EVM payment channel to the home node (via Anvil).
  9. Sender sends an ILP PREPARE with a kind:1 Nostr event payload.
  10. Home node verifies (Schnorr), prices, dedups, delivers to strfry, returns FULFILL.
  11. Sender's claim threshold crosses; SettlementMonitor triggers `claimFromChannel()`.
  12. EVM transaction confirms; balances reconcile.
- AC3: Test asserts ALL of the above with no SDK imports anywhere on the home node.
- AC4: Test asserts no seed phrase was typed/copied during home-init.
- AC5: Test runs nightly + on-demand via `make acceptance-home-hosting`.

**Files.** `packages/connector/test/integration/acceptance.home-hosting.spec.ts`.

**Dependencies.** All five prior epics (35, 38, 39, 40, 41).

---

### Story 42.3: Solana + Mina parity tests

**Goal.** Same acceptance flow but settling on Solana and Mina respectively. Deferrable to v2 if EVM-only is sufficient for v1 sign-off.

**AC.**
- AC1: `acceptance.home-hosting.solana.spec.ts` — settles on Solana via the existing Solana provider container.
- AC2: `acceptance.home-hosting.mina.spec.ts` — settles on Mina via the existing Mina lightnet container.
- AC3: Both run weekly (not nightly — too long); failures alert but don't block PRs.
- AC4: Operator docs note the per-chain support matrix.

**Files.** Per AC.

**Dependencies.** Story 42.2.

---

### Story 42.4: `connector home-init` operator script

**Goal.** A single CLI command that walks a stranger through the home-hosting setup, end to end.

**AC.**
- AC1: `connector home-init` is interactive: prints next-step prompts; doesn't require operator to read docs.
- AC2: Steps:
  1. Detect environment (Docker available, network connectivity).
  2. Generate `toon.json` template (operator chooses kind set, pricing, settlement chain).
  3. Open admin UI in browser; prompt for passkey ceremony + recovery passkey.
  4. Provision derived keys via Epic 40 plumbing.
  5. Boot ATOR (Epic 35); wait for `.anon` URL.
  6. Publish kind:30400 (Epic 41).
  7. Print the `.anon` URL + ILP address + how to verify discoverability.
- AC3: Time-to-first-published-event ≤ 5 minutes on a clean Pi.
- AC4: All errors handled with actionable messages (not raw stack traces).

**Files.** `packages/connector/src/cli/home-init.ts`; existing `cli/onboarding-wizard.ts` may share helpers.

**Dependencies.** Stories 42.1, 42.2 + epics 35/38/39/40/41.

---

### Story 42.5: `docs/operators/home-hosting.md` reference deployment guide

**Goal.** A cold-readable guide that takes a developer from "I have a Pi and a passkey" to "I'm receiving paid ILP packets" without the developer asking for help.

**AC.**
- AC1: Hardware shopping list: Pi model, SD card, network requirements, optional UPS.
- AC2: Step-by-step from OS install through first paid packet.
- AC3: Reference `connector home-init` (Story 42.4) as the canonical setup path.
- AC4: Troubleshooting section covering the top 10 failure modes from Story 42.7 rollback drills.
- AC5: External-developer dry-run: at least one developer (not on the connector team) follows the guide cold and reaches first-paid-packet within a documented time bound (target: ≤ 60 minutes from boot).

**Files.** `docs/operators/home-hosting.md`.

**Dependencies.** Stories 42.4, 42.7.

---

### Story 42.6: Performance baseline + ratchet metric in nightly CI

**Goal.** Measure end-to-end latency and throughput from the acceptance test; publish a ratchet number that future PRs can't regress.

**AC.**
- AC1: Metrics captured: P50/P99 PREPARE→FULFILL latency; settlement-trigger latency; per-component breakdown (Schnorr verify, nonce store, HTTP delivery, response).
- AC2: Baseline established on first green run; recorded in `docs/operators/home-hosting-performance.md`.
- AC3: Nightly run compares against baseline; PR fails if P99 latency regresses by >20%.
- AC4: Telemetry sent to existing OTel collector with `acceptance.home_hosting.*` namespace.

**Files.** `packages/connector/test/integration/acceptance.home-hosting.spec.ts` (extends 42.2); doc.

**Dependencies.** Story 42.2.

---

### Story 42.7: Rollback drills (failure-mode coverage)

**Goal.** Simulate the most likely production failure modes; verify the connector either self-recovers or fails safely.

**AC.**
- AC1: ATOR outage simulation: kill `anon` mid-acceptance; assert connector recovers when ATOR restarts.
- AC2: App crash simulation: kill strfry mid-PREPARE; assert in-flight nonce row reaped after `max_in_flight_seconds`; idempotent retry succeeds.
- AC3: Passkey-loss simulation: invalidate primary passkey; assert recovery passkey unlocks all derivations.
- AC4: Connector restart simulation: kill connector mid-settlement; assert SettlementMonitor resumes from persisted state and crosses threshold on next claim.
- AC5: Each drill becomes a named test in `packages/connector/test/integration/acceptance.rollback.*.spec.ts`.

**Files.** Per AC.

**Dependencies.** Story 42.2.

---

### Story 42.8: Existing-operator upgrade acceptance test

**Goal.** Mirror Story 42.2's acceptance test, but starting from an *existing operator* with seed-phrase identity, active settlement channels, and v1 envelope. Verify the operator can complete the migration playbook (Epic 43 Story 43.4) without service interruption and end up with the same end-state as a fresh-deploy operator.

**AC.**
- AC1: Test name: `acceptance.existing-operator-upgrade.spec.ts` in `packages/connector/test/integration/`.
- AC2: Setup: connector with seed-phrase identity, two active EVM settlement channels with non-zero balance, v1 envelope, bearer auth on admin API. Mirrors a real v1 production deployment.
- AC3: Run the migration playbook automation (Epic 43 Story 43.4 commands) end-to-end:
  1. Upgrade connector binary; verify health.
  2. Enable telemetry.
  3. Register passkey + recovery; link to existing identity (Epic 43 Story 43.3).
  4. Flip envelope to `'toon-event'`; verify ILP packet through new path settles correctly.
  5. Enable RFC 9421 on admin API; verify operator can still hit admin endpoints.
  6. Enable RFC 9421 per-peer for one peer; verify bilateral works.
  7. Switch to `auth.signingKeySource: 'passkey-prf'`.
  8. Opt-in to `discovery.publish: true`.
- AC4: Throughout the migration, the operator must be able to send and receive ILP packets — measured via background traffic generator that runs continuously through the test. Zero failed packets allowed during migration.
- AC5: At the end, the operator state matches Story 42.2's fresh-deploy end-state (telemetry, both keys linked, all flags new, discovery published).
- AC6: Test runs weekly (not nightly — too long); failures alert but don't block PRs.

**Files.** `packages/connector/test/integration/acceptance.existing-operator-upgrade.spec.ts`.

**Dependencies.** Stories 42.2, 42.4. Epic 43 Stories 43.3 + 43.4.

---

## Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Test takes too long to run nightly (>30 min total) | Medium | Medium | Parallelise where possible; drop Solana/Mina from nightly (run weekly); time-budget per story |
| Dependent epic slippage cascades | High | High | This epic ships LAST. Its story is "wire what's already there." If a dependency slips, this epic slips proportionally |
| External-developer dry-run fails to find docs gaps | Medium | Medium | Recruit at least 2 external developers; document gaps as backlog for Story 42.5 |
| Ratchet metric is too aggressive and blocks legitimate PRs | Low | Low | Tunable threshold; start at 20%; relax to 30% if too noisy |
| Pi-class CI environment underestimates real Pi performance | Low | Medium | Periodically validate against real Pi 4/5 hardware; calibrate thresholds |

---

## Definition of Done

- The binary acceptance test from the north star answers "yes" — verified by nightly CI and at least one external-developer cold run within the documented time bound.
- All seven stories shipped.
- Performance baseline + ratchet metric live in nightly CI.
- Rollback drills cover the named failure modes.
- `docs/operators/home-hosting.md` is cold-readable and validated by external dry-run.
- Solana + Mina parity tests added (or explicitly deferred to v2 in roadmap).

## Estimated Total Effort

8 stories. Estimate range: 1–1.5 sprints (2–3 weeks at 2-week cadence) for a single dedicated engineer, **assuming all dependencies (Epics 35, 38, 39, 40, 41, 43) are green when this epic starts.** Slippage in any prior epic delays this proportionally. Story 42.8 (existing-operator upgrade) requires Epic 43 Stories 43.3 + 43.4.

## Test design

Separate doc `test-design-epic-42.md` (TBD). The acceptance test in this epic IS the test design — it's the load-bearing artifact.

---

## Success criterion (the binary north-star answer)

**`make acceptance-home-hosting` returns exit code 0 in nightly CI for at least 7 consecutive nights.**

That's the criterion. When it passes, the connector has met its strategic goal. When it fails, the goal is not yet met. There is no partial credit.
