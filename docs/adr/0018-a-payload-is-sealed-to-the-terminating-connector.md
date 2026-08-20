# A packet's payload is sealed to the terminating connector

**Status:** Accepted. Bounded by [0032](0032-a-client-destination-is-never-a-route-termination.md) — "the terminating connector" means a route termination, never a client destination. Live: `connector-signer`'s gift wrap, `connector-domain::envelope`.

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
