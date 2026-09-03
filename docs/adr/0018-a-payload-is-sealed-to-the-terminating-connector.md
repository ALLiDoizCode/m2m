# A packet's payload is sealed to the terminating connector

**Status:** Accepted. Bounded by [0032](0032-a-client-destination-is-never-a-route-termination.md) — "the terminating connector" means a route termination, never a client destination. Live: `connector-signer`'s gift wrap, `connector-domain::envelope`. **Amended by [0054](0054-an-unsealed-termination-reject-answers-where-to-ask.md)** (issue #1071): a reject raised _at_ a termination is **not always sealed** — a termination that never recovered the shared secret (no identity key, or a wrap it could not open) answers in plaintext. `CONTEXT.md` carried the correct law throughout and this record did not. Its `GET /identity` citation is one path segment short of `/ilp/identity`; the key reported there is the sealing key. **Its Consequences contradicted themselves** on key discovery — "not settled here" in one paragraph, "ADR 0022 settles how" four paragraphs later; [0022](0022-a-connector-answers-it-does-not-announce.md) settles it, and the second Update below is the correction.

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

A packet's `data` is always a gift wrap addressed to the identity of the connector that terminates
its route. Inside sits a structured envelope and the secret that packet's fulfilment derives from.
Opacity in carriage stops being a rule hops are asked to keep and becomes one they cannot break.

## Context

ADR 0016 established that a forwarding hop never interprets a payload and a terminating one does,
and left that as a rule. Nothing prevented a hop from reading a payload it was merely forbidden to
read. The payload was also plaintext, so every hop on a path could see the method, target, headers
and size of every request crossing it. For a network whose proposition is paid carriage between
parties that need not trust one another, "we agreed not to look" is a weak guarantee and an
unmeasured leak.

The prototype's envelope was an HTTP/1.1 request as text (ADR 0017). Parsing attacker-supplied text
at the point where money changes hands invites the vulnerability classes that exist _because_ HTTP
framing is subtle — request smuggling, header injection, ambiguous body boundaries. The prototype's
own parser already showed the shape of it.

## Decision

**Every packet's `data` is a gift wrap**, and the seal runs in both directions.

**On a PREPARE**, the sender seals to the terminating connector's identity key — the key that
connector already holds (`connector-signer`, uncompressed secp256k1, reported at `GET /identity`).
The wrap carries two things:

- **the envelope**, as a _structured_ encoding — a method, a target, headers and a body going in; a
  status, headers and a body coming back — not as HTTP text. `connector-domain` already carries an
  OER codec (`oer.rs`) for packets.
- **a shared secret**, from which the fulfilments of that packet and its successors derive
  (ADR 0019).

**On a FULFILL, and on a REJECT raised at the termination**, the terminating connector seals its
answer back with that same shared secret. No second exchange is needed; the secret is bidirectional
by construction. Sealing only the request would have left the app's answer — a store's returned
content, a relay's confirmation — readable by every hop on the return trip, which is half the
conversation and was never the intent.

**A reject raised short of the termination is necessarily plaintext.** An intermediate hop rejecting
for no-route, expiry or ceiling shares no secret with the sender and cannot seal anything.

`accumulated_cost` (ADR 0020) stays **outside** the wrap in every direction: each hop adds its own
fee to a reject travelling back, so that field cannot be sealed. The separation already exists —
`packet.rs:388` asserts the running total does not ride the OER encoding but beside it.

Only the intended reader can open a wrap. Every other hop carries bytes it cannot read.

## Considered options

**Carry the secret as a header of a plaintext envelope.** Cheaper, and conformant with the
prototype's format since its envelope already carries arbitrary headers. Rejected: it leaves the
envelope readable, so opacity stays a norm, the metadata leak stays open, and any hop that peeks can
take the secret and be paid without forwarding.

**Keep the envelope as HTTP text inside the wrap.** Readable with `xxd`, and nearly a pass-through
to the app. Rejected: the wrap already removes plaintext inspection, so the debuggability argument
buys nothing — and a lenient text parser at a paid boundary is the sharpest edge in this design.

## Consequences

Every terminated packet now costs an ECDH and an AEAD decrypt, on the packet plane. This has not
been measured. ADR 0015 was written over a `HashMap` clone per packet; this is heavier, and should
be measured before it is load-bearing.

Operators lose plaintext packet inspection, including in logs. Anything that needs to read an
envelope needs the key.

Discovery becomes a hard dependency. A sender must know the public key of the connector terminating
its destination before it can form a packet at all. Under a plaintext envelope a wrong guess meant
"delivered but unpaid"; now it means undeliverable. How a sender learns that key is not settled
here.

The app is unaffected. It is handed ordinary HTTP by a connector that has already unwrapped and
decoded, so "any HTTP service is a TOON node app" still holds. What changed is only the format
between a sender and the connector that terminates for it.

A sealed reject is **authenticated**, and that is a gain rather than a side effect. Only the
terminating connector holds the secret, so only it can produce one — which means a sender can
finally distinguish _"the destination said no"_ from _"someone on the path said no."_ Today those
are indistinguishable, and any hop can forge the former.

The sender must hold the terminating connector's public key before it can form a packet at all, and
must have obtained it in a way an intermediary cannot have tampered with. ADR 0022 settles how.

## Update — the wrap is deliberately **unauthenticated**, and that is a property, not an omission

This record settles that only the intended reader can open a wrap. It never states the converse, and
the converse is equally load-bearing: **the wrap says nothing about who sealed it, and cannot be made
to.**

### The construction

