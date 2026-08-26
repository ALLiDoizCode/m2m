# The cap bounds one packet, is discovered by its own `T04`, and is never earned by the connector

**Status:** Accepted, **partly not yet built** — the cap and its `T04` refusal are live; the message-carries-the-cap rule is live but unstated, and a runtime-settable cap does not exist. Corrects `CONTEXT.md`'s **Cap** entry, and corrects three documents that claim nothing emits `T04`. Both falsifiers below are answered by [0058](0058-a-peering-is-established-from-a-url.md), which puts the cap on the write that establishes a peering.

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

**Falsifier:** `crates/connector-operator/src/**/*.rs` matching `\bmax_packet_amount\b` — Consequences below: "The operator surface must be able to express a cap, and today it cannot." A runtime-settable cap has to be nameable on the write half, so the key appearing here means it landed.

**Falsifier:** `crates/connector-runtime/src/peer_route_store.rs` matching `\bmax_packet_amount\b` — the other end of the same mechanism: a runtime peer row would have to carry the cap and persist it, under the durability rules [0034](0034-a-runtime-peer-route-table-never-shadows-the-config-file.md) already decided.

**A cap is the largest amount a connector will forward to one peer in a single packet.** A packet
exceeding it is refused `T04`, never carried and never split. **The reject's message carries the
current cap**, and that is the only way a sender learns it. A connector never raises a cap on its own:
the number comes from outside — the config file, or a controller writing through the operator surface.

## What was wrong, and where

`CONTEXT.md`'s **Cap** entry ends: _"a peering that has just been bought starts at the floor, and a
path that keeps fulfilling earns a larger one."_ Neither clause describes anything that exists.

**"A peering that has just been bought"** — peerings cannot be bought.
[0043](0043-purchasable-peering-is-removed.md) removed purchasable peering in full and restored
[0006](0006-the-connector-is-mechanism-not-policy.md) without qualification. The clause is a survivor
of the retired 0037/0038/0039 line, describing a thing that cannot exist. Deleted.

**"A path that keeps fulfilling earns a larger one"** — nothing earns anything.
`Connector::packet_cap_for` is a static lookup into a map populated once at boot from
`[[peers]].max_packet_amount`, defaulting to `DEFAULT_MAX_PACKET_AMOUNT`. There is no history, no
counter, and no path by which a cap changes while a node runs. The sentence stated intent as
behaviour.

**And three documents claim nothing emits `T04`** — `connector-domain/src/packet.rs`'s own
constructor doc (_"nothing in this codebase emits `T04` any more"_), ADR 0033's body, and
`peer-semantics-pre-868.md` §5.1–§5.3, which additionally omit the cap refusal entirely. All three were
true between issue #424 and the cap landing; none is true now. `Connector` emits `T04` for the cap
refusal, and the glossary was the only document that had it right.

## Decision

**1. The cap bounds one packet, never an accumulation.** There is no running total for it to bound —
nothing is owed between packets, because a packet carries its own claim
([0042](0042-a-packet-carries-its-claim.md)). One packet, checked and forgotten.

**2. Over the cap is `T04`, never a split.** A connector does not fragment a packet to fit.

**3. The reject's message states the current cap.** This is what makes the cap discoverable at all,
and it is the clause most at risk of being missed: a second implementer emitting a bare `T04` would
satisfy every other rule here while leaving senders unable to size anything. Discovery by rejection is
the same shape [0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md) already uses for cost.

**4. The cap is not published in advance.** Caps are per-peer, and a public self-description listing
them would disclose who this node peers with and how far it trusts each — a relationship
[0006](0006-the-connector-is-mechanism-not-policy.md) and [0043](0043-purchasable-peering-is-removed.md)
make operator-private. Only the peer concerned ever learns its own cap, and only by being refused once.

**5. A connector never raises its own cap.** A cap that grows with demonstrated good behaviour is a
**trust** mechanism, and trust is policy. Under [0006](0006-the-connector-is-mechanism-not-policy.md)
policy lives outside the connector. Earning is a **controller's** job: it watches whatever history it
chooses and writes a new cap through the operator surface. The connector enforces the number it was
given and decides nothing.

## Consequences

**The operator surface must be able to express a cap, and today it cannot.**
`Connector::upsert_runtime_peer` takes an `id` and nothing else, so a runtime peer row has no cap and
a controller has no way to raise one. Until that lands, "the controller earns it" is a division of
responsibility with no mechanism behind it, and a cap can only change by editing the config file and
restarting.

**A runtime-settable cap inherits the rules already decided for runtime rows** —
[0034](0034-a-runtime-peer-route-table-never-shadows-the-config-file.md)'s config ownership, and its
`## Update (issue #1059)` on what boot does with a colliding row.

**A published cap would have been a hint, not a contract.** Because the cap is settable at runtime, any
value published in advance can be stale by the time it is used, so the `T04` path must stay
authoritative regardless. That is what decided clause 4: once the rejection is authoritative, a second
advisory source is a surface to maintain and keep honest, for the saving of one packet.

**Three documents need correcting** and none of them is this record's to fix: `packet.rs`'s
constructor doc, ADR 0033's body, and `peer-semantics-pre-868.md` §5.1–§5.3. They are named here so the
correction is not re-derived.
