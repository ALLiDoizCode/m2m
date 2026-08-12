# Connectors peer over BTP or ILP-over-HTTP; the raw-TCP peer wire is deleted

**Scope:** protocol law — binds every implementation, not just this one. See the [ADR index](README.md).

> **The flush timer and the exposure ceiling this ADR reasons with throughout are retired** by
> [ADR 0033](0033-the-exposure-machinery-is-retired-not-restated.md) (issue #882), on top of
> [ADR 0031](0031-a-peer-prepare-arrives-with-its-covering-claim-or-it-is-greeted.md)'s retirement of
> the credit window itself. This ADR's own decision — the two carriages, role-by-auth, and the
> configuration-time asymmetry of a one-way-dialed HTTP peering — is untouched and still stands. What
> is now historical is every clause that treats `flushIntervalMs` or an explicit `ceiling` as live
> configuration, in particular the accept-only side's "MUST carry an explicit exposure ceiling"
> below: `AcceptOnlyPeerWithoutCeiling` no longer exists, and every peering, accept-only or not, is
> bounded instead by ADR 0031's covering-claim requirement.

A connector speaks to another connector over one of the two carriages it already serves clients on:
**BTP (RFC-0023) over `wss://`**, or **ILP-over-HTTP over `https://`**. Which of them a given
connector exposes, and which it dials for a given peer, is **operator policy**, not a protocol
constant — and a connector may expose both.

The raw-TCP peer wire of [ADR 0003](0003-clean-room-peer-wire-versioned-client-edge.md) —
`crates/connector-runtime/src/peer_wire.rs`, `crates/connector-runtime/src/network_peer_transport.rs`,
`docs/protocol/peer-wire-spec.md` §1–§2 — is **deleted, first, before the replacement is built**,
because it has never carried a production packet and there is therefore nothing to migrate off.

**One peer pipeline, two carriages.** This is not two peer implementations. It is the shape
[ADR 0026](0026-client-btp-rides-the-client-edge-peers-stay-on-the-peer-wire.md) already established
one layer down and proved in production, lifted to the peer side.

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
- **ADR 0026's peer _conclusion_ only** — "Peers never use it: connector↔connector traffic stays on
  the raw-TCP peer wire". Its **carriage architecture is not superseded; it is the precedent this ADR
  builds on** (see "One pipeline, two carriages"). What it does lose is its proof-by-construction
  that every BTP session is a client session; the replacement is role-by-auth, specified below, and
  that swap is the sharpest cost of this decision.
- **ADR 0022's consequence** that the peer wire is "private, plaintext and unauthenticated on its own
  segment". The peer transport is now public-capable, TLS-encrypted and authenticated. ADR 0022's
  actual decision — a connector answers, it does not announce — is unaffected.
- **`docs/protocol/peer-wire-spec.md` §1–§2** (framing and packet structure). §3–§6 — claim exchange,
  fees and minimum delivery, reject codes and accumulated cost, consistency — survive as the
  _semantics_ both carriages carry, and are re-hosted rather than rewritten.

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
requests on one connection". Combined with `POST /ilp`, which has carried paid packets since #520,
**both carriages already exist**; the remaining peer work is _configuration, role and claim wiring_,
not a protocol implementation from scratch. This is the cheapest moment this decision will ever be
available at, which is why #711 sequenced it after #697.

## Decision

### One pipeline, two carriages — the ADR 0026 precedent, applied one layer up

ADR 0026 already answered this exact question for clients, and its answer is the one to copy.
`POST /ilp` and `GET /ilp/btp` are mounted on the same router, therefore the same bind address, the
same `ClientClaimGate` instance, the same watermarks and the same journal: **"a second carriage for
the client edge's existing pipeline, not a second pipeline."** It went further and factored
`claim_rejection_reject` and the x402 terms builder specifically so the two carriages could not drift
from each other's refusal taxonomy — because when they did drift, it caused a devnet incident.

**The peer side inherits that discipline as a requirement, not an aspiration.** There is one peer
pipeline — one route lookup, one `ClaimBook`, one journal, one fee and ceiling policy, one refusal
taxonomy — and two carriages that differ only in how bytes are framed. A peer PREPARE that arrived
over HTTP must be indistinguishable downstream from one that arrived over BTP, in the same way a
client write already is. Any behaviour that exists on one peer carriage and not the other is a bug,
and shared vectors (below) are how that is enforced rather than hoped for.

This also settles the "what did ADR 0026 buy us" question honestly: its _conclusion_ about peers is
superseded, its _architecture_ is the foundation of this ADR.

### Transport is per-connector policy — `toon-meta#262` decision 11, extended to peers

This is not a new kind of decision. `toon-meta#262` decision 11 already established that transport is
per-connector policy rather than a protocol constant, with the general rule **persistent +
high-frequency → BTP; one-shot stranger + low-frequency → HTTP**, and #701 / PR #704 shipped it for
_terminated routes_ (`connector-config`'s per-route `transport` policy, which the client edge enforces
ahead of payment with a self-diagnosing `requiredTransport` field). This ADR extends the same rule to
_peerings_. The mechanism is deliberately the same shape so operators learn it once.

The recommendation that follows from that rule, which operators should treat as the default unless
they have a reason:

- **A standing fleet peering → BTP.** Persistent, high-frequency, ordered, and the only carriage that
  works behind NAT.
- **A dialable, low-frequency counterparty → HTTP is fine**, and cheaper to stand up: any reverse
  proxy, no long-lived socket, no reconnect logic.
- **Behind NAT → BTP, and you must dial.** There is no other option, and the consequence below is
  the first thing such an operator will hit.

### Expose and dial are separate axes

This is the part that needs stating precisely, because getting it wrong produces a peering that
silently never establishes.

- **Expose** = which peer carriages this connector opens a listener for: `btp`, `http`, both, or
  **neither**. `neither` is legal and meaningful: a connector behind NAT exposes nothing.
- **Dial** = for each configured peer, which carriage this connector reaches _it_ on. Determined by
  the scheme of that peer's configured `endpoint` (`wss://` → BTP, `https://` → HTTP). A peer with no
  `endpoint` is accept-only: we never dial it, it dials us.

**A peering requires an intersection**: at least one side must dial a carriage the other exposes.
Two operators who each expose only the carriage the other cannot dial simply cannot peer. Where this
is detectable at config load it **must be a named load-time error**, not a runtime mystery — in
particular, a connector that exposes nothing and configures a peer with no `endpoint` has declared a
peering that can never establish, and must fail at boot.

**The NAT case only works one way, and operators will hit this first.** An operator behind NAT
exposes nothing and must dial out, over BTP, which is RFC-0023's original motivation verbatim.
Therefore:

> **An HTTP-only peer cannot be reached by, and cannot reach, a NAT'd peer.** The NAT'd side can only
> dial (so it needs the other side to expose something), and it can only hold an inbound-capable
> session over a persistent socket (so that something must be BTP). An operator who exposes HTTP
> only has chosen to peer exclusively with dialable counterparties.

This is a real limit of the HTTP carriage, not a defect to fix later. It is why BTP is the
recommendation for anything resembling a fleet link.

### Role is decided by authentication, never by transport, port or carriage

A session or request is a **peer** interaction if, and only if, it presented a credential configured
in `[[peers]]` _and_ has a `[[peer_channels]]` entry binding it to a channel identity. Neither, or
only one → **client**, full stop, with no fallthrough. This applies identically on both carriages: an
authenticated `POST /ilp` from a configured peer is peer traffic; the same POST without the credential
is an ordinary client write.

This is the invariant the TypeScript fleet's `toon-sandbox` no-auth admission violated
(`docs/btp-client-ingress-findings.md`: `btp_auth … success:true mode:"no-auth"` admitted an anonymous
client as a quasi-peer), and it is a named stop-ship regression test on both carriages, not a code
comment. If review or audit finds any path by which an unauthenticated session reaches peer handling
in a shared listener, the escape hatch is a **dedicated peer listener with mandatory auth** — on
either carriage — never a return to raw TCP.

### Config schema

`crates/connector-config/src/peer.rs` is today `RawPeer { id, addr }` with `deny_unknown_fields` and
`addr` parsed as a `SocketAddr`, so a `wss://` or `https://` URL is a **hard config-load error right
now**. The schema change is part of this decision:

```toml
[peers]
expose = ["btp", "http"]        # which peer carriages this connector listens on; [] = dial-only (NAT)

[[peers.peer]]                   # exact table naming settled in the config ticket
id         = "store-box"
endpoint   = "wss://proxy.store.devnet.toonprotocol.dev"   # scheme selects the dialed carriage
credential = "…"                                            # role-by-auth; omit endpoint for accept-only

[[peer_channels]]                # NEW — the surface whose absence makes ADR 0024 inert (#620 gap 3)
peer_id           = "store-box"
channel_id        = "0x…"
counterparty_key  = "0x…"
chain_id          = 84532
token_network     = "0x…"
```

`deny_unknown_fields` stays. Removed fields (`peer_wire_addr`, a `SocketAddr`-shaped `addr`) must be
a hard, named error rather than a silent ignore — the devnet boxes run bind-mounted configs that lead
the repo copies, so a stale one has to fail at boot instead of quietly not peering.

### How each peer-wire frame is carried, on each carriage

This is the load-bearing part of the decision. PREPARE/FULFILL/REJECT are obvious on both. FLUSH and
CLAIM_ACK are not, and they are where a careless mapping loses ADR 0024's semantics — or, on HTTP,
loses an exposure bound.

| peer-wire frame              | BTP carriage (`wss://`)                                                                                              | ILP-over-HTTP carriage (`https://`)                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `0x01` PREPARE               | **MESSAGE**, ILP PREPARE in `ilpPacket`; claim as a `payment-channel-claim` protocolData entry (raw UTF-8 JSON)      | **POST** with the OER PREPARE as the body; claim in the `ILP-Payment-Channel-Claim` request header        |
| `0x02` FULFILL               | **RESPONSE** under the MESSAGE's `requestId`                                                                         | **200** with the OER FULFILL as the body                                                                  |
| `0x03` REJECT                | **RESPONSE** under the MESSAGE's `requestId`                                                                         | **200** with the OER REJECT as the body                                                                   |
| `0x04` **FLUSH**             | **TRANSFER** (type 7): `amount` = new cumulative, claim in `payment-channel-claim`, no `ilpPacket`                   | **POST with an empty ILP body** and the claim header — a standalone claim submission                      |
| `0x05` **CLAIM_ACK**         | a **`claim-ack` protocolData entry** on the RESPONSE that already answers the claim-bearing frame                    | a **`Toon-Claim-Ack` response header** on the response that already answers the claim-bearing request     |
| `minimumDelivery` (ADR 0010) | `toon-minimum-delivery` protocolData entry on the MESSAGE                                                            | `Toon-Minimum-Delivery` request header                                                                    |
| `accumulatedCost` (ADR 0011) | `toon-accumulated-cost` entry on the REJECT's RESPONSE — **already implemented** on the client edge, reused verbatim | the `Toon-Accumulated-Cost` response header — **already implemented** on the client edge, reused verbatim |

The header/protocolData mirroring is not invented here: `client-edge-spec.md` §1.9 already describes
each BTP protocolData entry as "the BTP analogue of the HTTP header" for exactly these fields. The
peer side keeps that correspondence so the two carriages cannot drift, and the vectors below pin it.

**Corrected: the HTTP claim header is `ILP-Payment-Channel-Claim`.** An earlier version of the table
above wrote it `Payment-Channel-Claim`, mirroring the BTP entry name. The deployed client edge sends
and parses `ilp-payment-channel-claim` (`crates/connector-client-edge/src/lib.rs`), and this ADR's
own "one codec, reused verbatim" rule settles which spelling wins: a new name would need a second
decoder on the HTTP path, which is exactly the drift the shared vectors exist to prevent.
`docs/protocol/peer-carriage-spec.md` §3 pins the deployed name. The table above now carries it,
because an ADR that names a header the wire does not use is a trap for whoever implements from it.

**FLUSH is a TRANSFER on BTP, and that is not an approximation.** FLUSH exists because a payer that
fulfilled a peer's last packet of the day would otherwise leave that peer's exposure unclaimed
indefinitely (peer-wire-spec §3.3): an unsolicited, payer-originated frame carrying settlement value
and its proof, with no ILP packet attached. That is a verbatim description of what RFC-0023 defines
TRANSFER for — `amount` plus ledger-specific proof in `protocolData`, no ILP packet
(client-edge-spec §1.9's `transferBody`). `flushIntervalMs` keeps its exact meaning: still the real
bound on trailing exposure, still configured per peering relation. Only the bytes change.

**FLUSH on HTTP works, but only in the dialing direction — and that asymmetry has to be paid for.**
The frame itself maps cleanly: a POST with the claim header and an empty ILP body is precisely the
"standalone claim" shape the client edge already defines (§1.9 step 5 — ingested at price 0, full
validation, replay still refused). What does _not_ map is origination. FLUSH must be sent by
whichever side just fulfilled, and on HTTP only the **dialing** side can originate anything. So:

- **On an HTTP peering where both sides dial each other** (both expose HTTP, both configure an
  `endpoint`), FLUSH is fully symmetric and `flushIntervalMs` bounds trailing exposure on both sides,
  exactly as on BTP.
- **On an HTTP peering where only one side dials**, the accept-only side cannot originate anything at
  all, a FLUSH included. Everything this ADR requires of that side follows from that and is unchanged.
  What changed is the reason.

  **Correction, from `docs/protocol/peer-carriage-spec.md` §6.4 (recorded in its §12).** This ADR
  previously said that side "cannot flush, and `flushIntervalMs` does not bound its trailing exposure
  at all", which reads the asymmetry as a settlement-time loss. That is exactly true only in the
  residual case below; in the ordinary accept-only configuration the premise is wrong. Packets flow
  only in the dialing direction, and debt flows with packets (peer-wire-spec §3.2 — the sender owes),
  so an accept-only side is structurally the **payee**. It has no trailing exposure of its own, and
  therefore no flush bound to lose. The real consequence is **unidirectional packet flow**: the
  accept-only side can never forward a packet to that peer, so a route naming it as next hop is
  undeliverable, must be a named load-time error where detectable and must reject at runtime
  otherwise. **The asymmetry bites at configuration time, not at settlement time** — and it is more
  likely to surprise an operator than the flush question is.

  **The conclusions are unchanged; the sharper premise strengthens them.**
  1. That side MUST carry an **explicit exposure ceiling** (peer-wire-spec §5.3). The ceiling, not
     the flush timer, is its only real bound — it cannot originate, so it cannot prompt a payer that
     has simply stopped sending, and unlike BTP it has no live session to read liveness from. Its
     absence MUST be a named load-time error, never a default: a defaulted ceiling on the one
     configuration where the ceiling is the sole bound is an unowned credit decision.
  2. It MAY set a `Toon-Flush-Requested: <channel-id>` response header on any response, which asks
     the dialing peer to send its pending claim on its next request or immediately as a standalone
     claim POST. This is a hint, not a guarantee — the ceiling is what actually holds.
  3. **The residual flush case survives**, and is where the original wording was right: an
     accept-only side that nonetheless holds a pending claim for that peer — because it could dial
     earlier and can no longer, or its configured endpoint is unreachable — cannot send the FLUSH at
     all, and `flushIntervalMs` bounds nothing for it. The claim stays pending until it can dial
     again, and its counterparty's protection meanwhile is that counterparty's own ceiling.

Stating this plainly is the point: **the accept-only direction of an HTTP peering is a payee-only
direction, bounded by a ceiling rather than by a flush timer.** An operator who wants packets to flow
both ways, or wants the flush timer to mean what the spec says, should either dial as well, or use
BTP.

**CLAIM_ACK becomes a field on a response both carriages already require, and this is strictly better
than the frame it replaces.** Three properties are preserved and two defects are fixed, identically
on both carriages:

- _Preserved — the claim verdict is independent of the packet verdict._ Peer-wire §3.4 is explicit
  that a `rejected` CLAIM_ACK does not reject the PREPARE the claim was piggybacked on. On BTP the
  RESPONSE carries both verdicts in different places (`ilpPacket` answers the packet, the `claim-ack`
  entry answers the claim); on HTTP the response body answers the packet and the `Toon-Claim-Ack`
  header answers the claim. One response, two independent answers, no coupling introduced, same shape
  on both wires.
- _Preserved — the reason taxonomy._ JSON `{"result":"accepted"}` or
  `{"result":"rejected","reason":"…"}` with §3.4's four reasons unchanged: `signature_invalid`,
  `nonce_not_advancing`, `amount_not_advancing`, `unknown_channel`. A rejected claim is a well-formed
  answer, **not** a BTP ERROR frame and **not** an HTTP error status — a claim-rejecting response
  still carries its FULFILL or REJECT with a 200, exactly as the client edge already does.
- _Preserved — the consequence._ A peer whose most recent claim was rejected still holds unclaimed
  exposure, and a connector SHOULD still stop forwarding to it until a valid claim restores the
  watermark (§3.4, §5.3). That is policy above the carriage and is untouched.
- **Fixed — correlation.** Peer-wire CLAIM_ACK carries an all-zero `correlationId` and "answers the
  claim most recently received", a positional rule that is ambiguous the moment two claims are in
  flight. BTP's `requestId` and HTTP's request/response pairing each name exactly which claim is
  being acknowledged.
- **Fixed — liveness.** The peer wire has no timeout on a CLAIM_ACK that never arrives: a pending
  claim can hang forever. RFC-0023 requires a responder to answer every request, and HTTP always
  answers, so the ack becomes structurally synchronous on both carriages.

The one honest loss is encoding-level and identical on both: CLAIM_ACK was a distinct frame type, so
"the peer sent no ack" was inexpressible; as an entry or a header it is omissible. **Defined
behaviour:** a missing `claim-ack` / `Toon-Claim-Ack` on a response answering a claim-bearing request
means **not acknowledged** — the claim stays pending and the flush timer keeps running — never
accepted.

**And a retransmission at the current watermark MUST be re-acked `accepted`.** "Not acknowledged"
implies retransmission — a lost ack and a lost claim are indistinguishable at the payer — but neither
this ADR nor peer-wire-spec §3.2 said what a payee does with the byte-identical retransmission that
follows, and §3.2's strictly-advancing rule read literally refuses it `nonce_not_advancing`, which
wedges the peering permanently on a single lost ack. `docs/protocol/peer-carriage-spec.md` §6.3
supplies the rule and this ADR carries it: a claim whose `(channel, nonce, cumulative, signature)` is
byte-identical to the one already at the payee's watermark MUST be answered `{"result":"accepted"}`
and MUST NOT be refused `nonce_not_advancing`, while a claim at the same nonce differing in any other
field is a different claim and MUST still be refused. It records nothing and advances nothing, so it
changes no exposure — but it is a new normative rule rather than a restatement, which is why it is
named here and not left in the spec alone. §6.3 is where it is defined and vectored.

Every row above gets canonical vectors per [ADR 0021](0021-vectors-are-normative-prose-is-not.md),
and **the vectors are shared across carriages**: the same claim, minimum-delivery and accumulated-cost
values, pinned in both encodings, so a change to one carriage that is not made to the other fails CI.
That is the mechanical form of ADR 0026's anti-drift discipline.

[ADR 0024](0024-peer-wire-claims-sign-the-eip-712-balance-proof.md) is untouched in substance on both
carriages: peer claims still sign the EIP-712 `BalanceProof` digest, byte for byte. Only carriage
moves.

### Ordering: a real difference between the carriages, and it is the client edge's difference

`client-edge-spec.md` §1.9 exists because parallel HTTP writes carrying nonces _n_ and _n+1_ reach
the watermark lock in either order and the loser is refused `NonceNotAdvancing` for nothing. Peer
claims carry the identical strictly-advancing nonce rule (peer-wire-spec §3.2), so **the same race
exists on an HTTP peering and does not exist on a BTP one.** This is not a reason to forbid HTTP
peering; it is a documented property of the carriage the operator chose, with the same mitigation the
client edge already ships — one outstanding claim-bearing request at a time on an HTTP peering, or
accept the retry. On BTP, claims are judged strictly sequentially per session with the remaining work
windowed (`btp_session_window`, #688), and the race cannot occur.

**Discovery needs no schema change.** `kind:10032` already carries both a `btpEndpoint` (`wss://`) and
an HTTP endpoint, and never carried a raw-TCP endpoint — it already describes a two-carriage world.
This decision makes that description true of Rust connectors instead of only of the retired
TypeScript ones.

## What is given up

- **The client-by-construction session classification.** ADR 0026's strongest property — "no client
  middleware can leak onto peer traffic; no peer trust can leak onto client sessions", true because
  peers spoke a different protocol on a different listener — becomes role-by-auth, which is code and
  can therefore have bugs, now on two carriages instead of one. Mitigated by requiring _two_
  configured facts for peer role, by the named `toon-sandbox` regression test on both carriages, and
  by the dedicated-listener fallback. This is the real price.
- **Design freedom.** The fleet wire is again constrained by external specs and by code shared with a
  versioned client edge — the exact coupling ADR 0003 split apart. The escape, if edge versioning
  starts dictating peer changes, is a fleet-only sub-protocol version, not raw TCP.
- **Two carriages to keep honest instead of one.** This is the cost the owner accepted in exchange
  for operator choice, and ADR 0026 is the evidence it is payable — but also the evidence of what
  happens when it is not paid. Shared vectors and a shared refusal taxonomy are load-bearing, not
  nice-to-have.
- **Framing simplicity and plaintext debuggability.** 102 lines of codec with no HTTP/WS dependency
  become a websocket and TLS stack in the value path, and `tcpdump` on a peer link stops being
  readable.
- **Structurally mandatory fields become spec-mandatory entries/headers**, optional by encoding on
  both carriages. Each needs a defined "absent" behaviour (given above for the claim ack) and vectors.
- **Single-in-flight simplicity.** `NetworkPeerTransport`'s one-request-per-peer mutex bounded
  concurrency by construction. BTP multiplexing needs a demux table, per-request timeouts and a
  window; HTTP needs an explicit outstanding-request policy for the nonce race above.

What is **not** given up, and was assumed to be: a flag day. ADR 0003 accepted "a coordinated cutover
across `connector`, `relay`, `store`, `swap`, `town`, `mill` and both devnet boxes" as the price of
peer-wire changes. Since no link has ever run on the peer wire, that price is not paid here.

## Sequencing: delete first, then build

This is where this ADR differs most from the draft it replaces. PR #675 planned four phases —
dual-stack, config, cutover with rollback, removal — a shape appropriate to draining live traffic off
a wire. **There is no live traffic.** No box configures `[[peers]]`, no claim has ever been written to
`peer-claims.log`, and discovery never advertised a raw-TCP endpoint. So:

1. **Delete the raw-TCP transport now** (#679). `peer_wire.rs`, the raw-TCP halves of
   `network_peer_transport.rs`, `peer_wire_addr`, `[[peers]].addr` as a `SocketAddr`, and
   `peer-wire-spec.md` §1–§2. The `PeerTransport` port and `InProcessPeerTransport` **stay** — the
   port is the seam this whole plan rests on, and everything above it
   (`Connector::forward_via_peer_route`, `ClaimBook`, fees, routing) is untouched. A pure subtraction
   that cannot break production.
2. **Specify** (#711) both carriages' entries/headers, role-by-auth, the expose/dial axes and the
   intersection rule, with shared vectors (ADR 0021).
3. **Config** (#677): `[peers].expose`, per-peer `endpoint` + credential, `[[peer_channels]]`, and the
   load-time intersection check.
4. **Charge peer-forwarded routes** (#620) — carriage-independent, and the hard gate on any
   deployment: a peer-forwarded route that is neither priced nor charged is a free-write path on
   `g.toon`, and claims spent for free cannot be recharged.
5. **Implement** (#676) both carriages behind the existing `PeerTransport` port, on the extracted
   codec (#713) and the existing HTTP handler shape.
6. **Bring up** (#678) the first real Rust peer link on devnet — apex↔store, over `wss` through the
   store box's existing nginx. Rollback is one config edit back to today's HTTPS-terminated
   `handler_url`, which costs nothing because that is what production does today anyway.
7. **Retire the TypeScript connectors** (#714), gated on (6) holding.

## Revisit conditions

- Role-by-auth fails review or audit on either carriage — any path by which an unauthenticated
  session reaches peer handling. Stop-ship for the bring-up; the answer is a dedicated authenticated
  listener, not raw TCP.
- The two carriages drift — any peer behaviour that exists on one and not the other, or a refusal
  taxonomy that diverges. That is the ADR 0026 incident repeating one layer up, and the response is
  more shared vectors and more shared code, not dropping a carriage.
- The `claim-ack` entry/header cannot express ADR 0024's semantics losslessly in practice — in
  particular if the independence of the claim verdict from the packet verdict cannot be maintained on
  a shared response.
- The HTTP carriage's non-dialing-side exposure (ceiling instead of flush timer) proves inadequate in
  operation — a peer accumulates unclaimed exposure that the ceiling does not actually bound. The fix
  is to require mutual dialing for HTTP peerings, not to remove the carriage.
- A measured, budget-breaking latency or throughput regression attributable to framing. Note the
  measurement already on record (`toon-meta/prototypes/mesh-shard-over-ilp/RESULTS.md`): one
  `fdatasync` is 72% of a paid packet's p50 and 99% of its p99, while the entire crypto layer costs
  0.23 ms. Framing is not where this budget goes, and any claim that it is needs numbers beside that
  file first.
