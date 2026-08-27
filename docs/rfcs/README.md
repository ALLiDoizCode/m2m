# The protocol a connector speaks

The connector routes **Interledger** packets. This page is the protocol half of
the documentation: enough of Interledger to read the rest, the ten RFCs vendored
into this directory, and — for each — where this connector deliberately does
something else. [`README.md`](../../README.md) is the operator guide and assumes
none of it.

## Interledger in five paragraphs

A payment travels as a **packet**. A sender builds a `PREPARE` carrying an
amount, an expiry, a 32-byte execution condition and an opaque `data` payload,
addressed to an ILP address like `g.example.app`.

Each **connector** along the way matches the longest prefix in its routing table
and either forwards the packet to a **peer** or **terminates** it — meaning the
address belongs to an app it serves.

The terminating connector answers with a `FULFILL` carrying the preimage of that
condition, or a `REJECT` carrying a code. That answer travels back along the
same path.

What each hop keeps is a flat **fee**; what the caller pays for the whole path is
a flat **price**. Neither is a percentage and neither is per byte.

Money does not move inside the packet. Each hop is backed by a payment channel,
and a packet carries a signed **claim** on that channel — an off-chain IOU whose
cumulative total only ever rises. Settling means taking the latest claim to the
chain and redeeming it: rare and deliberate, the opposite of a claim.

## Where TOON departs

Read the profile before the body. They often disagree, and the profile is where
you find out why.

| RFC                                                                                                       | Where TOON departs                                                                                                                              |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001 Architecture](0001-interledger-architecture/0001-interledger-architecture.md)                       | Two of its five layers are absent: no transport layer, no ledger abstraction                                                                    |
| [0015 ILP Addresses](0015-ilp-addresses/0015-ilp-addresses.md)                                            | Addresses are self-asserted; allocation schemes (`peer.`, `self.`, `private.`) have no behaviour here                                           |
| [0018 Risk Mitigations](0018-connector-risk-mitigations/0018-connector-risk-mitigations.md)                | Exposure limits are deleted, not reduced; one per-packet cap replaces them                                                                      |
| [0019 Glossary](0019-glossary/0019-glossary.md)                                                           | [`CONTEXT.md`](../../CONTEXT.md) is this repo's vocabulary and wins; "ledger", "transfer" and "receiver" are gone                                |
| [0023 BTP](0023-bilateral-transfer-protocol/0023-bilateral-transfer-protocol.md)                          | The frame grammar is the deployed client's dialect; the `auth` frame authenticates nothing                                                      |
| [0027 ILPv4](0027-interledger-protocol-4/0027-interledger-protocol-4.md)                                  | ⚠ **The wire encoding is TOON's, not this RFC's** ([ADR 0063](../adr/0063-the-ilp-packet-is-toons-dialect-not-rfc-0027s.md)); `data` is sealed to the terminating connector |
| [0030 OER Encoding](0030-notes-on-oer-encoding/0030-notes-on-oer-encoding.md)                              | Stricter: length determinants must be canonical, trailing bytes are refused                                                                     |
| [0032 Peering & Settlement](0032-peering-clearing-settlement/0032-peering-clearing-settlement.md)          | Clearing is per packet. No balance, no threshold, no netting cycle, no credit limit                                                             |
| [0034 Connector Requirements](0034-connector-requirements/0034-connector-requirements.md)                  | No route discovery, no advertisement, no exchange rates, no quoting                                                                             |
| [0035 ILP over HTTP](0035-ilp-over-http/0035-ilp-over-http.md)                                             | Adds the claim header, the `402` payment-required document, and an anonymous-by-default caller                                                  |

**"Speaks ILPv4" is retired** as a description of this connector
([ADR 0063](../adr/0063-the-ilp-packet-is-toons-dialect-not-rfc-0027s.md) D3).
The accurate form is **ILPv4 semantics, TOON encoding**: the packet types, the
field meanings, `condition = sha256(fulfilment)` and the `F`/`T`/`R` taxonomy are
RFC 0027's; the byte layout is not, and an off-the-shelf ILPv4 encoder does not
produce a packet this connector accepts.

## What TOON does not use, and why

If you know Interledger, these are the absences to notice. Each is deliberate,
and none is vendored — a copy would assert a relevance it does not have
([ADR 0062](../adr/0062-an-rfc-is-vendored-verbatim-and-profiled-never-forked.md) D4).

- **SPSP (0009)** — no payment-setup handshake. A payer reads a free `GET` on the
  node's URL, and `GET /ilp/routes/price`.
- **STREAM (0029)** and **STREAM receipts (0039)** — no transport layer at all.
  One sealed request envelope per packet; no chunking, no flow control.
- **Payment pointers (0026)** — a route is an ILP address, a node is a URL.
- **HTLA (0022)** — no ledger-layer trust spectrum. Every peering is backed by a
  payment channel and authorised by a signed claim.
- **ILDCP (0031)** — the connector neither discovers nor advertises. Configuration
  is one TOML file; a peering is an operator write.
- **Settlement engines (0038)** — settlement is in-process, not a sidecar.
- **Relationship between protocols (0033)** — the map it draws is not this stack.

## How a vendored copy is arranged

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

## The pin

All ten are pinned at `interledger/rfcs` commit
[`1eb8d73b67a1d048f74ded508406a7e1ae1e00d5`](https://github.com/interledger/rfcs/tree/1eb8d73b67a1d048f74ded508406a7e1ae1e00d5).
Every file in this directory is that commit's text, unmodified, under a profile.
"Where TOON departs" above links each one.

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
