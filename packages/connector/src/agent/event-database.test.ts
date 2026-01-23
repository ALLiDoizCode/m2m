// Mock toon-codec to avoid ESM transformation issues with @toon-format/toon
jest.mock('./toon-codec', () => ({
  ValidationError: class ValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ValidationError';
    }
  },
}));

import { AgentEventDatabase, DatabaseSizeExceededError } from './event-database';
import { ValidationError } from './toon-codec';

// Local NostrEvent interface for testing (matches toon-codec)
interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * Helper to create a test Nostr event with default values.
 */
function createTestEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: timestamp,
    kind: 1,
    tags: [],
    content: 'test content',
    sig: 'c'.repeat(128),
    ...overrides,
  };
}

describe('AgentEventDatabase', () => {
  let db: AgentEventDatabase;

  beforeEach(async () => {
    db = new AgentEventDatabase({ path: ':memory:' });
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
  });

  // ============================================
  // Database Initialization Tests
  // ============================================
  describe('initialization', () => {
    it('should create database with in-memory path', async () => {
      const testDb = new AgentEventDatabase({ path: ':memory:' });
      await testDb.initialize();

      const count = await testDb.getEventCount();
      expect(count).toBe(0);

      await testDb.close();
    });

    it('should create events table with correct schema', async () => {
      const event = createTestEvent();
      await db.storeEvent(event);

      const retrieved = await db.getEventById(event.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(event.id);
      expect(retrieved?.pubkey).toBe(event.pubkey);
      expect(retrieved?.kind).toBe(event.kind);
      expect(retrieved?.created_at).toBe(event.created_at);
      expect(retrieved?.content).toBe(event.content);
      expect(retrieved?.tags).toEqual(event.tags);
      expect(retrieved?.sig).toBe(event.sig);
    });

    it('should throw error when accessing uninitialized database', async () => {
      const uninitDb = new AgentEventDatabase({ path: ':memory:' });

      await expect(uninitDb.getEventCount()).rejects.toThrow(
        'Database not initialized. Call initialize() first.'
      );
    });
  });

  // ============================================
  // Event Storage Tests
  // ============================================
  describe('storeEvent', () => {
    it('should store single event with all fields', async () => {
      const event = createTestEvent({
        tags: [
          ['e', 'event123'],
          ['p', 'pubkey456'],
        ],
        content: 'Hello, Nostr!',
      });

      await db.storeEvent(event);

      const retrieved = await db.getEventById(event.id);
      expect(retrieved).toEqual(event);
    });

    it('should handle duplicate event IDs (upsert)', async () => {
      const event1 = createTestEvent({ content: 'original' });
      const event2 = { ...event1, content: 'updated' };

      await db.storeEvent(event1);
      await db.storeEvent(event2);

      const retrieved = await db.getEventById(event1.id);
      expect(retrieved?.content).toBe('updated');

      const count = await db.getEventCount();
      expect(count).toBe(1);
    });

    it('should store event with empty content (Kind 3)', async () => {
      const event = createTestEvent({ kind: 3, content: '' });

      await db.storeEvent(event);

      const retrieved = await db.getEventById(event.id);
      expect(retrieved?.content).toBe('');
    });

    it('should throw ValidationError for missing required fields', async () => {
      const invalidEvent = { id: 'a'.repeat(64) } as NostrEvent;

      await expect(db.storeEvent(invalidEvent)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for invalid field types', async () => {
      const invalidEvent = createTestEvent();
      (invalidEvent as unknown as Record<string, unknown>).kind = 'not a number';

      await expect(db.storeEvent(invalidEvent)).rejects.toThrow(ValidationError);
    });
  });

  describe('storeEvents', () => {
    it('should store batch of events atomically', async () => {
      const events = [
        createTestEvent({ id: '1'.repeat(64) }),
        createTestEvent({ id: '2'.repeat(64) }),
        createTestEvent({ id: '3'.repeat(64) }),
      ];

      await db.storeEvents(events);

      const count = await db.getEventCount();
      expect(count).toBe(3);
    });

    it('should validate all events before storing', async () => {
      const events = [
        createTestEvent({ id: '1'.repeat(64) }),
        { id: '2'.repeat(64) } as NostrEvent, // Invalid - missing fields
        createTestEvent({ id: '3'.repeat(64) }),
      ];

      await expect(db.storeEvents(events)).rejects.toThrow(
        'Event at index 1: Missing required field: pubkey'
      );

      // No events should be stored due to validation failure
      const count = await db.getEventCount();
      expect(count).toBe(0);
    });

    it('should handle empty array', async () => {
      await db.storeEvents([]);

      const count = await db.getEventCount();
      expect(count).toBe(0);
    });
  });

  // ============================================
  // Event Querying Tests
  // ============================================
  describe('queryEvents', () => {
    beforeEach(async () => {
      // Set up test data
      const events = [
        createTestEvent({
          id: '1'.repeat(64),
          pubkey: 'alice'.padEnd(64, '0'),
          kind: 1,
          created_at: 1000,
        }),
        createTestEvent({
          id: '2'.repeat(64),
          pubkey: 'alice'.padEnd(64, '0'),
          kind: 3,
          created_at: 2000,
        }),
        createTestEvent({
          id: '3'.repeat(64),
          pubkey: 'bob'.padEnd(64, '0'),
          kind: 1,
          created_at: 3000,
        }),
        createTestEvent({
          id: '4'.repeat(64),
          pubkey: 'carol'.padEnd(64, '0'),
          kind: 1,
          created_at: 4000,
          tags: [
            ['e', 'event_ref'],
            ['p', 'pubkey_ref'],
          ],
        }),
      ];
      await db.storeEvents(events);
    });

    it('should query by kind', async () => {
      const results = await db.queryEvents({ kinds: [1] });

      expect(results).toHaveLength(3);
      expect(results.every((e) => e.kind === 1)).toBe(true);
    });

    it('should query by pubkey (authors)', async () => {
      const results = await db.queryEvents({ authors: ['alice'.padEnd(64, '0')] });

      expect(results).toHaveLength(2);
      expect(results.every((e) => e.pubkey === 'alice'.padEnd(64, '0'))).toBe(true);
    });

    it('should query by time range (since)', async () => {
      const results = await db.queryEvents({ since: 2500 });

      expect(results).toHaveLength(2);
      expect(results.every((e) => e.created_at >= 2500)).toBe(true);
    });

    it('should query by time range (until)', async () => {
      const results = await db.queryEvents({ until: 2500 });

      expect(results).toHaveLength(2);
      expect(results.every((e) => e.created_at <= 2500)).toBe(true);
    });

    it('should query by time range (since and until)', async () => {
      const results = await db.queryEvents({ since: 1500, until: 3500 });

      expect(results).toHaveLength(2);
      expect(results.every((e) => e.created_at >= 1500 && e.created_at <= 3500)).toBe(true);
    });

    it('should query by multiple filters (AND logic)', async () => {
      const results = await db.queryEvents({
        authors: ['alice'.padEnd(64, '0')],
        kinds: [1],
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('1'.repeat(64));
    });

    it('should query with limit', async () => {
      const results = await db.queryEvents({ limit: 2 });

      expect(results).toHaveLength(2);
    });

    it('should return results ordered by created_at DESC', async () => {
      const results = await db.queryEvents({});

      expect(results).toHaveLength(4);
      expect(results[0]!.created_at).toBe(4000);
      expect(results[1]!.created_at).toBe(3000);
      expect(results[2]!.created_at).toBe(2000);
      expect(results[3]!.created_at).toBe(1000);
    });

    it('should query by #e tag filter', async () => {
      const results = await db.queryEvents({ '#e': ['event_ref'] });

      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('4'.repeat(64));
    });

    it('should query by #p tag filter', async () => {
      const results = await db.queryEvents({ '#p': ['pubkey_ref'] });

      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('4'.repeat(64));
    });

    it('should query by IDs', async () => {
      const results = await db.queryEvents({ ids: ['1'.repeat(64), '3'.repeat(64)] });

      expect(results).toHaveLength(2);
      expect(results.map((e) => e.id).sort()).toEqual(['1'.repeat(64), '3'.repeat(64)].sort());
    });

    it('should return empty array for no matches', async () => {
      const results = await db.queryEvents({ kinds: [999] });

      expect(results).toEqual([]);
    });

    it('should apply default limit of 100', async () => {
      // Store more than 100 events
      const manyEvents = Array.from({ length: 150 }, (_, i) =>
        createTestEvent({
          id: i.toString().padStart(64, '0'),
          created_at: i,
        })
      );
      await db.storeEvents(manyEvents);

      const results = await db.queryEvents({});

      expect(results).toHaveLength(100);
    });
  });

  describe('getEventById', () => {
    it('should return event by ID', async () => {
      const event = createTestEvent();
      await db.storeEvent(event);

      const retrieved = await db.getEventById(event.id);

      expect(retrieved).toEqual(event);
    });

    it('should return null for non-existent ID', async () => {
      const retrieved = await db.getEventById('nonexistent'.repeat(6).substring(0, 64));

      expect(retrieved).toBeNull();
    });
  });

  // ============================================
  // Event Deletion Tests
  // ============================================
  describe('deleteEvent', () => {
    it('should delete event by ID', async () => {
      const event = createTestEvent();
      await db.storeEvent(event);

      const deleted = await db.deleteEvent(event.id);

      expect(deleted).toBe(true);
      const retrieved = await db.getEventById(event.id);
      expect(retrieved).toBeNull();
    });

    it('should return false for non-existent event', async () => {
      const deleted = await db.deleteEvent('nonexistent'.repeat(6).substring(0, 64));

      expect(deleted).toBe(false);
    });
  });

  describe('deleteEvents', () => {
    it('should delete multiple events', async () => {
      const events = [
        createTestEvent({ id: '1'.repeat(64) }),
        createTestEvent({ id: '2'.repeat(64) }),
        createTestEvent({ id: '3'.repeat(64) }),
      ];
      await db.storeEvents(events);

      const deletedCount = await db.deleteEvents(['1'.repeat(64), '2'.repeat(64)]);

      expect(deletedCount).toBe(2);
      const remaining = await db.getEventCount();
      expect(remaining).toBe(1);
    });

    it('should handle empty array', async () => {
      const deletedCount = await db.deleteEvents([]);

      expect(deletedCount).toBe(0);
    });

    it('should return actual count of deleted events', async () => {
      const event = createTestEvent({ id: '1'.repeat(64) });
      await db.storeEvent(event);

      const deletedCount = await db.deleteEvents(['1'.repeat(64), 'nonexistent'.padEnd(64, '0')]);

      expect(deletedCount).toBe(1);
    });
  });

  describe('deleteByFilter', () => {
    beforeEach(async () => {
      const events = [
        createTestEvent({ id: '1'.repeat(64), kind: 1, created_at: 1000 }),
        createTestEvent({ id: '2'.repeat(64), kind: 1, created_at: 2000 }),
        createTestEvent({ id: '3'.repeat(64), kind: 3, created_at: 3000 }),
      ];
      await db.storeEvents(events);
    });

    it('should delete events matching filter', async () => {
      const deletedCount = await db.deleteByFilter({ kinds: [1] });

      expect(deletedCount).toBe(2);
      const remaining = await db.getEventCount();
      expect(remaining).toBe(1);
    });

    it('should delete events by time range', async () => {
      const deletedCount = await db.deleteByFilter({ until: 1500 });

      expect(deletedCount).toBe(1);
      const remaining = await db.getEventCount();
      expect(remaining).toBe(2);
    });

    it('should return 0 when no filter provided', async () => {
      const deletedCount = await db.deleteByFilter({});

      expect(deletedCount).toBe(0);
      const remaining = await db.getEventCount();
      expect(remaining).toBe(3);
    });
  });

  // ============================================
  // Database Size Management Tests
  // ============================================
  describe('getDatabaseSize', () => {
    it('should return database size in bytes', async () => {
      const size = await db.getDatabaseSize();

      expect(typeof size).toBe('number');
      expect(size).toBeGreaterThanOrEqual(0);
    });

    it('should increase after storing events', async () => {
      const initialSize = await db.getDatabaseSize();

      // Store several events
      const events = Array.from({ length: 10 }, (_, i) =>
        createTestEvent({
          id: i.toString().padStart(64, '0'),
          content: 'x'.repeat(1000),
        })
      );
      await db.storeEvents(events);

      const finalSize = await db.getDatabaseSize();
      expect(finalSize).toBeGreaterThan(initialSize);
    });
  });

  describe('getEventCount', () => {
    it('should return 0 for empty database', async () => {
      const count = await db.getEventCount();

      expect(count).toBe(0);
    });

    it('should return correct count', async () => {
      const events = [
        createTestEvent({ id: '1'.repeat(64) }),
        createTestEvent({ id: '2'.repeat(64) }),
        createTestEvent({ id: '3'.repeat(64) }),
      ];
      await db.storeEvents(events);

      const count = await db.getEventCount();

      expect(count).toBe(3);
    });
  });

  describe('pruneOldEvents', () => {
    it('should keep newest events and delete oldest', async () => {
      const events = [
        createTestEvent({ id: '1'.repeat(64), created_at: 1000 }),
        createTestEvent({ id: '2'.repeat(64), created_at: 2000 }),
        createTestEvent({ id: '3'.repeat(64), created_at: 3000 }),
        createTestEvent({ id: '4'.repeat(64), created_at: 4000 }),
        createTestEvent({ id: '5'.repeat(64), created_at: 5000 }),
      ];
      await db.storeEvents(events);

      const prunedCount = await db.pruneOldEvents(2);

      expect(prunedCount).toBe(3);
      const remaining = await db.queryEvents({});
      expect(remaining).toHaveLength(2);
      expect(remaining[0]!.created_at).toBe(5000);
      expect(remaining[1]!.created_at).toBe(4000);
    });

    it('should not delete if count is within limit', async () => {
      const events = [
        createTestEvent({ id: '1'.repeat(64) }),
        createTestEvent({ id: '2'.repeat(64) }),
      ];
      await db.storeEvents(events);

      const prunedCount = await db.pruneOldEvents(10);

      expect(prunedCount).toBe(0);
      const count = await db.getEventCount();
      expect(count).toBe(2);
    });
  });

  describe('database size limit enforcement', () => {
    it('should throw DatabaseSizeExceededError when limit reached', async () => {
      // Create a database with tiny size limit
      const tinyDb = new AgentEventDatabase({
        path: ':memory:',
        maxSizeBytes: 1, // 1 byte - will be exceeded immediately
      });
      await tinyDb.initialize();

      // Store one event to establish the database
      const event = createTestEvent();

      await expect(tinyDb.storeEvent(event)).rejects.toThrow(DatabaseSizeExceededError);

      await tinyDb.close();
    });
  });

  // ============================================
  // Cleanup Tests
  // ============================================
  describe('close', () => {
    it('should release database connection', async () => {
      const testDb = new AgentEventDatabase({ path: ':memory:' });
      await testDb.initialize();
      await testDb.close();

      // Accessing after close should fail
      await expect(testDb.getEventCount()).rejects.toThrow(
        'Database not initialized. Call initialize() first.'
      );
    });

    it('should be safe to call multiple times (idempotent)', async () => {
      const testDb = new AgentEventDatabase({ path: ':memory:' });
      await testDb.initialize();

      await testDb.close();
      await testDb.close(); // Should not throw

      expect(true).toBe(true);
    });
  });
});
