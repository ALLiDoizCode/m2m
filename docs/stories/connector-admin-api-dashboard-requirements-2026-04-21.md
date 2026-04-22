# Connector Admin API — Dashboard Requirements

**Author:** Town project (Epic 21, Story 21.8 — Fastify REST + WebSocket Metrics API)
**Audience:** `@toon-protocol/connector` maintainers
**Date:** 2026-04-21
**Status:** Proposed — awaiting connector-team review
**Consumer:** `packages/townhouse` (node-operator dashboard) in the `town` repo

---

## 1. Context

Epic 21 (Townhouse) builds a node-operator dashboard that binds to `127.0.0.1:9400` and surfaces the live state of the operator's local Town / Mill / DVM nodes. The dashboard reads **exclusively** from the connector's admin API — the dashboard never talks to the BLS containers directly for metrics.

Story 21.8 (Fastify REST + WebSocket Metrics API) exposes five routes to the dashboard SPA:

- `GET /nodes` — one row per node type
- `GET /nodes/:type` — detail including a `metrics` object
- `PATCH /nodes/:type/config` — mutate runtime fee / enabled flags
- `GET /wallet` — address-only key summary
- `WS /metrics` — 1 Hz push of live metrics + `containerState` / `pullProgress` / `connectorRestarted` events + 15 s heartbeat

During code review of the 21.8 implementation, the review panel found that the `MetricsPayload` shape the dashboard was designed against (`uptimeSeconds`, `eventsReceived`, `eventsWritten`, `peers`, `credits`, `debits`) does not match anything the connector currently exposes on its admin surface. This document records what the dashboard _needs_, what the connector _has_, and a concrete proposal for the gap.

---

## 2. What the connector exposes today

Verified from `packages/connector/src/http/` in the connector repo at `/home/jonathan/Documents/connector` (v2.3.0 line).

### 2.1 `health-server.ts` (public-ish, port defaults to 9096)

| Route           | Method | Shape                                                                                 |
| --------------- | ------ | ------------------------------------------------------------------------------------- |
| `/health`       | GET    | `{ status: 'healthy' \| 'unhealthy', uptime: number, … }`                             |
| `/health/live`  | GET    | liveness probe                                                                        |
| `/health/ready` | GET    | readiness probe                                                                       |
| `/metrics`      | GET    | **Prometheus text format** via pluggable `metricsMiddleware` (`health-server.ts:133`) |

### 2.2 `admin-api.ts` (mounted at `/admin`, protected by API-key allowlist)

| Route                                | Method       | Purpose                           |
| ------------------------------------ | ------------ | --------------------------------- |
| `/admin/peers`                       | GET / POST   | list / add peers                  |
| `/admin/peers/:peerId`               | PUT / DELETE | update / remove peer              |
| `/admin/routes`                      | GET / POST   | routing table read / write        |
| `/admin/routes/:prefix`              | DELETE       | withdraw route                    |
| `/admin/channels`                    | GET / POST   | list / open payment channels      |
| `/admin/channels/:channelId`         | GET          | channel state (on-chain enriched) |
| `/admin/channels/:channelId/deposit` | POST         | add deposit                       |
| `/admin/channels/:channelId/close`   | POST         | initiate close                    |
| `/admin/channels/:channelId/claims`  | GET          | list claim events                 |
| `/admin/balances/:peerId`            | GET          | per-peer ILP balance              |
| `/admin/settlement/states`           | GET          | global settlement state           |
| `/admin/ilp/send`                    | POST         | send an ILP packet                |

### 2.3 Example response: `GET /admin/balances/:peerId`

```json
{
  "peerId": "town",
  "balances": [
    {
      "tokenId": "M2M",
      "debitBalance": "15000",
      "creditBalance": "22000",
      "netBalance": "7000"
    }
  ]
}
```

### 2.4 Example response: `GET /admin/channels`

```json
[
  {
    "channelId": "0xabc…",
    "peerId": "town",
    "chain": "ethereum",
    "status": "open",
    "deposit": "1000000000000000000",
    "lastActivity": "2026-04-21T10:30:00.000Z"
  }
]
```

---

## 3. What `@toon-protocol/connector`'s current `ConnectorAdminClient` wrapper in townhouse expects

The townhouse wrapper at `packages/townhouse/src/connector/admin-client.ts` (added in Story 21.3) today treats `/metrics` as JSON with this strict shape:

```ts
interface MetricsResponse {
  packetsForwarded: number;
  packetsRejected: number;
  bytesSent: number;
}
```

