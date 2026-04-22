# Connector Admin API Reference

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
