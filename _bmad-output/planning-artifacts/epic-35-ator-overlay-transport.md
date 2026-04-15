# Epic 35: ATOR Overlay Transport for Privacy-Enabled Peering

**Date:** 2026-04-13
**Author:** Jonathan (with BMAD multi-agent roundtable)
**Status:** Draft
**Dependencies:** None (transport layer is orthogonal to settlement providers)
**Type:** Brownfield — extends existing connector with optional privacy transport

---

## Executive Summary

Add an optional SOCKS5-based transport layer that enables TOON connectors to peer through ATOR (Anyone Protocol) `.anon` hidden services. This eliminates the requirement for public IPs, port forwarding, and domain names — allowing connector operation from home networks behind NAT on commodity hardware like Raspberry Pis.

### Why ATOR

- **Democratizes connector operation:** No public IP, no port forwarding, no domain name, no cloud VPS needed
- **Privacy-enabled peering:** Peers never see each other's real IP addresses; peering graph is hidden from network observers
- **Minimal integration cost:** ~50 lines of core transport code + 2 npm dependencies; zero protocol changes to ILP or BTP
- **Opt-in, zero behavioral change:** Default transport remains direct TCP; existing deployments are unaffected

### What ATOR Is

ATOR (Anyone Protocol) is a fork of Tor 0.4.9.x with token-incentivized relay operators. Protocol-level changes from upstream Tor are zero — same onion routing, same cryptography, same circuit construction. The `@anyone-protocol/anyone-client` npm SDK manages the `anon` binary lifecycle and exposes a SOCKS5 proxy for tunneling traffic through the Anyone relay network.

### Integration Model (Validated)

Five integration hypotheses were explored in the [handoff document](./_bmad-output/planning-artifacts/ator-protocol-integration-handoff.md). Only one survived validation:

**Overlay Transport** — TOON connectors peer through ATOR circuits using SOCKS5 proxy. Relay operators are unaware ILP traffic flows through their relays. Two separate economic loops (ANYONE tokens for relay capacity, ILP fees for payment routing). Privacy boundary (encrypted cells) is load-bearing and must not be violated.

The other four models (relay-connector merge, ILP fee replacement, circuit provider DVM, relay intelligence DVM) were invalidated with documented reasoning — see handoff document for details.

---

## Architecture

### OSI Layering

ATOR is a transport concern below BTP and ILP. The connector does not need to know it is running over onion circuits.

```
┌─────────────────────────────────────────────────────────┐
│  APPLICATION    TOON Connector (BTP/WS, ILP routing)    │
├─────────────────────────────────────────────────────────┤
│  TRANSPORT      TransportProvider abstraction            │
│                 ├─ DirectTransportProvider (default)     │
│                 └─ SocksTransportProvider (ATOR/Tor)     │
├─────────────────────────────────────────────────────────┤
│  CIRCUIT        ATOR Onion Routing (when SOCKS enabled) │
│                 514-byte fixed-size encrypted cells      │
├─────────────────────────────────────────────────────────┤
│  LINK           TLS connections between relays          │
└─────────────────────────────────────────────────────────┘
```

### TransportProvider Interface

```typescript
interface TransportProvider {
  createAgent(peerUrl: string): http.Agent;
  getExternalUrl(): string;
  start(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<boolean>;
}
```

Two implementations:
- **`DirectTransportProvider`** — wraps current direct connection behavior (default, extracted refactor)
- **`SocksTransportProvider`** — routes outbound connections through SOCKS5 proxy, serves inbound via `.anon` hidden service

### Per-Node Process Architecture

```
┌──────────────────────────────────────────────┐
│  Raspberry Pi / Home Server / VPS            │
│                                              │
│  ┌──────────────────────┐                    │
│  │  anon (ATOR client)  │  ← via npm SDK     │
│  │  - SOCKS5 :9050      │  ← outbound proxy  │
│  │  - .anon hidden svc  │  ← inbound peering │
│  └──────────┬───────────┘                    │
│             │ localhost only                  │
│  ┌──────────┴───────────┐                    │
│  │  TOON Connector      │                    │
│  │  - BTP/WS listener   │  ← behind .anon    │
│  │  - BTP/WS clients    │  ← via SOCKS5      │
│  │  - ILP router        │                    │
│  │  - Settlement engine  │                    │
│  └──────────────────────┘                    │
└──────────────────────────────────────────────┘
```

