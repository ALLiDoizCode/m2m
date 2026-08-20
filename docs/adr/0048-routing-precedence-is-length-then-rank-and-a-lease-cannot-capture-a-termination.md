# Routing precedence is length, then rank — and a lease cannot capture a termination

**Status:** Accepted, **partly not yet built** — the four-source ordering and the label-aware match are live and described here for the first time; the terminated-subtree protection is new and is tracked by its implementation issue. Bounds [0032](0032-a-client-destination-is-never-a-route-termination.md) by stating where a client session sits relative to the route table.

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

**A destination is matched by longest prefix first, and route _kind_ breaks a tie — with one
exception: a leased route may never out-specify a terminated route's subtree.** A client session is
not part of that ordering at all: it is an exact-address lookup that receives only what the route
table could not place.

## The ordering

Four sources compete, scored `(matched prefix length, rank)`, highest wins:

| rank | source                                                    | written by            | durability                                                                         |
| ---- | --------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| 3    | **App** — a `[[routes]]` row with a `handler_url`         | operator, config file | permanent                                                                          |
| 2    | **Peer** — a `[[routes]]` row with a `peer_id`            | operator, config file | permanent                                                                          |
| 1    | **RuntimePeer** — a row written over the operator surface | operator, at runtime  | durable ([0034](0034-a-runtime-peer-route-table-never-shadows-the-config-file.md)) |
| 0    | **Leased**                                                | controller            | expires unless renewed                                                             |

**Length dominates rank.** Rank breaks a tie only between equal-length prefixes. `CONTEXT.md`'s
"a static route … always beats a leased route **for the same prefix**" is exact, and is routinely
misread as "always beats": a _longer_ leased prefix does beat a shorter static one, and that is
deliberate — a controller refining a route is the normal case, and a broad static route that swallowed
every lease beneath it would make leases unusable.

**Matching is label-aware, never raw string prefix.** A prefix `p` governs `destination` when the
destination is exactly `p`, or begins with `p` followed by a dot. `g.example` does not match
`g.exampleX`; `g.toon.rel` does not match `g.toon.relay`. RFC 0015 addresses are dot-separated labels
and matching respects that.

**An expired lease does not compete.** Leases are filtered by expiry before matching, so a route to an
unreachable peer stops being used by lapsing rather than by anyone noticing.

**No match is `F02`**, with the destination named.

## The exception: a lease cannot capture a terminated subtree

**A leased route whose prefix falls beneath a terminated route's prefix does not compete.** Refinement
of _forwarding_ is a controller's job; capture of a _termination_ is not.

The asymmetry is not stylistic. A lease out-specifying a forwarded route changes which peer carries a
packet — recoverable, and the kind of decision leases exist to make. A lease out-specifying a
**terminated** route changes whether the packet reaches the operator's own app at all, on a
destination whose price a client already paid at this edge ([0028](0028-a-forwarded-route-is-priced-at-the-client-edge.md))
— and the terminating connector is the party that derives the fulfilment it is paid against
([0019](0019-a-terminating-connector-derives-the-fulfilment.md)). Redirecting that traffic sells work
the app was paid for and does not perform.

[0032](0032-a-client-destination-is-never-a-route-termination.md) already refuses exactly this shape
when the competitor is a **client session**. Refusing it there and permitting it from a lease was an
inconsistency nobody had noticed, because the ordering had never been written down in one place.

This is a **narrowing of live behaviour**: a lease can capture a terminated subtree today.

## Where a client session sits

Not in the ordering. A session is bound to an **exact address** — a hash lookup on the full
destination, with no prefix semantics — so it cannot be ranked by prefix length in any meaningful
sense; an exact match is by construction the longest match there is.

The interaction is two rules, not a precedence:

1. **A session bound where a _terminated_ route also matches is a refusal**, not a contest — ADR 0032,
   enforced at packet time. Neither "the app silently wins" nor "the session silently wins" is safe.
2. **Otherwise the route table answers first, and the session receives only what it could not place** —
   strictly a reject of `F02`, which is produced solely by the no-match arm. A matched forwarded route
   can therefore never fall through to a session, so there is no silent substitution of destination to
   guard against.

A session is a gap-filler. It never shadows a route.

## Consequences

**Three planes write into one namespace** — the config file, the operator surface, and a controller —
and this record is the only statement of how they compose. [0034](0034-a-runtime-peer-route-table-never-shadows-the-config-file.md)
protects the config file from the operator surface at equal prefix; this record protects a termination
from a lease at any prefix. Nothing protects a forwarded route from a longer lease, deliberately.

**The terminated-subtree rule needs building.** Until it lands, a sufficiently specific lease can
capture a termination.

**`CONTEXT.md`'s Leased route and Static route entries should point here.** They are individually
accurate and jointly misleading, which is what a precedence rule spread across two glossary entries
does.
