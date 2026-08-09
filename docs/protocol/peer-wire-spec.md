# Peer semantics specification (formerly the peer wire specification)

**Status:** Normative for §3–§6. **§1–§2 are deleted** — superseded by
[ADR 0027](../adr/0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md),
and the implementation they described was removed in issue #679.
Originally: normative, version 1 — clean-room design per [ADR 0003](../adr/0003-clean-room-peer-wire-versioned-client-edge.md).
**Consumers:** the Rust `connector-runtime` peer transport port and every implementation of
it (contract-tested per [ADR 0007](../adr/0007-testing-doctrine-fakes-yes-mocks-no.md)); any
non-Rust connector that wishes to peer with this fleet.
**Vocabulary:** [`CONTEXT.md`](../../CONTEXT.md). The key words MUST, MUST NOT, SHOULD and MAY
are per RFC 2119.
**How the claim exchange below fits into value moving end to end across a forwarded packet,
with a diagram:** [`money-model.md`](money-model.md).

## What this document is now

This document used to define a whole protocol: a raw-TCP framing (§1), the ILPv4 packet
structure carried on it (§2), and the peer _semantics_ riding on top (§3–§6). ADR 0027 split
those apart. Connectors peer over one of the two carriages the client edge already serves —
**BTP (RFC-0023) over `wss://`** or **ILP-over-HTTP over `https://`** — so there is no
peer-specific framing left to specify, and the raw-TCP wire that was the only implementation
of §1–§2 has been deleted. It never carried a production packet.

**§1 Framing and §2 Packet structure are therefore gone.** What replaced them:

| What §1–§2 defined                              | Where it lives now                                                                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The stream, framing and the six frame types     | ADR 0027's carriage table — each former frame is a BTP MESSAGE/RESPONSE/TRANSFER or an HTTP request/response, with the extra fields as protocolData entries or headers                                                    |
| Session mechanics on a persistent socket        | [`client-edge-spec.md`](client-edge-spec.md) §1.9 (BTP) and §1.3 (HTTP) — one pipeline, two carriages, per ADR 0026                                                                                                       |
| ILPv4 packet fields and their OER encoding      | `connector_domain::oer` and `vectors/wire-vectors.json`, which were never peer-specific ([ADR 0021](../adr/0021-vectors-are-normative-prose-is-not.md), [ADR 0023](../adr/0023-oer-length-determinants-are-canonical.md)) |
| Peer identity as configuration, not a handshake | Role-by-authentication (ADR 0027): a configured credential **and** a `[[peer_channels]]` entry. Config schema is issue #677; the carriages are #676                                                                       |

**§3–§6 below are unchanged and still normative.** They are the semantics _both_ carriages
carry — claim exchange, fees and minimum delivery, reject codes and accumulated cost,
consistency — and ADR 0027 re-hosts them rather than rewriting them. Section numbering is
deliberately left alone so that every existing citation of §3.2, §3.4, §3.5, §5.2 and §5.3 in
the code, the ADRs and `client-edge-spec.md` still resolves. Where these sections say "frame",
read "whatever the configured carriage frames it as"; ADR 0027's table is the mapping, and
FLUSH (§3.3) and CLAIM_ACK (§3.4) are the two whose mapping is not obvious — on BTP a FLUSH is a TRANSFER and a CLAIM_ACK is a `claim-ack` protocolData entry on the RESPONSE.

Everything below reuses ILPv4's packet semantics (RFC-0027) for the PREPARE/FULFILL/REJECT
fields themselves, since those are Interledger-network-level concepts this connector still
speaks.

## 3. Execution condition, fulfilment, and claim exchange

### 3.1 Execution condition is mandatory and real

Per [ADR 0004](../adr/0004-value-moves-on-fulfilment.md) ("Why the reversal"), every PREPARE on
the peer wire MUST carry a non-zero, 32-byte `executionCondition` chosen by the original sender. A
connector receiving a PREPARE with an absent or all-zero condition MUST reject it with
`F01_INVALID_PACKET`. There is no derived-preimage (HKDF) fallback on the peer wire — that path
is deleted, leaving one security model: a hop is paid only against a preimage it cannot forge.
(The prototype's **legacy** class — an absent or all-zero condition auto-fulfilled without
verification, recorded in
[`docs/local-delivery-fulfillment-contract.md`](../local-delivery-fulfillment-contract.md), now
superseded — has no counterpart here. `connector_domain::condition` defines presence as
"not all-zero" and treats an absent condition as invalid on **both** wires, so there is no
client-edge allowance left for this paragraph to carve out; a zero condition is refused at ingress
rather than needing a real one minted for it on the way out.)

