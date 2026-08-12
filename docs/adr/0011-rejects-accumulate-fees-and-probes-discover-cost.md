# Rejects accumulate fees; a probe is how cost is discovered

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

Every reject carries a running total of the fees of the hops it has passed through: each hop
adds its own fee before passing the reject upstream. Cost discovery is then a packet you expect
to be rejected — a probe — and the reject that comes back states what the path costs. Probes
are not a distinct packet type, and fee accumulation is not a special mode.

## Why not a quoting protocol

Interledger removed ILQP because a quote is computed over a path chosen at quote time, which
need not be the path a real packet later takes; the answer is precise about a route you did not
use. A probe has no such gap. It is an ordinary packet, routed by the ordinary routing table,
accumulating the fees of the hops that actually carried it.

No single participant can answer the question any other way. Fees are per peering relation —
bilateral, local and private — and no hop can see past its own next hop. End-to-end cost
therefore requires either a global view of the graph or a traversal of it, and traversal is the
one that cannot go stale.

## Properties this inherits from earlier decisions

**The answer is cacheable.** Because ADR 0010 makes fees flat per packet rather than
proportional, a path's cost is a constant that does not vary with the amount being sent. One
probe yields a figure good until the topology or a fee changes. Under a percentage spread the
client would have to re-probe per amount.

**Understating a fee is unprofitable.** Because ADR 0004 moves value on fulfilment, a hop that
advertises a low fee to attract traffic and then rejects the real packet earns nothing and has
spent its own bandwidth. Honesty needs no enforcement.

**Returning a sum leaks nothing.** The total is what a caller must know in order to use the
path. The per-hop breakdown is not, and is never returned, so topology and individual pricing
stay private.

## Consequences

Making accumulation a property of all rejects rather than of probes specifically means a client
rejected for any reason — expiry, no route, a ceiling — also learns what that path would have
cost. That is strictly more information for strictly less protocol.

A probe traverses the network and pays nothing, so it is accepted only from a sender that
already holds an open payment channel with this connector, and is rate-limited per that
identity. A sender without a channel is rejected at ingress without being forwarded. This costs
legitimate users nothing, since a channel is required to send real traffic regardless, while an
abuser must fund a channel per identity to sustain it.

This closes the price-discovery gap opened by removing `announcePrice` with discovery (ADR 0006) and the x402 greeting. Neither is reinstated.
