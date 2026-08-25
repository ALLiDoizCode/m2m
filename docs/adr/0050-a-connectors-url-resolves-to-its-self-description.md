# A connector's URL resolves to its self-description

**Status:** Accepted, **not yet built**. Completes [0022](0022-a-connector-answers-it-does-not-announce.md) by giving "answering" a single surface, and is what [0046](0046-the-kind-10032-announce-is-removed-a-connector-needs-no-relay.md) leaves behind when the announce is removed. Narrows [0003](0003-clean-room-peer-wire-versioned-client-edge.md)'s version-discovery mechanism onto this document.

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

**Falsifier:** `crates/connector-client-edge/src/**/*.rs` matching `\.route\("/ilp",.*\bget\(` — the address this record chose is `GET /ilp`, and today the edge registers `POST` there and nothing else, so a `GET` answers `405`. Registering a `GET` handler on that exact path is unavoidable for anything that implements this record.

**`GET` on a connector's own URL returns its self-description**: the facts a stranger needs to
transact with it, as one document, with no ILP packet, no encoder and no protocol knowledge required.
The x402 greeting becomes a projection of it. It carries **facts only** and never accepts a `POST`.

## Why one document, and why at that URL

Before this record a node described itself in **two** places with **different field sets** — the x402
greeting's `extra` block and a kind:10032 announce — and neither was authoritative. Neither was a
superset of the other. That is not a tidiness problem: `requiredTransport` was _enforced_ long before
it was _advertised_, toon-client's guard read a key no announce carried, and every relay publish was
refused. Verified live 2026-08-14 — not one announce in the fleet's corpus carried the key in any form.

**The address is `GET /ilp`** — the same URL that already appears in every config, every greeting and
every operator's runbook. `POST /ilp` remains the packet endpoint; `GET` on it was unrouted and
answered `405`. A stranger who has this node's URL at all therefore has its description, with nothing
further to discover.

The alternatives both fail on a fact. A separate sub-resource (`/ilp/info`) is a second address that
must itself be discovered — reintroducing the step this document exists to remove. A well-known URI
(`/.well-known/toon`) assumes the connector owns the origin root; it does not, and `/ilp` is the mount
point precisely because the root is not the connector's to claim.

## What it carries

**Connector facts only** — things this node either proved at startup or was configured with, about
itself:

- its ILP address(es);
- its public client-edge endpoints, HTTP and BTP, and which carriages it exposes;
- its edge identity — the key a packet is sealed to
  ([0018](0018-a-payload-is-sealed-to-the-terminating-connector.md)). This closes issue #1026: a
  forwarded route is unreachable today because the terminating connector's identity is required to
  seal a packet and is published nowhere;
- per chain, the channel-opening facts a buyer needs — chain id, settlement address, token network
  and its registry, token address, decimals;
- its route prices, and their descriptions once [0044](0044-a-probe-answers-what-a-route-costs-and-what-it-does.md) is built;
- the client transport its routes require, when they agree on one;
- the client-edge versions it serves, and which one unversioned `POST /ilp` resolves to
  (issue #1054 — `GET /ilp/versions` is retired before it was ever built, and
  `client-edge-spec.md` §3.2 is rewritten to point here).

**It does not describe what runs behind the connector.** `relay_url` — an operator's assertion that a
Nostr relay for free reads sits behind this node — is **dropped**. [0046](0046-the-kind-10032-announce-is-removed-a-connector-needs-no-relay.md)
established that a conforming connector must work with no relay in the world, and this was the last
place that assumption survived. A connector is a paid reverse proxy; what is behind it is the app's
business and the operator advertises it elsewhere. The document's meaning stays uniform: **everything
in it is true of this connector**.

**It does not carry per-peer facts.** Caps and peerings are operator-private
([0049](0049-the-cap-bounds-one-packet-is-discovered-by-t04-and-is-set-from-outside.md),
[0006](0006-the-connector-is-mechanism-not-policy.md)): publishing them would disclose who this node
peers with and how far it trusts each.

## Facts only. There is no `POST`.

**This endpoint never accepts a write, and never becomes a surface on which a stranger requests
peering.** It publishes what an operator needs to configure a peering out of band; a peering itself is
created by an operator in the config file or through the operator surface, and by nothing else
([0043](0043-purchasable-peering-is-removed.md), [0006](0006-the-connector-is-mechanism-not-policy.md)).

This prohibition is stated rather than implied because the failure mode is obvious in hindsight and
slow to arrive: a self-description endpoint grows a `POST`, and purchasable peering is back through a
side door years after 0043 removed it.

## Consequences

**`[announce]` becomes `[node]`.** Its surviving fields — `addresses`, `http_endpoint`,
`btp_endpoint` — are exactly the facts a node cannot introspect about itself (a container sees
`0.0.0.0:4000`, never its public URL), and they already feed the x402 greeting's bootstrap identity
(issue #807). They move to a section named for what they are rather than for a verb that no longer
exists. Everything else in `[announce]` dies with the announce (issue #1074).

**Issue #981 closes by construction.** `[announce].solana_chain_id` defaults to `solana:devnet` and is
never checked against `[settlement.solana]`, so a mainnet node announces itself as devnet. It is a
**second declaration** of a fact the settlement backend already holds and verified against a chain at
startup. One authoritative document derives it from that backend, and the class of bug disappears
rather than acquiring a consistency check.

**The greeting is a projection, not a peer.** It keeps its own job — terms for one specific priced
route, in band, to a client that just tried to use it — and stops doubling as a node description.
Where the two disagree, the document is authoritative.

**No caching contract, and no TTL.** The document is generated from live configuration and read when a
client wants it. `ttl_secs` existed because a _pushed_ copy needed a shelf life; a pulled one does not,
and it does not come back.

**Free and unauthenticated**, which is what [0022](0022-a-connector-answers-it-does-not-announce.md)
already means by answering: it decides nothing and reaches nobody who did not ask. Rate limiting uses
the shaper that already guards unresolvable lookups rather than a mechanism of its own.
