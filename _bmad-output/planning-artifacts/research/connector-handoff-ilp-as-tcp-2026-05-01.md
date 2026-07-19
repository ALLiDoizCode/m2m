# Connector Project Handoff: ILP-as-TCP Local Delivery Pipeline

**Date:** 2026-05-01  
**From:** TOON Protocol / Townhouse team  
**Priority:** HIGH — blocks Townhouse v2 and TownHub registry  
**Full spec:** `toon-ilp-as-tcp-townhub-design-2026-05-01.md` (same directory)

---

## What We Are Building and Why

Townhouse is evolving into "Docker Desktop for TOON nodes." Any OCI container image should be deployable as a TOON node — an Arweave storage service, a Nostr relay, a token swap peer, a pet dungeon — without the node developer writing a single line of ILP code.

Right now that's not possible. Every TOON node must import `@toon-protocol/sdk`, call `createNode()`, and register handlers. The SDK embeds Schnorr signature verification, pricing validation, and settlement tracking. This means:

- Node developers must use TypeScript/JavaScript
- Node developers must understand the ILP payment flow
- A standard `strfry` Nostr relay binary can never be a TOON node without modification
- Bugs in verification logic must be fixed in every node independently

**The fix:** move the ILP payment boundary into the connector's local delivery pipeline. The connector already owns ILP routing, claim validation, and settlement accounting. It should also own the final validation steps before handing a packet to a node — Schnorr verification, nonce monotonicity, and pricing gate. By the time a packet reaches the node's HTTP server, the connector has already confirmed it is valid and paid-for.

The result: a node is just an HTTP service. It receives a Nostr event, does its work, returns 200 or 4xx. No ILP knowledge required.

---

## The Current Flow vs The Target Flow

**Current:**
```
Sender → ILP PREPARE (+ signed claim) → Connector
  → Connector validates claim, routes
  → Connector HTTP POST /handle-packet (raw ILP packet) → Node SDK
  → SDK: parse → Schnorr verify → price check → dispatch to handler
  → Handler: accept/reject
  → SDK: return FULFILL/REJECT to connector
```

**Target:**
```
Sender → ILP PREPARE (+ signed claim) → Connector
  → Connector validates claim
  → Connector: Schnorr verify
  → Connector: price check against toon.json rate
  → Connector HTTP POST / (Nostr event JSON + X-TOON-* headers) → Node
  → Node: business logic only → HTTP 200 or 4xx
  → Connector: HTTP 200 → ILP FULFILL, HTTP 4xx → ILP REJECT
```

The SDK's verify/price/dispatch pipeline is replaced by a new connector-side stage. The node sees a plain HTTP call.

---

## What the Connector Needs to Build

### New file: `connector/src/local-delivery.ts`

This is the core of the change. It sits between "packet routed to local peer" and "packet delivered to node's HTTP server."

Pipeline (in order):

