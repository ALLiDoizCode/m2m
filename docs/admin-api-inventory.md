# Connector HTTP Endpoint Inventory

**Document ID:** `docs/admin-api-inventory.md`  
**Epic:** 38 — Comprehensive HTTP Surface E2E Test Coverage  
**Story:** 38.1 — HTTP endpoint inventory doc  
**Last Updated:** 2026-04-21

> **Historical — this inventories the retired TypeScript connector, not the one in this
> repository.** Its machine-readable source (`packages/connector/src/http/admin-api-inventory.ts`)
> was deleted with that implementation ([ADR 0017](adr/0017-the-typescript-connector-is-a-prototype.md),
> #465, #543), so nothing regenerates or checks this document any more. It remains accurate for
> the published `ghcr.io/toon-protocol/connector` image the devnet fleet still runs.
>
> **The Rust connector's HTTP surface is much smaller** and shares one port: `POST /ilp`,
> `GET /ilp/identity`, `GET /ilp/routes/price` on the client edge
> ([`docs/protocol/client-edge-spec.md`](protocol/client-edge-spec.md)), plus the bearer-gated
> reads and RFC 9421-signed writes of the operator surface
> ([`docs/operators/admin-api.md`](operators/admin-api.md),
> [ADR 0008](adr/0008-operator-surface-splits-read-from-write.md)). There is no health endpoint,
> no explorer UI and no separate admin port.

> **Purpose (as written):** Single source-of-truth enumerating every HTTP route the connector exposes. This document is the operator-facing view; the machine-readable source was `packages/connector/src/http/admin-api-inventory.ts`.

---

## Table of Contents

- [Overview](#overview)
- [Servers & Ports](#servers--ports)
- [Authentication Model](#authentication-model)
- [Inventory by Server](#inventory-by-server)
  - [AdminServer (port 8081)](#adminserver-port-8081)
  - [HealthServer (port 8080)](#healthserver-port-8080)
  - [Settlement API (HealthServer-mounted)](#settlement-api-healthserver-mounted)
- [Cross-Surface Invariant Groups](#cross-surface-invariant-groups)
- [TypeScript Contracts](#typescript-contracts)
- [Curl Examples](#curl-examples)
- [Not Covered](#not-covered)

---

## Overview

The connector exposes **23 HTTP endpoints** across **two independent HTTP servers**:

| Server         | Default Port | Mount Point                                      | Auth                              |
| -------------- | ------------ | ------------------------------------------------ | --------------------------------- |
| `AdminServer`  | 8081         | `/admin/*` + own `/health`                       | X-Api-Key + optional IP allowlist |
| `HealthServer` | 8080         | `/metrics`, `/health*`, optional `/settlement/*` | Unauthenticated                   |

> ⚠️ **Critical:** These are separate Express apps on separate ports with different auth postures. Do not assume `/health` on 8080 is the same as `/health` on 8081.

---

## Servers & Ports

### AdminServer (port 8081)

- **Purpose:** Administrative operations (peer/route/channel management)
- **Default Binding:** `0.0.0.0:8081` (configurable via `ADMIN_API_PORT`)
- **Router Mount:** `/admin/*` (all routes prefixed with `/admin`)
- **Own Health Endpoint:** `/health` at root (NOT `/admin/health`)
- **Auth:** X-Api-Key header required when `apiKey` configured; optional IP allowlist (CIDR)

### HealthServer (port 8080)

- **Purpose:** Health checks, Prometheus metrics, optional settlement API
- **Default Binding:** `0.0.0.0:8080` (configurable)
- **Routes:** Mounted at root (no prefix)
- **Auth:** Unauthenticated (designed for internal monitoring/Docker)

---

## Authentication Model

### AdminServer Authentication

When `apiKey` is configured in the connector YAML:

```yaml
adminApi:
  apiKey: '${ADMIN_API_KEY}' # Required for all /admin/* routes
  allowedIPs: # Optional CIDR allowlist
    - '10.0.0.0/8'
    - '172.16.0.0/12'
  trustProxy: true # Trust X-Forwarded-For from proxy
```

| Aspect       | Rule                                                          |
| ------------ | ------------------------------------------------------------- |
| Header       | `X-Api-Key: <key>` (must be header; query param rejected)     |
| Query Param  | **Explicitly rejected** — returns 400-equivalent              |
| IP Allowlist | Applied after API key check; supports CIDR notation           |
| Trust Proxy  | When `trustProxy: true`, uses `X-Forwarded-For` for client IP |

**Timing-safe comparison:** API keys are compared using `crypto.timingSafeEqual` to prevent timing attacks.

### HealthServer Authentication

All HealthServer routes are **unauthenticated**:

- `/metrics` — Prometheus scraping endpoint
- `/health` — Basic health status
- `/health/live` — Kubernetes liveness probe
- `/health/ready` — Kubernetes readiness probe

### Settlement Router on HealthServer

When `HealthServerConfig.settlementRouter` is provided, settlement endpoints inherit HealthServer's **unauthenticated** posture:

- `POST /settlement/execute`
- `GET /settlement/status/:peerId`

The settlement router has its own body-based `authToken` validation (if configured).

---

## Inventory by Server

### AdminServer (port 8081)

#### Peer Management

| Method   | Path                   | Auth      | Status    | Request                   | Response                                                 |
| -------- | ---------------------- | --------- | --------- | ------------------------- | -------------------------------------------------------- |
| `GET`    | `/admin/peers`         | X-Api-Key | 200       | none                      | `Array<{ id, url, connected, transport?, settlement? }>` |
| `POST`   | `/admin/peers`         | X-Api-Key | 201 / 200 | `AddPeerRequest`          | `{ id, url, connected, transport? }`                     |
| `DELETE` | `/admin/peers/:peerId` | X-Api-Key | 204       | none                      | none                                                     |
| `PUT`    | `/admin/peers/:peerId` | X-Api-Key | 200       | `Partial<AddPeerRequest>` | `{ id, connected, settlement? }`                         |

`POST /admin/peers` returns **201** for new peers and **200** for idempotent
re-registration of an existing peer ID (never 409).

**`AddPeerRequest.transport`** (optional, `'direct' | 'socks5'`) overrides the
connector-level `transport.type` for outbound BTP dial on this peer. When
omitted, the peer inherits the connector default. A request with
`transport: 'socks5'` against a connector whose `transport.type !== 'socks5'`
is rejected with HTTP 400.

**Re-registration cannot change a peer's live transport** (Decision 7 in the
per-peer-transport tech spec). A POST against an existing peer ID is a no-op
for the BTP client: the response payload's `transport` field reflects the
**live** value read from the existing peer, NOT the requested one. To change
a peer's transport, `DELETE` then `POST`.

**`PUT /admin/peers/:peerId`** does NOT accept the `transport` field (or any
peer-identity field — `id` / `url` / `authToken`). Any such fields in the
body are silently ignored.

**Failure Modes:**

- `400` — Invalid body, missing fields, invalid ILP address
- `400` — Invalid `transport` value, or `transport: 'socks5'` requested on a
  connector whose `transport.type !== 'socks5'`
- `401` — Missing/invalid X-Api-Key
- `403` — IP not in allowlist
- `404` — Peer not found (DELETE, PUT, GET balances), nextHop peer not found (POST /routes)

**Curl Examples:**

```bash
# Register a Docker-sibling peer over direct WS while the connector itself is
# configured with transport.type: 'socks5':
curl -X POST http://127.0.0.1:8081/admin/peers \
  -H 'Content-Type: application/json' -H 'X-Api-Key: <key>' \
  -d '{"id":"sibling","url":"ws://docker-sibling:3000","authToken":"",
       "transport":"direct"}'
# → 201 { peer: { id: "sibling", url: "...", connected: true, transport: "direct" }, ... }

# Same request on a transport.type: 'direct' connector → 400:
curl -X POST http://127.0.0.1:8081/admin/peers \
  -H 'Content-Type: application/json' -H 'X-Api-Key: <key>' \
  -d '{"id":"bad","url":"ws://x:3000","authToken":"","transport":"socks5"}'
# → 400 { error: "Bad request",
#         message: "transport: 'socks5' requires connector-level transport.type 'socks5'" }
```

**Related Stories:** 6.4, 37.1, per-peer-transport-selection

**Cross-Surface Group:** `peer-existence` (with GET /admin/balances/:peerId, GET /metrics, GET /admin/metrics.json)

---

#### Route Management

| Method   | Path                       | Auth      | Status | Request           | Response                               |
| -------- | -------------------------- | --------- | ------ | ----------------- | -------------------------------------- |
| `GET`    | `/admin/routes`            | X-Api-Key | 200    | none              | `Array<{ prefix, nextHop, priority }>` |
| `POST`   | `/admin/routes`            | X-Api-Key | 201    | `AddRouteRequest` | `{ prefix, nextHop, priority }`        |
| `DELETE` | `/admin/routes/:prefix(*)` | X-Api-Key | 204    | none              | none                                   |

**Failure Modes:**

- `400` — Invalid body, missing prefix/nextHop, invalid ILP address
- `401` — Missing/invalid X-Api-Key
- `403` — IP not in allowlist
- `404` — Route not found, nextHop peer not found

**Related Stories:** 6.4

---

#### Channel Management

| Method | Path                                 | Auth      | Status | Request                                | Response                         |
| ------ | ------------------------------------ | --------- | ------ | -------------------------------------- | -------------------------------- |
| `GET`  | `/admin/channels`                    | X-Api-Key | 200    | none                                   | `Array<AdminChannelStatus>`      |
| `POST` | `/admin/channels`                    | X-Api-Key | 201    | `{ peerId, initialDeposit, chainId? }` | `{ channelId, txHash?, status }` |
| `GET`  | `/admin/channels/:channelId`         | X-Api-Key | 200    | none                                   | `AdminChannelStatus`             |
| `GET`  | `/admin/channels/:channelId/claims`  | X-Api-Key | 200    | none                                   | `Array<ClaimRecord>`             |
| `POST` | `/admin/channels/:channelId/deposit` | X-Api-Key | 200    | `{ amount }`                           | `{ txHash, newBalance }`         |
| `POST` | `/admin/channels/:channelId/close`   | X-Api-Key | 200    | `{ force?: boolean }`                  | `{ channelId, status, txHash? }` |

**Failure Modes:**

- `400` — Invalid body, channel state conflict
- `401` — Missing/invalid X-Api-Key
- `403` — IP not in allowlist
- `404` — Channel not found
- `503` — ChannelManager/ClaimReceiver not configured

**Related Stories:** 32.4, 32.5, 33.5, 34.5

**Cross-Surface Group:** `channel-state` (with GET /admin/settlement/states)

---

#### Balance & Settlement Queries

| Method | Path                       | Auth      | Status | Request | Response                                  |
| ------ | -------------------------- | --------- | ------ | ------- | ----------------------------------------- |
| `GET`  | `/admin/balances/:peerId`  | X-Api-Key | 200    | none    | `BalanceResponse`                         |
| `GET`  | `/admin/settlement/states` | X-Api-Key | 200    | none    | `Array<{ peerId, state, pendingClaims }>` |

**BalanceResponse Type:**

```typescript
interface BalanceResponse {
  peerId: string;
  balances: Array<{
    tokenId: string;
    debitBalance: string; // bigint as string
    creditBalance: string; // bigint as string
    netBalance: string; // bigint as string
  }>;
}
```

**Failure Modes:**

- `401` — Missing/invalid X-Api-Key
- `403` — IP not in allowlist
- `404` — Peer not found (balances endpoint uses `btpClientManager.getPeerIds()` as authoritative set)
- `503` — AccountManager/SettlementMonitor not configured

**Related Stories:** 37.1 (balances), 32.5 (settlement states)

**Cross-Surface Groups:**

- `/admin/balances/:peerId` → `peer-existence`
- `/admin/settlement/states` → `channel-state`

---

#### ILP Operations

| Method | Path              | Auth      | Status | Request                                        | Response                       |
| ------ | ----------------- | --------- | ------ | ---------------------------------------------- | ------------------------------ |
| `POST` | `/admin/ilp/send` | X-Api-Key | 200    | `{ destination, amount, condition?, expiry? }` | `{ fulfillment?, rejection? }` |

**Failure Modes:**

- `400` — Invalid request body or ILP address
- `401` — Missing/invalid X-Api-Key
- `403` — IP not in allowlist
- `503` — Connector not ready or packet sender unavailable

**Related Stories:** 6.4

---

#### Metrics (JSON)

| Method | Path                  | Auth      | Status | Request | Response                   |
| ------ | --------------------- | --------- | ------ | ------- | -------------------------- |
| `GET`  | `/admin/metrics.json` | X-Api-Key | 200    | none    | `AdminMetricsJsonResponse` |

**AdminMetricsJsonResponse Type:**

```typescript
interface AdminMetricsJsonPeer {
  peerId: string;
  connected: boolean;
  packetsForwarded: number;
  packetsRejected: number;
  bytesSent: number;
  lastPacketAt: string | null; // ISO timestamp or null
}

interface AdminMetricsJsonResponse {
  uptimeSeconds: number;
  aggregate: {
    packetsForwarded: number;
    packetsRejected: number;
    bytesSent: number;
  };
  peers: AdminMetricsJsonPeer[];
}
```

**Prometheus Metric Families:**

- `toon_packets_forwarded_total` (counter, per-peer labels)
- `toon_packets_rejected_total` (counter, per-peer labels)
- `toon_bytes_sent_total` (counter, per-peer labels)
- `toon_last_packet_timestamp_seconds` (gauge, per-peer labels)

**Failure Modes:**

- `401` — Missing/invalid X-Api-Key
- `403` — IP not in allowlist
- `503` — Metrics registry not wired (returns graceful degradation)

**Operational Notes:**

- `Cache-Control: no-store` (always)
- Dashboard polling cadence: 1 Hz (1 second)
- Port: 8081 (AdminServer)

**Related Stories:** 37.2, 37.3

**Cross-Surface Group:** `packet-counters` (with GET /metrics on HealthServer)

---

#### AdminServer Health Endpoint

| Method | Path      | Auth            | Status | Request | Response                                 |
| ------ | --------- | --------------- | ------ | ------- | ---------------------------------------- |
| `GET`  | `/health` | Unauthenticated | 200    | none    | `{ status, service, nodeId, timestamp }` |

**Response:**

```json
{
  "status": "healthy",
  "service": "admin-api",
  "nodeId": "connector-1",
  "timestamp": "2026-04-21T12:00:00.000Z"
}
```

**Critical Note:** This endpoint is mounted at the **Express app root** BEFORE the `/admin` router is mounted. The full URL is:

```
http://admin-host:8081/health   ← Correct
http://admin-host:8081/admin/health   ← Wrong (404)
```

**Related Stories:** 6.4

**Cross-Surface Group:** `health-liveness-readiness`

---

### HealthServer (port 8080)

#### Prometheus Metrics

| Method | Path       | Auth            | Status | Request | Response                                  |
| ------ | ---------- | --------------- | ------ | ------- | ----------------------------------------- |
| `GET`  | `/metrics` | Unauthenticated | 200    | none    | Prometheus exposition format (text/plain) |

**Prometheus Metric Families:**

| Family                               | Type    | Labels    | Description                                     |
| ------------------------------------ | ------- | --------- | ----------------------------------------------- |
| `toon_packets_forwarded_total`       | Counter | `peer_id` | Packets successfully forwarded                  |
| `toon_packets_rejected_total`        | Counter | `peer_id` | Packets rejected (insufficient liquidity, etc.) |
| `toon_bytes_sent_total`              | Counter | `peer_id` | Total bytes sent to peer                        |
| `toon_last_packet_timestamp_seconds` | Gauge   | `peer_id` | Unix timestamp of last packet                   |

**Failure Modes:**

- `404` — Metrics middleware not configured (was empty slot prior to Story 37.2)

**Related Stories:** 37.2

**Cross-Surface Group:** `packet-counters` (with GET /admin/metrics.json)

---

#### Health Probes

| Method | Path            | Auth            | Status  | Request | Response                                         |
| ------ | --------------- | --------------- | ------- | ------- | ------------------------------------------------ |
| `GET`  | `/health`       | Unauthenticated | 200/503 | none    | `HealthStatus` or `HealthStatusExtended`         |
| `GET`  | `/health/live`  | Unauthenticated | 200     | none    | `{ status: "alive", timestamp }`                 |
| `GET`  | `/health/ready` | Unauthenticated | 200/503 | none    | `{ status: "ready"/"not_ready", dependencies? }` |

**HealthStatus (basic):**

```typescript
interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'starting';
  timestamp: string;
}
```

**HealthStatusExtended (with extendedProvider):**

```typescript
interface HealthStatusExtended extends HealthStatus {
  dependencies: {
    tigerbeetle: { status: 'up' | 'down' };
    // Additional dependencies...
  };
  uptimeSeconds: number;
  packetStats: {
    forwarded: number;
    rejected: number;
  };
}
```

**Status Codes:**

- `200` — Healthy or degraded (still operational)
- `503` — Unhealthy, starting, or critical dependencies down

**Probe Purposes:**

- `/health/live` — Kubernetes liveness probe (process running?)
- `/health/ready` — Kubernetes readiness probe (ready to accept traffic?)

**Related Stories:** 12.6

**Cross-Surface Group:** `health-liveness-readiness`

---

### Settlement API (HealthServer-mounted)

When `settlementRouter` is provided to `HealthServer`, these endpoints are mounted:

| Method | Path                         | Auth              | Status | Request                           | Response                                                     |
| ------ | ---------------------------- | ----------------- | ------ | --------------------------------- | ------------------------------------------------------------ |
| `POST` | `/settlement/execute`        | Unauthenticated\* | 200    | `{ peerId, amount?, authToken? }` | `{ txHash, amount, tokenId }`                                |
| `GET`  | `/settlement/status/:peerId` | Unauthenticated\* | 200    | none                              | `{ peerId, pendingAmount, lastSettlement?, channelStatus? }` |

\*Inherits HealthServer's unauthenticated posture. The settlement router validates `authToken` in the request body when configured.

**Failure Modes:**

- `400` — Invalid body or missing peerId
- `404` — Peer not found or no settlement configured
- `503` — Settlement infrastructure not available

**Related Stories:** 6.7

---

## Cross-Surface Invariant Groups

These groups identify endpoints that project overlapping state. **Story 38.3** (cross-surface invariant tests) and **Story 38.4** (packet-flow observability tests) use these groupings to assert consistency across surfaces.

### 1. peer-existence

**Surfaces:**

- `GET /admin/peers` (POST, DELETE, PUT also affect existence)
- `GET /admin/balances/:peerId`
- `GET /metrics` (prom labels)
- `GET /admin/metrics.json` (peers[])

**Invariant:** A peer that exists in `btpClientManager.getPeerIds()` must:

- Appear in GET /admin/peers response
- Return 200 (not 404) from GET /admin/balances/:peerId
- Have metric labels present in GET /metrics
- Appear in GET /admin/metrics.json `peers[]` array

### 2. packet-counters

**Surfaces:**

- `GET /metrics` (Prometheus: toon_packets_forwarded_total, toon_packets_rejected_total, toon_bytes_sent_total)
- `GET /admin/metrics.json` (aggregate + peers[])

**Invariant:** For any time T, the Prometheus counters and the JSON metrics must agree:

- `sum(toon_packets_forwarded_total)` ≈ `aggregate.packetsForwarded`
- `sum(toon_packets_rejected_total)` ≈ `aggregate.packetsRejected`
- `sum(toon_bytes_sent_total)` ≈ `aggregate.bytesSent`
- Per-peer Prometheus labels match per-peer JSON entries

### 3. channel-state

**Surfaces:**

- `POST /admin/channels` (creates)
- `GET /admin/channels` (lists)
- `GET /admin/channels/:channelId` (details)
- `GET /admin/channels/:channelId/claims` (pending claims)
- `POST /admin/channels/:channelId/deposit` (updates)
- `POST /admin/channels/:channelId/close` (transitions)
- `GET /admin/settlement/states` (aggregated view)

**Invariant:** Channel state transitions are atomic and consistent across queries. A channel that is `CLOSING` in one surface must be `CLOSING` in all.

### 4. health-liveness-readiness

**Surfaces:**

- `GET /health` (AdminServer)
- `GET /health` (HealthServer)
- `GET /health/live` (HealthServer)
- `GET /health/ready` (HealthServer)

**Invariant:**

- `/health/live` returns 200 if the process is running (always, unless crashed)
- `/health/ready` returns 200 only when dependencies are up
- `/health` on HealthServer returns extended status when provider configured
- `/health` on AdminServer returns simple healthy/unhealthy

---

## TypeScript Contracts

All request/response contracts are defined in TypeScript source files:

| Contract                   | Source File           | Export Name                          |
| -------------------------- | --------------------- | ------------------------------------ |
| `AddPeerRequest`           | `http/admin-api.ts`   | `interface AddPeerRequest`           |
| `AddRouteRequest`          | `http/admin-api.ts`   | `interface AddRouteRequest`          |
| `BalanceResponse`          | `http/admin-api.ts`   | `interface BalanceResponse`          |
| `AdminMetricsJsonPeer`     | `http/admin-api.ts`   | `interface AdminMetricsJsonPeer`     |
| `AdminMetricsJsonResponse` | `http/admin-api.ts`   | `interface AdminMetricsJsonResponse` |
| `AdminChannelStatus`       | `settlement/types.ts` | `type AdminChannelStatus`            |
| `AdminSettlementConfig`    | `settlement/types.ts` | `interface AdminSettlementConfig`    |
| `HealthStatus`             | `http/types.ts`       | `interface HealthStatus`             |
| `HealthStatusExtended`     | `http/types.ts`       | `interface HealthStatusExtended`     |

---

## Curl Examples

### AdminServer (with API key)

```bash
# List peers
export ADMIN_API_KEY="your-secret-key"
curl -H "X-Api-Key: $ADMIN_API_KEY" \
  http://localhost:8081/admin/peers

# Add a peer
curl -X POST -H "X-Api-Key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"alice","url":"ws://alice:3000","authToken":"secret"}' \
  http://localhost:8081/admin/peers

# Get balances
curl -H "X-Api-Key: $ADMIN_API_KEY" \
  http://localhost:8081/admin/balances/alice

# Get metrics JSON (dashboard)
curl -H "X-Api-Key: $ADMIN_API_KEY" \
  http://localhost:8081/admin/metrics.json
```

### HealthServer (no auth)

```bash
# Prometheus metrics
curl http://localhost:8080/metrics

# Health check
curl http://localhost:8080/health

# Liveness probe
curl http://localhost:8080/health/live

# Readiness probe
curl http://localhost:8080/health/ready
```

### AdminServer Health (unauthenticated)

```bash
# AdminServer own health endpoint (not /admin/health!)
curl http://localhost:8081/health
```

---

## Not Covered

The following are **explicitly out of scope** for this inventory:

| Out of Scope                              | Reason                                           |
| ----------------------------------------- | ------------------------------------------------ |
| BTP WebSocket wire protocol               | Not HTTP; documented in `shared/ilp` and BTP RFC |
| ILP packet shape (Prepare/Fulfill/Reject) | Not HTTP; documented in RFC-0027                 |
| Internal module APIs                      | Only HTTP-exposed endpoints are inventoried      |
| Load/performance benchmarks               | Operational concern, not HTTP surface            |
| gRPC endpoints                            | Connector does not expose gRPC                   |
| GraphQL endpoints                         | Connector does not expose GraphQL                |

---

## Machine-Readable Source

This document is derived from the TypeScript manifest at:

```
packages/connector/src/http/admin-api-inventory.ts
```

The manifest exports:

```typescript
export const ADMIN_API_INVENTORY: readonly InventoryEntry[];
export type InventoryEntry = {
  /* ... */
};
export type CrossSurfaceGroupId =
  | 'peer-existence'
  | 'packet-counters'
  | 'channel-state'
  | 'health-liveness-readiness';
export function getEntriesByServer(server: ServerName): readonly InventoryEntry[];
export function getEntriesByGroup(groupId: CrossSurfaceGroupId): readonly InventoryEntry[];
```

**Drift Check:** Running `make lint` includes a check that verifies the manifest matches actual route registrations in the source. If they diverge, the lint fails with a specific error naming the undocumented route.

---

## Related Documents

- **Story 38.1 Spec:** `_bmad-output/implementation-artifacts/38-1-http-endpoint-inventory.md`
- **Epic 38 Scaffold:** `_bmad-output/planning-artifacts/epic-38-http-surface-e2e-coverage.md`
- **Epic 37 Retro:** `_bmad-output/implementation-artifacts/epic-37-retro-2026-04-21.md` (motivation for AG2)
- **Story 37.1:** `_bmad-output/implementation-artifacts/37-1-balances-endpoint-404-on-unknown-peer.md`
- **Story 37.2:** `_bmad-output/implementation-artifacts/37-2-wire-prom-client-per-peer-ilp-counters.md`
- **Story 37.3:** `_bmad-output/implementation-artifacts/37-3-admin-metrics-json-endpoint.md`
- **Operator Guide Index:** `docs/operators/` (this doc linked from there)

---

## Change Log

| Date       | Change                                                                     | Story |
| ---------- | -------------------------------------------------------------------------- | ----- |
| 2026-04-21 | Initial inventory created                                                  | 38.1  |
| 2026-04-21 | Discharged Epic 37 A3 (operator docs for /metrics and /admin/metrics.json) | 38.1  |
