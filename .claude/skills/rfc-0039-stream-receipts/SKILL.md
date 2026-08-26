---
name: rfc-0039-stream-receipts
description: Expert knowledge of Interledger RFC 0039 - STREAM Receipts. Use when users ask about payment receipts, payment verification, proof of payment, or non-repudiation in STREAM. NOTE: this connector does not implement RFC 0039 — the skill explains what TOON does instead. Triggers on 'STREAM receipt', 'payment proof', 'payment verification', or receipt generation questions.
---

# RFC 0039: STREAM Receipts

## This connector does not implement it

TOON has no STREAM. Delivery is proven by the fulfilment the terminating connector derives (ADR 0019), and what was paid is the claim journal (ADR 0005).

RFC 0039 is therefore **not vendored** into `docs/rfcs/`
([ADR 0062](../../../docs/adr/0062-an-rfc-is-vendored-verbatim-and-profiled-never-forked.md)
D4: a copy would assert a relevance this one does not have). The ten RFCs this
connector *does* implement or profile are there, each with a TOON profile.

Say this plainly when asked. Somebody looking for RFC 0039 behaviour in this
codebase will not find it, and the useful answer is what replaced it — not a
search.

## If you need the RFC itself

It is upstream, and this repository holds no copy:
<https://github.com/interledger/rfcs/blob/main/0039-stream-receipts/0039-stream-receipts.md>

Read it there when the question is about Interledger generally rather than about
this connector. Do not vendor it in passing — that is ADR 0062 D4's decision,
not a gap.

## Where to look instead

- [`docs/rfcs/README.md`](../../../docs/rfcs/README.md) — the ten vendored RFCs.
- [`CONTEXT.md`](../../../CONTEXT.md) — this project's vocabulary, which differs
  from RFC 0019's in the places that matter here.
- [`docs/adr/README.md`](../../../docs/adr/README.md) — the decisions, grouped.
