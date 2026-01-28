# Epic 18: Agent Capability Discovery (NIP-XX1)

## Executive Summary

Epic 18 implements NIP-XX1 (Agent Capability Advertisement), enabling agents to advertise their capabilities, supported event kinds, pricing, and availability to the network. This builds on NIP-89 (Recommended Application Handlers) with agent-specific metadata fields, allowing agents to discover peers through the social graph and filter by required capabilities before task delegation.

This epic is **HIGH** priority as it enables the discovery mechanism required for all agent-to-agent interactions.

## Architecture

### Capability Advertisement Pattern

```
Agent Startup
     │
     ├─ Generate Kind 31990 Capability Event
     │   ├─ List supported event kinds (k tags)
     │   ├─ Pricing per kind (pricing tags)
     │   ├─ Agent type and metadata
     │   └─ ILP address for payments
     │
     ├─ Sign with Agent's Nostr Key
     │
     └─ Store Locally + Broadcast to Relays
```

### Discovery Flow

```
Agent A (wants translation service)
     │
     ├─ Query follow graph (Kind 3)
     │
     ├─ For each followed agent:
     │   └─ Query Kind 31990 with k=5100 filter
     │
     ├─ Filter by:
     │   ├─ Supported capability (k tag)
     │   ├─ Acceptable pricing
     │   └─ Available capacity
     │
     └─ Select best agent → Delegate task
```

### Event Structure (Kind 31990)

```json
{
  "kind": 31990,
  "pubkey": "<agent-pubkey>",
  "created_at": 1234567890,
  "tags": [
    ["d", "<agent-ilp-address>"],
    ["k", "5000"],
    ["k", "5100"],
    ["nip", "89"],
    ["nip", "90"],
    ["nip", "xx1"],
    ["agent-type", "dvm"],
    ["ilp-address", "g.agent.alice"],
    ["pricing", "5000", "100", "msat"],
    ["pricing", "5100", "5000", "msat"],
    ["capacity", "10", "100"],
    ["model", "claude-3-haiku"],
    ["skills", "query", "translate"]
  ],
  "content": "{\"name\":\"Alice Agent\",\"about\":\"...\"}",
  "sig": "<signature>"
}
```

## Package Structure

```
packages/connector/src/agent/
├── discovery/
│   ├── index.ts
│   ├── capability-publisher.ts      # Publish Kind 31990 events
│   ├── capability-query.ts          # Query peer capabilities
│   ├── capability-cache.ts          # Cache discovered capabilities
│   └── types.ts                     # Capability types
├── ai/skills/
│   ├── get-agent-info-skill.ts      # Enhanced with capability data
│   └── discover-agents-skill.ts     # New: Find capable agents
└── __tests__/
    └── discovery/
        ├── capability-publisher.test.ts
        ├── capability-query.test.ts
        └── discovery-integration.test.ts
```

## Configuration

```yaml
agent:
  discovery:
    enabled: true
    publishOnStartup: true
    refreshInterval: 3600 # Re-publish every hour
    cacheExpiry: 86400 # Cache peer capabilities for 24h
  capability:
    agentType: 'dvm' # dvm | assistant | specialist | coordinator | relay
    model: 'anthropic:claude-haiku-4-5'
    capacity:
      maxConcurrent: 10
      queueDepth: 100
```

## Stories

| Story | Description                                | Status      |
| ----- | ------------------------------------------ | ----------- |
| 18.1  | Capability Event Types & Schema            | Done        |
| 18.2  | Capability Publisher (Kind 31990)          | Done        |
| 18.3  | Pricing Tag Generation from Skill Registry | Not Started |
| 18.4  | Capability Query & Filter                  | Not Started |
| 18.5  | Social Graph Capability Discovery          | Not Started |
| 18.6  | Enhanced get_agent_info Skill              | Not Started |
| 18.7  | Capability Caching & Refresh               | Not Started |
| 18.8  | Integration with Follow Graph Router       | Not Started |

---

## Story 18.1: Capability Event Types & Schema

### Description

Define TypeScript types and Zod schemas for NIP-XX1 capability events.

### Acceptance Criteria

1. `AgentCapability` type with all required fields
2. `AgentType` enum: dvm, assistant, specialist, coordinator, relay
3. `PricingEntry` type for pricing tags
4. `CapacityInfo` type for capacity tags
5. Zod schema for validation
6. Content JSON schema for metadata
7. Constants for tag names

### Technical Notes