**This is incorrect against the real connector.** The connector's `/metrics` ships Prometheus text format, not JSON. The townhouse wrapper's `response.json()` call will either throw on the `text/plain; version=0.0.4` content-type, or silently receive garbage. This is a pre-existing defect in Story 21.3 that 21.8 inherited.

---

## 4. What the dashboard actually needs

From Story 21.8 Acceptance Criteria + the Dev Notes "per-node attribution" discussion:

| Dashboard field                         | Semantic                                | Current source                                              | Status                    |
| --------------------------------------- | --------------------------------------- | ----------------------------------------------------------- | ------------------------- |
| Connector uptime (seconds)              | healthcheck                             | `/health.uptime`                                            | ✅ available              |
| Total packets forwarded (aggregate)     | observability                           | Prometheus `/metrics`                                       | ⚠️ available but not JSON |
| Total packets rejected (aggregate)      | observability                           | Prometheus `/metrics`                                       | ⚠️ same                   |
| Total bytes sent (aggregate)            | observability                           | Prometheus `/metrics`                                       | ⚠️ same                   |
| **Per-peer packets forwarded**          | attribution for "this DVM earned X"     | _not exposed_                                               | ❌ missing                |
| **Per-peer packets rejected**           | attribution for "this peer is erroring" | _not exposed_                                               | ❌ missing                |
| **Per-peer credit / debit balance**     | per-node earnings                       | `/admin/balances/:peerId`                                   | ✅ available              |
| **Per-peer channel list + deposit**     | liquidity view                          | `/admin/channels?peerId=…`                                  | ✅ available              |
| Channel claim history                   | settlement audit                        | `/admin/channels/:id/claims`                                | ✅ available              |
| Peer connectivity state                 | "is mill reachable?"                    | `/admin/peers` (existing `connected` field in `PeerStatus`) | ✅ available              |
| Connector restart / state events (push) | real-time dashboard                     | _polling only_                                              | ❌ missing (see §5.3)     |

The dashboard is content to read **per-peer attribution** rather than "events received / events written" semantics — the renamings in the 21.8 `MetricsPayload` were speculative and are being withdrawn.

---

## 5. Requested additions / clarifications for the connector team

Three asks, ranked by dashboard impact.

### 5.1 **ASK 1 (blocking for dashboard MVP) — JSON metrics endpoint with per-peer attribution**

Add a JSON-shaped endpoint alongside the Prometheus `/metrics` so browser / Node JS clients can consume metrics without an OpenMetrics parser.

