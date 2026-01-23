import { createClient, Client } from '@libsql/client';
import { NostrEvent, ValidationError } from './toon-codec';

/**
 * Configuration for AgentEventDatabase.
 */
export interface AgentEventDatabaseConfig {
  path: string; // Database file path (e.g., './data/events.db') or ':memory:'
  maxSizeBytes?: number; // Maximum database size (default: 100MB)
}

/**
 * NIP-01 compatible query filter for Nostr events.
 */
export interface NostrFilter {
  ids?: string[]; // Event IDs to match
  authors?: string[]; // Author pubkeys to match
  kinds?: number[]; // Event kinds to match
  since?: number; // Unix timestamp lower bound (>=)
  until?: number; // Unix timestamp upper bound (<=)
  limit?: number; // Maximum results (default: 100)
  '#e'?: string[]; // Events referenced in tags
  '#p'?: string[]; // Pubkeys referenced in tags
}

/**
 * Error thrown when database size limit is exceeded.
 */
export class DatabaseSizeExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseSizeExceededError';
  }
}

const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
const DEFAULT_QUERY_LIMIT = 100;

const REQUIRED_EVENT_FIELDS: (keyof NostrEvent)[] = [
  'id',
  'pubkey',
  'created_at',
  'kind',
  'tags',
  'content',
  'sig',
];

/**
 * Validates that an event has all required fields with correct types.
 */
function validateEventFields(event: unknown): asserts event is NostrEvent {
  if (typeof event !== 'object' || event === null) {
    throw new ValidationError(`Expected object, got ${typeof event}`);
  }

  const e = event as Record<string, unknown>;

  for (const field of REQUIRED_EVENT_FIELDS) {
    if (!(field in e)) {
      throw new ValidationError(`Missing required field: ${field}`);
    }
  }

  if (typeof e.id !== 'string') {
    throw new ValidationError('Invalid type for field: id (expected string)');
  }
  if (typeof e.pubkey !== 'string') {
    throw new ValidationError('Invalid type for field: pubkey (expected string)');
  }
  if (typeof e.created_at !== 'number') {
    throw new ValidationError('Invalid type for field: created_at (expected number)');
  }
  if (typeof e.kind !== 'number') {
    throw new ValidationError('Invalid type for field: kind (expected number)');
  }
  if (!Array.isArray(e.tags)) {
    throw new ValidationError('Invalid type for field: tags (expected array)');
  }
  if (typeof e.content !== 'string') {
    throw new ValidationError('Invalid type for field: content (expected string)');
  }
  if (typeof e.sig !== 'string') {
    throw new ValidationError('Invalid type for field: sig (expected string)');
  }
}

/**
 * AgentEventDatabase provides libSQL-based event storage with NIP-01 compatible querying.
 *
 * Features:
 * - Store Nostr events with all fields
 * - Query by kind, pubkey, time range, tags
 * - Efficient lookups via indexes
 * - Database size limits configurable
 */
export class AgentEventDatabase {
  private _client: Client | null = null;
  private readonly _config: Required<AgentEventDatabaseConfig>;

  constructor(config: AgentEventDatabaseConfig) {
    this._config = {
      path: config.path,
      maxSizeBytes: config.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES,
    };
  }

