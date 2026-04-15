# ATOR Protocol Integration Handoff — Onion Routing Transport for TOON Connectors

**Date:** 2026-04-13
**Author:** Jonathan Green (with BMAD multi-agent roundtable analysis)
**Audience:** TOON Protocol development team
**Status:** Exploration / Pre-RFC

---

## Executive Summary

This document captures findings from a deep multi-agent research session exploring how **ATOR Protocol** (a Tor fork with token-incentivized relay network) integrates with **TOON Protocol** connectors. The goal: determine whether ATOR provides meaningful value as a privacy transport layer for ILP connector peering, and identify the honest integration path.

**Bottom line:** ATOR provides a single, high-value capability: it lets TOON connectors peer through `.anon` hidden services, enabling **home-hosted connectors on Raspberry Pis with no public IP, no port forwarding, and hidden peering graphs**. The integration is minimal (~50 lines of SOCKS5 proxy support + one npm dependency). Several more ambitious integration models (DVM, incentive replacement, relay-connector merge) were explored and invalidated with documented reasoning.

---

## What Is ATOR Protocol

ATOR (Anyone Protocol) is a **fork of Tor 0.4.9.x** with token-incentivized relay operators. The protocol-level changes from upstream Tor are zero — same onion routing, same cryptography, same circuit construction. The differences are:

| Aspect | Tor | ATOR (Anyone Protocol) |
|--------|-----|----------------------|
| Binary | `tor` | `anon` |
| Hidden service TLD | `.onion` | `.anon` |
| Directory authorities | Tor Project's 10 | 7 Anyone-run DAs |
| Relay incentive | Volunteer | ANYONE token rewards (proof of capacity) |
| Relay count | ~6,500 | 22K registered, ~7.6K active |
| Relay registration | Free | 100 ANYONE tokens staked for 6 months |
| Token distribution | N/A | Hourly, gasless, via Smartweave on Arweave |
| Novel cryptography | N/A | None — identical to Tor |

**SDK:** `@anyone-protocol/anyone-client` on npm (v1.1.3). Manages `anon` binary lifecycle, exposes SOCKS5 proxy for tunneling traffic through the Anyone relay network.

**Repository:** https://github.com/anyone-protocol
**Docs:** https://docs.anyone.io

---

## Why This Matters for TOON Protocol

### The Problem It Solves

Running a TOON connector today requires:
- A server with a **public IP address**
- **Port forwarding** or a cloud VPS ($5-20/month)
- A **domain name** or static IP for peer discovery
- Accepting **IP exposure** to every BTP peer

This limits connector operation to people comfortable with server administration and cloud hosting.

### What ATOR Enables

With ATOR's `.anon` hidden services, a connector can run from **any network**:
- **No public IP** — hidden service protocol handles rendezvous
- **No port forwarding** — works behind any NAT, including carrier-grade NAT
- **No domain name** — `.anon` address derived from keypair
- **No IP exposure** — peers never see the operator's real IP
- **Raspberry Pi on home WiFi** — genuinely sufficient hardware

---

## Architecture

### OSI Layering Model

The core architectural insight: Tor doesn't care about HTTP. It won't care about ILP. TOON is just application-layer payload riding through encrypted circuits.

```
┌─────────────────────────────────────────────────────────┐
│  APPLICATION    TOON Connectors                         │
│                 BTP/WebSocket peering, ILP routing,     │
│                 per-packet fees, NIP-59 settlement      │
│                 Operators earn: ILP routing fees         │
├─────────────────────────────────────────────────────────┤
│  CIRCUIT        ATOR Onion Routing                      │
│                 514-byte fixed-size encrypted cells      │
│                 Payload opaque to all relays             │
│                 3-hop circuits, telescoping key exchange │
├─────────────────────────────────────────────────────────┤
│  TRANSPORT      ATOR Relay Network                      │
│                 22K nodes routing cells                  │
│                 Content-blind (sees only circ_id)        │
│                 Operators earn: ANYONE tokens            │
├─────────────────────────────────────────────────────────┤
│  LINK           TLS connections between relays          │
└─────────────────────────────────────────────────────────┘
```

