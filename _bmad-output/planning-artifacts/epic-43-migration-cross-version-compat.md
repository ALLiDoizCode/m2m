# Epic 43: Migration & Cross-Version Compatibility

**Date:** 2026-05-01
**Author:** Jonathan (with BMAD multi-agent roundtable)
**Status:** Draft
**Dependencies:** Epics 38, 39, 40, 41 — this epic owns the cross-cutting migration concerns that span all of them. Most stories can run in parallel with delivery of the source epics; some land near the end of the migration window.
**Type:** Cross-cutting infrastructure + ops + docs
**North-star tier served:** All — protects the existing operator base while T1/T2/T3 are rolled out

---

## Executive Summary

Epics 38, 39, 40, and 41 each ship behind config flags with default-off / soak-window / flip-default migration patterns. That's necessary but not sufficient. Three things fall through the cracks if no epic owns them:

1. **Telemetry to drive the flip-default decisions.** Every epic has a "soak then flip" plan; none owns the metrics that say "soak is over, flip is safe."
2. **Cross-version compatibility under realistic mixed deployments.** Epic 38's bilateral peer can be on `auth: "either"`. Epic 39's envelope can be v1 or v2. Epic 40's signing key can be KMS or passkey-derived. The matrix of "which combinations actually work in a real bilateral pair" is not tested anywhere.
3. **Existing-operator on-chain identity migration.** Epic 40 Story 40.12 AC2 hand-waves "verifies derived keys match existing on-chain identities." If they don't match (and they won't for a fresh PRF), the operator has to fund-migrate, close channels, etc. That tooling does not exist.

This epic owns those concerns plus the unified operator migration playbook and rollback procedures. Without it, each individual epic's migration plan would be locally correct but globally fragile — the kind of system where every component is in spec and the integration is broken.

### Why a separate epic and not stories scattered across 38–41

- **Cross-cutting concern.** Telemetry has to span all four migration flags; one epic to look at, not four.
- **Compat test matrix is multiplicative.** Each epic tests its own flag in isolation. The matrix of all flag combinations is its own test surface.
- **On-chain identity migration is load-bearing for everything.** It blocks Epic 40's adoption; affects how Epic 38's per-peer config is keyed; affects how Epic 41's discovery events are signed.
- **Operator playbook is one document.** Five separate migration sections in five separate epic docs is operator-hostile.

### What's NOT in this epic

- Per-epic migration flags / soak windows (each source epic owns its own).
- The rollout schedule itself (sprint planning).
- Marketing / change-communication to operators (separate go-to-market motion).
- Test design for individual epics (those are paired with each epic; this epic adds the cross-version matrix test).

---

## Architecture (concerns + dataflow)

### The migration surface in one diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  Five migration flags across four epics:                             │
│                                                                       │
│  Epic 38  auth.adminApi.mode:    rfc9421 | legacy   | either         │
│           auth.peer.<id>.mode:   rfc9421 | mtls     | either         │
│           localDelivery.signing: enabled | disabled                  │
│  Epic 39  localDelivery.envelope: payment-request | toon-event       │
│  Epic 40  auth.signingKeySource: kms     | passkey-prf               │
│  Epic 41  discovery.publish:     true    | false (opt-in)            │
└──────────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Epic 43 — what this epic owns                                       │
│                                                                       │
│  ┌─ Telemetry ───────────────────────────────────────────────────┐   │
│  │  Per-flag adoption metrics (op_count, success_rate)           │   │
│  │  Aggregated dashboard surface in admin UI                     │   │
│  │  Flip-default decision protocol with thresholds               │   │
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  ┌─ Cross-version compat matrix ────────────────────────────────┐    │
│  │  Test every realistic combination of the five flags          │    │
│  │  in CI; assert FULFILL/REJECT correctness end-to-end         │    │
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  ┌─ On-chain identity migration ──────────────────────────────────┐  │
│  │  Tooling to bridge existing seed-derived chain identities     │  │
│  │  to passkey-derived ones without fund migration               │  │
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  ┌─ Unified migration playbook ──────────────────────────────────┐   │
│  │  Single doc walking an existing operator through full upgrade │   │
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  ┌─ Rollback procedures ─────────────────────────────────────────┐   │
│  │  Per-flag rollback triggers, who-decides, recovery steps      │   │
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  ┌─ Sunset & deprecation timeline ───────────────────────────────┐   │
│  │  Once flags flip default, lint + CI prevents regression to    │   │
│  │  legacy paths; eventual code removal in a major release       │   │
│  └────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Stories

