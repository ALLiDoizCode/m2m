/**
 * Unit tests for the DiscoveredNodeRegistry (toon-meta#153,
 * discovered-vs-peered split).
 *
 * Events are hand-built structural `LinkStateEventInput` objects — the
 * registry sits BEHIND the RouteLearningService's signature verification, so
 * no signing/network is involved (the verified-signature contract is covered
 * by the route-learning-service tests).
 *
 * Covers: discover/update/stale/expired ingest semantics, defensive parsing
 * of malformed content, NIP-40 sweep expiry, self-exclusion, funded matching
 * (pubkey and btpEndpoint-fallback, recomputed at read time), counts, and
 * clear().
 *
 * @module discovery/discovered-node-registry.test
 */

import { createLogger } from '../utils/logger';
import type { LinkStateEventInput } from '../routing/link-state-db';
import { ILP_PEER_INFO_KIND } from './ilp-peer-info-event';
import { DiscoveredNodeRegistry, type FundedPeerRef } from './discovered-node-registry';

const logger = createLogger('discovered-node-registry-test', 'silent');

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const PK_SELF = 'c'.repeat(64);

const NOW = 1_800_000_000;

function makeEvent(
  pubkey: string,
  // Loosely typed on purpose: malformed-input cases deliberately carry
  // wrong-typed fields the defensive parser must reject or drop.
  info: Record<string, unknown>,
  opts: { createdAt?: number; expiresAt?: number; kind?: number; content?: string } = {}
): LinkStateEventInput {
  const payload: Record<string, unknown> = {
    ilpAddress: 'g.node',
    btpEndpoint: 'wss://node.example:443',
    assetCode: 'USDC',
    assetScale: 6,
    ...info,
  };
  return {
    kind: opts.kind ?? ILP_PEER_INFO_KIND,
    pubkey,
    created_at: opts.createdAt ?? NOW,
    content: opts.content ?? JSON.stringify(payload),
    tags: opts.expiresAt !== undefined ? [['expiration', String(opts.expiresAt)]] : [],
  };
}

function makeRegistry(
  fundedPeers: FundedPeerRef[] = [],
  ownPubkey?: string
): { registry: DiscoveredNodeRegistry; funded: { current: FundedPeerRef[] } } {
  const funded = { current: fundedPeers };
  const registry = new DiscoveredNodeRegistry({
    getFundedPeers: () => funded.current,
    ...(ownPubkey !== undefined ? { ownPubkey } : {}),
    logger,
  });
  return { registry, funded };
}

