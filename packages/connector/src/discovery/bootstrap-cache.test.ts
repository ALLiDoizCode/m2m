/**
 * Tests for the learned-peer relay cache file store (toon-meta#153).
 *
 * Covers: save→load round trip (real filesystem in a temp dir — no mocks),
 * missing/corrupt/wrong-shape files degrading to empty, parent-dir creation,
 * atomic overwrite, and structural filtering of hand-edited entries.
 *
 * @module discovery/bootstrap-cache.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from '../utils/logger';
import { FileBootstrapCacheStore, type CachedRelaySeed } from './bootstrap-cache';

const logger = createLogger('bootstrap-cache-test', 'silent');

describe('FileBootstrapCacheStore (toon-meta#153)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-cache-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function entry(overrides: Partial<CachedRelaySeed> = {}): CachedRelaySeed {
    return {
      relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev',
      verifiedAt: '2026-07-16T00:00:00.000Z',
      source: 'registry',
      ...overrides,
    };
  }

  it('round-trips entries through save/load', async () => {
    const store = new FileBootstrapCacheStore(path.join(dir, 'cache.json'), logger);
    const entries = [
      entry(),
      entry({ relayUrl: 'wss://relay-2.example.org', source: 'config', pubkey: 'a'.repeat(64) }),
    ];
    await store.save(entries);
    await expect(store.load()).resolves.toEqual(entries);
  });

  it('returns [] when the cache file does not exist yet (cold start)', async () => {
    const store = new FileBootstrapCacheStore(path.join(dir, 'missing.json'), logger);
    await expect(store.load()).resolves.toEqual([]);
  });

  it('returns [] for a corrupt (non-JSON) cache file', async () => {
    const filePath = path.join(dir, 'corrupt.json');
    fs.writeFileSync(filePath, '{not json!', 'utf8');
    const store = new FileBootstrapCacheStore(filePath, logger);
    await expect(store.load()).resolves.toEqual([]);
  });

  it('returns [] for a JSON file with the wrong shape/version', async () => {
    const filePath = path.join(dir, 'wrong-shape.json');
    fs.writeFileSync(filePath, JSON.stringify({ version: 99, entries: 'nope' }), 'utf8');
    const store = new FileBootstrapCacheStore(filePath, logger);
    await expect(store.load()).resolves.toEqual([]);
  });

  it('filters structurally invalid entries but keeps valid ones', async () => {
    const filePath = path.join(dir, 'mixed.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: [
          entry(),
          {
            relayUrl: 'https://not-ws.example.org',
            verifiedAt: entry().verifiedAt,
            source: 'cache',
          },
          { relayUrl: 'wss://ok.example.org', verifiedAt: 'not-a-date', source: 'cache' },
          { relayUrl: 'wss://ok2.example.org', verifiedAt: entry().verifiedAt, source: 'bogus' },
          'garbage',
        ],
      }),
      'utf8'
    );
    const store = new FileBootstrapCacheStore(filePath, logger);
    await expect(store.load()).resolves.toEqual([entry()]);
  });

  it('creates missing parent directories on save', async () => {
    const filePath = path.join(dir, 'nested', 'deeper', 'cache.json');
    const store = new FileBootstrapCacheStore(filePath, logger);
    await store.save([entry()]);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('save replaces prior contents atomically (no .tmp left behind)', async () => {
    const filePath = path.join(dir, 'cache.json');
    const store = new FileBootstrapCacheStore(filePath, logger);
    await store.save([entry(), entry({ relayUrl: 'wss://old.example.org' })]);
    await store.save([entry({ relayUrl: 'wss://new.example.org', source: 'cache' })]);
    await expect(store.load()).resolves.toEqual([
      entry({ relayUrl: 'wss://new.example.org', source: 'cache' }),
    ]);
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
  });
});
