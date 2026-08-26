# A runtime peer/route table never shadows the config file

**Status:** Accepted. Extends [0009](0009-one-typed-config-file-no-environment-layer.md) and [0006](0006-the-connector-is-mechanism-not-policy.md). **Survives [0043](0043-purchasable-peering-is-removed.md) intact** — a durable runtime table is what an operator needs and was never about selling. Live: `connector-runtime/src/peer_route_store.rs`. **Completed by [0058](0058-a-peering-is-established-from-a-url.md)** — until that record is built, the rules here govern a table that cannot hold a peering.

**Scope:** connector architecture — internal to this codebase. See the [ADR index](README.md).

Issue #884 (toon-meta#316, child C1 of #867 "sell peering") makes the peer/route table mutable and
durable at runtime for the first time: `POST`/`DELETE /peers*` and `POST`/`DELETE /routes/peers*`
over the operator surface. This ADR states the precedence rule between a config-file row and a
runtime-added one, and where the durable copy lives -- both of which the issue asked to be picked
and written down, not left implicit.

## Context

Before this issue, `Connector` had no runtime peer-mutation path at all: `/peers` was `GET` only,
and `PeerView` was a literal empty struct -- nothing in the runtime tracked peer identity, since
peer carriage config (`connector_config::PeerConfig`: endpoint, credential, exposure) is consumed
once at boot to build the peer transport and never stored back on `Connector`. The one existing
runtime-mutable routing table, leased routes (issue #427, ADR 0006), is deliberately **not**
durable: a lease is pushed by an automated controller with a TTL and lapses unless renewed, so its
safety property is expiry, not persistence -- "a controller that dies causes routes to expire
rather than to rot."

Selling a peering (#867) is a different shape: a paying counterparty's route is a deliberate,
durable relationship, not an automated controller's transient push. A table that evaporated on
restart would be useless to the devnet boxes this ships to, which run hand-tuned bind-mounted TOML
and nothing auto-deploys (`CLAUDE.md`) -- the whole reason #884 exists is that a runtime-mutable
table with no durability would not actually solve anything a lease doesn't already solve.

At the same time, `connector-config`'s load-time `UnknownPeerId` check (`config.rs`) already
enforces an invariant: the routing table IS the relationship set, and a route naming a peer id the
config file does not define is a hard failure at boot, not a route that resolves to nothing. A
runtime table has to preserve that invariant continuously rather than abandon it, since nothing
re-validates a `Config` after `Config::load` returns.

## Decision

**Config always wins, and it wins by refusing the write, never by silently shadowing or being
shadowed.**

- A runtime write (`upsert_runtime_peer`, `upsert_runtime_peer_route`, and their `remove_*` twins)
  that names a peer id or route prefix the config file already owns is refused outright
  (`PeerRouteTableError::OwnedByConfig`), whether the write would add, update or remove. There is
  no code path where a runtime row and a config row can coexist under the same key, so there is
  nothing to disambiguate at match time between the two -- the ambiguity is refused at write time
  instead.
- A runtime peer-forwarding route's `peer_id` must resolve to a known peer -- the config file's or
  the runtime table's -- checked on every write (`PeerRouteTableError::UnknownPeerId`). This is the
  runtime analogue of `connector-config`'s load-time check, enforced continuously rather than once
  at boot, since a runtime table has no "boot" to validate at.
- A runtime peer cannot be removed while a runtime route still forwards to it
  (`PeerRouteTableError::PeerInUse`) -- the same orphaned-row shape the load-time check exists to
  prevent, refused here at mutation time instead.

**Durability: a `state_dir`-scoped whole-table JSON snapshot, not an append-only log.**

`connector_runtime::PeerRouteStore` writes `<state_dir>/runtime-peers.json` on every mutation --
peers and peer-forwarding routes together, so the two can never fall out of sync with each other.
Unlike the two journals already living under `state_dir` (`peer-claims.log`, `client-edge-claims.log`),
this is a snapshot rewritten atomically (write to a temp file, `fsync`, `rename` over the target)
rather than an append-only log: this table supports removal, which an append-only log cannot
express without a compaction pass nothing else in this codebase needed. Every write is on the
operator-initiated, cold path (ADR 0015's exception to "no locking, no cloning"), so the O(n)
whole-table rewrite this costs is paid by nothing that runs per packet. An operator inspects the
current table at any time with `cat`/`jq` directly on the file -- no separate export tooling.

A node with no `state_dir` configured still has a mutable runtime table (`Connector::runtime_store`
is `Option`); it simply does not survive a restart, the same "degrade to in-memory-only, still
functional" shape every other `state_dir`-scoped store on `Connector` already takes.

**Priority ordering, for a prefix match against a lease at the same length.**

A runtime peer-forwarding route is durable and deliberate, unlike a lease, so it outranks a lease
at the same prefix -- extending the existing "a static route always outranks a leased route"
ordering (issue #427) rather than replacing it:

```
Leased (0) < RuntimePeer (1) < Peer, config (2) < App, config (3)
```

A runtime row can never collide with a config row at the same prefix (refused at write time,
above), so this ordering only ever has to disambiguate a runtime row against a lease -- it is not a
second precedence mechanism competing with "config always wins."

**Matching itself is unchanged.** `select_configured_route` still resolves the single longest
matching prefix; a runtime peer route is folded into the same lookup a config peer route already
goes through, priced by `client_route` exactly like one (it carries an explicit `price`, unlike a
lease, so it does not reopen the "an operator-pushed longer-prefix lease zeroes a configured
route's price" failure issue #557 exists to prevent). The only change is a new data source
feeding an unchanged algorithm.

## Consequences

- An operator can inspect precedence directly: `GET /peers` and `GET /routes/peers` tag every row
  with `source: "config" | "runtime"`, so which row would win a given write is never something to
  infer.
- Renaming or removing a config-file peer id or route prefix that a runtime row was refused against
  frees that key up for a runtime write on the next boot -- there is no permanent reservation, only
  a live one for as long as the config file names it.
- This does not change `PeerConfig`, `[[peers]]`, `[[routes]]`'s peer form, or any peer-carriage
  authentication machinery (endpoint, credential, exposure, dial). A runtime-added peer id has no
  effect on which BTP/HTTP connections this node accepts or dials -- that remains entirely
  config-file-driven, exactly as before #884. A route to a runtime-added peer id with no live
  carriage wired for it degrades exactly as a route to a _misconfigured_ config-file peer id
  already does: `PeerTransport` answers a synthesized `T01`, not a crash and not a silent drop.
  Wiring a sold peering into live carriage dial/accept machinery is explicitly out of this issue's
  scope (#867's later children, C2--C4: pricing, leasing/expiry, abuse bounds).

## Update (issue #1059) — the rule covered writes; boot is a separate case with a separate answer

This record says a colliding runtime row is _"refused outright rather than shadowing or being
shadowed."_ That is true of the **write** path — `Connector::upsert_runtime_peer` and
`upsert_runtime_peer_route` both check `config_peer_ids` and return `OwnedByConfig` before touching
the table. It has never been true of **load**, and load was never considered.

### What the binary does today

`Connector::with_runtime_peer_route_store` stores the loaded snapshot verbatim into its `ArcSwap`s.
There is no collision check at boot. Both rows exist, and `select_configured_route` picks between
them by `(matched prefix length, RouteRank)`, where `RouteRank` orders
`Leased(0) < RuntimePeer(1) < Peer(2) < App(3)` — so at equal prefix length the config row wins.

Three sequences follow, and only the first was ever described:

1. A runtime row exists; the config later gains the same key; restart. **Both load. The config row
   wins at packet time and the runtime row persists, inert.** That is shadowing — the thing this
   record's sentence disclaims.
2. The config owns a key; a runtime write for it is refused; the config later loses the key; restart.
   **Nothing returns**, because the refused write never persisted. Correct already.
3. A runtime row is shadowed as in (1); the config later loses the key; restart. **The shadowed row
   silently becomes live again** — a row an operator wrote months ago taking effect on a restart
   nobody connected to it.

### Decision

**On load, a runtime row whose key the configuration file owns is deleted, not shadowed.** The
deletion is written back to the snapshot, logged at `warn` naming the id or prefix and the snapshot
path, and counted.

Ownership therefore becomes **permanent** rather than a precedence that flips back. Sequence (3)
cannot arise: there is no shadowed row to revive.

### Why deletion, and not refusal to boot

Refusing to start is the more obvious reading of this record's original sentence, and it matches this
repository's habit of stopping by name rather than loading with something silently ignored (the
tombstone rule, ADR 0009). It was rejected on failure mode: **it lets an operator brick a serving node
by editing a configuration file**, with recovery requiring a hand-edit of the JSON snapshot on a box
that will not start. For a fleet, an outage is a worse outcome than a dropped row.

Deletion is also the more honest resolution of the underlying conflict. Both rows are operator intent,
but they are not equal: the configuration file is the **committed, reviewed** artifact that
[0041](0041-a-moving-tag-carries-the-fleets-committed-config-or-it-does-not-move.md)'s release gate
runs over, while a runtime row is an ad-hoc write over the operator surface. When an operator
overrides themselves, the reviewed artifact should win, and it should win permanently.

**Silence is the part that must not survive.** The status quo's defect is not that a row loses — it is
that nothing says so. A deletion that is logged and counted is recoverable in one operator action; a
shadowing that is not logged is a behaviour change waiting for an unrelated restart.

### Note on how this was ruled

Neither the record nor the binary had an answer here, so wayfinder map #1049's scope-based default —
_connector architecture, therefore the code wins and the record is amended_ — did not apply. The
record is extended to cover a case it never reached, **and** the behaviour changes. Issue #1060-adjacent
implementation work is tracked separately.
