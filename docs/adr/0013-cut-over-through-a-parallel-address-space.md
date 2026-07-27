# The Rust fleet runs in parallel under its own address space

The Rust connectors are deployed alongside the TypeScript ones, under a different ILP prefix,
fronting the same running relay and store apps. Both networks are live at once. Traffic moves
by changing a destination address, one client at a time, and the TypeScript prefix is deleted
once nothing addresses it.

## Why this is possible

Apps are payment-oblivious. An app is the HTTP service a connector POSTs local delivery to at
its `handler_url`; it returns success or failure and knows nothing about channels, claims or
settlement. A Rust connector can therefore be placed in front of an already-running relay or
store app without touching it, and the app cannot tell which connector is in front of it.

> **That last clause is conditional on a conformance this ADR never named** (#492). It is true of
> two connectors that both implement client edge version 1. The Rust connector does not yet: it
> implements §1.1 only, so it reads no envelope, derives no request target, injects none of the
> `X-TOON-Payer`/`X-TOON-Amount`/`X-TOON-Chain` headers both apps read, and charges nothing. Until
> #498 lands, an app _can_ tell, and a migrating client would be moving onto a free, anonymous
> network.
>
> The mechanism below is unaffected — a parallel prefix, both fleets live, migration by repointing
> — and was demonstrated working. Evidence in
> [`docs/operators/parallel-fleet-comparison.md`](../operators/parallel-fleet-comparison.md); the
> reasoning in [ADR 0016](0016-payload-opacity-is-a-property-of-carriage.md).

This removes the flag day that ADR 0003 accepted as the cost of a clean-room peer wire. The two
peer wires never have to interoperate, because the two networks never have to be one network.
Nothing speaks the old protocol except the old fleet, which continues to work until it is
switched off.

## Consequences

Rollback is changing a destination string, and the old fleet remains available as a control for
comparing behaviour under identical conditions rather than against memory.

Every client that migrates must open and fund a payment channel with the new apex, because a
channel is bilateral and does not follow an address change. Migration therefore costs each
client an on-chain transaction, which is the main friction in this approach and the reason to
migrate deliberately rather than all at once.

`swap`, `town` and `mill` migrate individually. Each moves from an in-process `ConnectorNode` to
an HTTP client at the moment it repoints, and any one of them can sit on the old fleet while the
others have moved.

Two address spaces exist for as long as the migration lasts, and the temporary prefix is
disposable by design — it exists to be deleted, and nothing durable should be published against
it.

The conditions for recognizing that moment — what must be observably true of traffic, clients
and channels before the old prefix is deleted, and what is irreversible if they are wrong — are
written down in
[`docs/operators/prefix-retirement-checklist.md`](../operators/prefix-retirement-checklist.md).
