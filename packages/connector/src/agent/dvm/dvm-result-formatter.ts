import type { NostrEvent } from '../toon-codec';
import {
  DVM_RESULT_KIND_OFFSET,
  type DVMJobResult,
  type DVMResultEvent,
  type DVMResultStatus,
} from './types';

/**
 * Creates the 'request' tag containing the stringified original request event.
 *
 * @param requestEvent - The original DVM job request event
 * @returns Tag array ['request', stringified-event]
 */
function createRequestTag(requestEvent: NostrEvent): string[] {
  return ['request', JSON.stringify(requestEvent)];
}

/**
 * Creates the 'e' tag referencing the request event ID.
 *
 * @param requestEventId - The ID of the original request event
 * @returns Tag array ['e', event-id]
 */
function createEventTag(requestEventId: string): string[] {
  return ['e', requestEventId];
}

/**
 * Creates the 'p' tag with the requester's public key.
 *
 * @param requesterPubkey - The public key of the requester
 * @returns Tag array ['p', pubkey]
 */
function createPubkeyTag(requesterPubkey: string): string[] {
  return ['p', requesterPubkey];
}

/**
 * Creates the 'amount' tag with the payment amount as string.
 *
 * @param amount - The payment amount in millisatoshis
 * @returns Tag array ['amount', amount-string]
 */
function createAmountTag(amount: bigint): string[] {
  return ['amount', amount.toString()];
}

/**
 * Creates the 'status' tag with the result status.
 *
 * @param status - The result status (success, error, or partial)
 * @returns Tag array ['status', status]
 */
function createStatusTag(status: DVMResultStatus): string[] {
  return ['status', status];
}

/**
 * Formats content for the result event based on type and status.
 *
 * @param content - The content to format (string, object, or Buffer)
 * @param status - The result status
 * @returns Formatted content string
 */
function formatContent(content: string | object | Buffer, status: DVMResultStatus): string {
  // For error status, wrap non-JSON content in error object
  if (status === 'error') {
    if (typeof content === 'string') {
      // Check if it's already a valid JSON error object
      try {
        const parsed = JSON.parse(content);
        if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
          return content;
        }
      } catch {
        // Not JSON, continue to wrap
      }
      // Wrap plain string error in error object
      return JSON.stringify({ error: true, message: content });
    }
  }

  // Handle Buffer - convert to base64
  if (Buffer.isBuffer(content)) {
    return content.toString('base64');
  }

  // Handle object - stringify
  if (typeof content === 'object' && content !== null) {
    return JSON.stringify(content);
  }

  // Handle string - return as-is
  return content;
}

/**
 * Formats a DVM job result into an unsigned NIP-90 result event.
 *
 * Creates a Kind 6XXX event (request kind + 1000) with all required tags:
 * - request: Stringified original request event
 * - e: Reference to request event ID
 * - p: Requester's public key
 * - amount: Payment amount received
 * - status: Result status (success/error/partial)
 *
 * @param result - The DVM job result to format
 * @returns Unsigned DVMResultEvent ready for signing
 */
export function formatDVMJobResult(result: DVMJobResult): DVMResultEvent {
  const { requestEvent, content, amount, status } = result;

  // Calculate result kind: request kind + 1000
  const resultKind = requestEvent.kind + DVM_RESULT_KIND_OFFSET;

  // Build tags array
  const tags: string[][] = [
    createRequestTag(requestEvent),
    createEventTag(requestEvent.id),
    createPubkeyTag(requestEvent.pubkey),
    createAmountTag(amount),
    createStatusTag(status),
  ];

  // Format content based on type
  const formattedContent = formatContent(content, status);

  // Return unsigned event template
  return {
    id: '',
    pubkey: '',
    kind: resultKind,
    created_at: Math.floor(Date.now() / 1000),
    content: formattedContent,
    tags,
    sig: '',
  };
}

/**
 * Formats a DVM error result into an unsigned NIP-90 result event.
 *
 * Convenience function for creating error responses with proper structure:
 * { error: true, code: errorCode, message: errorMessage }
 *
 * @param requestEvent - The original DVM job request event
 * @param errorCode - Error code string (e.g., 'F99', 'INVALID_INPUT')
 * @param errorMessage - Human-readable error message
 * @param amount - Payment amount received (may be 0 if payment failed)
 * @returns Unsigned DVMResultEvent with error content
 */
export function formatDVMErrorResult(
  requestEvent: NostrEvent,
  errorCode: string,
  errorMessage: string,
  amount: bigint
): DVMResultEvent {
  const errorContent = {
    error: true,
    code: errorCode,
    message: errorMessage,
  };

  return formatDVMJobResult({
    requestEvent,
    content: errorContent,
    amount,
    status: 'error',
  });
}
