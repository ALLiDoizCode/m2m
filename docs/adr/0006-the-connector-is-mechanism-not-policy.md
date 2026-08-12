# The connector is mechanism; discovery and route policy live outside it

**Scope:** connector architecture — internal to this codebase. See the [ADR index](README.md).

The connector forwards what it is told to forward and settles what it is told to settle. It
does not decide who its peers are, does not learn routes, and does not announce itself.
Discovery is removed entirely; the operator surface exposes CRUD over the routing table and
over payment-channel lifecycle, and an external controller drives both.

## What this removes

All 4,028 lines of `discovery/`, plus `routing/link-state-db.ts` and
`routing/path-computation.ts` — the link-state database and Dijkstra belonged to route
learning, not to forwarding. With them go the `nostr-tools` dependency, NIP-06 key
derivation, NIP-40 expiry handling, the relay WebSocket client, the bootstrap seed list, the
learned-relay cache, the signed seed manifest and its pinned curator key, and the paid
self-announce write path.

`PeerDiscoveryService` was already dead — exported from `discovery/index.ts` and never
constructed — and is not carried forward under any name.

## Why

Discovery is a routing protocol that happens to use Nostr as its flooding substrate. Bundling
it into the forwarder made the forwarder untestable without a relay, gave one component
privileged in-process access to the routing table that no external caller had, and coupled
the connector to a stack it otherwise has no reason to know about. Splitting them makes
routing a pure function of state that can be set directly, and forces the operator API to be
complete because nothing can reach around it any more.

## Consequences

**Route withdrawal must be preserved, so routes are leased.** Static routes come from config,
persist across restarts, and always win. Dynamic routes are pushed through the operator API
with a TTL and lapse unless renewed. This keeps the safety property that route learning
provided — a peer that stops being refreshed loses its routes — without the connector knowing
why. A controller that dies causes routes to expire rather than to rot, and a stale route
pointing value at a peer that can no longer deliver is the failure this prevents.

**Extended, not replaced, by issue #884.** A sold peering (#867) is a deliberate, paid
relationship rather than an automated controller's push, so it needs a third shape beside
"static, from config" and "leased, TTL-bound": runtime-mutable AND durable. ADR 0034 adds it
without disturbing either existing one — "static routes... always win" still holds; a runtime
row can never take a key the config file owns.

**Nothing announces any more, and that gap is now external.** An empty bootstrap seed
previously produced hardcoded address literals and 404s for new users. Self-announcement and
route learning are moved, not dropped, and the component that owns them has to exist
somewhere else before the network can grow past its static configuration.

**The operator API is now money-critical.** Route CRUD decides where value goes, and channel
operations move funds. It requires real authentication and audit, on the same footing as the
settlement code — not the shared-token treatment an inspection API would deserve.
