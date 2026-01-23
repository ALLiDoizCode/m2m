import { encode, decode } from '@toon-format/toon';

/**
 * Nostr event structure per NIP-01 specification.
 * All fields must be preserved exactly during encoding/decoding.
 */
export interface NostrEvent {
  id: string; // 32-byte lowercase hex SHA-256 of serialized event
  pubkey: string; // 32-byte lowercase hex public key
  created_at: number; // Unix timestamp in seconds
  kind: number; // Event kind integer
  tags: string[][]; // Array of tag arrays
  content: string; // Event content (may be JSON for some kinds)
  sig: string; // 64-byte lowercase hex Schnorr signature
}

/**
 * Error thrown when TOON encoding fails.
 */
export class ToonEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToonEncodeError';
  }
}

/**
 * Error thrown when TOON decoding fails.
 */
export class ToonDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToonDecodeError';
  }
}

/**
 * Error thrown when event validation fails.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const REQUIRED_FIELDS: (keyof NostrEvent)[] = [
  'id',
  'pubkey',
  'created_at',
  'kind',
  'tags',
  'content',
  'sig',
];

/**
 * Validates that an object has all required NostrEvent fields with correct types.
 */
function validateNostrEvent(obj: unknown, context: string): asserts obj is NostrEvent {
  if (typeof obj !== 'object' || obj === null) {
    throw new ValidationError(`${context}: Expected object, got ${typeof obj}`);
  }

  const event = obj as Record<string, unknown>;

  for (const field of REQUIRED_FIELDS) {
    if (!(field in event)) {
      throw new ValidationError(`Missing required field: ${field}`);
    }
  }

  // Type validation
  if (typeof event.id !== 'string') {
    throw new ValidationError(`Invalid type for field: id (expected string)`);
  }
  if (typeof event.pubkey !== 'string') {
    throw new ValidationError(`Invalid type for field: pubkey (expected string)`);
  }
  if (typeof event.created_at !== 'number') {
    throw new ValidationError(`Invalid type for field: created_at (expected number)`);
  }
  if (typeof event.kind !== 'number') {
    throw new ValidationError(`Invalid type for field: kind (expected number)`);
  }
  if (!Array.isArray(event.tags)) {
    throw new ValidationError(`Invalid type for field: tags (expected array)`);
  }
  if (typeof event.content !== 'string') {
    throw new ValidationError(`Invalid type for field: content (expected string)`);
  }
  if (typeof event.sig !== 'string') {
    throw new ValidationError(`Invalid type for field: sig (expected string)`);
  }
}

/**
 * ToonCodec provides TOON encoding/decoding for Nostr events.
 *
 * TOON (Token-Oriented Object Notation) achieves ~40% size reduction
 * compared to JSON, making it efficient for ILP packet data fields.
 */
export class ToonCodec {
  /**
   * Encodes a single Nostr event to a Buffer using TOON format.
   *
   * @param event - The Nostr event to encode
   * @returns Buffer containing TOON-serialized data
   * @throws ToonEncodeError if encoding fails
   * @throws ValidationError if event is missing required fields
   */
  encode(event: NostrEvent): Buffer {
    validateNostrEvent(event, 'encode');

    try {
      const toonString = encode(event);
      return Buffer.from(toonString, 'utf-8');
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown encoding error';
      throw new ToonEncodeError(`Failed to encode event: ${message}`);
    }
  }

  /**
   * Decodes a Buffer containing TOON data back to a Nostr event.
   *
   * @param buffer - Buffer containing TOON-serialized event
   * @returns The decoded Nostr event
   * @throws ToonDecodeError if the buffer contains invalid TOON data
   * @throws ValidationError if decoded object is missing required fields
   */
  decode(buffer: Buffer): NostrEvent {
    if (!Buffer.isBuffer(buffer)) {
      throw new ToonDecodeError('Invalid input: expected Buffer');
    }

    try {
      const toonString = buffer.toString('utf-8');
      const decoded = decode(toonString);

      validateNostrEvent(decoded, 'decode');

      return decoded;
    } catch (error) {
      if (error instanceof ValidationError || error instanceof ToonDecodeError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown decoding error';
      throw new ToonDecodeError(`Invalid TOON format: ${message}`);
    }
  }

  /**
   * Encodes an array of Nostr events to a single Buffer.
   *
   * @param events - Array of Nostr events to encode
   * @returns Buffer containing TOON-serialized array
   * @throws ToonEncodeError if encoding fails
   * @throws ValidationError if any event is missing required fields
   */
  encodeMany(events: NostrEvent[]): Buffer {
    if (!Array.isArray(events)) {
      throw new ToonEncodeError('Expected array of events');
    }

    // Validate all events before encoding
    for (let i = 0; i < events.length; i++) {
      try {
        validateNostrEvent(events[i], `encodeMany[${i}]`);
      } catch (error) {
        if (error instanceof ValidationError) {
          throw new ValidationError(`Event at index ${i}: ${error.message}`);
        }
        throw error;
      }
    }

    try {
      const toonString = encode(events);
      return Buffer.from(toonString, 'utf-8');
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown encoding error';
      throw new ToonEncodeError(`Failed to encode events array: ${message}`);
    }
  }

  /**
   * Decodes a Buffer containing a TOON array back to an array of Nostr events.
   *
   * @param buffer - Buffer containing TOON-serialized array
   * @returns Array of decoded Nostr events
   * @throws ToonDecodeError if the buffer contains invalid TOON data
   * @throws ValidationError if any decoded event is missing required fields
   */
  decodeMany(buffer: Buffer): NostrEvent[] {
    if (!Buffer.isBuffer(buffer)) {
      throw new ToonDecodeError('Invalid input: expected Buffer');
    }

    try {
      const toonString = buffer.toString('utf-8');
      const decoded = decode(toonString);

      if (!Array.isArray(decoded)) {
        throw new ToonDecodeError('Expected array in TOON data');
      }

      // Validate each event
      for (let i = 0; i < decoded.length; i++) {
        try {
          validateNostrEvent(decoded[i], `decodeMany[${i}]`);
        } catch (error) {
          if (error instanceof ValidationError) {
            throw new ValidationError(`Event at index ${i}: ${error.message}`);
          }
          throw error;
        }
      }

      return decoded as unknown as NostrEvent[];
    } catch (error) {
      if (error instanceof ValidationError || error instanceof ToonDecodeError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown decoding error';
      throw new ToonDecodeError(`Invalid TOON format: ${message}`);
    }
  }
}
