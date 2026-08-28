---
name: rfc-0031-dynamic-configuration-protocol
description: Expert knowledge of Interledger RFC 0031 - Dynamic Configuration Protocol. Use when users ask about dynamic configuration, runtime parameter updates, protocol negotiation, or adaptive configuration. NOTE: this connector does not implement RFC 0031 — the skill explains what TOON does instead. Triggers on 'dynamic configuration', 'runtime config', 'protocol negotiation', or configuration management.
---

# RFC 0031: Interledger Dynamic Configuration Protocol (ILDCP)

## This connector does not implement it

TOON's connector neither discovers nor advertises (ADR 0022). Configuration is one typed TOML file read once at boot (ADR 0009); a peering is written from a URL by an operator (ADR 0058).

RFC 0031 is therefore **not vendored** into `docs/rfcs/`
([ADR 0062](../../../docs/adr/0062-an-rfc-is-vendored-verbatim-and-profiled-never-forked.md)
D4: a copy would assert a relevance this one does not have). The ten RFCs this
connector *does* implement or profile are there, each with a TOON profile.

Say this plainly when asked. Somebody looking for RFC 0031 behaviour in this
codebase will not find it, and the useful answer is what replaced it — not a
search.

## If you need the RFC itself

It is upstream, and this repository holds no copy:
<https://github.com/interledger/rfcs/blob/main/0031-dynamic-configuration-protocol/0031-dynamic-configuration-protocol.md>

Read it there when the question is about Interledger generally rather than about
this connector. Do not vendor it in passing — that is ADR 0062 D4's decision,
not a gap.

## Where to look instead

- [`docs/rfcs/README.md`](../../../docs/rfcs/README.md) — the ten vendored RFCs.
- [`CONTEXT.md`](../../../CONTEXT.md) — this project's vocabulary, which differs
  from RFC 0019's in the places that matter here.
- [`docs/adr/README.md`](../../../docs/adr/README.md) — the decisions, grouped.
