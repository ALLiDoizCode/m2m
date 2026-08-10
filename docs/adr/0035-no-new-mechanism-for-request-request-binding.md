# Request-request binding ships no new mechanism

Issue #508 asks whether a claim must be bound to the specific request it paid for, so that a
captured claim cannot be spent twice on different work. This ADR decides that it must not.
The protocol already refuses a replayed claim, already refuses an underpaying claim, and already
rejects an unpaid packet before the app is reached. The one party a binding could constrain is
the party that would have to verify it. Request-request binding ships no new mechanism.

## Context

### The re-scoping that led to this issue

Issue #498 re-scoped request-request binding: "Request-request binding is re-scoped, not carried
forward... The residual threat needs restating before a mechanism is chosen. See #508." This ADR
is that restatement. Issue #500 surveyed the client edge and found that toon-client builds real
envelopes and speaks the client edge in production, so the "nothing speaks the client edge"
escape hatch is closed: the client edge is a live surface with a live payer.

Issue #508 asks for a binding between a claim and the request it pays for: an RFC 9421 HTTP
Message Signature over the inner envelope of a terminated route's request, with an RFC 9530
`Content-Digest` and a `TOON-Price` header, verified by the connector that terminates the route
before it proxies to the app. The mechanism is specified in
[docs/protocol/client-edge-spec.md §1.5](../protocol/client-edge-spec.md#15-request-request-binding-rfc-9421)
as "Not yet implemented." Its premise is that "a claim is a bearer token for *any* request at
that price: an observer who captures one can replay it against a different request, or against a
different route costing less."

### What ADR 0018 closed

[ADR 0018](0018-a-payload-is-sealed-to-the-terminating-connector.md) (issue #524) decided that
every packet's `data` is a gift wrap (`connector_signer::giftwrap`, [client-edge-spec.md
§1.8](../protocol/client-edge-spec.md#18-sealing-issue-524)), sealed to the identity key of the
connector that terminates the route, carrying the request envelope and the shared secret the
fulfilment derives from. Its words: "Only the intended reader can open a wrap. Every other hop
carries bytes it cannot read." The observer who reads a payload in transit was removed as a
class: no hop on the path can see the method, target, headers or size of a request, and no hop
can take the secret.

### What ADR 0019 closed

[ADR 0019](0019-a-terminating-connector-derives-the-fulfilment.md) (issue #525) decided that at a
route termination "the terminating connector derives the fulfilment, from the shared secret the
sender sealed to it (ADR 0018). The app supplies nothing, and the `TOON-Fulfillment` response
header goes away." Issue #417's rule, that a connector never produces a fulfilment itself, is
kept for forwarding hops and dropped at terminations, because the terminating connector is the
counterparty the payer deliberately addressed, in the same trust domain as the app behind it.

### What the claim gate closes, independently of both ADRs

The claim gate of [client-edge-spec.md §1.3](../protocol/client-edge-spec.md#13-payment-claim)
predates both ADRs and closes most of the original threat on its own. It validates a present
claim in five steps, "deliberately freshness-and-value before cryptography", so a replay or an
underpayment never pays the cost of a signature verification and never reaches the app:

- **Freshness, step 2.** The claim's nonce MUST strictly advance this connector's last-verified
  watermark for the (peer, blockchain, channel) tuple. A non-advancing nonce is rejected without
  a cryptographic verification. A spent claim is refused, whatever request it is attached to.
- **Value binding, step 3.** The claim's cumulative amount MUST advance by at least the route's
  configured flat price, read from the same longest-prefix route lookup the x402 terms (§1.4)
  and the price answer (§1.7) charge and answer against. A minimal fresh claim cannot pay for an
  expensive route.
- **Cryptographic verification, step 4.** The signature MUST recover to the counterparty
  recorded for the channel the claim names, not to anything the claim declares about itself:
  [crates/connector-client-edge/src/channels.rs](../../crates/connector-client-edge/src/channels.rs)
  states it outright: "Nothing falls back to the claim's own self-declared signer." A claim
  naming a channel with no record is refused as `UnknownChannel`; unverifiable is never accepted.
- **Collateral binding, step 5.** The cumulative amount MUST NOT exceed the channel
  counterparty's on-chain deposit, so a claim that could never be redeemed is not served.
- **Ordering.** A claim that fails any check is a validation failure, and the PREPARE is
  rejected before it reaches the terminating app or advances any watermark. The gate is the same
  one the peer wire uses, and the same instance serves both the HTTP and the BTP carriages (§1.9).

### Correction to the premise: a claim is a per-hop artifact

The original ticket's "observer on the path" is not a party that exists, and this is a correction
to the premise of #508, not new work.

A claim is a per-hop artifact. A client-edge claim travels from a client to the one connector
that verifies it and stops there: [docs/protocol/money-model.md](../protocol/money-model.md)
states it as "The client's claim never leaves box 1. Box 1's claim to box 2 is box 1's own
money." The inbound claim is consumed, never forwarded, and the value it carries becomes that
connector's own money the moment its watermark advances. Peer-wire claims are per-peering: every
peer PREPARE arrives with its own covering claim, signed fresh on the channel between that pair
of connectors ([ADR 0031](0031-a-peer-prepare-arrives-with-its-covering-claim-or-it-is-greeted.md)),
and one connector's claim to another is never relayed onward either.

So no hop observes a claim addressed to somebody else. The party that verifies a claim is always
a party to it, and the claim travels directly from its signer to its verifier with nothing
between them. There is no middle position for an "observer on the path" to occupy, and the
payload of every packet on that same path is opaque to every hop but the terminating connector
(ADR 0018) in any case.

### The parties that remain

Three parties do remain, and each was considered against what a binding would have bought:

**(a) The terminating connector itself.** Request-request binding is verified BY the terminating
connector: it is the one party that checks the signature, the digest and the price before
proxying. A dishonest terminating connector is therefore the one party binding structurally
cannot defend against: it can skip the check, or declare it passed, exactly as it can already
take payment and never call the app (ADR 0019). This is the strongest single reason not to ship
a mechanism: the mechanism's only verifier is the party the mechanism would need to constrain.

**(b) A holder of the payer's claim-signing key.** Step 4 of the gate verifies against the
recorded counterparty, and that counterparty is the holder of the payer's key. Such a holder can
sign a fresh claim for any request, at any price, with any nonce, and with a binding in place it
can equally sign the binding over any envelope it chooses: a binding proves only that the claim
and the request carry the same signer, which is exactly what this party is. Binding would not
have defended against it. The key holder is indistinguishable from the payer, and does not need
to capture anything.

**(c) Anything that can terminate or intercept the client's transport to its first connector.**
A passive observer on the client's transport sees the claim in flight, but the connector accepts
a claim at most once: the watermark (step 2) refuses any second presentation, so capture-and-
replay of a claim the connector has already accepted is already refused. An active interceptor
that drops the client's request and presents the captured claim under its own work could spend
the claim once, and binding would refuse that substitution, since the digest and price checks
fail. But binding would not defend a full interception that forwards both halves of the signed
exchange unchanged, and the substitution it would stop is the reopen condition named below: no
evidence of it exists in practice.

## Decision

**No new mechanism.** Request-request binding does not ship.

The issue's own acceptance criteria about replay, price and ordering are already satisfied by
the watermark, the value binding and the gate ordering of §1.3, as the record below shows. The
criteria that remain describe the mechanism itself, and are vacated with it. The residual threat
that #498 asked to have restated is the terminating connector's ability to take payment without
delivering, which ADR 0019 already names and answers with counterparty choice, evidence and
identifiability, not with a mechanism the same party would verify.

## Considered options

**RFC 9421 request-request binding, as §1.5 specifies it.** The mechanism the issue asks for:
a signature over the inner envelope with a content digest and the route's price, present
signatures always verified, absent signatures refused only where the route requires one.
Rejected. It is verified by the terminating connector, the one party it cannot constrain, and a
dishonest one can simply not perform it. Against the parties that remain, it defends only the
narrow substitution move described in (c), for which there is no evidence. It also carries a
per-packet signature verification and a fleet-wide client signing requirement; the issue's own
criteria concede the fleet cannot be forced to sign before it is ready.

**A price-only binding.** Bind the claim to the route's price without signing the envelope.
Rejected. §1.3 step 3 already does this: the cumulative amount must advance by at least the
route's price, read from the same longest-prefix lookup §1.4 and §1.7 use. A price-only binding
would duplicate an existing gate.

**No new mechanism.** The replay and underpayment criteria are already satisfied, and the
strongest party a binding could constrain is its own verifier. This option is chosen.

## Consequences

No production code change is required by this ticket. The decision changes no crate, no wire
format, no config field and no header. It decides the fate of a mechanism that was specified but
never implemented.

The residual defence is ADR 0019's, and it stands as that ADR states it: "the payer chose this
counterparty, that the response envelope is evidence of what the connector claims happened, and
that a connector doing this systematically is identifiable and can be refused as a peer." The
party that remains dangerous is the terminating connector itself, and it is answered by choice,
evidence and reputation, not by a check it would perform on itself.

The question reopens only if one of these becomes true:

- a hop appears that forwards claims, so that a claim transits a party that is not its verifier;
- the client edge changes so that a claim transits multiple verifiers; or
- evidence shows that capture-and-replay of claims on the client edge occurs in practice.

The re-scoping of #498 is completed. Its statement, "The residual threat needs restating before
a mechanism is chosen. See #508", is answered here: this ADR restates the residual threat, and
the restating concludes that no mechanism is chosen. The epic no longer points at an unanswered
question.

### Acceptance criteria record

The record below maps every acceptance criterion of the original issue body to the mechanism
that satisfies it, or marks it vacated with the mechanism:

| Criterion (#508) | Status | Mechanism |
| --- | --- | --- |
| A request whose signature covers its envelope, digest and price is accepted | Vacated with the mechanism | no binding signature exists to accept; §1.3's gate decides acceptance |
| A claim replayed against a different request is refused | Satisfied | watermark, §1.3 step 2: a non-advancing nonce is refused, whatever request the claim rides |
| A claim replayed against a route with a different price is refused | Satisfied | value binding, §1.3 step 3: the cumulative amount must advance by at least the route's price from the longest-prefix lookup; collateral binding, step 5, refuses a claim above the channel's deposit |
| A structural or cryptographic binding failure and a price mismatch produce distinct reject codes | Satisfied in kind | the gate's refusal taxonomy already refuses each failure class (structure, freshness, value, signature, channel, deposit) under its own distinguishable reason |
| The underlying failure reason travels in the reject message, so a client can debug its signing without the connector's logs | Satisfied in kind | the gate reports which check failed; each refusal is its own reason (§1.3) |
| A present signature is verified even on a route that does not require binding | Vacated with the mechanism | no binding signature exists to verify |
| An absent signature is refused only where the route requires binding, and otherwise proceeds unchanged | Vacated with the mechanism | no route requires binding |
| A route that does not terminate locally never performs this check | Vacated with the mechanism | ADR 0031 already requires a covering claim on every peer PREPARE, so the intent, every hop is paid before it carries, is enforced by the peer gate |
| A packet failing binding is rejected before the app is contacted | Satisfied | gate ordering: the claim is validated before the PREPARE is routed, and a claim that fails any check is rejected before it reaches the terminating app (§1.3) |

[docs/protocol/client-edge-spec.md §1.5](../protocol/client-edge-spec.md#15-request-request-binding-rfc-9421)
specifies the mechanism this ADR decides against. The section remains as the record of a
considered option; its "Not yet implemented" status does not change to implemented.
