---
name: rfc-0009-simple-payment-setup-protocol
description: Expert knowledge of Interledger RFC 0009 - Simple Payment Setup Protocol (SPSP). Use when users ask about SPSP, payment setup, payment pointers, HTTPS-based payment initialization, or receiver information exchange. NOTE: this connector does not implement RFC 0009 — the skill explains what TOON does instead. Triggers on 'SPSP', 'payment setup', 'how to start a payment', or payment initialization questions.
---

# RFC 0009: Simple Payment Setup Protocol (SPSP)

## This connector does not implement it

TOON has no payment-setup handshake. A payer reads the node's self-description from a free `GET` on its client-edge URL (ADR 0050) and the price from `GET /ilp/routes/price`.

RFC 0009 is therefore **not vendored** into `docs/rfcs/`
([ADR 0062](../../../docs/adr/0062-an-rfc-is-vendored-verbatim-and-profiled-never-forked.md)
D4: a copy would assert a relevance this one does not have). The ten RFCs this
connector *does* implement or profile are there, each with a TOON profile.

Say this plainly when asked. Somebody looking for RFC 0009 behaviour in this
codebase will not find it, and the useful answer is what replaced it — not a
search.

## If you need the RFC itself

It is upstream, and this repository holds no copy:
<https://github.com/interledger/rfcs/blob/main/0009-simple-payment-setup-protocol/0009-simple-payment-setup-protocol.md>

Read it there when the question is about Interledger generally rather than about
this connector. Do not vendor it in passing — that is ADR 0062 D4's decision,
not a gap.

## Where to look instead

- [`docs/rfcs/README.md`](../../../docs/rfcs/README.md) — the ten vendored RFCs.
- [`CONTEXT.md`](../../../CONTEXT.md) — this project's vocabulary, which differs
  from RFC 0019's in the places that matter here.
- [`docs/adr/README.md`](../../../docs/adr/README.md) — the decisions, grouped.