### Three-Layer Privacy Stack (with NIP-59)

When NIP-59 gift wrapping from Epic 34 is enabled alongside ATOR transport, three nested encryption layers apply:

| Layer | What It Hides | From Whom |
|-------|---------------|-----------|
| **ATOR circuit** | All traffic — 514-byte fixed cells, content-blind | Relays, network observers, ISPs |
| **ILP routing** | Only connector endpoints see destination, amount, expiry | Hidden from relays (encrypted in cells) |
| **NIP-59 gift wrap** | Settlement claims: sender identity, blockchain type, amounts, timing | Hidden from intermediary connectors |

---

## Integration Points

| Component | Interaction |
|-----------|-------------|
| `packages/connector/src/transport/` | New directory: `TransportProvider` interface + implementations |
| `packages/connector/src/config/` | Zod schema extension: optional `transport` block in YAML config |
| `packages/connector/src/core/connector-node.ts` | Wire `TransportProvider` lifecycle (start/stop) into connector startup/shutdown |
| `packages/connector/src/btp/` | BTP WebSocket client passes `http.Agent` from transport provider |
| `@anyone-protocol/anyone-client` | New npm dependency: manages `anon` binary lifecycle |
| `socks-proxy-agent` | New npm dependency: SOCKS5 HTTP agent for Node.js `ws` library |

---

## Critical Implementation Rules

| Rule | Why |
|------|-----|
| Use `socks5h://` scheme (with `h`) | DNS must resolve through the proxy, not locally — prevents DNS leaks that expose `.anon` addresses |
| Never log `.anon` addresses at INFO level | Hidden service addresses are sensitive — DEBUG only |
| Fail closed, never fail open | If SOCKS proxy is unavailable, reject connections — never silently fall back to direct |
| Transport is opt-in, default is direct | Zero behavioral change for existing deployments |
| Never silently fall back to direct | Silent fallback is an opsec violation — hard error if proxy is down |
| Health check the SOCKS proxy | Detect proxy failure proactively; report via health endpoint |

---

## Performance Characteristics

| Metric | Without ATOR | With ATOR |
|--------|-------------|-----------|
| BTP connection latency | ~50ms (direct TCP) | ~600ms (6-hop rendezvous circuit) |
| ILP packet round-trip (per hop) | ~100ms | ~400-700ms |
| 3-hop ILP payment round-trip | ~300ms | ~1.2-2.1s |
| ILP STREAM throughput | Limited by TCP | Limited by circuit bandwidth (~1-5 MB/s) |
| Connection establishment | Instant (TCP handshake) | ~2-5s (circuit build + hidden service rendezvous) |

**Assessment:** Latency is acceptable for ILP STREAM micropayments (pipelined, throughput matters more than individual packet latency). Not suitable for latency-critical real-time settlement.

---

## Risk Assessment

| ID | Risk | Likelihood | Impact | Severity | Mitigation |
|----|------|-----------|--------|----------|------------|
| R-001 | **`anyone-client` SDK maturity** — v1.1.3, maintenance cadence unknown | Medium | High | 7 | Audit SDK before committing; abstract behind `TransportProvider` so swapping to raw `tor` is trivial |
| R-002 | **SOCKS proxy failure mid-session** — connections drop silently | Medium | Medium | 6 | Health check loop; connection error propagation; explicit logging on proxy failure |
| R-003 | **DNS leak via `socks5://` instead of `socks5h://`** | Low | High | 5 | Validate URI scheme at config load time; reject `socks5://` in config validation |
| R-004 | **Latency exceeds timeout for ILP PREPARE** | Medium | Medium | 6 | Document latency characteristics; recommend adjusted ILP timeouts for ATOR peers |
| R-005 | **`anon` binary not available on all platforms** | Low | Medium | 4 | SDK manages binary; fallback to system `tor` with config flag; document supported platforms |
| R-006 | **Hidden service address rotation** — if keypair changes, peers lose connectivity | Low | Medium | 4 | Document key persistence requirements; config for static hidden service keys |

---

## Config Schema Extension

```yaml
# connector.yaml — new optional block
transport:
  type: "socks5"                         # or "direct" (default, current behavior)
  socksProxy: "socks5h://127.0.0.1:9050" # SOCKS5 proxy URL (socks5h required)
  externalUrl: "ws://abc123.anon/btp"    # .anon hidden service address for inbound peering
  managed: true                          # optional: start/stop anon binary via anyone-client SDK
```

