# Local-delivery fulfillment contract — sender-chosen execution conditions

**Status:** Normative (issue #309) · **Consumers:** `@toon-protocol/sdk` swap handler
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

## Sequence (rolling-swap maker, leg A termination)

```
sender ── PREPARE(amount δ, condition C_i) ──▶ apex ── forward (C_i unchanged) ──▶ maker connector
maker connector ── LocalDeliveryRequest{..., executionCondition: b64(C_i)} ──▶ swap handler
swap handler: sends leg-B PREPARE (same C_i), learns P_i from leg-B FULFILL
swap handler ── {fulfill: {fulfillment: b64(P_i)}} ──▶ maker connector
maker connector: sha256(P_i) == C_i ? FULFILL(P_i) upstream : F99, nothing delivered
```
