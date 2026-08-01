# Connectors peer over BTP; the clean-room peer wire is retired

The connector↔connector transport becomes BTP (RFC-23) over websockets, carried on `wss://` URLs,
sharing one BTP framing layer with the client-facing BTP ingress. The raw-TCP peer wire of
[ADR 0003](0003-clean-room-peer-wire-versioned-client-edge.md) — `peer_wire.rs`'s five-frame,
plaintext, unauthenticated protocol — is dual-stacked during migration and then deleted. This
reverses ADR 0003's judgement that "BTP is not worth preserving as a constraint on the design";
it does not reverse ADR 0003's licence to redesign the peer wire freely — that licence is what
authorises this redesign.

## Context

ADR 0003 chose a clean-room peer wire for one stated reason: both ends are operator-controlled,
so the wire could be redesigned without legacy constraint, at the accepted cost of fleet flag
days. It made no performance, security or framing argument for raw TCP over websockets.

What the freedom bought is real and small: a 102-line codec
(`crates/connector-runtime/src/peer_wire.rs`) with five frame types and no HTTP or websocket
dependency, plus four wire-level extensions that BTP has no first-class field for —
`minimumDelivery` beside every PREPARE ([ADR 0010](0010-flat-per-packet-fee-and-minimum-delivery.md)),
`accumulatedCost` on every REJECT ([ADR 0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md)),
claims piggybacked in the PREPARE frame plus dedicated FLUSH/CLAIM_ACK frames with typed
rejection reasons ([ADR 0024](0024-peer-wire-claims-sign-the-eip-712-balance-proof.md)), and
strict OER canonicality ([ADR 0023](0023-oer-length-determinants-are-canonical.md)).

