# Permissionless payment is guaranteed, and a claim — never an identity — is what authorises it

**Status:** Accepted. The client edge's identity, authentication and privacy surface appeared in **none** of the first 51 records; this is its first. Bounded by [0047](0047-the-configuration-schema-is-implementation-detail-capabilities-are-law.md) on what is law and what is spelling.

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

**A conforming connector accepts payment from a buyer it has never heard of, whose channel it
resolves from chain.** Registration with an operator is never a precondition for paying. What
authorises a packet is a **verified claim**; an identity authorises nothing.

## Why this is a guarantee and not an operator choice

The obvious objection is [0006](0006-the-connector-is-mechanism-not-policy.md): whether to serve
strangers looks like policy, and policy lives outside the connector. **It is the other way round.**

0006 keeps _discovery and route policy_ out of the connector — which peers exist, which routes are
carried. Accepting a valid payment for a route the operator already chose to publish is not policy; it
is the function. A connector that refuses a verified claim for a route it advertises and priced is
refusing its own purpose.

And the operator's lever already exists, one layer down: **reachability**. A node on a private segment,
or behind an allowlist, is unreachable by strangers whatever this record says. So "must accept" binds
only nodes that are _actually reachable_ — exactly the nodes where it matters. Making it a per-node
switch would put a "should I serve strangers" decision **inside** the connector, which is less
mechanism-not-policy than this record, not more.

The alternative was fatal to the network's shape: if every edge may require registration, TOON is not a
network but a collection of private services that share a wire format.

## What authorises a packet

**A verified claim.** The claim's signature is checked against **this connector's own record of the
channel** — a `[[client_channels]]` row an operator wrote, or a channel resolved from the chain the
`[settlement.*]` section already names. Never against anything the claim declares about itself.

**Unverifiable is never accepted, by configuration, flag or build profile.** A registry with neither a
record nor a source refuses; a source that cannot answer — an unreachable RPC endpoint — refuses the
claim it was asked about, distinguishably and never silently. There is no degraded mode, no
"accept-and-reconcile", and no build in which this weakens.

**An unaffiliated buyer registers with the chain, not with the operator.** That is a public fact this
connector reads for itself, which is what makes anonymity a first-class path rather than a
concession.

## Identity is a label, not a gate

`[[client_identities]]` — an `id` presented as `ILP-Peer-Id`, with a secret presented as
`Authorization: Bearer` — **identifies** a client. It does not authorise payment and cannot substitute
for a claim.

- **The negotiation is law**: a client may present an identity; a wrong or unknown secret is refused
  with `401`; an absent identity is not an error. A client SDK must be able to rely on all three.
- **What an identity buys is local policy** — in this implementation, its own bucket in the
  unresolvable-lookup shaper. A second implementation may grant it something else, or nothing.
- **An empty secret means permissionless**: the identity is a name, not a credential.

Per [0047](0047-the-configuration-schema-is-implementation-detail-capabilities-are-law.md), the
`[[client_identities]]` table itself is spelling. That an identity can be presented, and what happens
when it is wrong, is observable and therefore law.

## The bound that makes the guarantee affordable

Anonymity is asymmetrically expensive: resolving a previously-unseen channel costs one chain read, and
a sender naming a fresh nonexistent channel id per request makes this connector spend its metered
settlement-RPC budget indefinitely. Every such claim is refused — nothing is paid and nothing is
delivered — _and that is exactly what makes it attractive_: the exchange is free in one direction only.

**A conforming connector MUST bound the chain lookups an unidentified sender can cause, and MUST
refuse rather than serve when the bound is reached.** The bound's existence and its refusal behaviour
are law; the numbers are policy — the same split
[0047](0047-the-configuration-schema-is-implementation-detail-capabilities-are-law.md) drew for
`btp_session_window`. Without this bound, the guarantee above would ask operators to accept an
unbounded cost from strangers, and would not survive contact with a busy edge.

## Transport privacy is the client's choice, and a connector accepts both

A claim may be presented in plaintext or NIP-59-wrapped
(`ILP-Payment-Channel-Claim-Wrapped`): a rumor (the claim JSON), sealed to the receiver and signed by
the sender, inside a gift wrap keyed by a one-time ephemeral key so the wrap layer alone discloses
nothing about who sent it.

**Which form is used is the client's decision, and a conforming connector accepts both.** The threat it
answers is concrete and not hypothetical: these nodes run behind TLS terminators the connector's
operator controls, so a plaintext claim header is legible to the proxy and to its logs, not merely to
the connector. A guarantee of permissionless payment that forced every payer to disclose itself to an
operator's infrastructure would be permissionless in name only.

## Consequences

**A second implementer has a baseline.** Before this record, the client edge's front door — sender
authentication, the anonymous path, and the wrapped claim header — was specified only in
`client-edge-spec.md`, which is non-normative under [0021](0021-vectors-are-normative-prose-is-not.md).
The likeliest second implementer is a client SDK, and it had nothing normative to build against.

**None of it is vectored.** No client-edge carriage vectors exist at all (issue #1073), so every rule
here enters [0045](0045-a-behavioural-rule-is-normative-prose-until-its-vector-lands.md)'s debt ledger
on arrival. That is the correct state for it, and the ledger is where the priority argument belongs.

**`peer_allow_plaintext_endpoints` is not a contradiction of [0027](0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md)'s
TLS requirement**, contrary to sweep finding F-49. It defaults to false; `true` is an explicit loopback
and test opt-in; a node that sets it logs a `WARN` naming every plaintext peering at startup; and it is
deliberately one node-wide switch rather than a per-peer field, _"where a per-peer field reads as an
ordinary property of that peering and would be copied into a production file one peer at a time."_
Recorded so it is not re-raised.

**RFC 9421 belongs to the operator surface only** ([0008](0008-operator-surface-splits-read-from-write.md)),
and is not used on the client edge (sweep finding F-12). That is correct rather than a gap: the client
edge authenticates payment by claim, and identity by bearer token, neither of which is an operator
write.
