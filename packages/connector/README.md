# @m2m/connector

The M2M Connector package provides the core ILP connector functionality for the Machine-to-Machine Economy platform.

## Overview

This package implements:

- ILP packet routing and forwarding
- Settlement coordination (EVM and XRP Ledger)
- Balance tracking with TigerBeetle
- Peer management via BTP
- Security controls and rate limiting
- Explorer UI for telemetry visualization

## Explorer UI

The connector includes an embedded Explorer UI for visualizing telemetry events in real-time.

### Configuration

The Explorer is enabled by default. Configure via environment variables:

| Variable                  | Default   | Description                              |
| ------------------------- | --------- | ---------------------------------------- |
| `EXPLORER_ENABLED`        | `true`    | Enable/disable explorer UI               |
| `EXPLORER_PORT`           | `3001`    | HTTP/WebSocket server port               |
| `EXPLORER_RETENTION_DAYS` | `7`       | Event retention period (1-365 days)      |
| `EXPLORER_MAX_EVENTS`     | `1000000` | Maximum events to retain (1000-10000000) |

### Accessing the Explorer

When enabled, access the Explorer UI at:

- Local development: `http://localhost:3001`
- Docker (mesh topology): `http://localhost:3010` (connector-a), `3011` (b), `3012` (c), `3013` (d)

### API Endpoints

| Endpoint          | Description                                  |
| ----------------- | -------------------------------------------- |
| `GET /api/events` | Query historical events (supports filtering) |
| `GET /api/health` | Explorer health status                       |
| `WS /ws`          | Real-time event streaming                    |

### Docker Topologies

Explorer ports are pre-configured in each docker-compose file:

**Linear (3-node):**

```bash
docker-compose -f docker/docker-compose.linear.yml up -d
# Connector A: http://localhost:3010
# Connector B: http://localhost:3011
# Connector C: http://localhost:3012
```

**Mesh (4-node):**

```bash
docker-compose -f docker/docker-compose.mesh.yml up -d
# Connector A-D: http://localhost:3010-3013
```

**Hub-Spoke:**

```bash
docker-compose -f docker/docker-compose.hub-spoke.yml up -d
# Hub: http://localhost:3010
# Spokes: http://localhost:3011-3013
```

## Installation

```bash
npm install @m2m/connector
```

## Usage

See the main project README for configuration and deployment instructions.

## Testing

```bash
# Unit tests
npm test

# Acceptance tests
npm run test:acceptance

# Load tests (requires staging environment)
npm run test:load
```

## Package Structure

- `src/` - Source code
  - `core/` - Core connector logic
  - `routing/` - Packet routing
  - `settlement/` - Settlement engines
  - `wallet/` - Wallet management
  - `explorer/` - Explorer server and event store
- `explorer-ui/` - Explorer UI (React/Vite)
- `test/` - Test suites
  - `unit/` - Unit tests
  - `integration/` - Integration tests
  - `acceptance/` - Acceptance tests

## License

See root LICENSE file.
