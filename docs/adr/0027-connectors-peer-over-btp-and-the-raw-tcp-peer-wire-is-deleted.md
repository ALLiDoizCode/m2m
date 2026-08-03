# Connectors peer over BTP; the raw-TCP peer wire is deleted

A connector speaks to another connector over BTP (RFC-0023) on a `wss://` URL — the same frame
grammar `crates/connector-client-edge/src/btp.rs` already implements, symmetric since issue #697.
The raw-TCP peer wire of [ADR 0003](0003-clean-room-peer-wire-versioned-client-edge.md) —
`crates/connector-runtime/src/peer_wire.rs`, `crates/connector-runtime/src/network_peer_transport.rs`,
`docs/protocol/peer-wire-spec.md` §1–§2 — is **deleted, first, before the replacement is built**,
because it has never carried a production packet and there is therefore nothing to migrate off.

ILP-over-HTTP is considered and deliberately not adopted as a peer transport. There is exactly one
peer transport. The reasoning is in "Why not ILP-over-HTTP", below.

## Bookkeeping: the duplicate ADR 0026

Two documents were numbered 0026, and this ADR exists partly to end that.

| Number                         | Title                                                           | State                                                                                                 |
| ------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **0026**                       | _Client BTP rides the client edge; peers stay on the peer wire_ | **Merged** (PR #680, `37440320`; amended by #702, #703, #708). Keeps its number.                      |
| ~~0026~~ → **this ADR (0027)** | _Connectors peer over BTP…_                                     | Was an unmerged draft on `adr/btp-peer-transport` (PR #675, `370d53a3`). Renumbered to **0027** here. |

The merged 0026 keeps 0026. It is referenced by `docs/protocol/client-edge-spec.md` §1.9, by
`crates/connector-client-edge/src/btp.rs`'s module header, and by four merged PRs' commit messages;
renumbering a merged, cross-referenced ADR to fix a collision caused by an _unmerged_ draft would
trade one broken reference for a dozen. The draft takes the next free number instead. **There is no
third document.** Any reference to "ADR 0026, connectors peer over BTP" means this file.

**What this supersedes:**

- **ADR 0003's peer-wire half** — the clean-room raw-TCP wire, and the sentence "BTP is not worth
  preserving as a constraint on the design". ADR 0003's _client-edge_ half (the edge is versioned;
  edge complexity is paid twice) stands untouched and is if anything reinforced.
- **ADR 0026's peer half** — "Peers never use it: connector↔connector traffic stays on the raw-TCP
  peer wire". Everything 0026 says about the _client_ edge stands. What it loses is its
  proof-by-construction that every BTP session is a client session; the replacement is role-by-auth,
  specified below, and that swap is the sharpest cost of this decision.
- **ADR 0022's consequence** that the peer wire is "private, plaintext and unauthenticated on its own
  segment". The peer transport is now public-capable, TLS-encrypted and authenticated. ADR 0022's
  actual decision — a connector answers, it does not announce — is unaffected.
- **`docs/protocol/peer-wire-spec.md` §1–§2** (framing and packet structure). §3–§6 — claim exchange,
  fees and minimum delivery, reject codes and accumulated cost, consistency — survive as the
  _semantics_ of the sub-protocol payloads, and are re-hosted rather than rewritten.

## Context: what two audits established on 2026-08-03

The findings are at `toon-meta/prototypes/peer-wire-audit/` (REPO-FINDINGS.md, DEPLOYED-FINDINGS.md).
Four facts changed this decision, and three of them falsify premises the earlier draft argued from.

**1. The peer wire is the only connector↔connector transport in the code, and it has never carried a
packet.** `NetworkPeerTransport` is the one production `PeerTransport` implementation, constructed
unconditionally (`crates/connector-cli/src/runtime.rs`). And the live apex `connector-rust.toml` has
**no `[[peers]]` table at all**; `peer-claims.log` on the Rust state volume is **0 bytes**. Both
statements are true at once: it is the only wire, and it is a dead wire.

**2. Production inter-connector traffic is BTP over `wss://…:443`, right now, and it works.** The
devnet's one live peering is store-box → apex, both ends the _TypeScript_ connector, carrying real
paid packets on a 5-minute cadence with claims verified on arrival. We are not proposing an unproven
transport; we are proposing to reimplement in Rust a link that is carrying money today.

**3. ADR 0003's load-bearing premise has expired.** Its second sentence is the whole case: _"Both
ends of the peer wire are operator-controlled: our own connectors, on our own boxes and in our own
images."_ An open market — `toon-meta#262` (agents selling factory work), `toon-meta#265`
(mesh-compute earning) — is precisely what falsifies it. The moment a third party runs a connector,
"both ends are ours" is false, and the design freedom was bought against an assumption that has since
expired.

It expires in a specific, structural way, not a philosophical one. **Raw-TCP peering requires inbound
reachability.** `toon-meta#262` opens on exactly that problem — an agent on a laptop behind NAT
cannot be dialled — and #697 solved it _for clients_ by adopting RFC-0023's symmetric grammar. The
identical problem exists one layer up, and there the answer today is "you cannot peer." A small
operator can be a client of the network but never a node in it: a ceiling on decentralization inside
a project whose pitch is sovereignty. RFC-0023's own motivating sentence is about this case and no
other:

> When two Interledger **connectors** send ILPv4 packets over HTTP POST, they each need to act as an
> HTTP server at times. If one of the connectors runs behind a firewall, this may be impossible.

We adopted BTP for the case it was not written for (clients) and built a bespoke wire for the case it
was.

**4. #702 already shipped most of the protocol work.** connector#697 is closed: `btp.rs` now
encodes/decodes RFC-0023's TRANSFER, answers an inbound one, and can **originate** a MESSAGE or
TRANSFER of its own behind a session-scoped requestId allocator satisfying the RFC's uniqueness
property (`docs/protocol/client-edge-spec.md` §1.9). Peering is exactly "both sides originate
requests on one connection". The remaining peer work is therefore mostly _configuration, role and
claim wiring_ — not a protocol implementation from scratch. This is the cheapest moment this decision
will ever be available at, which is why #711 sequenced it after #697.

## Decision

**Connector↔connector links are BTP sessions over `wss://` URLs.** ILPv4 PREPARE/FULFILL/REJECT ride
BTP MESSAGE/RESPONSE frames with real requestId correlation; the session is authenticated by BTP's
`auth` sub-protocol; TLS is terminated by the ordinary reverse proxy each box already runs.
`[[peers]]` addresses become URLs, which is what closes #623.

**One codec, two roles.** The peer transport uses the _same_ BTP codec as the client edge, extracted
into a transport-neutral module. It does not fork it and does not invent a second websocket stack.

**Role is decided by authentication, never by transport or by port.** A session is a peer session if,
and only if, it presented a credential configured in `[[peers]]` _and_ has a `[[peer_channels]]`
entry binding it to a channel identity. A session that presented neither, or only one, is a client
session — full stop, with no fallthrough. This is the invariant the TypeScript fleet's `toon-sandbox`
no-auth admission violated (`docs/btp-client-ingress-findings.md`: `btp_auth … success:true
mode:"no-auth"` admitted an anonymous client as a quasi-peer), and it is a named stop-ship regression
test, not a code comment. The escape hatch, if review or audit finds any path by which an
unauthenticated session reaches peer handling in a shared listener, is a **dedicated peer listener
with mandatory auth — still BTP**, never a return to raw TCP.

### How each peer-wire frame is carried

This is the load-bearing part of the decision. PREPARE/FULFILL/REJECT are obvious. FLUSH and
CLAIM_ACK are not, and they are where a careless mapping would lose ADR 0024's semantics.

| Peer-wire frame              | BTP carriage                                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x01` PREPARE               | **MESSAGE**, ILP PREPARE in `ilpPacket`. Piggybacked claim (§3.2) rides as a `payment-channel-claim` protocolData entry — the same entry name and raw-UTF-8-JSON encoding the client edge already uses (client-edge-spec §1.9 step 2), not `WireClaim`'s length-prefixed binary. |
| `0x02` FULFILL               | **RESPONSE** under the MESSAGE's `requestId`, ILP FULFILL in `ilpPacket`.                                                                                                                                                                                                        |
| `0x03` REJECT                | **RESPONSE** under the MESSAGE's `requestId`, ILP REJECT in `ilpPacket`.                                                                                                                                                                                                         |
| `0x04` **FLUSH**             | **TRANSFER** (type 7): `amount` = the claim's new cumulative, the claim itself as a `payment-channel-claim` protocolData entry, no `ilpPacket`.                                                                                                                                  |
| `0x05` **CLAIM_ACK**         | A **`claim-ack` protocolData entry on the RESPONSE** that already answers the frame the claim arrived on — the FULFILL/REJECT RESPONSE for a piggybacked claim, the TRANSFER's RESPONSE for a FLUSH.                                                                             |
| `minimumDelivery` (ADR 0010) | `toon-minimum-delivery` protocolData entry on the MESSAGE, decimal-uint64 UTF-8.                                                                                                                                                                                                 |
| `accumulatedCost` (ADR 0011) | `toon-accumulated-cost` protocolData entry on the REJECT's RESPONSE — **already specified and implemented** on the client edge (§1.9 step 2), reused verbatim.                                                                                                                   |

**FLUSH is a TRANSFER, and that is not an approximation.** FLUSH exists because a payer that
fulfilled a peer's last packet of the day would otherwise leave that peer's exposure unclaimed
indefinitely (peer-wire-spec §3.3): it is an unsolicited, payer-originated frame carrying settlement
value and its proof, with no ILP packet attached. That is a verbatim description of what RFC-0023
defines TRANSFER for — `amount` plus ledger-specific proof in `protocolData`, no ILP packet
(client-edge-spec §1.9's `transferBody`). Two things follow. First, **`flushIntervalMs` keeps its
exact meaning**: it is still the real bound on trailing exposure, still configured per peering
relation, and nothing about §3.3 changes except which bytes carry it. Second, **FLUSH is the frame
that makes ILP-over-HTTP unworkable as a peer transport** — see below — because it must be originated
by whichever side just fulfilled, including a side nobody can dial.

**CLAIM_ACK becomes a field on a response RFC-0023 already requires, and this is strictly better than
the frame it replaces.** Three properties are preserved and two defects are fixed:

- _Preserved — the claim verdict is independent of the packet verdict._ Peer-wire §3.4 is explicit
  that a `rejected` CLAIM_ACK does not reject the PREPARE the claim was piggybacked on. On BTP the
  RESPONSE carries both verdicts in different places: `ilpPacket` says what happened to the packet,
  the `claim-ack` protocolData entry says what happened to the claim. One frame, two independent
  answers, no coupling introduced.
- _Preserved — the reason taxonomy._ The entry is JSON `{"result":"accepted"}` or
  `{"result":"rejected","reason":"…"}` with §3.4's four reasons unchanged: `signature_invalid`,
  `nonce_not_advancing`, `amount_not_advancing`, `unknown_channel`. A rejected claim is a well-formed
  answer, **not** a BTP ERROR frame; ERROR stays reserved for undecodable frames, as on the client
  edge.
- _Preserved — the consequence._ A peer whose most recent claim was rejected still holds unclaimed
  exposure, and a connector SHOULD still stop forwarding to it until a valid claim restores the
  watermark (§3.4, §5.3). That is policy above the transport and is untouched.
- **Fixed — correlation.** Peer-wire CLAIM_ACK carries an all-zero `correlationId` and "answers the
  claim most recently received", a positional rule that is ambiguous the moment two claims are in
  flight. BTP's `requestId` names exactly which frame's claim is being acknowledged.
- **Fixed — liveness.** The peer wire has no timeout on a CLAIM_ACK that never arrives: a pending
  claim can hang forever. RFC-0023 requires a responder to answer every request, so the ack becomes
  structurally mandatory and inherits the session's per-request timeout.

The one honest loss is encoding-level: on the peer wire CLAIM_ACK was a distinct frame type, so "the
peer sent no ack" was inexpressible; as a protocolData entry it is omissible, and "peer omitted the
entry" becomes a new error class the spec must define a behaviour for. It is defined as: a missing
`claim-ack` entry on a RESPONSE answering a claim-bearing frame is treated as **not acknowledged** —
the claim stays pending and the flush timer keeps running — never as accepted.

Every entry above gets canonical vectors per [ADR 0021](0021-vectors-are-normative-prose-is-not.md).
[ADR 0024](0024-peer-wire-claims-sign-the-eip-712-balance-proof.md) is untouched in substance: peer
claims still sign the EIP-712 `BalanceProof` digest, byte for byte. Only the carriage moves, and it
moves toward the encoding `connector-domain/src/client_claim.rs` already uses.

**Discovery needs no schema change.** `kind:10032`'s `btpEndpoint` and `genesis-peers.json` have
always required a `wss://` URL and never carried a raw-TCP endpoint — they describe a fleet that
peers over BTP. This decision makes that description true of Rust connectors instead of only of the
retired TypeScript ones.

## Why not ILP-over-HTTP

`POST /ilp` is a real, shipped, proven carriage and reusing it would cost less code than anything else
on the table. It is still the wrong choice for peering, for five reasons in descending order of
weight.

1. **It cannot reach a peer behind NAT, which is the whole point.** ILP-over-HTTP requires both ends
   to be dialable HTTP servers. That is RFC-0023's own stated motivation for existing, quoted above.
   Choosing HTTP would leave open-market operators exactly where they are now — clients, never nodes
   — and would make this ADR pointless.
2. **FLUSH has no carriage.** A payer-originated, unsolicited settlement frame requires the payer to
   be able to _originate_ to the payee. Over HTTP, a payer that cannot be dialled can still POST —
   but a payer that can only _receive_ cannot flush at all, and the exposure bound `flushIntervalMs`
   provides silently becomes unbounded in one direction. Every workaround (payee polls, payee
   long-polls, a second reverse HTTP connection) is a worse websocket.
3. **Claim nonces race themselves.** `docs/protocol/client-edge-spec.md` §1.9 exists because parallel
   HTTP writes carrying nonces _n_ and _n+1_ reach the watermark lock in either order and the loser
   is refused `NonceNotAdvancing` for nothing. Peer claims carry the identical strictly-advancing
   nonce rule (peer-wire-spec §3.2), so the identical race exists on a peer link, under heavier
   concurrency. One ordered session per peering relation removes it by construction — the same fix,
   for the same reason, on the same codec.
4. **A peering is bidirectional; HTTP is not.** Each side is the payer for the traffic it originates,
   so each side must be able to originate MESSAGEs and TRANSFERs and to authenticate. On BTP that is
   one authenticated socket. Over HTTP it is two independent client/server pairs per relation, with
   two TLS surfaces, two auth stories and two sets of credentials.
5. **The proven reference is BTP.** The live devnet peering is BTP-over-443, in TypeScript, moving
   money as this is written. Choosing HTTP would mean re-deriving from first principles a shape we
   already operate.

**What HTTP does keep, honestly.** A counterparty that _is_ publicly dialable and wants no long-lived
socket can already push paid packets at us today over `POST /ilp` — as a **client**, with claim
carriage in its own direction, with no new code and no peering configuration. That degenerate mode is
not removed and not deprecated; it is simply not peering, because it gives no reverse origination, no
FLUSH from our side, and no ordered claim sequence. Naming it a second peer transport would double
the spec, vector and test surface to describe a strictly weaker subset of what already exists.
Per-route transport policy (#701 / PR #704) remains the mechanism for saying which carriages a
_terminated_ route accepts, and is orthogonal to this decision.

## What is given up

- **The client-by-construction session classification.** ADR 0026's strongest property — "no client
  middleware can leak onto peer traffic; no peer trust can leak onto client sessions", true because
  peers spoke a different protocol on a different listener — becomes role-by-auth, which is code and
  can therefore have bugs. Mitigated by requiring _two_ configured facts for peer role, by the named
  `toon-sandbox` regression test, and by the dedicated-listener fallback. This is the real price.
- **Design freedom.** The fleet wire is again constrained by an external spec and by a codec shared
  with a versioned client edge — the exact coupling ADR 0003 split apart. The escape, if edge
  versioning starts dictating peer changes, is a fleet-only BTP sub-protocol version, not raw TCP.
- **Framing simplicity and plaintext debuggability.** 102 lines of codec with no HTTP/WS dependency
  become a websocket and TLS stack in the value path, and `tcpdump` on a peer link stops being
  readable.
- **Structurally mandatory fields become spec-mandatory entries.** `minimumDelivery`,
  `accumulatedCost` and the claim ack were fields of a frame; as protocolData entries they are
  optional by encoding. Each needs a defined "entry absent" behaviour (given above for `claim-ack`)
  and canonical vectors.
- **Single-in-flight simplicity.** `NetworkPeerTransport`'s one-request-per-peer mutex bounded
  concurrency by construction. BTP multiplexing needs a demux table, per-request timeouts and a
  window — capability gained, invariants to enforce. The client edge's `btp_session_window` (#688) is
  the existing pattern to copy rather than re-derive.

What is **not** given up, and was assumed to be: a flag day. ADR 0003 accepted "a coordinated cutover
across `connector`, `relay`, `store`, `swap`, `town`, `mill` and both devnet boxes" as the price of
peer-wire changes. Since no link has ever run on the peer wire, that price is not paid here.

## Sequencing: delete first, then build

This is where this ADR differs most from the draft it replaces. PR #675 planned four phases —
dual-stack, config, cutover with rollback, removal — a shape appropriate to draining live traffic off
a wire. **There is no live traffic.** No box configures `[[peers]]`, no claim has ever been written to
`peer-claims.log`, and discovery never advertised a raw-TCP endpoint. So:

1. **Delete the raw-TCP transport now.** `peer_wire.rs`, the raw-TCP halves of
   `network_peer_transport.rs`, `peer_wire_addr`, `[[peers]].addr` as a `SocketAddr`, and
   `peer-wire-spec.md` §1–§2. The `PeerTransport` port (`peer_transport.rs`) and
   `InProcessPeerTransport` **stay** — the port is the seam this whole plan rests on, and everything
   above it (`Connector::forward_via_peer_route`, `ClaimBook`, fees, routing) is untouched and keeps
   its in-process tests. This is a pure subtraction that cannot break production, and it removes the
   "two pipelines around one journal" duplication before the second pipeline is written rather than
   after.
2. **Specify** the sub-protocol entries above and role-by-auth, with vectors (ADR 0021).
3. **Config**: `[[peers]]` with a `wss://` endpoint and a credential; new `[[peer_channels]]` binding
   a peer to its channel id, counterparty key and EIP-712 domain — the surface whose absence is the
   third gap in #620 (ADR 0024's claim mechanism is implemented and inert because nothing can
   configure it). No `transport` selector: there is one transport.
4. **Charge peer-forwarded routes** (#620). A peer-forwarded route that is neither priced nor charged
   is a free-write path on `g.toon`, and claims spent for free cannot be recharged. This gates any
   deployment on any transport and is not a peer-transport ticket at all.
5. **Implement** the BTP peer transport behind the existing port, on the extracted codec.
6. **Bring up** the first real Rust peer link on devnet — apex↔store, over `wss` through the store
   box's existing nginx. Rollback is one config edit back to today's HTTPS-terminated `handler_url`,
   which costs nothing because that is what production does today anyway.
7. **Retire the TypeScript connectors**, gated on (6) holding. Not before: the two live TS connectors
   are the default public edge on the apex, the only connector on the store box, and both ends of the
   only inter-node link on the devnet.

## Revisit conditions

- Role-by-auth fails review or audit — any path is found by which an unauthenticated session reaches
  peer handling. Stop-ship for the bring-up; the answer is a dedicated authenticated BTP listener,
  not raw TCP.
- The `claim-ack` entry cannot express ADR 0024's semantics losslessly in practice — in particular if
  the independence of the claim verdict from the packet verdict cannot be maintained on a shared
  RESPONSE.
- A measured, budget-breaking latency or throughput regression on a peer link attributable to
  websocket/TLS framing. Note the client-edge measurement already on record
  (`toon-meta/prototypes/mesh-shard-over-ilp/RESULTS.md`): one `fdatasync` is 72% of a paid packet's
  p50 and 99% of its p99, while the entire crypto layer costs 0.23 ms. Framing is not where this
  budget goes, and any claim that it is needs numbers beside that file before it is acted on.
- Sharing the codec with the client edge forces edge versioning constraints onto peer changes in
  practice. The escape is a fleet-only sub-protocol version.
