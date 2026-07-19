/**
 * Unit tests for the LinkStateDatabase (toon-meta#153).
 *
 * Covers ingest (valid / stale / expired / invalid), replaceable-event
 * supersede semantics (newest per pubkey wins; a newer announcement without a
 * routing block withdraws the announcer), NIP-40 expiry sweeps, and defensive
 * parsing of malformed content. Pure data — no network, no mocks.
 *
 * @module routing/link-state-db.test
 */

import { LinkStateDatabase, parseExpirationTag, type LinkStateEventInput } from './link-state-db';
import { ILP_PEER_INFO_KIND } from '../discovery/ilp-peer-info-event';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const PK_C = 'c'.repeat(64);

const NOW = 1_700_000_000;

function evt(overrides: Partial<LinkStateEventInput> = {}): LinkStateEventInput {
  return {
    kind: ILP_PEER_INFO_KIND,
    pubkey: PK_A,
    created_at: NOW,
    content: JSON.stringify({
      ilpAddress: 'g.a',
      btpEndpoint: 'ws://a:3000',
      assetCode: 'USDC',
      assetScale: 6,
      routing: { prefixes: [{ prefix: 'g.a', cost: 0 }], adjacency: [PK_B] },
    }),
    tags: [['expiration', String(NOW + 600)]],
    ...overrides,
  };
}

describe('parseExpirationTag', () => {
  it('parses a NIP-40 expiration tag', () => {
    expect(parseExpirationTag([['expiration', '12345']])).toBe(12345);
  });

  it('returns null when absent or unparseable', () => {
    expect(parseExpirationTag([])).toBeNull();
    expect(parseExpirationTag([['e', 'abc']])).toBeNull();
    expect(parseExpirationTag([['expiration', 'soon']])).toBeNull();
    expect(parseExpirationTag([['expiration', '-5']])).toBeNull();
  });
});

