---
name: agent-society-test
description: Run comprehensive Agent Society Protocol integration test. Creates N agent peers with Nostr keypairs, establishes a social graph with hardcoded follower relationships, deploys AGENT ERC20 token and TokenNetwork contracts on local Anvil, opens payment channels between connected peers, and simulates TOON-encoded event exchange with payments over ILP/BTP. Use when testing multi-agent communication, payment channel integration, or end-to-end Agent Society Protocol flows. Triggers on "agent society test", "test agent network", "multi-agent integration", "/agent-society-test", or "run agent test".
---

# Agent Society Integration Test

Run a comprehensive end-to-end test of the Agent Society Protocol with N agent peers communicating via ILP/BTP and settling payments through EVM payment channels.

## Prerequisites

Ensure the development infrastructure is running:

```bash
docker compose -f docker-compose-dev.yml up -d anvil
```

Verify Anvil is accessible:
```bash
curl -s http://localhost:8545 -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

## Running the Test

### Via Jest (Recommended)

```bash
cd packages/connector
E2E_TESTS=true npx jest agent-society-integration.test.ts --verbose
```

### Configuration Options

Set environment variables to customize the test:

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_SOCIETY_PEER_COUNT` | 5 | Number of peers to create |
| `ANVIL_RPC_URL` | `http://localhost:8545` | Anvil EVM RPC endpoint |
| `SKIP_CHANNELS` | false | Skip payment channel setup (faster test) |
| `VERBOSE` | false | Enable detailed logging |

Example with options:
```bash
AGENT_SOCIETY_PEER_COUNT=3 E2E_TESTS=true npx jest agent-society-integration.test.ts
```

## What the Test Does

1. **Deploys Contracts**: MockERC20 "AGENT" token and TokenNetwork for payment channels
2. **Creates N Peers**: Each with Nostr keypair, ILP address, AgentNode, and EVM wallet
3. **Establishes Social Graph**: Hub-and-spoke + ring topology
4. **Opens Payment Channels**: Between all connected peers using AGENT token
5. **Simulates Events**: Kind 1 notes exchanged with payments via ILP/BTP
6. **Verifies Results**: Events stored, payments processed, routing works

## Social Graph Topology

For 5 peers (default):
```
Peer 0 (Hub) --> follows [1, 2, 3, 4]
Peer 1 --> follows [0, 2]
Peer 2 --> follows [0, 1, 3]
Peer 3 --> follows [0, 2, 4]
Peer 4 --> follows [0, 3]
```

## Test Output

The test reports:
- Number of peers initialized
- Social graph connections established
- Events sent and received
- Payment channel operations
- Verification check results

## Troubleshooting

**Anvil not running**: Start with `docker compose -f docker-compose-dev.yml up -d anvil`

**Test timeout**: Increase Jest timeout or reduce peer count

**Contract deployment fails**: Check Anvil logs with `docker logs anvil_base_local`