### Story 43.1: Migration telemetry instrumentation

**Goal.** Per-flag adoption metrics; dashboard surface; flip-default decision protocol.

**AC.**
- AC1: Each migration flag emits an OTel counter on every operation: `connector.migration.flag.<name>.{accept,reject,error}` with `value=<flag-value>` attribute.
- AC2: Per-bilateral-peer attribution: counters tagged with peer ID for the auth/peer flags.
- AC3: New admin endpoint: `GET /admin/api/migration/status` returns aggregated adoption per flag (24h window): `{ flag, total_ops, distribution: {value: count}, success_rate: number }`.
- AC4: Admin UI surface: "Migration Status" panel showing each flag's adoption %, recent trend, flip-default readiness indicator.
- AC5: Flip-default decision protocol documented in `docs/operators/migration-decision-protocol.md`: "flip default on flag X when (a) >90% of operations use the new value, (b) success rate of new value within 0.5% of old, (c) ≥ 14 consecutive days at threshold."
- AC6: Telemetry retention: 90 days minimum; older data downsampled to daily aggregates.

**Files.** `packages/connector/src/observability/migration-metrics.ts`, `packages/connector/src/admin/migration-status-api.ts`, `docs/operators/migration-decision-protocol.md`, admin UI panel.

**Dependencies.** Epics 38, 39, 40, 41 each provide their flag instrumentation hooks.

---

### Story 43.2: Cross-version compatibility test matrix

**Goal.** Test every realistic combination of the five migration flags in CI. Asserts FULFILL/REJECT correctness end-to-end across mixed bilateral pairs.

**AC.**
- AC1: Test harness in `packages/connector/test/integration/migration-compat-matrix.ts` parameterised on the five flags.
- AC2: Realistic combinations enumerated:
  - v1 connector (all flags legacy) ↔ v1 connector — must work (existing baseline)
  - v2 connector (all flags new) ↔ v2 connector — must work
  - v2 ↔ v1 with `either` modes set on v2 — must work (gradual rollout)
  - v2 envelope (Epic 39) sent to v1 BLS — must reject cleanly with documented error code
  - v1 envelope sent to v2 app expecting v2 — must reject cleanly
  - KMS signing key (Epic 40) verified by passkey-derived peer's verifier — must work (verifier doesn't care about key source, only that JWKS validates)
  - passkey-derived signing key from peer A verified by passkey-derived verifier from peer B — must work
  - Discovery on (Epic 41) + direct peering coexisting — must work; same peer reachable two ways resolves to one identity
- AC3: Matrix combinations that MUST fail return specific error codes (no silent failures).
- AC4: Test runs in nightly HTTP-surface CI; matrix expansion does not exceed 30 minutes wall-clock total.
- AC5: Adding a new migration flag requires extending this matrix; documented in `docs/contributors/adding-migration-flag.md`.

**Files.** `packages/connector/test/integration/migration-compat-matrix.ts`, helper fixtures, `docs/contributors/adding-migration-flag.md`.

**Dependencies.** All four source epics' flags must be instrumented before full matrix; partial matrix possible earlier.

---

### Story 43.3: On-chain identity migration tooling

**Goal.** Resolve Epic 40 Story 40.12 AC2. Provide a tool that lets existing operators with seed-derived chain identities migrate to passkey-derived without closing channels and re-funding.

**Approach options (story planning picks one):**

**Option A — Identity attestation via channel update.** New on-chain message type that lets a channel participant attest "from now on, my new pubkey is X" — channel contract verifies signature from old pubkey, accepts new pubkey for future claims. Requires contract changes on EVM/Solana/Mina. Highest engineering cost, cleanest UX.

