# A connector answers when asked; it still never announces

A connector tells whoever asks what its own configuration already says — its identity, and what a
route of its costs. It still never pushes that into a network unprompted. A sender **asks directly
and pays through the network**, which is what makes the answer trustworthy.

## Context

ADR 0018 requires a sender to hold the terminating connector's public key before it can form a
packet at all. Getting that key wrong is not a delivery failure: an attacker whose key is used can
read every envelope, which is precisely the confidentiality ADR 0018 was adopted to obtain.

The obvious route — carry the key back in a reject, as ADR 0011 carries accumulated cost — does not
survive contact with the threat model. Hops rewrite rejects by design (`connector.rs:719` adds each
hop's fee to a reject passing back), so any hop on the path can substitute its own key into a
greeting in flight. Intermediaries are exactly the parties positioned to do this, and exactly the
parties the wrap exists to defend against. Signing the greeting does not help, because verifying the
signature requires the key being learned.

Meanwhile a negotiation surface is needed regardless, for connector-to-connector peering: two
operators deciding to peer have to exchange identities and terms somehow.

`CONTEXT.md` and ADR 0006 say flatly that "the connector never learns, announces, or discovers", and
ADR 0011 removed both `announcePrice` and the x402 greeting, saying "Neither is reinstated." Taken
literally that forbids the endpoint. Taken as written it does not, because two different things had
been sharing one word.

## Decision

**Answering is not announcing, and a connector does the first but not the second.**

- **Announcing** is pushing facts about yourself into a network unprompted — `announcePrice`,
  kind:10032 self-announce. A connector never does this. Deciding to participate in a discovery
  network is the controller's business, and ADR 0006 stands unchanged.

  > **Read alongside [ADR 0030](0030-an-operator-announces-a-node-the-node-still-does-not.md)
  > (2026-08-05, issue #784):** the second sentence of this bullet is the operative one. A running
  > connector still never announces — no timer, no startup broadcast, nothing on the packet path.
  > An **operator** may, by running `connector announce` on the node itself: the controller
  > deciding, once, with the identity key never leaving the box and the write paid for like any
  > other. ADR 0030 does not weaken this rule about the process; it names who the verb belongs to.

- **Answering** is telling whoever asks what your own configuration already says. It decides
  nothing, and reaches nobody who did not ask. `GET /identity` on the operator surface is already
  this, for a different audience.

A connector answers **on the client edge**, the surface already public and already defined as the
one whose far end is "installed on machines the operator does not control". A request either carries
payment and is served, or does not and is answered with the terms (ADR 0020). Both cases live on one
port because they have one audience and one exposure, and are already separated by whether payment
was attached.

The key property is the asymmetry between the two paths: **a sender asks the terminating connector
directly, over its own connection, and pays through whatever path routing chooses.** Nothing carries
the answer but the connection that requested it, so there is nothing in between to substitute. The
x402 body shape (`accepts[]`, a list of acceptable payment methods) is a good fit for what an answer
must carry, since terms are plural.

For peering the same endpoint serves: both ends of a peer wire are operator-controlled by
definition, so two operators who have decided to peer exchange endpoints out of band and verify over
a direct connection.

## Considered options

**A signed announce binding address to key**, verified against an identity the client already
trusts. Genuinely solves substitution, and the org has the machinery. Rejected as the primary
mechanism because it needs a trust root, a distribution path and a revocation story to answer a
question a direct connection answers for free — and because the endpoint has to exist anyway for
peering. It remains the fallback if a terminating connector ever cannot be reached directly.

**Trust on first use with pinning.** Cheap; makes substitution detectable after the fact rather than
prevented. Rejected: first contact is the contact that matters.

**A second, separate port for answering.** Answering could never be confused with serving, and the
two could be firewalled apart. Rejected: it doubles what must be bound, TLS'd and rate-limited to
separate two cases already separated by whether payment was attached.

## Consequences

**A connector that terminates a priced route must be reachable by anyone who may buy from it**, even
when no packet is ever routed to it directly. On devnet a client sends its packet to the apex and
the apex forwards over the peer wire, so the store connector need not be reachable today. Under this
decision it must be — to be _asked_, while still being _paid_ through the apex. Ask direct, pay
routed.

This does not disturb #492's finding about the peer wire, which stays private, plaintext and
unauthenticated on its own segment. It is the client edge that becomes public on boxes where it is
not, and that is a different port with different exposure.

> **Superseded consequence (2026-08-03,
> [ADR 0027](0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md)):** the peer
> wire no longer "stays private, plaintext and unauthenticated on its own segment" — it is deleted,
> and connector↔connector traffic becomes an authenticated, TLS-terminated BTP session on a public
> `wss://` URL. This ADR's own decision — a connector answers, it does not announce — is unaffected,
> and its "ask direct, pay routed" shape is unchanged.

An unauthenticated public endpoint returning identity and prices is a denial-of-service surface, and
prices stop being private. Both are accepted as the cost of selling.

**Paying over HTTP is deliberately deferred, not rejected.** A connector fronting an app could
plausibly accept a plain HTTP request with payment attached — the x402 onramp, for a client with no
ILP stack and no channel — and answer `402` with terms when payment is absent. That is a second
architecture with its own payment verification (a one-shot exact payment settles per request, which
inverts ADR 0004 and 0005's "claims are constant, settlement is rare"), and it is out of scope here.
Answering over HTTP while paying over ILP is a different and smaller thing, and is what this ADR
decides.
