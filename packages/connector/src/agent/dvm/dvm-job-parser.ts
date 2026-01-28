import type { NostrEvent } from '../toon-codec';
import {
  DVM_KIND_RANGE,
  DVM_ERROR_CODES,
  DVMParseError,
  type DVMJobRequest,
  type DVMInput,
  type DVMInputType,
} from './types';

/** Valid input types for DVM job requests */
const VALID_INPUT_TYPES: Set<string> = new Set(['text', 'url', 'event', 'job']);

/**
 * Parses 'i' tags from a DVM job request event.
 * Format: ['i', data, type, relay?, marker?]
 *
 * @param tags - The event tags array
 * @returns Array of parsed DVMInput objects
 * @throws DVMParseError if an invalid input type is encountered
 */
function parseInputTags(tags: string[][]): DVMInput[] {
  const inputs: DVMInput[] = [];

  for (const tag of tags) {
    if (tag[0] !== 'i' || tag.length < 3) {
      continue;
    }

    // We've verified tag.length >= 3, so indices 1 and 2 are safe
    const data = tag[1] as string;
    const type = tag[2] as string;
    const relay = tag[3];
    const marker = tag[4];

    if (!VALID_INPUT_TYPES.has(type)) {
      throw new DVMParseError(
        DVM_ERROR_CODES.INVALID_INPUT_TYPE,
        `Invalid input type: '${type}'. Expected one of: text, url, event, job`,
        'i'
      );
    }

    const input: DVMInput = {
      data,
      type: type as DVMInputType,
    };

    if (relay && relay.length > 0) {
      input.relay = relay;
    }

    if (marker && marker.length > 0) {
      input.marker = marker;
    }

    inputs.push(input);
  }

  return inputs;
}

/**
 * Parses 'output' tag from a DVM job request event.
 * Format: ['output', mimeType]
 *
 * @param tags - The event tags array
 * @returns The output MIME type or undefined if not present
 */
function parseOutputTag(tags: string[][]): string | undefined {
  for (const tag of tags) {
    if (tag[0] === 'output' && tag.length >= 2) {
      return tag[1];
    }
  }
  return undefined;
}

/**
 * Parses 'param' tags from a DVM job request event.
 * Format: ['param', key, value]
 * Duplicate keys: last value wins.
 *
 * @param tags - The event tags array
 * @returns Map of parameter key-value pairs
 */
function parseParamTags(tags: string[][]): Map<string, string> {
  const params = new Map<string, string>();

  for (const tag of tags) {
    if (tag[0] === 'param' && tag.length >= 3) {
      // We've verified tag.length >= 3, so indices 1 and 2 are safe
      params.set(tag[1] as string, tag[2] as string);
    }
  }

  return params;
}

/**
 * Parses 'bid' tag from a DVM job request event.
 * Format: ['bid', amount]
 * Amount is in millisatoshis.
 *
 * @param tags - The event tags array
 * @returns The bid amount as bigint or undefined if not present
 * @throws DVMParseError if bid is not a valid number
 */
function parseBidTag(tags: string[][]): bigint | undefined {
  for (const tag of tags) {
    if (tag[0] === 'bid' && tag.length >= 2) {
      // We've verified tag.length >= 2, so index 1 is safe
      const bidValue = tag[1] as string;
      try {
        return BigInt(bidValue);
      } catch {
        throw new DVMParseError(
          DVM_ERROR_CODES.INVALID_BID,
          `Invalid bid amount: '${bidValue}'. Expected a valid integer`,
          'bid'
        );
      }
    }
  }
  return undefined;
}

/**
 * Parses 'relays' tag from a DVM job request event.
 * Format: ['relays', url1, url2, ...]
 *
 * @param tags - The event tags array
 * @returns Array of relay URLs
 */
function parseRelaysTag(tags: string[][]): string[] {
  for (const tag of tags) {
    if (tag[0] === 'relays' && tag.length >= 2) {
      return tag.slice(1);
    }
  }
  return [];
}

/**
 * Parses a NIP-90 DVM job request from a Nostr event.
 *
 * Extracts all DVM-specific tags (i, output, param, bid, relays) and
 * validates the event kind is in the valid DVM range (5000-5999).
 *
 * @param event - The Nostr event to parse
 * @returns Parsed DVMJobRequest object
 * @throws DVMParseError if the event is not a valid DVM job request
 */
export function parseDVMJobRequest(event: NostrEvent): DVMJobRequest {
  // Validate kind is in DVM range
  if (event.kind < DVM_KIND_RANGE.min || event.kind > DVM_KIND_RANGE.max) {
    throw new DVMParseError(
      DVM_ERROR_CODES.INVALID_KIND,
      `Invalid DVM kind: ${event.kind}. Expected kind in range ${DVM_KIND_RANGE.min}-${DVM_KIND_RANGE.max}`,
      'kind'
    );
  }

  const tags = event.tags;

  return {
    kind: event.kind,
    inputs: parseInputTags(tags),
    outputType: parseOutputTag(tags),
    params: parseParamTags(tags),
    bid: parseBidTag(tags),
    relays: parseRelaysTag(tags),
    event,
  };
}
