/**
 * Unit tests for the persistent peer/route RegistryStore.
 *
 * Uses a real in-memory libsql database (no mocks, per project policy) so the
 * SQL upsert/delete/load round-trips are exercised against the actual driver
 * the connector ships with.
 */

// Runtime DB is libsql (better-sqlite3-compatible); type stays on better-sqlite3.
import BetterSqlite3 from 'libsql';
import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';
import { initializeRegistrySchema } from './registry-db-schema';
import { RegistryStore } from './registry-store';

const noopLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

describe('RegistryStore', () => {
  let db: Database;
  let store: RegistryStore;

  beforeEach(() => {
    db = new BetterSqlite3(':memory:') as unknown as Database;
    initializeRegistrySchema(db);
    store = new RegistryStore(db, noopLogger);
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips a peer with all fields', () => {
    store.savePeer({
      id: 'town',
      url: 'wss://town:3000',
      authToken: 'secret',
      relation: 'child',
      transport: 'direct',
      settlementJson: JSON.stringify({ preference: 'evm' }),
      source: 'runtime',
    });

    const { peers } = store.loadAll();
    expect(peers).toHaveLength(1);
    expect(peers[0]).toEqual({
      id: 'town',
      url: 'wss://town:3000',
      authToken: 'secret',
      relation: 'child',
      transport: 'direct',
      settlementJson: JSON.stringify({ preference: 'evm' }),
      source: 'runtime',
    });
  });

  it('round-trips a route', () => {
    store.saveRoute({
      prefix: 'g.townhouse.town',
      nextHop: 'town',
      priority: 5,
      source: 'runtime',
    });

    const { routes } = store.loadAll();
    expect(routes).toEqual([
      { prefix: 'g.townhouse.town', nextHop: 'town', priority: 5, source: 'runtime' },
    ]);
  });

  it('upserts a peer by id (no duplicate rows)', () => {
    store.savePeer({ id: 'p', url: 'wss://a', authToken: 't', source: 'runtime' });
    store.savePeer({ id: 'p', url: 'wss://b', authToken: 't2', source: 'runtime' });

    const { peers } = store.loadAll();
    expect(peers).toHaveLength(1);
    expect(peers[0]!.url).toBe('wss://b');
    expect(peers[0]!.authToken).toBe('t2');
  });

  it('upserts a route by prefix (no duplicate rows)', () => {
    store.saveRoute({ prefix: 'g.x', nextHop: 'a', priority: 0, source: 'config' });
    store.saveRoute({ prefix: 'g.x', nextHop: 'b', priority: 9, source: 'runtime' });

    const { routes } = store.loadAll();
    expect(routes).toHaveLength(1);
    expect(routes[0]).toEqual({ prefix: 'g.x', nextHop: 'b', priority: 9, source: 'runtime' });
  });

  it('deletes a peer and a route idempotently', () => {
    store.savePeer({ id: 'p', url: 'wss://a', authToken: 't', source: 'runtime' });
    store.saveRoute({ prefix: 'g.x', nextHop: 'p', priority: 0, source: 'runtime' });

    store.deletePeer('p');
    store.deleteRoute('g.x');
    // second delete is a no-op, must not throw
    store.deletePeer('p');
    store.deleteRoute('g.x');

    const { peers, routes } = store.loadAll();
    expect(peers).toHaveLength(0);
    expect(routes).toHaveLength(0);
  });

  it('preserves source provenance so boot reconciliation can filter runtime rows', () => {
    store.savePeer({ id: 'cfg', url: 'wss://a', authToken: 't', source: 'config' });
    store.savePeer({ id: 'rt', url: 'wss://b', authToken: 't', source: 'runtime' });

    const { peers } = store.loadAll();
    const runtime = peers.filter((p) => p.source === 'runtime');
    expect(runtime.map((p) => p.id)).toEqual(['rt']);
  });

  it('returns optional fields as undefined when absent', () => {
    store.savePeer({ id: 'p', url: 'wss://a', authToken: 't', source: 'runtime' });
    const { peers } = store.loadAll();
    expect(peers[0]!.relation).toBeUndefined();
    expect(peers[0]!.transport).toBeUndefined();
    expect(peers[0]!.settlementJson).toBeUndefined();
  });
});
