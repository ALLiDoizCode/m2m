# Epic 37: Admin API Observability for Townhouse Dashboard

**Status:** done (retro 2026-04-21, see `_bmad-output/implementation-artifacts/epic-37-retro-2026-04-21.md`)
**Owner:** connector team
**Cross-team request:** Town project, Epic 21 Story 21.8 (Townhouse dashboard)
**Source documents (canonical decision log):**

- `docs/stories/connector-admin-api-dashboard-requirements-2026-04-21.md` (Town request)
- `docs/stories/connector-admin-api-dashboard-response-2026-04-21.md` (cross-team decision log, authoritative)

## Goal

Unblock the Townhouse node-operator dashboard by (a) adding per-peer packet/byte attribution metrics the dashboard can consume over JSON, (b) fixing a latent defect in the balances endpoint that collapses "unknown peer" and "idle peer" into a single 200 response, and (c) closing the long-standing bug where the connector's Prometheus `/metrics` slot has never been wired to an actual metrics registry.

## Scope summary

### Original scope (planned)

| Story | Title | Size | Depends on |
|---|---|---|---|
| 37.1 | Balances endpoint: 404 on unknown peer | S | — |
| 37.2 | Wire `prom-client` + per-peer ILP counters + `/metrics` middleware | M | — |
| 37.3 | `GET /admin/metrics.json` JSON projection for dashboard | S | 37.2 |

37.1 and 37.2 are parallelizable. 37.3 blocks on 37.2.

### Scope additions during execution

The epic grew from 3 to 9 stories during execution. 37.4 was a direct extension of the Townhouse dashboard ask (per-peer earnings, requested after 37.3 shipped). 37.5–37.9 are accounting/metric correctness fixes uncovered while wiring the per-peer counters and earnings projection — they were too tightly coupled to ship separately because the dashboard JSON would have surfaced incorrect values without them.

| Story | Title | Size | Depends on | Why added |
|---|---|---|---|---|
| 37.4 | `GET /admin/earnings.json` — per-peer earnings projection | M | 37.3 | Town follow-up ask after 37.3 ship; same auth/middleware surface |
| 37.5 | Fix `AccountManager.checkCreditLimit` sign mismatch (bug) | S | — | Discovered while validating earnings math in 37.4; would mis-report on credit-limited peers |
| 37.6 | Dedicated `ConnectorFee` TigerBeetle account with cross-peer double-entry | M | 37.5 | Required for 37.4's earnings figures to balance against on-chain settlements |
| 37.7 | Outbound `claimsSentTotal` via `sent_claims` wiring | S | 37.2 | Counter slot existed but was never incremented; symmetry with inbound counters |
| 37.8 | On-chain token metadata for Solana and Mina | M | — | 37.4 earnings JSON exposes asset codes/scales; EVM had metadata, Solana/Mina did not |
| 37.9 | Denormalize `nonce` and `token_address` columns on `received_claims` (nice-to-have) | S | 37.6 | Query simplification for the dashboard projection; opportunistic |

## Auth model (locked in §10.2 of response doc)

Header-based `X-Api-Key`, reusing the existing `/admin/*` middleware. Applies to `/admin/metrics.json`. The text `/metrics` endpoint (Prometheus scrape target) stays unauthenticated per scraper convention.

## Out of scope (per §6 of response doc)

- Reshaping the existing Prometheus text output (add, don't reshape).
- Historical time-series on the connector (Grafana/Prom handles that).
- Per-packet event streaming (1 Hz polling from the dashboard is sufficient).
- SSE/WS event push (deferred — Town Ask 3, P2, re-evaluate after 37.3 ships).

## Done when

- All nine stories shipped with tests green (3 planned + 6 added during execution; see retro for cause analysis).
- Docker image verified to serve `GET /metrics` with real counter output (closes the §9.1 anomaly Town raised about the broken T-020 integration test).
- Operator docs updated to describe the new endpoints and the `X-Api-Key` requirement on `/admin/metrics.json` and `/admin/earnings.json`.
- Response doc §12 posts story completion links; Town kicks off their 21.8.5 follow-up.
