# Peer relation on the embedded TypeScript `ConnectorNode` — the `child` claim skip

> **Frozen — a record of the retired TypeScript prototype, not a contract anything in this
> repository implements, and not one that will ever change.**
>
> Every seam this document pins (`ConnectorNode.registerPeer()`, `ConnectorNode.addRoute()`,
> `PacketHandler.setPeerRelation()`, `packages/connector/src/routing/relation-route-validator.ts`)
> was deleted with the TypeScript connector — [ADR 0017](adr/0017-the-typescript-connector-is-a-prototype.md),
> #465 and #543. The paths below resolve only in git history, at the `@toon-protocol/connector@3.30.0`
> release commit `509663bc`.
>
> The Rust connector does not implement this contract and will not. It has no parent/child peer
> relation and no relation-keyed exemption from claim coverage. It does not need one: it already
> resolves a return path to a direct-dialled client natively, through
> `crates/connector-client-edge/src/session_route.rs`, with no relation to set and no claim to
> waive. See "What replaces this on the Rust connector" below — that section is the one a migrating
> embedder wants.
>
> Written because one live embedder — the rolling-swap maker
> ([`docs/operators/swap-node-bringup.md`](operators/swap-node-bringup.md)) — depends on this seam
> today, reaches it through a private field, and asked whether the connector should grow a public
> way to do so. It should not. This document says why, and what the embedder may rely on instead.

