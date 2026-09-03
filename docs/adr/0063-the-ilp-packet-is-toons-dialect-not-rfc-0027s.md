# The ILP packet is TOON's dialect, not RFC 0027's

**Status:** Accepted — **built**, in the sense that this record ratifies the encoding this connector has always emitted (#1174). Nothing changes on the wire. Extends [0026](0026-client-btp-rides-the-client-edge-peers-stay-on-the-peer-wire.md)'s reasoning one layer down, from the BTP frame to the packet inside it.

**Scope:** protocol law — binds every implementation. See the [ADR index](README.md).

**This connector's ILPv4 packet is not byte-compatible with RFC 0027, it has
never been, and it is not going to be.** The encoding is TOON's, the semantics
are Interledger's, and the vectors are what bind. Saying so is the whole of this
record: the divergence was an accident of porting, the decision to keep it is
deliberate, and until now only the first half was written down anywhere.

## What differs

| RFC 0027 §Packet Format                                 | This connector                                 |
| ------------------------------------------------------- | ---------------------------------------------- |
| Outer type-length wrapper: `type` then a VarOctetString | Type byte, then fields inline — no wrapper     |
| `amount` is a fixed `UInt64` (8 bytes)                  | `encode_var_uint` — a VarUInt                  |
| `expiresAt` is a 17-byte Interledger Timestamp          | 19-byte GeneralizedTime, `YYYYMMDDHHMMSS.fffZ` |

Everything else is RFC 0027's: the three type bytes, the field order and
meanings, `condition = sha256(fulfilment)`, the `F`/`T`/`R` error taxonomy, and
the rule that an ILP outcome never becomes an HTTP one.

## How it happened, and why that matters

`connector-domain`'s packet codec says of itself that it was "ported
byte-for-byte from `packages/shared/src/types/ilp.ts`… so a **real
ILPv4-over-HTTP client (RFC-0035) can address this connector's client edge**".

The first clause is true and the second does not follow. It was ported from the
TypeScript prototype's encoder, which already diverged; porting it faithfully
reproduced the divergence, and the sentence records an intention nobody
subsequently checked. Three independent readings of this codebase in one sitting
took that comment at face value.

That is why this record exists even though it changes nothing. An undocumented
divergence is indistinguishable from a bug, and gets "fixed" by the next person
who reads the RFC — at the cost of a flag day across every consumer.

## Why not become compatible

**Because packet-byte compatibility buys nothing while
[0018](0018-a-payload-is-sealed-to-the-terminating-connector.md) and
[0019](0019-a-terminating-connector-derives-the-fulfilment.md) stand, and those
two are the product.** A conforming ILPv4 sender with a perfectly-encoded packet
still cannot pay a TOON node: `data` must be a gift wrap sealed to the
terminating connector's identity key, and the fulfilment is derived from the
32-byte secret inside it. No standard sender constructs that, and no
implementation of RFC 0027 tells it how.

Behind that sit three further blockers, each larger than the encoding:

- **Nothing foreign can route to us.** This connector neither discovers nor
  advertises routes ([0006](0006-the-connector-is-mechanism-not-policy.md),
  [0022](0022-a-connector-answers-it-does-not-announce.md),
  [0046](0046-the-kind-10032-announce-is-removed-a-connector-needs-no-relay.md)),
  and CCP is not implemented.
- **No foreign hop can price a path through us.** There are no exchange rates and
  no ILQP; cost is discovered by probe
  ([0011](0011-rejects-accumulate-fees-and-probes-discover-cost.md)).
- **There is no transport layer.** No STREAM, so a standard sender has nothing to
  run over the packets even if it could build them.

Correcting three encoding details would produce a node that still cannot
interoperate for four other reasons, none of which anyone proposes to remove.
The encoding is the _last_ obstacle to interoperation, not the first, and
treating it as the first is how a wire break gets paid for nothing.

## What compatibility would cost

The packet crosses the **client edge**, and
[0003](0003-clean-room-peer-wire-versioned-client-edge.md) is explicit about what
that means: `toon-client` ships as an `.mcpb` bundle into Claude Desktop and as a
Claude Code plugin, so "there is no date on which every installed client
updates — a breaking edge change is not a flag day, it is an outage of unbounded
duration."

It crosses the peer carriage too, where a third-party operator now runs a node
(#1098). The cost is therefore a coordinated cutover across `connector`,
`toon-client`, `rig`, `swap` and at least one operator this project does not
employ — spent to reach a network we cannot join for other reasons.

## The precedent this follows

[ADR 0026](0026-client-btp-rides-the-client-edge-peers-stay-on-the-peer-wire.md)
already decided exactly this question one layer up, for the BTP frame that
carries the packet: the grammar is the deployed client's dialect rather than
RFC 0023's, because "the only BTP speakers this edge must interoperate with are
`@toon-protocol/client`'s `IsomorphicBtpClient` and its consumers."

The packet is the same question about the layer below, with the same answer and
the same reason. What 0026 had and this did not is a record.

## Decisions

**D1. The encoding above is TOON's, and is normative.** An implementation of this
protocol emits and accepts the dialect in the table, not RFC 0027's byte layout.

**D2. The vectors bind, as always.** `vectors/wire-vectors.json`'s
`peer_carriage` fixtures already pin the packet bytes — `http_body_hex` and
`btp_message_hex` carry a complete encoded PREPARE — so this has been the
cross-repo contract since those vectors landed
([0021](0021-vectors-are-normative-prose-is-not.md)). This record does not create
the contract; it names it. The fixtures are to be made discoverable **as** the
packet-encoding pin rather than remaining a side-effect of a peer-carriage
example, because three readers in one sitting concluded the encoding was
unpinned by looking exactly where they should have.

**D3. "Speaks ILPv4" is retired as a description of this connector.** It is doing
unearned work in prose, and it is the sentence that produced the codec's own
misleading comment. The accurate form is **ILPv4 semantics, TOON encoding** —
and where the distinction matters, say which. The vendored
[RFC 0027 profile](../rfcs/0027-interledger-protocol-4/0027-interledger-protocol-4.md)
is where a reader is owed the detail.

**D4. This is not a claim that RFC 0027 is wrong.** The RFC's reason for `amount`
and `expiresAt` being fixed-length — so a connector can rewrite them in place
while forwarding — is sound, and this connector forgoes that optimisation by
re-encoding. That is a cost of the dialect, accepted, and worth knowing before
anyone benchmarks the forward path.

## What would reopen this

Joining the public Interledger network — reaching a node this project does not
operate and did not write. That is the only thing packet compatibility is for.

If it becomes a goal, the migration path already exists and is deliberate:
[ADR 0003](0003-clean-room-peer-wire-versioned-client-edge.md)'s
`POST /ilp/v{N}` seam, which that record describes as "unexercised, not unbuilt".
A version 2 client edge is precisely the change it was left in place for, and it
lets old clients keep working rather than making the cutover a flag day. The
encoding would still be the last of the five things to fix.
