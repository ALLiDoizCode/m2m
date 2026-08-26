# The node self-description

**Status:** **Normative for its numbered rules.** The endpoint is **built** (#1080): `GET /ilp`
serves this document and the x402 greeting is a projection of the same source. Two rules are still
**not built** and are marked so rather than written in the present tense — ND-15's unsealed reject
carrying a URL (#1083, [ADR 0054](../adr/0054-an-unsealed-termination-reject-answers-where-to-ask.md))
and the route descriptions [ADR 0044](../adr/0044-a-probe-answers-what-a-route-costs-and-what-it-does.md)
adds.

**Coverage:** none of ND-01 – ND-16 is vectored. This **is** a wire surface, so unlike the
configuration and operator documents these rules **do** enter
[ADR 0045](../adr/0045-a-behavioural-rule-is-normative-prose-until-its-vector-lands.md)'s debt ledger,
and the burn-down order is issue #1084's.

**Consumers:** every client SDK, every controller, every operator configuring a peering by hand.

**Vocabulary:** [`CONTEXT.md`](../../CONTEXT.md). MUST, MUST NOT, SHOULD, MAY per RFC 2119.

**Falsifier:** `crates/connector-runtime/src/connector.rs` matching `fn unsealed_termination_reject\([^)]*,` — the second item "Not built" below (#1083, the unsealed reject's URL, [ADR 0054](../adr/0054-an-unsealed-termination-reject-answers-where-to-ask.md)). The reject builder takes a message and nothing else; the URL has to be handed to it.

---

## Why this document exists

A node used to describe itself in **two** places, with **different field sets**, neither
authoritative and neither a superset of the other: the x402 greeting's `extra` block, and a kind:10032
`IlpPeerInfo` announce.

That is not a tidiness problem. `requiredTransport` was **enforced long before it was advertised** —
the devnet relay pinned a route to BTP, its announce said nothing, `toon-client`'s guard read a key
that was not there, fell through to HTTP, and **every relay publish was refused**. Verified live on
2026-08-14: not one announce in the fleet's corpus carried the key in any form.

One authoritative document is what makes that class of failure structural rather than recurring. The
announce is gone ([ADR 0046](../adr/0046-the-kind-10032-announce-is-removed-a-connector-needs-no-relay.md));
the greeting becomes a projection.

---

## 1. The document

### 1.1 Where it lives

**ND-01** `[connector]` — A connector MUST answer `GET` on its **own client-edge URL** with its
self-description. No ILP packet, no encoder, no protocol knowledge required.
([ADR 0050](../adr/0050-a-connectors-url-resolves-to-its-self-description.md))

**ND-02** `[connector]` — It MUST be free and unauthenticated. This is what
[ADR 0022](../adr/0022-a-connector-answers-it-does-not-announce.md) already means by _answering_: it
decides nothing and reaches nobody who did not ask.

**ND-03** `[connector]` — It MUST NOT accept a `POST`, or any other write, **ever**.

> ND-03 is stated rather than implied because the failure mode is obvious in hindsight and slow to
> arrive: a self-description endpoint grows a write, and purchasable peering is back through a side
> door years after [ADR 0043](../adr/0043-purchasable-peering-is-removed.md) removed it. **A peering
> is created by an operator and by nothing else.** This endpoint publishes what an operator needs to
> configure one out of band; it is never where one is requested.

**ND-04** `[connector]` — There is **no caching contract and no TTL**. The document is generated from
live configuration and read when a client wants it. A TTL existed because a _pushed_ copy needed a
shelf life; a pulled one does not.

### 1.2 What it carries

**ND-05** `[connector]` — Everything in the document MUST be true **of this connector**: a fact it
either proved at startup or was configured with, about itself.

The document carries:

| fact                                                                                                                              | why a stranger needs it                                                            |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| ILP address(es)                                                                                                                   | what to address                                                                    |
| public HTTP and BTP endpoints, and which carriages are exposed                                                                    | where to reach it, and how                                                         |
| **edge identity** — the key a packet is sealed to                                                                                 | without it a packet cannot be sealed, so it cannot be delivered                    |
| per chain: chain id, settlement address, token network and its registry, token address, decimals                                  | what a buyer needs to **open a channel**                                           |
| route prices, and their descriptions once [ADR 0044](../adr/0044-a-probe-answers-what-a-route-costs-and-what-it-does.md) is built | what a route costs and what it does                                                |
| the client transport its routes require, when they agree on one                                                                   | the `requiredTransport` failure, closed by construction                            |
| supported client-edge versions, and which one unversioned `POST /ilp` resolves to                                                 | [ADR 0003](../adr/0003-clean-room-peer-wire-versioned-client-edge.md), issue #1054 |

**ND-06** `[connector]` — The **edge identity** MUST be published. A route whose terminating identity
is unpublished is unreachable: a sender cannot seal to it, so it can never be delivered to.

**ND-07** `[connector]` — Per-chain settlement facts MUST be derived from the settlement backend the
connector verified against a chain at startup, and MUST NOT be separately declared. **Two declarations
of one fact is how a mainnet node comes to announce itself as devnet.**

### 1.3 What it does not carry

**ND-08** `[connector]` — It MUST NOT describe software **behind** the connector. A connector is a
paid reverse proxy; what runs behind it is the app's business.

> This is why a `relayUrl` field was dropped rather than carried forward. It asserted that a Nostr
> relay for free reads sat behind the node — an _application_ fact, and the last place
> [ADR 0046](../adr/0046-the-kind-10032-announce-is-removed-a-connector-needs-no-relay.md)'s removed
> relay assumption survived. Keeping it would have mixed facts the node **proved** with a claim about
> software it does not run, and mixing those provenances is how `requiredTransport` happened.

**ND-09** `[connector]` — It MUST NOT carry **per-peer** facts: peer identities, per-peering fees, or
caps. Publishing them discloses who this node peers with and how far it trusts each — an
operator-private relationship ([ADR 0006](../adr/0006-the-connector-is-mechanism-not-policy.md),
[ADR 0049](../adr/0049-the-cap-bounds-one-packet-is-discovered-by-t04-and-is-set-from-outside.md)).

**ND-10** `[connector]` — A **cap** is discovered by being refused, not by being published. The `T04`
reject's message states the current cap, which is the whole discovery mechanism.

### 1.4 The greeting is a projection

**ND-11** `[connector]` — The x402 greeting's `extra` block MUST be derived from the same source as
this document. Where the two disagree the **document** is authoritative — the point being that they
cannot.

**ND-12** `[connector]` — The greeting keeps its own job: **terms for one specific priced route**, in
band, to a client that just tried to use it. It is not a node description and MUST NOT be treated as
one.

The greeting therefore carries what a client needs _at that moment_ — `payTo`, `maxTimeoutSeconds`,
the route's price, `sessionLeaseTtlMs` — alongside the projected node facts. Fields that exist only to
serve an in-flight transaction stay there and are not promoted.

---

## 2. Forwarded routes: whose identity?

**ND-13** `[client]` — A client paying a **forwarded** route MUST seal to the **terminating**
connector's identity, not to the first hop's. A packet sealed to the wrong hop cannot be opened at its
destination, and every hop between is by design unable to help.

**ND-14** `[connector]` — A connector MUST NOT relay another node's identity key as if it were an
answer. A client learns an identity **from the node that owns it**.

> This is the sharpest rule in the document, and the reasoning is not stylistic. If a hop supplies the
> key it will forward to, it can supply **its own**: the client seals to it, that hop opens the payload
> and derives the fulfilment itself ([ADR 0019](../adr/0019-a-terminating-connector-derives-the-fulfilment.md)),
> terminates the packet and pockets the payment. The client receives a **valid-looking fulfilment and
> never learns it was robbed**. Sealing exists so that no hop between sender and destination can open a
> payload; letting a hop name the key hands back exactly what sealing took away.

**ND-15** `[connector]` — A termination that cannot open a packet's wrap MUST answer with an unsealed
reject carrying **where to ask** — the terminating connector's URL.
([ADR 0054](../adr/0054-an-unsealed-termination-reject-answers-where-to-ask.md))

**ND-16** `[client]` — A client MUST NOT trust an identity learned from an unsealed reject. It fetches
the identity from the URL, over TLS, from the node itself. **Ask direct, pay through.**
([ADR 0022](../adr/0022-a-connector-answers-it-does-not-announce.md))

A URL is safe where a key is not: a substituted URL yields an identity that produces packets the real
terminating connector cannot open, so a sender finds out on the **next packet** rather than losing
money silently.

### The flow, end to end

1. Client probes the route. It cannot seal, so the termination answers an unsealed reject.
2. That reject names the terminating connector's **URL**.
3. Client `GET`s that URL — the terminating node's own self-description — and reads its **edge identity**.
4. Client seals to it and pays **through the first hop**, which forwards without ever opening anything.

---

## 3. Consistency

Uses exactly the vocabulary of [`CONTEXT.md`](../../CONTEXT.md) and implements
[ADR 0050](../adr/0050-a-connectors-url-resolves-to-its-self-description.md),
[ADR 0022](../adr/0022-a-connector-answers-it-does-not-announce.md),
[ADR 0046](../adr/0046-the-kind-10032-announce-is-removed-a-connector-needs-no-relay.md) and
[ADR 0054](../adr/0054-an-unsealed-termination-reject-answers-where-to-ask.md).

**Built (#1080):** the endpoint. `GET /ilp` answers this document, free and unauthenticated,
projected from live state on each request; the x402 greeting's `extra` node facts are read off the
same value (ND-11); `[announce]` is `[node]` with its three surviving fields and every other key
refused by name; and the announce itself is gone (#1074).

**Not built:** the unsealed reject's URL (#1083, ND-15) and route descriptions
([ADR 0044](../adr/0044-a-probe-answers-what-a-route-costs-and-what-it-does.md)).

**Issue #981 is closed by construction.** There is no `solana_chain_id` in the tree — not defaulted,
not overridable, not compared against anything. A Solana entry's `chain` is what
`SolanaSettlementBackend::connect` reported after proving the program against the chain, and no
consistency check was added because there is no second source to check against.

**Issue #1026 is not.** ND-06 is built — the terminating connector publishes the key a packet is
sealed to — but that is the _publication_ half, and each node's `GET /ilp/identity` already published
the same key before this landed. The half #1026 actually lacks is the _discovery_: how a client
learns the terminating connector's URL without asking a hop, which ND-14 forbids answering. That is
ND-15/#1083. Until it is built, a forwarded route is reachable only by a client that already knows
the terminating node's URL out of band.
