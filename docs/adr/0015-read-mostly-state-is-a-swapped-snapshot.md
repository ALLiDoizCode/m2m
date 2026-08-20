# Read-mostly state is a swapped snapshot; the packet path never locks

**Status:** Accepted. Live: `ArcSwap`-held leased routes in `connector-runtime`.

**Scope:** connector architecture — internal to this codebase. See the [ADR index](README.md).

Routes, peers and configuration are read on every packet and written rarely, if ever. That
state is held as an immutable snapshot, published as a whole and swapped atomically, so the
packet path reads it with no lock and no per-read copy. State that is genuinely mutable —
written as often as, or more often than, it is read — is owned by the struct that mutates it
and reached through an ordinary lock, because a snapshot swap buys nothing when there is
nothing read-mostly about the data.

## Why

The packet path is the hot path: it runs once per packet, not once per administrative action.
A lock taken there is contended by every concurrent packet; a clone taken there is paid by
every packet regardless of whether the data it copies ever changes. Neither cost is visible in
a single request — both show up only under concurrent load, which is exactly when the
`RwLock<HashMap<..>>` this rule replaces looks fine in a test and falls over in production.

## The worked example (#452 / #484)

`Connector::leased_routes` was a `RwLock<HashMap<String, LeasedRoute>>`. Every `PREPARE`
called `active_leased_peer_routes()`, which took a read lock and cloned every active
`LeasedRoute` into a fresh `Vec`, then cloned again into a `PeerRoute` for the one that
matched — two allocations and a lock, per packet, scaling with how many leases happened to be
active rather than with the one packet being forwarded. Issue #452 named this as a violation
of the rule this ADR states; issue #484 fixed it by making `leased_routes` an
`arc_swap::ArcSwap<HashMap<String, LeasedRoute>>`. The packet path now calls `load_full()` — one
lock-free `Arc` clone of the current snapshot, not a lock and not a copy of the map's contents —
and forwards through a reference into that snapshot (`LeasedRoute::as_peer_route()`), so the
second allocation is gone too. Renewing or creating a lease uses `rcu` to publish a whole new
map; that O(n) copy now happens only on the rare, administrative write, which is where it
belongs.

Measured before and after (`connector::tests::perf::bench_leased_route_lookup`, release mode):
with 1,000 concurrently-active leases, per-packet latency dropped from 181.0µs to 6.1µs — about
30x. The N=0 case (no leases at all) was unchanged, since there was nothing to clone either way;
the cost this rule guards against only appears once there is state worth cloning.

## What this covers

- **Static routes and peer routes.** Loaded once at construction (`Connector::routes`,
  `Connector::peer_routes`) and never mutated afterwards. This is the degenerate, simplest case
  of the rule: an immutable value with no swap mechanism at all, because nothing ever publishes
  a second version.
- **Configuration.** `connector-config`'s `Config` is validated once at boot and held as an
  immutable value for the process lifetime (ADR 0009) — construction-time immutability again,
  not a runtime swap.
- **Leased routes**, and anything with the same shape: read on every packet, written
  occasionally at runtime by an administrative action. This is the case that needs an actual
  swap mechanism, because unlike the two above, a second version really does get published
  while the process is running.

## How, concretely

For state that is only ever set once (static routes, peer routes, config), a plain owned value
is enough — there is no second version to swap to, so introducing `ArcSwap` around it would add
a mechanism with nothing for it to do.

For state that is updated at runtime while remaining read-mostly (leased routes), use
`arc_swap::ArcSwap<T>`: reads call `load_full()`, a lock-free `Arc` clone of whatever snapshot is
current; writes call `rcu` to publish a wholly new `T` rather than mutating the old one in place.
A reader that already holds a loaded snapshot keeps reading a consistent, unchanging view even
if a write publishes a new one concurrently — nothing it forwards through needs to be cloned out
of the snapshot again, matching `LeasedRoute::as_peer_route()` above.

**Name the anti-pattern:** wrapping a derived `Vec` (or any other collection built fresh from the
snapshot) in its own `RwLock` reproduces the exact problem `ArcSwap` exists to remove, with an
extra layer of indirection on top. If a read has to lock and then clone before it can use the
data, the snapshot has not actually been swapped in — it has been re-copied behind a new lock.

## What this does not mean

Not every shared value needs `ArcSwap`, and a plain lock is not itself the mistake. This rule
applies to data that is **read far more often than it is written** and sits on the per-packet
path. It does not apply to:

- **Cold paths and administrative surfaces.** The operator surface's writes (upserting a leased
  route, opening a channel) are rare enough, and off the per-packet path, that locking there is
  fine — the cost this ADR cares about is cost paid per packet, not per admin call.
- **State that is written at least as often as it is read.** `Connector::probe_rate_limiter`'s
  window map (a plain `Mutex`) is mutated on every single access — recording a probe always
  updates its count — so there is no "mostly read" character to snapshot in the first place; a
  lock there is not a smaller version of the #452 bug, it is the correct tool for data with no
  read-mostly shape. Likewise `known_channels` (`RwLock<Vec<ChannelId>>`) is read and written by
  settlement operations, not by the packet-forwarding path, so it is a cold-path lock, not a
  hot-path one.

Reaching for `ArcSwap` on either of those would not remove a cost — it would just be a different
name for the same lock, protecting data that was never the problem this rule exists to solve.