`connector_signer::giftwrap::seal_request` runs ECDH between a **fresh per-packet ephemeral secret**
and the receiver's identity public key. **No sender key participates.** The sealed request is:

```
0x01 ‖ ephemeral secp256k1 public key (65 bytes, uncompressed) ‖ AEAD ciphertext
                                                                 └─ shared_secret(32) ‖ envelope
```

The ephemeral public key rides in the clear, because the receiver needs it to redo the ECDH — but it
is drawn fresh from the CSPRNG for every packet, so it is unlinkable across packets and carries
nothing about its author.

**The shared secret is not derived from the ECDH.** It is 32 independent CSPRNG bytes, sealed
_inside_ the envelope the ECDH-derived key encrypts. That separation is what the rest of this update
rests on.

### What it buys

- **Deniability, in the strong sense.** The secret is a function of no key pair, so holding it
  evidences nothing about who produced it. A receiver can trivially fabricate a wrap "from" anybody —
  sealing needs only a public key — so a receiver can never demonstrate to a third party that a given
  wrap came from a given sender.
- **Unlinkability.** Two packets from one sender share no observable value. The ephemeral key is the
  only sender-side material on the wire and it is fresh each time.
- **Nothing to compromise later.** There is no long-term sender key whose disclosure would retro-open
  past wraps, because there is no long-term sender key in the construction at all.
- **A fulfilment proves opening, never identity.** [ADR 0019](0019-a-terminating-connector-derives-the-fulfilment.md)'s
  derivation runs over the random secret, so producing a valid fulfilment demonstrates that you opened
  the wrap or were handed what was in it — and demonstrates nothing else. This is what keeps ADR 0054's
  sealed-reject property about _the destination_ rather than about a named party.
- **The receiver's key never leaves its boundary.** `open_request` goes through `Signer::ecdh`, so a
  KMS backend opens a wrap without exposing secret key material.

### What it costs, and the rule that follows

**Zero sender authentication.** Anyone holding a node's public identity key — which is served to
whoever asks, by [ADR 0022](0022-a-connector-answers-it-does-not-announce.md) — can seal a wrap that
opens cleanly. It follows that **a terminating connector MUST NOT treat "this wrap opened" as evidence
of who sent it**, and MUST NOT derive authorisation from it. Authorisation comes from the claim that
paid, never from the payload that opened.

Deniability and authentication are the same coin here. Taking sender authentication would mean binding
a sender key into the seal, and every property above would go with it.

### The alternative this rejects, stated so it is not re-proposed

Deriving the shared secret from a **static-static** ECDH — the sender's long-term key against the
receiver's — is the obvious cheaper construction, and it destroys all of the above at once: the secret
becomes a cryptographic binding between two named identities, either party can later evidence the
other's participation, and compromise of one long-term key retro-opens every wrap ever exchanged with
it. Minting the secret independently and carrying it inside the wrap is what avoids that, and is why
it is done that way rather than derived.

### Two things this does not say

**It is not the claim wrap.** `connector_signer::nip59` — the client-edge
`ILP-Payment-Channel-Claim-Wrapped` header — has an inner **seal layer that IS ECDSA-signed by the
sender**, so its receiver does learn who sent it and only outside observers do not. Opposite property,
different path; the two must not be conflated.

**Deniability is a property of the wrap, not of the path.** Every hop authenticates its _immediate_
upstream and records it durably: an operator origination is RFC 9421-signed, a peer crossing carries
the peering credential and a claim on a configured channel, a client arrival carries its client claim,
and accepted claims land in the journal. So a hop knows who handed it the packet and does not know who
handed it to _them_. What the wrap withholds is the **original sender**, from everyone including the
termination.

## Update — key discovery **is** settled, and this record said both things

Two paragraphs of Consequences above disagree with each other. One says _"How a sender learns that
key is not settled here."_ Four paragraphs later another says the sender _"must have obtained it in a
way an intermediary cannot have tampered with. ADR 0022 settles how."_ Both were left standing. **The
second is right**; the first is stale and should be read as superseded by it.

[ADR 0022](0022-a-connector-answers-it-does-not-announce.md) settles discovery: a connector
**answers** what its own configuration already says — its identity, and what a route of its costs —
and a sender **asks it directly**, over its own connection, paying through whatever path routing
chooses. `GET /ilp/identity` is that answer. The guarantee is structural rather than cryptographic:
_"Nothing carries the answer but the connection that requested it, so there is nothing in between to
substitute."_

**What that does and does not defend.** The threat ADR 0022 names is a hop **on the packet path**
substituting its own key — it can, because a greeting and a reject pass back through it. Asking
directly defeats exactly that, by taking the question off the path the packet travels. It does not
make the direct connection itself tamper-proof; that is the transport's job, and ADR 0022's own
consequences assume a TLS-terminated one. A sender dialling `http://` — as every `local/` topology
does, behind `peer_allow_plaintext_endpoints` — has the structural guarantee and not the transport
one.

**And a substituted identity key is not detectable after the fact.** `connector send` does carry an
`Outcome::FulfilledWithWrongFulfillment` check, but it catches a node answering with a fulfilment it
could not have derived — not an attacker who served their own key at `/ilp/identity`. That attacker
opens the wrap legitimately, recovers the secret, derives a valid fulfilment, and is paid without
ever delivering. The check stays silent, because from the sender's side nothing is wrong. This is why
ADR 0022 rejected trust-on-first-use with pinning as the primary answer — it makes substitution
detectable only afterwards — and why it keeps a signed announce binding address to key as the
**fallback** for a terminating connector that cannot be reached directly.
