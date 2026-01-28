import type { NostrEvent } from '../../toon-codec';
import {
  parseDVMJobRequest,
  parseTaskDelegationRequest,
  DVMParseError,
  DVM_ERROR_CODES,
  DVM_KIND_RANGE,
} from '../index';

/**
 * Creates a test DVM job event with optional overrides.
 */
function createDVMJobEvent(overrides?: Partial<NostrEvent>): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    kind: 5000,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [['i', 'test input', 'text']],
    sig: 'c'.repeat(128),
    ...overrides,
  };
}

describe('parseDVMJobRequest', () => {
  describe('kind validation', () => {
    it('should accept kind 5000 (minimum valid)', () => {
      // Arrange
      const event = createDVMJobEvent({ kind: 5000 });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.kind).toBe(5000);
    });

    it('should accept kind 5999 (maximum valid)', () => {
      // Arrange
      const event = createDVMJobEvent({ kind: 5999 });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.kind).toBe(5999);
    });

    it('should accept kind 5500 (middle of range)', () => {
      // Arrange
      const event = createDVMJobEvent({ kind: 5500 });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.kind).toBe(5500);
    });

    it('should reject kind 4999 (below range)', () => {
      // Arrange
      const event = createDVMJobEvent({ kind: 4999 });

      // Act & Assert
      expect(() => parseDVMJobRequest(event)).toThrow(DVMParseError);
      try {
        parseDVMJobRequest(event);
      } catch (error) {
        expect(error).toBeInstanceOf(DVMParseError);
        expect((error as DVMParseError).code).toBe(DVM_ERROR_CODES.INVALID_KIND);
        expect((error as DVMParseError).field).toBe('kind');
      }
    });

    it('should reject kind 6000 (above range)', () => {
      // Arrange
      const event = createDVMJobEvent({ kind: 6000 });

      // Act & Assert
      expect(() => parseDVMJobRequest(event)).toThrow(DVMParseError);
      try {
        parseDVMJobRequest(event);
      } catch (error) {
        expect(error).toBeInstanceOf(DVMParseError);
        expect((error as DVMParseError).code).toBe(DVM_ERROR_CODES.INVALID_KIND);
      }
    });

    it('should reject kind 1 (regular note)', () => {
      // Arrange
      const event = createDVMJobEvent({ kind: 1 });

      // Act & Assert
      expect(() => parseDVMJobRequest(event)).toThrow(DVMParseError);
    });
  });

  describe('input tag parsing', () => {
    it('should parse text input type', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [['i', 'Hello world', 'text']],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.inputs).toHaveLength(1);
      expect(result.inputs[0]).toEqual({
        data: 'Hello world',
        type: 'text',
      });
    });

    it('should parse url input type', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [['i', 'https://example.com/article.txt', 'url']],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.inputs).toHaveLength(1);
      expect(result.inputs[0]).toEqual({
        data: 'https://example.com/article.txt',
        type: 'url',
      });
    });

    it('should parse event input type', () => {
      // Arrange
      const eventId = 'd'.repeat(64);
      const event = createDVMJobEvent({
        tags: [['i', eventId, 'event']],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.inputs).toHaveLength(1);
      expect(result.inputs[0]).toEqual({
        data: eventId,
        type: 'event',
      });
    });

    it('should parse job input type', () => {
      // Arrange
      const jobResultId = 'e'.repeat(64);
      const event = createDVMJobEvent({
        tags: [['i', jobResultId, 'job']],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.inputs).toHaveLength(1);
      expect(result.inputs[0]).toEqual({
        data: jobResultId,
        type: 'job',
      });
    });

    it('should parse input with relay hint', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [['i', 'd'.repeat(64), 'event', 'wss://relay.example.com']],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.inputs[0]).toEqual({
        data: 'd'.repeat(64),
        type: 'event',
        relay: 'wss://relay.example.com',
      });
    });

    it('should parse input with relay hint and marker', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [['i', 'es', 'text', '', 'target_language']],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.inputs[0]).toEqual({
        data: 'es',
        type: 'text',
        marker: 'target_language',
      });
    });

    it('should parse input with both relay hint and marker', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [['i', 'd'.repeat(64), 'event', 'wss://relay.example.com', 'source']],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.inputs[0]).toEqual({
        data: 'd'.repeat(64),
        type: 'event',
        relay: 'wss://relay.example.com',
        marker: 'source',
      });
    });

    it('should parse multiple inputs in single request', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', 'What is the BTC price?', 'text'],
          ['i', 'https://example.com/data.json', 'url'],
          ['i', 'd'.repeat(64), 'event', 'wss://relay.example.com'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.inputs).toHaveLength(3);
      expect(result.inputs[0]!.type).toBe('text');
      expect(result.inputs[1]!.type).toBe('url');
      expect(result.inputs[2]!.type).toBe('event');
    });

    it('should return empty inputs array when no i tags present', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [['output', 'application/json']],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.inputs).toEqual([]);
    });

    it('should skip malformed i tags with less than 3 elements', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', 'only-data'], // Missing type
          ['i', 'valid input', 'text'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.inputs).toHaveLength(1);
      expect(result.inputs[0]!.data).toBe('valid input');
    });

    it('should throw DVMParseError for invalid input type', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [['i', 'some data', 'unknown_type']],
      });

      // Act & Assert
      expect(() => parseDVMJobRequest(event)).toThrow(DVMParseError);
      try {
        parseDVMJobRequest(event);
      } catch (error) {
        expect(error).toBeInstanceOf(DVMParseError);
        expect((error as DVMParseError).code).toBe(DVM_ERROR_CODES.INVALID_INPUT_TYPE);
        expect((error as DVMParseError).field).toBe('i');
        expect((error as DVMParseError).message).toContain('unknown_type');
      }
    });
  });

  describe('output tag parsing', () => {
    it('should parse output tag when present', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', 'test', 'text'],
          ['output', 'application/json'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.outputType).toBe('application/json');
    });

    it('should return undefined when output tag absent', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [['i', 'test', 'text']],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.outputType).toBeUndefined();
    });

    it('should parse text/plain output type', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', 'test', 'text'],
          ['output', 'text/plain'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.outputType).toBe('text/plain');
    });
  });

  describe('param tag parsing', () => {
    it('should parse single param tag', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', 'test', 'text'],
          ['param', 'format', 'detailed'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.params.size).toBe(1);
      expect(result.params.get('format')).toBe('detailed');
    });

    it('should parse multiple param tags', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', 'test', 'text'],
          ['param', 'format', 'detailed'],
          ['param', 'currency', 'USD'],
          ['param', 'language', 'en'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.params.size).toBe(3);
      expect(result.params.get('format')).toBe('detailed');
      expect(result.params.get('currency')).toBe('USD');
      expect(result.params.get('language')).toBe('en');
    });

    it('should handle duplicate param keys (last value wins)', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', 'test', 'text'],
          ['param', 'format', 'brief'],
          ['param', 'format', 'detailed'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.params.size).toBe(1);
      expect(result.params.get('format')).toBe('detailed');
    });

    it('should return empty Map when no param tags present', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [['i', 'test', 'text']],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.params.size).toBe(0);
    });
  });

  describe('bid tag parsing', () => {
    it('should parse valid bid as bigint', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', 'test', 'text'],
          ['bid', '5000'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.bid).toBe(5000n);
    });

    it('should parse large bid values', () => {
      // Arrange
      const largeBid = '9007199254740993'; // Larger than Number.MAX_SAFE_INTEGER
      const event = createDVMJobEvent({
        tags: [
          ['i', 'test', 'text'],
          ['bid', largeBid],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.bid).toBe(9007199254740993n);
    });

    it('should return undefined when bid tag absent', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [['i', 'test', 'text']],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.bid).toBeUndefined();
    });

    it('should throw DVMParseError for non-numeric bid', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', 'test', 'text'],
          ['bid', 'not_a_number'],
        ],
      });

      // Act & Assert
      expect(() => parseDVMJobRequest(event)).toThrow(DVMParseError);
      try {
        parseDVMJobRequest(event);
      } catch (error) {
        expect(error).toBeInstanceOf(DVMParseError);
        expect((error as DVMParseError).code).toBe(DVM_ERROR_CODES.INVALID_BID);
        expect((error as DVMParseError).field).toBe('bid');
        expect((error as DVMParseError).message).toContain('not_a_number');
      }
    });

    it('should throw DVMParseError for floating point bid', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', 'test', 'text'],
          ['bid', '5000.5'],
        ],
      });

      // Act & Assert
      expect(() => parseDVMJobRequest(event)).toThrow(DVMParseError);
    });
  });

  describe('relays tag parsing', () => {
    it('should parse relays tag with single URL', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', 'test', 'text'],
          ['relays', 'wss://relay1.example.com'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.relays).toEqual(['wss://relay1.example.com']);
    });

    it('should parse relays tag with multiple URLs', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', 'test', 'text'],
          [
            'relays',
            'wss://relay1.example.com',
            'wss://relay2.example.com',
            'wss://relay3.example.com',
          ],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.relays).toEqual([
        'wss://relay1.example.com',
        'wss://relay2.example.com',
        'wss://relay3.example.com',
      ]);
    });

    it('should return empty array when relays tag absent', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [['i', 'test', 'text']],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.relays).toEqual([]);
    });
  });

  describe('event reference preservation', () => {
    it('should preserve original event in result', () => {
      // Arrange
      const event = createDVMJobEvent({
        id: 'specific_id_' + 'a'.repeat(52),
        pubkey: 'specific_pubkey_' + 'b'.repeat(48),
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.event).toBe(event);
      expect(result.event.id).toBe(event.id);
      expect(result.event.pubkey).toBe(event.pubkey);
    });
  });

  describe('complete job request parsing', () => {
    it('should parse complete job request with all tag types', () => {
      // Arrange
      const event = createDVMJobEvent({
        kind: 5000,
        tags: [
          ['i', 'What is the current BTC price?', 'text'],
          ['i', 'https://example.com/context.txt', 'url'],
          ['output', 'application/json'],
          ['param', 'format', 'detailed'],
          ['param', 'currency', 'USD'],
          ['bid', '5000'],
          ['relays', 'wss://relay1.example.com', 'wss://relay2.example.com'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.kind).toBe(5000);
      expect(result.inputs).toHaveLength(2);
      expect(result.inputs[0]!.type).toBe('text');
      expect(result.inputs[1]!.type).toBe('url');
      expect(result.outputType).toBe('application/json');
      expect(result.params.get('format')).toBe('detailed');
      expect(result.params.get('currency')).toBe('USD');
      expect(result.bid).toBe(5000n);
      expect(result.relays).toHaveLength(2);
      expect(result.event).toBe(event);
    });

    it('should parse minimal valid job request', () => {
      // Arrange
      const event = createDVMJobEvent({
        kind: 5000,
        tags: [['i', 'Hello world', 'text']],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.kind).toBe(5000);
      expect(result.inputs).toHaveLength(1);
      expect(result.outputType).toBeUndefined();
      expect(result.params.size).toBe(0);
      expect(result.bid).toBeUndefined();
      expect(result.relays).toEqual([]);
    });

    it('should parse Kind 5100 translation request', () => {
      // Arrange
      const event = createDVMJobEvent({
        kind: 5100,
        tags: [
          ['i', 'https://example.com/article.txt', 'url'],
          ['i', 'es', 'text', '', 'target_language'],
          ['output', 'text/plain'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.kind).toBe(5100);
      expect(result.inputs).toHaveLength(2);
      expect(result.inputs[0]!.type).toBe('url');
      expect(result.inputs[1]!.type).toBe('text');
      expect(result.inputs[1]!.marker).toBe('target_language');
      expect(result.outputType).toBe('text/plain');
    });
  });

  describe('DVM_KIND_RANGE constant', () => {
    it('should have correct min and max values', () => {
      expect(DVM_KIND_RANGE.min).toBe(5000);
      expect(DVM_KIND_RANGE.max).toBe(5999);
    });
  });

  describe('DVM_ERROR_CODES constant', () => {
    it('should have all error codes', () => {
      expect(DVM_ERROR_CODES.INVALID_KIND).toBe('INVALID_KIND');
      expect(DVM_ERROR_CODES.INVALID_INPUT_TYPE).toBe('INVALID_INPUT_TYPE');
      expect(DVM_ERROR_CODES.INVALID_BID).toBe('INVALID_BID');
    });
  });

  describe('DVMParseError class', () => {
    it('should have correct name property', () => {
      const error = new DVMParseError('INVALID_KIND', 'test message');
      expect(error.name).toBe('DVMParseError');
    });

    it('should include field when provided', () => {
      const error = new DVMParseError('INVALID_BID', 'test message', 'bid');
      expect(error.field).toBe('bid');
    });

    it('should have undefined field when not provided', () => {
      const error = new DVMParseError('INVALID_KIND', 'test message');
      expect(error.field).toBeUndefined();
    });
  });

  describe('dependency tag parsing (job chaining)', () => {
    it('should parse single dependency', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', '', 'job'],
          ['e', 'dep1-event-id', '', 'dependency'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.dependencies).toEqual(['dep1-event-id']);
    });

    it('should parse multiple dependencies', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', '', 'job'],
          ['e', 'dep1-event-id', '', 'dependency'],
          ['e', 'dep2-event-id', '', 'dependency'],
          ['e', 'dep3-event-id', '', 'dependency'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.dependencies).toEqual(['dep1-event-id', 'dep2-event-id', 'dep3-event-id']);
    });

    it('should parse dependency with relay hint', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', '', 'job'],
          ['e', 'dep1-event-id', 'wss://relay.example.com', 'dependency'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.dependencies).toEqual(['dep1-event-id']);
    });

    it('should return empty array when no dependency tags', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [['i', 'test', 'text']],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.dependencies).toEqual([]);
    });

    it('should ignore e tags without dependency marker', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', 'test', 'text'],
          ['e', 'some-event-id', '', 'reply'], // Different marker
          ['e', 'another-event-id'], // No marker
          ['e', 'dep1-event-id', '', 'dependency'], // Valid dependency
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.dependencies).toEqual(['dep1-event-id']);
      expect(result.dependencies).toHaveLength(1);
    });

    it('should handle job input type with dependencies', () => {
      // Arrange
      const event = createDVMJobEvent({
        kind: 5200, // Text summarization
        tags: [
          ['i', '', 'job'], // Job input type
          ['e', 'translation-job-id', 'wss://relay.example.com', 'dependency'],
          ['output', 'text/plain'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.inputs).toHaveLength(1);
      expect(result.inputs[0]!.type).toBe('job');
      expect(result.inputs[0]!.data).toBe('');
      expect(result.dependencies).toEqual(['translation-job-id']);
    });

    it('should parse mixed e tags and dependency tags', () => {
      // Arrange
      const event = createDVMJobEvent({
        tags: [
          ['i', 'test', 'text'],
          ['e', 'reference-event-id'], // Regular e tag (no marker)
          ['e', 'dep1-event-id', '', 'dependency'],
          ['e', 'reply-event-id', '', 'reply'],
          ['e', 'dep2-event-id', '', 'dependency'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.dependencies).toEqual(['dep1-event-id', 'dep2-event-id']);
      expect(result.dependencies).toHaveLength(2);
    });

    it('should handle complete job chaining request', () => {
      // Arrange
      const event = createDVMJobEvent({
        kind: 5200, // Text summarization
        tags: [
          ['i', '', 'job'],
          ['i', 'es', 'text', '', 'language'],
          ['e', 'translation-job-id', '', 'dependency'],
          ['output', 'text/plain'],
          ['param', 'max_length', '500'],
        ],
      });

      // Act
      const result = parseDVMJobRequest(event);

      // Assert
      expect(result.kind).toBe(5200);
      expect(result.inputs).toHaveLength(2);
      expect(result.inputs[0]!.type).toBe('job');
      expect(result.dependencies).toEqual(['translation-job-id']);
      expect(result.outputType).toBe('text/plain');
      expect(result.params.get('max_length')).toBe('500');
    });
  });

  describe('parseTaskDelegationRequest (Kind 5900)', () => {
    it('should parse Kind 5900 with all task delegation fields', () => {
      // Arrange
      const event = createDVMJobEvent({
        kind: 5900,
        tags: [
          ['i', 'Translate this text', 'text'],
          ['output', 'application/json'],
          ['timeout', '30'],
          ['p', 'agent-pubkey-1'],
          ['p', 'agent-pubkey-2'],
          ['priority', 'high'],
          ['schema', 'https://example.com/schema.json'],
        ],
      });

      // Act
      const result = parseTaskDelegationRequest(event);

      // Assert
      expect(result.kind).toBe(5900);
      expect(result.timeout).toBe(30);
      expect(result.preferredAgents).toEqual(['agent-pubkey-1', 'agent-pubkey-2']);
      expect(result.priority).toBe('high');
      expect(result.schema).toBe('https://example.com/schema.json');
    });

    it('should use default priority when not specified', () => {
      // Arrange
      const event = createDVMJobEvent({
        kind: 5900,
        tags: [['i', 'Task', 'text']],
      });

      // Act
      const result = parseTaskDelegationRequest(event);

      // Assert
      expect(result.priority).toBe('normal');
    });

    it('should handle timeout as undefined when not present', () => {
      // Arrange
      const event = createDVMJobEvent({
        kind: 5900,
        tags: [['i', 'Task', 'text']],
      });

      // Act
      const result = parseTaskDelegationRequest(event);

      // Assert
      expect(result.timeout).toBeUndefined();
    });

    it('should handle schema as undefined when not present', () => {
      // Arrange
      const event = createDVMJobEvent({
        kind: 5900,
        tags: [['i', 'Task', 'text']],
      });

      // Act
      const result = parseTaskDelegationRequest(event);

      // Assert
      expect(result.schema).toBeUndefined();
    });

    it('should parse empty preferred agents array', () => {
      // Arrange
      const event = createDVMJobEvent({
        kind: 5900,
        tags: [['i', 'Task', 'text']],
      });

      // Act
      const result = parseTaskDelegationRequest(event);

      // Assert
      expect(result.preferredAgents).toEqual([]);
    });

    it('should reject non-5900 kinds', () => {
      // Arrange
      const event = createDVMJobEvent({
        kind: 5000,
        tags: [['i', 'Task', 'text']],
      });

      // Act & Assert
      expect(() => parseTaskDelegationRequest(event)).toThrow(DVMParseError);
      try {
        parseTaskDelegationRequest(event);
      } catch (error) {
        expect(error).toBeInstanceOf(DVMParseError);
        expect((error as DVMParseError).code).toBe(DVM_ERROR_CODES.INVALID_KIND);
        expect((error as DVMParseError).message).toContain('5900');
      }
    });

    it('should parse all priority levels', () => {
      // Arrange & Act & Assert
      const priorities: Array<'high' | 'normal' | 'low'> = ['high', 'normal', 'low'];

      for (const priority of priorities) {
        const event = createDVMJobEvent({
          kind: 5900,
          tags: [
            ['i', 'Task', 'text'],
            ['priority', priority],
          ],
        });

        const result = parseTaskDelegationRequest(event);
        expect(result.priority).toBe(priority);
      }
    });

    it('should normalize priority to lowercase', () => {
      // Arrange
      const event = createDVMJobEvent({
        kind: 5900,
        tags: [
          ['i', 'Task', 'text'],
          ['priority', 'HIGH'],
        ],
      });

      // Act
      const result = parseTaskDelegationRequest(event);

      // Assert
      expect(result.priority).toBe('high');
    });

    it('should default to normal for invalid priority', () => {
      // Arrange
      const event = createDVMJobEvent({
        kind: 5900,
        tags: [
          ['i', 'Task', 'text'],
          ['priority', 'invalid'],
        ],
      });

      // Act
      const result = parseTaskDelegationRequest(event);

      // Assert
      expect(result.priority).toBe('normal');
    });

    it('should ignore invalid timeout values', () => {
      // Arrange
      const event = createDVMJobEvent({
        kind: 5900,
        tags: [
          ['i', 'Task', 'text'],
          ['timeout', 'not-a-number'],
        ],
      });

      // Act
      const result = parseTaskDelegationRequest(event);

      // Assert
      expect(result.timeout).toBeUndefined();
    });

    it('should ignore negative timeout values', () => {
      // Arrange
      const event = createDVMJobEvent({
        kind: 5900,
        tags: [
          ['i', 'Task', 'text'],
          ['timeout', '-10'],
        ],
      });

      // Act
      const result = parseTaskDelegationRequest(event);

      // Assert
      expect(result.timeout).toBeUndefined();
    });
  });
});
