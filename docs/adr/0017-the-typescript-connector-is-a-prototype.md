# The TypeScript connector is a prototype, not a reference implementation

**Scope:** fleet and operations — not connector-internal, not wire law. See the [ADR index](README.md).

The Rust connector implements a wire of its own design and never client edge version 1. ADR 0016's
ruling that it must implement v1 as written is superseded. That ADR's other half — opacity is a
property of carriage — stands, and ADR 0018 strengthens it.

## Context

ADR 0016 decided that "the Rust connector must implement client edge version 1 as written", that
conformance is "a property of the _wire_: identical observable behaviour", and that the TypeScript
implementation is "a reference for behaviour, never a target to copy". That rested on ADR 0013,
whose parallel-fleet cutover is proven by running both fleets and comparing them under identical
conditions.

Writing down what v1 actually specifies made the price of that visible. The format survives only as
compiled JavaScript (`packages/connector/dist/core/handlers/http-proxy-handler.js`, its source
deleted in `c4a4ad1`), and what it defines was not designed so much as accumulated:

- The envelope is an HTTP/1.1 request as latin1 text, hand-parsed. A payload with no `CRLFCRLF`
  silently yields an empty body; blank header lines are skipped; spaces are tolerated inside the
  request target. None of these leniencies were chosen, and all of them are now contract.
- `X-TOON-Payer` carries `LocalDeliveryRequest.sourcePeer` — the immediate previous hop. RFC-0027
  has no source address, so on any path longer than one hop the header names the wrong party, and
  the relay's per-write attribution record is wrong with it. It looked correct only because the
  deployed path was one hop.
- `X-TOON-Chain` is derived from the second label of the destination address, and is set only when
  that resolver returns something — so a payer-supplied value can survive into an app that trusts
  the header as connector-asserted.
- A route carried a flat `price` of `1000` while the relay behind it priced per byte with per-kind
  overrides. Two pricing systems, neither consulting the other.

ADR 0016 said "its quirks are the contract". Written down, the quirks are defects.

## Decision

**The TypeScript connector is a prototype.** It is not a reference implementation, its wire is not a
conformance target, and the Rust connector implements neither version 1 nor a compatibility path to
it.

ADR 0016's conformance half is superseded. Its first half — a forwarding hop never interprets a
payload, a terminating one does — survives unchanged, and ADR 0018 makes it structural rather than
advisory.

## Considered options

**Implement v1, then a v2 with the properties we want.** Preserves ADR 0013's comparison and lets
clients migrate on their own schedule. Rejected: it means building, at full fidelity including the
defects above, a wire we have already decided is wrong — in order to prove parity with a prototype.

**Implement v1 only, and defer the rest.** Rejected for the same reason, without the eventual
payoff.

## Consequences

The parallel-fleet comparison is abandoned. `crates/connector-bin/src/fleet_compare.rs` (596 lines)
and `crates/connector-bin/tests/fleet_compare_two_local_fleets.rs` (239 lines) exist to produce
evidence that no longer has a consumer, and should be deleted rather than maintained. ADR 0013's
parallel address space survives as a _migration_ mechanism — clients move when they choose — but the
cutover is judged by whether the new fleet is good enough, not by measured parity with the old one.

Every existing client is rewritten: `@toon-protocol/connector` (published at 4.0.0, consumed by
`swap`), toon-client's daemon, and `rig`. That work lives in three other repositories and is not
optional.

Nothing is versioned. ADR 0003's `POST /ilp/v{N}` remains a seam with zero adapters — this fleet
serves exactly one wire. Versioning becomes a live question the first time that wire has to change
underneath deployed clients, and not before.
