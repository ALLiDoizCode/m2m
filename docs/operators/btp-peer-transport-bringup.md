# Bringing up the first Rust peer link (BTP over `wss`)

> **Carriage choice.** ADR 0027 gives operators two peer carriages — BTP over `wss://` and
> ILP-over-HTTP over `https://` — selected per connector (`[peers].expose`) and per peer (the
> `endpoint` scheme). **This bring-up uses BTP**, because it is a standing high-frequency fleet link
> and because BTP is the only carriage a NAT'd operator can use, so it is the one worth proving
> first. An HTTP peering follows the same gates with the header equivalents
> (`Payment-Channel-Claim`, `Toon-Claim-Ack`, `Toon-Accumulated-Cost`) and the one difference ADR
> 0027 names: on a peering where only one side dials, the non-dialing side cannot FLUSH. Before
> [ADR 0033](../adr/0033-the-exposure-machinery-is-retired-not-restated.md) (issue #882) this also
> meant setting a lower exposure ceiling instead of relying on `flushIntervalMs`; both are retired
> along with the credit window they bounded — every peer PREPARE now carries its own covering
> claim (ADR 0031) regardless of which side dials.

Operator runbook for
[ADR 0027](../adr/0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md).

> **This replaces the four-phase migration plan that used to live at
> `btp-peer-transport-migration.md`.** That plan assumed traffic had to be drained off the raw-TCP
> peer semantics onto BTP. The 2026-08-03 audits (`toon-meta/prototypes/peer-role-audit/`) established
> that **no link has ever run on the peer semantics**: the live apex `connector-rust.toml` has no
> `[[peers]]` table, `peer-claims.log` on the Rust state volume is 0 bytes, and no peer-role
> listener is open on either box. There is nothing to drain and no dual-stack window. The raw-TCP
> transport is deleted up front; what follows is a **bring-up**, not a cutover.

## What is actually deployed today

> **Superseded 2026-08-04/05 — this section is now history.** The bring-up succeeded and the Rust
> cutover followed. Both boxes now run **only** the Rust connector at `/` (the TypeScript container
> on the store box exited at 2026-08-04T19:24:29Z), the peering is live between them, and the store
> box's edge was renamed `proxy.store.devnet` → `proxy.ario.devnet` (#774) to match the
> `g.toon.ario` prefix it serves. `proxy.store` survives only as a deprecated alias — same
> certificate, same upstream — and is slated for removal, so read every `proxy.store` URL below as
> the name that host had at the time.
>
> **Further superseded by issue #872.** The apex box this bring-up peered the store to has since
> been destroyed (toon-meta#310 / toon-meta#313) and `infra/linode-node/` deleted. There is no
> peering on this fleet at all today: both surviving boxes are client-edge-only and terminate their
> own prefix. The mechanism below (BTP carriage, the accept/dial split) is what a future peering
> would use. The one part of it that has changed since is authentication: the peering shared secret
> is deleted, and a peer proves itself with a signed claim
> ([ADR 0060](../adr/0060-a-claim-proves-a-peering-and-the-shared-secret-is-deleted.md)).

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
  `Toon-Claim-Ack`, `toon-accumulated-cost` / `Toon-Accumulated-Cost`. (`toon-minimum-delivery` /
  `Toon-Minimum-Delivery` was a fourth pair; it is retired with the field, ADR 0057.)
- `[peers].expose` selects the listeners; each `[[peers]]` entry has an `endpoint` URL whose scheme
  selects the dialed carriage; `[[peer_channels]]` exists and wires `ClaimBook`'s channel id,
  counterparty verification key and EIP-712 domain — and since ADR 0060 that row is the whole of
  peer authentication. A peering with no dialable intersection is a **load-time error**.
- **Peer-forwarded routes are priced and charged (#620).** Non-negotiable: a peer-forwarded route
  that is not charged is a free-write path on `g.toon`, and claims spent for free cannot be
  recharged.
- A Rust connector is deployed on the store box with its client edge behind nginx.

## Order — store accepts, apex dials

1. **Store box.** Add the peer BTP listener to the Rust connector's config and an nginx `location`
   TLS-terminating the `wss` upgrade to the Rust container, alongside the existing `/store` path
   (which is untouched). Configure the apex's `[[peers]]` entry and the `[[peer_channels]]` row
   binding its channel.
2. **Apex box.** Add `[[peers]]` (the store's `wss://` endpoint) and the matching
   `[[peer_channels]]`. Repoint **`g.toon.store` only** to peer forwarding. Leave `g.toon.ario` on
   today's HTTPS termination — that is the rollback path, and it stays warm.
3. **Soak**, then flip `g.toon.ario` the same way.
4. **Discovery**, last: point the advertised `btpEndpoint` host at the Rust listener in nginx, then
   the genesis-seed republish chain in the `toon` core repo. Nothing before this step changes what
   any external client resolves.

## Gates — in order, and do not reorder (c)

- **(a) Link up.** The BTP session establishes both directions and each side takes the `peer` role
  on its first covering claim (ADR 0060 — there is no auth frame to succeed); the session survives
  a store-container restart and reconnects without operator action.
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

---

# The peer config surface

The configuration surface for peering, and what changed when the raw-TCP transport was
deleted (issue #677). This is the section every peer-related config error names: if a
connector refused to start and sent you here, find your error message below.

- **Decision:** [ADR 0027](../adr/0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md)
  — connectors peer over BTP or ILP-over-HTTP; the raw-TCP transport is deleted.
- **Normative detail:** [`docs/protocol/peer-carriage-spec.md`](../protocol/peer-carriage-spec.md)
  — the role rule, the two carriages, and §11's config requirements.
- **Scope of this document:** the configuration surface only (issue #677). The carriages that
  actually dial and accept are issue #676; until they land, a peering validated by this surface is
  a peering nothing traverses, and a packet routed to one is answered `T01`.

## What was removed

| Removed field          | Replaced by                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `peer_wire_addr`       | `peer_expose` — peer carriages ride this node's own listeners, not a second socket                  |
| `[[peers]].addr`       | `[[peers]].endpoint` — a `wss://` or `https://` URL, not a `SocketAddr`                             |
| `[[peers]].credential` | nothing — a peering is proven by a verified claim on one of its `[[peer_channels]]` rows (ADR 0060) |

Both are **hard, named errors**, never a silent ignore. The devnet boxes run bind-mounted configs
that lead the repo copies, so a stale file has to stop the node rather than come up looking healthy
and never peer.

## Expose and dial are two axes

`peer_expose` says which peer carriages **this node opens a listener for**. Each peer's `endpoint`
says which carriage **this node dials that peer on**, decided solely by the URL scheme. Neither
implies the other.

```toml
peer_expose = "btp"   # "btp" | "http" | "both" | "neither"; default "neither"
```

- `wss://` selects the **BTP** carriage. Symmetric once established: after auth either side may
  originate on the one session.
- `https://` selects the **ILP-over-HTTP** carriage. Only the dialing side can originate.
- Any other scheme is a load-time error. Both are TLS-only, because a peering carries signed
  balance proofs — `ws://` and `http://` are refused too, unless the node has explicitly opted in
  (see `peer_allow_plaintext_endpoints` below).
- **No `endpoint` at all** means accept-only: this node never dials that peer, and the peer dials
  in.

### Where a peer connects: this node's own listener

There is **no peer port**. A node that exposes a peer carriage serves it on the paths its client
edge already serves, on `client_edge_addr`:

| Carriage      | Path           | What a peer sends                                             |
| ------------- | -------------- | ------------------------------------------------------------- |
| BTP           | `GET /ilp/btp` | the websocket upgrade, then `auth` on its first MESSAGE       |
| ILP-over-HTTP | `POST /ilp`    | the OER PREPARE, with its covering claim on **every** request |

So a peer's `endpoint` is `wss://<host>/ilp/btp` or `https://<host>/ilp`, and nginx needs no new
`location` beyond whatever already fronts the client edge — the `wss` upgrade included.

What tells a peer interaction from a client one on that shared socket is the **claim on the frame**
and nothing else (below). The listener, the port and the bind address are explicitly **not** allowed
to decide, which is why there is nothing to open and nothing to firewall separately.

**The shared socket stays permissionless for clients.** Exposing a peer carriage adds peer handling
behind the claim check; it puts nothing in front of anybody, and since ADR 0060 there is no peer
credential to put anywhere. A client still opens `GET /ilp/btp` presenting no credential — or, as
the deployed client does, an `auth` entry with `secret: ""`, whose contents the client edge does not
verify — and is admitted as a client; what authorizes its **writes** is the signed
payment-channel claim it puts on each frame, per
[`../protocol/client-edge-spec.md`](../protocol/client-edge-spec.md) §1.9 step 1 (_"Authorization to
write comes from the claim, never the session"_). Nothing in this runbook asks an operator to issue
a token to clients, because there is none to issue.

A peering establishes only if at least one side dials a carriage the other exposes. What the far
side exposes is not knowable from this file, so that half surfaces as an ordinary dial failure
naming the peer and the endpoint. What _is_ knowable is refused at load — see `PeerUndialable` and
`PeerRouteUndeliverable` below.

**An HTTP-only node can neither reach nor be reached by a NAT'd peer.** A NAT'd node exposes
nothing and can only dial, and it can only be reached back over a persistent session — so the
counterparty must expose BTP. If you run behind NAT, `peer_expose = "neither"` and give every peer
a `wss://` endpoint.

## A correct peering

```toml
peer_expose = "btp"
state_dir = "/app/state"

[[peers]]
id = "store"
endpoint = "wss://store.example.net:443/btp"
# there is no `credential` here: the shared secret is deleted (ADR 0060) and a
# `[[peers]]` entry that still sets one is a named load-time error. What proves
# this peering is the `[[peer_channels]]` row below and the signed claims on it.
# claim_ack_timeout_ms and peer_answer_timeout_ms default to 30000 each
# `ceiling`/`flush_interval_ms` used to be set here -- retired along with the
# credit window they bounded (ADR 0031, ADR 0033, issue #882). Delete them
# rather than replace them; setting either now is a named load-time error.

[[peer_channels]]
peer_id = "store"
channel_id = "0x…"          # 32 bytes of hex
counterparty_key = "0x…"    # the 20-byte address whose signature is accepted
chain_id = 31337
token_network = "0x…"       # the EIP-712 verifyingContract

[[routes]]
prefix = "g.example.store"
peer_id = "store"
fee = 3
```

**`chain_id`/`token_network` must be the deployment this node settles through.** They are the
EIP-712 domain every claim on the channel is signed and verified under (ADR 0024), and since issue
#1136 the node holds them against the `TokenNetwork` its own `[settlement.evm]` registry resolves
at connect: a disagreement is a refusal to start naming both contracts, not a warning. There is
nothing to copy them from -- `[settlement.evm]` names the _registry_ -- so read the resolved
address off the node's own x402 greeting (`extra.settlement.tokenNetwork`) or off the registry
with `cast call <contract_address> "getTokenNetwork(address)(address)" <token_address>`, and write
that. A row left behind after a `TokenNetwork` redeploy used to load happily and render carriage
for claims it could never redeem; it now stops the node instead.

`[[peer_channels]]` also accepts a Solana-shaped row (issue #759) -- `channel_account` and
`counterparty_key` instead of `channel_id`, and no `chain_id`/`token_network` (a Solana channel has
neither):

```toml
[[peer_channels]]
peer_id = "store"
channel_account = "…"       # the base58 channel PDA
counterparty_key = "…"      # the base58 ed25519 key whose signature is accepted
```

**Do not write `program_id` here.** The key was removed in issue #1128, and a row that still sets
it fails load by name (`PeerChannelProgramIdRemoved`). The program this channel is judged and
settled under is `[settlement.solana] program_id` -- the only program this node can submit a
redemption to, so the only one a peer channel can live under. It was a second declaration of the
same fact, nothing compared the two, and since ADR 0053 bound the settlement program into a Solana
claim's signed message the consequence of them disagreeing was not cosmetic: the node verified
inbound peer claims under the row's program while redeeming under the table's, carrying traffic for
claims it could never cash. Typo it, or leave it stale after a program redeploy, and nothing said
so. **If you are recovering an old config, delete the line -- do not copy its value anywhere.**

For the same reason, a Solana row on a node with **no** `[settlement.solana]` table now fails load
(`PeerChannelWithoutSolanaSettlement`) rather than half-working: there is no program id to read and
no backend to redeem through. This is a change from the previous behaviour, where such a node
verified inbound claims on the channel and signed none outbound.

**A channel row needs the settlement table of its own chain, whichever chain that is**
(issue #1138, `peer-carriage-spec.md` §11.1). An EVM `[[peer_channels]]` row on a node with no
`[settlement.evm]` is `PeerChannelWithoutEvmSettlement`, and so are the two `[[client_channels]]`
shapes on their own chains. This is a change from the previous behaviour on all three, and it is
not the Solana row's missing-input problem: an EVM row declares its own EIP-712 domain, so the file
was complete and the node happily verified inbound claims. What is missing is the node's **address
on that chain**. `[settlement.evm.key]` is what a channel names as this node's participant, and
`TokenNetwork.claimFromChannel` reverts `InvalidParticipant` for anyone else — so without the table
there is no address this node could ever redeem the claim as, from this process or any other, and
it signs no covering claim outbound either. The rule is per chain and no wider: a Solana-only node
keeps loading its Solana rows, which is exactly what `local/mixed-chain/connector-c.toml` is.

Otherwise a Solana row is wired exactly like an EVM one (issue #998): `channel_account`/
`counterparty_key` reach `ClaimBook`'s Solana verification key the way an EVM row's
`channel_id`/`counterparty_key` reach its own, it is wired into `accept_inbound` and outbound
signing, and its outbound identity is the `[settlement.solana]` key (the Solana counterpart of the
EVM peer-claim signer, ADR 0024).

### `credential` — deleted, and refused by name

**A peering carries no credential.** The `{peerId, secret}` shared secret is deleted — from
`[[peers]]`, from the BTP `auth` protocolData entry and from the `Toon-Peer-Auth` request header, on
both carriages together ([ADR 0060](../adr/0060-a-claim-proves-a-peering-and-the-shared-secret-is-deleted.md),
[`peer-carriage-spec.md`](../protocol/peer-carriage-spec.md) §1.4). A `[[peers]]` entry that still
sets `credential` stops the node at load with `PeerCredentialRemoved`, in any of its spellings —
`secret`, `secret_file` or an empty table. Delete the subtable, and delete the `*.secret` file it
pointed at; nothing on the box reads it any more.

There is **no replacement key**: not renamed, not demoted to a label, not kept as an optional
discriminator. What replaces the credential is the claim every peer frame already carried
([ADR 0042](../adr/0042-a-packet-carries-its-claim.md)). A signature over ADR 0024's balance proof
proves control of the key the channel was actually opened against — strictly stronger than
possession of a string both operators wrote into their own config files, and present on every
packet rather than once per session. The rule it feeds is
[Role is decided by a verified claim](#role-is-decided-by-a-verified-claim), below.

Two things follow for an operator.

**Onboarding a peer no longer needs a side channel.** There is no string for the two operators to
agree out of band, which is what lets a peering be established from a public URL
([ADR 0058](../adr/0058-a-peering-is-established-from-a-url.md)) — everything the counterparty
needs is either in the self-description or derivable from it.

**The kill switch changed.** Revoking a secret used to cut a peering dead without touching a key
that also signs claims. The lever now is `DELETE /peers/:id`, an authenticated operator write on
the durable runtime peer table (ADR 0034, ADR 0058): immediate, no restart, and auditable. It
removes a **runtime** row — a peering written into this box's TOML is cut by editing that file and
restarting, because the runtime table never shadows the config file (ADR 0034).

A **receiving** node ignores a `Toon-Peer-Auth` header or a peer `auth` entry that still arrives,
rather than answering `400`. That is deliberate: it lets the two ends of a peering be upgraded in
either order without the peering going dark mid-flight while one side still sends a field the other
has stopped reading.

### The peering id is a local label

`[[peers]].id` names the peering **relation**, and since ADR 0060 nothing puts it on the wire. Role
is decided by the claim, which names a channel, which names at most one `[[peer_channels]]` row
(`PeerChannelDuplicate` refuses a second), which names exactly one peering — so the connector
resolves the relation without any help from a name (`peer-carriage-spec.md` §1.2).

The two operators' files therefore do **not** have to carry the same literal string. One name for
one relation is easier to read across two configs, and the peered topologies under
[`local/`](../../local/README.md) do it that way, but nothing checks it and nothing breaks if they
differ.

```toml
# apex/connector.toml                # store/connector.toml
[[peers]]                            [[peers]]
id = "apex-store"                    id = "apex-store"     # by convention, not by rule
endpoint = "wss://store…/ilp/btp"    # no endpoint: the apex dials in
```

What must agree is the **channel**. Each side's `[[peer_channels]]` row has to describe the same
on-chain channel from its own point of view — the same `channel_id` (or `channel_account`), and a
`counterparty_key` that is the _other_ participant's. Get that wrong and the failure is loud or
silent depending on which half; see `peer_auth_refused` below.

### `peer_allow_plaintext_endpoints` — loopback and tests only

```toml
peer_allow_plaintext_endpoints = false   # the default, and the only production value
```

One top-level switch, default `false`. While it is off — which is every config that does not
mention it — `ws://` and `http://` are a hard `PeerEndpointScheme` load error, exactly as they have
always been.

Turned on, `ws://` resolves onto the **BTP** carriage and `http://` onto the **ILP-over-HTTP** one:
it widens which schemes resolve, never what they resolve to, and no other behaviour changes. It
exists so a laptop-runnable end-to-end test can point one connector at another's loopback socket
with no TLS terminator in between, and everything that sets it is of that shape: the config pairs
`crates/connector-bin/tests/two_connectors_peer.rs` and `connector-cli`'s own fixtures write at test
time, and the peered topologies under [`local/`](../../local/README.md), whose peerings dial each
other by container name over a private compose network. Every one of them is disposable by
construction, which is the only setting in which this switch is defensible.

**Never set it on a deployed node.** A peering carries every signed balance proof on it — the
claims that authenticate it and move its value; in the clear, they are readable by anything on the
path. A node that does set it logs a
`WARN` naming every plaintext peering at startup, so a box that acquired one by accident says so on
every restart. There is deliberately **no per-peer form** of this switch — a per-peer field reads as
an ordinary property of that peering and gets copied into production one line at a time.

`deploy/connector-rust/connector.toml` carries the same block, commented, with every field
annotated.

### Role is decided by a verified claim

An interaction is a peer **if and only if both** of
[`peer-carriage-spec.md`](../protocol/peer-carriage-spec.md) §1.2's requirements hold:

- **P2 — a channel binding.** The frame's claim names a `channel_id` that one of a peer's
  `[[peer_channels]]` rows configures.
- **P3 — a verified signature.** That claim's signature verifies against the **counterparty key
  that row configures** — never against anything the claim declares about itself.

If either fails, for any reason, the interaction is an ordinary **client** — there is no degraded
peer and no fallthrough. Not the port, not the source address, not the carriage, not the TLS name,
and no bearer string: only the claim (§1.3, and
[ADR 0060](../adr/0060-a-claim-proves-a-peering-and-the-shared-secret-is-deleted.md)).

Three consequences worth writing down:

- **A peering with no channel binding can never be a peering.** That is why `[[peer_channels]]` is
  required rather than optional (`PeerChannelUnbound`); its absence is what left ADR 0024's
  peer-claim verification wired to nothing.
- **Role attaches to the packet, not to the session.** A BTP session's role is whatever its current
  frame proves. A peer PREPARE carrying no covering claim is not admitted as a peer at all — it
  gets the same 402 greeting the client edge gives (ADR 0031, ADR 0042), so there is no claimless
  peer frame left for anything else to take a role from.
- **A websocket that has not yet sent a packet is a client session**, which the client edge already
  serves to anyone. There is nothing extra admitted at the upgrade, and nothing to firewall.

### When a peer does not peer: `peer_auth_refused`

A connector never refuses an interaction for failing to prove a peering — refusing would tell
whoever asked which peer channels this node has configured. It admits the interaction as an
ordinary client instead, silently, on the wire.

So the only place a failed peering shows up is an operator event named **`peer_auth_refused`**,
carrying the configured peer id and which of the two requirements went unmet:

| Field    | Meaning                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `peerId` | the `[[peers]]` id the named channel is bound to — config's own string, never anything the caller sent                                   |
| `unmet`  | `P2` — this node holds no record of that channel to verify against; `P3` — the signature did not recover to the row's `counterparty_key` |

The two are deliberately **not** one bucket, because they have different fixes. **P2**
(`UnknownChannel`) means config binds a channel the claim book has no record of: config and chain
disagree, which is this node's own wiring rather than the caller's, and it is exactly the shape
that presents as a peering that never peers. **P3** (`SignatureInvalid`) means the record exists
and the claim was signed by the wrong key — a key rotated on one side only, a stale
`counterparty_key`, or somebody else's claim entirely. The shared secret this replaced gave one
message for both.

The event is rate-limited to one per peer id and requirement per minute, and each one reports how
many were suppressed since the last — a peering retrying every second stays one line a minute, and
still says it is still failing.

**If a peering will not establish, look for this event first.** Without it the symptom is "peering
configured, nothing peers, no error anywhere", which is exactly what happened on devnet before
role-by-authentication existed: an anonymous session was admitted as a quasi-peer and nothing
anywhere said so.

One case is deliberately silent: a claim on a channel **no `[[peer_channels]]` row binds**. Every
ordinary client covers every packet with a claim of its own, on a `[[client_channels]]` channel, so
emitting there would fire `peer_auth_refused` on essentially every client packet — both noise and a
log-volume lever any anonymous caller could pull. The trap that falls out of it is worth memorising
before you debug a peering: **a peer paying from a channel this node's config never bound presents
as an ordinary client with nothing logged, while a peering whose bound channel fails to verify is
loud.** If the event you expect is missing entirely, check the `channel_id` (or `channel_account`)
on both sides before anything else — and check that this node's `[[peer_channels]]` row exists at
all, because a peering configured only on the far side is the same silence.

### Watermark namespaces are disjoint

A channel id in `[[peer_channels]]` must not also appear in `[[client_channels]]`. Peer and client
claim watermarks are separate records; one channel in both namespaces would let the same claim be
counted as credit twice. Config load refuses the overlap so the two can never describe the same
money.

`[[peer_channels]]` also requires `state_dir`, for the same reason `[[client_channels]]` does: a
watermark held only in memory is not a replay defence.

## The load-time errors

Every one of these stops the node before it serves anything (ADR 0009), and every message names
this document.

| Error                                           | What it means                                                                                       | Fix                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `PeerUndialable`                                | `peer_expose = "neither"` and a peer has no `endpoint` — nothing dials, nothing accepts             | give the peer an endpoint, or expose a carriage               |
| `PeerEndpointScheme`                            | an `endpoint` whose scheme selects no carriage (`ws://`, `http://`, `tcp://`, …)                    | use `wss://` for BTP or `https://` for ILP-over-HTTP          |
| `PeerCredentialRemoved`                         | a `[[peers]]` entry still setting `credential` (ADR 0060, issue #1157)                              | delete the subtable; a claim proves the peering now           |
| `PeerChannelUnbound`                            | a `[[peers]]` entry with no `[[peer_channels]]` row                                                 | add the channel binding, or remove the peering                |
| `PeerChannelOrphaned`                           | a `[[peer_channels]]` row naming a `peer_id` no `[[peers]]` entry configures                        | fix the `peer_id` typo, or add the peer                       |
| `PeerChannelDuplicate`                          | one channel id on two `[[peer_channels]]` rows — the claim would resolve to two peerings            | one channel, one row: delete the duplicate                    |
| `ChannelInBothNamespaces`                       | one channel id in both `[[peer_channels]]` and `[[client_channels]]`                                | keep the namespaces disjoint — pick one                       |
| `PeerRouteUndeliverable`                        | a route whose next hop is a peer this node can never originate to                                   | give the peer an endpoint, or include `btp` in `peer_expose`  |
| `DuplicatePeerId`                               | two `[[peers]]` entries with the same `id`                                                          | rename one                                                    |
| `PeerAddrRemoved`                               | a `[[peers]]` entry still setting `addr`                                                            | replace it with `endpoint`                                    |
| `PeerWireAddrRemoved`                           | a config still setting `peer_wire_addr`                                                             | delete the line and set `peer_expose` instead                 |
| `PeerCeilingRemoved`                            | a `[[peers]]` entry still setting `ceiling` (ADR 0033, issue #882)                                  | delete the line; no replacement is needed                     |
| `PeerFlushIntervalRemoved`                      | a `[[peers]]` entry still setting `flush_interval_ms` (ADR 0033, issue #882)                        | delete the line; no replacement is needed                     |
| `PeerChannelProgramIdRemoved`                   | a Solana `[[peer_channels]]` row still setting `program_id` (issue #1128)                           | delete the line; the value lives in `[settlement.solana]`     |
| `PeerChannelWithoutSolanaSettlement`            | a Solana `[[peer_channels]]` row on a node with no `[settlement.solana]` (issue #1128)              | add the table, or drop the row and peer on a chain you settle |
| `PeerChannelWithoutEvmSettlement`               | an EVM `[[peer_channels]]` row on a node with no `[settlement.evm]` (issue #1138)                   | add the table, or drop the row and peer on a chain you settle |
| `ClientChannelWithoutEvmSettlement`             | an EVM `[[client_channels]]` row on a node with no `[settlement.evm]` (issue #1138)                 | add the table, or drop the row                                |
| `ClientChannelWithoutSolanaSettlement`          | a Solana `[[client_channels]]` row on a node with no `[settlement.solana]` (issue #1138)            | add the table, or drop the row                                |
| `ClientChannelSolanaSettlementProgramIdInvalid` | a Solana `[[client_channels]]` row whose `[settlement.solana] program_id` is not base58 of 32 bytes | fix `[settlement.solana] program_id`                          |
| `PeerChannelSolanaSettlementProgramIdInvalid`   | a Solana row whose `[settlement.solana] program_id` is not base58 of 32 bytes                       | fix `[settlement.solana] program_id`                          |
| `PeerChannelInvalidSolanaAccount`               | a Solana `[[peer_channels]]` row's account/key is not base58 of a 32-byte value                     | fix the base58 value                                          |

`AcceptOnlyPeerWithoutCeiling` no longer exists: it required an accept-only peering to carry an
explicit `ceiling`, and both the requirement and the field are retired together (ADR 0033).

Two more guard the same shape: `InvalidPeerEndpoint` (an `endpoint` that is not a URL at all — the
old `host:port` spelling lands here) and `InvalidPeerExposure` (a `peer_expose` value that is not
one of the four).

## Migrating a running box

1. Delete `peer_wire_addr`. Decide what this node should expose and write `peer_expose`.
2. Replace each `[[peers]].addr` with an `endpoint` URL, or delete it for an accept-only peering.
   Delete any `ceiling`/`flush_interval_ms` lines too — both are retired (ADR 0033) and setting
   either is now a named load-time error, not a default.
3. Delete any `credential` subtable, and the `*.secret` file it named. There is nothing to share
   with the counterparty out of band any more (ADR 0060); a `[[peers]]` entry that still sets one
   is a named load-time error.
4. Add a `[[peer_channels]]` row per peering, and make sure `state_dir` is set and mounted.
5. Check that no channel id appears in both `[[peer_channels]]` and `[[client_channels]]`.

Start the node. If it refuses, the message names the field and points back here.
