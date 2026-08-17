# A packet carries its claim

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

Every packet carries the claim that pays for it. A PREPARE arrives at a connector with a covering
claim or it is refused, whether that connector will forward it or terminate it; and a connector
covers every PREPARE it sends. A **fulfilment proves that the intended receiver got the packet**
and nothing else — it is a delivery receipt, not a payment trigger. Value in flight is therefore
at risk, and bounding that risk is the **sender's** business rather than the protocol's: small
packets, and larger ones only on a path that has earned them.

## What this supersedes

**[ADR 0004](0004-value-moves-on-fulfilment.md)'s headline is retired.** "Value moves on fulfilment
and only on fulfilment" conflated two questions — _when is value owed_ and _what proves delivery_ —
and answered both with the fulfilment. This record keeps only the second. What survives from 0004 is
untouched: **one claim per packet, never batched**, and `lockedAmount`/`locksRoot` stay dead.

**[ADR 0031](0031-a-peer-prepare-arrives-with-its-covering-claim-or-it-is-greeted.md) is superseded
entirely**, not amended. It stated this rule for the peer role alone, and every clause of its
Decision was false of the shipped binary: an uncovered arrival was refused only at a _priced
termination_ (a forwarded destination prices at `0` and is admitted free); no connector has ever
covered a PREPARE it sends, because issue #881's proactive covering was never wired to config;
`ClaimEnforcement::Observe` is an escape hatch it claimed did not exist; and the credit window it
declared "gone as an operating mode" is the only mode that runs. Four false clauses is past the
point where amendment banners help a reader.

**[ADR 0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md) loses one inherited
property.** Its "understating a fee is unprofitable — honesty needs no enforcement" was reasoned
from ADR 0004's postpay: a hop advertising a low fee and then rejecting earned nothing. Under this
record it banks the claim instead, so fee honesty becomes bounded rather than self-enforcing — by
packet size and by the cap below. ADR 0011 carries the amendment; nothing else in it changes, probe
economics included.

## The trade this makes, and does not hide

ADR 0004 rejected prepay on a specific argument: prepayment makes the execution condition
economically inert, because "a hostile next hop takes the claim and rejects the packet… Trustless
forwarding and prepayment cannot both be true."

**That argument is correct, and this record overrides it deliberately.** ADR 0031 asserted the
argument "remains sound and is not disturbed here" while doing precisely the thing it forbids; the
inversion was real and went unstated. Stating it: under this record the condition stops being an
economic guarantee and becomes a delivery proof. A hop can take a claim and refuse to carry.

What answers the objection is not a protocol guarantee but two bounds, and Interledger has always
worked this way:

- **A per-peer cap** on the amount carried in one packet (below), which is the most a single theft
  can take.
- **The sender's own packet sizing.** RFC 0018: smaller payments carry proportionally less risk —
  "in ILPv4, this is the default." RFC 0027 designs for "large volumes of low-value packets."

RFC 0027 does not say when ledger value moves relative to the packet — "payment channels are only
used for funding and rebalancing… not directly part of the ILPv4 packet flow" — so both this record
and ADR 0004 were always protocol-legal. This is a local choice, made because a peering may have
been **bought** ([ADR 0037](0037-a-purchased-peering-is-a-terminated-route-whose-work-is-a-table-write.md))
and a counterparty that selected itself is owed no credit.

## The cap

**Every peering carries a maximum amount this connector will forward to it in one packet.** A packet
needing more is refused with `T04` — never carried, never split. The cap is how far a connector
trusts a peer, expressed as the most it is willing to lose at once: a peering that has just been
bought starts at the floor; a path that keeps fulfilling earns a larger one.

It has a default, so an operator who never configures one is still bounded — the same convention
[ADR 0039](0039-abuse-bounds-on-a-purchased-peering-refuse-not-refund.md) uses for purchase bounds.

This is not [ADR 0033](0033-the-exposure-machinery-is-retired-not-restated.md)'s ceiling returning.
That bounded an _accumulation_, and under this record no accumulation exists — a packet carries its
own claim, so nothing is ever owed between packets. The cap bounds **one packet**. ADR 0033 stands
as written, and its premise (that a covering claim bounds every peering) becomes true for the first
time once the work below lands.

## What must be true for this record to be true

None of this ships today. Listed in the order it must be built:

1. **Require a covering claim on forwarded arrivals.** The price gate filters on
   `ClientRouteKind::Terminated`, so a packet this connector forwards onward is carried for free.
2. **The cap, refused with `T04`, with a default.** Before the next item, not after: turning on
   covering while a stranger can buy into the routing table means prepaying a counterparty that
   chose _you_.
3. **Wire issue #881 — the send half.** Proactive covering exists in the runtime and is exercised by
   tests, but no production path populates `outbound_client_hops`. Until it does, this record is
   aspirational and should be read as such.
4. **Resolve `ClaimEnforcement::Observe`** — honour its 2026-11-01 sunset, or record that the escape
   hatch is permanent.

Until (3) lands the connector runs ADR 0004's model end to end for forwarding, which is coherent and
RFC-shaped; it is simply not this record. **Three documents already assert otherwise** — ADR 0031's
Decision, ADR 0033's premise, and `docs/protocol/money-model.md`'s "current behaviour" banner. This
record does not become a fourth: it says plainly that it describes the target.

## Consequences

**The app is never a hop.** Claims ride client-to-connector and connector-to-connector links only.
The app holds no channel, settles nothing, and is handed ordinary HTTP that was already paid for.

**Trust buys packet size, never deferred payment.** A well-trodden path earns a larger cap. It never
earns the right to owe — batching and credit windows stay retired, because that is what would put an
accumulation back.

**A signature sits on the hot path of every packet at every hop**, as ADR 0004 already noted. That
cost is now permanent rather than provisional, and is the price of extending no credit to a
counterparty that may have bought its way in.
