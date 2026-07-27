# Payload opacity is a property of carriage, so a terminating connector reads the envelope

A forwarding hop never interprets a packet's payload. A connector at a route termination does —
that is what terminating means. The Rust connector therefore implements client edge version 1 as
specified, envelope and all, rather than treating the payload as opaque everywhere.

## Context

`CONTEXT.md` said a connector "never interprets the payload", and defined a packet as carrying "an
opaque payload". Client edge version 1 §1.5 says the connector binds "the _inner_ HTTP request it
will proxy to the app (the literal HTTP envelope carried verbatim in the PREPARE's `data` field)"
to the claim that pays for it.

Both statements have been in the repository for as long as both documents have existed, and they
contradict each other. Nobody noticed, because the thing they disagree about had no name.

#492 turned the contradiction into an outage-shaped problem. Deploying the Rust connector in front
of a running relay showed that the two implementations sit on opposite sides of it:

- the TypeScript connector decodes the envelope, derives the request's method and target from it,
  makes that request to the app, and injects `X-TOON-Payer`, `X-TOON-Amount` and `X-TOON-Chain`
- the Rust connector treats the payload as an opaque body, always POSTs to the configured handler
  URL, and injects none of those headers

Both apps read those headers; the relay's per-write record is built from them. So the Rust
connector — the one faithful to the glossary — is the one that breaks the apps. And because it
never decodes the envelope, it cannot perform §1.5's request-request binding at all: there is
nothing to bind, so a captured claim cannot be prevented from being replayed against a different
request. That defence was not weakened, it was absent.

This also falsified ADR 0013's premise that "the app cannot tell which connector is in front of
it", on which the entire parallel-fleet cutover rests.

## Decision

**Opacity is a property of carriage, not of the node.** A connector forwarding a packet never
interprets its payload. The same connector, at a route termination, does — because a termination
is precisely the point at which a packet stops being carried and becomes a delivery to an app.

`CONTEXT.md` is amended to say so, and the thing that had no name is now the **Envelope**: the HTTP
request carried in a packet's payload, read only at a route termination.

It follows that the Rust connector must implement client edge version 1 as written. This is
non-conformance to a published contract, not a design fork between two reasonable
implementations — so conformance is defined as a property of the _wire_: identical observable
behaviour, with the internal model free to differ. The TypeScript implementation's shape is a
reference for behaviour, never a target to copy.

## Considered options

**Redesign §1.5 to bind over something the connector legitimately sees** — the destination, the
amount, a `Content-Digest` header — leaving the payload opaque everywhere and making the Rust
connector the reference implementation rather than the laggard. This is the truest reading of the
old glossary and was seriously considered. Rejected because the property §1.5 buys is that a claim
pays for _a specific request_; binding over anything less than the request re-opens exactly the
replay it exists to close. Preserving a slogan is not worth weakening a defence, and the slogan
turned out to be over-general rather than wrong.

**Drop "never interprets the payload" outright** as an aspiration the system never held. Rejected:
the property does hold, and holds strongly, on the forwarding path — which is most of the system.
Discarding it would license payload inspection at hops that have no business doing it.

**Leave the contradiction in place and implement neither side deliberately.** This is the status
quo that produced the divergence, and it produced it silently over months.

## Consequences

A connector at a route termination is a paid reverse proxy, and the codebase should say so plainly
rather than treat envelope handling as an embarrassment. The envelope becomes a modelled concept
with a name, not an implementation detail of one HTTP client.

The Rust connector has real work to do before the cutover: identity, claims, the x402 greeting and
request binding are all unimplemented (#498). Until that lands, its client edge must not be exposed
— an unpriced connector in front of an app whose payment enforcement is entirely upstream is a free
gateway to that app, which is what #492 discovered.

ADR 0013's premise is restored rather than abandoned: once #498 lands, an app genuinely cannot tell
which connector fronts it, and the cutover is the destination change that ADR describes.

The envelope format must be written down, because it is currently defined only by compiled
JavaScript whose source was deleted, and its quirks are the contract.

Nothing here licenses payload interpretation on the forwarding path. A hop that is not terminating
still never looks inside, and any future proposal to relax that is a separate decision requiring
its own reasoning.
