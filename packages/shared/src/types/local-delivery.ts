/**
 * localDelivery wire contract (`POST /handle-packet`).
 *
 * This is the cross-process source of truth for how the connector forwards a
 * final-hop, already-validated payment to a co-located business-logic node
 * (relay / store / any TOON node). The connector serializes a {@link PaymentRequest}
 * and the node answers with a {@link PaymentResponse} (accept = FULFILL, reject = REJECT).
 *
 * Defined here (not in the connector or the SDK) so every repo on either side of
 * the wire — connector, `@toon-protocol/sdk` (its payment-handler bridge), and any
 * node implementing `/handle-packet` — imports ONE definition and cannot drift.
 */

/** Simplified inbound payment request delivered to a node (sourcePeer dropped). */
export interface PaymentRequest {
  /** Unique payment identifier (base64url) */
  paymentId: string;
  /** Full ILP destination address */
  destination: string;
  /** Amount in smallest unit (as string for precision) */
  amount: string;
  /** ISO 8601 expiration timestamp */
  expiresAt: string;
  /** Base64-encoded application data (optional) */
  data?: string;
  /**
   * Whether this is a transit notification at an intermediate hop.
   * When true, the node response is ignored (fire-and-forget notification).
   * When false or omitted, this is a final-hop delivery where the node
   * response determines accept/reject.
   */
  isTransit?: boolean;
}

/** Simplified node response — accept/reject without ILP knowledge. */
export interface PaymentResponse {
  /** Whether to accept (fulfill) the payment */
  accept: boolean;
  /** Optional response data (base64) for the fulfill or reject packet */
  data?: string;
  /** Rejection reason (only used when accept is false) */
  rejectReason?: {
    /** Business error code (e.g., 'insufficient_funds', 'invalid_amount') */
    code: string;
    /** Human-readable error message */
    message: string;
  };
}
