# The kind:10032 announce is removed: a connector must work with no relay in the world

**Status:** Accepted — **built** (#1074). **Retires [0030](0030-an-operator-announces-a-node-the-node-still-does-not.md) in full.** Restores [0022](0022-a-connector-answers-it-does-not-announce.md) and [0006](0006-the-connector-is-mechanism-not-policy.md) without qualification: a connector answers, and does nothing else about being found. The `[announce]` section did **not** become a tombstone — two of its fields feed the packet path and were re-homed into `[node]` by [0050](0050-a-connectors-url-resolves-to-its-self-description.md) (#1080), which landed in the same change.

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

**A connector does not announce itself, and there is no mechanism by which it could.**
`connector announce` is removed, the kind:10032 `IlpPeerInfo` event is no longer produced by this
implementation, and nothing in a conforming connector depends on a Nostr relay existing.

## Why — the reason that must survive, or this gets rebuilt

**An announce assumes a relay.** Publishing one requires, at minimum:

- a **Nostr relay** to exist and accept the event;
- a **connector fronting that relay**, with a funded payment channel, to pay for the write;
- **BIP-340 Schnorr** signing, **NIP-01** regular-replaceable semantics, and a **NIP-40** expiration
  tag.

That is an entire second protocol stack, made mandatory, in service of one thing: being discovered.
And it is not reachable at all for the case this protocol has to serve first — **a network of pure
connectors**, peering with each other, with no relay anywhere in it. Such a network cannot announce,
so a discovery design that only works when a relay exists is not a property of the protocol. It is a
property of one application built on top of it, compiled into the connector.

[ADR 0030](0030-an-operator-announces-a-node-the-node-still-does-not.md) reasoned carefully about
**who** may announce, and reached the right answer to the question it asked: the operator, from the
box holding the key, because only the announced node holds all three of the identity key, the
settlement facts and a channel to pay with. That argument is not wrong. It is answering a question
this record removes.

**What replaces it: nothing, inside the connector.** A connector answers what it is asked
(ADR 0022), and a `GET` on its URL resolves to its self-description (issue #1060). Whether those
facts are then copied into a discovery network, by whom, in what format, and signed by which key, is
the **controller's** business — outside the connector by definition (ADR 0006), and now outside it in
fact as well as in principle.

## Consequences

**The `[announce]` section is not deleted, and is not a tombstone.** Issue #807 amended ADR 0030 so
that the packet path reads two of its fields — `addresses` and `btp_endpoint` — to _answer_ with,
carrying them in the x402 greeting so a client with a stale or missing genesis seed can bootstrap
against an edge it can reach (`connector-cli/src/runtime.rs` maps them into
`connector_client_edge::BootstrapIdentity`). That is answering, not announcing, and it survives this
record intact. Those two fields are the seed of the self-description document and must be re-homed
into a section named for what they now do. The remaining announce-only keys — `publish_to`,
`publish_btp_url`, `pay_channel`, `relay_url`, `ttl_secs`, `identity_key_file`, `notice` — are
removed and parsed-to-be-rejected by name, per this repo's rule that a removed key never silently
drops.

**A third party's announce is a different object, and this record does not define one.** If a
controller publishes facts about a node it did not sign, the event is that controller's claim about
the node rather than the node's claim about itself — a materially different security property from
what kind:10032 has meant. Anyone building that is defining a new thing and should say so.

**Downstream consumers read kind:10032 today** — `toon-client`'s `discovery-subscription.ts`,
`@toon-protocol/core`'s `parseIlpPeerInfo`, `rig`, and genesis peer seeds. Removing the producer does
not remove them, and the corpus stops being refreshed. Sequencing that is an operational task, not a
protocol one, and is tracked separately.

**The `requiredTransport` defect closes by construction.** It was enforced long before it was
advertised, because there were two descriptions of one node and only one of them was checked
(verified live 2026-08-14: not one announce in the fleet's corpus carried the key). With a single
authoritative self-description there is no second copy to fall behind.

## Update (issue #1074)

Built, in one change with [0050](0050-a-connectors-url-resolves-to-its-self-description.md)'s
`GET /ilp` (#1080) — the two could not be separated, because renaming `[announce]` while
`connector announce` still read eleven of its keys would have left a broken subcommand.

What came out: the `announce` subcommand (`crates/connector-cli/src/announce.rs`) and its test;
`IlpPeerInfo`, `RouteHints`, the `deriveRouteHints` suffix heuristic, `EdgeIdentity` and `Notice`;
`sign_ilp_peer_info`, `ILP_PEER_INFO_KIND` and the whole `connector-signer` NIP-01 signing module the
kind:10032 event was the only author of; each box's scheduled announce compose overlay and the relay
box's second `connector-rust.swap-announce.toml`; and `fleet-ops.yml`'s `announce` operation with
`fleet-health.yml`'s probe for the loop it forced. `nip59` stays — wrapping a claim to a receiver is
not announcing.

What did not come out: `[announce]`'s `addresses`, `http_endpoint` and `btp_endpoint`, now `[node]`'s
three fields. Every other key it carried is parsed solely to be **refused by name**, and so is a
stale `[announce]` heading, which is refused with the new name in the message
(`crates/connector-bin/tests/refuses_to_start.rs`).

The verb itself is refused by name too. `connector announce` does not resolve to a config path that
does not exist; it prints what removed it and where a node's facts are answered instead. The boxes
are driven by scripts and units that lead this repo, and "No such file or directory: announce" is not
an answer anybody can act on.

**Downstream consumers were not touched, and this is the sequencing ADR 0046 already recorded as a
separate operational task.** `toon-client`'s `discovery-subscription.ts`, `@toon-protocol/core`'s
`parseIlpPeerInfo`, `rig` and the genesis peer seeds all still read kind:10032. Removing the producer
does not remove them: the corpus simply stops being refreshed, and what those readers hold goes stale
rather than wrong. `g.toon.ario`'s discoverability depended on an announce; whatever replaces it is a
controller concern, outside the connector by definition (ADR 0006).
