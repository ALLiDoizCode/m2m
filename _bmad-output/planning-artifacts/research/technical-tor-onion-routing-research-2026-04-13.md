---
stepsCompleted: [1, 2, 3, 4, 5, 6]
inputDocuments: []
workflowType: 'research'
lastStep: 1
research_type: 'technical'
research_topic: 'Tor onion routing/circuits and integration points with ILP connector'
research_goals: 'Understand how Tor onion routing and circuits work, and identify potential integration points with the multi-chain ILP connector'
user_name: 'Jonathan'
date: '2026-04-13'
web_research_enabled: true
source_verification: true
---

# Privacy-Enhanced ILP Connector Peering: Comprehensive Tor Onion Routing Technical Research

**Date:** 2026-04-13
**Author:** Jonathan
**Research Type:** technical

---

## Research Overview

This technical research investigates how Tor onion routing and circuit construction work at a protocol level, and identifies concrete integration points with the multi-chain ILP connector. The research covers Tor's telescoping circuit architecture, v3 onion services, the Arti Rust implementation, and SOCKS5 proxy integration patterns — then maps these capabilities onto the connector's existing architecture for peer communication, settlement privacy, and operational deployment.

Key findings indicate that Tor integration is both technically feasible and architecturally clean for this connector. The SOCKS5 sidecar proxy pattern requires minimal code changes (primarily an HTTP agent swap), aligns with established cryptocurrency precedent (Bitcoin Core, LND, Zcash), and fits naturally into the connector's existing pluggable provider architecture. A three-phase incremental adoption strategy — outbound proxy, inbound onion service, settlement RPC privacy — balances risk against privacy gains. See the full Executive Summary and Recommendations in the Research Synthesis section below.

---

## Technical Research Scope Confirmation

**Research Topic:** Tor onion routing/circuits and integration points with ILP connector
**Research Goals:** Understand how Tor onion routing and circuits work, and identify potential integration points with the multi-chain ILP connector

**Technical Research Scope:**

- Architecture Analysis - design patterns, frameworks, system architecture
- Implementation Approaches - development methodologies, coding patterns
- Technology Stack - languages, frameworks, tools, platforms
- Integration Patterns - APIs, protocols, interoperability
- Performance Considerations - scalability, optimization, patterns

**Research Methodology:**

- Current web data with rigorous source verification
- Multi-source validation for critical technical claims
- Confidence level framework for uncertain information
- Comprehensive technical coverage with architecture-specific insights

**Scope Confirmed:** 2026-04-13

## Technology Stack Analysis

### Core Protocol Architecture

Tor (The Onion Router) implements a layered encryption scheme for anonymous communication over TCP. The protocol's fundamental architecture consists of:

**Circuit Construction (Telescoping Path-Building):**
Rather than building the entire path at once, Tor uses incremental/telescoping circuit construction. The initiator negotiates session keys with each successive hop using Diffie-Hellman key exchange, providing forward secrecy. Once session keys are deleted, subsequently compromised nodes cannot decrypt old traffic.

**Three-Hop Default Circuit:**
- **Guard (Entry) Node** - First relay, knows the client's IP but not the destination
- **Middle Relay** - Knows neither source nor destination, only predecessor and successor
- **Exit Node** - Knows the destination but not the client's IP

**Key Properties:**
- Each relay only knows its predecessor and successor in the circuit
- Circuits are reused and rotated approximately once per minute
- All communication is TCP-only (no UDP support via SOCKS)

