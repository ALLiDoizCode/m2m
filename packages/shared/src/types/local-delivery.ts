/**
 * localDelivery wire contract (`POST /handle-packet`) — zod-validated.
 *
 * The cross-process source of truth for how the connector forwards a final-hop,
 * already-validated payment to a co-located node (relay / store / any TOON node):
 * the connector sends a {@link PaymentRequest}; the node answers a
 * {@link PaymentResponse} (accept = FULFILL, reject = REJECT).
 *
 * Defined here (not in the connector or the SDK) so every repo on either side of
 * the wire imports ONE definition and cannot drift. Exposed as zod schemas so the
 * boundary can be validated at runtime (`PaymentRequestSchema.parse(...)`), not
 * just type-checked.
 *
 * NOTE: this is the WIRE contract. `@toon-protocol/sdk`'s payment-handler *bridge*
 * has a separate internal DX type that `create-node.ts` adapts to this shape — do
 * not conflate them (see toon-meta `context/contracts.md`).
 */
import { z } from 'zod';

/** Inbound payment delivered to a node (sourcePeer dropped). */
export const PaymentRequestSchema = z.object({
  /** Unique payment identifier (base64url) */
  paymentId: z.string(),
  /** Full ILP destination address */
  destination: z.string(),
  /** Amount in smallest unit (string for precision) */
  amount: z.string(),
  /** ISO 8601 expiration timestamp */
  expiresAt: z.string(),
  /** Base64-encoded application data (optional) */
  data: z.string().optional(),
  /**
   * Transit notification at an intermediate hop. When true the node response is
   * ignored (fire-and-forget); when false/omitted the response decides accept/reject.
   */
  isTransit: z.boolean().optional(),
});
export type PaymentRequest = z.infer<typeof PaymentRequestSchema>;

/** Node response — accept/reject without ILP knowledge. */
export const PaymentResponseSchema = z.object({
  /** Whether to accept (fulfill) the payment */
  accept: z.boolean(),
  /** Optional response data (base64) for the fulfill or reject packet */
  data: z.string().optional(),
  /** Rejection reason (only when accept is false) */
  rejectReason: z
    .object({
      /** Business error code (e.g., 'insufficient_funds', 'invalid_amount') */
      code: z.string(),
      /** Human-readable error message */
      message: z.string(),
    })
    .optional(),
});
export type PaymentResponse = z.infer<typeof PaymentResponseSchema>;
