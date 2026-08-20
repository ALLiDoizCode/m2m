# A probe answers what a route costs and what it does

**Status:** Accepted, **not yet built**. No `description` field exists in `connector-config`'s route schema, and nothing carries one on a greeting or a reject. Extends [0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md), [0020](0020-a-price-is-flat-and-attaches-to-a-handler.md) and [0022](0022-a-connector-answers-it-does-not-announce.md).

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

A probe already learns what a path costs
([ADR 0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md)). It now also learns **what the
addressed route does**: a short, operator-written description of the work behind that route, carried
back on the same reject. The description comes from **this connector's own configuration** and from
nowhere else — never by asking the app, never by inspecting a payload.

## Why this is answering, not announcing

[ADR 0022](0022-a-connector-answers-it-does-not-announce.md) draws the line at who initiated: a
connector tells whoever asks what its own configuration already says, and reaches nobody who did
not ask. Capability is the same kind of fact as price — it is in the config file, the operator put
it there, and a caller has to send a packet to get it. Adding it changes what an answer contains,
not who gets answered, so ADR 0022 and [ADR 0006](0006-the-connector-is-mechanism-not-policy.md)
are untouched.

Reading it out of config rather than out of the app is what keeps that true. A connector that asked
its app what it does would be discovering rather than answering, would need the app to speak a
protocol it currently does not, and would put a round trip on a path that exists to avoid one. The
app stays payment-oblivious and capability-oblivious; the operator describes the route it published.

## Granularity is handler granularity

[ADR 0020](0020-a-price-is-flat-and-attaches-to-a-handler.md) already fixed the unit: one handler,
one price, and an operator charges differently for different work by publishing a route per handler.
A description attaches at exactly the same place and for the same reason. One route describes one
kind of work, so a description never has to vary with what a packet carries — which is what keeps
this from becoming a reason to look inside one.

## Only the termination describes; every hop still costs

An intermediate hop adds its fee to a reject travelling back and **contributes no description**.
Only the connector that terminates the addressed route describes it.

This preserves ADR 0011's privacy property exactly as written — "returning a sum leaks nothing…
the per-hop breakdown is not [returned], so topology and individual pricing stay private". A
description of the destination says nothing about who carried the packet there. Had every hop
annotated a reject, the reject would have become the topology dump that ADR 0011 was careful not to
produce.

## Where it rides

Two surfaces already answer this question, and they answer different halves:

- **The x402 greeting** is free, comes from the node you addressed directly, and already carries
  `extra` facts about that node (`price`, `ilpAddress`, `requiredTransport`, and since issue #807
  `addresses`/`btpEndpoint`). It is the natural carrier for a **description**, which is a fact about
  one node.
- **A probe's reject** accumulates across hops and is the only thing that can report **path cost**,
  which is a fact about a route rather than a node.

**Both carry the description; only the reject carries the sum.** A caller that can reach a node
directly should not have to spend a packet to read its menu, and a caller discovering a multi-hop
path should not need a second round trip to find out what is at the end of it. The description is
identical in both, because it is the same config field.

`accumulated_cost` stays outside the ADR 0018 seal as it always has. **A description does not** — on
a reject raised at the termination it rides inside the sealed response, because it is the
destination's own answer and sealing is what makes it provably the destination's.

## Consequences

**A description is untrusted input to whoever reads it.** It is operator-written free text about a
service a caller has not used yet, and nothing verifies that the route does what it says. It is a
menu, not a warranty, and a client that renders one must treat it as text from a stranger.

**It must be bounded in length**, for the reason every network-reachable string in this repo is:
it rides a reject that a hop must forward. A cap on it belongs with the field.

**Nothing becomes discoverable that was not already reachable.** A caller learns a description only
for a route it addressed and a node that answered. There is no listing, no enumeration and no index
— those would be announcing, and ADR 0022 still refuses them.
