# Local-delivery fulfillment contract — sender-chosen execution conditions

> **Superseded — a record of the retired TypeScript prototype, not a contract anything in this
> repository implements.**
>
> Every seam this document pins (`ConnectorNode.setLocalDeliveryHandler()`, `setPacketHandler()`,
> `POST /handle-packet`, `packages/connector/src/core/packet-handler.ts`,
> `packages/shared/src/types/local-delivery.ts`) was deleted with the TypeScript connector —
> [ADR 0017](adr/0017-the-typescript-connector-is-a-prototype.md), #465 and #543. The paths below
> resolve only in git history.
>
> The Rust connector does not implement this contract and will not.
> [ADR 0019](adr/0019-a-terminating-connector-derives-the-fulfilment.md) inverts it: the
> **terminating connector** derives the fulfilment from the shared secret sealed into the packet's
> gift wrap ([ADR 0018](adr/0018-a-payload-is-sealed-to-the-terminating-connector.md)), so an app
> never supplies a preimage, is never handed an `executionCondition`, and has no way to fail this
> contract's enforcement step. For what a terminated route actually exchanges with its app, read
> [`docs/protocol/client-edge-spec.md`](protocol/client-edge-spec.md) §1.8 and
> [`vectors/README.md`](../vectors/README.md).
>
> Kept because the peer-wire spec's §3.1 "legacy class" and several ADRs cite it as the record of
> what the prototype promised.

