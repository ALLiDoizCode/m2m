# Bringing up the first Rust peer link (BTP over `wss`)

> **Carriage choice.** ADR 0027 gives operators two peer carriages — BTP over `wss://` and
> ILP-over-HTTP over `https://` — selected per connector (`[peers].expose`) and per peer (the
> `endpoint` scheme). **This bring-up uses BTP**, because it is a standing high-frequency fleet link
> and because BTP is the only carriage a NAT'd operator can use, so it is the one worth proving
> first. An HTTP peering follows the same gates with the header equivalents
> (`Payment-Channel-Claim`, `Toon-Claim-Ack`, `Toon-Accumulated-Cost`) and the one difference ADR
> 0027 names: on a peering where only one side dials, the non-dialing side cannot FLUSH and must set
> a lower exposure ceiling instead of relying on `flushIntervalMs`.

Operator runbook for
[ADR 0027](../adr/0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md).

> **This replaces the four-phase migration plan that used to live at
> `btp-peer-transport-migration.md`.** That plan assumed traffic had to be drained off the raw-TCP
> peer wire onto BTP. The 2026-08-03 audits (`toon-meta/prototypes/peer-wire-audit/`) established
> that **no link has ever run on the peer wire**: the live apex `connector-rust.toml` has no
> `[[peers]]` table, `peer-claims.log` on the Rust state volume is 0 bytes, and no peer-wire
> listener is open on either box. There is nothing to drain and no dual-stack window. The raw-TCP
> transport is deleted up front; what follows is a **bring-up**, not a cutover.

## What is actually deployed today

Verify before touching anything — both boxes run hand-tuned **bind-mounted** configs that lead the
repo copies.

|                      | Apex (`toon`, `proxy.devnet.toonprotocol.dev`)                                   | Store (`toon-devnet-store`, `proxy.store.devnet.toonprotocol.dev`) |
| -------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| TypeScript connector | yes — serves the **default** public edge at `/`, and one end of the live peering | yes — the **only** connector on the box                            |
| Rust connector       | yes, but only under `/rust/ilp` and `/rust/ilp/btp`                              | **none**                                                           |
| Inter-node link      | TS↔TS **BTP over `wss://…:443`**, live, carrying paid packets                    | same link, other end                                               |
| Rust store leg       | plain `POST https://proxy.store.devnet.toonprotocol.dev/store` — not a peering   | n/a                                                                |

Two consequences. The Rust store-box deployment is a **precondition**, not a step of this runbook
(it is tracked separately). And retiring the TypeScript connectors cannot happen until this link is
proven, because they are the default client edge and both ends of the only inter-node link.

## Preconditions

- The raw-TCP transport is deleted; `PeerTransport` and `InProcessPeerTransport` remain.
- Both carriages' peer entries/headers and role-by-auth are specified, with **shared** canonical
  vectors (ADR 0021): `payment-channel-claim` / `Payment-Channel-Claim`, `claim-ack` /
  `Toon-Claim-Ack`, `toon-minimum-delivery` / `Toon-Minimum-Delivery`, `toon-accumulated-cost` /
  `Toon-Accumulated-Cost`.
- `[peers].expose` selects the listeners; each `[[peers]]` entry has an `endpoint` URL whose scheme
  selects the dialed carriage, plus a credential; `[[peer_channels]]` exists and wires `ClaimBook`'s
  channel id, counterparty verification key and EIP-712 domain. A peering with no dialable
  intersection is a **load-time error**.
- **Peer-forwarded routes are priced and charged (#620).** Non-negotiable: a peer-forwarded route
  that is not charged is a free-write path on `g.toon`, and claims spent for free cannot be
  recharged.
- A Rust connector is deployed on the store box with its client edge behind nginx.

## Order — store accepts, apex dials

1. **Store box.** Add the peer BTP listener to the Rust connector's config and an nginx `location`
   TLS-terminating the `wss` upgrade to the Rust container, alongside the existing `/store` path
   (which is untouched). Configure the apex's credential and the `[[peer_channels]]` entry for it.
2. **Apex box.** Add `[[peers]]` (the store's `wss://` endpoint + credential) and the matching
   `[[peer_channels]]`. Repoint **`g.toon.store` only** to peer forwarding. Leave `g.toon.ario` on
   today's HTTPS termination — that is the rollback path, and it stays warm.
3. **Soak**, then flip `g.toon.ario` the same way.
4. **Discovery**, last: point the advertised `btpEndpoint` host at the Rust listener in nginx, then
   the genesis-seed republish chain in the `toon` core repo. Nothing before this step changes what
   any external client resolves.

## Gates — in order, and do not reorder (c)

- **(a) Link up.** BTP auth succeeds both directions; the session survives a store-container restart
  and reconnects without operator action.
- **(b) Routing intact.** The apex still answers prices for every route; a probe of `g.toon.store`
  returns the priced reject carrying `toon-accumulated-cost`.
- **(c) Paid write end to end with NO free-write path.** A publish is charged at the apex client
  edge, forwarded with a peer claim as `payment-channel-claim`, fulfilled, and the store-side claim
  watermark advances. A **claimless** peer PREPARE to a priced route is rejected. This is the #620
  gate. If (c) cannot be demonstrated, stop — an unmetered peer-forwarded route is worse than no
  peer link at all.
- **(d) Claim exchange complete.** A FLUSH (TRANSFER) sent when traffic stops is acknowledged with a
  `claim-ack` entry on its RESPONSE; a deliberately stale-nonce claim comes back
  `{"result":"rejected","reason":"nonce_not_advancing"}` **without** rejecting the PREPARE it rode
  on. The journaled claim verifies against the configured counterparty and is redeemable — ADR 0024's
  digest is unchanged, so the existing redemption path applies as-is.
- **(e) Discovery.** `kind:10032` announces still propagate on devnet and still resolve to a
  reachable endpoint for existing clients.

## Rollback

One config edit on the apex: point `g.toon.store` (and `g.toon.ario`, if flipped) back at
`handler_url = "https://proxy.store.devnet.toonprotocol.dev/store"` and restart. That is what
production does today, so the rollback target is the known-good current state rather than a
reconstructed one. No client-visible change, because discovery is not touched until step 4.

## Retiring the TypeScript connectors

Gated on the gates above holding for a soak window with no rollback, and tracked as its own ticket.
It is a fleet change, not a peer-transport change: the TS connectors currently serve the default
public edge on the apex and are the only connector on the store box, and the `relay` and `store`
repos still rebuild `relay-connector` / `store-connector` images **from** the TypeScript connector
image on every merge to main. Those image pipelines have to be repointed before the boxes are.