A FULFILL's `fulfillment` MUST satisfy `sha256(fulfillment) == executionCondition` of the PREPARE
it answers. A connector MUST verify this on every FULFILL it relays upstream before treating the
packet as fulfilled for its own claim accounting (§3.2) — a hop that merely trusts its downstream
peer's word reintroduces exactly the forgeable-payment hole this rule closes.

### 3.2 A claim rides the next packet to that peer

Value is owed only on fulfilment ([ADR 0004](../adr/0004-value-moves-on-fulfilment.md)). When
connector A forwards a PREPARE to connector B and later receives a matching FULFILL from B, A now
owes B the PREPARE's `amount`. A does not open a new stream write for this alone; instead:

1. A's projection ([ADR 0005](../adr/0005-claims-are-truth-balances-are-a-projection.md)) folds
   the fulfilled `amount` into the cumulative it owes B on their shared channel, and marks a claim
   as **pending** for that channel.
2. The **next** frame A sends to B on this peering relation — whether a new PREPARE A is
   forwarding to B, or a FLUSH (§3.3) — MUST carry a claim: the channel id, the new cumulative
   amount, a nonce strictly greater than the last nonce A sent B on this channel, and A's
   signature over that tuple (chain-specific fields per §3.5).
3. Once B acknowledges the claim (CLAIM_ACK, §3.4), the "pending" mark clears. A fulfilment that
   occurs after step 2 was sent but before the CLAIM_ACK is received starts a new pending claim
   covering the newer cumulative; it is never conflated with the one already in flight, since each
   claim's nonce is one more than the last and its cumulative amount supersedes it.

This is the mechanism [ADR 0004](../adr/0004-value-moves-on-fulfilment.md) requires: "the claim
covering it follows the fulfilment rather than riding the outgoing PREPARE." Piggybacking costs
nothing under load — a claim is never a wire message on its own while traffic is flowing — but the
final packet of a burst is not covered until either another PREPARE goes out or the flush timer
(§3.3) fires.

Claims are **not batched**: a claim's cumulative amount MUST be updated (and the pending mark
re-armed) for every individual fulfilment, so B's exposure is one packet under normal flow
([ADR 0004](../adr/0004-value-moves-on-fulfilment.md), "Why not batched"; `CONTEXT.md`
"Exposure"). If two fulfilments complete before A has sent any frame to B, a single outbound claim
naturally covers both, since a claim is always the _latest_ cumulative state, not a running batch
A chose to accumulate — B's exposure in that narrow race is two packets rather than one, which is
the bound the flush interval (§3.3) exists to keep short, not a violation of "one claim per
packet."

### 3.3 Flush

If a claim is pending for a channel and no outbound frame to that peer occurs within the
peering relation's configured `flushIntervalMs`, the payer MUST send a FLUSH frame carrying only
the pending claim. FLUSH is the mechanism that covers the case traffic stops: without it, a
payer that fulfilled a peer's last packet of the day would leave that peer's exposure unclaimed
indefinitely. `flushIntervalMs` is the real bound on trailing exposure — it MUST be small enough
that a peer's tolerated exposure (its ceiling, §5.3) is not threatened by a payer that simply
stopped sending, and is configured per peering relation alongside the flat fee
([ADR 0010](../adr/0010-flat-per-packet-fee-and-minimum-delivery.md)) and the ceiling.

### 3.4 Claim acknowledgement and rejection

A CLAIM_ACK answers the claim most recently received on a PREPARE or FLUSH from that peer, with
one of:

- `accepted` — the claim's signature verified, its nonce strictly advanced the channel's
  watermark, and it did not decrease the cumulative amount.
- `rejected` — with a reason: `signature_invalid`, `nonce_not_advancing`, `amount_not_advancing`,
  or `unknown_channel`.

A `rejected` CLAIM_ACK does not reject the PREPARE the claim was piggybacked on — that PREPARE is
independently routed and answered as an ordinary ILPv4 packet. It does mean the payee now holds unclaimed exposure to
the payer it cannot account for; a connector SHOULD stop forwarding further PREPAREs to a peer
whose most recent claim was rejected until a valid claim restores the watermark (this is the same
mechanism as the ceiling in §5.3, applied to a payer that has become unable to pay rather than
merely over its limit).

### 3.5 Claim contents

A claim is chain-specific (`CONTEXT.md` "Claim", "Nonce", "Watermark"):

