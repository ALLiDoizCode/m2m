# An unsealed termination reject says where to ask, never what the key is

**Status:** Accepted, **not yet built**. Amends [0018](0018-a-payload-is-sealed-to-the-terminating-connector.md) with the carve-out `CONTEXT.md` already carried, and extends [0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md)'s probe the way [0044](0044-a-probe-answers-what-a-route-costs-and-what-it-does.md) does. Closes issue #1026.

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

**Falsifier:** `crates/connector-runtime/src/connector.rs` matching `fn unsealed_termination_reject\([^)]*,` — `unsealed_termination_reject` takes a message and nothing else. This record requires the reject it builds to carry the terminating connector's URL, which the connector has to be handed; a second parameter is the narrowest tell that the URL arrived.

**A reject raised at a termination is sealed — unless the termination never recovered the shared
secret, in which case it is plaintext and identifies nobody.** That plaintext reject carries **where to
ask** for the terminating connector's identity. It never carries the identity itself.

## The carve-out ADR 0018 was missing

[ADR 0018](0018-a-payload-is-sealed-to-the-terminating-connector.md) says a reject raised _at_ the
termination is sealed back with the shared secret, and that _"a sender can finally distinguish 'the
destination said no' from 'someone on the path said no.'"_

Two paths break that, both in `Connector::open_termination_request`:

- **no identity key is configured** — the connector cannot open a sealed payload at all;
- **the wrap does not open** — the sender sealed to the wrong key, or the wrap is malformed.

Both are rejects raised at the termination, and both answer in plaintext with empty `data`
(`unsealed_termination_reject`). `CONTEXT.md` has carried the correct law throughout:

> An **unsealed** reject proves nothing about who refused, because a termination that never recovered
> the secret — no identity key, or a wrap it could not open — also answers in plaintext. **Sealed
> identifies the destination; unsealed identifies nobody.**

The glossary was right and the record was not. This is the rare direction, and it is why the index's
"fix the glossary, never the record" rule does not apply here.

**Both cases stay `F01`.** Under [0051](0051-a-reject-code-binds-where-a-sender-must-act-differently.md)
`F01` is class-only, so the two need not be distinguished by code — and they need not be distinguished
at all, because the sender's next action is the same for both: read the terminating connector's
self-description and re-seal. Empty `data` is what marks a reject unsealed
(`giftwrap::looks_like_sealed_response`), and that is the only distinction a sender needs.

## Where to ask, and why not the key

A client paying a **forwarded** route must seal to the _terminating_ connector's identity while talking
only to the first hop. Today it cannot learn that identity, which is issue #1026: the route is
unreachable for any real client.

[ADR 0022](0022-a-connector-answers-it-does-not-announce.md) already fixed the rule — _"it must be
[reachable] to be **asked**, while still being **paid** through the apex. **Ask direct, pay through.**"_
What was missing was the pointer.

**The probe's reject supplies it.** A probe is a packet sent expecting a reject
([0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md)), and its reject already states the
accumulated cost of the path travelled; [0044](0044-a-probe-answers-what-a-route-costs-and-what-it-does.md)
already extends it to say what the route _does_. A probe that cannot seal — because it does not yet
know the identity — reaches the termination and receives the unsealed `F01` above. That reject carries
the terminating connector's **URL**.

**It must not carry the identity key.** An unsealed reject identifies nobody, so any hop on the path
can rewrite it. A reject carrying a key invites a hop to substitute its own: the client seals to it,
that hop opens the payload and derives the fulfilment itself
([0019](0019-a-terminating-connector-derives-the-fulfilment.md)), and terminates the packet while
pocketing the payment. The client receives a valid-looking fulfilment and **never learns it was
robbed**. Sealing exists precisely so no hop between sender and destination can open a payload; letting
a hop name the key hands back exactly what sealing took away.

**A URL is safe under the same attack.** A substituted URL yields an identity that produces packets the
real terminating connector cannot open, so the sender discovers it on the next packet instead of losing
money silently. And the client's trust anchor becomes TLS to that URL, which is what _ask direct_
means.

## Consequences

**Issue #1026 closes** — a forwarded route becomes reachable: probe, read the URL, fetch that node's
self-description ([0050](0050-a-connectors-url-resolves-to-its-self-description.md)), seal, pay through
the first hop.

**One extra round trip per unfamiliar terminating node**, and it is cacheable — an identity changes
only on rotation, which invalidates conditions already minted against the old key anyway.

**A forwarding connector must know its terminated peers' URLs.** For a route it forwards, the answer
comes from its own configuration; it is not derived and not asked for at packet time.

**Sweep finding F-68 does not survive.** ADR 0018 says the sealing key is _"reported at `GET /identity`"_
and it is — at `/ilp/identity`, and it is the same key: `with_identity_signer(signer.clone())` and the
client-edge router both take `runtime.signer`, _"one signing key for everything this connector owes, not
a second one minted for this edge alone."_ The record's path is one segment short. A citation nit, not a
gap.
