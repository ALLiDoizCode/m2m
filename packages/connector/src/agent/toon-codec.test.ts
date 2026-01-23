// Mock the ESM-only @toon-format/toon package
// Using JSON.stringify/parse as a stand-in for testing the codec wrapper logic
jest.mock('@toon-format/toon', () => ({
  encode: (input: unknown) => JSON.stringify(input),
  decode: (input: string) => JSON.parse(input),
}));

import {
  ToonCodec,
  NostrEvent,
  ToonEncodeError,
  ToonDecodeError,
  ValidationError,
} from './toon-codec';

/**
 * Creates a test Nostr event with default values that can be overridden.
 */
function createTestEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
    pubkey: 'def456abc123def456abc123def456abc123def456abc123def456abc123def4',
    created_at: 1706000000,
    kind: 1,
    tags: [],
    content: 'Hello, world!',
    sig: 'sig789abc123def456abc123def456abc123def456abc123def456abc123def456abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
    ...overrides,
  };
}

describe('ToonCodec', () => {
  let codec: ToonCodec;

  beforeEach(() => {
    codec = new ToonCodec();
  });

  describe('Single Event Encoding/Decoding', () => {
    describe('Kind 0 (Metadata)', () => {
      it('should encode and decode Kind 0 metadata event losslessly', () => {
        const event = createTestEvent({
          kind: 0,
          content: JSON.stringify({
            name: 'Alice',
            about: 'A test user',
            picture: 'https://example.com/avatar.png',
          }),
        });

        const encoded = codec.encode(event);
        const decoded = codec.decode(encoded);

        expect(decoded).toEqual(event);
      });

      it('should preserve JSON content in metadata', () => {
        const metadata = { name: 'Bob', nip05: 'bob@example.com' };
        const event = createTestEvent({
          kind: 0,
          content: JSON.stringify(metadata),
        });

        const decoded = codec.decode(codec.encode(event));
        expect(JSON.parse(decoded.content)).toEqual(metadata);
      });
    });

    describe('Kind 1 (Text Note)', () => {
      it('should encode and decode Kind 1 text note losslessly', () => {
        const event = createTestEvent({
          kind: 1,
          content: 'Hello, world!',
          tags: [
            ['e', 'replyto123', '', 'reply'],
            ['p', 'mentionpubkey123'],
          ],
        });

        const encoded = codec.encode(event);
        const decoded = codec.decode(encoded);

        expect(decoded).toEqual(event);
      });

      it('should preserve unicode content', () => {
        const event = createTestEvent({
          kind: 1,
          content: '你好世界 🌍 مرحبا بالعالم',
        });

        const decoded = codec.decode(codec.encode(event));
        expect(decoded.content).toBe('你好世界 🌍 مرحبا بالعالم');
      });

      it('should handle special characters in content', () => {
        const event = createTestEvent({
          kind: 1,
          content: 'Line1\nLine2\tTabbed\r\nWindows',
        });

        const decoded = codec.decode(codec.encode(event));
        expect(decoded.content).toBe('Line1\nLine2\tTabbed\r\nWindows');
      });

      it('should handle empty content', () => {
        const event = createTestEvent({
          kind: 1,
          content: '',
        });

        const decoded = codec.decode(codec.encode(event));
        expect(decoded.content).toBe('');
      });
    });

    describe('Kind 3 (Follow List)', () => {
      it('should encode and decode Kind 3 follow list with p-tags and ilp-tags', () => {
        const event = createTestEvent({
          kind: 3,
          tags: [
            ['p', 'xyz789abc123', 'wss://relay.example.com', 'alice'],
            ['p', 'abc456def789', 'wss://relay2.example.com', 'bob'],
            ['ilp', 'def123xyz456', 'g.agent.alice'],
            ['ilp', 'ghi789jkl012', 'g.agent.bob'],
          ],
          content: '',
        });

        const encoded = codec.encode(event);
        const decoded = codec.decode(encoded);

        expect(decoded).toEqual(event);
        expect(decoded.tags).toHaveLength(4);
        expect(decoded.tags[0]).toEqual(['p', 'xyz789abc123', 'wss://relay.example.com', 'alice']);
        expect(decoded.tags[2]).toEqual(['ilp', 'def123xyz456', 'g.agent.alice']);
      });

      it('should preserve complex tag arrays correctly', () => {
        const event = createTestEvent({
          kind: 3,
          tags: [
            ['p', 'pubkey1'],
            ['p', 'pubkey2', 'relay', 'petname'],
            ['t', 'hashtag'],
            ['custom', 'value1', 'value2', 'value3', 'value4'],
          ],
          content: '',
        });

        const decoded = codec.decode(codec.encode(event));
        expect(decoded.tags).toEqual(event.tags);
      });
    });

    describe('Kind 5 (Delete)', () => {
      it('should encode and decode Kind 5 delete event with e-tags', () => {
        const event = createTestEvent({
          kind: 5,
          tags: [
            ['e', 'eventid1abc123def456abc123def456abc123def456abc123def456'],
            ['e', 'eventid2abc123def456abc123def456abc123def456abc123def456'],
            ['e', 'eventid3abc123def456abc123def456abc123def456abc123def456'],
          ],
          content: 'Deleted because of spam',
        });

        const encoded = codec.encode(event);
        const decoded = codec.decode(encoded);

        expect(decoded).toEqual(event);
        expect(decoded.tags).toHaveLength(3);
      });

      it('should preserve e-tag event IDs exactly', () => {
        const eventIds = [
          'aaaa1111222233334444555566667777aaaa1111222233334444555566667777',
          'bbbb1111222233334444555566667777bbbb1111222233334444555566667777',
        ];
        const event = createTestEvent({
          kind: 5,
          tags: eventIds.map((id) => ['e', id]),
          content: '',
        });

        const decoded = codec.decode(codec.encode(event));
        expect(decoded.tags[0]![1]).toBe(eventIds[0]);
        expect(decoded.tags[1]![1]).toBe(eventIds[1]);
      });
    });

    describe('Kind 10000 (Query)', () => {
      it('should encode and decode Kind 10000 query event', () => {
        const queryFilter = {
          kinds: [1, 3],
          authors: ['pubkey1', 'pubkey2'],
          limit: 100,
        };
        const event = createTestEvent({
          kind: 10000,
          content: JSON.stringify(queryFilter),
          tags: [['relay', 'wss://relay.example.com']],
        });

        const encoded = codec.encode(event);
        const decoded = codec.decode(encoded);

        expect(decoded).toEqual(event);
        expect(JSON.parse(decoded.content)).toEqual(queryFilter);
      });

      it('should preserve query structure', () => {
        const event = createTestEvent({
          kind: 10000,
          content: JSON.stringify({
            ids: ['id1', 'id2'],
            since: 1700000000,
            until: 1706000000,
          }),
        });

        const decoded = codec.decode(codec.encode(event));
        const content = JSON.parse(decoded.content);
        expect(content.ids).toEqual(['id1', 'id2']);
        expect(content.since).toBe(1700000000);
      });
    });
  });

  describe('Array Encoding/Decoding', () => {
    it('should encode and decode empty array', () => {
      const events: NostrEvent[] = [];

      const encoded = codec.encodeMany(events);
      const decoded = codec.decodeMany(encoded);

      expect(decoded).toEqual([]);
      expect(decoded).toHaveLength(0);
    });

    it('should encode and decode single event array', () => {
      const events = [createTestEvent({ kind: 1, content: 'Single event' })];

      const encoded = codec.encodeMany(events);
      const decoded = codec.decodeMany(encoded);

      expect(decoded).toEqual(events);
      expect(decoded).toHaveLength(1);
    });

    it('should encode and decode multiple events of different kinds', () => {
      const events = [
        createTestEvent({ kind: 0, content: '{"name":"Alice"}' }),
        createTestEvent({ kind: 1, content: 'A text note' }),
        createTestEvent({ kind: 3, tags: [['p', 'pubkey1']], content: '' }),
        createTestEvent({ kind: 5, tags: [['e', 'eventid1']], content: '' }),
        createTestEvent({ kind: 10000, content: '{"limit":10}' }),
      ];

      const encoded = codec.encodeMany(events);
      const decoded = codec.decodeMany(encoded);

      expect(decoded).toEqual(events);
      expect(decoded).toHaveLength(5);
    });

    it('should handle 100 events to verify performance at scale', () => {
      const events: NostrEvent[] = [];
      for (let i = 0; i < 100; i++) {
        events.push(
          createTestEvent({
            kind: i % 5, // Rotate through kinds 0-4
            content: `Event number ${i} with some content`,
            created_at: 1706000000 + i,
            tags: [['index', String(i)]],
          })
        );
      }

      const encoded = codec.encodeMany(events);
      const decoded = codec.decodeMany(encoded);

      expect(decoded).toHaveLength(100);
      expect(decoded[0]!.content).toBe('Event number 0 with some content');
      expect(decoded[99]!.content).toBe('Event number 99 with some content');
      expect(decoded[50]!.tags[0]![1]).toBe('50');
    });
  });

  describe('Error Handling', () => {
    describe('Encoding Errors', () => {
      it('should throw ValidationError for missing id field', () => {
        const event = createTestEvent();
        delete (event as unknown as Record<string, unknown>).id;

        expect(() => codec.encode(event as NostrEvent)).toThrow(ValidationError);
        expect(() => codec.encode(event as NostrEvent)).toThrow('Missing required field: id');
      });

      it('should throw ValidationError for missing pubkey field', () => {
        const event = createTestEvent();
        delete (event as unknown as Record<string, unknown>).pubkey;

        expect(() => codec.encode(event as NostrEvent)).toThrow(ValidationError);
        expect(() => codec.encode(event as NostrEvent)).toThrow('Missing required field: pubkey');
      });

      it('should throw ValidationError for missing sig field', () => {
        const event = createTestEvent();
        delete (event as unknown as Record<string, unknown>).sig;

        expect(() => codec.encode(event as NostrEvent)).toThrow(ValidationError);
        expect(() => codec.encode(event as NostrEvent)).toThrow('Missing required field: sig');
      });

      it('should throw ValidationError for invalid id type', () => {
        const event = createTestEvent();
        (event as unknown as Record<string, unknown>).id = 12345;

        expect(() => codec.encode(event as NostrEvent)).toThrow(ValidationError);
        expect(() => codec.encode(event as NostrEvent)).toThrow('Invalid type for field: id');
      });

      it('should throw ValidationError for invalid kind type', () => {
        const event = createTestEvent();
        (event as unknown as Record<string, unknown>).kind = 'not-a-number';

        expect(() => codec.encode(event as NostrEvent)).toThrow(ValidationError);
        expect(() => codec.encode(event as NostrEvent)).toThrow('Invalid type for field: kind');
      });

      it('should throw ValidationError for invalid tags type', () => {
        const event = createTestEvent();
        (event as unknown as Record<string, unknown>).tags = 'not-an-array';

        expect(() => codec.encode(event as NostrEvent)).toThrow(ValidationError);
        expect(() => codec.encode(event as NostrEvent)).toThrow('Invalid type for field: tags');
      });
    });

    describe('Decoding Errors', () => {
      it('should throw ToonDecodeError for invalid TOON buffer', () => {
        const invalidBuffer = Buffer.from('{{{{invalid toon data}}}}', 'utf-8');

        expect(() => codec.decode(invalidBuffer)).toThrow(ToonDecodeError);
        expect(() => codec.decode(invalidBuffer)).toThrow('Invalid TOON format');
      });

      it('should throw ToonDecodeError for non-buffer input', () => {
        expect(() => codec.decode('not a buffer' as unknown as Buffer)).toThrow(ToonDecodeError);
        expect(() => codec.decode('not a buffer' as unknown as Buffer)).toThrow(
          'Invalid input: expected Buffer'
        );
      });

      it('should throw ValidationError for decoded object missing required fields', () => {
        // Encode an object that's not a valid NostrEvent using JSON (mocked TOON behavior)
        const invalidObj = { foo: 'bar' };
        const buffer = Buffer.from(JSON.stringify(invalidObj), 'utf-8');

        expect(() => codec.decode(buffer)).toThrow(ValidationError);
        expect(() => codec.decode(buffer)).toThrow('Missing required field');
      });

      it('should throw ToonDecodeError for corrupted buffer', () => {
        const validEvent = createTestEvent();
        const encoded = codec.encode(validEvent);

        // Corrupt the buffer
        const corrupted = Buffer.from(encoded);
        corrupted[0] = 0xff;
        corrupted[1] = 0xfe;
        corrupted[2] = 0x00;

        // Should either throw ToonDecodeError or ValidationError
        expect(() => codec.decode(corrupted)).toThrow();
      });
    });

    describe('Array Encoding/Decoding Errors', () => {
      it('should throw ToonEncodeError for non-array input to encodeMany', () => {
        expect(() => codec.encodeMany('not an array' as unknown as NostrEvent[])).toThrow(
          ToonEncodeError
        );
      });

      it('should throw ValidationError for invalid event in array', () => {
        const events = [createTestEvent(), { invalid: 'event' } as unknown as NostrEvent];

        expect(() => codec.encodeMany(events)).toThrow(ValidationError);
        expect(() => codec.encodeMany(events)).toThrow('Event at index 1');
      });

      it('should throw ToonDecodeError for non-array TOON data in decodeMany', () => {
        const singleEvent = createTestEvent();
        const encoded = codec.encode(singleEvent);

        expect(() => codec.decodeMany(encoded)).toThrow(ToonDecodeError);
        expect(() => codec.decodeMany(encoded)).toThrow('Expected array in TOON data');
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle event with empty tags array', () => {
      const event = createTestEvent({ tags: [] });

      const decoded = codec.decode(codec.encode(event));
      expect(decoded.tags).toEqual([]);
    });

    it('should handle event with large content (10KB)', () => {
      const largeContent = 'x'.repeat(10 * 1024);
      const event = createTestEvent({ content: largeContent });

      const decoded = codec.decode(codec.encode(event));
      expect(decoded.content.length).toBe(10 * 1024);
      expect(decoded.content).toBe(largeContent);
    });

    it('should handle event with many tags', () => {
      const manyTags: string[][] = [];
      for (let i = 0; i < 50; i++) {
        manyTags.push(['p', `pubkey${i}`, `relay${i}`, `petname${i}`]);
      }
      const event = createTestEvent({ tags: manyTags });

      const decoded = codec.decode(codec.encode(event));
      expect(decoded.tags).toHaveLength(50);
      expect(decoded.tags[49]).toEqual(['p', 'pubkey49', 'relay49', 'petname49']);
    });

    it('should preserve numeric string content', () => {
      const event = createTestEvent({ content: '12345' });

      const decoded = codec.decode(codec.encode(event));
      expect(decoded.content).toBe('12345');
      expect(typeof decoded.content).toBe('string');
    });

    it('should preserve special JSON characters in content', () => {
      const event = createTestEvent({
        content: '{"key": "value with \\"quotes\\" and \\n newlines"}',
      });

      const decoded = codec.decode(codec.encode(event));
      expect(decoded.content).toBe('{"key": "value with \\"quotes\\" and \\n newlines"}');
    });

    it('should handle zero timestamp', () => {
      const event = createTestEvent({ created_at: 0 });

      const decoded = codec.decode(codec.encode(event));
      expect(decoded.created_at).toBe(0);
    });

    it('should handle large kind numbers', () => {
      const event = createTestEvent({ kind: 30023 }); // Parameterized replaceable event

      const decoded = codec.decode(codec.encode(event));
      expect(decoded.kind).toBe(30023);
    });
  });
});
