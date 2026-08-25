# Value moves on fulfilment, one claim per packet

**Status:** Partly superseded by [0042](0042-a-packet-carries-its-claim.md). The headline — "value moves on fulfilment and only on fulfilment" — is retired. **One claim per packet, never batched, and dead `lockedAmount`/`locksRoot`, are Accepted and still binding.** Its trailing-claim mechanism was inverted by [0031](0031-a-peer-prepare-arrives-with-its-covering-claim-or-it-is-greeted.md), itself superseded by 0042; the flush timer and exposure ceiling it reasons with are retired by [0033](0033-the-exposure-machinery-is-retired-not-restated.md).

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

> **The headline is superseded by [ADR 0042](0042-a-packet-carries-its-claim.md).** "Value moves on
> fulfilment and only on fulfilment" conflated two questions — _when is value owed_ and _what proves
> delivery_ — and answered both with the fulfilment. ADR 0042 keeps only the second: a packet
> carries its own claim, and a fulfilment is a delivery receipt. **What survives here is unchanged
> and still binding: one claim per packet, never batched, and `lockedAmount`/`locksRoot` stay
> dead.** The argument below against prepay is not retracted — ADR 0042 accepts it and bounds it
> with a per-peer packet cap rather than answering it.

A packet's value is owed only when the packet fulfils. The claim covering it follows the
fulfilment rather than riding the outgoing PREPARE, which reverses the existing prepay model
in which the payer paid for the forward _attempt_. Claims remain one per packet: they are not
batched.

> **The peer path is inverted by
> [ADR 0031](0031-a-peer-prepare-arrives-with-its-covering-claim-or-it-is-greeted.md)** (owner
> decision, 2026-08-07, issue #868). On the peer wire a PREPARE now arrives **with** its covering
> claim or it is refused with the x402 greeting, and the credit window this ADR's trailing-claim
> mechanism creates is retired. Everything else here stands: value moves on fulfilment, one claim
> per packet, no batching, `lockedAmount`/`locksRoot` stay dead. The reasoning below for why the
> claim trailed the fulfilment is **superseded, not wrong** — it was correct for a world in which
> a forwarding hop had no way to sign a claim for a packet it had not yet been paid for (issue
> #866 is what supplies one).

## Why the reversal

The old model is documented as deliberate in
`docs/local-delivery-fulfillment-contract.md § Reject semantics`, and its argument is sound on
its own terms: the receiving connector is never exposed to an unpaid forward, and a claim
already handed over cannot be voided unilaterally. But the second point is circular — the claim
is unvoidable _because_ it was sent before the outcome was known.

The decisive problem is that prepaying makes the execution condition economically inert. The
peer wire is trustless by default: a hop should be paid only against a preimage it cannot
forge. Under prepay, a hostile next hop takes the claim and rejects the packet, and the
condition prevents only a lie that would gain it nothing it does not already hold. Trustless
forwarding and prepayment cannot both be true.

## Why not batched

Claims are cumulative — each supersedes the last, and only the highest-nonce claim is ever
submitted on-chain — so one claim could cover a hundred packets with an identical on-chain
result and roughly a hundredth of the signing and verification work. That saving was declined
deliberately.

Batching converts the payee's exposure from one packet into one window: between claims, the
payee has forwarded value it holds no signature for, and a payer that vanishes in that window
takes the difference. One claim per packet keeps that exposure at the smallest unit the system
can express, and the signature cost is not the constraint we are trying to relieve — the
architecture is. If per-packet signing later proves to be the throughput ceiling, batching is
reintroducible as a per-peer policy without changing what a claim is.

## Consequences

An ECDSA verify on the inbound claim and a sign on the outbound one sit on the hot path of
every packet at every hop. That is the dominant per-packet CPU cost and should be measured
early rather than assumed acceptable; it parallelises across cores cleanly, since each peering
relation's claims are independent.

The claim now travels after the fulfilment, which the peer wire spec must account for. Sending
it as its own message costs an extra round trip per packet; piggybacking it on the next PREPARE
to that peer costs nothing under load but leaves the final packet of a burst uncovered until a
flush timer fires. The spec needs both mechanisms, and the flush interval becomes the real
bound on trailing exposure.

Benign application-level rejects — a swap node rejecting for staleness or liquidity, a leg-B
failure — stop costing the payer. That behaviour was previously called out as intentional; it
is now simply gone.

`lockedAmount` and `locksRoot` stay dead and are removed from the balance proof and the
on-chain contract. In-flight exposure is bounded by packet expiry rather than collateralised
and arbitrated on-chain.

## Update (issue #1145) — this record's model no longer runs anywhere

The banners above say the headline is retired and the peer path inverted. Both were true of the
_record_ and only partly true of the tree: until issue #1145 the mechanism this ADR describes was
still what actually paid for a forward whenever a peering had no `[[pay_channels]]` row —
`Connector::cover_forward` answered `NotConfigured`, `ClaimBook::record_fulfillment` signed a claim
once the forward fulfilled, and `pending_claim` put it on the next PREPARE to that peer.
[ADR 0042](0042-a-packet-carries-its-claim.md) said so plainly ("Until those land, forwarding runs
0004's model end to end"), and no committed config anywhere wrote such a row except
`local/two-hop`'s payer.

**That code is deleted.** A forward is covered before it is sent or it is not sent: `cover_forward`
has no not-configured arm, nothing arms a peer-role pending claim, and `Config::load` refuses a
peering a `[[routes]]` entry forwards to with no `[[pay_channels]]` row
(`ConfigError::PayChannelUnbound`). `Connector::sweep_flush` and `ClaimBook::due_for_flush` — the
FLUSH sweep this record's Consequences call "the real bound on trailing exposure" — go with it:
nothing can arm a claim for them to sweep, and there is no trailing exposure to bound, because
nothing is ever owed between packets.

**What survives here is exactly what the Status line already said survives**, and it survives
untouched: **one claim per packet, never batched**, and `lockedAmount`/`locksRoot` stay dead. The
"Why not batched" section is unaffected by any of this — under 0042 a packet carries its own claim,
which is the same one-claim-per-packet rule reached from the other side.

`ClaimBook::record_fulfillment` itself is still in the tree, and its survival is not a survival of
this model. It is wrapped by `ClientPayoutLedger` for an unrelated live feature — this connector
paying a **client** back for work it did ([ADR 0026](0026-client-btp-rides-the-client-edge-peers-stay-on-the-peer-wire.md),
issues #699/#770/#779) — where "sign a fresh cumulative claim and arm it pending" is the right
shape and no packet is being forwarded at all. The peer role no longer calls it.
