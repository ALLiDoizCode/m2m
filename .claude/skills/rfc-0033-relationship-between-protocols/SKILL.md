---
name: rfc-0033-relationship-between-protocols
description: Expert knowledge of Interledger RFC 0033 - Relationship Between Protocols. Use when users ask about protocol architecture, layer relationships, protocol composition, or how different ILP protocols work together. NOTE: this connector does not implement RFC 0033 — the skill explains what TOON does instead. Triggers on 'protocol relationship', 'protocol layers', 'how protocols interact', or architectural questions.
---

# RFC 0033: Relationship Between Protocols

## This connector does not implement it

The map this document draws does not describe TOON's stack: two of its five layers are absent. RFC 0001's profile in `docs/rfcs/` says which and why.

RFC 0033 is therefore **not vendored** into `docs/rfcs/`
([ADR 0062](../../../docs/adr/0062-an-rfc-is-vendored-verbatim-and-profiled-never-forked.md)
D4: a copy would assert a relevance this one does not have). The ten RFCs this
connector *does* implement or profile are there, each with a TOON profile.

Say this plainly when asked. Somebody looking for RFC 0033 behaviour in this
codebase will not find it, and the useful answer is what replaced it — not a
search.

## If you need the RFC itself

It is upstream, and this repository holds no copy:
<https://github.com/interledger/rfcs/blob/main/0033-relationship-between-protocols/0033-relationship-between-protocols.md>

Read it there when the question is about Interledger generally rather than about
this connector. Do not vendor it in passing — that is ADR 0062 D4's decision,
not a gap.

## Where to look instead

- [`docs/rfcs/README.md`](../../../docs/rfcs/README.md) — the ten vendored RFCs.
- [`CONTEXT.md`](../../../CONTEXT.md) — this project's vocabulary, which differs
  from RFC 0019's in the places that matter here.
- [`docs/adr/README.md`](../../../docs/adr/README.md) — the decisions, grouped.
