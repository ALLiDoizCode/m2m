# Peer transport bring-up

The config surface for peering, and what changed when the raw-TCP peer wire was deleted.

This is the document every peer-related config error names. If a connector refused to start and
sent you here, the section that matches your error message is below.

- **Decision:** [ADR 0027](../adr/0027-connectors-peer-over-btp-and-the-raw-tcp-peer-wire-is-deleted.md)
  — connectors peer over BTP or ILP-over-HTTP; the raw-TCP peer wire is deleted.
- **Normative detail:** [`docs/protocol/peer-carriage-spec.md`](../protocol/peer-carriage-spec.md)
  — the role rule, the two carriages, and §11's config requirements.
- **Scope of this document:** the configuration surface only (issue #677). The carriages that
  actually dial and accept are issue #676; until they land, a peering validated by this surface is
  a peering nothing traverses, and a packet routed to one is answered `T01`.

## What was removed

| Removed field    | Replaced by                                                                        |
| ---------------- | ---------------------------------------------------------------------------------- |
| `peer_wire_addr` | `peer_expose` — peer carriages ride this node's own listeners, not a second socket |
| `[[peers]].addr` | `[[peers]].endpoint` — a `wss://` or `https://` URL, not a `SocketAddr`            |

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
  balance proofs — `ws://` and `http://` are refused too.
- **No `endpoint` at all** means accept-only: this node never dials that peer, and the peer dials
  in.

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
credential = { secret = "…" }
ceiling = 1000000
flush_interval_ms = 5000
# claim_ack_timeout_ms and peer_answer_timeout_ms default to 30000 each

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

`deploy/connector-rust/connector.toml` carries the same block, commented, with every field
annotated.

### Role is decided by the credential

An interaction is a peer **only if** it presents a credential naming a configured peer id whose
secret matches, **and** that peer has at least one `[[peer_channels]]` row. If either fails, for
any reason, the interaction is an ordinary **client** — there is no degraded peer and no
fallthrough. Not the port, not the source address, not the carriage, not the TLS name: only the
credential.

Two consequences worth writing down:

- **An empty secret matches nothing**, including an empty presented secret. `secret = ""` is
  refused at load rather than becoming a peering anybody can claim.
- **A peering with no channel binding can never be a peering.** That is why `[[peer_channels]]` is
  required rather than optional; its absence is what left ADR 0024's peer-claim verification wired
  to nothing.

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

| Error                          | What it means                                                                           | Fix                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `PeerUndialable`               | `peer_expose = "neither"` and a peer has no `endpoint` — nothing dials, nothing accepts | give the peer an endpoint, or expose a carriage              |
| `PeerEndpointScheme`           | an `endpoint` whose scheme selects no carriage (`ws://`, `http://`, `tcp://`, …)        | use `wss://` for BTP or `https://` for ILP-over-HTTP         |
| `PeerCredentialMissing`        | a `[[peers]]` entry with no credential, or an empty secret                              | add `credential = { secret = "…" }` with a real secret       |
| `PeerChannelUnbound`           | a `[[peers]]` entry with no `[[peer_channels]]` row                                     | add the channel binding, or remove the peering               |
| `PeerChannelOrphaned`          | a `[[peer_channels]]` row naming a `peer_id` no `[[peers]]` entry configures            | fix the `peer_id` typo, or add the peer                      |
| `ChannelInBothNamespaces`      | one channel id in both `[[peer_channels]]` and `[[client_channels]]`                    | keep the namespaces disjoint — pick one                      |
| `AcceptOnlyPeerWithoutCeiling` | a peering this node cannot dial and that carries no explicit `ceiling`                  | set an explicit `ceiling`; it is that peering's only bound   |
| `PeerRouteUndeliverable`       | a route whose next hop is a peer this node can never originate to                       | give the peer an endpoint, or include `btp` in `peer_expose` |
| `DuplicatePeerId`              | two `[[peers]]` entries with the same `id`                                              | rename one                                                   |
| `PeerAddrRemoved`              | a `[[peers]]` entry still setting `addr`                                                | replace it with `endpoint`                                   |
| `PeerWireAddrRemoved`          | a config still setting `peer_wire_addr`                                                 | delete the line and set `peer_expose` instead                |

Two more guard the same shape: `InvalidPeerEndpoint` (an `endpoint` that is not a URL at all — the
old `host:port` spelling lands here) and `InvalidPeerExposure` (a `peer_expose` value that is not
one of the four).

## Migrating a running box

1. Delete `peer_wire_addr`. Decide what this node should expose and write `peer_expose`.
2. Replace each `[[peers]].addr` with an `endpoint` URL, or delete it for an accept-only peering
   and give that peering an explicit `ceiling`.
3. Add a `credential` to every peering, and share the secret with the counterparty out of band.
4. Add a `[[peer_channels]]` row per peering, and make sure `state_dir` is set and mounted.
5. Check that no channel id appears in both `[[peer_channels]]` and `[[client_channels]]`.

Start the node. If it refuses, the message names the field and points back here.