**Proposed route:** `GET /admin/metrics.json` (or `/admin/stats`, name your choice — we'll match it).

**Proposed response shape:**

```ts
interface AdminMetricsJson {
  uptimeSeconds: number; // connector process uptime
  aggregate: {
    packetsForwarded: number;
    packetsRejected: number;
    bytesSent: number;
    bytesReceived: number; // nice-to-have
  };
  peers: Array<{
    peerId: string;
    connected: boolean;
    packetsForwarded: number; // per-peer attribution
    packetsRejected: number;
    bytesSent: number;
    bytesReceived: number;
    lastPacketAt: string | null; // ISO-8601, null if never
  }>;
  timestamp: string; // ISO-8601, server wall-clock
}
```

**Rationale.** The per-peer counters are the only piece the dashboard cannot reconstruct from what's already there. `/admin/peers` gives connected-state but no counters. `/admin/balances/:peerId` gives _money_ but not _packets_. Operators will ask "is my mill actually routing anything?" — that needs per-peer packets, not aggregate.

**Implementation hint.** The Prometheus collector already tracks per-peer counters by label (the Prometheus `/metrics` output will contain lines like `toon_packets_forwarded{peer="town"} 42`). Exposing the same map as JSON is a straightforward adapter over the existing registry.

**Acceptance test the dashboard will run.** `curl http://127.0.0.1:$ADMIN_PORT/admin/metrics.json` returns a parseable JSON body with `peers[].packetsForwarded` ≥ 0 for each registered peer within 500 ms.

### 5.2 **ASK 2 (blocking for a specific 21.8 test case) — confirm or fix `GET /admin/balances/:peerId` error semantics**

The dashboard needs to distinguish three states:

1. Peer exists and has a balance → `200` with body.
2. Peer exists but has no ledger entries yet → should be `200` with all-zero balances, **not** `404`.
3. Peer does not exist → `404` with `{ error, peerId }`.

The current implementation at `admin-api.ts:1392` returns `503` when `accountManager` is not wired up. Please confirm:

- Is `accountManager` wired up in the standalone connector image that townhouse runs? (If not, townhouse can't rely on this endpoint.)
- What status does the endpoint return for an **unknown peerId** vs. a **known peerId with no activity**?

If the current behavior collapses both cases into `503` or `500`, please separate them.

### 5.3 **ASK 3 (nice-to-have, non-blocking) — server-push channel for lifecycle events**

Today 21.8 polls `/health` and `/admin/metrics.json` every second. For lifecycle events (peer connected / disconnected, channel opened / closed, settlement occurred) polling wastes CPU and adds up-to-1 s latency.

If the connector team has bandwidth, consider:

- **Option A — Server-Sent Events** at `GET /admin/events` emitting `{ type, peerId?, channelId?, payload, ts }` frames on peer state, channel state, settlement, and fraud-alert transitions.
- **Option B — WebSocket** at `WS /admin/events` with the same envelope.

Either is strictly additive and doesn't change existing endpoints. If neither is feasible now, the dashboard will poll — functional, just less crisp.

---

## 6. Non-asks / explicitly out of scope

- The dashboard does **not** need the connector to add auth UX beyond the existing API-key allowlist. 21.8 runs behind a loopback bind + CORS localhost-only allowlist; the API key is shared with the operator's local CLI config.
- The dashboard does **not** need per-packet event streaming — per-peer counters at 1 Hz granularity are enough.
- The dashboard does **not** need historical time-series. Grafana / Prometheus already covers that via the existing `/metrics`.
- The dashboard does **not** need the connector to change the Prometheus `/metrics` shape. Keep it; add JSON alongside.

---

## 7. Town-side follow-up regardless of connector changes

These are fixes the town team will make in `packages/townhouse/src/connector/admin-client.ts` **independently** of this request, so the connector team can schedule on their own cadence:

1. Fix the `getMetrics()` JSON-parsing bug — detect `text/plain` Prometheus output and either parse it or route to the new `/admin/metrics.json` once it lands.
2. Extend `ConnectorAdminClient` with wrappers for `/admin/balances/:peerId`, `/admin/channels` (list + filter by peerId), `/admin/channels/:channelId`. These already exist on the connector; the wrapper class is just catching up.
3. Narrow the 21.8 `MetricsPayload` to the shape that actually exists today (`packetsForwarded / packetsRejected / bytesSent` + an `attribution: 'aggregate'` label) until Ask 1 lands; then expand to `{ aggregate, peers[] }`.

Follow-up tracking will be a new story in Epic 21 (tentatively `21.8.5 — ConnectorAdminClient v2`).

---

## 8. Summary of asks

| Ask                                                                                                            | Priority | Change kind                    | Blocks                                    |
| -------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------ | ----------------------------------------- |
| 1. JSON metrics endpoint with per-peer attribution                                                             | **P0**   | Additive route                 | Dashboard MVP "per-node earnings" panel   |
| 2. Clarify `/admin/balances/:peerId` error semantics and `accountManager` availability in the standalone image | **P1**   | Doc + possibly status-code fix | Dashboard "degraded when unknown peer" UX |
| 3. Server-push lifecycle events (SSE or WS)                                                                    | **P2**   | Additive route                 | Nothing — polling works                   |

---

## 9. Contact

- **Town-side owner of this doc:** Epic 21 (Townhouse). Source of truth lives in the `town` repo at `/home/jonathan/Documents/town`.
  - Story file: `_bmad-output/implementation-artifacts/21-8-fastify-rest-websocket-metrics-api.md` (§ "Review Findings" captures the decision that produced this ask)
  - Epic: `_bmad-output/planning-artifacts/epics.md` § Epic 21
  - Relevant town source:
    - `packages/townhouse/src/api/routes/nodes.ts`
    - `packages/townhouse/src/api/routes/metrics-ws.ts`
    - `packages/townhouse/src/connector/admin-client.ts`
- **Connector-side files referenced in §§2 & 5** (paths in this repo):
  - `packages/connector/src/http/admin-api.ts` — existing `/admin/*` routes
  - `packages/connector/src/http/health-server.ts` — Prometheus middleware mount point (§5.1 adapter target)
  - `packages/connector/src/settlement/metrics-collector.ts` — existing per-peer counter source the JSON endpoint can reuse
- **How to respond:** append decisions / scheduling notes directly to this file under a new `## 10. Connector-team response` section, or open a PR in the `town` repo against the story file's "Review Findings" block.