**Option B — Documented fund-migration playbook.** Operator opens new channels with passkey-derived identity, drains old channels via `claimFromChannel` to a holding wallet, transfers funds, opens new channels. No contract changes. High operator friction; works today.

**Option C — Layered identity (recommended).** Connector tracks both keys per operator. Old key signs old channels; new key signs new channels. Operator gradually moves volume to new channels; old channels close on natural expiry. Connector treats both as the same operator identity for routing/discovery purposes. Lowest engineering cost; takes a settlement cycle to fully migrate; no contract changes.

**AC (assuming Option C).**
- AC1: New table `operator_identity_links`: `(operator_id, key_role, key_pubkey, derived_from, valid_from, valid_until)`. Multiple active keys per operator-role allowed.
- AC2: BTP claim signing: connector accepts claims signed by ANY pubkey listed for the operator-role at the BTP layer.
- AC3: New admin API: `POST /admin/api/identity/link-passkey` — links a passkey-derived key to an existing operator identity; verified by signing a challenge with both old and new keys.
- AC4: Routing / discovery: passkey-derived identity is treated as equivalent to seed-derived identity for the purpose of inbound packet attribution.
- AC5: Settlement: claims arriving on old channels settle to old identity; claims on new channels settle to new identity; operator dashboards aggregate both.
- AC6: Expiry: legacy seed-derived key marked `valid_until` on operator-initiated cutover; defaults to "indefinite until operator closes."
- AC7: Migration test: existing operator can register a passkey, link it, immediately operate, and have all packets attributed correctly across both key sources.

**Files.** `packages/connector/src/auth/identity-link.ts`, `packages/connector/src/db/schema/operator-identity-links.sql`, admin API + UI.

**Dependencies.** Epic 40 Story 40.12 (uses this tooling instead of hand-waving AC2).

---

### Story 43.4: Unified operator migration playbook

**Goal.** Single doc that walks an existing operator from "v1 connector with seed-phrase identity" to "v2 connector with passkey-PRF, signed transports, discovery enabled" without service interruption.

**AC.**
- AC1: New doc `docs/operators/migration-from-v1.md`.
- AC2: Step-by-step ordered sequence:
  1. Upgrade connector binary; verify health (no flag changes yet).
  2. Enable telemetry (from Story 43.1).
  3. Register passkey + recovery passkey (Epic 40); link to existing identity (Story 43.3).
  4. Flip `localDelivery.envelope` to `'toon-event'` for one node; verify; expand.
  5. Enable RFC 9421 on admin API (`auth.adminApi.mode: 'either'`); verify; flip to `'rfc9421'`.
  6. Enable RFC 9421 per-peer (`auth.peer.<id>.mode: 'either'`); coordinate with each peer; flip per-peer.
  7. Enable `localDelivery.signing.enabled: true`; coordinate with apps.
  8. Enable `auth.signingKeySource: 'passkey-prf'` once passkey adoption is verified.
  9. Opt-in to `discovery.publish: true` if desired.
- AC3: Each step has: prerequisite check, command(s) to run, verification command, rollback command.
- AC4: Time estimate per step; total migration ≤ 4 hours of operator-time (parallel work allowed; some steps need peer coordination).
- AC5: Section: "If this step fails" — common errors with diagnoses.
- AC6: External-operator validation: at least one operator (not on the connector team) follows the playbook cold and reaches the end without help.

**Files.** `docs/operators/migration-from-v1.md`.

**Dependencies.** Stories 43.1, 43.3.

---

### Story 43.5: Rollback procedures with explicit triggers

**Goal.** Per-flag rollback triggers, decision authority, and recovery steps. If the new path has bugs in production, what's the playbook?

