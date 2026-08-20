# A hop charges a flat per-packet fee, and packets declare a minimum delivery

**Status:** Accepted, amended by [0042](0042-a-packet-carries-its-claim.md): a fee is earned when the packet is paid for, not on fulfilment. Flat-per-packet and minimum delivery are unchanged.

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

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

A hop's earnings are the difference between the cumulative it receives from upstream and the
cumulative it sends downstream, which falls out of the claim exchange without separate accounting.
That arithmetic is unchanged by _when_ the exchange happens: this record originally said fees are
earned only on fulfilment, following ADR 0004, and
[ADR 0042](0042-a-packet-carries-its-claim.md) retired that headline — a packet carries its claim,
so a fee is earned when the packet is paid for rather than when it fulfils. The difference-of-two-
cumulatives above is what a hop earns either way.

Choosing a flat fee is what makes cost discoverable in one shot. Because the figure does not
vary with the amount carried, a path's cost is a constant a client can learn once and cache;
see ADR 0011, which replaces the price discovery lost with `announcePrice` and the x402
greeting.

## Update (issue #1072) — minimum delivery is a peer-path field, and a client role MUST ignore it

This record says _"every packet declares the amount that must reach its destination."_ That was
written when the peer path was the whole story, and it generalises a **peer** rule into a universal.
It is narrowed here to what the design actually is, and always was.

### A client-originated packet declares none, deliberately

`connector-client-edge` calls `handle_prepare_with_client_channel(prepare, 0, …)` — a floor of zero —
and says why: _"client-edge-spec v1 carries no minimum-delivery field… a client-originated packet
declares no guarantee yet, so this hop enforces none."_

**A client's guarantee is the price, not a floor.** [0028](0028-a-forwarded-route-is-priced-at-the-client-edge.md)
prices a forwarded route at the client edge and requires it carry no more than it was paid, and the
invariant `price − fee >= next hop price` is what protects a client across the whole path. A client has
already bought a stated route at a stated price.

A **peer** needs minimum delivery for the opposite reason: it is carrying on someone else's behalf,
with no price of its own to lean on, and must be able to bound its own erosion. That asymmetry is the
whole content of the field, and stating it as universal obscured it.

Adding a client-side floor as well would give one guarantee two mechanisms that can disagree — a client
declaring a floor contradicting the price it paid has no good resolution. The pricing invariant is the
one that binds.

### A client role MUST **ignore** the field — not reject it, not apply it

This rule binds every implementation and had no record at all (sweep finding F-27). Its only source
was `connector-peer-btp/src/fields.rs`, `connector-peer-http/src/headers.rs` and a spec that is now
frozen history.

> `role` is taken rather than assumed because the field is a **peer** grant: on a client-role
> interaction it MUST be ignored — not rejected and not applied — **so a client SDK that sets an
> unrecognised entry is not broken by a peer feature.**

The reason is forward compatibility, and **ignoring is the only behaviour that achieves it**.
Rejecting looks like the safer choice and is the wrong one: it turns a client's harmless extra header
into a refused packet, which is precisely the breakage the rule exists to prevent. A second
implementer choosing "reject" as the conservative default would be conforming to this record's old
wording and breaking real clients.

### Ruling note

The map's scope default (#1049) says a **protocol law** record wins and the binary has a bug. That
default is argued against here, and the evidence is that the counter-argument was written down in two
crates and a specification — the signature of a deliberate narrowing nobody recorded, rather than
drift. Reading [0028](0028-a-forwarded-route-is-priced-at-the-client-edge.md)'s pricing invariant makes
it conclusive: the client-side guarantee already exists and is not this field.

**Everything else in this record stands:** flat per-packet fees, and a hop that cannot meet a declared
minimum delivery after its fee rejecting (`R01`) rather than forwarding less.