### Three-Layer Privacy Stack

When NIP-59 gift wrapping is enabled, the full stack provides three nested encryption layers:

| Layer | What It Hides | From Whom |
|-------|---------------|-----------|
| **ATOR circuit** | All traffic — 514-byte fixed cells, content-blind | Relays, network observers, ISPs |
| **ILP routing** | Only connector endpoints see destination, amount, expiry | Hidden from relays (encrypted in cells) |
| **NIP-59 gift wrap** | Settlement claims: sender identity, blockchain type, amounts, timing (±48h) | Hidden from intermediary connectors |

**Emergent property:** An adversary must compromise all three layers simultaneously for full deanonymization. Each layer requires a different class of attack (network surveillance vs connector compromise vs key compromise).

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

### Multi-Hop Payment Flow (All Nodes Behind NAT)

```
Alice's Pi          ATOR Relay Network          Bob's Pi           Carol's Pi
(home NAT)     (22K relays, not our infra)     (home NAT)         (home NAT)
    │                                              │                   │
    ├──── circuit (6 hops via rendezvous) ────────►│                   │
    │     ILP PREPARE: 1000 to g.carol             │                   │
    │                                              ├── circuit ───────►│
    │                                              │   PREPARE: 999    │
    │                                              │                   │
    │                                              │◄── FULFILL ───────┤
    │◄──────────── FULFILL ────────────────────────┤                   │
    │                                              │                   │
    │  Alice earned: 1 (fee)                       │  Bob earned: 1    │
```

Each connector-to-connector link is a separate ATOR circuit (different entry guards, different rendezvous points). An observer cannot correlate the circuits.

---

## What Was Explored and Invalidated

Five integration hypotheses were tested. Only one survived.

### 1. Overlay Transport (VALIDATED)

**Model:** TOON connectors peer through ATOR circuits using `@anyone-protocol/anyone-client` SDK. Relay operators are unaware ILP traffic flows through their relays. Two separate economic loops.

**Verdict:** Works. Minimal code change. Relay economics unchanged. Connector gets privacy + NAT traversal.

### 2. ATOR Relay as TOON Connector (INVALIDATED)

**Model:** Merge relay and connector into one role — relay forwards cells AND routes ILP packets.

**Why it fails:** Relay sees encrypted cells (514 bytes, opaque). Cannot see ILP destination (needed for routing), cannot see amount (needed for fee calculation), makes no routing decision (circuit is pre-built). These are fundamentally different machines.

### 3. ILP Fees Replacing ATOR Capacity Rewards (INVALIDATED)

**Model:** Replace ATOR's proof-of-capacity token rewards with per-packet ILP fees.

**Why it fails:** The privacy boundary prevents it. Relays are content-blind — they cannot count ILP packets because ILP packets are encrypted inside cells. The relay sees bytes, not payments. The economic separation between layers is load-bearing: any mechanism that leaks payment information across the privacy boundary creates a correlation attack surface.

### 4. Circuit Provider DVM (INVALIDATED)

**Model:** Package ATOR as a DVM (Data Vending Machine, kind:5070) in the TOON marketplace. A "Circuit Provider" DVM builds onion circuits on behalf of clients.

**Why it fails:** In Tor/ATOR, the CLIENT must build circuits via telescoping Diffie-Hellman key exchange. Each hop's session key is negotiated directly between the client and that hop. If a third party builds the circuit, it holds all session keys and sees plaintext traffic — this is a VPN, not onion routing. Privacy model collapses.

### 5. Relay Intelligence DVM (PLAUSIBLE but marginal)

**Model:** DVM sells curated relay lists, path optimization, or bandwidth commitments.

**Verdict:** Technically feasible but may not need the DVM pattern. The existing directory authority consensus already provides relay information. Value-add is marginal.

---

## Integration Specification

### Scope

