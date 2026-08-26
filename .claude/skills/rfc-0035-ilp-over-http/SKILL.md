---
name: rfc-0035-ilp-over-http
description: Expert knowledge of Interledger RFC 0035 - ILP Over HTTP. Use when users ask about HTTP transport for ILP, HTTP binding, REST API for ILP, or HTTP-based packet transport. Answers from the copy vendored in this repository at docs/rfcs/, which carries a TOON profile saying where this connector departs. Triggers on 'ILP over HTTP', 'HTTP transport', 'ILP HTTP binding', or HTTP integration questions.
---

# RFC 0035: ILP over HTTP

**Read [`docs/rfcs/0035-ilp-over-http/0035-ilp-over-http.md`](../../../docs/rfcs/0035-ilp-over-http/0035-ilp-over-http.md).**
It is the upstream RFC, unmodified, beneath a **TOON profile** written by this
project. Answer from that file rather than from memory or from the network.

It gives you the `https://` carriage and the shape of `POST /ilp`.

## How to read it

1. **The TOON profile, at the top.** Every place this connector departs from the
   RFC, each citing the ADR or `docs/protocol/` rule that governs it. Departures
   marked ⚠ are unrecorded gaps or divergences nothing guards — say so plainly
   when one is relevant.
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
