# A terminating connector derives the fulfilment it is paid against

**Status:** Accepted. Bounded by [0032](0032-a-client-destination-is-never-a-route-termination.md), extended by [0064](0064-a-deadline-bounds-the-wait-for-an-app-not-the-answer.md) — which states the one condition under which a termination declines to derive at all: the packet's deadline fired before the app answered (#1183). Live: `Connector::deliver_opened_envelope`. The `TOON-Fulfillment` header it retires is gone from `crates/`.

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

At a route termination the connector derives the packet's fulfilment from the secret in the gift
wrap, rather than receiving it from the app. Issue #417's rule — that a connector never produces a
fulfilment itself — is kept for forwarding hops and dropped at terminations.

## Context

Issue #417 closed the derived-preimage hole, and closed it thoroughly.
`connector-domain::condition` states it outright: there is deliberately no function anywhere in that
module from a condition to a fulfilment. `Connector::accept_if_fulfilled` documents the same rule
from the other side — it exists to prevent "an intermediate hop (relaying a peer's answer) or a
terminating one (relaying an app's) from producing a valid fulfilment without the destination's
actual participation", and never accepts "a fulfilment this connector invents itself".

That rule and envelope delivery cannot both hold. The prototype's own normative contract says so —
`docs/local-delivery-fulfillment-contract.md`, rule 5:

> Handlers that structurally cannot supply preimages (e.g. the #216 HTTP reverse-proxy for
> terminated routes) fulfill without one and are therefore converted to F99 by rule 3; do not point
> sender-chosen traffic at them.

The prototype made envelope delivery work through its _legacy class_: an absent or all-zero
condition, no verification, and a receiver-side preimage the connector injected from an NIP-59/HKDF
derivation. The Rust connector deleted that class — an all-zero condition is invalid outright, never
a legacy auto-fulfil path. So it can decode an envelope or it can honour #417, and not both.

Underneath sits a trade that cannot be dodged:

> You cannot have both _"any HTTP service is a TOON node app"_ and _"only the true recipient can
> produce a fulfilment."_

A payment-oblivious HTTP service holds no secret and performs no cryptography, so it cannot mint a
preimage. Someone else must — and whoever does can fulfil without delivering.

## Decision

**The terminating connector derives the fulfilment**, from the shared secret the sender sealed to it
(ADR 0018). The app supplies nothing, and the `TOON-Fulfillment` response header goes away.

#417's protection is unchanged where it was aimed. A forwarding hop still cannot produce a
fulfilment, and is still paid only against a preimage it verifies. The reasoning is that a
condition's trustless property protects a payer from parties it never chose and cannot see. A
terminating connector is not one of those: it is the counterparty the payer deliberately addressed,
in the same trust domain as the app behind it.

## Considered options

**The app supplies the preimage**, derived from an end-to-end secret with the sender — the
prototype's sender-chosen class, and #417's assumption. Cryptographically the strongest option on
offer: only the true recipient can fulfil, and no connector anywhere can forge one. Rejected because
it makes every app condition-aware, which deletes the payment-oblivious app and with it the goal
that any HTTP service can be a TOON node app.

**The sender reveals the preimage inside a plaintext envelope.** Keeps the app oblivious and needs
no derivation. Rejected: any hop that reads a payload it is only _asked_ not to read can take the
fulfilment and be paid without forwarding. ADR 0018 makes this moot in any case.

## Consequences

A dishonest terminating connector can fulfil without delivering — take payment, never call the app,
and return a fabricated response envelope. ADR 0020 sharpens this rather than softening it: because
value moves whenever the app answered, _whatever_ it answered, fabricating an error response is
exactly as profitable as fabricating a success.

The defence is not cryptographic, and this ADR does not pretend otherwise. It is that the payer
chose this counterparty, that the response envelope is evidence of what the connector claims
happened, and that a connector doing this systematically is identifiable and can be refused as a
peer.

The identity key becomes load-bearing for fulfilment, not only for signing claims. Rotating it
invalidates conditions already minted against the old key, so rotation needs an overlap window. That
window is not specified here.

`AppOutcome::Delivered`'s `fulfillment` field, `decode_fulfillment_header`, and the
`TOON-Fulfillment` header have no remaining purpose.