  /**
   * Initialize the database and create schema.
   */
  async initialize(): Promise<void> {
    const url = this._config.path === ':memory:' ? ':memory:' : `file:${this._config.path}`;

    this._client = createClient({ url });

    // Create events table
    await this._client.execute(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        pubkey TEXT NOT NULL,
        kind INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        content TEXT,
        tags TEXT NOT NULL,
        sig TEXT NOT NULL
      )
    `);

    // Create indexes for efficient lookups
    await this._client.execute('CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey)');
    await this._client.execute('CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind)');
    await this._client.execute(
      'CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC)'
    );
    await this._client.execute(
      'CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind ON events(pubkey, kind)'
    );
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    if (this._client) {
      this._client.close();
      this._client = null;
    }
  }

  /**
   * Get the database client, throwing if not initialized.
   */
  private _getClient(): Client {
    if (!this._client) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this._client;
  }

  // ============================================
  // Event Storage (Task 3)
  // ============================================

  /**
   * Store a single Nostr event.
   *
   * @param event - The Nostr event to store
   * @throws ValidationError if event is missing required fields
   * @throws DatabaseSizeExceededError if database size limit reached
   */
  async storeEvent(event: NostrEvent): Promise<void> {
    validateEventFields(event);

    const client = this._getClient();

    // Check database size before insert
    const currentSize = await this.getDatabaseSize();
    if (currentSize >= this._config.maxSizeBytes) {
      throw new DatabaseSizeExceededError(
        `Database size limit exceeded: ${currentSize} >= ${this._config.maxSizeBytes} bytes`
      );
    }

    await client.execute({
      sql: 'INSERT OR REPLACE INTO events (id, pubkey, kind, created_at, content, tags, sig) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [
        event.id,
        event.pubkey,
        event.kind,
        event.created_at,
        event.content,
        JSON.stringify(event.tags),
        event.sig,
      ],
    });
  }

  /**
   * Store multiple Nostr events atomically.
   *
   * @param events - Array of Nostr events to store
   * @throws ValidationError if any event is missing required fields
   * @throws DatabaseSizeExceededError if database size limit reached
   */
  async storeEvents(events: NostrEvent[]): Promise<void> {
    // Validate all events before beginning transaction
    for (let i = 0; i < events.length; i++) {
      try {
        validateEventFields(events[i]);
      } catch (error) {
        if (error instanceof ValidationError) {
          throw new ValidationError(`Event at index ${i}: ${error.message}`);
        }
        throw error;
      }
    }

    const client = this._getClient();

    // Check database size before insert
    const currentSize = await this.getDatabaseSize();
    if (currentSize >= this._config.maxSizeBytes) {
      throw new DatabaseSizeExceededError(
        `Database size limit exceeded: ${currentSize} >= ${this._config.maxSizeBytes} bytes`
      );
    }

    // Use batch for atomic transaction
    const statements = events.map((event) => ({
      sql: 'INSERT OR REPLACE INTO events (id, pubkey, kind, created_at, content, tags, sig) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [
        event.id,
        event.pubkey,
        event.kind,
        event.created_at,
        event.content,
        JSON.stringify(event.tags),
        event.sig,
      ],
    }));

    await client.batch(statements, 'write');
  }

  // ============================================
  // Event Querying (Task 4)
  // ============================================

  /**
   * Query events using NIP-01 compatible filter.
   *
   * @param filter - Query filter criteria
   * @returns Array of matching events (empty if no matches)
   */
  async queryEvents(filter: NostrFilter): Promise<NostrEvent[]> {
    const client = this._getClient();

    const conditions: string[] = [];
    const args: (string | number)[] = [];

    // Build WHERE clause dynamically
    if (filter.ids && filter.ids.length > 0) {
      const placeholders = filter.ids.map(() => '?').join(', ');
      conditions.push(`id IN (${placeholders})`);
      args.push(...filter.ids);
    }

    if (filter.authors && filter.authors.length > 0) {
      const placeholders = filter.authors.map(() => '?').join(', ');
      conditions.push(`pubkey IN (${placeholders})`);
      args.push(...filter.authors);
    }

    if (filter.kinds && filter.kinds.length > 0) {
      const placeholders = filter.kinds.map(() => '?').join(', ');
      conditions.push(`kind IN (${placeholders})`);
      args.push(...filter.kinds);
    }

    if (filter.since !== undefined) {
      conditions.push('created_at >= ?');
      args.push(filter.since);
    }

    if (filter.until !== undefined) {
      conditions.push('created_at <= ?');
      args.push(filter.until);
    }

    // Handle #e tag filter (events referenced in tags)
    if (filter['#e'] && filter['#e'].length > 0) {
      const tagConditions = filter['#e'].map(() => {
        return `EXISTS (
          SELECT 1 FROM json_each(tags)
          WHERE json_extract(value, '$[0]') = 'e'
          AND json_extract(value, '$[1]') = ?
        )`;
      });
      conditions.push(`(${tagConditions.join(' OR ')})`);
      args.push(...filter['#e']);
    }

    // Handle #p tag filter (pubkeys referenced in tags)
    if (filter['#p'] && filter['#p'].length > 0) {
      const tagConditions = filter['#p'].map(() => {
        return `EXISTS (
          SELECT 1 FROM json_each(tags)
          WHERE json_extract(value, '$[0]') = 'p'
          AND json_extract(value, '$[1]') = ?
        )`;
      });
      conditions.push(`(${tagConditions.join(' OR ')})`);
      args.push(...filter['#p']);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? DEFAULT_QUERY_LIMIT;

    const sql = `SELECT * FROM events ${whereClause} ORDER BY created_at DESC LIMIT ?`;
    args.push(limit);

    const result = await client.execute({ sql, args });

    return result.rows.map((row) => ({
      id: row.id as string,
      pubkey: row.pubkey as string,
      kind: row.kind as number,
      created_at: row.created_at as number,
      content: (row.content as string) ?? '',
      tags: JSON.parse(row.tags as string) as string[][],
      sig: row.sig as string,
    }));
  }

  /**
   * Get a single event by ID.
   *
   * @param id - Event ID (64-char hex)
   * @returns The event or null if not found
   */
  async getEventById(id: string): Promise<NostrEvent | null> {
    const client = this._getClient();

    const result = await client.execute({
      sql: 'SELECT * FROM events WHERE id = ?',
      args: [id],
    });

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0]!;
    return {
      id: row.id as string,
      pubkey: row.pubkey as string,
      kind: row.kind as number,
      created_at: row.created_at as number,
      content: (row.content as string) ?? '',
      tags: JSON.parse(row.tags as string) as string[][],
      sig: row.sig as string,
    };
  }

  // ============================================
  // Event Deletion (Task 5)
  // ============================================

  /**
   * Delete a single event by ID.
   *
   * @param id - Event ID to delete
   * @returns true if event was deleted, false if not found
   */
  async deleteEvent(id: string): Promise<boolean> {
    const client = this._getClient();

    const result = await client.execute({
      sql: 'DELETE FROM events WHERE id = ?',
      args: [id],
    });

    return result.rowsAffected > 0;
  }

  /**
   * Delete multiple events by ID.
   *
   * @param ids - Array of event IDs to delete
   * @returns Count of events actually deleted
   */
  async deleteEvents(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const client = this._getClient();

    const placeholders = ids.map(() => '?').join(', ');
    const result = await client.execute({
      sql: `DELETE FROM events WHERE id IN (${placeholders})`,
      args: ids,
    });

    return result.rowsAffected;
  }

  /**
   * Delete events matching a filter.
   *
   * @param filter - Filter criteria for events to delete
   * @returns Count of events deleted
   */
  async deleteByFilter(filter: NostrFilter): Promise<number> {
    const client = this._getClient();

    const conditions: string[] = [];
    const args: (string | number)[] = [];

    // Build WHERE clause (same logic as queryEvents, but without limit)
    if (filter.ids && filter.ids.length > 0) {
      const placeholders = filter.ids.map(() => '?').join(', ');
      conditions.push(`id IN (${placeholders})`);
      args.push(...filter.ids);
    }

    if (filter.authors && filter.authors.length > 0) {
      const placeholders = filter.authors.map(() => '?').join(', ');
      conditions.push(`pubkey IN (${placeholders})`);
      args.push(...filter.authors);
    }

    if (filter.kinds && filter.kinds.length > 0) {
      const placeholders = filter.kinds.map(() => '?').join(', ');
      conditions.push(`kind IN (${placeholders})`);
      args.push(...filter.kinds);
    }

    if (filter.since !== undefined) {
      conditions.push('created_at >= ?');
      args.push(filter.since);
    }

    if (filter.until !== undefined) {
      conditions.push('created_at <= ?');
      args.push(filter.until);
    }

    // Handle #e tag filter
    if (filter['#e'] && filter['#e'].length > 0) {
      const tagConditions = filter['#e'].map(() => {
        return `EXISTS (
          SELECT 1 FROM json_each(tags)
          WHERE json_extract(value, '$[0]') = 'e'
          AND json_extract(value, '$[1]') = ?
        )`;
      });
      conditions.push(`(${tagConditions.join(' OR ')})`);
      args.push(...filter['#e']);
    }

    // Handle #p tag filter
    if (filter['#p'] && filter['#p'].length > 0) {
      const tagConditions = filter['#p'].map(() => {
        return `EXISTS (
          SELECT 1 FROM json_each(tags)
          WHERE json_extract(value, '$[0]') = 'p'
          AND json_extract(value, '$[1]') = ?
        )`;
      });
      conditions.push(`(${tagConditions.join(' OR ')})`);
      args.push(...filter['#p']);
    }

    if (conditions.length === 0) {
      // No filter criteria - don't delete everything
      return 0;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const result = await client.execute({
      sql: `DELETE FROM events ${whereClause}`,
      args,
    });

    return result.rowsAffected;
  }

  // ============================================
  // Database Size Management (Task 6)
  // ============================================

  /**
   * Get the current database size in bytes.
   *
   * @returns Database size in bytes
   */
  async getDatabaseSize(): Promise<number> {
    const client = this._getClient();

    const result = await client.execute(
      'SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()'
    );

    if (result.rows.length === 0 || result.rows[0]?.size === null) {
      return 0;
    }

    return result.rows[0]!.size as number;
  }

  /**
   * Get the total count of events in the database.
   *
   * @returns Total event count
   */
  async getEventCount(): Promise<number> {
    const client = this._getClient();

    const result = await client.execute('SELECT COUNT(*) as count FROM events');

    return (result.rows[0]?.count as number) ?? 0;
  }

  /**
   * Prune old events, keeping only the newest events.
   *
   * @param keepCount - Number of newest events to keep
   * @returns Count of events pruned
   */
  async pruneOldEvents(keepCount: number): Promise<number> {
    const client = this._getClient();

    const result = await client.execute({
      sql: `DELETE FROM events WHERE id NOT IN (
        SELECT id FROM events ORDER BY created_at DESC LIMIT ?
      )`,
      args: [keepCount],
    });

    return result.rowsAffected;
  }
}
