# Epic 13: Agent Society Protocol (ILP + Nostr Integration)

## Executive Summary

Extend the M2M ILP implementation to support autonomous AI agents as unified **Connector-Relays**
that combine ILP packet routing with Nostr event storage and handling. This creates a foundational
protocol for an agent society—a distributed system where autonomous agents communicate, compensate
each other for work, and route transactions through social network topology.

The protocol leverages existing standards (ILP, Nostr, TOON) without requiring new consensus
mechanisms or separate relay infrastructure.

## Vision

Create a protocol that enables:

- **Autonomous agents** as first-class peers in the ILP network
- **Decentralized communication** via Nostr events routed through ILP (not separate relays)
- **Direct agent-to-agent value transfer** through ILP packet `amount` field
- **Social topology-based routing** using Nostr follow relationships (Kind 3)
- **Local event storage** with agents acting as their own "relays"
- **Micropayment-enabled services** (queries, storage, work execution)

## Architecture Decision: Unified Connector-Relay

### Key Insight

Instead of connecting to external Nostr relays, agents **ARE the relays**:

- Each agent is both an ILP connector (routes packets) and a Nostr relay (stores/queries events)
- ILP packets transport TOON-serialized Nostr events between agents
- Agents maintain local libSQL databases for event persistence (MVCC concurrent writes)
- The ILP network becomes the transport layer for Nostr protocol

### Benefits

| Traditional Approach            | Agent Society Approach                  |
| ------------------------------- | --------------------------------------- |
| External Nostr relay dependency | Self-contained agent network            |
| Separate payment rails          | Native ILP micropayments                |
| Centralized relay points        | Fully decentralized                     |
| Relay subscription model        | Nostr subscriptions over BTP WebSockets |

## Core Protocol Specification

### 1. Packet Structure

ILP packets contain TOON-serialized Nostr events in the `data` field:

```typescript
interface ILPPreparePacket {
  type: PacketType.PREPARE;
  amount: bigint; // Payment for service
  destination: ILPAddress; // g.agent.* address
  executionCondition: Buffer; // HTLC condition
  expiresAt: Date; // Timeout
  data: Buffer; // TOON-serialized Nostr event
}
```

- ILP packet types (Prepare, Fulfill, Reject) unchanged
- `data` field: Always contains TOON-serialized Nostr event(s)
- TOON serialization: 30-60% smaller than JSON, LLM-friendly format

### 2. Agent Addressing

ILP address format for agents:

```
g.agent.{identifier}[.endpoint]
```

Examples:

- `g.agent.alice` - Agent Alice's base address
- `g.agent.alice.query` - Alice's query service
- `g.agent.alice.work` - Alice's work execution endpoint
- `g.agent.bob.storage` - Bob's event storage service

### 3. Event Storage

Each agent maintains a local **libSQL** database (SQLite-compatible with MVCC concurrent writes):

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,           -- Nostr event ID
  pubkey TEXT NOT NULL,          -- Author pubkey
  kind INTEGER NOT NULL,         -- Event kind
  created_at INTEGER NOT NULL,   -- Unix timestamp
  content TEXT,                  -- Event content
  tags TEXT NOT NULL,            -- JSON tags array
  sig TEXT NOT NULL              -- Signature
);

