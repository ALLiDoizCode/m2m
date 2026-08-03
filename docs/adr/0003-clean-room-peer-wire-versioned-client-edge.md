# The peer wire is redesigned freely; the client edge is versioned

> **Partly superseded (2026-08-03) by
> [ADR 0027](0027-connectors-peer-over-btp-and-the-raw-tcp-peer-wire-is-deleted.md).** The
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
