---
name: docker-agent-society-test
description: Run Docker-based Agent Society Protocol integration test. Creates N agent containers with real network communication, establishes social graph relationships via HTTP API, deploys AGENT ERC20 token on local Anvil, and verifies event exchange between containers. Use when testing multi-agent communication with real Docker networking, container orchestration, or production-like agent deployment. Triggers on "docker agent test", "containerized agent test", "docker integration test", "/docker-agent-society-test", or "run docker agent test".
---

# Docker Agent Society Integration Test

Run a comprehensive end-to-end test of the Agent Society Protocol using real Docker containers with actual network communication between agents.

## Overview

This test differs from the in-process `agent-society-test` by running each agent as a separate Docker container, communicating over real TCP/WebSocket connections. This provides a more realistic test of the production deployment model.

## Prerequisites

Ensure Docker is running and available:

```bash
docker info
```

Build the agent Docker image (first time only):

```bash
docker compose -f docker-compose-agent-test.yml build
```

## Running the Test

### Via Shell Script (Recommended)

```bash
./scripts/run-docker-agent-test.sh
```

### Configuration Options

Set environment variables to customize the test:

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_COUNT` | 5 | Number of agent containers (max 5 with current compose) |
| `LOG_LEVEL` | info | Log verbosity (debug, info, warn, error) |
| `TEST_TIMEOUT` | 300 | Maximum test duration in seconds |

Example with options:
```bash
AGENT_COUNT=3 LOG_LEVEL=debug ./scripts/run-docker-agent-test.sh
```

### Manual Execution

Start infrastructure manually:
```bash
# Start Anvil and agents
docker compose -f docker-compose-agent-test.yml up -d

# Wait for health checks
docker compose -f docker-compose-agent-test.yml ps

# Run test orchestrator
RUNNING_IN_DOCKER=false node packages/connector/dist/test/docker-agent-test-runner.js

# Cleanup
docker compose -f docker-compose-agent-test.yml down -v
```

## Architecture

### Container Layout

```
┌──────────────────────────────────────────────────────────────┐
│                    Docker Network                            │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐         │
│  │ agent-0 │  │ agent-1 │  │ agent-2 │  │ agent-3 │  ...    │
│  │ :8080   │  │ :8080   │  │ :8080   │  │ :8080   │         │
│  │ :3000   │  │ :3000   │  │ :3000   │  │ :3000   │         │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘         │
│       │            │            │            │               │
│       └────────────┴─────┬──────┴────────────┘               │
│                          │                                    │
│                   ┌──────┴──────┐                            │
│                   │    Anvil    │                            │
│                   │    :8545    │                            │
│                   └─────────────┘                            │
└──────────────────────────────────────────────────────────────┘
```

### Port Mapping (Host -> Container)

| Container | HTTP API | BTP WebSocket |
|-----------|----------|---------------|
| agent-0   | 8100     | 3100          |
| agent-1   | 8101     | 3101          |
| agent-2   | 8102     | 3102          |
| agent-3   | 8103     | 3103          |
| agent-4   | 8104     | 3104          |
| anvil     | 8545     | -             |

## Test Phases

1. **Wait for Agents**: Poll health endpoints until all agents are initialized
2. **Collect Agent Info**: Query `/status` to get pubkeys and ILP addresses
3. **Configure Social Graph**: POST to `/follows` to establish hub-and-spoke + ring topology
4. **Deploy AGENT Token**: Deploy MockERC20 to Anvil
5. **Establish BTP Connections**: POST to `/connect` to create WebSocket connections
6. **Broadcast Events**: POST to `/broadcast` to send Kind 1 notes to all follows
7. **Verify Results**: Query `/status` and `/events` to verify event storage

## Agent HTTP API

Each agent exposes these endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Health check with initialization status |
| GET | /status | Full status including event counts |
| POST | /follows | Add a follow relationship |
| GET | /follows | List all follows |
| POST | /connect | Establish BTP connection to peer |
| POST | /send-event | Send event to specific peer |
| POST | /broadcast | Send event to all follows |
| GET | /events | Query stored events |

## Differences from In-Process Test

| Aspect | In-Process | Docker |
|--------|------------|--------|
| Agent Isolation | Same process | Separate containers |
| Communication | Direct method calls | HTTP/WebSocket |
| Database | In-memory shared | In-memory isolated |
| Network | None | Real TCP/IP |
| Startup Time | Fast (~1s) | Slower (~30s) |
| Use Case | Unit/integration | E2E/deployment |

## Troubleshooting

**Docker not running**: Start Docker Desktop or daemon

**Build failures**: Clear Docker cache with `docker compose -f docker-compose-agent-test.yml build --no-cache`

**Agent not healthy**: Check logs with `docker compose -f docker-compose-agent-test.yml logs agent-0`

**Anvil connection failed**: Ensure port 8545 is not in use

**Test timeout**: Increase `TEST_TIMEOUT` or check container logs for errors

## Files

- `docker-compose-agent-test.yml` - Docker Compose configuration
- `packages/connector/Dockerfile.agent` - Agent container image
- `packages/connector/src/agent/agent-server.ts` - Standalone agent server
- `packages/connector/src/test/docker-agent-test-runner.ts` - Test orchestrator
- `scripts/run-docker-agent-test.sh` - Convenience wrapper script
