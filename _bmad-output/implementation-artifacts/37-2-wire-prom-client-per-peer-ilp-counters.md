# Story 37.2: Wire prom-client + Per-Peer ILP Counters + /metrics Middleware

Status: done

## Story

As a connector operator running the Townhouse dashboard (and as an existing Prometheus/Grafana user),
I want the connector's `/metrics` HTTP endpoint to actually serve metrics,
so that per-peer packet/byte attribution data is collected and exposed — closing the long-standing empty-middleware-slot defect and providing the substrate for Story 37.3's JSON projection.

**Epic:** 37 — Admin API Observability for Townhouse Dashboard
**Priority:** P0 (blocks 37.3, blocks Town Story 21.8.5)
**Estimated effort:** 3 points (~2–3 dev days)
**Dependencies:** None (37.1 parallelizable)

## Context

Verified in response doc §3.1 and §10.1: `HealthServer.metricsMiddleware` has always been an empty slot. `ConnectorNode:250` constructs `HealthServer(logger, this)` with no options, so `/metrics` is a `404` in every deployment (dev, prod, Docker). Story 21.3's T-020 integration test in the Town repo has been asserting against an endpoint that doesn't exist.

The `metrics-collector.ts` in `settlement/` is a circuit-breaker tool (settlement success/failure, not packets) and is not reusable for per-peer ILP counters.

## Acceptance Criteria

### AC 1: prom-client installed and a default Registry exists

```gherkin
Scenario: prom-client is a production dependency of packages/connector
  Given the workspace packages/connector
  When package.json is inspected
  Then prom-client is listed in dependencies (not devDependencies)
  And a singleton Registry is constructed in a new module packages/connector/src/observability/metrics-registry.ts
  And process-default metrics (collectDefaultMetrics) are registered
```

### AC 2: Per-peer counters defined and instrumented

```gherkin
Scenario: ILP forwarding path records per-peer counters
  Given a PacketHandler processing an ILP PREPARE from peer 'relay'
  When the packet is forwarded to peer 'swap'
  Then toon_packets_forwarded_total{peer="swap"} increments by 1
  And toon_bytes_sent_total{peer="swap"} increments by packet.byteLength
  And toon_last_packet_timestamp_seconds{peer="swap"} is updated to Date.now()/1000
  When the packet is REJECTED downstream
  Then toon_packets_rejected_total{peer="swap"} increments by 1
  And an incoming packet from 'swap' updates toon_last_packet_timestamp_seconds{peer="swap"} as well (either-direction semantic, per §9.2 Q2)
```

### AC 3: Metrics middleware supplied to HealthServer

```gherkin
Scenario: ConnectorNode wires metrics middleware on construction
  Given a ConnectorNode is instantiated
  When the HealthServer is constructed inside connector-node.ts
  Then it receives a third argument { metricsMiddleware } whose handler returns register.metrics() with Content-Type 'text/plain; version=0.0.4; charset=utf-8'
  And starting the HealthServer logs 'Prometheus metrics endpoint mounted at /metrics'
```

### AC 4: GET /metrics returns OpenMetrics text

```gherkin
Scenario: /metrics endpoint serves Prometheus text
  Given a running connector with at least one peer registered
  And at least one ILP packet has been processed
  When GET /metrics is requested
  Then the response status is 200
  And the Content-Type header is 'text/plain; version=0.0.4; charset=utf-8'
  And the body contains a line matching /^toon_packets_forwarded_total\{peer="[^"]+"\} \d+/m
  And the body contains process_* default metrics
```

### AC 5: Metrics endpoint is unauthenticated (matches scraper convention)

```gherkin
Scenario: /metrics does NOT require X-Api-Key
  Given the connector is configured with an API key for /admin/*
  When GET /metrics is requested without any Authorization header
  Then the response status is 200 (unauth'd, per §10.2 of response doc)
```

### AC 6: Docker image verification closes the T-020 anomaly

```gherkin
Scenario: Standalone Docker image serves real /metrics output
  Given the connector Docker image is built from the repo root Dockerfile
  When the image is run with default env and at least one peer registered
  And GET /metrics is issued against the mapped port
  Then the response body is non-empty Prometheus text
  And includes the toon_packets_forwarded_total family
```

### AC 7: No behavioral regressions

```gherkin
Scenario: Existing test suite passes
  Given the changes in this story
  When `make test` is run
  Then all existing suites remain green, including admin-api-*, health-server, packet-handler
```

## Tasks / Subtasks

1. Add `prom-client` to `packages/connector/package.json` dependencies. Run `npm install`.
2. Create `packages/connector/src/observability/metrics-registry.ts`:
   - Singleton `Registry`, export `register`.
   - Export counter instances: `packetsForwardedTotal`, `packetsRejectedTotal`, `bytesSentTotal`, `bytesReceivedTotal` (bytesReceived optional per §9.2 Q5 — including for completeness, costs negligible if instrumented in the same hook).
   - Export `lastPacketTimestampSeconds` gauge with label `{peer}`.
   - Call `collectDefaultMetrics({ register })`.
3. Instrument the ILP forwarding path. Identify the hooks in `PacketHandler` / `BTPClientManager` / the inbound request entrypoint; update each to call the counter/gauge methods with the resolved peer label.
4. Create the `metricsMiddleware` handler (small Express handler wrapping `register.metrics()`). Export from the observability module.
5. Wire the middleware into `ConnectorNode:250` — pass `{ metricsMiddleware }` as the third arg to `HealthServer`.
6. Add tests:
   - Unit test for the observability module (counters increment, registry serializes).
   - Integration test in `health-server.test.ts` (or a new `metrics-endpoint.test.ts`) asserting `GET /metrics` returns text containing the expected metric families after a synthetic packet flow.
7. Update `Dockerfile` if needed (no new runtime deps beyond prom-client itself; confirm EXPOSE covers the health port where `/metrics` lives).
8. Run `make test`, `make lint`, `npm run format:check`.
9. Manually verify with the standalone Docker image per AC 6; document the verification in the story's Dev Notes before marking done.
10. Update operator docs to mention `/metrics` is now real and to include a `toon_*` family reference.

## Dev Notes

- **Library choice:** `prom-client` is the de-facto Node.js Prometheus library, permissive license, zero runtime deps of note. No reason to evaluate alternatives.
- **Cardinality:** Town confirmed ceiling of ≤10 peers in §9.2 Q1. Default Registry behavior is safe at this scale; no label filtering needed.
- **`lastPacketAt` as gauge of Unix seconds:** Emitting a timestamp gauge rather than a dedicated counter keeps the label set small and makes the dashboard's "is this node doing work?" check a simple `Date.now()/1000 - gauge < N` comparison.
- **Instrumentation injection:** Prefer passing the registry/counters into `PacketHandler` via constructor rather than importing a singleton inside hot paths — keeps the module testable and avoids a hidden coupling. The singleton module still lives in `observability/` for the `/metrics` endpoint to read from.
- **Docker image verification:** This is the concrete deliverable that closes Town's T-020 anomaly. Not optional.