describe('LinkStateDatabase', () => {
  describe('ingest', () => {
    it('ingests a fresh announcement with a routing block', () => {
      const db = new LinkStateDatabase();
      expect(db.ingest(evt(), NOW)).toBe('ingested');
      expect(db.size).toBe(1);

      const entry = db.get(PK_A);
      expect(entry).toBeDefined();
      expect(entry!.routing.prefixes).toEqual([{ prefix: 'g.a', cost: 0 }]);
      expect(entry!.routing.adjacency).toEqual([PK_B]);
      expect(entry!.createdAt).toBe(NOW);
      expect(entry!.expiresAt).toBe(NOW + 600);
      expect(entry!.info.btpEndpoint).toBe('ws://a:3000');
    });

    it('treats a missing expiration tag as non-expiring', () => {
      const db = new LinkStateDatabase();
      expect(db.ingest(evt({ tags: [] }), NOW)).toBe('ingested');
      expect(db.get(PK_A)!.expiresAt).toBeNull();
      expect(db.sweepExpired(NOW + 999_999)).toEqual([]);
    });

    it('supersedes with a newer event per pubkey (replaceable semantics)', () => {
      const db = new LinkStateDatabase();
      db.ingest(evt(), NOW);

      const newer = evt({
        created_at: NOW + 10,
        content: JSON.stringify({
          ilpAddress: 'g.a',
          routing: { prefixes: [{ prefix: 'g.a2' }], adjacency: [] },
        }),
        tags: [['expiration', String(NOW + 700)]],
      });
      expect(db.ingest(newer, NOW)).toBe('ingested');
      expect(db.size).toBe(1);
      expect(db.get(PK_A)!.routing.prefixes).toEqual([{ prefix: 'g.a2' }]);
      expect(db.get(PK_A)!.expiresAt).toBe(NOW + 700);
    });

    it('rejects an older or equal-age event as stale', () => {
      const db = new LinkStateDatabase();
      db.ingest(evt(), NOW);
      expect(db.ingest(evt({ created_at: NOW - 10 }), NOW)).toBe('stale');
      expect(db.ingest(evt({ created_at: NOW }), NOW)).toBe('stale');
      expect(db.get(PK_A)!.createdAt).toBe(NOW);
    });

    it('rejects an already-expired event', () => {
      const db = new LinkStateDatabase();
      expect(db.ingest(evt({ tags: [['expiration', String(NOW - 1)]] }), NOW)).toBe('expired');
      expect(db.size).toBe(0);
    });

    it('withdraws an announcer whose NEWER event has no routing block', () => {
      const db = new LinkStateDatabase();
      db.ingest(evt(), NOW);
      const withoutRouting = evt({
        created_at: NOW + 5,
        content: JSON.stringify({ ilpAddress: 'g.a', btpEndpoint: 'ws://a:3000' }),
      });
      expect(db.ingest(withoutRouting, NOW)).toBe('ingested');
      expect(db.size).toBe(0);
    });

    it('rejects wrong kinds, malformed pubkeys, and malformed JSON', () => {
      const db = new LinkStateDatabase();
      expect(db.ingest(evt({ kind: 1 }), NOW)).toBe('invalid');
      expect(db.ingest(evt({ pubkey: 'not-hex' }), NOW)).toBe('invalid');
      expect(db.ingest(evt({ pubkey: PK_A.toUpperCase() }), NOW)).toBe('invalid');
      expect(db.ingest(evt({ content: '{not json' }), NOW)).toBe('invalid');
      expect(db.ingest(evt({ content: '"a string"' }), NOW)).toBe('invalid');
      expect(db.ingest(evt({ content: '[1,2]' }), NOW)).toBe('invalid');
      expect(db.ingest(evt({ created_at: Number.NaN }), NOW)).toBe('invalid');
      expect(db.size).toBe(0);
    });

    it('rejects a first-seen announcement with no routing block', () => {
      const db = new LinkStateDatabase();
      const noRouting = evt({ content: JSON.stringify({ ilpAddress: 'g.a' }) });
      expect(db.ingest(noRouting, NOW)).toBe('invalid');
      expect(db.size).toBe(0);
    });

    it('drops malformed prefix/adjacency ENTRIES while keeping the valid remainder', () => {
      const db = new LinkStateDatabase();
      const messy = evt({
        content: JSON.stringify({
          ilpAddress: 'g.a',
          routing: {
            prefixes: [
              { prefix: 'g.good', cost: 2 },
              { prefix: '', cost: 0 }, // empty prefix: dropped
              { prefix: 'g.badcost', cost: -1 }, // negative cost: dropped
              { prefix: 'g.nancost', cost: Number.NaN }, // NaN survives JSON as null: dropped
              'not-an-object', // dropped
              { cost: 1 }, // no prefix: dropped
              { prefix: 'g.free' }, // valid, cost omitted
            ],
            adjacency: [PK_B, 'garbage', 42, PK_C.toUpperCase(), PK_C],
          },
        }),
      });
      expect(db.ingest(messy, NOW)).toBe('ingested');
      const entry = db.get(PK_A)!;
      expect(entry.routing.prefixes).toEqual([{ prefix: 'g.good', cost: 2 }, { prefix: 'g.free' }]);
      expect(entry.routing.adjacency).toEqual([PK_B, PK_C]);
    });

    it('rejects a routing block whose prefixes/adjacency are not arrays', () => {
      const db = new LinkStateDatabase();
      const bad = evt({
        content: JSON.stringify({ ilpAddress: 'g.a', routing: { prefixes: 'x', adjacency: [] } }),
      });
      expect(db.ingest(bad, NOW)).toBe('invalid');
    });
  });

  describe('sweepExpired', () => {
    it('removes entries whose NIP-40 expiry has lapsed and reports them', () => {
      const db = new LinkStateDatabase();
      db.ingest(evt({ pubkey: PK_A, tags: [['expiration', String(NOW + 100)]] }), NOW);
      db.ingest(evt({ pubkey: PK_B, tags: [['expiration', String(NOW + 500)]] }), NOW);
      db.ingest(evt({ pubkey: PK_C, tags: [] }), NOW);

      expect(db.sweepExpired(NOW + 50)).toEqual([]);
      expect(db.sweepExpired(NOW + 100)).toEqual([PK_A]);
      expect(db.size).toBe(2);
      expect(db.sweepExpired(NOW + 1_000_000)).toEqual([PK_B]);
      expect(db.get(PK_C)).toBeDefined();
    });
  });

  describe('clear', () => {
    it('drops all entries', () => {
      const db = new LinkStateDatabase();
      db.ingest(evt(), NOW);
      db.clear();
      expect(db.size).toBe(0);
    });
  });
});
