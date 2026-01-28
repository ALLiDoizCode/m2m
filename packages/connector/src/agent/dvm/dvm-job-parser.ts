import type { NostrEvent } from '../toon-codec';
import {
  DVM_KIND_RANGE,
  DVM_ERROR_CODES,
  DVMParseError,
  type DVMJobRequest,
  type DVMInput,
  type DVMInputType,
  type TaskDelegationRequest,
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
 * Parses 'e' tags with 'dependency' marker from a DVM job request event.
 * Format: ['e', eventId, relay?, 'dependency']
 *
 * Used for job chaining where one job depends on previous job results.
 *
 * @param tags - The event tags array
 * @returns Array of dependency event IDs
 */
function parseDependencyTags(tags: string[][]): string[] {
  const dependencies: string[] = [];

  for (const tag of tags) {
    // 'e' tag format: ["e", "<event-id>", "<relay-url>", "<marker>"]
    if (tag[0] === 'e' && tag.length >= 2) {
      // Check for 'dependency' marker (4th element, index 3)
      const marker = tag[3];
      if (marker === 'dependency') {
        dependencies.push(tag[1] as string);
      }
    }
  }

  return dependencies;
}

/**
 * Parses 'timeout' tag from a task delegation request.
 * Format: ['timeout', seconds]
 *
 * @param tags - The event tags array
 * @returns Timeout in seconds or undefined if not present
 */
function parseTimeoutTag(tags: string[][]): number | undefined {
  for (const tag of tags) {
    if (tag[0] === 'timeout' && tag.length >= 2 && tag[1]) {
      const timeout = parseInt(tag[1], 10);
      if (!isNaN(timeout) && timeout > 0) {
        return timeout;
      }
    }
  }
  return undefined;
}

/**
 * Parses 'p' tags as preferred agent pubkeys for task delegation.
 * Format: ['p', pubkey]
 *
 * @param tags - The event tags array
 * @returns Array of preferred agent pubkeys
 */
function parsePreferredAgentsTags(tags: string[][]): string[] {
  const agents: string[] = [];

  for (const tag of tags) {
    if (tag[0] === 'p' && tag.length >= 2 && tag[1]) {
      agents.push(tag[1]);
    }
  }

  return agents;
}

/**
 * Parses 'priority' tag from a task delegation request.
 * Format: ['priority', 'high'|'normal'|'low']
 *
 * @param tags - The event tags array
 * @returns Task priority or 'normal' as default
 */
function parsePriorityTag(tags: string[][]): 'high' | 'normal' | 'low' {
  for (const tag of tags) {
    if (tag[0] === 'priority' && tag.length >= 2 && tag[1]) {
      const priority = tag[1].toLowerCase();
      if (priority === 'high' || priority === 'normal' || priority === 'low') {
        return priority;
      }
    }
  }
  return 'normal'; // Default priority
}

/**
 * Parses 'schema' tag from a task delegation request.
 * Format: ['schema', url]
 *
 * @param tags - The event tags array
 * @returns Schema URL or undefined if not present
 */
function parseSchemaTag(tags: string[][]): string | undefined {
  for (const tag of tags) {
    if (tag[0] === 'schema' && tag.length >= 2 && tag[1]) {
      return tag[1];
    }
  }
  return undefined;
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
    dependencies: parseDependencyTags(tags),
    event,
  };
}

/**
 * Parses a Kind 5900 task delegation request with agent-specific fields.
 *
 * Extends the standard DVM job request parsing with additional fields for
 * agent-to-agent task delegation: timeout, preferred agents, priority, and schema.
 *
 * @param event - The Nostr event to parse (must be Kind 5900)
 * @returns Parsed TaskDelegationRequest object
 * @throws DVMParseError if the event is not Kind 5900
 */
export function parseTaskDelegationRequest(event: NostrEvent): TaskDelegationRequest {
  // Validate kind is 5900
  if (event.kind !== 5900) {
    throw new DVMParseError(
      DVM_ERROR_CODES.INVALID_KIND,
      `Invalid kind for task delegation: ${event.kind}. Expected Kind 5900`,
      'kind'
    );
  }

  // Parse base DVM job request fields
  const baseRequest = parseDVMJobRequest(event);

  const tags = event.tags;

  // Parse task delegation-specific fields
  return {
    ...baseRequest,
    kind: 5900,
    timeout: parseTimeoutTag(tags),
    preferredAgents: parsePreferredAgentsTags(tags),
    priority: parsePriorityTag(tags),
    schema: parseSchemaTag(tags),
  };
}