| Item | Estimate |
|------|----------|
| New dependency | `@anyone-protocol/anyone-client` (manages `anon` binary) |
| New dependency | `socks-proxy-agent` (SOCKS5 HTTP agent for Node.js) |
| New files | 2 (`src/transport/socks-transport-provider.ts` + test) |
| Modified files | 3 (config schema, connector-node.ts, BTP WebSocket client) |
| Lines of integration code | ~50 |
| Protocol changes (ATOR) | 0 |
| Protocol changes (ILP/BTP) | 0 |

### What Changes in the Connector

**1. Config schema addition** (Zod-validated YAML):

```yaml
# connector.yaml — new optional block
transport:
  type: "socks5"                    # or "direct" (default, current behavior)
  socksProxy: "socks5h://127.0.0.1:9050"
  externalUrl: "ws://abc123.anon/btp"  # .anon hidden service address
```

**2. BTP WebSocket client** — pass `socks-proxy-agent` as the `agent` option when connecting to peers. The `ws` npm package supports this natively.

**3. TransportProvider interface:**

```typescript
interface TransportProvider {
  createAgent(peerUrl: string): http.Agent;
  getExternalUrl(): string;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

Two implementations: `DirectTransportProvider` (current behavior, default) and `SocksTransportProvider` (routes through SOCKS5 proxy).

### Critical Implementation Rules

| Rule | Why |
|------|-----|
| Use `socks5h://` scheme (with `h`) | DNS must resolve through the proxy, not locally — prevents DNS leaks |
| Never log `.anon` addresses at INFO level | Hidden service addresses are sensitive — DEBUG only |
| Fail closed, never fail open | If SOCKS proxy is unavailable, reject packets — never silently fall back to direct connection |
| Transport is opt-in, default is direct | Zero behavioral change for existing deployments |
| Never silently fall back to direct | Silent fallback is an opsec violation — hard error if proxy is down |

### Peer Discovery

Three approaches, in order of deployment:

1. **Static config (day one):** Operators exchange `.anon` addresses out of band, add to connector YAML
2. **Nostr advertisements (near term):** Publish kind:10035 SkillDescriptor with `.anon` address using existing NIP-59 identity keys
3. **ILP route broadcasting (steady state):** Standard CCP route announcements flow over BTP channels already inside ATOR circuits

---

## Performance Characteristics

| Metric | Without ATOR | With ATOR |
|--------|-------------|-----------|
| BTP connection latency | ~50ms (direct TCP) | ~600ms (6-hop rendezvous circuit) |
| ILP packet round-trip (per hop) | ~100ms | ~400-700ms |
| 3-hop ILP payment round-trip | ~300ms | ~1.2-2.1s |
| ILP STREAM throughput | Limited by TCP | Limited by circuit bandwidth (~1-5 MB/s) |
| Connection establishment | Instant (TCP handshake) | ~2-5s (circuit build + hidden service rendezvous) |

**Assessment:** Latency is acceptable for ILP STREAM micropayments (pipelined, throughput matters more than individual packet latency). May be noticeable for single large payments. Not suitable for latency-critical real-time settlement.

---

## Security Analysis

### What the Integration Protects Against

- Network-level observer correlating connector identity with ILP activity
- Peer connectors learning each other's physical IP addresses
- ISP/government surveillance of connector-to-connector payment traffic
- Infrastructure topology mapping by competitors

### What It Does NOT Protect Against

- **Timing correlation by global passive adversary** — standard onion routing limitation
- **ILP address leaking destination identity** — hierarchical addressing is inherently informative to intermediary connectors
- **Compromised entry + exit** — same as Tor's guard/exit correlation attack
- **Application-level leaks** — misconfigured logging, DNS leaks (mitigated by `socks5h://`)

### Cross-Layer Attack Surface

| Attack | What adversary learns | Severity |
|--------|----------------------|----------|
| Compromised relay only | 514-byte cells between adjacent nodes. Nothing else. | Low |
| Compromised connector only | ILP destination, amount, expiry. Not sender identity or settlement details (NIP-59). | Medium |
| Compromised entry relay + ILP destination | Full sender-to-receiver linkage via timing correlation. | High |
| Full stack (entry + connector + receiver key) | Total deanonymization. Requires all three layers compromised. | Critical (but expensive) |

