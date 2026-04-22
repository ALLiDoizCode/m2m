# Epic 37: Admin API Observability for Townhouse Dashboard

**Status:** in-progress
**Owner:** connector team
**Cross-team request:** Town project, Epic 21 Story 21.8 (Townhouse dashboard)
**Source documents (canonical decision log):**

- `docs/stories/connector-admin-api-dashboard-requirements-2026-04-21.md` (Town request)
- `docs/stories/connector-admin-api-dashboard-response-2026-04-21.md` (cross-team decision log, authoritative)

## Goal

Unblock the Townhouse node-operator dashboard by (a) adding per-peer packet/byte attribution metrics the dashboard can consume over JSON, (b) fixing a latent defect in the balances endpoint that collapses "unknown peer" and "idle peer" into a single 200 response, and (c) closing the long-standing bug where the connector's Prometheus `/metrics` slot has never been wired to an actual metrics registry.

## Scope summary

| Story | Title | Size | Depends on |
|---|---|---|---|
| 37.1 | Balances endpoint: 404 on unknown peer | S | — |
| 37.2 | Wire `prom-client` + per-peer ILP counters + `/metrics` middleware | M | — |
| 37.3 | `GET /admin/metrics.json` JSON projection for dashboard | S | 37.2 |

37.1 and 37.2 are parallelizable. 37.3 blocks on 37.2.

## Auth model (locked in §10.2 of response doc)

Header-based `X-Api-Key`, reusing the existing `/admin/*` middleware. Applies to `/admin/metrics.json`. The text `/metrics` endpoint (Prometheus scrape target) stays unauthenticated per scraper convention.

## Out of scope (per §6 of response doc)

- Reshaping the existing Prometheus text output (add, don't reshape).
- Historical time-series on the connector (Grafana/Prom handles that).
- Per-packet event streaming (1 Hz polling from the dashboard is sufficient).
- SSE/WS event push (deferred — Town Ask 3, P2, re-evaluate after 37.3 ships).

## Done when

- All three stories shipped with tests green.
- Docker image verified to serve `GET /metrics` with real counter output (closes the §9.1 anomaly Town raised about the broken T-020 integration test).
- Operator docs updated to describe the new endpoints and the `X-Api-Key` requirement on `/admin/metrics.json`.
- Response doc §12 posts story completion links; Town kicks off their 21.8.5 follow-up.
