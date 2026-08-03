# Client BTP rides the client edge; peers stay on the peer wire

`crates/connector-client-edge` now serves a BTP websocket transport at `GET /ilp/btp`
(client-edge-spec.md §1.9), mounted on the same router — and therefore the same bind address, the
same `ClientClaimGate` instance, the same watermarks and journal — as `POST /ilp`. It is a second
carriage for the client edge's existing pipeline, not a second pipeline. Peers never use it:
connector↔connector traffic stays on the raw-TCP peer wire (`peer_wire.rs`,
`docs/protocol/peer-wire-spec.md`), unchanged.

## Why this is a client-edge route, not a peer transport

The retired TypeScript connector (ADR 0017) had one BTP server for both audiences, and that
ambiguity is precisely what `docs/btp-client-ingress-findings.md` measured on devnet: an anonymous
client session was admitted as a quasi-peer (`btp_auth … success:true mode:"no-auth"`), its
prepares were routed with `prepare.data` untouched, and the termination — which expected the
modern sealed envelope it had no key for — answered
`F01 Invalid HTTP envelope: malformed request-line: "<ciphertext>"`. The client's claim, riding as
protocolData, had no header to land in and fell on the floor as
`F06 No payment channel claim attached`.

Putting the websocket endpoint inside `connector-client-edge` dissolves the audience question
instead of re-answering it per-session: every BTP session is a client session by construction,
because peers speak a different protocol on a different listener. No client middleware can leak
onto peer traffic; no peer trust can leak onto client sessions. And because the route is mounted
in `router_with_gate_and_terms` beside `handle_ilp`, sharing `ClientEdgeState`, the claim
pipeline is shared by construction too — one gate, two carriages, with `claim_rejection_reject`
and the x402 terms builder factored so neither carriage can drift from the other's refusal
taxonomy (the F06 greeting REJECT is the one BTP-only code: BTP cannot answer HTTP 402, so the
same terms JSON rides as `payment-required` protocolData on a REJECT instead).

## Why the session is processed strictly in order

The transport exists because parallel HTTP writes race their own claims: two requests carrying
nonces n and n+1 can arrive at the gate's watermark lock in either order, and the loser is refused
`NonceNotAdvancing` even though the client did nothing wrong. A websocket delivers frames in
order; the session loop preserves that order all the way through the gate by not reading frame
k+1 until frame k's claim has been judged and its packet routed. In-order traffic on one session
therefore cannot self-race by design, which is the property the huddle-over-ilp measurement
(toon-meta `proto/huddle-over-ilp`, Phase D) needs. Pipelining routing while keeping only the
gate serial is a compatible future optimization; ordering is the contract, full serialization is
today's implementation.

## Why the frame grammar is the deployed client's dialect, not RFC-23

The only BTP speakers this edge must interoperate with are `@toon-protocol/client`'s
`IsomorphicBtpClient` and its consumers — the deployed wire. That dialect (fixed-width
protocolData list, ILP packet as a trailing length-prefixed field beside it, MESSAGE/RESPONSE/
ERROR only, no TRANSFER) is simpler than RFC-23 and is what §1.9 specifies normatively. The unit
vectors in `crates/connector-client-edge/src/btp.rs` pin it byte-for-byte against the TS
serializer. Implementing RFC-23's full grammar would add frames no deployed client sends, to a
transport ADR 0003 already versions behind the client edge's own discipline.

## Update (issue #697): the grammar is now additively symmetric

toon-meta#262 (agents earning) needs the connector to pay a client, not just be paid by one —
which needs the other half of RFC-23: a server-originated MESSAGE and TRANSFER (type 7), the
frame RFC-23 specifies for carrying settlement value. "No deployed client sends it" stopped being
a reason not to add TRANSFER once a _future_ client (the paired `toon-client` ticket) needs to.
The paragraph above is now historical: as of #697, `btp.rs` decodes/encodes TRANSFER,
acknowledges an inbound one, and can originate a MESSAGE or TRANSFER of its own with a
session-scoped outbound requestId allocator satisfying RFC-23's uniqueness property. This is
additive, not a reopening of the decision above — the deployed client still speaks exactly the
dialect this ADR describes and observes no change, because it never sends TRANSFER and nothing
yet originates a request to it (that caller is the session registry `toon-meta#262`'s
payout-ledger ticket adds next). See `docs/protocol/client-edge-spec.md` §1.9 for the current,
normative frame grammar.
