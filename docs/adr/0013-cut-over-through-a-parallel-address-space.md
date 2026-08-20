# The Rust fleet runs in parallel under its own address space

**Status:** Partly superseded by [0017](0017-the-typescript-connector-is-a-prototype.md) (the comparison half), and otherwise **spent**: the parallel fleet was switched off (issue #872), and no `infra/` config carries the temporary prefix any more. Kept for the migration mechanism and for the record of what the first deployment falsified.

**Scope:** fleet and operations — not connector-internal, not wire law. See the [ADR index](README.md).

The Rust connectors are deployed alongside the TypeScript ones, under a different ILP prefix,
fronting the same running relay and store apps. Both networks are live at once. Traffic moves
by changing a destination address, one client at a time, and the TypeScript prefix is deleted
once nothing addresses it.

## Why this is possible

Apps are payment-oblivious. An app is the HTTP service a connector POSTs local delivery to at
its `handler_url`; it returns success or failure and knows nothing about channels, claims or
settlement. A Rust connector can therefore be placed in front of an already-running relay or
store app without touching it, and the app cannot tell which connector is in front of it.

> **The first deployment falsified that last clause** (#492). The two connectors do not deliver
> alike — the TypeScript one reads an HTTP envelope out of `prepare.data` and sends
> `X-TOON-Payer`/`X-TOON-Amount`/`X-TOON-Chain`; the Rust one treats `prepare.data` as an opaque
> body and sends none of them. The relay and store both read those headers, so an app _can_ tell,
> and loses payer attribution behind the Rust fleet.
> [`docs/operators/parallel-fleet-comparison.md`](../operators/parallel-fleet-comparison.md) has
> the evidence. The rest of this ADR stands.
>
> The premise is not closed by making the two deliver alike. ADR 0017 withdraws the conformance
> target, and ADR 0020 with `CONTEXT.md` decides the app is told nothing about the payment at all —
> not who paid, not how much, not on what chain — so those headers have no successor rather than a
> Rust reimplementation (#505). What makes a migration safe is the new fleet being good enough on
> its own terms, which is the supersession recorded under Consequences below.
>
> **The headers did get a successor, three months later** (#994,
> [ADR 0040](0040-a-verified-payment-is-stated-to-the-app.md)): the Rust connector states
> `X-TOON-Payer`/`X-TOON-Amount`/`X-TOON-Chain` for a payment it verified itself, sourced from the
> admitted client claim rather than from the previous hop or the destination address. So the
> falsified clause above — "the app cannot tell which connector is in front of it" — is now false
> in a second way, and it no longer costs the app its attribution. The parallel fleet this record
> is about was switched off long before that (issue #872); nothing here changes.

This removes the flag day that ADR 0003 accepted as the cost of a clean-room peer wire. The two
peer wires never have to interoperate, because the two networks never have to be one network.
Nothing speaks the old protocol except the old fleet, which continues to work until it is
switched off.

## Consequences

> **The comparison half is superseded by [ADR 0017](0017-the-typescript-connector-is-a-prototype.md).**
> The mechanism below stands — a parallel prefix, both fleets live, migration and rollback by
> repointing a destination — and survives as a _migration_ mechanism. What does not survive is the
> old fleet's role as a control: the TypeScript connector is a prototype rather than a reference
> implementation, so the cutover is judged by whether the new fleet is good enough, not by measured
> parity with the old one. The premise this ADR assumed but never named — that an app cannot tell
> which connector is in front of it — was false when written (#492) and is not what makes the
> cutover safe.

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
The concrete box-by-box execution of that deletion on the devnet fleet's two boxes — exact nginx
edits, verification and rollback — is
[`docs/operators/rust-cutover-runbook.md`](../operators/rust-cutover-runbook.md).