CREATE INDEX idx_events_pubkey ON events(pubkey);
CREATE INDEX idx_events_kind ON events(kind);
CREATE INDEX idx_events_created ON events(created_at DESC);
```

### 4. Routing via Follow Graph

Kind 3 (Follow List) events with ILP address extensions:

```json
{
  "kind": 3,
  "tags": [
    ["p", "<pubkey>", "<relay hint>", "<petname>"],
    ["ilp", "<pubkey>", "g.agent.bob.wallet"]
  ],
  "content": ""
}
```

Routing table populated from follow relationships:

1. Agent parses Kind 3 events (from config or received events)
2. Extracts ILP addresses from `["ilp", pubkey, address]` tags
3. Populates routing table: followed agents = direct routes
4. Multi-hop routing through follow graph for indirect destinations

### 5. Payment Semantics

The `amount` field enables micropayments for agent services:

| Service       | Payment Model                   |
| ------------- | ------------------------------- |
| Store event   | Fixed fee per event             |
| Query events  | Base fee + per-result fee       |
| Execute work  | Dynamic pricing by complexity   |
| Forward event | Small fee per hop               |
| Free tier     | amount: 0 (gossip, public data) |

Payment flow:

1. Agent A sends ILP Prepare with `amount: N` and service request
2. Agent B validates payment is sufficient
3. Agent B executes service
4. Agent B returns ILP Fulfill (releases payment) with results
5. Balance tracked in TigerBeetle, settled via payment channels

### 6. Error Handling

Standard ILP rejection codes for agent errors:

| Scenario                 | ILP Error Code        |
| ------------------------ | --------------------- |
| Event kind not supported | F99_APPLICATION_ERROR |
| Insufficient payment     | F03_INVALID_AMOUNT    |
| Agent not found          | F02_UNREACHABLE       |
| Malformed event          | F01_INVALID_PACKET    |
| Temporary overload       | T03_CONNECTOR_BUSY    |
| Database error           | T00_INTERNAL_ERROR    |

## Implementation Scope

### In Scope (MVP)

1. **AgentEventDatabase** - libSQL storage for Nostr events
2. **AgentEventHandler** - Kind-based event dispatcher
3. **FollowGraphRouter** - Routing table from Kind 3 events
4. **ToonCodec** - TOON encode/decode wrapper
5. **Built-in handlers** - Kind 1 (notes), Kind 3 (follows), Kind 10000 (queries)
6. **Payment validation** - Reject underpaid requests
7. **AgentNode** - Main orchestrator extending ConnectorNode
8. **Configuration** - YAML config for agent settings
9. **Integration tests** - Multi-agent communication tests

### Out of Scope (Deferred)

- Dynamic follow list updates from network (use static config for MVP)
- Decentralized event kind registry
- Advanced query optimizations (full-text search, etc.)
- Agent reputation/trust scoring
- Multi-agent task coordination
- Custom LLM integration handlers

## Technical Dependencies

### New Dependencies

```json
{
  "dependencies": {
    "@toon-format/toon": "3.0.0",
    "nostr-tools": "2.10.0",
    "@libsql/client": "0.14.0"
  }
}
```

**Why libSQL over SQLite:**

- **MVCC concurrent writes** - Eliminates single-writer bottleneck (~4x throughput)
- **SQL compatible** - Same schema/queries as SQLite (drop-in replacement)
- **Encryption at rest** - Built-in for sensitive event content
- **Async API** - Non-blocking operations for Node.js

### Existing Dependencies (Reused)

- TigerBeetle - Balance tracking
- Settlement Coordinator - Multi-chain settlement
- BTP Client/Server - WebSocket transport
- Routing Table - Longest-prefix matching
- Telemetry Emitter - Monitoring

## Package Structure

```
packages/connector/src/agent/
├── index.ts                    # Public API
├── types.ts                    # Type definitions
├── event-database.ts           # libSQL storage
├── subscription-manager.ts     # Nostr REQ/EVENT subscriptions
├── event-handler.ts            # Kind dispatcher
├── follow-graph-router.ts      # Kind 3 routing
├── toon-codec.ts               # Serialization
├── handlers/
│   ├── note-handler.ts         # Kind 1
│   ├── follow-handler.ts       # Kind 3
│   ├── delete-handler.ts       # Kind 5
│   └── query-handler.ts        # Kind 10000
└── agent-node.ts               # Main orchestrator
```

## Success Criteria

- [ ] Agents send/receive TOON-serialized Nostr events via ILP packets
- [ ] Agent addresses (`g.agent.*`) route correctly through follow graph
- [ ] Events stored and queryable in local libSQL database
- [ ] Payment validation rejects underpaid requests (F03 error)
- [ ] Kind 3 events update routing tables correctly
- [ ] Settlement handles agent-to-agent micropayments
- [ ] Reference agent demonstrates full protocol
- [ ] Integration tests verify multi-agent communication
- [ ] TOON encoding/decoding has <1% error rate

## Stories

### Story 13.1: TOON Codec and Event Serialization

Implement TOON encoding/decoding wrapper for Nostr events in ILP packet data field.

**Acceptance Criteria:**

- ToonCodec encodes single Nostr event to Buffer
- ToonCodec decodes Buffer back to Nostr event (lossless)
- ToonCodec handles arrays of events efficiently
- Unit tests cover all Nostr event kinds
- Performance benchmark vs JSON serialization

### Story 13.2: Agent Event Database

Implement libSQL-based event storage with NIP-01 compatible querying.

**Acceptance Criteria:**

- AgentEventDatabase stores events with all fields
- Query by kind, pubkey, time range, tags
- Indexes enable efficient lookups
- Delete events by ID
- Database size limits configurable

### Story 13.3: Event Handler Dispatch System

Implement kind-based event dispatcher with payment validation.

**Acceptance Criteria:**

- AgentEventHandler routes events to registered handlers
- Payment validation before handler execution
- F03 rejection for insufficient payment
- Handler context includes packet metadata
- Extensible handler registration API

### Story 13.4: Follow Graph Router

Implement routing table population from Kind 3 follow list events.

**Acceptance Criteria:**

- Parse Kind 3 events for ILP address tags
- Update routing table with follow relationships
- Support static config for initial follows
- Export follow graph for debugging
- Handle follow list updates

### Story 13.5: Built-in Event Kind Handlers

Implement handlers for core event kinds (1, 3, 5, 10000) and subscription management.

**Acceptance Criteria:**

- Kind 1 (Note): Store locally, push to matching subscriptions
- Kind 3 (Follow): Update routing table
- Kind 5 (Delete): Remove event from database
- Kind 10000 (Query): Query database, return results
- Nostr REQ: Register subscription filter, push matching events over BTP
- Nostr CLOSE: Unregister subscription
- Configurable pricing per handler

### Story 13.6: Agent Node Orchestrator

Implement AgentNode extending ConnectorNode with event handling.

**Acceptance Criteria:**

- AgentNode initializes event database on startup
- Detects TOON events in incoming ILP packets
- Routes to AgentEventHandler
- Emits agent-specific telemetry events
- Graceful shutdown with database close

### Story 13.7: Agent Configuration Schema

Define YAML configuration for agent-specific settings.

**Acceptance Criteria:**

- Agent identity (private key or key file path)
- Database configuration (path, max size)
- Pricing configuration per service
- Static follow list with ILP addresses
- Handler enable/disable per kind

### Story 13.8: Integration Tests

End-to-end tests for multi-agent communication.

**Acceptance Criteria:**

- Agent A queries Agent B's database
- Payment flows correctly between agents
- Events propagate through follow graph
- Rejection codes returned for errors
- Settlement triggers after threshold

## Timeline Estimate

| Phase                   | Stories    | Effort        |
| ----------------------- | ---------- | ------------- |
| Serialization & Storage | 13.1, 13.2 | 40 hours      |
| Event Handling          | 13.3, 13.5 | 50 hours      |
| Routing & Node          | 13.4, 13.6 | 50 hours      |
| Config & Testing        | 13.7, 13.8 | 40 hours      |
| **Total**               |            | **180 hours** |

## References

- **ILP Specification:** https://interledger.org/rfcs/
- **Nostr Protocol:** https://github.com/nostr-protocol/nostr
- **NIP-01 (Events):** https://github.com/nostr-protocol/nips/blob/master/01.md
- **NIP-02 (Follow List):** https://github.com/nostr-protocol/nips/blob/master/02.md
- **TOON Format:** https://github.com/toon-format/toon
- **nostr-tools:** https://github.com/nbd-wtf/nostr-tools

---

**Epic Status:** Ready for Implementation

**Dependencies:** Epic 11 (AI Agent Wallet), Epic 12 (Multi-Chain Settlement)

**Architecture Reference:** [docs/architecture.md - Agent Society Protocol section](../architecture.md#agent-society-protocol-epic-13)