_Source: [Tor Design Paper](https://spec.torproject.org/tor-design), [Wikipedia - Onion Routing](https://en.wikipedia.org/wiki/Onion_routing)_

### Onion Services v3 Protocol

V3 onion services (formerly "hidden services") allow servers to receive connections without revealing their network location:

**Architecture:**
1. Service selects introduction points (Tor relays) and builds anonymized circuits to them
2. Service publishes a signed descriptor to the Hidden Service Directory (distributed hash table on Tor relays)
3. Client fetches the descriptor, contacts an introduction point, and proposes a rendezvous point
4. Both client and service build circuits to the rendezvous point, establishing a 6-hop connection

**V3 Cryptographic Improvements:**
- 56-character addresses based on Ed25519 public keys (replacing 16-char RSA-based v2 addresses)
- All hidden service directory data is encrypted using key derivation from the address
- Better resistance to brute-force and cryptographic attacks

_Source: [Tor Community - Onion Services Overview](https://community.torproject.org/onion-services/overview/), [V3 Onion Services Usage](https://blog.torproject.org/v3-onion-services-usage/)_

### Programming Languages and Libraries

**Arti (Rust) - Primary Modern Implementation:**
Arti is the official Rust reimplementation of the Tor protocols, reaching its 1.0.0 production-ready milestone. Key characteristics:
- Designed as a modular, embeddable library (not just a standalone daemon)
- Provides `arti-client` crate with async Rust API (AsyncRead/AsyncWrite streams)
- Supports SOCKS proxy mode and direct embedding in Rust applications
- Supports client-side anticensorship features
- Onion service hosting support added post-1.0
- Funded in part by Zcash Community Grants

_Crate: [arti-client on crates.io](https://crates.io/crates/arti-client), Source: [Arti 1.0.0 Release](https://blog.torproject.org/arti_100_released/)_

**C Tor (Legacy):**
The original C implementation (`tor` daemon) remains widely deployed but is being superseded by Arti for new development. It exposes a SOCKS5 proxy on a configurable port (default 9050).

**Node.js / TypeScript Integration Options:**
- **SOCKS Proxy**: Connect through Tor's SOCKS5 port using libraries like `socks` or `socks-proxy-agent`
- **Arti subprocess**: Spawn `arti` CLI as a child process exposing a local SOCKS proxy
- **No native FFI yet**: Arti does not currently offer a stable FFI/C API for direct binding from Node.js, though this is planned
- **Docker sidecar**: Run a Tor SOCKS proxy container alongside the application

_Source: [Arti FAQ](https://arti.torproject.org/FAQs/), [Tor SOCKS Extensions Spec](https://spec.torproject.org/socks-extensions.html)_

### SOCKS Proxy Integration Patterns

Applications integrate with Tor primarily through the SOCKS protocol:

- **SOCKS5** is the preferred protocol version (supports authentication, hostname resolution via SOCKS5h)
- **SOCKS4A** supported for legacy compatibility
- **TCP only** - Tor's SOCKS implementation does not support UDP ASSOCIATE
- **Tor-specific extensions** to SOCKS allow circuit isolation per destination (stream isolation)

**Integration Approaches:**
1. **Library-level**: Configure HTTP/TCP clients to use SOCKS proxy (e.g., `socks-proxy-agent` in Node.js)
2. **Process-level**: Use `torsocks` to transparently route all TCP through Tor
3. **Container-level**: Docker sidecar with Tor SOCKS proxy exposed on localhost
4. **Embedded**: Link Arti directly into Rust applications as a library dependency

_Source: [Tor SOCKS Extensions](https://spec.torproject.org/socks-extensions.html), [Proxying Through Tor](https://osamaelnaggar.com/blog/proxying_application_traffic_through_tor/)_

### Performance Characteristics

**Circuit Build Time:**
- Several hundred milliseconds due to public-key cryptography and multi-hop network latency
- Circuits are pre-built and rotated (~1 minute lifetime), amortizing build cost

**Latency:**
- Geographic latency-optimized path selection achieves ~40ms minimum round-trip
- Typical latency adds 200-600ms overhead vs. direct connections depending on relay geography
- Congestion-aware relay selection can improve throughput by up to 42% over baseline

**Throughput:**
- Research indicates only ~50% of available Tor network bandwidth is utilized
- Multipath routing (2 parallel circuits) can significantly improve throughput
- Beyond 2 circuits, 90th percentile transfer times actually increase

**Implications for ILP:**
- Circuit build time is comparable to but slower than typical ILP packet round-trips
- STREAM payment chunking aligns well with Tor's circuit reuse model (many streams per circuit)
- TCP-only limitation is not an issue since ILP-over-HTTP (RFC 0035) uses TCP

_Source: [Tor Metrics - Performance](https://metrics.torproject.org/onionperf-latencies.html), [Path Selection Optimization Research](https://arxiv.org/html/2508.17651v1)_

### Technology Adoption Trends

**Tor Ecosystem Evolution:**
- Arti (Rust) is the future of Tor development; the C implementation is in maintenance mode
- Zcash, Bitcoin, and other cryptocurrency projects have been early adopters of Tor integration for privacy
- Post-quantum cryptography research is active for future-proofing onion routing (NIST workshop papers exist)
- Pluggable transports (obfs4, Snowflake) extend Tor's censorship resistance capabilities
- Growing interest in embedding Tor in applications rather than running standalone daemons

_Source: [Arti GitLab](https://gitlab.torproject.org/tpo/core/arti), [Post-Quantum Onion Routing (NIST)](https://csrc.nist.gov/csrc/media/events/workshop-on-cybersecurity-in-a-post-quantum-world/documents/papers/session3-kate-paper.pdf)_

## Integration Patterns Analysis

### ILP-over-HTTP via Tor SOCKS Proxy (Peer Transport Privacy)

The most direct integration point: ILP connectors communicate with peers using ILP-over-HTTP (RFC 0035). By routing these HTTP connections through Tor, connector operators can hide their physical IP addresses from peers.

**Architecture:**
```
ConnectorNode → SOCKS5 Proxy (localhost:9050) → Tor Circuit (3 hops) → Peer Connector
```

**Node.js Implementation Pattern:**
The `socks-proxy-agent` library provides an `http.Agent` that routes traffic through SOCKS5:
```
const agent = new SocksProxyAgent("socks5h://localhost:9050");
// Use agent in HTTP client for ILP peer connections
```

**Key Considerations:**
- `socks5h://` (with 'h') ensures DNS resolution happens through Tor, preventing DNS leaks
- TCP-only limitation is not an issue — ILP-over-HTTP uses TCP
- Per-peer circuit isolation can be achieved by using different SOCKS credentials per peer connection

_Source: [socks-proxy-agent](https://github.com/TooTallNate/node-socks-proxy-agent), [Tor SOCKS Extensions](https://spec.torproject.org/socks-extensions.html)_

### Onion Service Endpoints for Connector Peering

Connectors can expose their ILP-over-HTTP endpoint as a Tor onion service (.onion address), making the connector reachable without revealing its IP address or physical location.

**Architecture:**
```
Peer Connector → Tor Circuit → Rendezvous Point → Tor Circuit → .onion:443 → Local ConnectorNode
```

**Benefits:**
- Connector is reachable without a public IP or domain name
- End-to-end encryption built in (no separate TLS needed, though it can be layered)
- NAT traversal — onion services work behind firewalls without port forwarding
- Censorship resistance — difficult to block specific .onion addresses

**Configuration Pattern:**
Via `torrc`, map the connector's local HTTP port to a virtual .onion port:
```
HiddenServiceDir /var/lib/tor/ilp-connector/
HiddenServicePort 443 127.0.0.1:7770
```

**ILP Config Integration:**
The connector's peer configuration would accept `.onion` addresses as peer URLs, routing those connections through the local Tor SOCKS proxy automatically.

_Source: [Tor Onion Services Setup](https://community.torproject.org/onion-services/setup/), [Tor Onion Services Overview](https://community.torproject.org/onion-services/overview/)_

### Stream Isolation for Per-Peer Circuit Separation

Tor's stream isolation mechanism ensures that traffic to different peers uses separate circuits, preventing a malicious exit node from correlating which peers a connector communicates with.

**Mechanism:**
- Each SOCKS connection with unique credentials (`username:password`) gets its own circuit
- The connector can generate unique SOCKS credentials per peer relationship
- This mirrors Bitcoin Core's approach (PR #5911) of isolating streams per peer connection

**Trade-offs:**
- More circuits = more memory/CPU on both the connector and Tor network
- Circuit build time (~200-500ms) per new peer connection
- Destination-based isolation is recommended over per-connection isolation for resource efficiency

_Source: [Tor Stream Isolation Spec](https://spec.torproject.org/path-spec/stream-isolation.html), [Bitcoin Stream Isolation PR](https://github.com/bitcoin/bitcoin/pull/5911)_

### Parallels with Lightning Network's Onion Routing

The Lightning Network's Sphinx-based onion routing for payment forwarding has strong parallels with ILP's hop-by-hop packet forwarding:

| Concept | Lightning Network | ILP Connector |
|---|---|---|
| Packet forwarding | Onion-encrypted HTLC forwards | ILP Prepare/Fulfill/Reject packets |
| Intermediary knowledge | Only knows predecessor + successor | Only knows predecessor + successor |
| Path determination | Source routing (sender picks path) | Connector routing tables |
| Privacy of endpoints | Sphinx encryption hides sender/receiver from intermediaries | Destination address visible to each hop |
| Settlement | On-chain Bitcoin tx | Multi-chain (EVM, Solana, Mina) |

**Key Insight:** ILP already shares the "each hop only knows predecessor and successor" property at the routing level. However, ILP packets currently expose the destination address to every intermediary. Tor-style layered encryption of the destination address within ILP packets could enhance this — though this would be a protocol-level change, not a transport-level integration.

_Source: [Lightning Onion Routing](https://github.com/lightningnetwork/lightning-onion), [Mastering Lightning Network Ch.10](https://www.oreilly.com/library/view/mastering-the-lightning/9781492054856/ch10.html), [ILPv4 Spec](https://interledger.org/developers/rfcs/interledger-protocol/)_

### Cryptocurrency Ecosystem Precedent

Multiple cryptocurrency projects have successfully integrated Tor:

**Bitcoin Core:** Automatically creates an onion service if Tor is detected. All peer connections can route through Tor. Stream isolation per peer connection.

**Zcash:** Funded Arti development. Uses Tor for both node privacy and transaction broadcast privacy.

**Lightning Network (LND/CLN):** Supports Tor-only mode where the Lightning node is only reachable via .onion address. This is the closest analogue to what an ILP connector would do.

**Relevance to ILP Connector:**
The connector could follow the same pattern as LND — supporting a "Tor mode" where:
1. Peer HTTP connections route through Tor SOCKS proxy
2. The connector exposes an .onion endpoint for inbound peer connections
3. Settlement transactions (EVM, Solana, Mina RPC calls) optionally route through Tor to hide the connector's IP from chain RPC providers

_Source: [Tor at the Heart: Cryptocurrencies](https://blog.torproject.org/tor-heart-cryptocurrencies/), [Tor-Only Bitcoin & Lightning Guide](https://blog.lopp.net/tor-only-bitcoin-lightning-guide/)_

### Settlement Layer Privacy via Tor

Beyond peer communication, Tor can anonymize settlement transactions:

**Chain RPC Privacy:**
- EVM: Route JSON-RPC calls to Ethereum/L2 nodes through Tor to hide connector IP from RPC providers
- Solana: Route RPC calls through Tor (though Solana's high-throughput nature may conflict with Tor's latency)
- Mina: Route GraphQL queries through Tor

**Trade-offs:**
- Added latency (200-600ms per request) may impact settlement speed
- Settlement is less latency-sensitive than ILP packet forwarding (settlement happens asynchronously)
- Running your own chain node behind Tor (like Bitcoin Core does) provides the strongest privacy

### Integration Security Patterns

**Threat Model:**
- Tor protects against network-level observers correlating connector identity with activity
- Does NOT protect against application-level deanonymization (timing analysis, payment amount correlation)
- Exit nodes can observe unencrypted traffic (mitigated by using .onion endpoints or TLS)

**Mutual Authentication over Tor:**
- ILP-over-HTTP already uses Bearer tokens for peer authentication (RFC 0035)
- Bearer tokens work over Tor connections without modification
- .onion addresses themselves provide a form of identity (the public key is the address)
- mTLS can be layered on top of .onion connections for additional peer authentication

**Defense in Depth:**
- Tor provides transport anonymity
- ILP's HMAC-based packet conditions provide payment integrity
- STREAM's encryption provides end-to-end confidentiality between sender and receiver

_Source: [ILP over HTTP](https://interledger.org/developers/rfcs/ilp-addresses/), [Whonix Stream Isolation](https://www.whonix.org/wiki/Stream_Isolation)_

## Architectural Patterns and Design

### System Architecture Pattern: Sidecar Proxy vs. Embedded Library

Two primary architectural patterns exist for integrating Tor into the ILP connector:

**Pattern A: Sidecar Proxy (Recommended for Initial Integration)**
```
┌─────────────────────────────────┐     ┌──────────────────┐
│  ConnectorNode (Node.js)        │     │  Tor Sidecar      │
│                                 │     │  (arti or tor)    │
│  PeerHttpClient ──SOCKS5──────────────▶  SOCKS5 :9050    │
│                                 │     │                    │
│  ILP-over-HTTP  ◀──reverse────────────── .onion :443     │
│  Listener :7770                 │     │  (HiddenService)  │
└─────────────────────────────────┘     └──────────────────┘
```

- Connector code changes are minimal — swap `http.Agent` for `SocksProxyAgent` on peer connections
- Tor process managed externally (Docker sidecar, systemd service, or child process)
- Clean separation of concerns: connector handles ILP logic, sidecar handles anonymity
- Follows the established [sidecar design pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/sidecar) used in service meshes
- **Trade-off:** Additional operational complexity (two processes to manage)

**Pattern B: Embedded Arti Library (Future / Rust-only)**
```
┌─────────────────────────────────────────┐
│  Application (Rust)                      │
│                                          │
│  arti-client ──► TorClient::connect()   │
│  (in-process, async streams)             │
└─────────────────────────────────────────┘
```

- Arti's `arti-client` crate provides in-process async Tor connections
- Only viable for Rust components (e.g., Solana program interactions via a Rust helper)
- No FFI for Node.js yet (planned but not available)
- **Trade-off:** Tighter coupling, but eliminates the SOCKS proxy hop and separate process

**Recommendation:** Pattern A (sidecar) for the Node.js connector, with Pattern B as a future option if a Rust-based connector component emerges.

_Source: [Sidecar Pattern - Azure](https://learn.microsoft.com/en-us/azure/architecture/patterns/sidecar), [Arti About](https://arti.torproject.org/about/), [arti-client docs](https://docs.rs/arti-client/latest/arti_client/)_

### Design Principles: Pluggable Transport Abstraction

The connector's existing architecture already supports pluggable settlement providers (Epic 32+). A similar pattern should apply to transport privacy:

**Proposed Abstraction Layer:**
```
interface TransportProvider {
  // Create an HTTP agent for outbound peer connections
  createAgent(peerUrl: string): http.Agent;
  // Get the externally reachable URL for this connector
  getExternalUrl(): string;
  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;
}

// Implementations:
// - DirectTransport (default, no proxy)
// - TorTransport (SOCKS5 proxy + optional .onion service)
// - Future: I2P, mixnet, etc.
```

**Key Design Decisions:**
- Transport privacy is orthogonal to ILP packet handling — it only affects the HTTP layer
- The abstraction lives at the peer communication boundary, not deep in the connector core
- Configuration-driven: select transport provider via YAML config, similar to settlement providers
- `.onion` addresses are just URLs — no special handling needed in peer config beyond routing through SOCKS

_Source: Connector architecture at `packages/connector/src/settlement/provider/`_

### Scalability and Performance Architecture

**Circuit Management Strategy:**

| Scenario | Circuit Strategy | Latency Impact | Privacy Level |
|---|---|---|---|
| Few peers (< 10) | One circuit per peer (stream isolation) | ~200-400ms initial, then reused | High — peers can't be correlated |
| Many peers (10-50) | Shared circuits with destination isolation | ~100-200ms amortized | Medium — same exit may see multiple peers |
| High-throughput settlement | Direct connection (no Tor) | None | Low — settlement privacy not critical |
| Mixed mode | Tor for peer ILP, direct for chain RPC | Varies | Balanced — privacy where it matters most |

**Pre-built Circuit Pool:**
- Tor pre-builds circuits and rotates them every ~60 seconds
- For a connector with stable peer relationships, circuits are reused efficiently
- STREAM protocol's chunked payments align well — many small packets over one long-lived circuit
- Circuit build latency (~200-500ms) is a one-time cost per peer, not per ILP packet

**Bandwidth Considerations:**
- ILP packets are small (typically < 32KB with STREAM)
- Tor's throughput constraints (~1-5 MB/s per circuit) are more than sufficient for ILP packet forwarding
- Settlement transactions (chain RPC) are also small payload, low frequency

_Source: [Tor Metrics - Performance](https://metrics.torproject.org/onionperf-latencies.html), [Path Selection Optimization](https://arxiv.org/html/2508.17651v1)_

### Security Architecture and Threat Model

**What Tor Protects Against:**
- Network-level observer correlating connector IP with ILP activity
- Peer connectors learning each other's physical IP addresses
- ISP/government surveillance of connector-to-connector traffic
- Chain RPC providers logging connector IP alongside settlement transactions

**What Tor Does NOT Protect Against:**
- **Timing analysis**: ILP packet forwarding timing can correlate sender/receiver across hops. Tor adds latency jitter but does not pad or delay packets to uniform intervals.
- **Payment amount correlation**: If an intermediary sees the same amount enter and exit, it can link the hops regardless of transport anonymity.
- **Application-level leaks**: DNS queries outside Tor (mitigated by `socks5h://`), metadata in HTTP headers, connector configuration errors.
- **Compromised guard/exit nodes**: A global adversary controlling entry and exit points can perform traffic confirmation attacks.

**Defense Strategies:**

| Threat | Defense | Feasibility |
|---|---|---|
| Timing correlation | Tor's inherent circuit latency variance provides some defense; adding artificial delays would harm STREAM performance | Low priority — acceptable trade-off |
| Amount correlation | ILP's STREAM protocol already splits payments into variable-size chunks | Already partially mitigated |
| DNS leaks | Use `socks5h://` for SOCKS proxy (DNS resolved through Tor) | Easy — configuration only |
| Exit node sniffing | Use .onion endpoints (no exit node involved) or TLS over Tor | Medium — requires both peers to support .onion |
| Guard node compromise | Tor's guard rotation and Vanguards defense | Handled by Tor automatically |

**Dandelion++-style Transaction Broadcast:**
Research on Bitcoin deanonymization shows that broadcasting transactions from a known IP is a privacy risk. For ILP, this is less relevant since ILP packets are forwarded along a specific path (not broadcast), but the principle applies to settlement transactions: broadcasting an on-chain transaction from a connector's IP reveals its identity. Routing settlement RPC through Tor mitigates this.

_Source: [Timing Attacks on Payment Channels](https://www.researchgate.net/publication/347578617_Counting_Down_Thunder_Timing_Attacks_on_Privacy_in_Payment_Channel_Networks), [Deanonymization via Network Analysis](https://ieeexplore.ieee.org/document/8806723/), [RPC Deanonymization](https://arxiv.org/html/2508.21440v1)_

### Deployment Architecture Options

**Option 1: Docker Compose (Development/Small Deployments)**
```yaml
services:
  connector:
    image: ilp-connector
    environment:
      - TOR_SOCKS_PROXY=socks5h://tor:9050
  tor:
    image: tor-socks-proxy  # e.g., PeterDaveHello/tor-socks-proxy
    ports: []  # No external ports — connector-only access
```

**Option 2: Kubernetes with Sidecar Injection**
- Tor container as a sidecar in the connector pod
- Shared localhost network — SOCKS proxy accessible at `127.0.0.1:9050`
- Follows the service mesh sidecar pattern (similar to Envoy/Istio)

**Option 3: System-level Tor (Bare Metal/VM)**
- `tor` or `arti` daemon managed by systemd
- Connector configured to use the system SOCKS proxy
- Simplest for single-node deployments

**Option 4: Embedded Subprocess**
- Connector spawns `arti` as a child process on startup
- Manages lifecycle directly
- Reduces external dependencies but increases connector complexity

_Source: [tor-socks-proxy Docker](https://github.com/PeterDaveHello/tor-socks-proxy), [Sidecar Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/sidecar)_

### Data Architecture: Configuration Schema

Extending the existing YAML config with Tor settings:

```yaml
# connector.yaml
transport:
  privacy:
    enabled: false  # opt-in
    provider: "tor"  # or "direct" (default)
    tor:
      socksProxy: "socks5h://127.0.0.1:9050"
      onionService:
        enabled: false
        virtualPort: 443
        targetPort: 7770  # connector's HTTP listener
      streamIsolation: true  # unique circuits per peer
      circuitTimeout: 30000  # ms, for circuit build
```

This follows the connector's existing Zod-validated YAML config pattern at `packages/connector/src/config/`.

## Implementation Approaches and Technology Adoption

### Technology Adoption Strategy: Incremental / Opt-In

Based on LND's experience integrating Tor, the recommended approach is **incremental adoption with hybrid mode support**:

**Phase 1 — SOCKS Proxy for Outbound Peer Connections (Low Risk)**
- Add `socks-proxy-agent` dependency (well-maintained, ~15M weekly npm downloads)
- Introduce `TransportProvider` abstraction in the peer HTTP client layer
- Configuration-driven: `transport.privacy.enabled: true` opts in, default is `false`
- No changes to ILP packet handling, settlement, or routing logic
- **Effort estimate:** Small — primarily configuration and HTTP agent swap

**Phase 2 — Onion Service for Inbound Peering (Medium Risk)**
- Connector manages or expects an external Tor process exposing a `.onion` endpoint
- Peer configuration accepts `.onion` URLs alongside clearnet URLs
- Hybrid mode (LND lesson): support both clearnet and `.onion` peers simultaneously to avoid isolating the connector from non-Tor peers
- **Effort estimate:** Medium — requires lifecycle management and config schema extension

**Phase 3 — Settlement RPC Privacy (Optional)**
- Route chain RPC calls (EVM JSON-RPC, Solana RPC, Mina GraphQL) through Tor
- Per-chain opt-in since latency sensitivity varies (Solana confirmations are faster than EVM)
- **Effort estimate:** Small per chain — reuse the same SOCKS proxy agent pattern

**LND Lessons Learned:**
- Early versions were Tor-only, which severely limited connectivity. Hybrid mode (v0.14.0-beta) was essential.
- Tor reliability issues can cause routing failures under load — the connector should gracefully fall back to direct connections if Tor circuits fail.
- Stream isolation per peer connection is valuable but increases resource consumption.

_Source: [LND Tor Configuration](https://github.com/lightningnetwork/lnd/blob/master/docs/configuring_tor.md), [LND Tor Issue #186](https://github.com/lightningnetwork/lnd/issues/186), [LND Hybrid Mode](https://lightningnetwork.plus/posts/137)_

### Development Workflows and Tooling

**Core npm Dependencies:**

| Package | Purpose | Weekly Downloads |
|---|---|---|
| `socks-proxy-agent` | SOCKS5 `http.Agent` for Node.js | ~15M |
| `socks` | Low-level SOCKS client (peer dep) | ~15M |

**No additional native dependencies** — unlike Arti embedding, the SOCKS proxy approach uses pure JavaScript/TypeScript packages.

**Development Environment Setup:**
```bash
# Option A: Docker (recommended for consistency)
docker run -d --name tor-dev -p 9050:9050 peterdavehello/tor-socks-proxy

# Option B: System Tor
brew install tor && tor  # macOS
sudo apt install tor && systemctl start tor  # Linux

# Verify connectivity
curl --socks5-hostname localhost:9050 https://check.torproject.org/api/ip
```

**TypeScript Integration:**
```typescript
import { SocksProxyAgent } from 'socks-proxy-agent';

// Create agent for Tor SOCKS proxy
const torAgent = new SocksProxyAgent('socks5h://127.0.0.1:9050');

// Use with any HTTP client (fetch, axios, undici, etc.)
const response = await fetch(peerUrl, {
  agent: torAgent,
  headers: { Authorization: `Bearer ${peerToken}` }
});
```

_Source: [socks-proxy-agent npm](https://www.npmjs.com/package/socks-proxy-agent), [socks npm](https://www.npmjs.com/package/socks)_

### Testing and Quality Assurance

**Unit Testing:**
- Mock the `TransportProvider` interface — test connector logic independently of Tor
- Verify that `SocksProxyAgent` is created with correct SOCKS URL and credentials
- Test stream isolation credential generation (unique per peer)

**Integration Testing with Chutney:**
Chutney is the Tor Project's official test network tool:
- Launches a local Tor network with directory authorities, relays, and clients
- Supports hidden service testing out of the box
- Generates `torrc` configurations automatically from templates
- **Limitation:** Resource-intensive; not suitable for CI on every commit — use for periodic/nightly integration tests

**Integration Testing Simplified (CI-friendly):**
```bash
# Spin up a minimal Tor SOCKS proxy in Docker
docker run -d --name tor-test -p 9050:9050 peterdavehello/tor-socks-proxy
# Run connector integration tests with TOR_SOCKS_PROXY env var
TOR_SOCKS_PROXY=socks5h://127.0.0.1:9050 npm run test:integration
# Tear down
docker rm -f tor-test
```

**Test Matrix:**

| Test Type | Tor Required | CI Frequency | What It Validates |
|---|---|---|---|
| Unit (transport provider) | No (mocked) | Every commit | Interface contracts, config parsing |
| Integration (SOCKS proxy) | Yes (Docker) | Every PR | Outbound connections route through Tor |
| Integration (onion service) | Yes (Chutney) | Nightly | Inbound .onion peering works end-to-end |
| Performance (latency) | Yes | Weekly | Tor overhead within acceptable bounds |

_Source: [Chutney GitLab](https://gitlab.torproject.org/tpo/core/chutney), [Chutney README](https://gitweb.torproject.org/chutney.git/tree/README.md)_

### Deployment and Operations Practices

**Monitoring and Observability:**

Tor's design intentionally limits observability to protect privacy, but operators need health signals:

| Metric | How to Collect | Alert Threshold |
|---|---|---|
| SOCKS proxy reachability | TCP health check on `:9050` | Unreachable > 30s |
| Circuit build success rate | Tor control port (GETINFO status) | < 90% success |
| Outbound connection latency | Application-level timing around peer requests | > 2000ms p95 |
| Onion service descriptor published | Tor control port event | Not published > 5min after start |
| Tor process alive | Process monitor / Docker health check | Process exit |

**Grafana Dashboard:** A community [Tor Health dashboard](https://grafana.com/grafana/dashboards/22067-tor-health/) exists for Grafana, providing relay-level metrics. For the connector, extend this with application-level ILP metrics.

**Operational Runbook Considerations:**
- Tor circuits can fail transiently — implement retry with exponential backoff on peer connections
- If Tor SOCKS proxy is unreachable, the connector should log a warning and (if configured) fall back to direct connections rather than failing entirely
- Circuit rotation every ~60s is normal — connections may briefly stall during rotation
- Monitor for Tor network-wide issues (DDoS on directory authorities has happened historically)

_Source: [Tor Metrics](https://metrics.torproject.org/), [Tor Health Grafana](https://grafana.com/grafana/dashboards/22067-tor-health/), [Netdata Tor Monitoring](https://www.netdata.cloud/monitoring-101/tor-monitoring/)_

### Risk Assessment and Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Tor latency degrades ILP packet forwarding | Medium | Medium | Tor for peer peering only (not in the ILP packet hot path if using persistent connections); circuit pre-building |
| Tor network outage/DDoS | Low | High | Hybrid mode: fall back to clearnet; alert on circuit failure rate |
| SOCKS proxy process crashes | Low | Medium | Docker restart policy / systemd auto-restart; health checks |
| Deanonymization via timing analysis | Medium | Low | Accept as known limitation; Tor adds jitter; STREAM chunking helps |
| Complexity burden on operators | Medium | Medium | Opt-in only; clear documentation; Docker Compose one-liner for Tor sidecar |
| npm dependency supply chain risk | Low | Medium | `socks-proxy-agent` is widely used (~15M/week); audit with `npm audit`; pin versions |

## Technical Research Recommendations

### Implementation Roadmap

1. **Immediate (Phase 1):** Add `socks-proxy-agent` dependency, create `TransportProvider` interface with `DirectTransport` and `TorTransport` implementations, extend YAML config schema with `transport.privacy` section
2. **Near-term (Phase 2):** Add onion service lifecycle management (detect/spawn Tor process, read `.onion` hostname file), support `.onion` peer URLs in config, implement hybrid mode
3. **Later (Phase 3):** Per-chain settlement RPC routing through Tor, Chutney-based integration test suite, Grafana dashboard for Tor health metrics
4. **Future (Exploratory):** Evaluate Arti FFI bindings when available for Node.js; explore ILP-level onion routing (Sphinx-style encryption of destination addresses within ILP packets)

### Technology Stack Recommendations

| Component | Recommendation | Rationale |
|---|---|---|
| SOCKS client | `socks-proxy-agent` | De facto standard, huge install base, maintained |
| Tor process | `arti` CLI or Docker `tor-socks-proxy` | Arti is the modern Rust implementation; Docker for ease |
| Test network | Chutney (nightly) + Docker Tor (CI) | Chutney for full simulation, Docker for fast CI |
| Monitoring | Tor control port + Prometheus/Grafana | Existing connector monitoring stack + Tor-specific metrics |

### Skill Development Requirements

- **Core team:** Understanding of SOCKS5 protocol, Tor circuit model, and threat model limitations
- **Operations:** Tor daemon configuration (`torrc`), onion service management, monitoring Tor health
- **No Rust required** for Phase 1-2 (SOCKS proxy approach is pure TypeScript/JavaScript)
- **Rust helpful** for Phase 4 (Arti embedding exploration)

### Success Metrics and KPIs

| KPI | Target | Measurement |
|---|---|---|
| Peer connection success rate over Tor | > 99% | Application metrics |
| Added latency for peer connections | < 500ms p95 overhead | Application timing |
| Onion service uptime | > 99.5% | Health check monitoring |
| Tor-related incidents per month | < 1 | Incident tracker |
| Adoption rate (opt-in operators) | Tracking only | Config telemetry (opt-in) |

## Research Synthesis: Tor Onion Routing for Privacy-Enhanced ILP Connector Peering

### Executive Summary

This research establishes that integrating Tor onion routing into the multi-chain ILP connector is technically sound, architecturally well-suited, and follows proven patterns from the cryptocurrency ecosystem. The Tor network — with 2.5 million daily active users and 8,000+ relays — provides a mature, battle-tested anonymity layer that maps cleanly onto the connector's HTTP-based peer communication model.

The core finding is that **transport-layer privacy via Tor is orthogonal to ILP packet handling** — it operates entirely at the HTTP peer communication boundary, requiring no changes to routing, settlement, or STREAM logic. This separation of concerns means Tor support can be introduced as an opt-in pluggable transport provider, mirroring the connector's existing settlement provider abstraction.

Three integration tiers emerge in order of complexity and value:

1. **Outbound SOCKS proxy** (lowest effort) — hides the connector's IP from peers using `socks-proxy-agent`
2. **Inbound onion service** (medium effort) — makes the connector reachable via `.onion` address without a public IP
3. **Settlement RPC privacy** (per-chain opt-in) — hides the connector's IP from blockchain RPC providers

The Lightning Network's LND implementation provides the closest prior art, demonstrating both the viability and the pitfalls (early Tor-only mode was too restrictive; hybrid clearnet+Tor mode was essential). ILP's STREAM protocol's payment chunking aligns naturally with Tor's circuit reuse model, and ILP's small packet sizes (~32KB) are well within Tor's per-circuit throughput capacity.

**Key Technical Findings:**

- Tor's 200-600ms latency overhead is acceptable for ILP peer communication (not in the per-packet hot path once connections are established)
- `socks-proxy-agent` (~15M weekly npm downloads) is the only new dependency needed for Phase 1
- Stream isolation via unique SOCKS credentials per peer prevents cross-peer traffic correlation
- V3 onion services provide Ed25519-based addressing that doubles as cryptographic identity
- Post-quantum cryptography migration is underway in the Tor ecosystem (hybrid circuit-extension proposal #269)

**Strategic Recommendations:**

1. Start with Phase 1 (SOCKS proxy) — minimal risk, immediate privacy gain, validates the `TransportProvider` abstraction
2. Support hybrid mode from the start — never force Tor-only, following LND's lesson
3. Design the `TransportProvider` interface to be protocol-agnostic (future I2P, mixnet support)
4. Route settlement RPC through Tor only for chains where latency is acceptable (EVM yes, Solana case-by-case)
5. Monitor for Arti FFI developments — when Node.js bindings become available, the embedded option eliminates the sidecar process

### Table of Contents

1. [Technical Research Scope Confirmation](#technical-research-scope-confirmation)
2. [Technology Stack Analysis](#technology-stack-analysis)
   - Core Protocol Architecture
   - Onion Services v3 Protocol
   - Programming Languages and Libraries
   - SOCKS Proxy Integration Patterns
   - Performance Characteristics
   - Technology Adoption Trends
3. [Integration Patterns Analysis](#integration-patterns-analysis)
   - ILP-over-HTTP via Tor SOCKS Proxy
   - Onion Service Endpoints for Connector Peering
   - Stream Isolation for Per-Peer Circuit Separation
   - Parallels with Lightning Network's Onion Routing
   - Cryptocurrency Ecosystem Precedent
   - Settlement Layer Privacy via Tor
   - Integration Security Patterns
4. [Architectural Patterns and Design](#architectural-patterns-and-design)
   - Sidecar Proxy vs. Embedded Library
   - Pluggable Transport Abstraction
   - Scalability and Performance Architecture
   - Security Architecture and Threat Model
   - Deployment Architecture Options
   - Configuration Schema
5. [Implementation Approaches and Technology Adoption](#implementation-approaches-and-technology-adoption)
   - Technology Adoption Strategy
   - Development Workflows and Tooling
   - Testing and Quality Assurance
   - Deployment and Operations Practices
   - Risk Assessment and Mitigation
6. [Technical Research Recommendations](#technical-research-recommendations)
   - Implementation Roadmap
   - Technology Stack Recommendations
   - Skill Development Requirements
   - Success Metrics and KPIs
7. [Future Technical Outlook](#future-technical-outlook)
8. [Research Methodology and Sources](#research-methodology-and-sources)

### Future Technical Outlook

**Near-term (1-2 years):**
- Arti continues to mature; FFI bindings for non-Rust languages are on the roadmap, which would enable direct embedding in Node.js via N-API
- Tor network capacity continues to grow with ~50% of bandwidth currently unutilized
- More cryptocurrency projects adopting Tor integration normalizes the pattern

**Medium-term (3-5 years):**
- Post-quantum cryptography integration into Tor circuits (proposal #269 hybrid ECDH+KEM design) will future-proof against quantum attacks on circuit confidentiality
- Arti relay support would allow running Tor relays in Rust, improving the network's overall security posture
- Potential for ILP-level onion routing (Sphinx-style) as a protocol extension — encrypting destination addresses within ILP packets themselves, complementing transport-layer Tor anonymity

**Long-term (5+ years):**
- Convergence of payment channel privacy techniques (Lightning's Sphinx, ILP's hop-by-hop model) with transport privacy (Tor, I2P) into unified privacy-preserving payment architectures
- Post-quantum signatures for onion service identity (Ed25519 → Dilithium or similar)
- Potential for mixnet-based alternatives (Nym, Katzenpost) offering stronger timing-analysis resistance than Tor's low-latency design

_Source: [Post-Quantum Migration of Tor](https://arxiv.org/html/2503.10238v1), [Tor Statistics 2026](https://sqmagazine.co.uk/tor-statistics/), [Advancing Digital Rights 2026](https://blog.torproject.org/advancing-digital-rights-in-2026/)_

### Research Methodology and Sources

**Research Methodology:**
- Comprehensive web search across Tor Project documentation, academic papers, cryptocurrency implementation case studies, and npm package ecosystems
- Multi-source validation for all critical technical claims
- Cross-referencing with existing ILP connector architecture and RFC specifications
- Practical feasibility assessment against the connector's TypeScript/Node.js stack

**Primary Sources:**

| Source | Type | Used For |
|---|---|---|
| [Tor Design Paper](https://spec.torproject.org/tor-design) | Protocol specification | Circuit construction, routing architecture |
| [Arti 1.0.0 Release](https://blog.torproject.org/arti_100_released/) | Official announcement | Rust implementation status and capabilities |
| [Tor SOCKS Extensions Spec](https://spec.torproject.org/socks-extensions.html) | Protocol specification | SOCKS5 integration patterns, stream isolation |
| [Tor Stream Isolation Spec](https://spec.torproject.org/path-spec/stream-isolation.html) | Protocol specification | Per-peer circuit separation |
| [LND Tor Configuration](https://github.com/lightningnetwork/lnd/blob/master/docs/configuring_tor.md) | Implementation reference | Lessons learned from Lightning Network integration |
| [socks-proxy-agent npm](https://www.npmjs.com/package/socks-proxy-agent) | Package documentation | Node.js SOCKS5 integration |
| [Tor Community - Onion Services](https://community.torproject.org/onion-services/overview/) | Documentation | V3 onion service architecture |
| [Tor Metrics](https://metrics.torproject.org/) | Network data | Performance benchmarks, network health |
| [Chutney GitLab](https://gitlab.torproject.org/tpo/core/chutney) | Test tooling | Integration testing approach |
| [Bitcoin Stream Isolation PR](https://github.com/bitcoin/bitcoin/pull/5911) | Implementation reference | Cryptocurrency Tor integration precedent |

**Secondary Sources:**

- [Lightning Onion Routing](https://github.com/lightningnetwork/lightning-onion) — Sphinx-based payment routing
- [Timing Attacks on Payment Channels](https://www.researchgate.net/publication/347578617) — Privacy threat analysis
- [RPC Deanonymization Research](https://arxiv.org/html/2508.21440v1) — Settlement privacy risks
- [Post-Quantum Migration of Tor](https://arxiv.org/html/2503.10238v1) — Future cryptographic evolution
- [Tor Statistics 2026](https://sqmagazine.co.uk/tor-statistics/) — Network adoption data

**Research Confidence Assessment:**

| Area | Confidence | Notes |
|---|---|---|
| Tor protocol architecture | High | Well-documented, stable specification |
| SOCKS5 integration feasibility | High | Proven pattern, widely used npm packages |
| LND/Bitcoin precedent | High | Production implementations with years of operation |
| Performance overhead estimates | Medium | Varies with network conditions; based on published metrics |
| Arti FFI timeline | Low | Roadmap item without committed dates |
| Post-quantum migration timeline | Low | Active research, no deployment date |

**Research Limitations:**
- Tor network performance varies significantly based on relay selection and network load
- Arti development velocity may change; FFI timeline is speculative
- ILP-level onion routing (Sphinx-style) is a novel concept not yet proposed in ILP RFCs
- Testing was not conducted against the actual connector codebase in this research phase

---

## Technical Research Conclusion

### Summary of Key Technical Findings

Tor onion routing provides a mature, well-understood anonymity layer that integrates cleanly with the ILP connector's HTTP-based peer communication model. The sidecar proxy pattern minimizes code changes while maximizing privacy gains. The cryptocurrency ecosystem (Bitcoin, Lightning, Zcash) has established proven patterns for Tor integration that the connector can follow directly.

### Strategic Technical Impact Assessment

Adding Tor support positions the connector as a privacy-conscious participant in the Interledger network — a differentiator that aligns with the broader trend of privacy-enhanced financial infrastructure. The opt-in nature ensures no performance or complexity penalty for operators who don't need anonymity, while providing meaningful protection for those who do.

### Next Steps Recommendations

1. **Validate architecture**: Review the proposed `TransportProvider` interface against the actual connector codebase at `packages/connector/src/settlement/provider/`
2. **Prototype Phase 1**: Implement `TorTransport` with `socks-proxy-agent` and test against a local Docker Tor proxy
3. **Create epic/stories**: Break Phase 1-2 into implementable stories following the project's BMAD workflow
4. **Engage with ILP community**: Discuss transport privacy as a potential connector feature with the Interledger community

---

**Technical Research Completion Date:** 2026-04-13
**Research Period:** Comprehensive technical analysis with current (2025-2026) sources
**Source Verification:** All technical facts cited with current sources
**Technical Confidence Level:** High — based on multiple authoritative technical sources and established implementation precedent

_This comprehensive technical research document serves as an authoritative technical reference on Tor onion routing integration with the ILP connector and provides strategic technical insights for informed decision-making and implementation._
