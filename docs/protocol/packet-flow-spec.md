# Packet flow

**Status:** **Normative for its numbered rules.** Absorbs `peer-semantics-pre-868.md` §4 (fee) and
§3.1 (a real execution condition), which were the live remnants of a document frozen as history by
issue #1065, and states the routing and reject rules that had never been written in one place.
PF-14 – PF-17 are amended or retired by
[ADR 0057](../adr/0057-minimum-delivery-is-retired-a-claim-bounds-erosion.md) (issue #1143); the
rule numbers are kept and never reused.

**Coverage:** none of PF-01 – PF-24 is vectored. This is a wire surface, so these rules enter
[ADR 0045](../adr/0045-a-behavioural-rule-is-normative-prose-until-its-vector-lands.md)'s debt ledger;
issue #1084 owns the burn-down order.

**Vocabulary:** [`CONTEXT.md`](../../CONTEXT.md). MUST, MUST NOT, SHOULD, MAY per RFC 2119.

---

## 1. Eligibility

**PF-01** `[connector]` — A packet MUST carry a **real** execution condition. A zero or absent
condition is refused before any route is selected, any fee taken, or any app touched. There is no
zero-condition path anywhere in this protocol.

**PF-02** `[connector]` — A packet whose expiry has already passed MUST be refused before routing.

---

## 2. Routing

**PF-03** `[connector]` — A destination is matched by **longest prefix**, and matching is
**label-aware**: a prefix `p` governs a destination when the destination is exactly `p`, or begins
with `p` followed by a dot. `g.example` MUST NOT match `g.exampleX`; `g.toon.rel` MUST NOT match
`g.toon.relay`. ILP addresses are dot-separated labels and matching respects that.

**PF-04** `[connector]` — Where prefixes are of equal length, **route kind** breaks the tie, in this
order, highest first:

| rank | kind             | written by                         |
| ---- | ---------------- | ---------------------------------- |
| 3    | terminated route | operator, configuration            |
| 2    | forwarded route  | operator, configuration            |
| 1    | runtime route    | operator, at runtime               |
| 0    | leased route     | controller, expires unless renewed |

**PF-05** `[connector]` — **Length dominates kind.** A longer leased prefix beats a shorter
configured one. This is deliberate: a controller refining a route is the normal case, and a broad
configured route that swallowed every lease beneath it would make leases unusable.
([ADR 0048](../adr/0048-routing-precedence-is-length-then-rank-and-a-lease-cannot-capture-a-termination.md))

**PF-06** `[connector]` — **Except that a leased route MUST NOT out-specify a terminated route's
subtree.** Refinement of _forwarding_ is a controller's job; capture of a _termination_ is not.

> A lease out-specifying a forwarded route changes which peer carries a packet — recoverable, and the
> decision leases exist to make. A lease out-specifying a **terminated** route changes whether the
> packet reaches the operator's own app at all, on a destination whose price a client already paid at
> this edge ([ADR 0028](../adr/0028-a-forwarded-route-is-priced-at-the-client-edge.md)) and whose
> fulfilment the terminating connector derives ([ADR 0019](../adr/0019-a-terminating-connector-derives-the-fulfilment.md)).
> It sells work the app was paid for and does not perform.

**PF-07** `[connector]` — An expired lease MUST NOT compete. Expiry is how a route to an unreachable
peer stops being used.

**PF-08** `[connector]` — A destination matching no route MUST be refused `F02`, naming the
destination.

### 2.1 Client sessions

**PF-09** `[connector]` — A **client destination** — an address resolving to a live client session — is
**not** part of the route ordering. It is an exact-address lookup, and an exact match is by
construction the longest match there is.

**PF-10** `[connector]` — A destination matching both a live client session and a **terminated** route
MUST be refused as **this connector's own configuration error**, not as a verdict on the packet.
Neither "the app silently wins" nor "the session silently wins" is safe.
([ADR 0032](../adr/0032-a-client-destination-is-never-a-route-termination.md))

**PF-11** `[connector]` — Otherwise the route table answers first, and a session receives only what the
route table could not place — strictly an `F02`. A matched forwarded route can therefore never fall
through to a session, so there is no silent substitution of destination.

---

## 3. Forwarding

**PF-12** `[connector]` — A hop charges a **flat fee per packet** for one peering relation, agreed
bilaterally as configuration and never renegotiated per packet. It is not a PREPARE field: it is
realised as the difference between the amount received and the amount forwarded.
([ADR 0010](../adr/0010-flat-per-packet-fee-and-minimum-delivery.md))

**PF-13** `[connector]` — A hop MUST NOT increase an amount while forwarding.

**PF-14** `[connector]` — Given an inbound amount `A` and this hop's fee `f`, the outgoing amount is
`A' = A − f`. A hop whose fee alone exceeds `A` MUST reject **`F03`**, stating both figures, rather
than forwarding what is left. **The declared floor this rule used to check is retired**: there is no
`M`, and `R01` is not emitted.
([ADR 0010](../adr/0010-flat-per-packet-fee-and-minimum-delivery.md),
[ADR 0057](../adr/0057-minimum-delivery-is-retired-a-claim-bounds-erosion.md))

**PF-15** `[connector]` — **Retired**, and replaced by the claim rather than restated. What bounds
erosion across a path is that each crossing is covered: a hop mints its covering claim for the
packet's own **forwarded** value, so it holds a claim for at least what it passes on and its fee is
the difference. That property chains, which is the end-to-end guarantee the retired inequality was
reaching for — enforced with money rather than with a field every hop is trusted to honour.
([ADR 0042](../adr/0042-a-packet-carries-its-claim.md),
[ADR 0057](../adr/0057-minimum-delivery-is-retired-a-claim-bounds-erosion.md))

**PF-16** `[client]` — **Retired.** No packet declares a minimum delivery, so there is no peer-path
field for a client to be excluded from. A sender's protection is now uniform whatever it is: the
**price** it paid ([ADR 0028](../adr/0028-a-forwarded-route-is-priced-at-the-client-edge.md)) and
the claim covering each crossing.
([ADR 0057](../adr/0057-minimum-delivery-is-retired-a-claim-bounds-erosion.md))

**PF-17** `[connector]` — **Retired.** There is no minimum-delivery field, on either carriage, for
any role to honour or ignore. Nothing replaces this rule: it existed only to say what a client's
copy of a peer field bought, and the field is gone.
([ADR 0057](../adr/0057-minimum-delivery-is-retired-a-claim-bounds-erosion.md))

**PF-18** `[connector]` — A packet exceeding the peering's **cap** MUST be refused `T04`, **never
carried and never split**, and the reject's message MUST state the current cap. The cap bounds one
packet, never an accumulation.
([ADR 0049](../adr/0049-the-cap-bounds-one-packet-is-discovered-by-t04-and-is-set-from-outside.md))

**PF-19** `[connector]` — A hop MUST decrease a packet's expiry when forwarding, by enough that a
fulfilment arriving in time downstream can still be delivered upstream before its own expiry fires.

---

## 4. Termination

**PF-20** `[connector]` — A payload is **opaque in carriage** and readable only at a route termination.
Opacity is a property of the packet, not a rule each hop is trusted to keep: the payload is sealed to
the terminating connector's identity, and no hop between can open it.
([ADR 0016](../adr/0016-payload-opacity-is-a-property-of-carriage.md), [ADR 0018](../adr/0018-a-payload-is-sealed-to-the-terminating-connector.md))

**PF-21** `[connector]` — An envelope's **target** MUST resolve _beneath_ the route's configured
handler path, never in place of it. A packet can address more of an app than one entry point, and can
never reach a neighbouring route to buy its work at this route's price.
([ADR 0025](../adr/0025-an-envelope-target-is-confined-beneath-the-handler-path.md))

**PF-22** `[connector]` — A terminating connector **derives** the fulfilment it is paid against, from
the secret the packet's wrap carried. It does not accept one from the app.
([ADR 0019](../adr/0019-a-terminating-connector-derives-the-fulfilment.md))

**PF-23** `[connector]` — **An app's `404` is not a reject.** It arrives as an answer and rides home on
a **FULFILL**: the app answered, and the answer is what was paid for. Only an app that is _unreachable_
(`T01`) or that _refuses the envelope's target_ (`F00`) produces a reject.

> This is the rule most likely to be got wrong by a second implementer, because turning an error status
> into a reject looks like the honest thing to do. It refunds work that was performed.

**PF-24** `[connector]` — A reject raised **at** a termination is sealed back to the sender — unless
that termination never recovered the shared secret, in which case it is plaintext and carries **where
to ask** for the identity. **Sealed identifies the destination; unsealed identifies nobody.**
([ADR 0054](../adr/0054-an-unsealed-termination-reject-answers-where-to-ask.md))

---

## 5. Rejects

Which code answers which situation, and how much of it binds, is
[ADR 0051](../adr/0051-a-reject-code-binds-where-a-sender-must-act-differently.md): **a code binds
where a sender can act differently on it than on its class alone, and only there.**

**Binding** — `F00` fix your envelope's target · `F02` this path is wrong · `F03` pay the stated
amount (the route's price, or this hop's own fee) · `F06` attach a claim · `F99` stop trusting that
counterparty · `T04` send smaller. **`R01` has left the vocabulary**
([ADR 0057](../adr/0057-minimum-delivery-is-retired-a-claim-bounds-erosion.md)): with no floor to
declare, "lower the floor" is not a move a sender has.

**Class-only** — `F01` (malformed packet) · `R00` (expired) · `T00` (this connector's own
configuration error) · `T01` (app or peer unreachable) · `T05` (rate limited).

A reject carries the **accumulated cost of the path it travelled** — the sum only, never the per-hop
breakdown and never the split between fees and price
([ADR 0011](../adr/0011-rejects-accumulate-fees-and-probes-discover-cost.md)). That is what makes a
**probe** work: a packet sent expecting a reject, in order to learn from it what the path costs.

---

## 6. Consistency

Uses exactly the vocabulary of [`CONTEXT.md`](../../CONTEXT.md) and implements
[ADR 0010](../adr/0010-flat-per-packet-fee-and-minimum-delivery.md),
[0011](../adr/0011-rejects-accumulate-fees-and-probes-discover-cost.md),
[0016](../adr/0016-payload-opacity-is-a-property-of-carriage.md),
[0018](../adr/0018-a-payload-is-sealed-to-the-terminating-connector.md),
[0019](../adr/0019-a-terminating-connector-derives-the-fulfilment.md),
[0025](../adr/0025-an-envelope-target-is-confined-beneath-the-handler-path.md),
[0032](../adr/0032-a-client-destination-is-never-a-route-termination.md),
[0048](../adr/0048-routing-precedence-is-length-then-rank-and-a-lease-cannot-capture-a-termination.md),
[0049](../adr/0049-the-cap-bounds-one-packet-is-discovered-by-t04-and-is-set-from-outside.md),
[0051](../adr/0051-a-reject-code-binds-where-a-sender-must-act-differently.md),
[0054](../adr/0054-an-unsealed-termination-reject-answers-where-to-ask.md) and
[0057](../adr/0057-minimum-delivery-is-retired-a-claim-bounds-erosion.md).

**Not yet built:** PF-06's terminated-subtree protection (#1078) and PF-24's URL (#1083). PF-18's cap
is live; its runtime settability is #1079.
