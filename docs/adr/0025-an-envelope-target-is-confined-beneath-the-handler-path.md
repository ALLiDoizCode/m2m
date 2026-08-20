# An envelope target is confined beneath the route's handler path, never in place of it

**Status:** Accepted, amended in place by issue #621. Live: `resolve_target_under_handler` in `connector-runtime/src/app_client.rs`.

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

`HttpAppClient::deliver` (`crates/connector-runtime/src/app_client.rs`) resolved a sealed
envelope's `target` against a route's `handler_url` with plain RFC 3986 reference resolution
(`Url::join`). An **absolute** path in `target` replaces the base's own path under that algorithm
rather than extending it, so a route configured at `handler_url = "http://relay:3100/write"`
delivered a target of `"/"` to `http://relay:3100/` and a target of `"/admin"` to
`http://relay:3100/admin` -- neither of which the operator published, and neither of which was
priced at what the sender paid.

## Why this is a pricing defect, not only a routing one

ADR 0020 makes pricing granularity handler granularity: one handler, one price, and an operator
who wants to charge differently for different work exposes a handler per price. That only holds if
a packet cannot choose its own handler. Before this issue, it could: an operator publishing a cheap
`/health` route and an expensive `/write` route on the same origin was, without knowing it, selling
`/write` at `/health`'s price to any sender whose envelope named it as the target --
`Config::load`'s `ConflictingHandlerPrice` guard (`crates/connector-config/src/route.rs`) only
catches two routes sharing one _exact_ `handler_url` string, not two routes on the same origin at
different paths.

## Decision

**A route's configured handler path is authoritative.** `target` is resolved _beneath_ it by
straightforward concatenation -- `resolve_target_under_handler` in `app_client.rs` -- never by
RFC 3986 merge-and-remove-dot-segments, which is exactly the algorithm that lets an absolute path,
a scheme or an authority in a relative reference replace the base instead of extending it.

**`""` and `"/"` both mean "the handler's own path, nothing appended."** This is deliberate, not an
oversight: a client with exactly one endpoint on its app addresses it with an empty or bare-slash
target, and neither can ever displace the configured path the way an arbitrary absolute path could,
because both are special-cased to resolve to `handler_url` unchanged rather than being parsed as
"replace the path with `/`".

**Any other value beginning with `/` is refused**, along with a `.`/`..` path segment, a scheme
(`javascript:`, `http:`, ...), an authority (`//host`, itself just another `/`-prefixed string), a
backslash, or a percent-encoded form of any of those (`%2e%2e`, `%2Fadmin`, `%5c`). The check runs
against `target`'s fully percent-decoded form, so an encoded equivalent cannot smuggle a traversal
past a check that only looked at the literal characters -- and a scheme prefix survives decoding
unchanged, so the decoded form is sufficient for that case too. Refusal happens before any HTTP
request is attempted -- the app is never reached, so a refused target costs the payer nothing (see
Pricing below).

**A backslash is refused outright**, not merely treated as a second separator. RFC 3986 gives `\`
no meaning inside a path, but the WHATWG URL parser the `url` crate implements treats it as a path
separator for a special scheme (`http`/`https`) _and_ applies dot-segment removal while doing so.
So `..\admin` against a handler at `/write` normalizes out to `/admin` -- the same escape as
`../admin`, but invisible to a check that splits only on `/`, and reachable in encoded form as
`%2e%2e%5cadmin`. There is no faithful reading of a backslash left to preserve (the target
delivered could never be the target the sender wrote), so the whole class is refused rather than
normalized.

**Multi-endpoint addressing survives.** ADR 0018 and issue #521 are explicit that an envelope's
target must remain expressive enough to address more than one endpoint on an app. A relative target
with no leading `/` -- `"orders/42"` against a handler at `/write` -- resolves to
`/write/orders/42`: nested under the route's own path, never beside or in place of it.

**`FakeAppClient` enforces the identical rule.** Per ADR 0007 a fake must genuinely uphold the
contract it stands in for; both `AppClient` implementations call the same
`resolve_target_under_handler`, so a test written against the fake exercises the same confinement
behaviour the real HTTP client would.

## Pricing

`AppOutcome` gains a third variant, `Refused`, distinct from `Answered` (the app responded, even
with a 404, and that rides home on a FULFILL) and `Unreachable` (the app could not be reached over
the network). `Connector::deliver_opened_envelope` maps `Refused` to a reject coded `F00` (Bad
Request) -- previously unused in this codebase -- with `accumulated_cost: 0`, matching
`Unreachable`'s own reasoning (issue #545): the app never did any of the priced work, so nothing
accumulates. `F00` is distinguishable from `F01` (the envelope itself failed to decode) and from an
app's own answer (never a reject at all), which is what lets a sender tell "your envelope named
somewhere this route does not expose" apart from either.

## Consequences

Two routes on the same origin at different prices can no longer be reached through one another:
resolving a target against a route's own `handler_url` can only ever produce a URL nested under
that route's own path, never a sibling or parent path another route happens to be configured at.

Every envelope target already written in this workspace's own tests and fixtures used either an
absolute path equal to the literal fixture string `"/"` (unaffected -- still means "the handler's
own path") or an absolute sub-path such as `"/orders"` (updated to the relative form `"orders"`,
since an arbitrary absolute path is now refused regardless of what it names). No production client
constructs an envelope yet (issue #500's survey), so this is not a wire compatibility break against
anything deployed.

`infra/linode-node/connector-rust.toml` and `infra/linode-store/connector-rust.toml` both carried a
comment asserting the connector "takes no path from the packet" -- true of the bare `handler_url`
before #492, but never true of `target`, which this issue closes the gap on. Both comments are
corrected to describe what the connector now actually does: `target` is confined beneath the
configured handler path rather than taking no path at all.

## Amendment (issue #621): the literal restatement of the handler's own path is accepted

"No production client constructs an envelope yet" stopped being true when the published rig CLI
(`@toon-protocol/rig`, via `@toon-protocol/client`) began uploading git objects through the Rust
edge with the TypeScript fleet's convention: an envelope target of `'/store'` addressed at a route
whose handler is configured at that same `/store` path. Refusing it defended nothing -- a target
that restates `handler_url.path()` character for character cannot name anything the route does not
already serve -- while breaking every deployed uploader against the store leg (#600).

So `resolve_target_under_handler` accepts exactly one absolute form: the literal,
character-for-character restatement of the handler's own configured path, which resolves to that
path -- the same meaning as `""` and `"/"`. Everything else this decision refuses stays refused:
any other absolute path, `..`/`.` segments, schemes, authorities, backslashes, and every
percent-encoded spelling INCLUDING the encoded form of the handler's own path (`%2Fstore` is an
escape probe, not a restatement). The invariant this ADR exists for is unchanged: resolution can
never produce a URL the route's configuration does not already name.