**AC.**
- AC1: New doc `docs/operators/rollback-procedures.md`.
- AC2: Per migration flag, document:
  - **Triggers**: signal patterns that warrant rollback (e.g., "signature verification rejection rate > 5% sustained 5 minutes").
  - **Decision authority**: who can decide to rollback (operator vs. team lead vs. emergency).
  - **Mechanism**: exact config command to roll back (config edit + connector reload, or hot-reload depending on flag).
  - **Verification**: how to confirm rollback succeeded.
  - **Recovery**: what state remains; what gets re-applied; whether downstream peers need re-coordination.
- AC3: For irreversible state changes (e.g., on-chain identity link), document explicitly: "this cannot be cleanly rolled back; mitigation is X."
- AC4: Tabletop exercise: connector team rehearses rollback for each flag at least once before that flag's flip-default ships.
- AC5: Stop-the-line escalation hooks: rollback decisions for production-impacting flags trigger the existing nightly stop-the-line policy.

**Files.** `docs/operators/rollback-procedures.md`, optional CLI helper `packages/connector/src/cli/rollback.ts`.

---

### Story 43.6: Sunset & deprecation timeline + CI lint

**Goal.** Once each migration flag flips default, prevent regression to legacy paths and define a removal date.

**AC.**
- AC1: New doc `docs/operators/deprecation-timeline.md` with one row per migration flag:
  - Default-flipped date (when the new value became default).
  - Sunset date (when the legacy value is removed entirely; recommend 6 months after default-flip).
  - Affected code paths.
  - Migration deadline communicated to operators.
- AC2: CI lint: PRs that re-enable default-off on a flipped flag fail CI unless the PR title contains `[migration-rollback]` (escape hatch for emergencies).
- AC3: Code-level deprecation: legacy code paths annotated `@deprecated since-X.Y, remove in Z.0`; CI surfaces these.
- AC4: At sunset date, remove legacy code paths in a single major-version release; legacy config flags raise startup error with link to migration guide.
- AC5: Telemetry alert when fewer than 1% of operations still use legacy path — flips the project from "actively migrating" to "ready to sunset."

**Files.** `docs/operators/deprecation-timeline.md`, `scripts/lint-migration-defaults.sh`, code annotations across affected modules.

**Dependencies.** Stories 43.1 (telemetry to feed the alert), 43.4 (playbook deadline communication).

---

## Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Cross-version compat matrix becomes stale as flags evolve | High | Medium | Story 43.2 AC5: contributor doc requires matrix extension on new flag |
| On-chain identity migration tooling has on-chain bugs | Low | Catastrophic | Option C avoids contract changes; testnet rehearsal mandatory before mainnet rollout |
| Operator confusion across migration steps | High | Medium | Story 43.4 AC6: external-operator validation; clear ordering with rollback per step |
| Telemetry overhead degrades hot path | Low | Medium | Story 43.1 emits via async OTel; no synchronous instrumentation in PREPARE→FULFILL path |
| Rollback for irreversible flags (identity link) creates orphaned state | Medium | Medium | Story 43.5 AC3: document explicitly; include "what to do if you can't rollback" recovery |
| Sunset removed legacy code while a peer still uses it | Low | High | Telemetry alert (Story 43.6 AC5) gates the sunset; deprecation timeline communicated 6 months ahead |

---

## Definition of Done

- All 6 stories shipped.
- Migration telemetry live for all five flags; admin UI shows adoption %.
- Cross-version compat matrix runs in nightly CI; covers all realistic flag combinations.
- On-chain identity migration tooling lets at least one existing operator migrate to passkey-PRF without closing channels.
- Unified migration playbook validated by external operator dry-run.
- Rollback procedures documented and tabletop-rehearsed for each flag.
- Deprecation timeline published; CI lint prevents regression.

## Estimated Total Effort

6 stories. Estimate range: 2–3 sprints (4–6 weeks at 2-week cadence). Story 43.3 is the single largest piece — Option C alone is ~1 sprint, mostly schema + admin API + linker logic. Other stories are 0.25–0.5 sprint each.

This epic runs **in parallel** with Epics 38–41 starting around their second sprint, lands its core stories before the first flip-default decision, and lands its sunset/lint stories after the last default-flip.

## Test design

Separate doc `test-design-epic-43.md` (TBD when this epic enters delivery).
