# Migrating the peer transport to BTP

**Status:** Operational plan, consistent with
[ADR 0026](../adr/0026-connectors-peer-over-btp-the-clean-room-peer-wire-is-retired.md) — it does
not restate that decision, it sequences its execution. Written for whoever implements and
executes the migration issues, not for the general reader of the ADR. No step here is done at
the time of writing.

**Implementation issues:** Phase 1 — #676 (dual-stack transport); Phase 2 — #677 (config schema
and discovery value alignment); Phase 3 — #678 (devnet cutover); Phase 4 — #679 (removal of the
raw-TCP wire). #678 is additionally gated on #620's pricing fix, wherever that lands.

**Fleet reality this plan starts from** (verify it still holds before executing anything): no
production link runs on the raw-TCP peer wire. The devnet store-side overlay is marked NOT
DEPLOYED in `infra/linode-store/connector-rust.toml`; the apex
(`infra/linode-node/connector-rust.toml`, bind-mounted and hand-tuned on the box `toon`, which
leads the repo copy) terminates `g.toon.ario` / `g.toon.store` at the store app over
`https://proxy.store.devnet.toonprotocol.dev/store`. The blockers that forced that shape are
#623 (peer wire cannot carry a public, TLS-terminated link) and #620 (a peer-forwarded route is
neither priced nor charged — it would serve writes for free). BTP-over-wss removes #623;
**nothing about the transport removes #620**, so #620's fix gates Phase 3 regardless.

## Phase 0 — preconditions (no peer code yet)

