# Agent Explorer

Real-time telemetry dashboard for ILP connector nodes. Displays streaming ILP packet events, peer account balances, settlement activity, payment channels, and on-chain wallet data.

## Quick Start

```bash
# Install dependencies
npm install

# Start dev server (proxies to local connector on port 3001)
npm run dev
```

Open http://localhost:5173 in your browser.

## Development with Docker Agent Society Test

The Agent Explorer can connect to real Docker-based agent nodes running the Agent Society Protocol integration test. This provides authentic multi-agent telemetry data including ILP packets with TOON payloads, settlement events, payment channel opens/updates, and wallet balances.

### Step 1: Start the Docker Agent Society Test

From the connector package root:

```bash
cd packages/connector
DOCKER_TESTS=true SKIP_CLEANUP=true npx jest test/integration/docker-agent-society.test.ts --testTimeout=120000
```

Key environment variables:

| Variable       | Default | Description                                                       |
| -------------- | ------- | ----------------------------------------------------------------- |
| `DOCKER_TESTS` | `false` | Must be `true` to enable Docker-based tests                       |
| `SKIP_CLEANUP` | `false` | Set to `true` to keep containers running after the test completes |
| `AGENT_COUNT`  | `5`     | Number of agent containers to spawn                               |
| `LOG_LEVEL`    | `info`  | Container log level                                               |

### Step 2: Identify Agent Ports

Each agent exposes its HTTP/API/Explorer on port `8100 + index`:

| Agent   | Port | Health Endpoint              | Explorer                        |
| ------- | ---- | ---------------------------- | ------------------------------- |
| Agent 0 | 8100 | http://localhost:8100/health | http://localhost:8100/explorer/ |
| Agent 1 | 8101 | http://localhost:8101/health | http://localhost:8101/explorer/ |
| Agent 2 | 8102 | http://localhost:8102/health | http://localhost:8102/explorer/ |
| Agent 3 | 8103 | http://localhost:8103/health | http://localhost:8103/explorer/ |
| Agent 4 | 8104 | http://localhost:8104/health | http://localhost:8104/explorer/ |

You can also check agent status at `http://localhost:{port}/status`, which returns `agentId`, `pubkey`, `ilpAddress`, `followCount`, and `storedEventCount`.

### Step 3: Connect the Explorer Dev Server

Use the `dev:agent-explorer` script to proxy the Vite dev server to a running Docker agent:

```bash
cd packages/connector/explorer-ui

# Connect to agent 0 (default port 8100)
npm run dev:agent-explorer

# Connect to a specific agent
AGENT_PORT=8101 npm run dev:agent-explorer
```

Open http://localhost:5173 to view the Explorer with live agent data.

### Expected Data

When connected to a running Docker agent, the Explorer should display:

- **Events tab**: ILP packet events (Prepare, Fulfill, Reject) with TOON-encoded payloads
- **Accounts view**: Peer account balances and settlement state
- **Payment Channels**: Open/funded payment channels between peers
- **Wallet**: On-chain wallet balances (ETH/EVM)

## Scripts

| Script                       | Description                                                   |
| ---------------------------- | ------------------------------------------------------------- |
| `npm run dev`                | Start Vite dev server (proxies to localhost:3001)             |
| `npm run dev:agent-explorer` | Start dev server proxying to Docker agent (default port 8100) |
| `npm run build`              | TypeScript check + Vite production build                      |
| `npm run test`               | Run Vitest test suite                                         |
| `npm run test:watch`         | Run Vitest in watch mode                                      |
| `npm run lint`               | Run ESLint                                                    |
| `npm run preview`            | Preview production build                                      |

## Tech Stack

- React 18 + TypeScript
- Vite 6
- shadcn/ui v4 + Tailwind CSS (dark theme)
- Vitest + React Testing Library
- WebSocket for real-time event streaming
