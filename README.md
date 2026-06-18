# Connector

[![Version](https://img.shields.io/badge/version-2.5.0-blue.svg)](CHANGELOG.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3.3-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **The payment infrastructure for agent networks.** Route micropayments between autonomous agents using proven protocols. Messages carry value. Routing earns fees. Settlement happens on-chain.

## What is a Connector?

A **connector** is a node in the [Interledger Protocol (ILP)](https://interledger.org) network. Think of it as a **payment router**—the same way IP routers forward internet packets, connectors forward payment packets.

### Core Function: Routing Payments

```
Agent A sends 1000 tokens to Agent B (3 hops away)

Agent A ──► Connector 1 ──► Connector 2 ──► Agent B
  1000        (keeps 1)       (keeps 1)       gets 998

Each hop: validates, routes, earns fee
```

Connectors handle three critical tasks:

1. **Routing** — Find the path from sender to receiver using an addressing hierarchy
2. **Accounting** — Track balances with each peer off-chain (thousands of transactions)
3. **Settlement** — Periodically settle net balances on-chain (one transaction)

### How Connectors Fit in the Town Stack

**Connector is the foundation. Town is the application.**

```
┌─────────────────────────────────────────────────┐
│  Applications (built on connector)               │
│  ┌──────────────────────────────────────────┐   │
│  │  Town                                │   │  Nostr relay with ILP payments
│  │  • Pay-to-write relay                     │   │  "Free to read, pay to write"
│  │  • Uses connector for payments            │   │
│  │  • Discovers peers via Nostr events       │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │  Your Agent App                           │   │  Custom AI agent
│  │  • Business logic layer                   │   │
│  │  • Uses connector for micropayments       │   │
│  │  • Send/receive with value attached       │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  Connector (this repo)                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │ Routing  │ │ BTP/WS   │ │ Ledger   │        │
│  │ Table    │ │ Peers    │ │ Balances │        │
│  └──────────┘ └──────────┘ └──────────┘        │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │  Settlement (optional, multi-chain)       │   │
│  │  • EVM (Base L2)  • Solana  • Mina       │   │
│  └──────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────┐   │
│  │  Transport                                │   │
│  │  • Direct TCP (default)                   │   │
│  │  • ATOR overlay (onion-routed, opt-in)    │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
                       │
                       ▼
              ┌────────────────┐
              │  Blockchains   │  On-chain settlement
              │  (payment      │  (batched, infrequent)
              │   channels)    │
              └────────────────┘
```

**Mental Model:**

- **Connector** = Payment infrastructure (like TCP/IP for the internet)
- **Town** = Application (like HTTP/HTTPS built on TCP/IP)
- **Your Agent** = Custom application (like a web browser)

The connector handles the hard parts (routing, accounting, settlement) so applications can focus on business logic.

## Getting Started

### Installation

```bash
npm install @toon-protocol/connector
```

That's it. No external databases required—the connector ships with an in-memory ledger that persists to disk via JSON snapshots. For high-throughput production workloads, you can optionally plug in [TigerBeetle](https://tigerbeetle.com).

## How Connector Networks Work

### 1. Addressing: Hierarchical ILP Addresses

Every node has an ILP address. Addresses are hierarchical, like domain names in reverse:

```
g.hub.alice       (agent "alice" on connector "hub" in global network "g")
g.hub.bob         (agent "bob" on the same connector)
g.peer.charlie    (agent "charlie" on a different connector)
```

Routing uses **longest prefix matching**:

- Traffic to `g.hub.*` → local delivery
- Traffic to `g.peer.*` → route to peer connector
- Traffic to `g.*` → route to parent connector

### 2. Peering: Bilateral Connections

Connectors peer with each other using the **Bilateral Transfer Protocol (BTP)** over WebSockets:

```yaml
# config.yaml
nodeId: hub
btpServerPort: 3000

peers:
  - id: peer
    url: ws://peer-connector:3001
    authToken: secret-token

routes:
  - prefix: g.peer
    nextHop: peer
    priority: 0
```

When you configure a peer, you're saying:

- "I trust this peer to route payments"
- "Send traffic for prefix `g.peer.*` to this peer"
- "Track balances off-chain and settle periodically"

### 3. Payment Flow: Prepare, Fulfill, Reject

ILP uses a **two-phase commit** protocol with cryptographic escrow:

```
1. PREPARE   Sender → Connectors → Receiver
   "I'll pay 1000 tokens if you provide proof X within 30 seconds"

2. FULFILL   Receiver → Connectors → Sender
   "Here's proof X (SHA256 preimage), claim your money"

3. SETTLE    Connectors update balances off-chain
```

**Key insight:** Connectors never hold funds in escrow. They track IOUs off-chain and settle the net balance on-chain when thresholds are reached.

## Quick Start

### Embedded Mode (In-Process)

**Use when:** Building an AI agent or application that needs to send/receive payments

**Benefits:**

- Zero network latency (in-process)
- Single process to manage
- Easier debugging

```typescript
import { ConnectorNode, createLogger } from '@toon-protocol/connector';

const logger = createLogger('my-agent', 'info');
const node = new ConnectorNode('config.yaml', logger);

// Handle incoming packets (same process)
node.setPacketHandler(async (request) => {
  const payload = request.data ? Buffer.from(request.data, 'base64').toString() : '';

  if (BigInt(request.amount) < 100n) {
    return {
      accept: false,
      rejectReason: { code: 'invalid_amount', message: 'Pay more' },
    };
  }

  console.log(`Received ${request.amount} tokens: ${payload}`);
  return { accept: true };
});

await node.start();

// Send a packet through the network
await node.sendPacket({
  destination: 'g.peer.agent',
  amount: 1000n,
  executionCondition: Buffer.alloc(32),
  expiresAt: new Date(Date.now() + 30000),
  data: Buffer.from('Hello, world!'),
});

await node.stop();
```

### Standalone Mode (Separate Process)

**Use when:** Running a connector as infrastructure for external applications

**Benefits:**

- Process isolation
- Independent scaling
- Language-agnostic (HTTP API)

```yaml
# config.yaml
nodeId: my-connector
btpServerPort: 3000
healthCheckPort: 8080

localDelivery:
  enabled: true
  handlerUrl: http://localhost:8080 # Your business logic server

adminApi:
  enabled: true
  port: 8081 # API for sending packets

peers:
  - id: peer-b
    url: ws://peer-b:3001
    authToken: secret-token

routes:
  - prefix: g.peer-b
    nextHop: peer-b
```

Start the connector:

```bash
npx connector start config.yaml
```

Your application receives packets via HTTP:

```typescript
// Your business logic server (separate process)
app.post('/handle-packet', async (req, res) => {
  const { paymentId, destination, amount, data } = req.body;

  if (BigInt(amount) < 100n) {
    return res.json({
      accept: false,
      rejectReason: { code: 'invalid_amount', message: 'Pay more' },
    });
  }

  res.json({ accept: true });
});
```

Send packets via HTTP API:

```bash
curl -X POST http://localhost:8081/admin/ilp/send \
  -H 'Content-Type: application/json' \
  -d '{"destination":"g.peer.agent","amount":"1000","data":"aGVsbG8="}'
```

## Configuration

### Minimal Configuration

```yaml
nodeId: my-agent
btpServerPort: 3000
healthCheckPort: 8080
logLevel: info

peers:
  - id: peer-b
    url: ws://peer-b:3001
    authToken: secret-token

routes:
  - prefix: g.peer-b
    nextHop: peer-b
    priority: 0
```

### Configuration Sections

| Section          | Purpose                                      | When to Use                   |
| ---------------- | -------------------------------------------- | ----------------------------- |
| `nodeId`         | Unique identifier for this connector         | Always required               |
| `btpServerPort`  | WebSocket port for incoming peer connections | Always required               |
| `peers`          | Other connectors to connect to               | Define your network topology  |
| `routes`         | Routing table (which prefixes go where)      | Map address prefixes to peers |
| `localDelivery`  | Forward packets to external HTTP server      | Standalone mode only          |
| `chainProviders` | Multi-chain settlement (EVM, Solana, Mina)   | When using payment channels   |
| `transport`      | Network transport (direct or ATOR/SOCKS5)    | Privacy or home-network peers |
| `explorer`       | Real-time telemetry UI                       | Development and debugging     |
| `security`       | Rate limiting, IP allowlists                 | Production deployments        |
| `performance`    | Timeouts, buffer sizes                       | Performance tuning            |

**Getting Started with Config:**

```bash
# Generate a config interactively
npx connector setup
```

All chain-specific settings (RPC URLs, contract addresses, private keys) go in the `chainProviders` array in your config file. See [`examples/`](examples/) for full configuration examples (linear topology, mesh, hub-spoke).

## Settlement: Batching Thousands of Payments into One Transaction

Agents exchange thousands of small payments off-chain. When thresholds are reached, the connector settles the net balance on-chain using **payment channels**.

**Example:**

```
Off-chain (fast, free):
  Agent A → Connector: 100 payments of 10 tokens = 1,000 tokens
  Connector → Agent A: 50 payments of 5 tokens = 250 tokens
  Net balance: Agent A owes 750 tokens

On-chain (slow, costs gas):
  Single transaction: Agent A → Connector: 750 tokens
```

### Supported Chains

| Chain       | Why Use It                                            | Settlement Type        |
| ----------- | ----------------------------------------------------- | ---------------------- |
| **Base L2** | Ethereum ecosystem, ERC-20 tokens, DeFi composability | Payment channels (EVM) |
| **Solana**  | Sub-second finality, low fees                         | Payment channels (SPL) |
| **Mina**    | Zero-knowledge proofs, succinct blockchain            | zkApp payment channels |

Settlement is **optional**. You can run a connector without on-chain settlement for testing or private networks. Chain SDKs are loaded lazily — you only need dependencies for chains you actually use.

### Configuring Settlement with `chainProviders`

All settlement is configured through the `chainProviders` array. Each entry tells the connector how to connect to a specific chain:

```yaml
chainProviders:
  - chainType: evm
    chainId: evm:8453
    rpcUrl: https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
    registryAddress: '0x...'
    tokenAddress: '0x...'
    keyId: '0x...'
    settlementOptions: # Optional tuning
      threshold: '1000000'
      settlementTimeoutSecs: 86400

  - chainType: solana
    chainId: solana:mainnet
    rpcUrl: https://api.mainnet-beta.solana.com
    programId: 'YourProgram...'
    keyId: '<base58 ed25519 secret key>' # env fallback: SOLANA_PRIVATE_KEY

  - chainType: mina
    chainId: mina:mainnet
    graphqlUrl: https://proxy.minaprotocol.com/graphql
    zkAppAddress: 'B62q...'
    keyId: 'EKE...'
```

Each peer's `chain` field determines which provider handles settlement for that peer. You can run EVM, Solana, and Mina peers in the same network — the connector routes settlement to the right chain automatically. A **Solana-only or Mina-only** node (no EVM `chainProvider`) is fully supported: it boots the settlement stack and redeems claims on-chain. Non-EVM settlement is **claim-driven redemption** of channels opened out-of-band — the connector does not open Solana/Mina channels on demand. See [docs/solana-deployment.md](docs/solana-deployment.md) and [docs/mina-deployment.md](docs/mina-deployment.md).

> **Migrating from `settlementInfra`?** The legacy `settlementInfra` config block was removed in v2.3.0. If your config still uses it, the connector will print a clear error message explaining how to move your settings into `chainProviders`. See the [connector package README](packages/connector/README.md) for the full migration guide.

### Payment Channels: How They Work

A payment channel is a smart contract (or zkApp, or Solana program) that holds funds in escrow. Both parties can update the balance off-chain by signing claims. Only the final balance is submitted on-chain.

```
1. Open channel:
   Both parties deposit funds into a smart contract

2. Off-chain updates (thousands of transactions):
   Agent A → Connector: signed claim "I owe you 100 tokens"
   Agent A → Connector: signed claim "I owe you 200 tokens" (replaces previous)
   Agent A → Connector: signed claim "I owe you 750 tokens" (replaces previous)

3. Close channel:
   Either party submits the latest signed claim to the smart contract
   Smart contract releases funds based on the claim
```

**Key benefit:** One on-chain transaction per channel lifecycle, unlimited off-chain transactions.

## ATOR Overlay Transport: Run a Peer from Anywhere

By default, connectors peer over direct TCP WebSocket connections. For operators who want **network-level privacy** — or who need to run a peer from a home network without exposing ports — the connector supports **ATOR overlay transport**.

[ATOR](https://anyone.io) (Anyone Protocol) is an incentivized onion-routing network based on Tor. When enabled, the connector tunnels all outbound BTP traffic through ATOR circuits and can accept inbound connections via a `.anon` hidden service. This means:

- **No port forwarding required.** Your home router doesn't need any special configuration. The hidden service handles inbound connections through the overlay network.
- **IP address stays private.** Peers see a `.anon` address, not your home IP. Traffic is onion-routed through multiple relays.
- **NAT traversal built in.** Works behind carrier-grade NAT, double NAT, and restrictive firewalls — anywhere that can make an outbound TCP connection.

This makes it practical to run a connector on a Raspberry Pi, a laptop, or any machine on a home network without the operational overhead of VPNs, dynamic DNS, or firewall rules.

### How It Works

```
Your home network                          ATOR overlay
┌───────────────────┐                    ┌─────────────┐
│  Connector        │── outbound TCP ──►│  3+ relays   │──► Peer's connector
│  (no open ports)  │◄── .anon HS ──────│  (encrypted) │◄── Peer connects to you
└───────────────────┘                    └─────────────┘
```

Transport is opt-in. Add a `transport` block to your config to enable it:

```yaml
transport:
  type: socks5
  socksUrl: socks5h://127.0.0.1:9050 # ATOR SOCKS5 proxy
  managed: true # Auto-start/stop the ATOR binary
  hiddenService:
    enabled: true # Accept inbound via .anon address
    hostname: your-address.anon # Assigned on first start
    virtualPort: 3000
```

There are two ways to run ATOR:

- **Managed mode** — The connector starts and monitors the ATOR binary automatically. Recommended for most operators.
- **External mode** — You run `anon` (or system `tor`) yourself and point the connector at its SOCKS5 port. Useful for shared infrastructure or custom configurations.

Both modes enforce `socks5h://` (DNS resolution at the proxy) to prevent DNS leaks.

See the full [ATOR Transport Guide](docs/ator-transport.md) for configuration examples, monitoring, performance tuning, and troubleshooting.

## Deployment Modes

The connector supports two deployment modes via the `deploymentMode` configuration:

### `embedded` Mode (Default)

**When to use:**

- Building an AI agent with embedded connector
- Running Town relay with integrated payments
- Single-process deployment

**Behavior:**

- Business logic runs in the same process
- Use `setPacketHandler()` to handle incoming payments
- No HTTP overhead
- Fastest performance

**Example:** [Town relay](https://github.com/ALLiDoizCode/crosstown) uses `embedded` mode to integrate ILP payments directly into the Nostr relay.

### `standalone` Mode

**When to use:**

- Running connector as microservice infrastructure
- Process isolation between connector and business logic
- Language-agnostic integration via HTTP

**Behavior:**

- Connector forwards packets to external HTTP endpoint (`localDelivery.handlerUrl`)
- Business logic server handles packets and returns accept/reject
- Admin API enabled for sending packets via HTTP

**Example:** A Python AI agent that calls the connector's HTTP API to send payments.

## Packages

This repo is a monorepo with multiple packages:

| Package                                          | Description                                            |
| ------------------------------------------------ | ------------------------------------------------------ |
| [`@toon-protocol/connector`](packages/connector) | Connector node — routing, accounting, settlement, CLI  |
| [`@toon-protocol/shared`](packages/shared)       | Shared types and OER codec utilities                   |
| [`@toon-protocol/contracts`](packages/contracts) | EVM payment channel smart contracts (Foundry/Solidity) |
| [`@m2m-connector/faucet`](packages/faucet)       | Token faucet for local EVM testing                     |

## Explorer UI

The connector includes a built-in real-time dashboard for observability:

```yaml
explorer:
  enabled: true
  port: 3001 # or set EXPLORER_PORT env var
```

Open `http://localhost:3001` to:

- Watch packets flow through the network in real-time
- View peer balances and routing tables
- Monitor settlement events
- Debug routing decisions

Perfect for development and debugging. Disable in production.

## Example: Town Integration

[Town](https://github.com/ALLiDoizCode/crosstown) is a Nostr relay that uses connector as its payment layer. Town is a separate project — see its repository for full integration details.

**How it works conceptually:**

1. Town creates a `ConnectorNode` (payment infrastructure)
2. The relay wraps the connector with Nostr-specific logic (event storage, subscriptions, TOON encoding)
3. Events flow as ILP packets with payment attached — free to read, pay to write

**Key insight:** Town doesn't implement payment routing — it delegates to connector. Connector handles routing, accounting, and settlement so applications can focus on business logic.

## Architecture: Two Modes

### Embedded Mode

```
┌─────────────────────────────────────────────┐
│  Your Agent                                  │
│  import @toon-protocol/connector             │
│  setPacketHandler() + sendPacket()           │
└──────────────────┬──────────────────────────┘
                   │ (same process)
┌──────────────────▼──────────────────────────┐
│  @toon-protocol/connector                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │ Routing  │ │ BTP/WS   │ │ Ledger   │    │
│  │ Table    │ │ Peers    │ │ Accounts │    │
│  └──────────┘ └──────────┘ └──────────┘    │
│  ┌──────────────────────────────────────┐   │
│  │  Settlement (optional, multi-chain)  │   │
│  └──────────┬───────────────────────────┘   │
└─────────────┼───────────────────────────────┘
              │
      ┌───────▼────────┐
      │ EVM / Solana / │
      │ Mina           │
      └────────────────┘
```

### Standalone Mode

```
┌──────────────┐   /handle-packet   ┌──────────────┐
│  Your BLS    │◄──────────────────│  @toon-protocol/ │
│              │                    │  connector   │
│  Outbound:   │  /admin/ilp/send  │              │
│  POST ───────│──────────────────►│              │
└──────────────┘                    └──────┬───────┘
                                           │
                                    ┌──────▼───────┐
                                    │ Blockchains  │
                                    └──────────────┘
```

## Docker Deployment

The simplest production-ready topology is a **standalone connector paired with your Business Logic Server (BLS)**, both running in Docker containers on a single host. `docker-compose.prod.yml` ships this pattern out of the box.

Two compose files ship at the repo root:

| Compose file              | Purpose                                                                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.prod.yml` | **Production deployment.** Connector + BLS, secure by default.                                                                                                                                                                   |
| `docker-compose.yml`      | **Development/test profiles.** Anvil, Solana, Mina, ATOR testnet, and the standalone-mode E2E test profiles (`standalone-e2e`, `standalone-ator-public`, `standalone-ator-p2p`, `standalone-allowlist`). Not for production use. |

### Production Deployment: Standalone Connector + BLS

The production stack runs a single connector and your BLS on an isolated Docker bridge network. The admin API is reachable only from the BLS container — it is **not** published to the host interface.

**Step 1 — Pull the image** (or build locally)

```bash
# Option A: Pull the published image (recommended for deployments).
# Images are published to GHCR on every push to main.
docker pull ghcr.io/toon-protocol/connector:latest

# Option B: Build locally from source. Uncomment the `build:` block in
# docker-compose.prod.yml and comment out the `image:` line.
docker compose -f docker-compose.prod.yml build
```

**Step 2 — Customize the config**

Edit [`config/connector.prod.yaml`](config/connector.prod.yaml) to set your node ID, peers, and routes. The template ships Tier-3 security defaults:

```yaml
# config/connector.prod.yaml (excerpt)
nodeId: prod-connector
deploymentMode: standalone

adminApi:
  enabled: true
  host: 0.0.0.0 # inside container only; not published to host
  port: 8081
  allowedIPs:
    - 172.16.0.0/12 # docker user-defined-bridge pool
    - 192.168.0.0/16 # fallback

localDelivery:
  enabled: true
  handlerUrl: http://bls:3100 # compose-DNS resolves to sibling container

peers: []
routes: []
```

**Step 3 — Start the stack**

```bash
docker compose -f docker-compose.prod.yml up -d

# Verify both containers are healthy:
docker compose -f docker-compose.prod.yml ps

# The BLS health endpoint is the only host-exposed port:
curl http://127.0.0.1:3100/health
```

**Step 4 — Verify the BLS can call the admin API**

```bash
# The BLS container drives admin calls over the compose network:
curl -X POST http://127.0.0.1:3100/trigger-admin-send \
  -H 'Content-Type: application/json' \
  -d '{"destination":"test.prod-connector.self","amount":"0"}'
# → {"accepted":false,"code":"F02","message":"No route to destination: ..."}
# (F02 is expected with an empty routes list — it proves the admin API accepted
# the call from the BLS but had nowhere to forward it.)

# Direct access to the admin API from the host is refused:
curl -m 2 http://127.0.0.1:8081/admin/peers
# → (no response; port is not published)
```

**Step 5 — Tear down**

```bash
docker compose -f docker-compose.prod.yml down           # preserves the connector data volume
docker compose -f docker-compose.prod.yml down --volumes  # wipes the data volume too
```

### Writing Your Own BLS

The compose file ships a minimal BLS (`scripts/standalone-e2e/bls.js`) that fulfills every inbound packet — fine for smoke-testing, not for production. Your real BLS is a plain HTTP server that speaks two endpoints. Any language works: if it can serve HTTP + JSON, it can be a BLS.

#### The HTTP contract

**`GET /health`** — return any 200 response when ready. Used by docker compose healthchecks and by the connector.

**`POST /handle-packet`** — the connector posts here for every inbound packet addressed to your agent.

_Request body_ (simplified shape from [`packages/connector/src/core/payment-handler.ts`](packages/connector/src/core/payment-handler.ts)):

```json
{
  "paymentId": "base64url-16-bytes",
  "destination": "test.my-agent.user-42",
  "amount": "1000",
  "expiresAt": "2026-04-20T18:42:00.000Z",
  "data": "base64-encoded-app-data-optional",
  "isTransit": false
}
```

- `amount` is a **string** — amounts can exceed JS safe integer range, so never parse as `number`
- `data` is optional; base64 of up to 32 KB of application payload
- `isTransit: true` means it's a pass-through notification at an intermediate hop — your response is **ignored**; treat as fire-and-forget

_Response body_ — accept:

```json
{ "accept": true, "data": "base64-optional-echo-payload" }
```

_Response body_ — reject:

```json
{
  "accept": false,
  "rejectReason": {
    "code": "insufficient_funds",
    "message": "Balance 42 < required 1000"
  }
}
```

Your business `code` is auto-mapped to an ILP error code by the connector:

| Your `code`          | → ILP | Meaning                     |
| -------------------- | ----- | --------------------------- |
| `insufficient_funds` | `T04` | try again later             |
| `expired`            | `R00` | packet expired              |
| `invalid_request`    | `F00` | permanent malformed request |
| `invalid_amount`     | `F03` | amount not accepted         |
| `unexpected_payment` | `F06` | no reason to pay us         |
| `application_error`  | `F99` | generic application reject  |
| `internal_error`     | `T00` | server broke                |
| `timeout`            | `T00` | operation timed out         |
| _(anything else)_    | `F99` | fallback                    |

#### Minimal Node.js BLS (drop-in replacement)

Create a `bls/` directory alongside `docker-compose.prod.yml`:

```text
bls/
├── Dockerfile
├── package.json
└── server.js
```

`bls/server.js`:

```javascript
import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ status: 'healthy' }));

app.post('/handle-packet', async (req, res) => {
  const { paymentId, destination, amount, data, isTransit } = req.body;
  console.log(
    `[BLS] ${isTransit ? 'transit' : 'deliver'} ${amount} → ${destination} (${paymentId})`
  );

  // Your business logic here. Return accept:true/false based on whatever
  // invariants your application enforces (balance checks, whitelists, etc.).
  if (BigInt(amount) > 100_000n) {
    return res.json({
      accept: false,
      rejectReason: { code: 'invalid_amount', message: 'amount exceeds limit' },
    });
  }

  // Optionally echo app data back in the fulfill packet:
  res.json({ accept: true, data });
});

// Optional: originate outbound packets via the connector's admin API.
app.post('/send', async (req, res) => {
  const adminRes = await fetch(`${process.env.CONNECTOR_ADMIN_URL}/admin/ilp/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      destination: req.body.destination,
      amount: req.body.amount,
      data: req.body.data ?? '',
    }),
  });
  res.status(adminRes.status).send(await adminRes.text());
});

app.listen(Number(process.env.PORT ?? 3100), '0.0.0.0', () =>
  console.log(`BLS listening on :${process.env.PORT ?? 3100}`)
);
```

`bls/package.json`:

```json
{
  "name": "my-bls",
  "type": "module",
  "dependencies": { "express": "^4.19.0" }
}
```

`bls/Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.js .
EXPOSE 3100
CMD ["node", "server.js"]
```

#### Minimal Python BLS (Flask)

If you prefer Python, the contract is identical:

`bls/app.py`:

```python
import os
from flask import Flask, request, jsonify

app = Flask(__name__)

@app.get('/health')
def health():
    return {'status': 'healthy'}

@app.post('/handle-packet')
def handle_packet():
    body = request.get_json()
    amount = int(body['amount'])   # amount is a string; parse carefully
    destination = body['destination']
    print(f"[BLS] {amount} → {destination} ({body['paymentId']})")

    if amount > 100_000:
        return jsonify(accept=False, rejectReason={
            'code': 'invalid_amount', 'message': 'amount exceeds limit'
        })
    return jsonify(accept=True, data=body.get('data'))

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 3100)))
```

`bls/Dockerfile`:

```dockerfile
FROM python:3.12-alpine
WORKDIR /app
RUN pip install --no-cache-dir flask
COPY app.py .
EXPOSE 3100
CMD ["python", "app.py"]
```

#### Wire it into `docker-compose.prod.yml`

Replace the sample BLS block with your own:

```yaml
services:
  bls:
    build: ./bls # your Dockerfile above
    restart: unless-stopped
    environment:
      PORT: '3100'
      CONNECTOR_ADMIN_URL: http://connector:8081 # compose DNS, same bridge net
    ports:
      - '127.0.0.1:3100:3100' # loopback only
    healthcheck:
      test:
        ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://127.0.0.1:3100/health || exit 1']
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 5s
    depends_on:
      connector:
        condition: service_healthy
    networks:
      - app_net
```

Everything else in the compose file stays as-is — same network, same allowlist picks up your BLS's bridge-subnet IP automatically, same admin API reachable at `http://connector:8081`.

#### Run it

```bash
docker compose -f docker-compose.prod.yml up -d --build

# Health check your BLS:
curl http://127.0.0.1:3100/health

# Drive a test packet from your BLS through the connector:
curl -X POST http://127.0.0.1:3100/send \
  -H 'Content-Type: application/json' \
  -d '{"destination":"test.peer-b.user","amount":"10"}'

# Follow BLS logs to see inbound `/handle-packet` calls:
docker compose -f docker-compose.prod.yml logs -f bls
```

That's the whole integration. The connector handles ILP routing, settlement, claim validation, transport, and admin APIs. Your BLS handles the part that matters to your application: _what do we do with this payment?_

### Enabling ATOR Transport (Public Anyone Network)

Route the connector's BTP WebSocket traffic through the public Anyone Protocol network for sender-side anonymity. This uses SOCKS5 egress against the public Anyone proxies — no additional containers required.

**Step 1 — Uncomment the transport block** in `config/connector.prod.yaml`:

```yaml
transport:
  type: socks5
  managed: false
  socksProxy: socks5h://5.78.181.0:9052
  externalUrl: ws://placeholder
```

**Step 2 — Restart the connector**

```bash
docker compose -f docker-compose.prod.yml up -d --force-recreate connector

# Verify transport is live + healthy:
curl -s http://127.0.0.1:3100/health
# The connector's health endpoint (inside its container) will report:
#   transport: { type: 'socks5', healthy: true }
# once the SOCKS5 probe to the public proxy succeeds.
```

**Changing regions / using your own proxy.** The `socksProxy` field takes any `socks5h://host:port` URL. The Anyone team publishes three public proxies (Oregon, Nürnberg, Warsaw) — swap the URL to the one geographically closest to your connector:

```yaml
# Option A — Oregon, USA
socksProxy: socks5h://5.78.181.0:9052

# Option B — Nürnberg, Germany
socksProxy: socks5h://157.90.113.23:9052

# Option C — Warsaw, Poland
socksProxy: socks5h://57.128.249.250:9052

# Option D — Your own anon-client sidecar
socksProxy: socks5h://my-anon-sidecar:9050
```

The authoritative list of public proxies is at <https://docs.anyone.io/connect/public-proxies>. If a proxy becomes unavailable, pick another from that page and restart the connector.

**Peer-to-peer ATOR routing** (both ends of a BTP link anonymized via hidden services) is a more advanced topology — see `docker compose --profile standalone-ator-p2p` in [`docker-compose.yml`](docker-compose.yml) and [`test/integration/standalone-ator-public-p2p-container-e2e.test.ts`](packages/connector/test/integration/standalone-ator-public-p2p-container-e2e.test.ts) for a working reference implementation.

### Troubleshooting

```bash
# Follow logs:
docker compose -f docker-compose.prod.yml logs -f connector
docker compose -f docker-compose.prod.yml logs -f bls

# Rebuild from source after local changes:
docker compose -f docker-compose.prod.yml build --no-cache connector

# Exec into the running connector (image runs as non-root user 'node'):
docker compose -f docker-compose.prod.yml exec connector sh
```

### Security Posture Summary

The production compose ships secure-by-default:

| Concern                       | Default behavior                                                 |
| ----------------------------- | ---------------------------------------------------------------- |
| Admin API reachable on host   | **No** — port 8081 is not published                              |
| Admin API reachable cross-net | **No** — `allowedIPs` restricts callers to docker bridge subnets |
| Packet-delivery BLS exposed   | Loopback only — `127.0.0.1:3100`                                 |
| Connector runs as root        | **No** — image runs as non-root user `node` (uid 1000)           |
| Secrets in YAML               | None in the template — `apiKey` is commented out by default      |

If your deployment publishes the admin API (e.g., behind a reverse proxy), you **must** additionally set `adminApi.apiKey` in the config and inject the value from a secrets manager — do not commit keys to the YAML.

## Development

```bash
# Clone and install
git clone https://github.com/ALLiDoizCode/connector.git
cd connector
npm install

# Build all packages
npm run build

# Run tests
npm test

# Start a local dev network (requires TigerBeetle installation)
npm run dev
```

### Getting started with Devbox

[Devbox](https://www.jetify.com/devbox) pins the full local toolchain (Node, Rust, Solana CLI, Foundry, jq) to exact versions and provides a reproducible shell that matches CI.

**Install Devbox:**

```bash
curl -fsSL https://get.jetify.com/devbox | bash
```

**Enter the pinned shell:**

```bash
devbox shell
```

Inside the shell, all tools are on `PATH` at the versions committed in `devbox.json`:

| Tool                       | Version |
| -------------------------- | ------- |
| Node.js                    | 22.11.0 |
| Rust (via rustup)          | stable  |
| Solana CLI                 | 2.3.3   |
| Foundry (forge/cast/anvil) | 1.7.1   |
| jq                         | 1.7.1   |

The `init_hook` runs `rustup default stable` and adds the `bpfel-unknown-unknown` target automatically on shell entry, so `cargo build-sbf` and `cargo test-sbf` work immediately.

**Run the standard workflow inside devbox shell:**

```bash
devbox shell
npm install
npm run build
make test
```

The Docker Compose chain infra (`make anvil-up`, `make solana-up`, `make mina-up`) is unchanged — devbox provides the toolchain, Docker provides the chain nodes.

### Requirements

- **Node.js** >= 22.11.0
- **Docker** >= 20.10.0 (for container deployments)
- **Docker Compose** >= 2.0.0

**macOS note:** For local development with TigerBeetle outside Docker, run `npm run tigerbeetle:install` first.

## Documentation

| Guide                                             | Description                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| [Configuration Examples](examples/README.md)      | YAML config schema and example files                              |
| [Connector Package](packages/connector/README.md) | Implementation reference, API, and `chainProviders` config        |
| [ATOR Overlay Transport](docs/ator-transport.md)  | Privacy transport: setup, config, monitoring, and troubleshooting |
| [Solana Deployment](docs/solana-deployment.md)    | Solana program deployment and devnet testing                      |
| [Mina Deployment](docs/mina-deployment.md)        | Mina zkApp deployment and lightnet testing                        |
| [Changelog](CHANGELOG.md)                         | Version history and release notes                                 |
| [Contributing](CONTRIBUTING.md)                   | Contribution guidelines                                           |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](LICENSE).

## Links

- **GitHub:** [github.com/ALLiDoizCode/connector](https://github.com/ALLiDoizCode/connector)
- **Town:** [github.com/ALLiDoizCode/crosstown](https://github.com/ALLiDoizCode/crosstown)
- **Interledger:** [interledger.org](https://interledger.org)
- **TigerBeetle:** [tigerbeetle.com](https://tigerbeetle.com)
