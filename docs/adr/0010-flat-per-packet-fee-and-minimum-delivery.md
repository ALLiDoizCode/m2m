# A hop charges a flat per-packet fee, and packets declare a minimum delivery

Each peering relation has a flat fee charged once per forwarded packet, replacing the
percentage spread. Every packet declares the amount that must reach its destination, and a hop
that cannot meet that figure after taking its fee rejects the packet rather than forwarding a
smaller one.

## Why flat rather than proportional

A hop's real cost to forward a packet is one signature verification, one signature, and some
bandwidth. That cost is constant; it does not vary with the value being carried. The
proportional-risk argument that justifies a spread elsewhere is weak here too, because a
payee's exposure is capped at a single packet by ADR 0004 rather than accumulating with volume.

The percentage model also failed quietly at the scale this network actually operates. Fees are
computed in basis points with integer arithmetic, so at the default 0.1% the fee is
`amount / 1000` and every packet below 1000 units is carried free. Route prices are denominated
at exactly that scale — `price: '1000'` is 0.001 USDC — so a meaningful share of real traffic
fell into the rounding gap.

## Why minimum delivery rather than quoting

Without it, each hop silently reduces the amount and the sender learns what arrived only after
the fact. There is no quoting protocol in the system today and the only reference to one is a
comment advising the sender to "re-quote and retry" against nothing. Interledger removed its
quoting protocol for good reasons, and reintroducing one to solve this would be a large amount
of machinery for a guarantee that a single field provides.

Declaring the minimum inverts the failure: under-delivery becomes an explicit reject that the
sender can act on, rather than a shortfall it discovers at the destination. Every hop can check
it locally, with no knowledge of the rest of the path.

## Consequences

Fees are earned only on fulfilment, following ADR 0004. A hop's earnings are the difference
between the cumulative it receives from upstream and the cumulative it sends downstream, which
falls out of the claim exchange without separate accounting.

Choosing a flat fee is what makes cost discoverable in one shot. Because the figure does not
vary with the amount carried, a path's cost is a constant a client can learn once and cache;
see ADR 0011, which replaces the price discovery lost with `announcePrice` and the x402
greeting.
