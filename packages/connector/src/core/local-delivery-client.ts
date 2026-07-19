/**
 * Local Delivery Client
 *
 * HTTP client for forwarding ILP packets to an external app
 * for local delivery handling. Sends simplified PaymentRequest/PaymentResponse
 * (no ILP knowledge required on the app side) and handles reject code mapping
 * and data validation internally.
 */

import { Logger } from 'pino';
import {
  ILPPreparePacket,
  ILPFulfillPacket,
  ILPRejectPacket,
  PacketType,
  ILPErrorCode,
} from '@toon-protocol/shared';
import { LocalDeliveryConfig } from '../config/types';
import {
  PaymentRequest,
  PaymentResponse,
  generatePaymentId,
  mapRejectCode,
  validateResponseData,
} from './payment-handler';

// Re-export for backward compatibility
export type { LocalDeliveryRequest, LocalDeliveryResponse } from '../config/types';

/**
 * Default configuration values.
 */
const DEFAULT_TIMEOUT = 30000; // 30 seconds

/**
 * Client for forwarding local delivery to an external app.
 */
export class LocalDeliveryClient {
  private readonly config: Required<LocalDeliveryConfig>;
  private readonly logger: Logger;

  constructor(config: LocalDeliveryConfig, logger: Logger) {
    this.config = {
      enabled: config.enabled ?? false,
      handlerUrl: config.handlerUrl ?? '',
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      authToken: config.authToken ?? '',
      perHopNotification: config.perHopNotification ?? false,
    };
    this.logger = logger.child({ component: 'LocalDeliveryClient' });

    if (this.config.enabled && !this.config.handlerUrl) {
      throw new Error('LOCAL_DELIVERY_URL is required when local delivery is enabled');
    }
  }

  /**
   * Check if local delivery is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Check if per-hop app notification is enabled for transit packets.
   */
  isPerHopNotificationEnabled(): boolean {
    return this.config.perHopNotification;
  }

  /**
   * Forward a packet to the app handler for local delivery.
   *
   * Sends a simplified PaymentRequest (no ILP internals exposed) and maps
   * the PaymentResponse back to ILP fulfill/reject packets internally.
   *
   * @param packet - ILP Prepare packet
   * @param _sourcePeer - Peer that sent this packet (unused, kept for interface compat)
   * @param options - Optional delivery options
   * @returns ILP Fulfill or Reject packet
   */
  async deliver(
    packet: ILPPreparePacket,
    _sourcePeer: string,
    options?: { isTransit?: boolean }
  ): Promise<ILPFulfillPacket | ILPRejectPacket> {
    // Check expiry before making the HTTP call
    if (packet.expiresAt < new Date()) {
      this.logger.warn(
        { destination: packet.destination, expiresAt: packet.expiresAt.toISOString() },
        'Payment expired before delivery'
      );
      return {
        type: PacketType.REJECT,
        code: ILPErrorCode.R00_TRANSFER_TIMED_OUT,
        triggeredBy: '',
        message: 'Payment has expired',
        data: Buffer.alloc(0),
      };
    }

    const url = `${this.config.handlerUrl}/handle-packet`;
    const paymentId = generatePaymentId();

    // Sender-chosen execution condition (issue #309): forwarded to the app iff
    // the PREPARE carries a non-zero condition. The app must answer an accept
    // with the matching preimage in PaymentResponse.fulfillment; the
    // PacketHandler enforces sha256(fulfillment) == condition on the way back.
    const executionCondition =
      packet.executionCondition && !Buffer.from(packet.executionCondition).every((b) => b === 0)
        ? Buffer.from(packet.executionCondition).toString('base64')
        : undefined;

    const request: PaymentRequest = {
      paymentId,
      destination: packet.destination,
      amount: packet.amount.toString(),
      expiresAt: packet.expiresAt.toISOString(),
      data: packet.data.length > 0 ? packet.data.toString('base64') : undefined,
      isTransit: options?.isTransit,
      executionCondition,
    };

    this.logger.debug(
      { paymentId, destination: request.destination, amount: request.amount, url },
      'Forwarding packet to app handler'
    );

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Try to get error details from response body
        let errorDetails = '';
        try {
          const errorBody = await response.json();
          errorDetails = JSON.stringify(errorBody);
        } catch {
          errorDetails = await response.text().catch(() => '');
        }

        this.logger.error(
          {
            status: response.status,
            paymentId,
            destination: request.destination,
            errorBody: errorDetails,
          },
          'App handler returned error status'
        );

        return {
          type: PacketType.REJECT,
          code: ILPErrorCode.T00_INTERNAL_ERROR,
          triggeredBy: '',
          message: `App handler returned status ${response.status}: ${errorDetails}`,
          data: Buffer.alloc(0),
        };
      }

