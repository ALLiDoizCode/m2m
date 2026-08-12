# A price is flat, attaches to a handler, and buys an answer

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

A price is flat per packet, as a fee is. Pricing granularity is handler granularity: one handler,
one price, and an app that wants to charge differently exposes more handlers. The app is told
nothing about the payment that bought its work. A price accumulates into a reject's running total
alongside fees. And value moves whenever the app answered — whatever it answered.

## Context

The Rust connector cannot charge for a termination at all. `StaticRoute` is a prefix and a handler
URL and nothing else (`crates/connector-config/src/route.rs:60`), and the word `price` appears in
`crates/` only in a comment saying "unpriced". Pay-to-write is not unenforced here, it is
unrepresentable.

Pricing the work at a termination looks as though it must be content-sensitive. The relay prices
`basePricePerByte × bytes` with per-kind overrides. But the connector must never learn what a Nostr
kind is (ADR 0006), and the app is payment-oblivious, so it cannot price either. The prototype
resolved this by not resolving it: its route carried a flat price of `1000` and never consulted the
relay's pricing engine.

## Decision

**A price is flat per packet**, exactly as a fee is (ADR 0010). It does not vary with the payload.

**Pricing granularity is handler granularity.** One handler, one price. An app that wants to charge
differently for different work exposes a handler for each, and the operator publishes a route per
handler. The distinction lives in the address space, not in the packet — which is how a connector
prices without ever interpreting what it carries. `Config::load` refuses two differently-priced
routes pointing at one handler, since an app provably cannot tell them apart and the cheaper price
would always win.

**The app is told nothing about the payment that brought the packet to it** — not who paid, not
how much, not on what chain, and not even which destination was addressed. Not the payer or the
chain: ADR 0017 found both wrong by construction, not merely omittable — `X-TOON-Payer` names the
immediate previous hop rather than the payer on any path longer than one hop, and `X-TOON-Chain`
can carry a payer-supplied value that an app trusts as connector-asserted. Not the amount: that is
this decision's own consequence rather than a separate one — an app that wants to charge
differently for different work already gets that by exposing a different handler, so an amount
header would tell it only what its own route's price already says. Not the destination: the ILP
address routing consumed to reach this handler never travels with the delivery, which is distinct
from the HTTP method and target inside the sealed envelope — exactly what the connector makes of
the app (ADR 0018). Whatever arrives at a handler was paid for, at that handler's one price, and
that is the only fact the app gets.

**A price accumulates into a reject's running total**, alongside the fees of the hops that carried
it, so a probe discovers what a path costs end to end (ADR 0011). Today only the forwarding path
accumulates (`connector.rs:719`) and every reject raised at a termination hardcodes zero. The field
is renamed `accumulated_fee` → `accumulated_cost`; it does not ride the OER encoding, so the rename
is internal. `CONTEXT.md` gains **Cost** for the sum — what a caller must send, and the only figure
ever returned.

**Value moves whenever the app answered**, whatever it answered. An HTTP status is envelope content,
never a packet outcome: a 404 rides home inside a response envelope on a FULFILL. Only the _absence_
of an answer rejects — unreachable, timed out, undecodable, no route. `AppOutcome::Declined` and its
mapping to `f99_application_error` (`connector.rs:740`) go.

**An unpaid request to a priced route is answered with its terms, not with service.** A connector
that receives one returns what it costs and what is needed to pay it (ADR 0022), rather than
performing the work. This is what makes it safe for a connector that sells to be reachable at all:
the failure mode of an unpriced connector in front of a payment-oblivious app — an anonymous free
gateway to that app, which is what #492 discovered — stops existing when the unpaid case has a
defined, useful, unpaid answer.

## Considered options

**Price per byte.** Covers what the relay actually does. Rejected on two counts: it is asymmetric
with ADR 0010's deliberately flat fee, and it breaks ADR 0011's cacheability — a probe would report
only the cost of a packet its own size, so a sender would have to probe with a same-size dummy
before every write.

**The app quotes each request.** Full fidelity to app-specific pricing. Rejected: it makes the app
payment-aware, and adds a round trip to every packet.

**Reject when the app returns an error.** Intuitive — don't charge for a failure. Rejected: it makes
app errors free, so anyone can drive unlimited load through a connector into an app at zero cost by
aiming at paths that error. That is precisely the traffic a price exists to charge for.

## Consequences

Byte-proportional pricing is gone, and with it anti-spam by size at the connector. A 100-byte and a
100 KB write to the same handler cost the same.

The relay's pricing engine loses its consumer. `basePricePerByte` and `kindOverrides` in
`relay/packages/bls/src/pricing/config.ts` have no successor: the route table _is_ the price list. A
relay that wants kind:30023 to cost more exposes a second write handler and the operator prices that
route. Today the relay has one write path, so it has one price.

A payer can be charged for a 500 from a running-but-broken app. The mitigation is the operator
watching its own error rate, not the protocol.

Combined with ADR 0019, fabricating an error response is exactly as profitable to a dishonest
terminating connector as fabricating a success. That consequence is recorded there.

An app fronted by this connector cannot log, bill or rate-limit by payer from what a handler
receives — nothing on that path names one. Anything that needs that attribution must get it from
somewhere other than the packet path.
