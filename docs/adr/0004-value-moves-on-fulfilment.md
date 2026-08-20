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