      const result = (await response.json()) as PaymentResponse;

      // Validate response shape
      if (typeof result.accept !== 'boolean') {
        this.logger.error(
          { paymentId, destination: request.destination },
          'App handler returned malformed response (missing accept field)'
        );

        return {
          type: PacketType.REJECT,
          code: ILPErrorCode.T00_INTERNAL_ERROR,
          triggeredBy: '',
          message: 'Malformed response from app handler',
          data: Buffer.alloc(0),
        };
      }

      if (result.accept) {
        const validatedData = validateResponseData(result.data, this.logger);

        this.logger.info(
          { paymentId, destination: request.destination, amount: request.amount },
          'Packet fulfilled by app handler'
        );

        return {
          type: PacketType.FULFILL,
          // App-supplied FULFILL preimage (issue #309) — required when the
          // request carried executionCondition; verified by the PacketHandler.
          fulfillment: this.decodeFulfillment(result.fulfillment, paymentId),
          data: validatedData ? Buffer.from(validatedData, 'base64') : Buffer.alloc(0),
        };
      } else {
        // Map business reject code to ILP error code
        const ilpCode = result.rejectReason ? mapRejectCode(result.rejectReason.code) : 'F99';
        const message = result.rejectReason?.message ?? 'Payment rejected';
        const validatedData = validateResponseData(result.data, this.logger);

        this.logger.info(
          { paymentId, destination: request.destination, code: ilpCode, message },
          'Packet rejected by app handler'
        );

        return {
          type: PacketType.REJECT,
          code: ilpCode as ILPErrorCode,
          triggeredBy: '',
          message,
          data: validatedData ? Buffer.from(validatedData, 'base64') : Buffer.alloc(0),
        };
      }
    } catch (error) {
      this.logger.error(
        { paymentId, destination: request.destination, error },
        'Failed to forward packet to app handler'
      );

      if (error instanceof Error && error.name === 'AbortError') {
        return {
          type: PacketType.REJECT,
          code: ILPErrorCode.R00_TRANSFER_TIMED_OUT,
          triggeredBy: '',
          message: 'App handler request timed out',
          data: Buffer.alloc(0),
        };
      }

      return {
        type: PacketType.REJECT,
        code: ILPErrorCode.T00_INTERNAL_ERROR,
        triggeredBy: '',
        message: error instanceof Error ? error.message : 'Unknown error',
        data: Buffer.alloc(0),
      };
    }
  }

  /**
   * Decode an app-supplied base64 fulfillment preimage (issue #309).
   * Returns the 32-byte preimage, or undefined when absent/malformed —
   * a malformed preimage is treated as withheld (the PacketHandler then
   * rejects with F99 when a sender-chosen condition required it).
   */
  private decodeFulfillment(
    fulfillment: string | undefined,
    paymentId: string
  ): Uint8Array | undefined {
    if (!fulfillment) {
      return undefined;
    }
    const decoded = Buffer.from(fulfillment, 'base64');
    if (decoded.length !== 32) {
      this.logger.warn(
        { paymentId, decodedLength: decoded.length },
        'App-supplied fulfillment is not 32 bytes after base64 decode; treating as withheld'
      );
      return undefined;
    }
    return new Uint8Array(decoded);
  }

  /**
   * Check if the app handler is healthy.
   */
  async healthCheck(): Promise<boolean> {
    if (!this.config.enabled) {
      return true;
    }

    const url = `${this.config.handlerUrl}/health`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      return response.ok;
    } catch {
      return false;
    }
  }
}
