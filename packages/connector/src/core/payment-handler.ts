/**
 * Payment Handler — Simple payment handler for in-process delivery
 *
 * Provides a simplified DX for handling inbound payments without
 * requiring knowledge of ILP packet types or error code mappings.
 *
 * Payment verification relies on self-described claims in the packet data
 * rather than fulfillment/condition cryptography.
 *
 * @packageDocumentation
 */

import * as crypto from 'crypto';
import { Logger } from '../utils/logger';
import { LocalDeliveryHandler, LocalDeliveryRequest, LocalDeliveryResponse } from '../config/types';
import type { PaymentRequest, PaymentResponse } from '@toon-protocol/shared';

/** Maximum ILP data field size per RFC-0027 (32KB) */
const ILP_MAX_DATA_BYTES = 32768;

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/**
 * The localDelivery (`/handle-packet`) wire contract — {@link PaymentRequest} /
 * {@link PaymentResponse} — is defined ONCE in `@toon-protocol/shared`
 * (`types/local-delivery.ts`) as the cross-process source of truth, and
 * re-exported here for back-compat with existing `@toon-protocol/connector`
 * consumers (and the connector's public `lib.ts`).
 */
export type { PaymentRequest, PaymentResponse };

/**
 * Simple payment handler function type.
 * Users implement this to handle inbound payments.
 */
export type PaymentHandler = (request: PaymentRequest) => Promise<PaymentResponse>;

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/**
 * Semantic reject codes accepted from external `PaymentHandler` callbacks.
 *
 * Published vocabulary for `rejectReason.code`. Adding a new code requires
 * both extending this union and adding the matching wire-code entry to
 * `REJECT_CODE_MAP` — the `satisfies` constraint on the map enforces
 * parity at compile time.
 */
export type AcceptedSemanticCode =
  | 'insufficient_funds'
  | 'expired'
  | 'unreachable'
  | 'invalid_request'
  | 'invalid_amount'
  | 'insufficient_destination_amount'
  | 'unexpected_payment'
  | 'application_error'
  | 'internal_error'
  | 'timeout'
  | 'stale_rate';

/**
 * Map business reject codes to ILP wire codes (RFC 0027).
 *
 * Consumed by `mapRejectCode()` to translate `rejectReason.code` from
 * `PaymentHandler` callbacks. Unknown keys fall through to `F99`.
 */
export const REJECT_CODE_MAP: Record<string, string> = {
  insufficient_funds: 'T04',
  expired: 'R00',
  unreachable: 'F02',
  invalid_request: 'F00',
  invalid_amount: 'F03',
  insufficient_destination_amount: 'F04',
  unexpected_payment: 'F06',
  application_error: 'F99',
  internal_error: 'T00',
  timeout: 'T00',
  // Swap-mill benign staleness reject (toon-protocol/swap#53): the mill
  // rejects with code/message 'stale_rate' (data.reason === 'stale_rate')
  // when its quoted rate has expired. T99 — temporary, application-layer,
  // retryable: the sender should re-quote and retry. Without this entry the
  // code fell through to fatal F99.
  stale_rate: 'T99',
} satisfies Record<AcceptedSemanticCode, string>;

// ────────────────────────────────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────────────────────────────────

/**
 * Generate a random payment ID.
 *
 * @returns URL-safe base64 string (16 random bytes)
 */
export function generatePaymentId(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * Map a business reject code to an ILP error code.
 *
 * @param code - Business error code (e.g., 'insufficient_funds')
 * @returns ILP error code (e.g., 'T04'), defaults to 'F99'
 */
export function mapRejectCode(code: string): string {
  return REJECT_CODE_MAP[code] ?? 'F99';
}

/**
 * Validate response data for inclusion in ILP packets.
 * Returns the data unchanged if valid base64 and within 32KB limit.
 * Returns undefined (with warning log) if invalid.
 *
 * @param data - Base64-encoded response data
 * @param logger - Logger for warnings
 * @returns Validated data or undefined
 */
export function validateResponseData(data: string | undefined, logger: Logger): string | undefined {
  if (!data) return data;

  try {
    const decoded = Buffer.from(data, 'base64');
    // Verify round-trip (catches non-base64 strings that Buffer.from silently decodes)
    if (decoded.toString('base64') !== data) {
      logger.warn('Response data is not valid base64, omitting from ILP response');
      return undefined;
    }
    if (decoded.length > ILP_MAX_DATA_BYTES) {
      logger.warn(
        { size: decoded.length, limit: ILP_MAX_DATA_BYTES },
        'Response data exceeds 32KB ILP limit, omitting from ILP response'
      );
      return undefined;
    }
    return data;
  } catch {
    logger.warn('Response data failed base64 decode, omitting from ILP response');
    return undefined;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Adapter Factory
// ────────────────────────────────────────────────────────────────────────────

/**
 * Create a LocalDeliveryHandler adapter that wraps a simple PaymentHandler.
 *
 * The adapter handles:
 * 1. Packet expiry checks (→ R00 reject)
 * 2. LocalDeliveryRequest → PaymentRequest transformation
 * 3. User handler invocation (catches throws → T00 reject)
 * 4. PaymentResponse → LocalDeliveryResponse transformation
 *    (mapping reject codes on reject)
 *
 * @param handler - Simple payment handler function
 * @param logger - Logger instance
 * @returns LocalDeliveryHandler that can be passed to PacketHandler
 */
export function createPaymentHandlerAdapter(
  handler: PaymentHandler,
  logger: Logger
): LocalDeliveryHandler {
  return async (packet: LocalDeliveryRequest): Promise<LocalDeliveryResponse> => {
    // 1. Check if payment has expired
    const expiresAtDate = new Date(packet.expiresAt);
    if (expiresAtDate < new Date()) {
      logger.warn({ expiresAt: packet.expiresAt }, 'Payment expired');
      return {
        reject: {
          code: 'R00',
          message: 'Payment has expired',
        },
      };
    }

    // 2. Transform LocalDeliveryRequest → PaymentRequest
    const paymentId = generatePaymentId();
    const paymentRequest: PaymentRequest = {
      paymentId,
      destination: packet.destination,
      amount: packet.amount,
      expiresAt: packet.expiresAt,
      data: packet.data || undefined,
      isTransit: packet.isTransit,
    };

    // 3. Call user handler
    let response: PaymentResponse;
    try {
      response = await handler(paymentRequest);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ paymentId, error: msg }, 'Payment handler threw an error');
      return {
        reject: {
          code: 'T00',
          message: 'Internal error processing payment',
        },
      };
    }

    // 4. Transform PaymentResponse → LocalDeliveryResponse
    if (response.accept) {
      logger.info({ paymentId, amount: packet.amount }, 'Payment fulfilled');

      return {
        fulfill: {
          data: validateResponseData(response.data, logger),
        },
      };
    } else {
      // Map reject code
      const ilpCode = response.rejectReason ? mapRejectCode(response.rejectReason.code) : 'F99';
      const message = response.rejectReason?.message ?? 'Payment rejected';

      logger.info({ paymentId, code: ilpCode, message }, 'Payment rejected');

      return {
        reject: {
          code: ilpCode,
          message,
          data: validateResponseData(response.data, logger),
        },
      };
    }
  };
}