1. **The shared BTP framing layer exists.** The client-facing BTP ingress (`docs/btp-client-ingress-findings.md`,
   PR #674 follow-ups) lands its websocket server and BTP codec in `connector-client-edge`. The
   peer transport reuses that layer; if peer work starts first, the framing layer is built as a
   transport-neutral module and the client ingress adopts it — either order, one codec.
2. **Spec and vectors first** (ADR 0003's surviving discipline, ADR 0021): rewrite §1–§2 of
   `docs/protocol/peer-wire-spec.md` against BTP framing; specify the sub-protocol entries
   (minimum delivery, accumulated cost, claim, claim-ack) with canonical vectors in
   `vectors/wire-vectors.json` before implementation.
3. **Role-by-auth is specified**: what credential a peer session presents, where it is
   configured on the accepting side, and the test that an unauthenticated or wrongly-credentialed
   session can never reach peer handling (the `toon-sandbox` regression test, named in ADR 0026).

**Rollback:** trivial — documentation only.

## Phase 1 — dual-stack transport

The connector accepts and dials both transports simultaneously; per-peer selection in config.

- Accepting: the BTP listener (shared with the client edge, role decided by auth — or a
  dedicated peer listener if review demands it; ADR 0026 allows both) runs alongside
  `peer_wire_addr`'s raw-TCP listener. Neither is removed.
- Dialing: `NetworkPeerTransport` grows a BTP-dialing sibling behind the same `PeerTransport`
  port; which one a peer gets is read from that peer's config entry.
- The `InProcessPeerTransport` fake and the fee/claim/routing logic above the port are untouched
  — the port boundary (`crates/connector-runtime/src/peer_transport.rs`) is what makes this
  phase small.

**Verification gate:** local-stack (`deploy/connector-rust/local-stack`) runs one topology with
a raw-TCP link and one with a BTP link; both carry a paid prepare→fulfill with a claim and a
FLUSH/claim-ack equivalent end to end. CI vectors pass for both encodings.

**Rollback:** config-only — point the peer entry back at the raw-TCP transport.

## Phase 2 — config and discovery schema

**Config (`crates/connector-config`).** Today `[[peers]]` is `{ id, addr }` with `addr` a
literal `SocketAddr` (no hostnames, no scheme), and there is no way to configure a peer channel
at all — ADR 0024's peer claims have no `connector.toml` surface (the #620 complex). Target
shape (exact field names settled in the issue, `deny_unknown_fields` kept):

```toml
[[peers]]
id        = "store"
endpoint  = "wss://proxy.store.devnet.toonprotocol.dev/btp"   # URL, not SocketAddr
transport = "btp"            # "peer-wire" accepted during dual-stack; default "btp" at the end
auth_token = "…"             # peer credential, per role-by-auth

[[peer_channels]]            # NEW — closes the ADR 0024 configuration gap
peer_id   = "store"
channel_id = "0x…"           # on-chain bytes32
counterparty = "0x…"         # verification key the claim gate checks
chain_id  = …
token_network = "0x…"        # EIP-712 domain inputs (ClaimBook::set_channel_domain)
```

`peer_wire_addr` and `addr` survive through the dual-stack window only. The accepting side needs
the mirror surface: accepted peer credentials mapped to peer ids and their `[[peer_channels]]`.

**Discovery.** No schema change. `kind:10032` (`IlpPeerInfo`) and `genesis-peers.json` already
require `btpEndpoint` as a `wss://` URL and have never carried a raw-TCP peer endpoint — the
raw-TCP wire was invisible to discovery, so there is nothing to remove. What changes is
**values and ownership**: after Phase 3 the advertised `btpEndpoint` for a devnet node must
resolve (via that box's nginx) to the Rust BTP listener rather than the retired TypeScript
container's wss port. That is an infra/nginx change on the boxes plus the cross-repo
genesis-seed republish chain (`toon` core repo), not a connector schema change. ADR 0022 stands:
the connector answers, apps announce.

**Verification gate:** config round-trip tests; a `[[peers]]` entry with `transport = "btp"` and
a wss URL boots; a peer prepare arriving on the BTP transport is charged and claim-gated exactly
as the client edge charges a terminated route (this is the #620 acceptance test).

**Rollback:** old config fields still parse during dual-stack; reverting a config file reverts
the node.

## Phase 3 — devnet cutover (apex ↔ store)

This is a **bring-up, not a drain**: it converts the terminated-HTTPS store leg into the first
real Rust peer link. Order matters because the store box only accepts (it never dials out).

1. **Store box (`toon-devnet-store`) first.** Deploy the Rust overlay
   (`docker-compose.store.rust.yml`) with the BTP peer listener enabled; add an nginx `location`
   TLS-terminating the wss upgrade to the Rust container (same certbot host that already fronts
   `/store`). The box's bind-mounted, hand-tuned `connector-rust.toml` is authoritative — edit
   it on the box, then reconcile the repo copy (box config leads the repo; keep them convergent).
   _Gate:_ wss endpoint answers a BTP auth from a test credential; `/metrics` up; the existing
   HTTPS-terminated `/store` path is untouched and still serving the apex's current route.
2. **Apex box (`toon`) second.** Add the `[[peers]]` store entry (wss endpoint, credential) and
   `[[peer_channels]]`, and repoint the `g.toon.store` route from `handler_url` termination to
   `peer_id = "store"`. Keep `g.toon.ario` on the terminated-HTTPS path until the peer path
   proves out, so the two shapes run side by side on one box.
   _Gates, in order:_ (a) peer link up — BTP auth success in both boxes' logs, reconnect after a
   store-container restart; (b) routing intact — the apex still answers prices for all routes,
   and a probe of `g.toon.store` returns the priced reject with `accumulatedCost` via the
   sub-protocol; (c) paid write end to end — a client publish to `g.toon.store` is charged at
   the apex edge, forwarded over BTP with the peer claim, fulfilled, and the store-side claim
   journal (`state_dir`, issue #605) shows the watermark advance; **no free-write path** — a
   claimless peer prepare is rejected (the #620 test, live); (d) settlement — the peer claim in
   the store box's journal verifies against the configured counterparty and is redeemable
   (digest per ADR 0024, unchanged); (e) discovery — `kind:10032` announces still propagate on
   devnet relays and the advertised `btpEndpoint` values resolve to live listeners.
3. **Flip `g.toon.ario`** to the peer route once (a)–(e) hold for a soak window, then update the
   boxes' nginx and the genesis/announce values (Phase 2's ownership change) so `btpEndpoint`
   points at Rust everywhere.

**Rollback at any step:** repoint the route back to `handler_url` HTTPS termination in the
apex's bind-mounted config and `docker compose up -d` — the terminated path is never removed
during this phase, so rollback is one config edit per route, no image change, no store-side
action. Both ends of the link change only when step 2 lands, and step 2 is a single apex config
edit — the atomicity problem is that small because the store side accepts both shapes
throughout.

## Phase 4 — removal of the raw-TCP wire

Delete `crates/connector-runtime/src/peer_wire.rs`, `network_peer_transport.rs`'s raw-TCP
halves, the `peer_wire_addr` and `[[peers]].addr`/`transport = "peer-wire"` config surface, and
the raw-TCP sections of the spec. Criteria, all required:

1. No `[[peers]]` entry with `transport = "peer-wire"` and no `peer_wire_addr` in the repo, in
   `infra/*`, in `deploy/*/local-stack`, or in the boxes' bind-mounted configs (check the boxes,
   not just the repo — they lead).
2. Phase 3's gates have held on devnet for a soak window with no rollback.
3. Vectors and `docs/protocol/peer-wire-spec.md` describe only the BTP transport; the
   sub-protocol vectors are canonical.
4. ADR 0003 and ADR 0022 carry their supersession block-quotes pointing at ADR 0026.

Config parsing of the removed fields becomes a **hard error naming this document** — not a
silent ignore — so a stale box config fails loudly at boot rather than silently not peering.

**Rollback:** git revert of the removal commit; nothing outside the repo depends on the raw-TCP
wire (discovery never advertised it), which is what makes the removal a normal commit rather
than a coordinated event.

## What is irreversible, and what is lost if a step is wrong

Nothing before Phase 4 is irreversible; every earlier step rolls back by config. The dangerous
step is not removal but **step 3.2 done before #620's fix is proven**: a peer-forwarded route
that is not charged is a free-write path on the official `g.toon` namespace, and claims already
spent free cannot be recharged afterwards. Gate (c) exists for exactly this; do not reorder it.
The second risk is credential handling in role-by-auth: a misconfigured accepting side that
admits an unauthenticated session as a peer reproduces the TypeScript fleet's `toon-sandbox`
defect on the Rust fleet — the regression test from Phase 0.3 must run against the deployed
listener, not only in CI.

## Relationship to the ADRs

ADR 0026 decides the end state and what is given up; this document owns the mechanics and may
change without touching the ADR. ADR 0003's client-edge half, ADR 0022's answer-don't-announce
posture, and ADR 0024's claim digest are load-bearing throughout and are not modified by any
step here — only carriage and transport move.
