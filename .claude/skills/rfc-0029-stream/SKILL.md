---
name: rfc-0029-stream
description: Expert knowledge of Interledger RFC 0029 - STREAM Protocol. Use when users ask about STREAM, transport layer protocols, streaming payments, payment chunking, flow control, or end-to-end encryption. NOTE: this connector does not implement RFC 0029 — the skill explains what TOON does instead. Triggers on 'STREAM', 'streaming payment', 'transport protocol', or payment flow control.
---

# RFC 0029: STREAM

## This connector does not implement it

TOON has no transport layer. The payload is a gift wrap sealed to the terminating connector, carrying one OER request envelope (ADR 0018) — no chunking, no flow control, no end-to-end secret negotiated above ILP.

RFC 0029 is therefore **not vendored** into `docs/rfcs/`
([ADR 0062](../../../docs/adr/0062-an-rfc-is-vendored-verbatim-and-profiled-never-forked.md)
D4: a copy would assert a relevance this one does not have). The ten RFCs this
connector *does* implement or profile are there, each with a TOON profile.

Say this plainly when asked. Somebody looking for RFC 0029 behaviour in this
codebase will not find it, and the useful answer is what replaced it — not a
search.

## If you need the RFC itself

It is upstream, and this repository holds no copy:
<https://github.com/interledger/rfcs/blob/main/0029-stream/0029-stream.md>

Read it there when the question is about Interledger generally rather than about
this connector. Do not vendor it in passing — that is ADR 0062 D4's decision,
not a gap.

## Where to look instead

- [`docs/rfcs/README.md`](../../../docs/rfcs/README.md) — the ten vendored RFCs.
- [`CONTEXT.md`](../../../CONTEXT.md) — this project's vocabulary, which differs
  from RFC 0019's in the places that matter here.
- [`docs/adr/README.md`](../../../docs/adr/README.md) — the decisions, grouped.
