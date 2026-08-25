# A behavioural rule is normative prose until its vector lands, and the debt only shrinks

**Status:** Accepted, **not yet built** — no rule is classified, no vector names a rule id, and the debt literal decision 4 requires does not exist. **The blocker this line used to name is spent:** it said the gate "cannot be written until [0021](0021-vectors-are-normative-prose-is-not.md)'s successor doc set exists (issue #1065)", and that doc set has landed — see the [Update](#update-2026-08-25--the-doc-set-landed-and-the-rule-ids-with-it) at the foot. Amends [0021](0021-vectors-are-normative-prose-is-not.md) in two places: it adds a bounded prose tier, and it corrects 0021's claim that vectors are generated from property tests.

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

**Falsifier:** `crates/**/*.rs` matching `\brule_id\b` — Consequences below: "A vector must name the rule it covers. This is new work for the vector format." No vector names one today, so a `rule_id` anywhere in the crates means the classification this record specifies has begun and its "not yet built" is stale.

A behavioural rule of this protocol is stated as a **numbered rule** in prose, and that prose is
**normative until a vector covers the rule, and no longer**. Every numbered rule is classified —
covered, or carrying an inline debt marker — and the count of uncovered rules is committed and may
only decrease. Byte-level facts are unaffected: they were vector-normative before this record and
remain so.

## Why this record exists at all

[ADR 0021](0021-vectors-are-normative-prose-is-not.md) is read as saying "bytes are normative,
behaviour is not specified." That is not what it says, and the difference is the whole of this
record.

0021's Decision opens **"The Rust implementation is the definition."** Vectors are how that
definition is exported to `toon-client`, `rig` and `swap`; they were never the definition itself.
And its Consequences name the properties worth stating: "envelope round-tripping, decode rejecting
every malformed input, a derived fulfilment satisfying the condition the sender minted, **cost
summing across a path**." The last of those is behaviour, not encoding.

So 0021 is not a two-tier record that stopped at bytes. **It is a one-tier record that was only
half-built.** The committed set covers `envelope`, `giftwrap`, `fulfilment`, `claim`,
`peer_carriage` and `channel_control_declaration`; `peer_carriage` alone carries behavioural cases
(`reject_with_cost`, `minimum_delivery_absent`, `minimum_delivery_malformed`,
`forwarded_data_unchanged`, `ack_rejected_reasons`). Nothing covers the client edge as a carriage.

That leaves a gap 0021 cannot close on its own: every behavioural rule not yet vectored is, on
0021's plain reading, normatively unspecified. A second implementer building against this protocol
today has ~20 byte-level cases and no statement of what the node must _do_.

## Decision

**1. A behavioural rule is a numbered rule.** Each carries a stable id — a two-letter territory
prefix and a sequential number (`PF-14`, `PM-03`) — and an audience tag naming who it binds. Ids
are permanent and never reused, on the same reasoning ADR numbers are: they are cited from vectors
and from other repositories.

**2. Prose is normative for a rule until that rule's vector lands.** Not per document — **per
rule**. A single "this document is normative" banner cannot describe a doc set where the peer
carriage has twenty behavioural vectors and the client edge has none, which is the actual state.

**3. Every numbered rule is classified.** Either a vector names its id, or the rule carries an
inline debt marker on its own line. There is no third state, and an unclassified rule fails the
build.

**4. The debt only shrinks.** The count of uncovered rules is committed as a literal. A change that
raises it fails `cargo test --workspace` until the literal is raised in the same diff — so adding
an unvectored rule is possible, deliberate, and reviewed, rather than silent.

**5. The marker is inline, never a sidecar.** `crates/connector-bin/tests/readme_config_keys.rs`
already establishes why: a second, hand-maintained list "would drift from the table under test
exactly the way the table drifted from the parser. The table's own rows are the input."

**6. Correction to 0021: vectors are not generated from property tests.** 0021 states they are
"generated from property tests over the invariants, not captured from whatever the implementation
happened to emit." `connector-vectors/src/lib.rs` generates from **fixed literal fixtures** run
through the real implementations and self-verified against the same validators, and
`connector-vectors/Cargo.toml` carries no `proptest` dependency. The shipped mechanism is
deliberate, documented, and arguably better — a fixture set is reproducible where a sampled one is
not. **0021's sentence is amended to describe it.** `CONTEXT.md`'s **Vector** entry repeats 0021's
wording and is corrected with it; `client-edge-spec.md` already describes the shipped behaviour.

## Considered options

**Finish 0021 instead of amending it.** Treat the record as one-tier and half-built: write the
missing behavioural vectors, and keep prose non-normative throughout. Philosophically the cleanest,
and it needs no new authority — `cost summing across a path` is already sanctioned. Rejected on
sequencing: it puts a conformance harness on the critical path and leaves the protocol
normatively unspecified until it is built. That is years, and the specification is needed now.

**Make behavioural prose normative, full stop.** The conventional answer, and the one 0021
explicitly considered and rejected: "it is exactly what failed here, documented above, at a cost
this project has already paid once." 0021's Context is a six-item post-mortem of prose drifting
from this codebase — a §1.4 describing a removed greeting, §1.2–§1.6 never implemented and nothing
reporting it. Adopting it unbounded would reverse a record whose entire argument is why not to.
Rejected.

**A report, not a gate.** Export the uncovered count and rely on discipline. Rejected for the same
reason as above: this repo has already demonstrated that an unenforced doc-to-code relationship
decays, and 88 findings across 44 records is the measurement.

## Consequences

**The seven territory documents can be written now.** They do not wait on a harness, and each rule
states its own status rather than inheriting a document-wide banner.

**The gate is not built by this record, and must not be described as though it were.** It reads the
successor doc set, which does not exist until issue #1065 rules on the fate of `docs/protocol/`'s
five specs. This record's Status line says so, per the folder's convention for a decision made
ahead of its mechanism.

**A ratchet makes debt visible, not impossible.** Raising the committed literal is a one-line diff,
and a reviewer who waves it through gets an unenforced report with extra ceremony. This is accepted
deliberately: the ability to state a decided rule before its vector exists is the point, and the
gate's job is to ensure nobody does it by accident.

**The client edge's coverage gap becomes countable.** It is currently invisible — `wire-vectors.md`
declares its scope to be "the client edge termination wire" while the committed set contains no
client-edge carriage section at all. Under this record that gap is a number, and the number can
only go down.

**A vector must name the rule it covers.** This is new work for the vector format and is the
reason the format ticket must resolve before large-scale rule numbering begins.

## Update (issue #1052) — the audience tag names who implements the rule

Every numbered rule carries an **audience tag** naming who must implement it. Four values, and the
set is closed:

`[client]` · `[connector]` · `[app]` · `[operator]`

The tag sits inline, immediately after the rule id:

> **PM-02** `[connector]` — A **peer** arrival at a **priced termination** must cover that route's
> price, per packet, before delivery.

**Role and position are not tags.** They are preconditions, and they belong in the rule's sentence,
where they already read naturally. This is not a style preference — a tag vocabulary containing
"a terminating connector" beside "a paying client" silently asserts a third role, and
`peer-carriage-spec.md` §1 is emphatic that there is not one: an interaction is `peer` if and only
if it is bound to a configured peer id **and** carries a verified claim on one of that peer's
channels, and _"if either fails, for any reason, the interaction has role `client`. There is no
fallthrough: no degraded peer, no peer-for-routing-but-client-for-claims, no retry into peer role."_
`SessionRole` in `connector-peer-auth` has exactly the two variants.

Position is likewise not a property of a reader: the same connector forwards one packet and
terminates the next. Tagging by position would ask a reader to filter on something that changes per
packet.

**Why "who implements it" and not the model's own axes.** The tag exists so a reader can find their
obligations in one lookup. A client SDK author greps `[client]` and holds their complete list. Had
the tag named role and position instead, that author would have to derive their obligations from two
orthogonal axes — the derivation the tag was invented to spare them.

The accepted cost is that `[connector]` is a large bucket. That is correct rather than a failure of
the taxonomy: a second connector must implement all of them. Within-connector navigation is already
served, for free, by the territory prefix in the rule id (`PF-` packet flow, `PM-` payment).

**Asymmetric obligations are two rules, not one rule with two tags.** A client must _send_ a covering
claim; a connector must _verify_ one. Those are different obligations discharged by different code,
and collapsing them hides one of the two from whoever needs it.

**A rule may carry more than one tag only when the obligation is identical for each audience.** The
worked case is a rule about what a reader may _conclude_ rather than what it must do — an unsealed
reject identifies nobody, which binds a client and a forwarding connector in exactly the same way.
Where the obligation differs at all, the asymmetry rule above applies instead.

## Update (issue #1143) — two of the named vectors are deleted

[0057](0057-minimum-delivery-is-retired-a-claim-bounds-erosion.md) retires minimum delivery, and
issue #1143 deletes it. `minimum_delivery_absent` and `minimum_delivery_malformed` — cited here as
vectors that had landed — are gone from `vectors/wire-vectors.json`, along with the
`minimum_delivery` field on the two `peer_prepare` cases and the `toon-minimum-delivery` entry and
header their pinned frames carried. **This is a cross-repo wire change** ([0021](0021-vectors-are-the-normative-cross-repo-contract.md)):
`toon-client`, `rig` and `swap` replay these.

The rest of the list, and this record's rule, are untouched — a rule with no vector is normative
prose, and deleting a rule deletes its vector rather than leaving one pinning behaviour nothing
implements.

## Update (2026-08-25) — the doc set landed, and the rule ids with it

**This record's Status line named a blocker that is no longer there.** It said the gate could not be
written until issue #1065 ruled on the fate of `docs/protocol/`'s five specs, and
[`README.md`](README.md)'s debt row said flatly that **"no rule ids exist yet"**. Both were true when
written and neither is true now, and nobody re-read them — the failure this folder's Conventions
describe, found by the sweep that added the `**Falsifier:**` line above.

**What landed.** The territory documents exist and carry **105 numbered rules**, each with the
audience tag the issue #1052 Update below specifies:

| document                                                           | rules             |
| ------------------------------------------------------------------ | ----------------- |
| [`configuration-spec.md`](../protocol/configuration-spec.md)       | `CF-01` – `CF-36` |
| [`packet-flow-spec.md`](../protocol/packet-flow-spec.md)           | `PF-01` – `PF-24` |
| [`payment-spec.md`](../protocol/payment-spec.md)                   | `PM-01` – `PM-22` |
| [`self-description-spec.md`](../protocol/self-description-spec.md) | `ND-01` – `ND-16` |
| [`operator-spec.md`](../protocol/operator-spec.md)                 | `OP-01` – `OP-07` |

Each also carries a document-level `**Coverage:**` banner, and two of them use it to say the rules
never enter the ledger at all — configuration and the operator surface are not wire surfaces, so per
this record they are prose-normative permanently rather than provisionally. That is decision 2 being
applied, and it was applied without the gate.

**What is still not built, which is what the Status line above now says instead.** Decision 3's
per-rule classification (a document-level "none of these is vectored" banner is precisely the
document-wide banner decision 2 rejects), decision 4's committed debt literal and its ratchet, the
build failure on an unclassified rule, and the vector-format change that lets a vector name the rule
it covers. The falsifier above is keyed on that last one, because it is the piece none of the others
can be built without.
