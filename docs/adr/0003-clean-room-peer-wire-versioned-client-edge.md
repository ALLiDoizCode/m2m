# The peer wire is redesigned freely; the client edge is versioned

**Status:** Partly superseded by [0027](0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md). The **peer-wire half is dead** — the raw-TCP wire is deleted from `crates/`. The **client-edge half is Accepted** and unchanged: the edge is versioned, edge complexity is paid twice. The `POST /ilp/v{N}` seam is **unexercised, not unbuilt** — per `client-edge-spec.md` §3.1 the unversioned `/ilp` _is_ version 1 by definition, and a version-qualified path only becomes necessary on a version 2 that has never existed. Amended by issue #1054: version discovery moves to the node self-description, and the scheme's silence on BTP is recorded as an open question with a trigger.

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

> **Partly superseded (2026-08-03) by
> [ADR 0027](0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md).** The
> **peer-wire half** of this ADR is reversed: connectors peer over BTP (RFC-0023) on `wss://`
> URLs and the raw-TCP wire is deleted. The premise below — _"Both ends of the peer wire are
> operator-controlled"_ — expired when an open market (`toon-meta#262`, `#265`) made a
> third-party connector a real participant, and raw-TCP peering cannot reach one behind NAT.
> The **client-edge half** of this ADR — the edge is versioned, edge complexity is paid twice —
> stands unchanged.

The connector has two protocol surfaces with opposite change economics, and treating them as
one protocol has been costing us design freedom on the half that doesn't need protecting. We
are redesigning the peer wire from scratch and freezing nothing, while the client edge gains
explicit versioning so old versions keep working alongside new ones.

## Why they differ

Both ends of the **peer wire** are operator-controlled: our own connectors, on our own boxes
and in our own images, all becoming Rust. Changing it costs a fleet restart, so BTP is not
worth preserving as a constraint on the design.

The **client edge** terminates on machines we do not control. `toon-client`'s MCP server ships
as an `.mcpb` bundle installed into Claude Desktop and as a Claude Code plugin. There is no
date on which every installed client updates, so a breaking edge change is not a flag day —
it is an outage of unbounded duration.

## Consequences

The client stays TypeScript permanently, because it lives inside a host application we do not
build. Any protocol we design for the edge is implemented twice — once in Rust, once in
TypeScript — so edge complexity is paid twice and should be minimised on those grounds alone.

The peer wire's flag day still costs a coordinated cutover across `connector`, `relay`,
`store`, `swap`, `town`, `mill` and both devnet boxes. That is accepted.

Anything published and persisted outside the fleet is treated as edge, not peer. `kind:10032`
announcements carrying `ilpAddress`, `assetScale` and endpoint data already sit on devnet
relays, and `genesis-peers.json` is a committed bootstrap seed other repos consume — so the
address scheme cannot be changed on peer-wire terms just because it is used on the peer wire.

## Update (issue #1054) — what is unexercised, where discovery lives, and the hole in BTP

Three corrections, none of which disturbs the decision.

**1. The client-edge half is not contradicted by the binary.** The index has read
"the `POST /ilp/v{N}` seam was never built; the edge serves `/ilp` unversioned" as a defect. It is
not one. `client-edge-spec.md` §3.1 says the unversioned path "is kept forever as a **permanent
alias for `v1`** — a client that never adopts versioning is a `v1` client by definition and is never
asked to change." Serving `/ilp` unversioned _is_ this scheme's version-1 behaviour. The additional
machinery costs nothing until a version 2 exists, and none ever has.

The reasoning behind the decision is unchanged and unarguable: the client edge terminates on
machines this project does not control, so "a breaking edge change is not a flag day — it is an
outage of unbounded duration."

**2. `GET /ilp/versions` is retired before it was ever built; version support moves to the node
self-description.** `client-edge-spec.md` §3.2 describes that endpoint in the present tense and
returns a worked example, and a client SDK following the spec's own "SHOULD call this once" receives
a 404. Rather than build a third surface describing this node — after the greeting and the
kind:10032 announce — the supported-version set becomes a **field on the self-description document**
(issue #1060), which a `GET` on the connector's URL already resolves to. Transport requirement and
version support are the same kind of fact — what this node speaks — and belong in the same place.
§3.2 is rewritten to point there.

**3. The scheme does not cover BTP, and nothing has noticed because there is no version 2.**
§3.3 states that "the path is the entire agreement." A BTP client's path is `/ilp/btp`, a websocket
upgrade carrying no version segment and having no analogue to a version-qualified path. The client
edge has two carriages and this scheme addresses one.

**This is deliberately not decided here.** Designing a version-selection mechanism for BTP with no
version 2 to test it against would be speculation, and the candidates — a version segment on the
upgrade path, a `Sec-WebSocket-Protocol` subprotocol token, or declaring BTP version-1-only — differ
in ways that only a real second version would settle.

> **Trigger.** This question MUST be answered before any client edge version 2 ships, on either
> carriage. A version 2 introduced on HTTP alone would leave BTP clients with no way to select it and
> no way to discover that they cannot — the exact failure `requiredTransport` already produced once
> (enforced long before it was advertised, refusing every relay publish).

**Also noted, and owned elsewhere:** §2 and §3.4 both hang on [ADR 0013](0013-cut-over-through-a-parallel-address-space.md),
which is spent — the old fleet was switched off (#872), so "the old fleet stays up until nothing
addresses its prefix" refers to nothing. Repairing `docs/protocol/` prose is issue #1065's scope.
