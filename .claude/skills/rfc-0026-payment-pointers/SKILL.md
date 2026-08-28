---
name: rfc-0026-payment-pointers
description: Expert knowledge of Interledger RFC 0026 - Payment Pointers. Use when users ask about payment pointers, user-friendly payment addressing, HTTP(S) payment resolution, or simplified payment endpoints. NOTE: this connector does not implement RFC 0026 — the skill explains what TOON does instead. Triggers on 'payment pointer', '$paymentpointer', 'payment address', or payment endpoint resolution.
---

# RFC 0026: Payment Pointers

## This connector does not implement it

TOON addresses a route by ILP address and a node by its URL. There is no payment-pointer resolution anywhere.

RFC 0026 is therefore **not vendored** into `docs/rfcs/`
([ADR 0062](../../../docs/adr/0062-an-rfc-is-vendored-verbatim-and-profiled-never-forked.md)
D4: a copy would assert a relevance this one does not have). The ten RFCs this
connector *does* implement or profile are there, each with a TOON profile.

Say this plainly when asked. Somebody looking for RFC 0026 behaviour in this
codebase will not find it, and the useful answer is what replaced it — not a
search.

## If you need the RFC itself

It is upstream, and this repository holds no copy:
<https://github.com/interledger/rfcs/blob/main/0026-payment-pointers/0026-payment-pointers.md>

Read it there when the question is about Interledger generally rather than about
this connector. Do not vendor it in passing — that is ADR 0062 D4's decision,
not a gap.

## Where to look instead

- [`docs/rfcs/README.md`](../../../docs/rfcs/README.md) — the ten vendored RFCs.
- [`CONTEXT.md`](../../../CONTEXT.md) — this project's vocabulary, which differs
  from RFC 0019's in the places that matter here.
- [`docs/adr/README.md`](../../../docs/adr/README.md) — the decisions, grouped.