Zod validation rules:
- `transport.type` defaults to `"direct"` if block is absent
- `transport.socksProxy` must start with `socks5h://` — reject `socks5://` with descriptive error
- `transport.externalUrl` required when `type: "socks5"`
- `transport.managed` defaults to `false`

---

## Stories

---

### Story 35.1: Define TransportProvider Interface + DirectTransportProvider

**Priority:** P0
**Estimate:** 3 points
**Dependencies:** None

#### Description

Define the `TransportProvider` interface and implement `DirectTransportProvider` that wraps the current direct connection behavior. This is a pure refactor — extract the existing WebSocket connection logic behind the new interface with zero behavioral change. All existing tests must continue to pass.

#### Files

- `packages/connector/src/transport/transport-provider.ts` — interface definition
- `packages/connector/src/transport/direct-transport-provider.ts` — default implementation
- `packages/connector/src/transport/index.ts` — barrel exports

#### TransportProvider Interface

```typescript
interface TransportProvider {
  createAgent(peerUrl: string): http.Agent | undefined;
  getExternalUrl(): string;
  start(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<boolean>;
}
```

`DirectTransportProvider.createAgent()` returns `undefined` (use default Node.js agent). `getExternalUrl()` returns the configured public URL. `healthCheck()` always returns `true`.

#### Acceptance Criteria

```gherkin
Given the connector starts with no transport config (or type: "direct")
When the TransportProvider is initialized
Then a DirectTransportProvider is created with identical behavior to current code

Given DirectTransportProvider.createAgent() is called
When any peer URL is passed
Then undefined is returned (use default Node.js HTTP agent)

Given DirectTransportProvider.healthCheck() is called
Then it returns true

Given the refactored connector with DirectTransportProvider
When the existing test suite is run
Then all tests pass with zero behavioral change
```

---

### Story 35.2: Implement SocksTransportProvider

**Priority:** P0
**Estimate:** 3 points
**Dependencies:** Story 35.1

#### Description

Implement `SocksTransportProvider` that creates `socks-proxy-agent` instances for outbound WebSocket connections. This provider routes all outbound BTP connections through a SOCKS5 proxy. It implements fail-closed behavior — if the proxy is unreachable, connections are rejected with an explicit error, never silently falling back to direct.

#### Files

- `packages/connector/src/transport/socks-transport-provider.ts` — SOCKS5 implementation
- `packages/connector/src/transport/socks-transport-provider.test.ts` — unit tests

#### Key Behaviors

- `createAgent(peerUrl)` returns a `SocksProxyAgent` configured with the proxy URL
- `getExternalUrl()` returns the configured `.anon` hidden service URL
- `healthCheck()` attempts a connection through the SOCKS proxy; returns `false` if unreachable
- `start()` validates proxy connectivity; throws if proxy unreachable at startup
- `stop()` is a no-op (proxy lifecycle managed externally unless `managed: true`)

#### Acceptance Criteria

```gherkin
Given a SocksTransportProvider configured with "socks5h://127.0.0.1:9050"
When createAgent is called with any peer URL
Then a SocksProxyAgent is returned configured with the SOCKS5 proxy

Given a SocksTransportProvider
When the SOCKS5 proxy at the configured address is unreachable
And start() is called
Then an error is thrown indicating proxy connectivity failure

Given a SocksTransportProvider
When the SOCKS5 proxy goes down after successful start
And healthCheck() is called
Then it returns false

Given a SocksTransportProvider
When createAgent is called and the proxy is down
Then the agent is still created (connection failure happens at socket level, not agent creation)

Given the proxy URL is configured as "socks5://" (without h)
When config validation runs
Then a descriptive error is thrown requiring "socks5h://" scheme
```

---

### Story 35.3: Extend Config Schema for Transport Block

**Priority:** P0
**Estimate:** 2 points
**Dependencies:** Story 35.1

#### Description

Add the optional `transport` block to the connector's Zod-validated YAML config schema. Defaults to `type: "direct"` when absent. Validates `socks5h://` scheme requirement, requires `externalUrl` when type is `socks5`.

#### Files

- `packages/connector/src/config/` — config schema files (modify existing Zod schemas)

#### Config Structure

