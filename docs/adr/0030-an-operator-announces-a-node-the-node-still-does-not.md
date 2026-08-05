# An operator announces a node; the node still does not

A running connector never pushes facts about itself into a network. An **operator** may, by running
`connector announce <relay-discovery-url>` on the node being announced — a one-shot command, from the
box that holds the identity key, paid for through that node's own routing like any other write.

## Context

[ADR 0022](0022-a-connector-answers-it-does-not-announce.md) draws a line that is still the right
line:

> **Announcing** is pushing facts about yourself into a network unprompted — `announcePrice`,
> kind:10032 self-announce. A connector never does this. Deciding to participate in a discovery
> network is the controller's business, and ADR 0006 stands unchanged.

Taken as a rule about the *process*, that sentence forbids a kind:10032 announce outright, and
issue #784 would contradict it. Taken as written — including its own second clause — it does not,
because the clause names who the decision belongs to: **the controller**. What ADR 0022 refuses is a
daemon that decides, on its own schedule, to broadcast. It says nothing about an operator deciding
to, once, deliberately.

That distinction stopped being academic on 2026-08-04, when the store box's TypeScript connector
exited in the cutover and took its `selfAnnounce` block with it. `g.toon.ario` has had no publisher
since, so it is undiscoverable — the last unmet acceptance criterion on #714. The cutover runbook's
stopgap was to stand up a second `packages/announcer` instance on the **apex** box holding the
**store's** identity key, because that is where a free relay is. That works, and it moves a key to
where the convenience is, which is the wrong direction for a key to move.

Three things are needed to make an announce honestly, and only the announced node has all three: the
**identity key** the event is signed with, the **settlement facts** the announce advertises, and a
**channel** with somebody who can carry the packet. A sidecar can be given at most one of them, and
the one it is easiest to give it is the key.

## Decision

**The verb belongs to the operator, and the binary is how they say it.**

- A serving connector announces nothing. There is no timer, no `selfAnnounce` config block, no
  startup broadcast, and nothing on the packet path reads the `[announce]` section. ADR 0022's rule
  about the *process* is unchanged and unweakened.
- `connector announce` is a **subcommand**: it runs, publishes one kind:10032 event, and exits. It
  is an operator action with an operator's intent behind it, in the same category as opening a
  channel.
- It publishes **from the node being announced**, paying through that node's own routing by calling
  `Connector::handle_prepare` in-process — the same call `POST /packets` makes. The identity key
  never leaves the box, and the settlement facts announced are unambiguously that node's own, read
  from the `[settlement.*]` tables it verified against a chain at startup rather than polled off
  whichever edge happened to be asked.
- The announce is **paid for**, at the price the chosen relay's edge quotes, from the same channels
  every other write on that node uses. There is no free path and no special case.

This also widens ADR 0001's "load configuration, construct the runtime, merge routers, serve — and
nothing else", which is a real change and is made deliberately. The binary itself still branches on
nothing: `connector_cli::run` returns a `Command` saying whether a socket is to be held open or the
work is already done.

### Not the operator surface

`POST /packets` already originates a packet outward "exactly as the client edge does for an external
caller", so an announce could have been an operator-surface call. Issue #753 is why it is not:
enabling `[operator]` to expose one endpoint publishes the **whole write surface** — `POST /packets`,
`POST /channels`, `/channels/:id/close` — because the bearer `route_layer` wraps reads only and the
Rust operator paths carry no `/admin` prefix for nginx to deny. A subcommand needs no operator
section, no bearer token, no write keys, and no second HTTP surface. It calls the same function
directly.

## Considered options

**A second `packages/announcer` instance holding the store's key** (the cutover runbook's stopgap).
Ships today and needs no code. Rejected as the answer, though not as a stopgap: it puts a node's
identity key on a different box from the node, permanently, to work around the fact that the sidecar
cannot pay.

**Teaching the sidecar to pay.** It would need a channel, a claim signer and a durable watermark —
i.e. it would need to become a connector. Rejected: that is the thing it is standing next to.

**A `[announce] publish_to` block the serving process acts on, on a timer.** Closest to what the
retired TypeScript connector's `selfAnnounce` did, and it would keep `g.toon.ario` announced without
anyone running anything. Rejected here because it is exactly the daemon-decides shape ADR 0022
refuses, and because it is a strictly larger commitment than the one this issue needs. It remains
the obvious next step if operator-driven announces prove too manual, and it would be a change to
this ADR, made on purpose, rather than a drift.

## Consequences

**An announce needs a route, not just a channel.** The packet goes out through the announcing node's
own routing table, so that node must have a `[[routes]]` entry reaching the connector that fronts the
chosen relay. A node with no such route is answered `F02 no route to destination` and told so by
name. On the devnet store box that means adding a `g.toon.relay` peer route toward the apex, which
also makes the store box's client edge sell that forwarding to anyone — an operator decision, and one
worth making knowingly.

**A second process must not share a serving node's `state_dir`.** A node's outbound peer-claim ledger
is replayed from the journal at startup and held in memory, and the journal has no lock. Two
processes over one `state_dir` both resume at nonce N, both sign N+1 against different cumulative
amounts, and the counterparty refuses one as a replay — after which the serving node's claims never
advance the far side's watermark again and the peering silently stops being paid.

`connector announce` therefore refuses when all three of these hold: the config names a `state_dir`,
the destination resolves to a `peer_id` route (so the announce would **forward**, which is the only
thing that signs an outbound claim), and something is already listening on this config's client
edge. It says which of those it found and what to do instead. An announce to a route this node
**terminates** — the apex publishing to its own relay — writes no journal entry and is not blocked;
neither is `--dry-run`. A guard that refused more than the hazard would be a guard operators route
around.

That refusal has a sharp edge on exactly the node that motivated the issue. The devnet store box's
peering is **accept-only** (no `endpoint`; the apex dials in), and an accept-only peering can only be
originated over by the process holding the accepted session — which is the serving process, not this
one. So on the store box a `connector announce` can neither run beside the node nor, if it did, reach
the apex over that peering. Restoring `g.toon.ario`'s discovery therefore still needs either a
stopgap or the in-serving-process shape above; this ADR decides the mechanism, not that one
deployment.

**A node with a KMS-held identity cannot announce.** A Nostr signature is BIP-340 Schnorr over the
event's own id, which needs the scalar itself rather than a `Signer`'s recoverable ECDSA `sign`. Said
by name at the point of use, not discovered as a panic.

**`relay_url` stays optional, and stays operator-supplied.** It is where clients **read** this node
for free, which is neither the URL the announce was published *through* nor anything derivable from
`[[routes]]` — a relay route's `handler_url` is the relay's private write ingress on a container
network. A node that fronts no relay omits the field. An `http(s)://` value is refused at config
load: that spelling is the write ingress, and announcing it publishes an unauthenticated write door
to the network.
