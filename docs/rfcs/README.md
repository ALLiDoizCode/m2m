# The Interledger RFCs this connector implements

Ten RFCs, vendored here so the protocol you are running is readable without
leaving the repository — and so the places this connector deliberately does
something else are written directly above the text they depart from.

Each file is in two halves:

```
docs/rfcs/0027-interledger-protocol-4/0027-interledger-protocol-4.md

    # RFC 0027 — ...          ← this project's words
    ## TOON profile           ← where TOON departs, each citing an ADR
    <!-- BEGIN VERBATIM UPSTREAM BODY -->
    ...                       ← the Interledger Foundation's words, untouched
```

**The body is never edited.** Not to strike a paragraph about exchange rates
this connector does not have, not to rewrite `data` to describe the gift wrap.
[ADR 0062](../adr/0062-an-rfc-is-vendored-verbatim-and-profiled-never-forked.md)
argues why, and `crates/connector-bin/tests/vendored_rfcs_are_unmodified.rs`
enforces it: each preface records the SHA-256 of its own body, and the workspace
gate recomputes it.

If you are correcting a profile, edit **above** the marker. If you are
re-vendoring from a newer upstream, use the script.

## What is here

All ten are pinned at `interledger/rfcs` commit
[`1eb8d73b67a1d048f74ded508406a7e1ae1e00d5`](https://github.com/interledger/rfcs/tree/1eb8d73b67a1d048f74ded508406a7e1ae1e00d5).

| RFC                                                                                                           | What it gives an operator                                        |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [0001 Interledger Architecture](0001-interledger-architecture/0001-interledger-architecture.md)               | The layered model and the hop-by-hop shape of a payment.         |
| [0015 ILP Addresses](0015-ilp-addresses/0015-ilp-addresses.md)                                                | What `g.example.app` is and how longest-prefix matching works.   |
| [0018 Connector Risk Mitigations](0018-connector-risk-mitigations/0018-connector-risk-mitigations.md)         | The risks of running a forwarding node, and the classic answers. |
| [0019 Glossary](0019-glossary/0019-glossary.md)                                                               | The field's vocabulary. `CONTEXT.md` is this repo's, and wins.   |
| [0023 Bilateral Transfer Protocol](0023-bilateral-transfer-protocol/0023-bilateral-transfer-protocol.md)      | The BTP frames a `wss://` peering and a client session speak.    |
| [0027 ILPv4](0027-interledger-protocol-4/0027-interledger-protocol-4.md)                                      | The packet itself: PREPARE, FULFILL, REJECT, and the codes.      |
| [0030 Notes on OER Encoding](0030-notes-on-oer-encoding/0030-notes-on-oer-encoding.md)                        | How those packets become bytes.                                  |
| [0032 Peering, Clearing and Settlement](0032-peering-clearing-settlement/0032-peering-clearing-settlement.md) | What a peering is for, and the settlement model TOON replaces.   |
| [0034 Connector Requirements](0034-connector-requirements/0034-connector-requirements.md)                     | The job description of the thing you are running.                |
| [0035 ILP over HTTP](0035-ilp-over-http/0035-ilp-over-http.md)                                                | The `https://` carriage, and the shape of `POST /ilp`.           |

**Not vendored, on purpose.** SPSP (0009), payment pointers (0026), HTLA (0022),
STREAM (0029), ILDCP (0031), the protocol-relationship map (0033), settlement
engines (0038) and STREAM receipts (0039) describe layers this connector
replaces or does not have. A copy would assert relevance
([ADR 0062](../adr/0062-an-rfc-is-vendored-verbatim-and-profiled-never-forked.md)
D4). The repository [`README.md`](../../README.md) says in one line each what
takes their place.

## Where a vendored RFC sits in the order of authority

```
vectors  >  ADRs  >  docs/protocol/ specs  >  a TOON profile  >  an RFC body
```

An RFC body never overrides anything local — it is what the local rules are
stated _against_. `vectors/wire-vectors.json` is normative and prose is not
([ADR 0021](../adr/0021-vectors-are-normative-prose-is-not.md)); most of what a
profile cites is prose-normative with a vector still owed
([ADR 0045](../adr/0045-a-behavioural-rule-is-normative-prose-until-its-vector-lands.md)),
and the profiles say so where it matters rather than dressing prose up as law.

## Re-vendoring

```bash
tools/vendor-rfc.sh 0027-interledger-protocol-4 <40-char-upstream-commit>
cargo test -p connector --test vendored_rfcs_are_unmodified
```

The script fetches, splices below the marker, and rewrites the pinned commit and
the digest. Everything above the marker is preserved, so a profile survives a
re-vendor. Called with no commit it re-fetches at the pin already recorded, which
also makes it the repair tool for a body somebody edited.

**Read the diff.** A protocol document changing under a running fleet is news.
The gate here is deliberately offline and answers only "unmodified since
vendored"; "still matches upstream today" is a question for a person, and this is
how they ask it:

```bash
curl -sSfL https://raw.githubusercontent.com/interledger/rfcs/main/0027-interledger-protocol-4/0027-interledger-protocol-4.md \
  | sha256sum
```

Compare against the `**Body SHA-256:**` line in the vendored copy.

## Licence and attribution

The RFC bodies in this directory are © the Interledger Foundation and
contributors, from [`interledger/rfcs`](https://github.com/interledger/rfcs),
and are licensed under
[Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/)
(CC BY-SA 4.0).

**Statement of changes, as CC BY-SA 4.0 requires:** the bodies are reproduced
**unmodified**. The only change is this project's preface, added above the
`<!-- BEGIN VERBATIM UPSTREAM BODY -->` marker in each file, and this README.
Those additions are also offered under CC BY-SA 4.0.

**This directory is CC BY-SA 4.0, not MIT.** The rest of this repository is MIT
([`LICENSE`](../../LICENSE)); the share-alike term applies to `docs/rfcs/` and
its contents, and to adaptations of them. Nothing in `crates/` derives from these
documents' text, so the binary is unaffected — an implementation of a
specification is not a derivative work of the specification.