**Step 1 — Schnorr signature verification**  
Extract the TOON Nostr event from the ILP packet data field. Verify the Schnorr signature on the event against the sender's pubkey.  
- Reject with ILP error code F99 if signature is invalid  
- Use `@noble/curves/secp256k1` (or the existing connector crypto dep — don't add a new one)

**Step 2 — Nonce monotonicity check**  
The signed claim carries a `nonce`. For each sender pubkey, track the highest nonce seen.  
- Reject if incoming nonce ≤ last seen nonce for that pubkey  
- This prevents replay attacks  
- Storage: extend the existing per-peer balance store (SQLite/TigerBeetle already tracked); add a `last_nonce` column/field per sender pubkey

**Step 3 — Pricing gate**  
Read the node's declared rate from `toon.json` (see §toon.json Contract below).  
- `per_kb` mode: reject if `packet.amount < rate_msats_per_kb × ceil(payload_bytes / 1024)`  
- `per_job` mode: reject if `packet.amount < rate_msats`  
- Reject with ILP F04 (insufficient destination amount) if underpaid  
- The rate comes from `toon.json`, not from the node at runtime — the connector is the enforcement point

**Step 4 — HTTP delivery**  
POST to the node's `handler_url` (from `toon.json`):

```
POST <handler_url>
Content-Type: application/json
X-TOON-Amount: <ilp_packet_amount>
X-TOON-Sender: <sender_ilp_address>
X-TOON-Pubkey: <sender_nostr_pubkey_hex>
X-TOON-Nonce: <claim_nonce>
X-TOON-Kind: <nostr_event_kind>

<raw Nostr event JSON>
```

Body is the decoded Nostr event JSON — not the raw ILP packet. Headers carry the payment context. The node never sees an ILP packet.

**Step 5 — Map HTTP response to ILP response**

| Node returns | Connector sends |
|---|---|
| HTTP 200 | ILP FULFILL (fulfillment data = response body if non-empty, else empty) |
| HTTP 402 | ILP F04 (insufficient — should be rare, connector already validated) |
| HTTP 4xx | ILP F99 (application reject) |
| HTTP 5xx | ILP T00 (temporary error — retryable per ILP spec) |

**Call-site change in connector:** wherever the connector currently routes a packet to a local peer's HTTP handler, replace that call with `await localDeliver(packet, nodeConfig)`. This should be a single call-site change; everything else is additive.

---

### New file: `connector/src/toon-config-loader.ts`

Reads and watches `toon.json` from each node's config path. The connector learns about each local node via this file.

- Watch via `fs.watch` or polling (fs.watch preferred for low latency)
- Cache parsed config in memory, keyed by node ILP address
- On change: reload and update the in-memory cache (hot reload)
- On connector startup: scan configured node config dirs and load all `toon.json` files

The connector needs to know where to find each node's `toon.json`. Two options:
1. Each node's config dir is registered with the connector at setup time (preferred — explicit)
2. Auto-discovery in a well-known directory (simpler but less flexible)

Start with option 1. The Townhouse orchestrator tells the connector where each node's `toon.json` lives when it registers the node.

---

### New file: `connector/src/payment-headers.ts`

Small helper module. Constructs the `X-TOON-*` HTTP headers from an ILP packet + claim data. Extracted as a separate module so it can be tested independently and evolved without touching the delivery pipeline.

---

## toon.json Contract

Every TOON node image ships a `toon.json`. The connector reads this — it is the node's declaration of its ILP address, pricing, and settlement preferences.

```json
{
  "version": "2",
  "ilp_address": "g.toon.us1.relay-abc",
  "handler_url": "http://127.0.0.1:7100",
  "pubkey": "npub1...",
  "pricing": {
    "mode": "per_kb",
    "rate_msats_per_kb": 10,
    "min_msats": 1
  },
  "kinds": [1, 3, 7],
  "settlement": {
    "threshold_msats": 100000,
    "interval_seconds": 3600
  }
}
```

**Field definitions:**

- `version`: schema version, currently `"2"` (v1 = no toon.json; nodes used SDK directly)
- `ilp_address`: the node's ILP address; connector adds this to its routing table
- `handler_url`: where the connector POSTs the Nostr event; must be reachable from connector's network namespace (in Townhouse: same Docker network)
- `pubkey`: the node's Nostr pubkey; connector uses this to filter inbound events (optional — if absent, connector delivers all packets to this node for the declared `kinds`)
- `pricing.mode`: `"per_kb"` or `"per_job"` — determines how `min_msats` is calculated per packet
- `pricing.rate_msats_per_kb`: msats per KB of Nostr event payload (used when `mode = "per_kb"`)
- `pricing.min_msats`: minimum accepted payment regardless of payload size
- `kinds`: which Nostr event kinds this node handles; connector uses this for routing (a packet to kind:5094 goes to the node declaring `"kinds": [5094]`, not to the relay declaring `"kinds": [1, 3, 7]`)
- `settlement.threshold_msats`: fire settlement when cumulative balance crosses this amount
- `settlement.interval_seconds`: also fire settlement every N seconds regardless of amount

---

## Settlement Migration

`SettlementMonitor` currently lives in `@toon-protocol/sdk` (`packages/sdk/src/settlement/settlement-monitor.ts`). It should move to the connector.

**Why:** settlement is about the payment channel balance between two ILP peers. That's entirely connector-domain. Nodes should not need to manage their own settlement timers — they don't even know what chain their channels are on. The connector already tracks cumulative balances (that's how claims work). The settlement trigger is just a threshold watch on that existing balance data.

**What to build:** `connector/src/settlement/toon-settlement.ts`

- On startup: for each registered node, start a settlement watcher using thresholds from `toon.json`
- Watcher checks the per-peer cumulative balance (already tracked by the claim validation store)
- When `balance >= threshold_msats` OR `time_since_last_settlement >= interval_seconds`: trigger on-chain settlement using the latest claim for that peer
- The settlement logic itself (submitting the claim to the payment channel contract) already exists in the connector's settlement modules — this is wiring the trigger, not rewriting settlement

**Migration path:**
1. Build `toon-settlement.ts` in the connector
2. Verify it fires correctly against the connector's existing balance store
3. Deprecate `SettlementMonitor` in the SDK (keep as a stub that logs a warning for operators on old SDK versions)
4. Delete from SDK in the next major SDK version

---

## What This Enables

Once this is built, any HTTP service + `toon.json` is a TOON node:

```bash
# Run strfry (unmodified Nostr relay) as a TOON node
docker run -v ./toon.json:/etc/toon/toon.json strfry/strfry relay

# The connector reads toon.json, routes ILP packets to strfry's HTTP endpoint
# strfry stores the Nostr event, returns 200
# Connector sends ILP FULFILL
# strfry never imported any TOON SDK
```

This is the acceptance test for the entire redesign. If an unmodified `strfry` binary stores Nostr events via ILP with no SDK code, ILP-as-TCP is achieved.

---

## What Does NOT Change in the Connector

- ILP routing (multi-hop, prefix matching) — unchanged
- BTP peer protocol — unchanged
- Claim validation (nonce, signature) at the **peer level** — unchanged (this is different from the node-level Schnorr verify above; peer-level claim validation already happens, node-level Schnorr verify is new)
- Multi-chain settlement (EVM, Solana, Mina) — unchanged
- Connector admin API — unchanged (Townhouse uses this for monitoring)

---

## Sequencing Recommendation

1. `toon-config-loader.ts` first — everything else reads from it
2. `payment-headers.ts` — small, isolated, testable
3. `local-delivery.ts` — the main pipeline; write tests against a mock node HTTP server
4. Wire `local-delivery.ts` into the connector's routing (single call-site change)
5. `toon-settlement.ts` — can be built in parallel with 1-4

---

## Questions for the Connector Team

1. **Where exactly in the current codebase does local delivery happen?** The call-site change in step 4 depends on this. Based on our understanding, it's wherever the connector resolves an ILP address to a local HTTP peer — likely in the BTP plugin layer or the routing handler. Can you confirm the file/function?

2. **What crypto library is currently used for signature ops?** We want to reuse the existing dep for Schnorr verify, not add `@noble/curves` if it's already there under a different name.

3. **How is the per-peer balance currently stored?** We need to add `last_nonce` tracking alongside it. Is it TigerBeetle, SQLite, or in-memory? What's the right way to extend it?

4. **Settlement: does the connector already have a timer/threshold mechanism for any use case?** If so, `toon-settlement.ts` can extend it rather than build from scratch.

---

## Full Context

Full architecture spec (ILP-as-TCP, TownHub registry, swap NIP, DVM splitting, multi-connector topology, dashboard UX):  
`_bmad-output/planning-artifacts/research/toon-ilp-as-tcp-townhub-design-2026-05-01.md`

The connector changes described here are one part of a larger redesign. The connector team does not need to understand the full Townhouse dashboard or TownHub registry to build this — the scope above is self-contained. But the full spec is available for context.