**Status:** Superseded (was: Normative, issue #309) · **Consumers (historical):**
`@toon-protocol/sdk` swap handler
(rolling-swap maker, toon-meta#145 §3), toon-client daemon leg-B termination
(toon-client#350), any app registered via `ConnectorNode.setLocalDeliveryHandler()` /
`setPacketHandler()` or the HTTP `POST /handle-packet` seam.

This document pins the contract between the connector's local-delivery dispatch
(`packages/connector/src/core/packet-handler.ts`) and the terminating application for
ILP PREPARE packets that carry a **sender-chosen execution condition** — a non-zero
32-byte `executionCondition` minted end-to-end by the original sender
(`C = sha256(P)`, toon-meta `docs/rolling-swap.md` §3 R1/R2). The key words MUST,
MUST NOT, and MAY are per RFC 2119.

## Condition classes

| Inbound PREPARE `executionCondition` | Class             | Behavior                                                                                                     |
| ------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| absent or all-zero (32×`0x00`)       | **legacy**        | Pre-#309 behavior, byte-for-byte: no verification; NIP-59/HKDF receiver-side preimage injection when active. |
| any non-zero value                   | **sender-chosen** | This contract. The terminating application owns the fulfillment.                                             |

The OER decoder only populates `executionCondition` when it is non-zero, so on the
wire "absent" and "all-zero" are the same legacy class.

## Contract (sender-chosen class)

1. **Request.** The connector delivers the packet with the condition attached:
   - in-process (`LocalDeliveryRequest`, `packages/connector/src/config/types.ts`):
     `executionCondition?: string` — base64-encoded 32 bytes; present iff sender-chosen;
   - HTTP wire / `PaymentHandler` bridge (`PaymentRequestSchema`,
     `packages/shared/src/types/local-delivery.ts`): same field, same encoding.
2. **Response.** An accepting application MUST return the matching 32-byte preimage:
   - in-process: `LocalDeliveryResponse.fulfill.fulfillment?: string` (base64, exactly
     32 bytes after decode);
   - HTTP wire / bridge: `PaymentResponseSchema.fulfillment?: string`, alongside
     `accept: true`.
3. **Enforcement (connector side).** Before FULFILLing upstream, the connector
   enforces `sha256(fulfillment) === executionCondition`. On a missing, malformed
   (non-32-byte), or mismatching preimage the fulfill is converted into an
   **F99 REJECT** (`Fulfillment does not match execution condition`) and **nothing is
   recorded as delivered** (no `recordLocalDeliver`, no value movement).
4. **No substitution.** The connector MUST NOT inject its NIP-59/HKDF-derived
   preimage on this path (spec R6): that preimage is recipient authentication for the
   legacy class and can never satisfy a sender-minted condition. The app-supplied
   preimage is placed on the FULFILL verbatim and propagates upstream unchanged, where
   every hop's existing `sha256(fulfillment) == executionCondition` check holds it.
5. **No handler.** If a sender-chosen packet reaches a connector with no local
   delivery handler registered (auto-fulfill stub), the connector rejects with F99
   (`No local delivery handler available to satisfy execution condition`) — the stub
   cannot mint the preimage. Handlers that structurally cannot supply preimages (e.g.
   the #216 HTTP reverse-proxy for terminated routes) fulfill without one and are
   therefore converted to F99 by rule 3; do not point sender-chosen traffic at them.
6. **Expiry.** An expired PREPARE is rejected with R00 before the handler is invoked,
   sender-chosen or legacy — the condition does not change expiry semantics.

## Legacy class — unchanged, guaranteed

For absent/all-zero conditions everything keeps pre-#309 behavior: the NIP-59-derived
preimage (when derivable from the inbound `claim-wrapped` protocolData) is injected
into the FULFILL, the auto-fulfill stub still auto-fulfills, and no verification is
applied. An app that volunteers `fulfillment` on a legacy packet gets it placed on the
FULFILL, but active NIP-59 injection takes precedence.

## Pass-through (intermediary role)

Connectors MUST pass a non-zero upstream condition through unchanged and MUST NOT
substitute their own HKDF-derived condition (spec R3). The forward path only sets its
own condition when the packet doesn't already carry a non-zero one
(`packet-handler.ts`, claim-generation block), and verifies the returned fulfillment
against whatever condition was forwarded. Regression-tested in
`packet-handler.test.ts` ("Condition/Fulfillment Verification").

## Egress (sender role) — public `sendPacket` API

The sender-side mirror of this contract: `ConnectorNode.sendPacket()` (and the
`POST /admin/ilp/send` `condition` field) accepts an optional
`executionCondition` — `Uint8Array` or base64 string, exactly 32 bytes, non-zero
(all-zero is the wire encoding for the legacy class; omit the field instead;
malformed values throw `InvalidExecutionConditionError` / return HTTP 400 before
any packet is sent). The condition rides the outgoing PREPARE verbatim (the
claim-generation block never overwrites an existing condition, spec R3/R4), and
the resolved FULFILL carries the terminating application's preimage on
`ILPFulfillPacket.fulfillment` (`fulfillment` base64 field on the admin API
response) so the sender can verify `sha256(fulfillment) === executionCondition`.
This is how a rolling-swap engine sends leg-B PREPAREs carrying leg A's `C_i`
(toon-meta#145 §3 R4) without reaching into `handlePreparePacket`. When omitted,
egress behavior is byte-for-byte the legacy class.

## Reject semantics — chain-A per-packet claims are issued at FORWARD time (issue #316)

This section is normative for the **per-packet settlement claim** the connector attaches
to a value-bearing PREPARE it forwards to a non-`child` peer (issue #76), and pins the
behavior on an ILP **REJECT**. It is distinct from the sender-chosen fulfillment above but
interacts with it: a swap node's application-level rejects (`leg_b_failed`,
`stale_rate`, liquidity, staleness — see toon-meta#145 §3 R8 and the swap benign-reject
vocabulary) all reach a connector hop that has _already_ issued its chain-A claim.

**Current behavior (connector 3.30.0), guaranteed:**

1. The forwarding connector calls
   `PerPacketClaimService.generateClaimForPacket()` **before** it forwards the PREPARE
   (`packages/connector/src/core/packet-handler.ts`, claim-generation block, immediately
   before `forwardToNextHop`). That call **unconditionally** advances the channel's
   cumulative amount and nonce, signs the cumulative balance proof, sets it as the
   channel's `latestClaim`, and persists it.
2. The signed claim rides the forwarded PREPARE in BTP `protocolData`. The receiving peer
   records it at **ingest** — `ClaimReceiver.ingestProtocolData()` runs off the inbound
   BTP message (`registerWithBTPServer`), **not** off the eventual FULFILL — and emits
   `CLAIM_RECEIVED`, which the SettlementMonitor/auto-drive uses to redeem the **highest
   cumulative** proof on-chain (`SettlementExecutor.settleViaExistingChannel` →
   `getLatestClaim`).
3. If the forward **REJECTs** (any code, including the swap benign rejects), **the claim
   stands.** There is no rollback: `PacketHandler` falls straight through to return the
   REJECT, and `PerPacketClaimService` exposes **no** void/rollback method — only
   `resetChannel()`, which is settlement-scoped (post cooperative settle), never per-reject.
   The rejected packet's δ therefore remains folded into the cumulative the auto-drive
   settles.

**Net effect:** a payer pays for the forward **attempt**, not for delivery. On a chain of
hops `sender → apex → maker`, a maker-side reject leaves the sender→apex and apex→maker
per-packet claims in force even though no value was delivered end-to-end. For the rolling
engine this is bounded to one δ per reject (R8 rolls the **maker's accepted watermark**
back so the _maker_ does not double-count), but the **payer-side** cumulative still
includes rejected packets.

**Why this is not fixed by coupling claim issuance to FULFILL:** all three obvious
"only pay on fulfill" shapes are unsound or out of scope at the connector level:

- _Attach-on-fulfill_ (defer the claim past the PREPARE): the receiver's
  `InboundClaimValidator` **rejects** any value-bearing, non-`parent` PREPARE that carries
  no claim (`"No payment channel claim attached to packet"`). Deferring the claim would
  get the PREPARE itself rejected. The design is deliberately pay-before-forward
  (issues #76/#78) so the receiving connector is never exposed to an unpaid forward.
- _Void-on-reject_ (roll the payer's cumulative/nonce back after a REJECT): the peer
  **already holds** the signed cumulative proof and can redeem it on-chain, so a local
  void changes nothing on-chain; and it would violate channel monotonicity — the receiver
  requires strictly increasing nonce **and** amount, so the next claim would be rejected
  and the channel wedged.
- A genuine fix requires **receiver-side cooperation or a netting/refund protocol**
  (signed refund acknowledgments that let the redeemable cumulative decrease for rejected
  δ), or reversing issue #76 to fulfill-gated claims and accepting receiver in-flight
  exposure. Either is a **cross-connector protocol change**, not a connector-local patch —
  surfaced for maintainers in issue #316.

Regression-pinned: `per-packet-claim-service.test.ts` § "reject semantics (issue #316)"
(a rejected packet's δ stays in the settleable cumulative; no void/rollback API exists) and
`packet-handler.test.ts` (claim is generated at forward time even when the forward REJECTs).

## Sequence (rolling-swap maker, leg A termination)

```
sender ── PREPARE(amount δ, condition C_i) ──▶ apex ── forward (C_i unchanged) ──▶ maker connector
maker connector ── LocalDeliveryRequest{..., executionCondition: b64(C_i)} ──▶ swap handler
swap handler: sends leg-B PREPARE via sendPacket({executionCondition: C_i}), learns P_i from leg-B FULFILL
swap handler ── {fulfill: {fulfillment: b64(P_i)}} ──▶ maker connector
maker connector: sha256(P_i) == C_i ? FULFILL(P_i) upstream : F99, nothing delivered
```