```typescript
type AgentType = 'dvm' | 'assistant' | 'specialist' | 'coordinator' | 'relay';

interface AgentCapability {
  pubkey: string;
  identifier: string; // d tag (ILP address)
  supportedKinds: number[]; // k tags
  supportedNips: string[]; // nip tags
  agentType: AgentType;
  ilpAddress: string;
  pricing: Map<number, PricingEntry>;
  capacity?: CapacityInfo;
  model?: string;
  skills?: string[];
  metadata: AgentMetadata;
  createdAt: number;
}

interface PricingEntry {
  kind: number;
  amount: bigint;
  currency: 'msat' | 'sat' | 'usd';
}

interface CapacityInfo {
  maxConcurrent: number;
  queueDepth: number;
}

interface AgentMetadata {
  name: string;
  about?: string;
  picture?: string;
  website?: string;
  nip05?: string;
  lud16?: string;
  capabilities?: {
    languages?: string[];
    domains?: string[];
    maxContextTokens?: number;
  };
}
```

---

## Story 18.2: Capability Publisher (Kind 31990)

### Description

Implement publishing of capability advertisement events to the network.

### Acceptance Criteria

1. Publisher generates Kind 31990 from skill registry
2. Event includes all required tags (d, k, nip, agent-type, ilp-address)
3. Event includes pricing tags from configured pricing
4. Event includes capacity tags from agent config
5. Content JSON includes agent metadata
6. Event signed with agent's Nostr key
7. Event stored in local database
8. Event broadcast to configured relays
9. Publisher supports manual trigger and auto-refresh

### Technical Notes

```typescript
class CapabilityPublisher {
  async publish(): Promise<NostrEvent> {
    const skills = this.skillRegistry.getRegisteredSkills();
    const kinds = [...new Set(skills.flatMap((s) => s.eventKinds ?? []))];

    const tags = [
      ['d', this.config.ilpAddress],
      ...kinds.map((k) => ['k', k.toString()]),
      ['nip', '89'],
      ['nip', '90'],
      ['nip', 'xx1'],
      ['agent-type', this.config.agentType],
      ['ilp-address', this.config.ilpAddress],
      ...this.buildPricingTags(),
      ...this.buildCapacityTags(),
    ];

    const event = this.createSignedEvent(31990, tags, this.buildMetadata());
    await this.store.saveEvent(event);
    await this.broadcast(event);
    return event;
  }
}
```

---

## Story 18.3: Pricing Tag Generation from Skill Registry

### Description

Generate pricing tags dynamically from skill registry configuration.

### Acceptance Criteria

1. Each skill can declare its base price
2. Pricing tags generated for all priced skills
3. Support for multiple pricing models (flat, per-token, per-input-size)
4. Override pricing via agent config
5. Pricing exposed via get_agent_info skill
6. Validation that all DVM kinds have pricing

### Technical Notes

```typescript
interface AgentSkill<T> {
  name: string;
  eventKinds?: number[];
  pricing?: {
    base: bigint;
    model: 'flat' | 'per-token' | 'per-byte';
    perUnit?: bigint;
  };
  // ...
}

function buildPricingTags(registry: SkillRegistry): string[][] {
  const tags: string[][] = [];
  for (const skill of registry.getRegisteredSkills()) {
    if (skill.pricing && skill.eventKinds) {
      for (const kind of skill.eventKinds) {
        tags.push(['pricing', kind.toString(), skill.pricing.base.toString(), 'msat']);
      }
    }
  }
  return tags;
}
```

---

## Story 18.4: Capability Query & Filter

### Description

Implement querying and filtering of peer capability events.

### Acceptance Criteria

1. Query Kind 31990 events from local storage
2. Query Kind 31990 events from relays
3. Filter by supported kind (k tag)
4. Filter by agent type
5. Filter by price range
6. Filter by ILP address prefix
7. Sort by pricing, capacity, freshness
8. Return parsed `AgentCapability` objects

### Technical Notes

```typescript
interface CapabilityQuery {
  requiredKinds?: number[];
  agentTypes?: AgentType[];
  maxPrice?: bigint;
  ilpAddressPrefix?: string;
  followedOnly?: boolean;
  limit?: number;
}

class CapabilityQueryService {
  async findAgents(query: CapabilityQuery): Promise<AgentCapability[]> {
    const filter: NostrFilter = {
      kinds: [31990],
      '#k': query.requiredKinds?.map((k) => k.toString()),
    };

    const events = await this.store.queryEvents(filter);
    return events
      .map((e) => this.parseCapability(e))
      .filter((c) => this.matchesQuery(c, query))
      .sort(this.rankCapabilities);
  }
}
```

---

## Story 18.5: Social Graph Capability Discovery

### Description

Discover capable agents through the follow graph.

### Acceptance Criteria