| Field              | evm                                         | solana                                     | mina (dropped, see [ADR 0002](../adr/0002-drop-mina-from-the-rust-connector.md)) |
| ------------------ | ------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| Channel identifier | `channelId` (bytes32)                       | `channelAccount` (program-derived address) | n/a — Mina is out of scope for the Rust peer wire                                |
| Nonce              | `uint64`                                    | `uint64`                                   | n/a                                                                              |
| Cumulative amount  | `uint64`                                    | `uint64`                                   | n/a                                                                              |
| Signature          | ECDSA over the EIP-712 balance-proof digest | Ed25519 over the balance-proof digest      | n/a                                                                              |

`lockedAmount` and `locksRoot` are removed from the claim and from the on-chain balance proof
(they were always zero — [ADR 0004](../adr/0004-value-moves-on-fulfilment.md)); in-flight exposure
is bounded by packet expiry, not collateralised on-chain. That removal describes the on-chain
contract this design calls for, not the one currently deployed: the live `TokenNetwork.sol`'s
`BalanceProof` typehash still declares both fields, so a digest that omits them does not match
what that contract's `ecrecover` checks. Until a redeployment drops them, they are still hashed as
zeros (see below).

**Implementation note (issue #575, [ADR 0024](../adr/0024-peer-wire-claims-sign-the-eip-712-balance-proof.md)):**
this table's `evm` row is normative and, as of this issue, matches what the code does — before it,
`crates/connector-runtime/src/claim.rs` signed and verified a connector-internal SHA-256 hash of
`channel_id ‖ nonce ‖ cumulative_amount` instead, a divergence from this section that was invisible
because nothing had ever redeemed a peer-wire claim on chain. `ClaimBook` now signs and verifies
through `connector_signer::evm_balance_proof_digest` — the same function the client edge already
used (issue #506) — over exactly the fields the deployed `TokenNetwork.sol` typehash requires,
`lockedAmount`/`locksRoot` included, hashed as zeros. The Solana row remains aspirational: the peer
wire has no Ed25519 claim path yet.

**Recovery id (issue #590):** an `evm` claim's signature is 65 bytes, `r (32) ‖ s (32) ‖ v (1)`. The
wire carries `v` exactly as libsecp256k1 emits it — `{0, 1}` — never the Ethereum-wallet `{27, 28}`
convention; `WireClaim::encode`/`decode` round-trip that byte unchanged, and nothing on the peer wire
adds 27 to it. `TokenNetwork.claimFromChannel`'s `ECDSA.recover` accepts only `{27, 28}`, so
`EvmSettlementBackend::redeem` is the one place that conversion happens, immediately before
submission — idempotent (a value already in `{27, 28}` passes through unchanged) and refusing
anything outside both ranges with a named error rather than submitting it to revert on chain. A
verifier checking a claim's signature off the wire (`recover_evm_signer`, used by both the peer wire
and the client edge) accepts either convention, since it never submits on chain and so has no reason
to prefer one.

### 3.6 Relationship to application-level claims (e.g. rolling-swap)

The peer-wire claim in this section is the connector's own per-hop claim — the "leg A" claim in
the rolling-swap terminology used when investigating this timing change (issue #410, closed; its
findings were carried forward as input to this ticket, issue #412). That investigation found no
dependency from `@toon-protocol/settlement-digest` on claim/fulfilment ordering (every one of its
functions is a hash or signature recovery over a fixed tuple, and `RollingSwapChannel.sol`'s
`updateBalance` checks only monotonic nonce and amount — nothing in it encodes when a claim was
made), so this section's reversal — claim-after-fulfilment instead of claim-with-PREPARE — requires
no change to that digest and is free to make on those terms. It also found that a **separate**,
application-level claim (the rolling-swap "leg B" claim, carried inside a PREPARE's opaque `data`
by the `swap` application, never inspected by the connector) is deliberately signed _before_ the
coupled packet's outcome is known, because rule R5 of the rolling-swap protocol requires the sender
to verify that claim before revealing a preimage — that ordering is structural to the protocol's
value-atomicity and is out of scope here. The two are not, however, wholly independent: leg A's
claim today rides the PREPARE via the connector's own per-packet claim path, which is precisely
what this section reverses. The rolling-swap residual exposure (`δ·W`) therefore **shifts** under
this section rather than being unaffected — narrowing the window in which leg-A exposure can be
banked without an unfulfilled leg-B counterpart — probably in the sender's favour, though this was
not proven quantitatively. That shift was flagged as expected and non-blocking when `swap` adopts
the Rust fleet (it only does so at issue #431), not a defect in this spec.

## 4. Fee and minimum-delivery fields

Per [ADR 0010](../adr/0010-flat-per-packet-fee-and-minimum-delivery.md), every peering relation
has a flat fee, agreed bilaterally as configuration — not renegotiated per packet. It is not a
PREPARE field; it is realized on the wire as the difference between the `amount` a connector
receives on the inbound PREPARE and the (possibly smaller) `amount` it forwards on the outbound
one, and is what falls out of the claim exchange (§3) once packets fulfil — a hop's earnings are
the difference between the cumulative it receives from upstream and the cumulative it sends
downstream. No separate fee accounting is needed on the peer wire beyond the claims themselves.

`minimumDelivery` (`uint64`) IS a PREPARE field, declared once by the original sender and
unchanged by every intermediate hop:

- On receiving a PREPARE with `amount = A` and `minimumDelivery = M`, a connector computes its
  outgoing amount `A' = A - fee` (its own configured fee for the outbound peering relation).
- If `A' < M`, the connector MUST reject with `R01_INSUFFICIENT_SOURCE_AMOUNT` rather than
  forward a packet it already knows cannot meet the declared minimum — it never forwards a
  smaller delivery hoping a downstream hop makes up the difference, because no downstream hop
  ever increases an amount.
- Otherwise it forwards a PREPARE with `amount = A'` and `minimumDelivery = M` unchanged.

Because every hop enforces the same inequality against the same unchanged `M`, a PREPARE that
survives every hop is guaranteed to deliver at least `M` at the destination — this is checkable
locally at each hop with no knowledge of the rest of the path, and requires no field beyond the
one `minimumDelivery` the sender set.

## 5. Reject codes and the accumulated-cost field

### 5.1 Codes in use on the peer wire

Peer-wire REJECTs use the existing RFC-0027 §3.3 codes:

| Code              | Meaning here                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `F00`             | A terminated envelope's `target` attempted to escape the route's handler path (issue #596).                                                       |
| `F01`             | Malformed frame or packet; absent/all-zero `executionCondition` (§3.1).                                                                           |
| `F02`             | No route to `destination`.                                                                                                                        |
| `F03`             | The PREPARE resolved to one of this connector's own priced terminated routes, but `amount` did not cover that route's `price` (§5.4, issue #752). |
| `F08`             | Duplicate packet (replay of a `correlationId` already answered).                                                                                  |
| `R00`             | PREPARE expired before it could be forwarded or answered.                                                                                         |
| `R01`             | This hop cannot meet the declared `minimumDelivery` after its fee (§4).                                                                           |
| `R02`             | `expiresAt` leaves insufficient time for this hop to forward and get a reply.                                                                     |
| `T00`             | Internal error at this connector (retryable).                                                                                                     |
| `T01`             | The configured next-hop peer is unreachable (stream down).                                                                                        |
| `T04`             | This connector's exposure ceiling for the inbound peer is exceeded (§5.3).                                                                        |
| `F99`/`T99`/`R99` | Application-level reject from the terminating app, passed through unchanged.                                                                      |

`F06_UNEXPECTED_PAYMENT`, previously used to reject a PREPARE arriving without an inline claim
under the prepay model, has no peer-wire use: PREPAREs never carry claims now (§3.2), so there is
nothing to gate at PREPARE time. A payer that cannot be trusted to pay is handled at the claim
layer (§3.4), not the packet layer.

### 5.2 Accumulated cost

Every REJECT frame carries `accumulatedCost` (`uint64`): the running total of what the packet's
path has charged so far, per [ADR 0011](../adr/0011-rejects-accumulate-fees-and-probes-discover-cost.md)
and issue #523 -- the fees of the hops the packet actually passed through, plus the price of the
route that terminated it, if it reached one. The field starts at `0`:

- When a connector **originates** a REJECT for a reason that added no value to the packet at all
  (no route, expired, ceiling exceeded, cannot meet minimum delivery, an underpriced peer-wire
  arrival at a priced terminated route (§5.4, issue #752), the terminating app itself unreachable,
  or an envelope target that attempted to escape the route's handler path), it sets
  `accumulatedCost = 0` on the REJECT it sends upstream — it never forwarded or terminated this
  packet, so nothing applies to a hop it never used. An app that could not be reached (`T01`) is
  the termination-side mirror of a forwarding hop that cannot reach its own peer: no priced work
  was done, so no price is added. A refused target (`F00`, issue #596) is the same reasoning one
  step earlier — the app was never even called, so nothing accumulates. An underpriced peer-wire
  arrival is the same reasoning again, one step earlier still: the app is never even consulted, so
  the route's price is not owed by a payer who was never even asked to cover it.
- When a connector **originates** a REJECT because the packet reached one of its own terminated
  routes and was rejected there (an application-level reject from the terminating app, or a
  fulfillment that didn't match the execution condition), it sets `accumulatedCost` to that
  route's configured price (`0` if the route is explicitly free) — the packet did reach a
  termination, and that termination's price is what a probe exists to discover, independent of
  whether the app happened to accept or decline this particular attempt.
- When a connector **relays** a REJECT it received from its own next hop back to its own upstream
  peer, it MUST add its own configured fee for the (already-successful) forward it made of the
  corresponding PREPARE, before sending the REJECT upstream: `accumulatedCost' = accumulatedCost +
thisHopFee`.

The sender therefore receives, on any REJECT for any reason, the sum of the fees of every hop
that successfully forwarded the packet plus the price of the route it reached, before it stopped
— this is strictly more information for strictly less protocol than a dedicated quoting message,
and is why a **probe** (a packet sent expecting rejection, `CONTEXT.md` "Probe") needs no protocol
of its own: it is an ordinary PREPARE whose reject reveals the real, current cost of the path it
actually traversed.

Never include a per-hop breakdown, and never split the total between fees and price — only the
sum. `accumulatedCost` leaks total path cost, not topology or any individual hop's or route's
pricing ([ADR 0011](../adr/0011-rejects-accumulate-fees-and-probes-discover-cost.md)).

All three bullets describe the Rust connector as it stands: issue #520 landed the price on a
terminated route and issue #545 wired it into the REJECT path, so a REJECT raised at a termination
now carries that route's configured price rather than the `0` this section previously had to
describe as forward-looking.

### 5.3 Ceiling enforcement

A connector tracks, per peering relation, the exposure it has extended (fulfilled but not yet
covered by an acknowledged claim, §3.2–§3.4). A PREPARE that would push that exposure over the
relation's configured ceiling MUST be rejected with `T04_INSUFFICIENT_LIQUIDITY` — retryable,
since the condition clears once the payer's pending claim is acknowledged (`CONTEXT.md`
"Ceiling").

### 5.4 A priced termination reached over the peer wire requires enough value to cover it

Issue #752 closes the second gap [ADR 0028](../adr/0028-a-forwarded-route-is-priced-at-the-client-edge.md)
left open: a connector whose priced _terminated_ route was reached over the peer wire used to serve
it without charging anything, since only the client edge checked a route's price. When a peer-role
PREPARE resolves to one of this connector's own terminated routes and that route's `price` is
greater than zero, the connector MUST check `amount >= price` **before** opening the wrap or
consulting the app. If `amount < price`, it MUST reject with `F03_INVALID_AMOUNT` and
`accumulatedCost = 0` (§5.2 — no priced work was done) without ever calling the app. `price = 0`
(an operator's deliberate free termination, [ADR 0020](../adr/0020-a-price-is-flat-and-attaches-to-a-handler.md))
never triggers this check.

This is a per-packet check answered from the amount already on the PREPARE, not a relation-wide
throttle — it needs no new state, leaves the claim exchange (§3.2–§3.4) and the exposure ceiling
(§5.3, `T04`) exactly as they were, and requires no x402 greeting or negotiation
(`peer-carriage-spec.md` §3.1 stands: a peer-role PREPARE is never greeted). It composes with the
existing mechanisms rather than replacing any of them: an arrival that clears this check is
delivered, and on fulfilment its full `amount` — never less than `price` by construction — becomes
the exposure the sending peer owes this connector (§3.2), so the ordinary claim exchange that later
covers that exposure is guaranteed to cover at least this route's price too. A peer that never
advances a claim, or advances one by less than it owes, is still bounded by the pre-existing ceiling
and claim-ack rules (§3.4, §5.3) exactly as before — this section only ensures that what accrues as
exposure in the first place was never less than the route's own price.

## 6. Consistency

This specification uses exactly the vocabulary of `CONTEXT.md` (connector, app, packet, route,
peer wire, client edge, claim, nonce, watermark, exposure, ceiling, flush, in flight, projection,
settlement, fee, minimum delivery, probe) and implements
[ADR 0003](../adr/0003-clean-room-peer-wire-versioned-client-edge.md),
[ADR 0004](../adr/0004-value-moves-on-fulfilment.md),
[ADR 0005](../adr/0005-claims-are-truth-balances-are-a-projection.md),
[ADR 0010](../adr/0010-flat-per-packet-fee-and-minimum-delivery.md) and
[ADR 0011](../adr/0011-rejects-accumulate-fees-and-probes-discover-cost.md). It intentionally does
not reuse "terminator", "BLS" or "agent runtime" (all deprecated) and does not reintroduce
`lockedAmount`, `locksRoot`, a quoting protocol, or the derived-preimage condition path.
