# Request-request binding ships no new mechanism

**Status:** Accepted. It ships no mechanism, so there is nothing in the tree to check: what closes the threat is [0018](0018-a-payload-is-sealed-to-the-terminating-connector.md), [0019](0019-a-terminating-connector-derives-the-fulfilment.md) and the client claim gate that predates both.

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

Issue #508 asked whether a claim must be cryptographically bound to the specific request it paid
for, so that a captured claim cannot be replayed against different work or a cheaper route. It
need not. The threat the binding was designed against is already closed — mostly by construction,
the rest by the claim gate that predates this question — and the one party a binding mechanism
could still constrain is the party that would be trusted to verify it.

## Context

### The original design and why it stalled

Issue #508's original body (2026-07-27, rewritten 2026-08-10) specified request-request binding as
an RFC 9421 HTTP Message Signature over the _inner_ envelope a terminated route proxies to its
app, plus an RFC 9530 `Content-Digest` and a `TOON-Price` header compared byte-exact against the
route's price — signed by the client, verified by the terminating connector before it proxies.
`docs/protocol/client-edge-spec.md` §1.5 carried that design under a `**Not yet implemented.**`
banner until this decision; it was written against a plaintext envelope and a v1 wire that
[ADR 0017](0017-the-typescript-connector-is-a-prototype.md) retired, and neither shipped nor was
attempted. The original nine acceptance criteria (preserved in issue #508's edit history) named
the property the mechanism was meant to buy: a captured claim, replayed against a different
request or a cheaper route, must be refused, and refused before the app is contacted.

Issue #498 (the parent epic, rewritten 2026-08-10) re-scoped the ticket rather than dropping it:

> Request-request binding is re-scoped, not carried forward. Its original threat — an observer
> capturing a claim and replaying it against different work — is largely closed by construction
> once the payload is sealed and the fulfilment derives from the sealed secret. The residual
> threat needs restating before a mechanism is chosen. See #508.

This ADR is that restatement, and the decision it produces.

### What ADR 0018 closed

[ADR 0018](0018-a-payload-is-sealed-to-the-terminating-connector.md) (issue #524, shipped) decided
that every packet's `data` is a gift wrap, not a plaintext envelope: a sender seals the request
envelope and a freshly generated shared secret to the terminating connector's own identity key
(`connector_signer::giftwrap`, `client-edge-spec.md` §1.8). Its own words: "Only the intended
reader can open a wrap. Every other hop carries bytes it cannot read." A forwarding hop can no
longer see the method, target, headers or size of the request a claim accompanies — the original
threat's "observer who captures one [and replays it]" needed to read something a hop is now
structurally unable to read.

### What ADR 0019 closed

[ADR 0019](0019-a-terminating-connector-derives-the-fulfilment.md) (issue #525, shipped) decided
that the terminating connector derives a packet's fulfilment from the shared secret in that gift
wrap, rather than receiving one from the app. The packet's condition is therefore already bound to
a secret only the terminating connector can open — a second, independent reason a claim cannot be
walked to a different destination and made to pay for different work there, since no other
connector holds the secret the fulfilment for that packet depends on.

### What the claim gate already closes, and predates both ADRs

`client-edge-spec.md` §1.3 validates a present claim in five steps, "deliberately
freshness-and-value before cryptography, so a replay or an underpayment never pays the cost of a
signature verification and never reaches the terminating app." Three of those steps close most of
the original nine acceptance criteria on their own, independently of ADR 0018 and ADR 0019:

- **Step 2, freshness.** A claim's nonce MUST strictly advance this connector's last-verified
  watermark for the `(peer, blockchain, channel)` tuple; a non-advancing nonce is refused before
  cryptography is spent on it. This refuses a claim presented a second time against _any_ request
  — the original one included — not only a different one.
- **Step 3, value binding.** A claim's cumulative amount MUST advance by at least the destination
  route's configured flat price, read from the same longest-prefix lookup `GET /ilp/routes/price`
  and the x402 terms (§1.4) use. A claim that does not cover the route it is actually presented
  against is refused; there is no second source of truth for price to disagree with.
- **Step 4, signer authority.** The signature MUST recover to the counterparty _recorded for the
  channel the claim names_, never to the claim's own declared `signerAddress`/`signerPublicKey`.
  `crates/connector-client-edge/src/channels.rs`'s module doc states this plainly: "a claim gets no
  say in [who its counterparty is]... [`ClientClaimGate`] reads the signer... out of this registry
  and never out of the claim." This is what makes step 4 a check against a fact the connector
  itself holds, not a self-attestation a forger could satisfy by signing with a key of their own
  choosing.
- **Ordering**, which is a property of the gate rather than a step of it. "A claim that fails any
  check is a validation failure and the PREPARE is rejected before it reaches the terminating app
  or advances any watermark." Every refusal reason in §1.3 — structural, freshness, value,
  unverifiable signature, unknown channel, an unreachable settlement endpoint, an over-deposit
  claim — is its own distinguishable reason, stated as such at each step ("distinguishable from a
  bad signature and from an underpayment", "refused under a third, separate reason").

### Correction to the premise: no hop occupies the observer's position

The original threat named an "observer who captures [a claim] and replays it against different
work." That party does not exist on the path the client edge or the peer wire actually carries a
claim over, and this is a correction to issue #508's own premise, not new work performed here.

A client-edge claim is a per-hop artifact: it travels from the client directly to the one
connector that verifies it, and stops there. `docs/protocol/money-model-pre-868.md` states this as the
model's own foundation: "The client's claim never leaves box 1. Box 1's claim to box 2 is box 1's
own money." The value a claim carries is consumed into that connector's own accounting the moment
its watermark advances — it is never re-presented, re-signed, or forwarded to the next hop as
evidence of anything. A peer-wire claim is per-peering for the same structural reason:
[ADR 0031](0031-a-peer-prepare-arrives-with-its-covering-claim-or-it-is-greeted.md) requires every
peer PREPARE to arrive with its own covering claim, signed fresh on the channel between that one
pair of connectors, and a claim covering a forward is never itself forwarded onward.

So on both surfaces a claim moves exactly once, from its signer to the single party checking it,
and the payload it accompanies is unreadable to everyone else on the path in any case (ADR 0018).
There is no position on either wire from which a party could observe a claim addressed to somebody
else and hold it for reuse. The premise the original mechanism was built to defend against is not
weakened — it is vacant.

### The parties who remain

Vacating the observer does not vacate every party. Three remain, and each is considered against
what request-request binding would specifically have bought:

**(a) The terminating connector itself.** A signature binding a claim to its request would be
checked _by_ the terminating connector, the same party ADR 0019 already names as able to "fulfil
without delivering — take payment, never call the app, and return a fabricated response envelope."
A party that controls whether a check runs at all is not constrained by adding a check it also
controls: a dishonest terminating connector can simply not perform the verification, or perform it
and discard the result, exactly as it can already skip calling the app. Binding structurally
cannot defend against its own verifier. This is the strongest single reason not to build it.

**(b) A holder of the payer's claim-signing key.** Step 4 verifies a claim's signature against the
counterparty the connector has on record for the named channel — which is to say, against the
payer's own key. Anyone holding that key is, by the gate's own definition, the payer: they can sign
a fresh claim naming any nonce, amount and (had a binding shipped) any request digest they choose,
because signing the binding costs them nothing more than signing the claim already did. A binding
proves only that the same key signed the claim and the request it accompanies — which a key holder
satisfies trivially, since they hold the one key both signatures would need. Request-request
binding was never a defence against this party; possession of the signing key already grants
everything a binding would additionally check.

**(c) Anything that can terminate or intercept the client's transport to its first connector.** A
purely passive eavesdropper on that transport gains nothing actionable: the watermark (step 2)
accepts a given nonce at most once, so replaying a claim the connector has already accepted is
already refused, binding or not. An active party sitting on the transport and able to substitute
its own request under a claim it captured before the legitimate request reached the connector is
the one scenario a signed digest-and-price binding would have caught, since the digest would no
longer match. But such a party, sitting between the client and its first connector, can just as
well suppress the client's own request and originate its own — at which point it needs no captured
claim at all, since it is already positioned to author whatever the client would have sent. The gap
binding would close is narrow — a captured, not-yet-consumed claim substituted onto different work
by a party who does not otherwise control the transport — and no incident or design surface in this
repository suggests that gap has ever been exploited or is presently reachable: TLS on `POST /ilp`
and the client-BTP websocket carriage (§1.9) are what actually stands between a client and its
first connector, and defending their integrity is a transport concern, not a claim-binding one.

## Decision

**No new mechanism.** Request-request binding, as issue #508 specified it, does not ship.

Two of the threat's three original components are closed by construction (ADR 0018 removes the
observer who could read a request to replay against; ADR 0019 binds the packet's condition to a
secret only the terminating connector holds) and the third is closed by a mechanism that predates
this ticket (the §1.3 claim gate's watermark and value binding). What remains is not a gap a
signature over the envelope would close: the terminating connector is the mechanism's own verifier,
a key holder already has everything a binding would check, and a transport-level interception is a
transport problem no packet-level signature reaches.

## Considered options

**Build §1.5 as specified** — an RFC 9421 signature over the inner envelope, an RFC 9530
`Content-Digest`, and a `TOON-Price` header, verified by the terminating connector before proxying.
Rejected: verified by the one party (a) above that a binding cannot constrain, defends nothing new
against (b), and against (c) closes only a narrow substitution window with no evidence it is ever
open in practice — at the cost of a per-packet signature verification on every terminated request
and a signing requirement the fleet's own client (`toon-client`) does not implement today.

**A narrower, price-only binding** — carry the route's price inside what the claim signs, without
signing the full envelope. Rejected as redundant: §1.3 step 3 already binds a claim's value to the
route's price via the same longest-prefix lookup the x402 terms and `GET /ilp/routes/price` use. A
second, claim-carried price assertion would either have to agree with that lookup, in which case it
adds nothing, or could disagree with it, in which case it is a second source of truth this protocol
does not otherwise have and should not introduce here.

**No new mechanism.** Chosen, for the reasons above.

## Consequences

No production code changes with this decision — no crate, wire format, config field or header is
touched. `client-edge-spec.md` §1.5 is corrected to record the decision rather than continuing to
describe an unimplemented design as pending; its considered-and-declined mechanism stays legible as
the record of what was evaluated.

The residual risk is exactly the one [ADR 0019](0019-a-terminating-connector-derives-the-fulfilment.md)
already named and accepted, unchanged by this ticket: "The defence is not cryptographic, and this
ADR does not pretend otherwise. It is that the payer chose this counterparty, that the response
envelope is evidence of what the connector claims happened, and that a connector doing this
systematically is identifiable and can be refused as a peer." This ADR does not add to that
defence; it confirms that nothing request-request binding would have added survives contact with
who actually holds the verifying position.

Issue #498's re-scoping is answered: "the residual threat needs restating before a mechanism is
chosen" is restated above (parties (a)–(c)), and the restatement concludes no mechanism. The
epic's "See #508" now resolves to a decision rather than to an open question.

**This decision is reopened, not merely revisited, if any of the following becomes true:**

- a hop is introduced anywhere on the client edge or peer wire that forwards a claim to a party
  other than the one that verifies it — the "per-hop artifact" property this ADR relies on would
  no longer hold;
- the terminating connector's verification of a request-request binding could be made itself
  externally checkable (for example, attested or replayable by a third party), which would answer
  party (a)'s objection directly; or
- concrete evidence surfaces of claim capture-and-substitution on the client's transport to its
  first connector (party (c)) — none is known today.

### Original acceptance criteria, accounted for

Issue #508's original nine acceptance criteria (preserved in its edit history) all presumed the
mechanism this ADR declines to build. Each is recorded below as satisfied by an existing mechanism,
or vacated along with the mechanism it presumed:

| Original acceptance criterion                                                                      | Disposition                    | Mechanism                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A request whose signature covers its envelope, digest and price is accepted                        | Vacated                        | no binding signature is defined; §1.3 alone decides acceptance                                                                                                                     |
| A claim replayed against a different request is refused                                            | **Satisfied**                  | §1.3 step 2, the watermark: a non-advancing nonce is refused regardless of which request accompanies it                                                                            |
| A claim replayed against a route with a different price is refused                                 | **Satisfied**                  | §1.3 step 3, value binding, against the same longest-prefix price lookup §1.4/§1.7 use                                                                                             |
| A structural or cryptographic binding failure and a price mismatch produce distinct reject codes   | Vacated, property already held | §1.3's existing refusal taxonomy already gives structural, freshness, value, signature, unknown-channel and deposit failures each their own distinguishable reason                 |
| The underlying failure reason travels in the reject message                                        | Vacated, property already held | each §1.3 step states its own refusal reason; nothing here changes how those reasons are reported                                                                                  |
| A present signature is verified even on a route that does not require binding                      | Vacated                        | no binding signature exists to verify                                                                                                                                              |
| An absent signature is refused only where the route requires binding, otherwise proceeds unchanged | Vacated                        | no route requires a binding signature                                                                                                                                              |
| A route that does not terminate locally never performs this check                                  | Vacated                        | there is no such check to skip; the claim gate itself deliberately does not tell the two kinds of route apart ([ADR 0028](0028-a-forwarded-route-is-priced-at-the-client-edge.md)) |
| A packet failing binding is rejected before the app is contacted                                   | Vacated, property already held | §1.3's own ordering already rejects any claim failure before the app is reached                                                                                                    |
