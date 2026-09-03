# The configuration schema is implementation detail; what an operator can express is law

**Status:** Accepted. Sharpens [0009](0009-one-typed-config-file-no-environment-layer.md) by stating what its `**Scope:**` line already implied, and settles two questions the configuration territory was blocked on: the tombstone rule's status, and the operational knobs'. Depends on nothing; the specification work it governs is wayfinder map #1049's territory 1.

**Scope:** connector architecture — internal to this codebase. See the [ADR index](README.md).

**A second implementation of this protocol is not required to read this connector's configuration
file.** It is required to be configurable to _do_ the things this connector can be configured to do —
expose these carriages, hold these channel roles, price a route per handler, refuse these collisions.
The configuration specification states **capabilities**, from the operator's side. The TOML schema —
table names, key names, types, defaults — is this implementation's business.

## Why

The tempting alternative is to publish the schema as law, so an operator could move a config file
between implementations. That use case is thinner than it sounds: an operator runs one connector, not
two, and freezing ~22 keys means every future addition becomes a protocol change.

The decisive argument is that **the facts a counterparty can actually observe are already law
somewhere else, and none of them are law _as TOML_.**

Sort the keys by who can tell:

|                                                           | keys                                                                                                                                                                                    | who can tell               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **Published** — stated on the wire                        | `[[routes]]` prices and prefixes, `[settlement.*]`, the `[signer]` identity, `[announce]`'s addresses and BTP endpoint                                                                  | any client, by asking      |
| **Behaviourally observable** — not stated, but detectable | `[[peers]]` fee and cap (via `T04`), `[[peer_channels]]`/`[[client_channels]]` (a claim verifies or does not), `peer_expose`, `[[client_identities]]` (via `401`), `btp_session_window` | a counterparty, by trying  |
| **Invisible**                                             | `client_edge_addr` (a bind address, not the public URL), `state_dir`, `[operator]`, the three `channel_*` timing knobs, the four `unresolvable_lookup_*` shaper knobs                   | nobody outside the process |

Every entry in the first two rows is binding — but as a **behaviour** and as a **published field**,
specified in the packet-flow, payment and self-description territories where it belongs. A peer must
learn that this hop charges a fee and refuses an over-cap packet with `T04`; it must not have to learn
that the fee is spelled `fee` inside a table spelled `[[peers]]`. Dragging the spelling along with the
semantics buys nothing.

**Published and configurable are independent axes**, and conflating them is what made this question
look hard. `sessionLeaseTtlMs` is the proof: the client edge publishes it in every greeting, and it is
not a config key at all — it is `connector_client_edge::session_registry::SESSION_LEASE_BACKSTOP_TTL`,
a constant. A value can be protocol law without being configurable, and a key can be configurable
without being protocol law.

**The conformance mechanism has already voted.** The behavioural vector format (issue #1051) makes a
vector's `given.node` a _named situation_ — `"priced-termination"`, `"static-and-leased-collide"` —
resolved through a shared fixture table, rather than an inlined configuration. That indirection exists
precisely so a vector does not depend on the schema. If the schema were law, the indirection would be
pointless.

And [0009](0009-one-typed-config-file-no-environment-layer.md) is already scoped _"connector
architecture — internal to this codebase"_. This record states the consequence rather than changing
the scope.

## Consequences

**The configuration specification is a capability specification.** It enumerates what an operator must
be able to express and what the connector must refuse, not what the file looks like. A second
implementer reading it learns the obligations; how they spell them is theirs.

**The tombstone rule is a local convention, not protocol law — and loses none of its value.** _A
removed configuration key is never silently dropped_: `peer_wire_addr`, `ceiling`, `flush_interval_ms`,
`[peer_sale]`, and now `apex`/`[[children]]` (issue #1057) are parsed solely so a node whose committed
TOML still sets one stops at boot **by name**. That rule protects _this_ implementation's operators
from a file that silently changes meaning. It binds nobody else because nobody else has these keys.
It is stated in the configuration document as a convention of this implementation, and
`crates/connector-bin/tests/refuses_to_start.rs` remains its proof.

**The operational knobs are local by construction.** `unresolvable_lookup_budget_per_signer`, `_total`,
`_window_secs`, `_max_wait_ms`, `channel_liveness_ttl_secs`, `channel_serve_stale_secs` and
`channel_reattempt_interval_ms` shape this connector's own resource use and are visible to nobody. They
belong in an operator's guide, not in a protocol specification.

**`btp_session_window` is the one case that splits.** A concurrency window is observable to a
counterparty, so **the existence of an in-flight limit and what a connector does when it is exceeded
are protocol law** and belong to the client-edge territory. The knob that sets it is local. This is the
general shape of the split, not an exception to it: the _limit_ is law, the _number_ is policy.

**What is given up: config portability.** Two implementations cannot share an operator's file. If that
ever becomes a goal, this record is what must be reopened — and it is far cheaper to adopt the
alternative before the specification is written than after.