1. Start from agent's follow list (Kind 3)
2. Query capabilities for followed agents
3. Optionally extend to 2-hop (follows of follows)
4. Rank by social distance (direct follow > 2-hop)
5. Cache discovered capabilities
6. Integration with FollowGraphRouter

### Technical Notes

```typescript
class SocialCapabilityDiscovery {
  async discoverForKind(kind: number): Promise<AgentCapability[]> {
    const directFollows = await this.followGraph.getFollowedPubkeys();
    const directCaps = await this.queryCapabilities(directFollows, kind);

    // Optionally discover 2-hop
    if (this.config.discovery.extendedHops) {
      const secondHop = await this.getSecondHopPubkeys(directFollows);
      const secondCaps = await this.queryCapabilities(secondHop, kind);
      return [...directCaps, ...this.weightByDistance(secondCaps, 2)];
    }

    return directCaps;
  }
}
```

---

## Story 18.6: Enhanced get_agent_info Skill

### Description

Enhance the existing get_agent_info skill with capability data.

### Acceptance Criteria

1. Include supported event kinds in response
2. Include pricing information
3. Include capacity information
4. Include agent type and model
5. Include skills list
6. Response format backward compatible
7. New fields documented

### Technical Notes

```typescript
const getAgentInfoSkill: AgentSkill<typeof schema> = {
  name: 'get_agent_info',
  description: 'Get information about this agent including capabilities and pricing',
  eventKinds: [], // Meta skill, no specific kind
  execute: async (params, context) => {
    const capability = await context.capabilityPublisher.getLocal();
    return {
      ilpAddress: context.ilpAddress,
      pubkey: context.pubkey,
      name: capability.metadata.name,
      about: capability.metadata.about,
      supportedKinds: capability.supportedKinds,
      pricing: Object.fromEntries(capability.pricing),
      capacity: capability.capacity,
      agentType: capability.agentType,
      skills: capability.skills,
    };
  },
};
```

---

## Story 18.7: Capability Caching & Refresh

### Description

Implement caching of discovered capabilities with automatic refresh.

### Acceptance Criteria

1. Cache capabilities in memory with TTL
2. Persist cache to database for restart recovery
3. Auto-refresh stale entries (configurable interval)
4. Manual cache invalidation API
5. Cache size limits with LRU eviction
6. Metrics: cache hits, misses, refresh count

### Technical Notes

```typescript
class CapabilityCache {
  private cache: Map<string, CacheEntry<AgentCapability>>;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  async get(pubkey: string): Promise<AgentCapability | undefined> {
    const entry = this.cache.get(pubkey);
    if (entry && !this.isExpired(entry)) {
      return entry.value;
    }
    return undefined;
  }

  async refresh(pubkey: string): Promise<AgentCapability> {
    const cap = await this.queryService.fetchCapability(pubkey);
    this.cache.set(pubkey, { value: cap, timestamp: Date.now() });
    return cap;
  }
}
```

---

## Story 18.8: Integration with Follow Graph Router

### Description

Integrate capability discovery with packet routing decisions.

### Acceptance Criteria

1. Router considers capabilities when selecting next hop
2. Prefer peers with required capabilities for task delegation
3. Factor pricing into routing decisions
4. Skip peers with exhausted capacity
5. Logging of routing decisions with capability context
6. Graceful degradation when capabilities unknown

### Technical Notes

```typescript
class CapabilityAwareRouter extends FollowGraphRouter {
  async routePacket(packet: IlpPreparePacket, event?: NostrEvent): Promise<string | undefined> {
    if (event && this.isTaskDelegation(event)) {
      const requiredKind = this.extractTargetKind(event);
      const capable = await this.discovery.discoverForKind(requiredKind);
      const sorted = this.rankByPriceAndDistance(capable);
      return sorted[0]?.ilpAddress;
    }
    return super.routePacket(packet);
  }
}
```

---

## Dependencies

- **Epic 13** (Agent Society Protocol) — Nostr events, follow graph
- **Epic 16** (AI Agent Node) — Skill registry
- **Epic 17** (NIP-90 DVM) — DVM kinds and patterns
- **NIP-89 Specification** — https://nips.nostr.com/89

## Risk Mitigation

| Risk                        | Mitigation                                           |
| --------------------------- | ---------------------------------------------------- |
| Stale capability data       | Auto-refresh with configurable TTL                   |
| Dishonest capability claims | Verify via test request; reputation system (Epic 21) |
| Discovery spam              | Rate limit queries; social graph filtering           |
| Missing capabilities        | Graceful fallback to direct routing                  |

## Success Metrics

- Agents successfully advertise capabilities on startup
- Capability queries return relevant results within 100ms (cached)
- Social graph discovery finds 90%+ of capable agents in test network
- Zero impact on routing performance for non-delegated packets
