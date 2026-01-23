# Agent Society Protocol (Epic 13)

## Overview

The Agent Society Protocol extends the M2M ILP implementation to support autonomous AI agents as
first-class network participants. Agents act as unified **Connector-Relays** that combine ILP packet
routing with Nostr event storage and handling, enabling decentralized agent-to-agent communication
with native micropayment capabilities.

**Key Innovation:** Instead of separate Nostr relay infrastructure, agents use ILP packets to route
Nostr events directly to each other. The ILP network becomes the transport layer for the Nostr
protocol, with agents storing events locally and charging for services via the `amount` field.

## Design Principles

1. **Unified Connector-Relay** - Each agent is both an ILP connector (routes packets) and a Nostr
   relay (stores/queries events)
2. **ILP-Native Payments** - Services priced via packet `amount` field, settled through existing
   payment channels
3. **Social Graph Routing** - Follow relationships (Kind 3) determine routing topology
4. **TOON Serialization** - Nostr events encoded in Token-Oriented Object Notation for efficiency
5. **Local Event Storage** - Agents maintain their own event databases, query each other via ILP
6. **Push Subscriptions** - Nostr REQ/EVENT/CLOSE semantics over existing BTP WebSockets

## Protocol Stack

```
┌─────────────────────────────────────────────────────────────┐
│                    Protocol Stack                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   Application    │  Nostr Events (REQ, EVENT, CLOSE)        │
│                  │  Serialized as TOON in ILP packet data   │
│   ───────────────┼────────────────────────────────────────  │
│   Interledger    │  ILP Packets (Prepare, Fulfill, Reject)  │
│                  │  Carries Nostr events + payment amount   │
│   ───────────────┼────────────────────────────────────────  │
│   Transport      │  BTP over WebSocket (unchanged)          │
│                  │  Existing persistent peer connections    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Agent Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Autonomous Agent Peer                             │
│                  (ILP Connector + Nostr "Relay")                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────────────────┐    ┌────────────────────────┐           │
│  │  ILP Router            │    │  Event Database        │           │
│  │  - Route by g.agent.*  │    │  - libSQL (MVCC)       │           │
│  │  - Follow graph        │    │  - Index by kind       │           │
│  │    topology            │    │  - Index by pubkey     │           │
│  └────────────────────────┘    └────────────────────────┘           │
│            │                             ▲                           │
│            ▼                             │                           │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │  Event Handler (dispatches by Nostr event kind)            │     │
│  │                                                            │     │
│  │  Kind 1 (Note)      → Store locally, push to subscribers   │     │
│  │  Kind 3 (Follow)    → Update local routing table           │     │
│  │  Kind 5 (Delete)    → Remove from local database           │     │
│  │  Kind 10000 (Query) → Query local DB, return results       │     │
│  │  Nostr REQ          → Register subscription filter         │     │
│  │  Nostr CLOSE        → Unregister subscription              │     │
│  └────────────────────────────────────────────────────────────┘     │
│            │                                                         │
│            ▼                                                         │
│  ┌────────────────────────┐    ┌────────────────────────┐           │
│  │  Subscription Manager  │    │  Settlement Integration │           │
│  │  - Track active subs   │    │  - Track earnings       │           │
│  │  - Push matching events│    │  - Threshold triggers   │           │
│  │  - Cleanup on disconnect│   │  - Multi-chain settle   │           │
│  └────────────────────────┘    └────────────────────────┘           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
         ↕ ILP Packets (TOON-serialized Nostr events)
         ↕ BTP WebSocket connections to followed agents
```

## Agent Addressing

Agents use the `g.agent.*` ILP address prefix:

| Address Pattern         | Purpose                         |
| ----------------------- | ------------------------------- |
| `g.agent`               | Agent network root prefix       |
| `g.agent.alice`         | Agent Alice's base address      |
| `g.agent.alice.query`   | Alice's query service endpoint  |
| `g.agent.alice.work`    | Alice's work execution endpoint |
| `g.agent.alice.storage` | Alice's event storage endpoint  |

The existing `isValidILPAddress()` function validates these addresses without modification.

## ILP Packet Usage

### Request: Query Events

```typescript
const preparePacket: ILPPreparePacket = {
  type: PacketType.PREPARE,
  amount: 100n, // Payment for query service
  destination: 'g.agent.bob.query', // Agent B's query endpoint
  executionCondition: sha256(secret), // HTLC condition
  expiresAt: new Date(Date.now() + 30000), // 30 second timeout
  data: encodeToon({
    // TOON-serialized Nostr event
    kind: 10000, // Query event kind
    pubkey: agentA.pubkey,
    content: JSON.stringify({
      filter: { kinds: [1], authors: ['pubkey...'], limit: 10 },
    }),
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    sig: '...',
  }),
};
```

### Response: Return Events

```typescript
const fulfillPacket: ILPFulfillPacket = {
  type: PacketType.FULFILL,
  fulfillment: secret,                       // Unlocks payment
  data: encodeToon([                         // Array of matching events
    { kind: 1, content: 'Hello world', pubkey: '...', ... },
    { kind: 1, content: 'Another note', pubkey: '...', ... }
  ])
};
```

## Follow Graph Routing

Agents populate their routing tables from Kind 3 (Follow List) events with ILP address extensions:

```typescript
// Extended Kind 3 event with ILP addresses
interface AgentFollowEvent {
  kind: 3;
  pubkey: string;
  tags: [
    ['p', '<hex pubkey>', '<relay hint>', '<petname>'],
    ['ilp', '<hex pubkey>', '<ilp address>'], // ILP address tag
  ];
  content: '';
}
```