What it cost accumulated faster. The wire has no authentication, no TLS, no handshake (#416) and
`SocketAddr`-only addressing, so it cannot cross a TLS-terminating proxy or the public internet
(#623). It holds one request in flight per peer behind a mutex, has no timeouts, and several of
its own spec'd features — duplex forwarding, PING/PONG, F08 dedup, the flush timer — were never
implemented. The consequence on devnet is decisive: the fleet's only inter-node leg, apex→store,
is **not carried by the peer wire at all**. `infra/linode-node/connector-rust.toml` terminates
`g.toon.store` over the store box's public HTTPS front, because the peer wire cannot carry a
public link (#623) and a peer-forwarded route would serve writes for free (#620). The transport
built for the fleet's internal links carries no production link.

Meanwhile everything outside the fleet already speaks BTP. The discovery plane — `kind:10032`
announces and `genesis-peers.json` — requires a `btpEndpoint` (`wss://…`) and has never carried a
raw-TCP peer endpoint. The retired TypeScript fleet peered connector↔connector over BTP on
wss:443. And the client edge is growing a Rust BTP websocket ingress anyway
(`docs/btp-client-ingress-findings.md`, PR #674): once that framing layer exists, the peer wire
is a second, weaker transport maintained beside a stronger one.

## Decision

**End state.** Connector↔connector links run over BTP on `wss://` URLs: ILPv4
prepare/fulfill/reject carried in BTP messages with real request-id correlation, authenticated by
BTP's `auth` sub-protocol, TLS-terminated by ordinary reverse proxies. `[[peers]]` addresses
become URLs. `peer_wire.rs`, `network_peer_transport.rs` and the raw-TCP listener are deleted
once nothing configures them.

**One framing layer, two roles.** The peer transport reuses the client-facing BTP ingress
framing (the #674 follow-up work in `connector-client-edge`); it does not invent a second
websocket stack. A session's _role_ is decided by authentication, not by transport: a peer
session presents a configured peer credential and is bound to its configured channel identity; a
session without one is a client, full stop. This is stated here because the findings doc
correctly observes that "peers stay on raw TCP" was what made every BTP session a client by
construction — that property is given up below, and role-by-auth is its replacement. An
unauthenticated session must never be able to name itself a peer; this is the invariant that the
TypeScript fleet's `toon-sandbox` no-auth admission violated.

**Semantics survive; carriage moves.** The four peer-wire extensions are re-expressed as named
BTP `protocolData` sub-protocols with canonical vectors ([ADR 0021](0021-vectors-are-normative-prose-is-not.md)):
minimum delivery beside the prepare, accumulated cost beside the reject, and claim carriage plus
claim acks. ADR 0024 is untouched in substance — peer claims still sign the EIP-712
`BalanceProof` digest; only `WireClaim`'s length-prefixed encoding is replaced by a protocolData
entry, converging with the client edge's existing `payment-channel-claim` convention
(`connector-domain/src/client_claim.rs`).

**Discovery is already aligned.** `btpEndpoint` in announces and genesis seeds becomes literally
true of Rust connectors instead of describing a retired fleet. No discovery schema change is
required; [ADR 0022](0022-a-connector-answers-it-does-not-announce.md) (answer, don't announce)
stands, though its consequence that the peer wire is "private, plaintext and unauthenticated on
its own segment" is superseded: the peer transport is now public-capable, encrypted and
authenticated.

**Supersessions.** The peer-wire half of ADR 0003 (the clean-room wire itself) is superseded;
its client-edge half (versioned edge, edge complexity paid twice) stands. §1 of
`docs/protocol/peer-wire-spec.md` is rewritten against BTP; §3–§6 (claims, fees, reject codes,
consistency) survive as the sub-protocol payloads' semantics.

## Considered options

**Keep the peer wire and harden it.** Adding TLS, auth, a handshake, timeouts and duplex to the
raw-TCP wire re-implements, feature by feature, what websockets and BTP already provide — and
still leaves a transport no proxy can terminate and no discovery record describes. Rejected: the
maintenance is BTP's, without BTP's interoperability.

**BTP for public links, peer wire for private segments.** Two peer transports forever, and
devnet has no private segment (#600 settled that node↔node links are public). Rejected: the
dual-stack exists in this decision only as a migration phase, not an end state.

**A new custom protocol over websockets.** Keeps design freedom, gains TLS/proxies. Rejected:
the discovery plane advertises `btpEndpoint`, the TS client already speaks BTP with claim
carriage, and the client ingress is BTP — a third framing convention is complexity with no
constituency.

## What is given up

Recorded honestly, because the losses are real even where they are acceptable:

- **Design freedom.** The fleet wire is again constrained by an external spec and by a framing
  layer shared with the versioned client edge — precisely the coupling ADR 0003 split apart.
  Fleet-only wire changes now weigh their effect on a shared layer.
- **Client-by-construction session classification.** With peers on raw TCP, every websocket
  session was a client and no classification code could be wrong. That proof-by-construction is
  replaced by role-by-auth, which is code that can have bugs and must be tested against the
  exact failure it replaces (anonymous admission as a peer).
- **Framing simplicity and dependency surface.** 102 lines of codec with zero HTTP/WS
  dependencies become a websocket stack (HTTP upgrade, TLS, tungstenite or equivalent) inside
  the fleet's most security-sensitive path. Plaintext tcpdump debuggability on the private
  segment is lost to TLS.
- **First-class fields become sub-protocols.** `minimumDelivery`, `accumulatedCost` and claim
  acks were structurally mandatory in the frame; as protocolData entries they are optional by
  encoding and mandatory only by our spec — a class of "peer omitted the entry" errors that
  could not previously exist, and new vectors to author and maintain.
- **Single-in-flight simplicity.** The mutex-serialized request model, primitive as it was,
  bounded concurrency by construction. BTP's request-id multiplexing requires a real demux
  table, per-request timeouts and concurrency limits — capability gained, invariants to enforce.

## Migration strategy

Four phases, specified operationally in
[`docs/operators/btp-peer-transport-migration.md`](../operators/btp-peer-transport-migration.md):
(1) dual-stack — the connector accepts and dials both transports, per-peer selection in config;
(2) config and discovery — `[[peers]]` gains URL endpoints, credentials and `[[peer_channels]]`
(closing the #620/ADR 0024 configuration gap, which gates any paid peer-forwarded route on any
transport); (3) devnet cutover — the apex→store leg becomes the first real Rust peer link, over
wss through the store box's existing nginx, with per-step verification and rollback to the
current HTTPS-terminated shape; (4) removal — `peer_wire.rs` and the raw-TCP listener are
deleted when nothing in the repo, the boxes' bind-mounted configs, or local-stack references
them. Because no production link runs on the peer wire today, the dual-stack phase protects
local-stack and test topologies rather than draining live traffic.

## Revisit conditions

- The claim/ack sub-protocol cannot express ADR 0024's semantics losslessly (typed rejection
  reasons, flush-and-ack ordering) within BTP's request/response shape.
- Sharing the framing layer forces client-edge versioning constraints onto peer-wire changes in
  practice — the ADR 0003 coupling returning through the back door. The escape is a fleet-only
  BTP sub-protocol version, not a return to raw TCP.
- Role-by-auth separation fails review or audit — i.e. any path is found by which an
  unauthenticated session reaches peer handling. That is a stop-ship for the cutover, not a
  reason to keep the peer wire, but if it proves structurally unfixable in a shared listener,
  the fallback is a dedicated peer listener port with mandatory auth, still over BTP.
- A measured, budget-breaking latency or throughput regression on fleet links attributable to
  websocket/TLS framing, at which point the evidence belongs in a doc beside
  `docs/operators/parallel-fleet-comparison.md` before any decision.
