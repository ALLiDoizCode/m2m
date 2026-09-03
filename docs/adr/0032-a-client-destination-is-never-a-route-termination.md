# A client destination is never a route termination

**Status:** Accepted. Bounds [0018](0018-a-payload-is-sealed-to-the-terminating-connector.md) and [0019](0019-a-terminating-connector-derives-the-fulfilment.md). Live: `session_route::route_prepare`.

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

ADR 0018's "sealed to the terminating connector" and ADR 0019's "the terminating connector derives
the fulfilment" describe a **route termination** -- a `[[routes]]` entry with a `handler_url`, the
store and relay pattern. They do not extend to a destination that resolves to a live **client
session** (issue #698's lease). This is a scope clarification of both, not a reversal of either.

## Context

toon-meta#265 (mesh-compute earning, decision 6) puts a BTP client behind a destination that
receives paying PREPAREs: a laptop selling GPU inference, addressable at its own `ilp_dest`
(toon-meta#266 §3.1), reachable only because issue #698 gave a bound client session a routable
address. That client holds the preimage the completion was encrypted under (toon-meta#266 §6.1's
`hashlock-delivery.ts`) and derives its own fulfilment (§7). Nobody else can, or is meant to.

ADR 0019's rule reads, on its own, as if it covers every terminating destination: "the terminating
connector derives the fulfilment ... from the shared secret the sender sealed to it." A client
destination is not that -- it never receives the gift wrap's shared secret at all, because it is
never sealed to a connector's identity key in the first place (toon-meta#266 §3.1's `seal_pubkey`
is the _seller's_ key, learned off a signed Nostr event, never a connector's). Reading ADR 0019 as
covering it anyway is the "natural wrong assumption" toon-meta#266 §7 warns about: a seller wired
by mistake as a `[[routes]]` app -- pointing `handler_url` at the same local ingress a `kind:5098`
job handler serves -- would still get paid, because `Connector::deliver_opened_envelope`
(`crates/connector-runtime/src/connector.rs`) derives a fulfilment from a shared secret regardless
of what the app answered (ADR 0020: "value moves whenever the app answered, whatever it
answered"). The buyer's hashlock would silently stop being a hashlock, and the buyer would be
trusting a connector operator it never chose to relay a completion honestly -- exactly the trust
ADR 0018/0019 exist to remove for a route termination, reintroduced at a destination those ADRs
were never written to cover.

Before this issue, nothing in code drew the line. `connector-client-edge/src/session_route.rs`'s
`route_prepare` -- the one convergence point `POST /ilp` and the BTP carriage both call through,
per ADR 0026 -- resolved an overlap between a configured app route and a bound session by silent
precedence: "a configured route always wins" (issue #736), unconditionally. A test pinned exactly
this (`a_configured_app_route_is_never_shadowed_by_an_overlapping_session`, since rewritten): bind
a session and a `[[routes]]` app at the same address, and the app answered every time, deriving a
fulfilment the client's own preimage was supposed to gate.

## Decision

**A route termination and a client destination are different surfaces of the same connector, and a
destination is never allowed to be both.**

- A destination that resolves to a live client session (issue #698's lease) **MUST** be delivered
  to that session. The connector **MUST NOT** locally terminate it and **MUST NOT** synthesize or
  derive a fulfilment for it -- the fulfilment comes back from the client, verified against the
  packet's own execution condition exactly as a peer's relayed fulfilment is (issue #417), or the
  packet is rejected.
- A destination that resolves to **both** a configured app route (ADR 0019's terminus) and a live
  client session is a **reported configuration error**, not a precedence question. There is no safe
  default here: letting the app route win reintroduces the derived-fulfilment hole this ADR closes;
  letting the session win would let a client shadow an operator's own routing table, which issue
  #736 already established a configured route must never be. `session_route::route_prepare` answers
  `T00` (Internal Error -- through no fault of the packet, ADR-worthy language already used for
  exactly this class of "this connector's own state is wrong," never `F02`/no-route or a fulfilled
  answer) and logs the overlap at `error` level, before either the app or the session is reached.
- A destination that resolves to a **forwarding** route (a `peer_id` entry, or a leased route,
  ADR 0028) and a live session is unaffected by this ADR: a forwarding hop never derives a
  fulfilment locally, so the existing "a configured route always wins" precedence (issue #736)
  still applies, unchanged.

For a client destination specifically, per toon-meta#266 §7's ordering: the buyer's connector seals
the PREPARE's `data` to the seller's `seal_pubkey` (a key carried on a signed Nostr event, never a
connector's `GET /identity`, per ADR 0022); the seller -- the BTP client itself -- unseals it with
its own private key, and derives the fulfilment from the symmetric key it already minted to encrypt
the completion (toon-meta#266 §6.1's `key`), not from anything ADR 0018's gift wrap carries. The
sealing in that flow provides confidentiality and authenticity for the PREPARE's payload; it is a
mechanism entirely separate from the hashlock preimage, and the two must not be conflated.

## Considered options

**Extend ADR 0019 to say client sessions are terminations too**, and let the connector derive their
fulfilment the same way. Rejected outright: it is the exact failure this ADR exists to prevent --
the client holds the only preimage a buyer's hashlock is meant to be gated on, and a connector that
can derive one on the client's behalf makes the hashlock decorative.

**Resolve the overlap by precedence** (session wins, or app route wins), rather than refusing it.
Rejected: either direction is silently wrong for someone. Session-wins shadows an operator's own
`[[routes]]` table with a client that happened to bind the same address (issue #736's regression).
App-route-wins is the derived-fulfilment hole this ADR closes. A configuration error that never
should have been reachable in the first place has no principled default; refusing it is the only
answer that is safe in both directions.

**Make the seller a peer instead of a client destination**, sidestepping the ambiguity by using a
surface (ADR 0027's peer wire) that already forwards rather than terminates. Rejected per
toon-meta#265's own guidance (issue #699's trap): a peer wire needs inbound reachability, which is
the entire problem the client-edge session registry (#698) exists to route around for a NAT'd
laptop.

## Consequences

`session_route::route_prepare` gains one more check ahead of its existing session-vs-`F02`
fallthrough: a destination is checked against `Connector::client_route`'s `Terminated` kind
_before_ `handle_prepare` or the session registry is touched at all, so neither is ever reached on
the conflicting path. `Connector::client_route` already excludes leased routes (issue #427) from
its answer, so this check is automatically scoped to configured app routes only, matching this
ADR's forwarding-route carve-out with no separate logic.

An operator who overlaps a `[[routes]]` prefix with a client's bound address now gets a loud,
retryable `T00` on every packet to that address instead of the packet quietly working. This is the
point: the mesh-compute market (toon-meta#265) depends on the boundary holding, and a silent
success on the wrong topology is exactly the "cheap to prevent and expensive to discover" failure
the epic named.

Nothing about an existing terminated route (store, relay) changes: neither of those addresses has a
client session ever bound to it, so this ADR's new check never fires on their traffic, and their
own tests are untouched.