```yaml
transport:
  type: "socks5"                         # "direct" | "socks5", defaults to "direct"
  socksProxy: "socks5h://127.0.0.1:9050" # required when type: "socks5"
  externalUrl: "ws://abc123.anon/btp"    # required when type: "socks5"
  managed: false                         # optional, default false
```

#### Acceptance Criteria

```gherkin
Given a connector YAML config with no transport block
When config is loaded and validated
Then transport defaults to { type: "direct" } with no errors

Given a connector YAML config with transport.type: "socks5"
When socksProxy and externalUrl are provided with valid values
Then config validation passes

Given a connector YAML config with transport.type: "socks5"
When socksProxy is missing
Then Zod validation fails with a descriptive error

Given a connector YAML config with socksProxy: "socks5://127.0.0.1:9050"
When config validation runs
Then validation fails with error message requiring "socks5h://" scheme

Given a connector YAML config with transport.type: "socks5"
When externalUrl is missing
Then Zod validation fails requiring externalUrl for SOCKS5 transport
```

---

### Story 35.4: Wire TransportProvider into ConnectorNode and BTP Client

**Priority:** P0
**Estimate:** 3 points
**Dependencies:** Stories 35.1, 35.2, 35.3

#### Description

Integrate the `TransportProvider` into `ConnectorNode` lifecycle and the BTP WebSocket client. The connector instantiates the appropriate provider based on config, calls `start()`/`stop()` during lifecycle, and passes the provider's `createAgent()` result to `ws` WebSocket connections.

#### Files

- `packages/connector/src/core/connector-node.ts` — add transport provider lifecycle
- `packages/connector/src/btp/` — BTP client WebSocket connection (pass `agent` option)

#### Key Behaviors

- `ConnectorNode` creates `DirectTransportProvider` or `SocksTransportProvider` based on config
- Provider `start()` called during connector startup (after config validation, before BTP connections)
- Provider `stop()` called during connector shutdown
- BTP WebSocket client uses `provider.createAgent(peerUrl)` when establishing outbound connections
- Health endpoint reports transport provider health status

#### Acceptance Criteria

```gherkin
Given a connector configured with transport.type: "direct"
When the connector starts
Then a DirectTransportProvider is initialized and BTP connections use default agents

Given a connector configured with transport.type: "socks5"
When the connector starts
Then a SocksTransportProvider is initialized with the configured proxy URL
And all outbound BTP WebSocket connections use the SOCKS proxy agent

Given a running connector with SocksTransportProvider
When the connector shuts down
Then the transport provider's stop() is called cleanly

Given a running connector with SocksTransportProvider
When the health endpoint is queried
Then the response includes transport provider health status

Given a connector configured with transport.type: "socks5"
When the SOCKS proxy is unreachable at startup
Then the connector fails to start with a clear error message
```

---

### Story 35.5: Managed ATOR Client Lifecycle (Optional)

**Priority:** P1
**Estimate:** 3 points
**Dependencies:** Story 35.2

#### Description

When `transport.managed: true`, the connector manages the `anon` binary lifecycle via `@anyone-protocol/anyone-client` SDK. The SDK starts the binary on connector startup and stops it on shutdown. Hidden service configuration is handled by the SDK. This story is optional — operators can run `anon` externally and point the connector at the SOCKS5 port.

#### Files

- `packages/connector/src/transport/managed-anon-client.ts` — SDK wrapper
- `packages/connector/src/transport/managed-anon-client.test.ts` — unit tests

#### Key Behaviors

- Start `anon` binary via `@anyone-protocol/anyone-client` SDK
- Wait for SOCKS5 proxy to become available before resolving `start()`
- Configure hidden service for inbound BTP peering
- Stop binary cleanly on `stop()`
- Crash recovery: detect stale process, clean up, restart

#### Acceptance Criteria

```gherkin
Given transport.managed: true in config
When the connector starts
Then the anon binary is started via the anyone-client SDK
And the connector waits for the SOCKS5 proxy to become available

Given a managed anon client is running
When the connector shuts down
Then the anon binary is stopped cleanly

Given a managed anon client
When the anon binary crashes unexpectedly
And healthCheck() is called
Then false is returned and the error is logged

Given transport.managed: false (or absent)
When the connector starts with type: "socks5"
Then no anon binary management occurs — operator manages it externally
```

---

### Story 35.6: Unit and Integration Tests