### Novel Risk: ECDH Shared Secret Dual-Use

The NIP-59 gift wrapping derives the ILP `executionCondition` from the same ECDH shared secret used for gift wrap encryption (`CONDITION_HKDF_INFO = 'ilp-condition-preimage'`). If the receiver's secp256k1 private key is compromised, both the ILP fulfillment and the NIP-59 settlement claims are exposed simultaneously. Consider whether this dual-use should be separated in a future version.

---

## Economic Model

### Two Separate Economic Loops (By Design)

| Layer | Who earns | What they earn | Paid for |
|-------|-----------|---------------|----------|
| ATOR Relay | Relay operators | ANYONE tokens | Available bandwidth (consensus-measured capacity) |
| TOON Connector | Connector operators | ILP per-packet fees | Actual payment routing work |

These loops are intentionally separate. The privacy boundary (encrypted cells) prevents ILP fees from reaching relay operators. This is not a bug — it's the same structure as ISPs carrying Netflix traffic without Netflix revenue.

### Dual-Role Operator Opportunity

A single operator can run both an ATOR relay and a TOON connector on the same hardware:
- Earns ANYONE tokens for relay capacity
- Earns ILP fees for payment routing
- Two independent revenue streams, one set of fixed costs

ATOR already sells plug-and-play relay hardware. Adding TOON connector to that hardware image = consumer device earning both revenue streams.

---

## Open Questions for Team Discussion

1. **ATOR vs mainline Tor?** Same protocol, different relay network. Should we support both (pluggable transport abstraction) or partner specifically with ATOR for token alignment and relay network size?

2. **Latency budget:** Is 1.2-2.1s round-trip for a 3-hop ILP payment acceptable for our target use cases? Which use cases are latency-sensitive enough to require direct (non-ATOR) peering?

3. **Dual-role hardware partnership:** ATOR sells relay hardware. Adding TOON connector to the image creates a device that earns from both networks. Is this a partnership worth pursuing?

4. **Peer discovery via Nostr:** We already have NIP-59 keys and kind:10035 SkillDescriptors. Advertising `.anon` connector addresses on Nostr is natural. Should this be part of the initial integration or a follow-up?

5. **`anyone-client` SDK maturity:** The SDK is at v1.1.3. Before committing, we need to verify: crash recovery, containerized operation (Docker, no TTY), maintenance cadence, and whether the Anyone Protocol team is actively maintaining it.

6. **When to build:** The integration is ~50 lines + 1 dependency. It could ship as an optional transport provider in a single sprint. Is it worth prioritizing given current roadmap?

---

## Recommendation

**Ship as an optional, opt-in transport provider.** The integration cost is minimal (one sprint), the privacy and accessibility benefits are real (home-hosted connectors, hidden peering graphs), and the implementation is clean (no protocol changes, no architectural disruption). Default behavior is unchanged — operators who don't enable ATOR transport see zero difference.

The strongest value proposition is not privacy for its own sake — it's **democratizing connector operation**. ATOR hidden services turn every home network into a viable connector hosting environment. This could meaningfully increase the number and geographic diversity of TOON connectors.

---

## References

- ATOR Protocol repository: https://github.com/anyone-protocol
- Anyone Protocol SDK: `@anyone-protocol/anyone-client` on npm
- Anyone Protocol docs: https://docs.anyone.io
- Tor onion routing design: https://spec.torproject.org/tor-design
- Tor hidden service protocol: https://community.torproject.org/onion-services/overview/
- `socks-proxy-agent` npm package: https://www.npmjs.com/package/socks-proxy-agent
- TOON NIP-59 implementation: `packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts`
- Prior research: `connector/_bmad-output/planning-artifacts/research/technical-tor-onion-routing-research-2026-04-13.md`
