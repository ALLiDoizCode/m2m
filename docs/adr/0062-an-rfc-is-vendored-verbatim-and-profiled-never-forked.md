# An RFC is vendored verbatim and profiled, never forked

**Status:** Accepted — **built** (#1173). Ten Interledger RFCs live under [`docs/rfcs/`](../rfcs/README.md), each an unmodified upstream body beneath a TOON-profile preface, pinned by commit and hashed by `crates/connector-bin/tests/vendored_rfcs_are_unmodified.rs`. Extends [0021](0021-vectors-are-normative-prose-is-not.md)'s precedence order downward to cover text this project did not write.

**Scope:** documentation and protocol law — binds this repository and anyone citing it. See the [ADR index](README.md).

**An Interledger RFC is copied into this repository byte for byte, and the ways
TOON differs from it are written above it, never into it.** The copy is
evidence of what the standard says. The preface is this project's claim about
itself. Merging the two destroys both.

## Why a copy at all

The connector speaks ILPv4 packets, OER bytes, ILP addresses, BTP frames and
ILP-over-HTTP. An operator standing a node up is entitled to read the protocol
it rides, and an agent working in this repository is instructed to answer
protocol questions from the RFC rather than from memory (`CLAUDE.md`). Both were
being served by a link to another repository's default branch — a moving target,
reachable only online, and silent about the dozen places this connector
deliberately does something else.

A vendored copy fixes all three: the text is here, it is pinned, and the
departures sit on top of it where the reader meets them.

## Why not a fork

The tempting version is to edit the copy — strike the paragraphs about exchange
rates, rewrite `data` to describe the gift wrap, delete STREAM — and end up with
one coherent document describing what this connector actually does.

That document must not exist, for three reasons.

**It would be a second normative prose source.**
[ADR 0021](0021-vectors-are-normative-prose-is-not.md) already settles that
prose is not normative and the vectors are. A forked RFC reads with the
authority of a standard while carrying local edits, which is precisely the
artefact that rule exists to prevent. `docs/protocol/`'s specs are careful to
say what binds and what does not; a rewritten RFC would say neither and be
believed anyway.

**It would rot silently.** Upstream revises. A verbatim body diverging from
upstream is a mechanical fact a hash can catch. A forked body diverging from
upstream is indistinguishable from a fork doing its job, and nobody can tell
which edits were deliberate five years on.

**It would put the departures in the wrong place.** Every departure this project
has already argued out has a record — the sealed payload is
[0018](0018-a-payload-is-sealed-to-the-terminating-connector.md), the derived
fulfilment is [0019](0019-a-terminating-connector-derives-the-fulfilment.md),
retired exposure is [0033](0033-the-exposure-machinery-is-retired-not-restated.md),
a packet carrying its claim is [0042](0042-a-packet-carries-its-claim.md). An
edit inside an RFC body restates a conclusion away from its argument. A preface
citing the ADR keeps the two together.

## Decisions

**D1. A vendored body is byte-identical to upstream at a named commit.** Each
file is a preface, a marker line, and then the upstream bytes with nothing added,
removed or reflowed. The preface records the upstream path, the pinned commit and
the SHA-256 of the body.
`crates/connector-bin/tests/vendored_rfcs_are_unmodified.rs` recomputes that hash
on `cargo test --workspace`, so an edit to the body fails the build. The check is
offline and therefore about _this_ claim — "unmodified since vendored" — which is
the one the licence makes us responsible for. "Still matches upstream" is a
`curl | sha256sum` the preface spells out, and is a deliberate human step: a
changed upstream is news, not a broken build.

**D2. The preface is the only place alignment is written, and it cites rather
than argues.** Every departure names the ADR or `docs/protocol/` rule that
governs it. A departure with no such record is not documented in a preface — it
is an ADR that has not been written yet.

**D3. Precedence, longest-standing first.** Where two of these disagree, the
earlier wins:

```
vectors  >  ADRs  >  docs/protocol/ specs  >  a TOON profile preface  >  an RFC body
```

An RFC body never overrides anything local. It is the thing the local rules are
stated _against_. This extends
[ADR 0021](0021-vectors-are-normative-prose-is-not.md) rather than amending it:
0021 ordered what this project writes, and vendoring introduces text it did not.
The preface outranks the body only in the narrow sense that it says which parts
of the body this connector honours — it has no authority over what the standard
says.

**D4. An RFC is vendored only if the connector implements or directly profiles
it.** Ten do: 0001, 0015, 0018, 0019, 0023, 0027, 0030, 0032, 0034, 0035. The
rest of the suite is not copied, because a copy asserts relevance. SPSP (0009),
STREAM (0029), STREAM receipts (0039), payment pointers (0026), HTLA (0022),
ILDCP (0031), settlement engines (0038) and the protocol-relationship map (0033)
describe layers this connector replaces or does not have, and each gets one line
in the README saying so. A reader who knows Interledger should learn that TOON
has no transport layer from the README, not from failing to find STREAM here.

**D5. The licence is honoured explicitly.** The Interledger RFCs are CC BY-SA
4.0; this repository is MIT.
[`docs/rfcs/README.md`](../rfcs/README.md) carries the attribution, the licence
notice and the statement of what was changed — a preface added above an
unmodified body — and that notice governs `docs/rfcs/` in place of the
repository's own licence. This is why D1 is enforced rather than merely
intended: "we did not modify the text" is a licence claim, and a claim of that
kind should be checkable.

## What this costs

The prefaces are hand-maintained, and an ADR that changes a departure has to be
carried into the preface that cites it — the test hashes the body, and nothing
hashes the accuracy of the profile. That is the same exposure every doc in
`docs/protocol/` already has, and it is accepted for the same reason: the
alternative is not writing the alignment down.

Upstream revisions are also a manual step. That is intended. A protocol document
changing under a running fleet should be read by a person.