**Status:** Frozen (informational) · **Applies to:** `@toon-protocol/connector` 1.x–3.x, last
published 3.44.2 · **Consumers:** `toon-protocol/swap` (`packages/swap`, pinned `^3.30.0`, locked at
`3.30.0`) via `packages/swap/src/leg-b-return-path.ts` (swap#148).

## Where this code is maintained

**Nowhere.** It is not maintained in this repository and it is not maintained in another one.

| Fact                                                                     | Evidence                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The embedded `ConnectorNode` was removed from the package                | `c4a4ad10`, "TypeScript client shim — remove the embedded ConnectorNode" (#465), 2026-07-27                                                                                     |
| The rest of the TypeScript surface and its npm/CI machinery went with it | `2d981565` (#543), 2026-07-28, under [ADR 0017](adr/0017-the-typescript-connector-is-a-prototype.md)                                                                            |
| `@toon-protocol/connector@4.0.0` is not a newer connector                | Published 2026-07-27 from `11c7354a`; `main: dist/lib.js`, described as "TypeScript client for the ILP connector's client edge". It is the removal, released as a semver major. |
| Nothing has published since                                              | npm `time`: last version 4.0.0, 2026-07-27. `release.yml`, `build-and-publish.yml` and `.releaserc.json` were deleted by #543.                                                  |
| The last version that contains `ConnectorNode` is 3.44.2                 | 2026-07-27, from the 3.x line whose source ends at `509663bc` (3.30.0) through `v3.44.2`                                                                                        |

The consequence for an embedder is the useful part: **a `^3.x` dependency can never resolve forward
into 4.0.0**, and no 3.x will ever be published again. The 3.x tree is not merely deprecated, it is
immutable. Nothing in it can be renamed, refactored or removed, because there is no branch from
which a change could ship.

ADR 0017's Consequences section says "`@toon-protocol/connector` (published at 4.0.0, consumed by
`swap`)". That is imprecise: swap consumes the 3.x _embedded node_, not 4.0.0's client, and 4.0.0
is the version that no longer contains what swap uses.

## The seam

A value-bearing forward to a non-local next hop demands a per-packet settlement claim. The demand
is waived for one relation only:

```ts
// packages/connector/src/core/packet-handler.ts:329-330 @ 509663bc
private requiresSettlementClaim(peerId: string): boolean {
  return this.peerRelations.get(peerId) !== 'child';
}

// :1599-1600
const claimRequired =
  !isLocalDelivery && forwardingPacket.amount > 0n && this.requiresSettlementClaim(nextHop);
```

`peerRelations` is a `Map<string, PeerRelation>` (`:124`) with no entry by default, so the default
is **claim required** — `undefined !== 'child'`. Without a claim the forward is refused
`T00 "No payment channel available for peer"`.

The waiver is deliberate and is the resolution of
[connector#76](https://github.com/toon-protocol/connector/issues/76): a parent settles _down_ to a
child by letting the child accrue a balance owed _up_, so a parent that issued per-packet claims
toward its own children would have the money flowing the wrong way. The rolling swap's leg B has the
same shape — the value is the signed chain-B claim inside the packet, never an ILP settlement owed
back over the link.

### What is public, and what is not

| Surface                                                      | Visibility at `509663bc`                                |
| ------------------------------------------------------------ | ------------------------------------------------------- |
| `PacketHandler.setPeerRelation(peerId, relation)`            | `public` (`packet-handler.ts:295`)                      |
| `ConnectorNode._packetHandler`                               | `private readonly` (`connector-node.ts:133`)            |
| `ConnectorNode.registerPeer(config)`                         | **public**, in the shipped `.d.ts` (`:2610`)            |
| `ConnectorNode.addRoute(route)`                              | **public**, in the shipped `.d.ts` (`:3031`)            |
| `ConnectorNode.setLocalDeliveryHandler` / `setPacketHandler` | **public**, in the shipped `.d.ts` (`:443`, `:459`)     |
| The admin-server closure `setPeerRelation: (id, rel) => …`   | `private`, built only when `adminApi.enabled` (`:1904`) |

So the relation is not unreachable — it is reachable **only through `registerPeer`**, which is the
admin HTTP surface's in-process twin ("Admin Operations — direct method API", Story 24.4;
"Equivalent to POST /admin/peers — same validation and behavior").

`registerPeer` is unusable for a peer that dialled _in_, for two independent reasons:

1. It **requires a dial-back `url`** — `ws://` or `wss://` for a BTP peer, `httpUrl` for an
   ILP-over-HTTP one, both validated up front. A direct-dialled client has no inbound-reachable
   endpoint; that is the premise of the direct-dial model (swap#105). A fabricated URL would not
   just be cosmetic: `_btpClientManager.addPeer(peer)` (`:2761`) registers an _egress_ peer and
   dials it.
2. It runs the **relation ↔ route admission validator** (below), which refuses precisely the route
   an inbound client needs.

## The admission validator, and why it matters more than the setter

`packages/connector/src/routing/relation-route-validator.ts` exists to convert a latent runtime
failure into a registration error. Its own header names the failure:

> The connector's single most common misconfiguration is registering a node with a `relation` that
> contradicts its ILP-address topology — e.g. a `child` whose route prefix is not under the
> connector's own address. At runtime this surfaces only as an opaque F06/T00 reject on the first
> paid packet (the "pay-the-child with no channel" path).

`validateRelationRoute` therefore holds:

- **`child`** — every route prefix must be a **strict descendant** of one of the connector's own
  self-prefixes (the prefixes whose `nextHop` is `nodeId` or `'local'`).
- **`parent`** — no route prefix may be a strict descendant of the connector's own subtree.
- **`peer`** — lateral, no subtree constraint.
- If the connector has **no** self-prefix, the subtree checks are skipped entirely — validation
  degrades to structural checks "rather than guessing".

Both `registerPeer` (`:2717-2726`) and `addRoute` (`:3054-3066`) call it; `registerPeer` also
derives `<self>.<peerId>` as a `child`'s default route when none is given (`:2711-2716`).

This is the load-bearing observation for the question this document was written to answer.

**A rolling-swap client is not an ILP child of the maker.** It keeps its own address — `g.toon.client`
— and dials in. That address is not under `g.toon.swap.maker`, so tagging it `child` contradicts
exactly the invariant this validator enforces. What the maker actually wants is not the ILP
parent/child relationship but one of its side effects: the claim waiver. In 3.x those two things
share a single map key, and there is no way to ask for the second without asserting the first.

That is a defect of the frozen design, not something to widen access to.

## Why no public setter, and no auto-`child`, is being added

Both candidate shapes were considered and both are refused.

**A public `setPeerRelation` on `ConnectorNode`** would expose the claim waiver _decoupled from_ the
admission validator that exists to keep a mis-tagged child from becoming an F06/T00 trap
(connector#76, connector#78). Where `registerPeer` refuses an inconsistent relation/route pair at
admission, a bare setter would accept it and fail later, on a paid packet, in a different process.
It would take the one guarded door and add an unguarded one beside it.

**Automatic `child` for inbound BTP sessions** is worse, and is a money-safety regression rather
than a convenience. Today `requiresSettlementClaim` returns `true` for every peer with no relation
entry, which is every peer that arrived by dialling in. Binding inbound sessions as `child` would
invert that default fleet-wide: every embedded 3.x node would stop generating per-packet settlement
claims on value-bearing forwards toward _anything_ that had dialled in and authenticated, and would
do so silently — the skip logs at `debug`. "A peer that dialled in is structurally a child" is true
of the _connection_, and false of the _address_: an inbound dialler keeps its own ILP address and is
therefore, by this connector's own validator, not a child. Nothing may rely on the relation being
inferred from which side opened the socket.

**And neither can ship at all.** There is no branch from which a 3.x change could be published (see
"Where this code is maintained"). A patch would have to be applied to a tree that no longer exists
on `main`, released from release machinery that was deleted, into a major version line that has been
superseded by an incompatible 4.0.0.

## What an embedder may rely on

For as long as a `^3.x` pin resolves — which is permanently, since the line is closed:

- `ConnectorNode.addRoute(route)`, `setLocalDeliveryHandler(handler)` and `setPacketHandler(handler)`
  are public, typed, and shipped in the package's `.d.ts`. They are the supported seams.
- `ConnectorNode.registerPeer(config)` is public and is the only supported way to set a peer
  relation without the admin HTTP API. It is usable when the peer has a dial-back endpoint and an
  address under the connector's own — i.e. for a genuine ILP child.
- `PacketHandler.setPeerRelation` is a **public method on a private field**. Reaching it through
  `ConnectorNode`'s `_packetHandler` is unsupported, and it is also **safe from the failure mode
  that ordinarily makes such a reach fragile**: the symbol cannot be renamed or refactored, because
  no version containing it will ever be published again. An embedder doing this is pinned to a
  frozen artifact, not tracking a moving one.
- Ordering is load-bearing when the reach is used: add the route **first**, set the relation
  **second**. `addRoute` consults the next hop's _current_ relation, so a prefix that is not under
  the connector's own address is refused once that peer is already held as `child`.

The security properties an embedder must preserve, since the connector will not enforce them for a
relation set behind its back:

1. A relation may only ever be set for the name the peer **authenticated under** on its BTP
   greeting — never a name taken from packet or payload content. Otherwise a payload claiming
   `g.proxy` installs a waiver, and a route, against the connector's own upstream.
2. It must never shadow the connector's own `ilpAddress`.
3. It must never shadow an operator-configured or static route; an operator route always wins.
4. It should be withdrawn on `stop()`, and bounded — the map has no eviction of its own.

swap#148 establishes all four in `packages/swap/src/leg-b-return-path.ts`. They are restated here
because they are properties of _this_ seam, and the next embedder to find it will not have read that
pull request.

### The one way to avoid the waiver entirely

`claimRequired` is `!isLocalDelivery && forwardingPacket.amount > 0n && requiresSettlementClaim(…)`.
A forward whose ILP `amount` is `0` needs no claim and therefore no relation. For a rolling-swap
leg B the value is carried by the signed chain-B claim inside the packet, and the ILP amount is
already advisory — swap#148 notes the client does not read it. Zeroing it would make the return path
need nothing but `addRoute`, at the cost of a wire that no longer states its own value. That trade
is the embedder's to make; it is recorded here because it is the only relation-free option, not
because it is recommended.

## What replaces this on the Rust connector

Not a renamed knob — the whole problem is answered a level up, and the seam this document describes
has no successor because it has no remaining job.

**There is no relation, and nothing to waive.** `PeerRelation` in
`crates/connector-peer-btp/src/dial.rs` and `crates/connector-peer-http/src/dial.rs` names _a
peering relationship_ — its timeouts, credential and claim domains — not a position in a hierarchy.
It is built by `from_config` from the TOML and carries no parent/child/peer discriminant. `child` as
a topology tag does not appear anywhere in `crates/`, and neither does any relation-keyed exemption
from claim coverage: [ADR 0031](adr/0031-a-peer-prepare-arrives-with-its-covering-claim-or-it-is-greeted.md)
makes coverage universal on the peer path and explicitly not configurable.

**The return path is already resolved, natively.** `crates/connector-client-edge/src/session_registry.rs`
holds an ILP address → live BTP session table, bound at the address a client declares on its BTP
auth frame, and `crates/connector-client-edge/src/session_route.rs`'s `route_prepare` is the routing
arm that delivers through it. Its module doc states the same properties swap#148 had to build by
hand, as connector-side invariants:

- a configured **forwarding** route always wins — the session arm is reached only when
  `Connector::handle_prepare` has already answered `F02`, so "a session therefore never shadows an
  operator's own routing table";
- a destination resolving to **both** a live session and a configured app route is refused outright
  rather than resolved by precedence, "as the configuration error it is";
- an unbound destination returns the original `F02` unchanged; a bound one that fails answers `T01`,
  never `F02`.

**And no claim is required in that direction.** The PREPARE handed to a session goes out with an
empty protocol-data slice — there is no claim on it and none is demanded. Value in that direction is
settled by `crates/connector-client-edge/src/outbound_ledger.rs`'s `ClientPayoutLedger`, credited
_after_ a genuine FULFILL returns. That is the same economics the `child` waiver was reaching for,
implemented as its own mechanism rather than as a hole in another one.

So a maker fronted by the Rust connector needs no route to install, no relation to set, and no
private field to reach. It needs only that its client dialled in and declared the address the
leg-B PREPARE is sent to.

**But it must originate that PREPARE through the right door.** `route_prepare` is wrapped around
`handle_prepare` inside `connector-client-edge`, not folded into it —
`connector_runtime::Connector` cannot see the session registry at all, because
`connector-client-edge` depends on `connector-runtime` and never the reverse. The consequence is an
asymmetry worth knowing before you hit it: the operator surface's `POST /packets`
(`crates/connector-operator/src/lib.rs`, `originate_packet`) calls `Connector::handle_prepare`
directly and so **bypasses the session arm entirely**, answering `F02` for a destination that is
only bound in the session registry. The client edge's own ingress — `POST /ilp`, or the BTP
carriage — is the surface that reaches it. See the issue linked from this document's pull request.

**A TypeScript app pairs with it as a sidecar, not as a library.**
[ADR 0001](adr/0001-rust-workspace-library-first.md) is explicit that TypeScript consumers move to
HTTP: "the embedded node is deleted; `@toon-protocol/connector` becomes a thin HTTP client. No
native addon, no FFI, no per-platform prebuilds." A Rust embedder can hold an `Arc<Connector>` and
call `upsert_runtime_peer` / `upsert_runtime_peer_route` in process; a TypeScript one cannot, and
would not want to here — those write the config-shaped forwarding table
([ADR 0034](adr/0034-a-runtime-peer-route-table-never-shadows-the-config-file.md)), which has no
bearing on reaching a live client session.

## See also

- [`docs/local-delivery-fulfillment-contract.md`](local-delivery-fulfillment-contract.md) — the
  sibling frozen contract, covering `setLocalDeliveryHandler()` / `setPacketHandler()`, the other
  seams this same embedder uses.
- [`docs/operators/swap-node-bringup.md`](operators/swap-node-bringup.md) — the runbook for the one
  embedded `ConnectorNode` still running on the fleet.
- [ADR 0017](adr/0017-the-typescript-connector-is-a-prototype.md) — why the TypeScript connector was
  retired.
- [connector#76](https://github.com/toon-protocol/connector/issues/76) — the `T00` that created the
  `child` waiver; [connector#78](https://github.com/toon-protocol/connector/issues/78) — the `F06`
  on the inbound side.
- [swap#148](https://github.com/toon-protocol/swap/pull/148) — the embedder, and the four security
  properties restated above.
