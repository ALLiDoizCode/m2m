# A peer-sale lease demotes at match time and reaps off the hot path

**Scope:** connector architecture — internal to this codebase. See the [ADR index](README.md).

Issue #886 (toon-meta#316, child C3 of #867 "sell peering") gives a purchased peering (issue
#885, ADR 0037) a lease: a duration bought alongside the price, renewable by paying again,
that lapses into a clean demotion back to client role rather than staying a permanent grant.
This ADR states where the lease lives, when it takes effect, how a lapsed row stops being a
durable "dead row", and how a purchased peer is distinguished from every other kind of peer
row so only it is ever subject to one.

## Context

ADR 0037 shipped the purchase itself and said plainly what it left out: "No lease, no expiry,
no abuse bounds. #886 (C3) and #887 (C4) own those. A purchased peering inserted here is a
permanent grant, exactly like any other operator-written `[[routes]]` row, until a later child
adds a TTL or a cap." Issue #886's own "Why" names the cost of leaving that as-is: a peering
that never expires is a permanent grant sold once, and it leaves a dead row in a table that
ADR 0034 made durable — a slow leak on a long-lived box.

Two mechanisms already exist in this codebase for "a routing-table entry that can lapse", and
neither fits by itself:

- **Leased routes** (issue #427, ADR 0006): TTL-bound, pushed by an automated controller,
  deliberately **not** durable — a lease evaporates on restart, and its safety property is
  expiry, not persistence. A peer-sale purchase is the opposite: a paying counterparty's
  relationship is deliberate and durable (ADR 0034's whole point), so it cannot use the same
  "memory-only, no restart survival" shape without losing what #884/#885 already built for it.
- **The runtime peer/route table** itself (issue #884, ADR 0034): durable, but with no
  expiry concept anywhere in it — `RuntimePeer`/`PeerRoute` carry no timestamp, and neither
  `upsert_runtime_peer` nor the config-file precedence rule has any notion of a row that stops
  being valid on its own.

So the lease needs the durability of the runtime table and the "checked fresh against the
clock on every lookup" immediacy of a lease, at once — and it needs to attach to _only_ the
rows a purchase creates, never to a config-file row or to a peer an operator added directly
over `POST /peers` (issue #886's own fourth acceptance criterion).

## Decision

**The lease lives on the peer's identity, not on the route.** `Connector::runtime_peers`
changes from a bare `HashSet<String>` of ids to a map, peer id to `Option<DateTime<Utc>>`:
`None` for a peer added over the plain `POST /peers` surface (a permanent grant, exactly as
every runtime peer was before this issue), `Some(expires_at)` for one a peer-sale purchase
inserted. A purchase always creates exactly one peer row for its one route
(`peer_id == client_channel_id`, ADR 0037), so demotion acting on peer identity rather than on
the route in isolation loses nothing and avoids a second, redundant expiry field on
`PeerRoute` itself. `connector_runtime::PeerRouteStore`'s durable snapshot carries the same
optional timestamp per peer, so a lease (or its absence) survives a restart exactly like the
row it is attached to.

**Config rows can never acquire a lease, structurally, not by a runtime check.** ADR 0034's
own rule — a runtime write naming a config-file peer id or prefix is refused outright,
never coexisting with it — means `config_peer_ids` and `runtime_peers` are disjoint by
construction. There is no code path where a lease could be attached to a config-file row even
by mistake, so this issue adds no new guard for that case; it inherits ADR 0034's.

**Only a peer-sale purchase leases; the plain operator surface never does.**
`Connector::upsert_runtime_peer` (`POST /peers`) always inserts with `None` — unchanged
behaviour from before this issue. A new `Connector::upsert_runtime_peer_purchase` is the one
path that ever writes `Some`, called only from `settle_peer_sale_purchase`. This is the answer
to the issue's own question ("state how the two are distinguished"): not a flag or a source
tag, but which of two insert methods was called, mirroring how ADR 0034 already distinguishes
config rows from runtime rows by which write path reached them rather than by a marker on the
row.

**Renewal extends; it does not restart.** `upsert_runtime_peer_purchase(id, lease_duration)`
computes the new expiry as `lease_duration` added to whichever is later of the current expiry
(if any) or now. Paying again well before a lease lapses stacks the fresh term on top of the
unused remainder; paying again after it has already lapsed has no remainder to preserve and
simply starts a fresh lease from the moment of that payment. The purchase's own sealed
response now echoes the resulting `expires_at`, so a buyer's renewal is confirmed by what
actually happened, not only by what it asked for.

**Demotion happens twice, at two different speeds, for two different reasons.**

1. _Immediately, at match time._ `Connector::select_configured_route` excludes a runtime
   peer-forwarding route whose peer's lease has lapsed as of the connector's own injected
   clock — the identical "filter fresh against the clock on every lookup" treatment issue
   #427's leased routes already receive. This is what makes a demotion take effect the
   instant it lapses, including for a packet routed in the same instant a lease crosses its
   boundary: nothing about _routing_ depends on any sweep having run.
2. _Off the hot path, on a timer._ `Connector::reap_expired_peer_leases` removes the peer row
   and every runtime route forwarding to it from the durable table, persists the result, and
   logs each demotion positively (`tracing::info!`, naming the peer id and the instant it
   lapsed) — never silently, which is issue #886's own explicit demand, made concrete against
   the exact failure mode it cites (`connector-peer-auth::decide_role` logging nothing at all
   for a credential naming an unconfigured peer id). `connector-cli` drives this on a one-
   minute interval, spawned once and never awaited on the startup path — the same shape
   `EvmChannelIndexSyncer::run`'s periodic sweep already takes. Splitting the two matters
   because the durable removal is the only thing issue #886's "Why" (the slow leak) is about;
   the routing behaviour must not wait for it, and the reap must not run on the packet path
   (`ADR 0015`'s "no locking on the hot path" already governs `runtime_table_lock`, which the
   reap takes exactly once per sweep, not once per packet).

**Safety of removing a row with packets concurrently in flight is inherited, not
re-solved.** `select_configured_route` already clones the one matched `PeerRoute` out of its
`ArcSwap` snapshot before returning (ADR 0034's own "Cow, not a plain clone" reasoning); by the
time a packet is forwarding, it is no longer reading the table at all. A reap can therefore
only ever remove a row nothing currently in flight still depends on.

**The lease is priced information, visible before paying, the same way price already is.**
`[peer_sale]` gains a required `lease_seconds` field — required for the same reason `price` is
required (`ConfigError::PeerSaleMissingLease`, mirroring `PeerSaleMissingPrice`): a purchase
with no stated duration would silently be the permanent grant this issue exists to retire.
kind:10032's announce gains `peerSaleLeaseSeconds`, populated unconditionally whenever
`[peer_sale]` is configured — the same "discoverable without a second config line" treatment
ADR 0037 already gives the price in `routePrices`. This is deliberately **not** a new field on
the generic x402 greeting (`connector_domain::x402::X402PaymentRequired`): that shape is
shared by every route this connector prices, and extending it would be a wire change scoped
far wider than one singleton route, where ADR 0037's own precedent (advertise via kind:10032,
leave the generic greeting alone) already applies without modification.

## What this deliberately does not do

**No change to peer-carriage accept-side authentication.** Exactly the gap ADR 0037 already
named and left to issue #868: a purchased peer's _identity_ now carries a lease, but whether
an inbound interaction is even recognised as peer-role at all is unaffected by this issue
either way.

**No abuse bounds.** Rate limits, purchase quantities and per-purchase caps are issue #887
(C4)'s job, not this one's — a lease bounds _how long_ a peering lasts, not _how many_ or _how
fast_ they can be bought.

**No lease on a config-file `[[peers]]` row, ever, under any circumstance.** Not merely
unimplemented — structurally impossible, per ADR 0034's disjointness between
`config_peer_ids` and `runtime_peers`.

## Consequences

- A node that never configures `[peer_sale]` is unaffected: `runtime_peers` still degrades to
  "every entry is `None`" exactly as it did before this issue, since `POST /peers` is the only
  write path reachable.
- An operator inspects a lease directly: `GET /peers` reports `expires_at` per row (absent for
  a permanent one), so which purchased peerings are about to lapse is never something to infer
  from `runtime-peers.json` by hand.
- The next reader wiring issue #887's abuse bounds has a lease-aware table to build on: the
  peer-identity-keyed expiry this issue introduces is the natural place a purchase _count_ or
  _rate_ would also key off of, though this issue does not add either.