**Priority:** P0
**Estimate:** 3 points
**Dependencies:** Stories 35.1–35.4

#### Description

Comprehensive test suite covering the transport provider abstraction, SOCKS5 proxy behavior, config validation, and connector integration. Unit tests use mocked SOCKS5 proxies. Integration tests verify end-to-end BTP WebSocket connections through a local SOCKS5 proxy.

#### Test Scenarios

| Scenario | Type | Priority | Description |
|----------|------|----------|-------------|
| DirectTransportProvider behavior | Unit | P0 | createAgent returns undefined, healthCheck returns true, start/stop are no-ops |
| SocksTransportProvider agent creation | Unit | P0 | createAgent returns SocksProxyAgent with correct proxy config |
| Fail-closed behavior | Unit | P0 | Proxy unavailable at start → error thrown; no silent fallback |
| DNS leak prevention | Unit | P0 | Config rejects `socks5://`, requires `socks5h://` |
| Config validation — happy path | Unit | P0 | Valid transport config passes Zod validation |
| Config validation — missing fields | Unit | P0 | Missing socksProxy/externalUrl when type: "socks5" → validation error |
| Config validation — absent block | Unit | P0 | No transport block → defaults to direct |
| Health check — proxy down | Unit | P0 | healthCheck returns false when proxy unreachable |
| BTP WebSocket through SOCKS5 | Integration | P0 | Two connectors peer through local SOCKS5 proxy, exchange ILP packets |
| `.anon` address not logged at INFO | Unit | P1 | Verify no INFO-level log contains `.anon` addresses |
| ConnectorNode lifecycle | Integration | P0 | Transport provider starts/stops with connector |

#### Acceptance Criteria

```gherkin
Given the full test suite
When npm test is run
Then all transport-related tests pass

Given a local SOCKS5 proxy server (mocked)
When two connectors are configured to peer through it
Then BTP WebSocket connections are established through the proxy
And ILP PREPARE/FULFILL packets are exchanged successfully

Given a SocksTransportProvider with an unreachable proxy
When the connector attempts to start
Then startup fails with a descriptive error — no silent fallback to direct

Given a valid transport config with socks5h:// scheme
When Zod validation runs
Then the config is accepted without errors

Given any log output at INFO level during SOCKS transport operation
When the output is inspected
Then no .anon addresses appear (only at DEBUG level)
```

---

### Story 35.7: Documentation — Deployment Guide and Config Reference

**Priority:** P1
**Estimate:** 2 points
**Dependencies:** Stories 35.1–35.6

#### Description

Document the ATOR transport integration including: installation of `anon` binary, connector configuration for SOCKS5 transport, peer discovery via static config, performance characteristics, privacy model explanation, and operational considerations.

#### Deliverables

1. **Deployment guide:** `docs/ator-transport.md` — setup instructions for ATOR overlay transport
2. **Config reference:** Updated config documentation with transport block schema
3. **Privacy model:** Explanation of three-layer privacy stack (ATOR + ILP + NIP-59)
4. **Performance guide:** Latency expectations, timeout recommendations for ATOR-connected peers
5. **Troubleshooting:** Common failure modes, DNS leak detection, proxy health checks

#### Acceptance Criteria

```gherkin
Given the deployment guide
When a developer reads the ATOR transport setup instructions
Then they can configure a connector with SOCKS5 transport by following the guide

Given the privacy model documentation
When reviewed by a developer unfamiliar with onion routing
Then the privacy guarantees and limitations are clearly explained

Given the performance guide
When an operator is configuring ILP timeouts for ATOR peers
Then recommended timeout values are documented with rationale

Given the troubleshooting section
When an operator encounters a DNS leak or proxy failure
Then diagnostic steps are documented
```

---

## Peer Discovery (This Epic)

**Static config only.** Operators exchange `.anon` addresses out of band and add to connector YAML:

```yaml
peers:
  - id: "alice"
    url: "ws://abc123def456.anon/btp"
    chain: "evm:8453"
    # ... other peer config
```

**Future work (not this epic):**
- Nostr kind:10035 advertisements with `.anon` addresses (uses existing NIP-59 identity keys)
- ILP CCP route broadcasts over BTP channels inside ATOR circuits

---

## Compatibility Requirements

