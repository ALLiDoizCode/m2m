---
name: rfc-0034-connector-requirements
description: Expert knowledge of Interledger RFC 0034 - Connector Requirements. Use when users ask about connector implementation, connector compliance, routing requirements, or building connectors. Answers from the copy vendored in this repository at docs/rfcs/, which carries a TOON profile saying where this connector departs. Triggers on 'connector requirements', 'build a connector', 'connector compliance', or connector implementation questions.
---

# RFC 0034: Connector Requirements

**Read [`docs/rfcs/0034-connector-requirements/0034-connector-requirements.md`](../../../docs/rfcs/0034-connector-requirements/0034-connector-requirements.md).**
It is the upstream RFC, unmodified, beneath a **TOON profile** written by this
project. Answer from that file rather than from memory or from the network.

It gives you the job description of the thing this repository builds.

## How to read it

1. **The TOON profile, at the top.** Every place this connector departs from the
   RFC, each citing the ADR or `docs/protocol/` rule that governs it. A ⚠ marks
   a departure that is easy to assume away — one a reader of the RFC would not
   expect and would be wrong to guess at. Some are recorded and guarded, some are
   open gaps; the bullet itself says which. Surface it plainly when it is
   relevant, rather than reading the glyph as "unrecorded".
2. **The body, below the `<!-- BEGIN VERBATIM UPSTREAM BODY -->` marker.** The
   standard as written. It is never edited to match this connector
   ([ADR 0062](../../../docs/adr/0062-an-rfc-is-vendored-verbatim-and-profiled-never-forked.md)),
   and a test enforces that.

## Precedence when they disagree

```
vectors  >  ADRs  >  docs/protocol/ specs  >  the TOON profile  >  the RFC body
```

The RFC body never overrides anything local — it is what the local rules are
stated against. If the question is "what does this connector do", the ADR wins.
If the question is "what does Interledger specify", the body wins. Distinguish
the two in your answer; they are often not the same, and this file exists
because that surprised somebody.

Never edit the body. A correction to how TOON aligns goes **above** the marker,
or into the record that owns the rule.
