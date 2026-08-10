# Connector Admin API Reference

> **Historical — this is the retired TypeScript connector's admin API**
> ([ADR 0017](../adr/0017-the-typescript-connector-is-a-prototype.md)). The image it describes
> (`ghcr.io/toon-protocol/connector`, semver-tagged) was deleted from GHCR in the post-cutover
> package purge ([`deploy/README.md`](../../deploy/README.md)); the devnet fleet runs the Rust
> connector on every box, published under `rust-sha-*` tags of that same package
> ([`deploy/connector-rust/README.md`](../../deploy/connector-rust/README.md)). This document
> describes nothing in `crates/`.
>
> The Rust connector's equivalent is the **operator surface**
> ([ADR 0008](../adr/0008-operator-surface-splits-read-from-write.md)), and it is a different
> design in every respect that matters here: one port (merged onto `client_edge_addr`, not 8081
> and 8080), no health endpoint at all, bearer-token auth for **reads only**, and RFC 9421
> request signatures — never a bearer token or an API key — for every **write**. It is mounted
> only when the config file has an `[operator]` section. Its routes are enumerated in
> [`crates/connector-operator`](../../crates/connector-operator) and in the repository
> [README](../../README.md#the-operator-surface).

The connector exposes an administrative HTTP API for runtime peer and route management, as well as a separate health/metrics server.

## Quick Links

- **[Complete HTTP Endpoint Inventory](../admin-api-inventory.md)** — Authoritative reference for all HTTP routes
- **Health & Metrics:** See inventory sections for HealthServer and Prometheus endpoints
- **Authentication:** X-Api-Key header required for all `/admin/*` routes

## Two-Server Architecture

| Server           | Port | Purpose                                                    | Auth                              |
| ---------------- | ---- | ---------------------------------------------------------- | --------------------------------- |
| **AdminServer**  | 8081 | Peer/route/channel management, admin operations            | X-Api-Key + optional IP allowlist |
| **HealthServer** | 8080 | Health checks, Prometheus metrics, optional settlement API | Unauthenticated                   |

> ⚠️ **Important:** These are separate Express apps. Do not confuse `/health` on 8080 with `/health` on 8081.

## Authentication

### AdminServer (Port 8081)

All `/admin/*` routes require the `X-Api-Key` header when `apiKey` is configured:

```bash
curl -H "X-Api-Key: your-secret-key" http://localhost:8081/admin/peers
```

Query parameter API keys are **rejected**. Configure via YAML:

```yaml
adminApi:
  apiKey: '${ADMIN_API_KEY}'
  allowedIPs:
    - '10.0.0.0/8'
  trustProxy: true
```

### HealthServer (Port 8080)

All endpoints are unauthenticated (designed for internal monitoring):

```bash
curl http://localhost:8080/metrics
curl http://localhost:8080/health
```

## Common Operations

### List Peers

```bash
curl -H "X-Api-Key: $ADMIN_API_KEY" http://localhost:8081/admin/peers
```

### Add a Peer

```bash
curl -X POST -H "X-Api-Key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"alice","url":"ws://alice:3000","authToken":"secret"}' \
  http://localhost:8081/admin/peers
```

### Get Balances

```bash
curl -H "X-Api-Key: $ADMIN_API_KEY" \
  http://localhost:8081/admin/balances/alice
```

### Get Metrics (JSON)

```bash
curl -H "X-Api-Key: $ADMIN_API_KEY" \
  http://localhost:8081/admin/metrics.json
```

### Prometheus Metrics

```bash
curl http://localhost:8080/metrics
```

## Full Reference

See the **[HTTP Endpoint Inventory](../admin-api-inventory.md)** for:

- Complete route listing (23 endpoints across both servers)
- Request/response contracts with TypeScript types
- Failure modes and status codes
- Cross-surface invariant groups (for testing)
- Curl examples for every endpoint

## Security Notes

- Bind AdminServer to internal network only (Docker Compose, Kubernetes)
- Never expose port 8081 to the public internet
- Use IP allowlists for defense in depth
- HealthServer (8080) is designed for internal monitoring — firewall appropriately