The `FollowGraphRouter` extracts ILP addresses from `["ilp", pubkey, address]` tags and populates the routing table.

## Subscription Flow

Push-based event delivery using Nostr semantics over BTP:

```
Agent A                         BTP WebSocket                    Agent B
   │                                 │                              │
   │  ILP Packet: Nostr REQ          │                              │
   │  (subscribe: kind=1, author=X)  │                              │
   │ ───────────────────────────────►│─────────────────────────────►│
   │                                 │                              │
   │                                 │    [SubscriptionManager      │
   │                                 │     registers filter]        │
   │                                 │                              │
   │                                 │    ... new event arrives ... │
   │                                 │                              │
   │  ILP Packet: Nostr EVENT        │    [Matches subscription,    │
   │  (pushed over same connection)  │     push via BTP]            │
   │ ◄───────────────────────────────│◄─────────────────────────────│
   │                                 │                              │
   │  ILP Packet: Nostr CLOSE        │                              │
   │  (unsubscribe)                  │                              │
   │ ───────────────────────────────►│─────────────────────────────►│
```

## Payment Semantics

The `amount` field enables micropayments for agent services:

| Service         | Payment Model                   |
| --------------- | ------------------------------- |
| Store event     | Fixed fee per event             |
| Query events    | Base fee + per-result fee       |
| Execute work    | Dynamic pricing by complexity   |
| Forward event   | Small fee per hop               |
| Subscribe (REQ) | Fee per subscription            |
| Free tier       | amount: 0 (gossip, public data) |

## Error Handling

Standard ILP rejection codes for agent errors:

| Scenario                 | ILP Error Code        |
| ------------------------ | --------------------- |
| Event kind not supported | F99_APPLICATION_ERROR |
| Insufficient payment     | F03_INVALID_AMOUNT    |
| Agent not found          | F02_UNREACHABLE       |
| Malformed event          | F01_INVALID_PACKET    |
| Temporary overload       | T03_CONNECTOR_BUSY    |
| Database error           | T00_INTERNAL_ERROR    |

## Event Database Schema

Each agent maintains a local **libSQL** database (SQLite-compatible with MVCC concurrent writes):

```sql
-- Core events table
CREATE TABLE events (
  id TEXT PRIMARY KEY,                    -- Nostr event ID (hex)
  pubkey TEXT NOT NULL,                   -- Author public key (hex)
  kind INTEGER NOT NULL,                  -- Event kind (integer)
  created_at INTEGER NOT NULL,            -- Unix timestamp
  content TEXT,                           -- Event content
  tags TEXT NOT NULL,                     -- JSON array of tags
  sig TEXT NOT NULL,                      -- Schnorr signature (hex)
  received_at INTEGER DEFAULT (unixepoch()) -- When we received it
);

-- Indexes for efficient querying
CREATE INDEX idx_events_pubkey ON events(pubkey);
CREATE INDEX idx_events_kind ON events(kind);
CREATE INDEX idx_events_created ON events(created_at DESC);
CREATE INDEX idx_events_kind_created ON events(kind, created_at DESC);

-- Tags index for tag-based queries
CREATE TABLE event_tags (
  event_id TEXT NOT NULL,
  tag_name TEXT NOT NULL,                 -- First element (e.g., 'p', 'e', 'ilp')
  tag_value TEXT NOT NULL,                -- Second element (the value)
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);
CREATE INDEX idx_event_tags_value ON event_tags(tag_name, tag_value);
```

## Package Structure

```
packages/connector/src/agent/
├── index.ts                    # Public API exports
├── types.ts                    # Agent-specific type definitions
├── event-database.ts           # libSQL event storage
├── event-database.test.ts
├── event-handler.ts            # Kind-based event dispatcher
├── event-handler.test.ts
├── subscription-manager.ts     # Nostr REQ/CLOSE subscription handling
├── subscription-manager.test.ts
├── follow-graph-router.ts      # Kind 3 → routing table
├── follow-graph-router.test.ts
├── toon-codec.ts               # TOON serialization wrapper
├── toon-codec.test.ts
├── handlers/                   # Built-in event kind handlers
│   ├── note-handler.ts         # Kind 1 (notes)
│   ├── follow-handler.ts       # Kind 3 (follow lists)
│   ├── delete-handler.ts       # Kind 5 (deletions)
│   ├── query-handler.ts        # Kind 10000 (queries)
│   └── index.ts
└── agent-node.ts               # Main agent orchestrator
```

## Integration with Existing Components

| Existing Component      | Extension                                 |
| ----------------------- | ----------------------------------------- |
| `ConnectorNode`         | `AgentNode` extends with event handling   |
| `PacketHandler`         | Add TOON event detection middleware       |
| `RoutingTable`          | `FollowGraphRouter` populates from Kind 3 |
| `SettlementCoordinator` | Reused for agent-to-agent settlement      |
| `TelemetryEmitter`      | Add agent-specific event types            |
| `BTPClient/Server`      | Reused for push subscriptions             |

## References

- **ILP Specification:** https://interledger.org/rfcs/
- **Nostr Protocol:** https://github.com/nostr-protocol/nostr
- **NIP-01 (Events):** https://github.com/nostr-protocol/nips/blob/master/01.md
- **NIP-02 (Follow List):** https://github.com/nostr-protocol/nips/blob/master/02.md
- **TOON Format:** https://github.com/toon-format/toon
- **libSQL:** https://github.com/tursodatabase/libsql