| Requirement | Detail |
|-------------|--------|
| **No protocol changes** | Zero changes to ILP, BTP, or ATOR protocols |
| **Existing deployments unchanged** | Default transport is `direct`; no behavioral change unless explicitly configured |
| **Multi-chain coexistence** | Transport layer is orthogonal to settlement; works with EVM, Solana, and Mina providers |
| **Node.js version** | `socks-proxy-agent` and `@anyone-protocol/anyone-client` are compatible with Node.js >= 22 |
| **`ws` library compatibility** | `ws` natively supports custom `agent` option for WebSocket connections |
| **Test infrastructure** | Unit tests use mocked SOCKS5; integration tests use local SOCKS5 proxy (no Docker dependency) |

---

## Definition of Done

- [ ] `TransportProvider` interface defined with `DirectTransportProvider` and `SocksTransportProvider` implementations
- [ ] Config schema extended with optional `transport` block, Zod-validated
- [ ] `ConnectorNode` lifecycle integrates transport provider start/stop
- [ ] BTP WebSocket client passes transport provider's agent for outbound connections
- [ ] Fail-closed behavior: SOCKS proxy unavailable → hard error, never silent fallback
- [ ] DNS leak prevention: `socks5h://` required, `socks5://` rejected at config validation
- [ ] `.anon` addresses never logged at INFO level
- [ ] Health endpoint reports transport provider status
- [ ] Unit tests cover all transport provider behavior
- [ ] Integration test verifies BTP peering through SOCKS5 proxy
- [ ] Documentation covers setup, config, privacy model, and troubleshooting
- [ ] Code passes ESLint, Prettier, and TypeScript strict checks
- [ ] Test coverage meets project thresholds (branches 60%, functions 75%, lines 70%, statements 70%)
- [ ] Existing test suite passes without modification (zero regression)

---

## Estimated Total Effort

| Story | Points | Description |
|-------|--------|-------------|
| 35.1 | 3 | TransportProvider interface + DirectTransportProvider |
| 35.2 | 3 | SocksTransportProvider implementation |
| 35.3 | 2 | Config schema extension |
| 35.4 | 3 | Wire into ConnectorNode + BTP client |
| 35.5 | 3 | Managed ATOR client lifecycle (optional) |
| 35.6 | 3 | Unit and integration tests |
| 35.7 | 2 | Documentation |
| **Total** | **19** |

---

## Security Analysis

### What the Integration Protects Against

- Network-level observer correlating connector identity with ILP activity
- Peer connectors learning each other's physical IP addresses
- ISP/government surveillance of connector-to-connector payment traffic
- Infrastructure topology mapping by competitors

### What It Does NOT Protect Against

- **Timing correlation by global passive adversary** — standard onion routing limitation
- **ILP address leaking destination identity** — hierarchical addressing is inherently informative
- **Compromised entry + exit** — same as Tor's guard/exit correlation attack
- **Application-level leaks** — misconfigured logging, DNS leaks (mitigated by `socks5h://`)

### Cross-Layer Attack Surface

| Attack | What adversary learns | Severity |
|--------|----------------------|----------|
| Compromised relay only | 514-byte cells between adjacent nodes. Nothing else. | Low |
| Compromised connector only | ILP destination, amount, expiry. Not sender identity or settlement details (NIP-59). | Medium |
| Compromised entry relay + ILP destination | Full sender-to-receiver linkage via timing correlation. | High |
| Full stack (entry + connector + receiver key) | Total deanonymization. Requires all three layers compromised. | Critical (but expensive) |

---

## Open Questions

1. **ATOR vs mainline Tor:** The `TransportProvider` abstraction supports both (SOCKS5 is SOCKS5). Should we test/document both, or partner specifically with ATOR?

2. **Latency budget:** Is 1.2-2.1s round-trip for a 3-hop ILP payment acceptable for all target use cases? Which use cases need direct (non-ATOR) peering?

3. **`anyone-client` SDK audit:** Before committing to `managed: true` (Story 35.5), audit the SDK for: crash recovery, containerized operation, maintenance cadence, platform support.

4. **Peer discovery timeline:** Static config is day-one. When should Nostr-based `.anon` address advertisements be prioritized?

5. **Dual-role hardware partnership:** ATOR sells relay hardware. Adding TOON connector to the hardware image creates dual-revenue devices. Is this a partnership worth pursuing?

6. **ILP timeout adjustments:** Should ATOR-connected peers automatically get longer ILP PREPARE timeouts, or is this purely operator config?
