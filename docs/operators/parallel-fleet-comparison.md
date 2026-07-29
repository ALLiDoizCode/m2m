# What the two fleets actually did, side by side

> **Closed record — there is no second run, and this is not an open defect.**
>
> [ADR 0017](../adr/0017-the-typescript-connector-is-a-prototype.md) abandons the parallel-fleet
> comparison: the TypeScript connector is a prototype rather than a reference implementation, so
> there is nothing for the Rust fleet to be identical to, and a divergence count measures
> convergence on a wire we have decided not to build. The harness that produced this, its binary
> target and its integration test are deleted (#518), along with the `infra/fleet-compare-packets.json`
> specs it read.
>
> The findings below are kept deliberately, because they are why several of the ADRs exist —
> they are the evidence that the prototype's quirks are defects rather than contract. Read the
> "next run" language throughout as describing a run that will not happen. ADR 0013's parallel
> address space survives as a _migration_ mechanism; only its role as a measured-parity gate is
> withdrawn. Under [ADR 0021](../adr/0021-vectors-are-normative-prose-is-not.md) the successor
> artefact is a committed set of vectors generated from property tests, replayed by every client
> SDK — a definition of done rather than a measurement.

Recorded from the first deployment of the Rust fleet to devnet (#492, parent #431). ADR 0013
keeps the TypeScript fleet running specifically so behaviour can be compared "under identical
conditions rather than against memory"; this is that comparison's first result, and it did not
match.

The issue asked for the result to be recorded whether or not the fleets agreed. They did not
agree, on every packet.

## What was running

The Rust connector was deployed to the **apex box only** — `toon-devnet-store` did not exist at
the time, along with the `evm`, `sol` and `mina` boxes, so the store hop and anything requiring
an on-chain channel were out of reach. Both connectors ran on the same box, in the same Docker
project, in front of the same `relay` container:

|             | TypeScript                           | Rust                                       |
| ----------- | ------------------------------------ | ------------------------------------------ |
| image       | `connector:3.36.3-solchan.0`         | `connector-rust:sha-0e45cef`               |
| client edge | `POST /ilp` on `:3000`               | `POST /ilp` on `:4000`                     |
| prefix      | `g.toon`                             | `g.rust`                                   |
| relay route | `g.toon.relay` → `http://relay:3100` | `g.rust.relay` → `http://relay:3100/write` |

Adding the Rust node changed nothing about the TypeScript one: it stayed up 6 days, healthy,
and kept serving live writes throughout (`[write] … payer=connector amount=1998 chain=toon` in
the relay's log). Both networks were live at once, which is ADR 0013's central claim and the
one thing here that held.

## The comparison

`fleet-compare` (#491) drove five packets at each client edge, one at a time, awaiting each
reply. `infra/fleet-compare-packets.json` is the sequence.

| packet                          | TypeScript                              | Rust                                     |
| ------------------------------- | --------------------------------------- | ---------------------------------------- |
| `relay-amount-zero`             | HTTP 402 + x402 offer                   | `F99` app declined, HTTP 400             |
| `relay-amount-matches-ts-price` | HTTP 402 + x402 offer                   | `F99` app declined, HTTP 400             |
| `relay-child-longest-prefix`    | HTTP 402 + x402 offer                   | `F99` app declined, HTTP 400             |
| `no-such-route`                 | `F02` `No route to destination: <dest>` | `F02` `no route to destination '<dest>'` |
| `already-expired`               | HTTP 402 + x402 offer                   | `R00` prepare has expired                |

**5 of 5 diverged.** Three findings come out of that, in descending order of how much they cost.

### 1. The app can tell which connector is in front of it

ADR 0013 rests on one sentence: _"a Rust connector can therefore be placed in front of an
already-running relay or store app without touching it, and the app cannot tell which connector
is in front of it."_

The app can tell. The two connectors deliver differently enough that the same app answers them
differently:

> **The Rust column below is a snapshot of `connector-rust:sha-0e45cef`, not of the connector
> today.** Every one of its five rows has since changed, and the record is kept unedited only
> because the ADRs it provoked cite it. What the Rust connector does now:
>
> - `prepare.data` is a **gift wrap** ([ADR 0018](../adr/0018-a-payload-is-sealed-to-the-terminating-connector.md)),
>   not an opaque body: sealed to the terminating connector's identity key, carrying a shared
>   secret and an OER-encoded envelope — method, target, headers, body — that only the terminating
>   connector can open.
> - The request path is `handler_url` **joined with the envelope's `target`**, and the method is
>   the envelope's method, not always `POST` (`connector_runtime::HttpAppClient::deliver`, #553).
> - No `X-TOON-Payer`/`-Amount`/`-Chain`, and no `TOON-Received-At`: the app is told nothing about
>   the payment at all, which [ADR 0020](../adr/0020-a-price-is-flat-and-attaches-to-a-handler.md)
>   makes a decision rather than the omission this record calls it. The envelope's own headers are
>   forwarded verbatim, minus hop-by-hop headers, `host` and `content-length`.
> - The app's **complete** response — status, headers and body — comes back in the reply's
>   envelope. An HTTP status is envelope content, never a packet outcome, so a `404` is a real
>   answer and is not converted to `F99`.
> - **There is no `TOON-Fulfillment` header.** [ADR 0019](../adr/0019-a-terminating-connector-derives-the-fulfilment.md)
>   has the terminating connector derive the fulfilment from the gift wrap's shared secret; the app
>   supplies none and never could. The row below, and the paragraph after the table that tells an
>   app to "learn to answer with `TOON-Fulfillment`", are both retired advice — an app that did so
>   today would simply have that header carried back as one more response header.

|                        | TypeScript `HttpProxyHandler`                                                                                   | Rust `HttpAppClient::deliver`                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| what `prepare.data` is | an encoded HTTP envelope — method, target, headers, body                                                        | an opaque request body                                                                                                                                                       |
| request path           | `joinUrl(upstreamBase, envelope.target)` — from the packet                                                      | the configured `handler_url`, verbatim                                                                                                                                       |
| request method         | the envelope's method                                                                                           | always `POST`                                                                                                                                                                |
| headers sent           | `X-TOON-Payer`, `X-TOON-Amount`, `X-TOON-Chain` (+ the envelope's own)                                          | `TOON-Received-At`                                                                                                                                                           |
| what comes back        | the upstream's full HTTP response — status, headers and body — re-encoded into the reply's `data`               | the response _body_ becomes the reply's `data`; status is reduced to 2xx → `Delivered` / else → `F99`. Headers are dropped except one, below                                 |
| fulfilment             | none — per `docs/local-delivery-fulfillment-contract.md` §5 this handler "structurally cannot supply preimages" | reads a `TOON-Fulfillment` response header (#417) and carries it as the app's _claimed_ fulfilment, verified against the condition before the packet is treated as fulfilled |

Both the relay and the store read `X-TOON-Payer`, `X-TOON-Amount` and `X-TOON-Chain` — the relay's
own per-write log line is built from them (confirmed by reading the literals out of the running
relay's bundle, and out of `http-proxy-handler.js`'s exports). The Rust connector sends none of
the three. So a relay fronted by the Rust fleet loses its payer and amount attribution, silently,
on every write.

The fulfilment row is a divergence in its own right and points the opposite way from the others:
the Rust side has a local-delivery fulfilment seam that the TypeScript reverse-proxy handler does
not. An app that learns to answer with `TOON-Fulfillment` works on the Rust fleet and is
`F99`-converted on the TypeScript one.

The path half of this is config-deep and was fixed here: `handler_url` now carries `/write`
(node side) and `/store` (store side), because the Rust connector will never derive a path from
the packet. **The header and envelope halves are not config-deep.** Either the Rust connector
learns the envelope contract, or the apps change — and the apps changing is precisely what
ADR 0013 promised would not be necessary.

This is worth more than the deployment. It says the cutover is not a repointing exercise yet.

### 2. The two fleets do not price the same thing, so this was never an identical condition

Every TypeScript route on this box carries `price: '1000'`, and the TypeScript connector gates
on payment at the HTTP layer _before_ it evaluates the packet — hence a 402 with an x402 offer
for the expired packet too, which never got as far as noticing it had expired. The Rust devnet
overlay prices nothing (`g.rust.relay` sets no fee), so it evaluated ILP semantics and answered
`R00`.

The expired packet is the sharper half of this. `docs/local-delivery-fulfillment-contract.md`
rule 6 is normative and unambiguous: _"An expired PREPARE is rejected with R00 before the handler
is invoked, sender-chosen or legacy — the condition does not change expiry semantics."_ The Rust
fleet did exactly that. The TypeScript deployment answered 402 and never reached the rule, because
the x402 payment gate sits at the client edge, upstream of the local-delivery dispatch the
contract scopes itself to. So this is not a contract violation on paper — but it does mean an
unpayable packet and an expired packet are indistinguishable to a client on the TypeScript fleet
and cleanly distinguishable on the Rust one.

Neither is wrong. But "identical conditions" is not yet true, and a comparison run against these
two configurations cannot say anything about behaviour under load or under payment.

Pricing the Rust routes to match is a prerequisite for the next run — and it is not sufficient on
its own. Every spec in `infra/fleet-compare-packets.json` carries a non-zero
`execution_condition_hex`, which puts it in the **sender-chosen** class, and
`docs/local-delivery-fulfillment-contract.md` §5 says a reverse-proxy handler that cannot mint a
preimage is `F99`-converted by rule 3. So once these packets get _past_ the TypeScript payment
gate they can only ever `F99` there, whatever the pricing. A next run wanting agreement on the
happy path needs all-zero (legacy-class) conditions as well as matched prices — with the caveat
from the reproduction note below that all-zero then breaks the Rust side. There is no condition
value that currently satisfies both fleets on a terminated route, which is itself part of
finding 1.

### 3. The harness assumes a structure the two fleets do not share

`fleet-compare` appends one `destination` to each fleet's own prefix, which requires the two
fleets to be structurally identical below the prefix. They are not:

- the TypeScript store child is `ario` (`g.toon.ario`, `g.toon.relay.ario`); the Rust one is
  `store` (`g.rust.store`). #490 renamed it deliberately, to avoid carrying Arweave-specific
  naming into the new prefix. The consequence is that no single `PacketSpec` addresses the store
  hop on both fleets, so the store path is untestable by this harness as written.
- `F02` messages differ only in wording (`No route to destination: X` vs
  `no route to destination 'X'`). Semantically identical, flagged as a divergence, because
  message text is compared exactly.

Both want a decision: either the harness gains a per-fleet child mapping and a message-text
normalisation, or the Rust config mirrors the TypeScript child names exactly. Until one of them
happens, a green `fleet-compare` run is not achievable and a red one is hard to read.

## Docker publishes past ufw — the port question from #490, answered

#490 left open "that `4000`/`4001` are actually reachable through Docker's iptables handling on a
live host". They are, and not in the reassuring direction.

`infra/linode-node/firewall.sh` allows 22, 80 and 443 only, and `ufw status` on the live box
confirms exactly those rules active. `POST http://<apex-public-ip>:4000/ilp` from off-box still
answers `400`. Docker inserts its own `DOCKER` chain ahead of ufw's, so a `ports:` publish is
reachable from the internet regardless of what ufw says.

### That combination was a free-write gateway, and it is now closed

Three facts compose into one that none of them states alone:

1. This client edge implements **only §1.1** of `docs/protocol/client-edge-spec.md`. Its own
   module doc: identity (§1.2), payment claims (§1.3) and the x402 greeting (§1.4) are
   unimplemented, so "every request today is treated as an unauthenticated, unpriced delivery
   attempt". §1.5 request-request binding is absent from `crates/` entirely.
2. The relay's `POST /write` "trusts the injected `X-TOON-Payer`/`-Amount`/`-Chain` headers
   WITHOUT re-validating payment" and stores any signature-valid event whether or not they are
   present. It enforces no payment itself — by design, because the connector upstream is supposed
   to have done it.
3. `:4000` was published on `0.0.0.0`, past ufw.

So an anonymous PREPARE addressed to `g.rust.relay`, carrying a valid NIP-01 event, would have
been stored in the devnet relay for free, from anywhere on the internet — the whole pay-to-write
premise bypassed. Note the `handler_url` fix earlier in this document is what _armed_ it: while
the route 404'd, the delivery could not land.

Closed by binding the publish to `127.0.0.1` (verified: refused externally, still serving on the
box). **This is not a firewall problem and a ufw rule would not have fixed it.** Widen it again
only once §1.2–§1.5 are implemented and the fleet charges for a write.

Not demonstrated end-to-end: doing so means publishing a permanent event, so the last link is
read out of the relay's handler rather than executed.

It also settles how the peer wire had to be protected. A ufw rule would not have contained it —
only refusing to publish it on the public interface does, which is why
`docker-compose.store.rust.yml` binds 4001 to `${STORE_PEER_WIRE_BIND}` rather than adding a
firewall rule.

## What was not tested

Not reached, and still open:

- **The store hop.** No store box existed. `g.rust.store` points at an RFC 5737 placeholder.
- **Peer-wire behaviour between two Rust nodes on a real network.** Same reason. The peer dial is
  lazy (`NetworkPeerTransport` connects on first packet), so the apex came up and served
  `g.rust.relay` with the placeholder in place — which is the only reason apex-first worked.
- **Migration and rollback of a client.** Both need a funded payment channel with the new apex
  (ADR 0013: a channel is bilateral and does not follow an address change), which needs the
  `evm`/`sol`/`mina` boxes.
- **Anything under payment.** See finding 2.
- **The comparison over a real network.** Both client edges were driven on `127.0.0.1` from the
  box itself, so the run says nothing about behaviour across a network hop — deliberately, to keep
  latency and transport out of the comparison, but worth knowing before quoting those numbers.

## Decisions taken here

- **The peer wire is never published on the public interface.** See above, and
  `docker-compose.store.rust.yml`'s header for the full reasoning.
- **The overlays stay a manual `up`.** #490 left open whether they should join `bootstrap.sh`'s
  automatic path. They should not, for now: the prefix is disposable by design (ADR 0013), the
  store side is unproven, and putting an unproven overlay on the path every box reboot takes is a
  way to find out about finding 1 the hard way. Revisit when the store hop is proven and the
  envelope gap is closed — at which point the overlay stops being an experiment.

## Reproducing

```bash
# on the apex box, both fleets running
fleet-compare \
  --fleet-a-url http://127.0.0.1:3000 --fleet-a-prefix g.toon \
  --fleet-b-url http://127.0.0.1:4000 --fleet-b-prefix g.rust \
  --packets infra/fleet-compare-packets.json
```

Exits non-zero when any packet diverges, so it gates a migration decision rather than only
informing one.

One trap when authoring a packet set: do **not** use an all-zero
`execution_condition_hex`. `docs/local-delivery-fulfillment-contract.md` puts "absent or all-zero"
in the **legacy** condition class, and the OER decoder only populates `executionCondition` when it
is non-zero — so an all-zero condition is not a weak condition, it is _no_ condition, and the two
fleets disagree about that before they get anywhere near the behaviour under test. The first run
here made that mistake and every Rust reply came back `F01 prepare carries no execution
condition`, masking the comparison entirely. The committed packet set uses
`sha256(0x11 × 32)` instead.