describe('DiscoveredNodeRegistry', () => {
  describe('ingest', () => {
    it('discovers a new node and surfaces its announced fields', () => {
      const { registry } = makeRegistry();
      const result = registry.ingest(
        makeEvent(PK_A, {
          ilpAddress: 'g.alpha',
          ilpAddresses: ['g.alpha', 'g.alpha.relay'],
          btpEndpoint: 'wss://alpha.example:443',
          httpEndpoint: 'https://alpha.example/ilp',
          relayUrl: 'wss://relay.alpha.example',
          supportedChains: ['evm:31337'],
          settlementAddresses: { 'evm:31337': '0x' + '1'.repeat(40) },
        }),
        NOW
      );

      expect(result).toBe('discovered');
      expect(registry.size()).toBe(1);
      const nodes = registry.list();
      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toMatchObject({
        pubkey: PK_A,
        ilpAddress: 'g.alpha',
        ilpAddresses: ['g.alpha', 'g.alpha.relay'],
        btpEndpoint: 'wss://alpha.example:443',
        httpEndpoint: 'https://alpha.example/ilp',
        relayUrl: 'wss://relay.alpha.example',
        assetCode: 'USDC',
        assetScale: 6,
        supportedChains: ['evm:31337'],
        settlementAddresses: { 'evm:31337': '0x' + '1'.repeat(40) },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        funded: false,
      });
      expect(nodes[0]!.expiresAt).toBeUndefined();
    });

    it('defaults ilpAddresses to [ilpAddress] when absent', () => {
      const { registry } = makeRegistry();
      registry.ingest(makeEvent(PK_A, { ilpAddress: 'g.alpha' }), NOW);
      expect(registry.list()[0]!.ilpAddresses).toEqual(['g.alpha']);
    });

    it('updates in place on a fresher announcement, preserving firstSeenAt', () => {
      const { registry } = makeRegistry();
      registry.ingest(makeEvent(PK_A, { ilpAddress: 'g.old' }, { createdAt: NOW }), NOW);
      const result = registry.ingest(
        makeEvent(PK_A, { ilpAddress: 'g.new' }, { createdAt: NOW + 10 }),
        NOW + 10
      );

      expect(result).toBe('updated');
      expect(registry.size()).toBe(1);
      const node = registry.list()[0]!;
      expect(node.ilpAddress).toBe('g.new');
      expect(node.firstSeenAt).toBe(NOW);
      expect(node.lastSeenAt).toBe(NOW + 10);
    });

    it('ignores an announcement older than (or equal-age to) the stored one', () => {
      const { registry } = makeRegistry();
      registry.ingest(makeEvent(PK_A, { ilpAddress: 'g.fresh' }, { createdAt: NOW }), NOW);
      expect(
        registry.ingest(makeEvent(PK_A, { ilpAddress: 'g.stale' }, { createdAt: NOW - 5 }), NOW)
      ).toBe('stale');
      expect(
        registry.ingest(makeEvent(PK_A, { ilpAddress: 'g.same' }, { createdAt: NOW }), NOW)
      ).toBe('stale');
      expect(registry.list()[0]!.ilpAddress).toBe('g.fresh');
    });

    it('skips an announcement that is already expired at ingest time', () => {
      const { registry } = makeRegistry();
      const result = registry.ingest(makeEvent(PK_A, {}, { expiresAt: NOW - 1 }), NOW);
      expect(result).toBe('expired');
      expect(registry.size()).toBe(0);
    });

    it('skips its own announcement when ownPubkey is set', () => {
      const { registry } = makeRegistry([], PK_SELF);
      expect(registry.ingest(makeEvent(PK_SELF, {}), NOW)).toBe('self');
      expect(registry.ingest(makeEvent(PK_A, {}), NOW)).toBe('discovered');
      expect(registry.size()).toBe(1);
    });

    it.each([
      ['wrong kind', makeEvent(PK_A, {}, { kind: 1 })],
      ['bad pubkey', makeEvent('not-hex', {})],
      ['unparseable content', makeEvent(PK_A, {}, { content: '{nope' })],
      ['non-object content', makeEvent(PK_A, {}, { content: '[1,2]' })],
      ['missing ilpAddress', makeEvent(PK_A, { ilpAddress: undefined })],
      ['missing btpEndpoint', makeEvent(PK_A, { btpEndpoint: undefined })],
      ['missing assetCode', makeEvent(PK_A, { assetCode: undefined })],
      ['non-numeric assetScale', makeEvent(PK_A, { assetScale: 'six' })],
    ])('rejects malformed input without throwing: %s', (_label, event) => {
      const { registry } = makeRegistry();
      expect(registry.ingest(event, NOW)).toBe('invalid');
      expect(registry.size()).toBe(0);
    });

    it('drops malformed optional entries while keeping the rest', () => {
      const { registry } = makeRegistry();
      registry.ingest(
        makeEvent(PK_A, {
          httpEndpoint: 42,
          supportedChains: ['evm:31337', 7, ''],
          settlementAddresses: { 'evm:31337': '0xabc', 'solana:x': 99 },
        }),
        NOW
      );
      const node = registry.list()[0]!;
      expect(node.httpEndpoint).toBeUndefined();
      expect(node.supportedChains).toEqual(['evm:31337']);
      expect(node.settlementAddresses).toEqual({ 'evm:31337': '0xabc' });
    });
  });

  describe('sweepExpired', () => {
    it('removes entries whose NIP-40 expiry has lapsed and keeps the rest', () => {
      const { registry } = makeRegistry();
      registry.ingest(makeEvent(PK_A, {}, { expiresAt: NOW + 60 }), NOW);
      registry.ingest(makeEvent(PK_B, {}, { expiresAt: NOW + 600 }), NOW);

      expect(registry.sweepExpired(NOW + 61)).toEqual([PK_A]);
      expect(registry.size()).toBe(1);
      expect(registry.list()[0]!.pubkey).toBe(PK_B);
    });

    it('never expires a non-expiring announcement', () => {
      const { registry } = makeRegistry();
      registry.ingest(makeEvent(PK_A, {}), NOW);
      expect(registry.sweepExpired(NOW + 1_000_000)).toEqual([]);
      expect(registry.size()).toBe(1);
    });
  });

  describe('funded matching', () => {
    it('flags funded via a live peer whose Nostr pubkey matches the announcer', () => {
      const { registry } = makeRegistry([{ peerId: 'upstream-a', nostrPubkey: PK_A }]);
      registry.ingest(makeEvent(PK_A, {}), NOW);
      registry.ingest(makeEvent(PK_B, {}), NOW);

      const byPubkey = new Map(registry.list().map((n) => [n.pubkey, n.funded]));
      expect(byPubkey.get(PK_A)).toBe(true);
      expect(byPubkey.get(PK_B)).toBe(false);
    });

    it('falls back to btpEndpoint === peer.url when no pubkey is configured', () => {
      const { registry } = makeRegistry([{ peerId: 'upstream-a', btpUrl: 'wss://a.example:443' }]);
      registry.ingest(makeEvent(PK_A, { btpEndpoint: 'wss://a.example:443' }), NOW);
      registry.ingest(makeEvent(PK_B, { btpEndpoint: 'wss://b.example:443' }), NOW);

      const byPubkey = new Map(registry.list().map((n) => [n.pubkey, n.funded]));
      expect(byPubkey.get(PK_A)).toBe(true);
      expect(byPubkey.get(PK_B)).toBe(false);
    });

    it('recomputes funded at read time as the live peer set changes', () => {
      const { registry, funded } = makeRegistry([]);
      registry.ingest(makeEvent(PK_A, {}), NOW);
      expect(registry.list()[0]!.funded).toBe(false);

      funded.current = [{ peerId: 'upstream-a', nostrPubkey: PK_A }];
      expect(registry.list()[0]!.funded).toBe(true);

      funded.current = []; // peer removed → discovered entry un-funds immediately
      expect(registry.list()[0]!.funded).toBe(false);
    });

    it('counts() reports discovered vs funded (gauge source)', () => {
      const { registry } = makeRegistry([{ peerId: 'upstream-a', nostrPubkey: PK_A }]);
      registry.ingest(makeEvent(PK_A, {}), NOW);
      registry.ingest(makeEvent(PK_B, {}), NOW);
      expect(registry.counts()).toEqual({ discovered: 2, funded: 1 });
    });
  });

  it('clear() drops everything (service stop — soft state)', () => {
    const { registry } = makeRegistry();
    registry.ingest(makeEvent(PK_A, {}), NOW);
    registry.clear();
    expect(registry.size()).toBe(0);
    expect(registry.list()).toEqual([]);
  });

  it('list() sorts by ILP address for stable operator output', () => {
    const { registry } = makeRegistry();
    registry.ingest(makeEvent(PK_B, { ilpAddress: 'g.zeta' }), NOW);
    registry.ingest(makeEvent(PK_A, { ilpAddress: 'g.alpha' }), NOW);
    expect(registry.list().map((n) => n.ilpAddress)).toEqual(['g.alpha', 'g.zeta']);
  });
});
