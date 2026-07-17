/**
 * Tests for the local kind:10032 IlpPeerInfo builder (relay#37 / store#22).
 *
 * Verifies the builder is byte-compatible with the core wire format: kind
 * 10032, `content = JSON.stringify(info)` (including out-of-band content fields
 * that ride along WITHOUT a wire-type change), a NIP-40 `expiration` tag at
 * `created_at + ttlSeconds`, and a valid Schnorr signature under the NIP-06
 * key.
 *
 * @module discovery/ilp-peer-info-event.test
 */

import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import {
  buildIlpPeerInfoEvent,
  parseRoutingInfo,
  ILP_PEER_INFO_KIND,
  EXPIRATION_TAG,
  type IlpPeerInfo,
} from './ilp-peer-info-event';

describe('buildIlpPeerInfoEvent', () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);

  const info: IlpPeerInfo = {
    ilpAddress: 'g.proxy.relay',
    btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
    assetCode: 'USDC',
    assetScale: 6,
    supportedChains: ['evm:31337'],
    settlementAddresses: { evm: '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab' },
  };

  it('builds a kind:10032 replaceable event signed under the NIP-06 key', () => {
    const event = buildIlpPeerInfoEvent(info, sk);
    expect(event.kind).toBe(ILP_PEER_INFO_KIND);
    expect(event.kind).toBe(10032);
    expect(event.pubkey).toBe(pk);
    expect(verifyEvent(event)).toBe(true);
  });

  it('serializes the IlpPeerInfo into content verbatim', () => {
    const event = buildIlpPeerInfoEvent(info, sk);
    expect(JSON.parse(event.content)).toEqual(info);
  });

  it('carries out-of-band content fields (route hints) without a wire-type change', () => {
    // The issue requirement: route hints ride along in CONTENT, not core wire
    // types. Since the builder JSON-stringifies the whole object, extra fields
    // survive the round-trip.
    const withRoutes = {
      ...info,
      routes: { publish: 'g.proxy.relay', store: 'g.proxy.store' },
    };
    const event = buildIlpPeerInfoEvent(withRoutes, sk);
    const parsed = JSON.parse(event.content) as typeof withRoutes;
    expect(parsed.routes).toEqual({ publish: 'g.proxy.relay', store: 'g.proxy.store' });
  });

  it('stamps a NIP-40 expiration tag at created_at + ttlSeconds when ttl is positive', () => {
    const ttl = 600;
    const event = buildIlpPeerInfoEvent(info, sk, { ttlSeconds: ttl });
    const expirationTag = event.tags.find((t) => t[0] === EXPIRATION_TAG);
    expect(expirationTag).toBeDefined();
    const expiry = Number(expirationTag![1]);
    expect(expiry).toBe(event.created_at + ttl);
    // Must be in the future relative to creation.
    expect(expiry).toBeGreaterThan(event.created_at);
  });

  it('omits the expiration tag when ttlSeconds is absent or non-positive', () => {
    expect(buildIlpPeerInfoEvent(info, sk).tags).toEqual([]);
    expect(buildIlpPeerInfoEvent(info, sk, { ttlSeconds: 0 }).tags).toEqual([]);
    expect(buildIlpPeerInfoEvent(info, sk, { ttlSeconds: -5 }).tags).toEqual([]);
  });
});

/**
 * parseRoutingInfo (toon-meta#153): defensive extraction of the optional
 * link-state block from OTHER nodes' kind:10032 content.
 */
describe('parseRoutingInfo', () => {
  const PK = 'ab'.repeat(32);

  it('parses a well-formed routing block', () => {
    const routing = parseRoutingInfo({
      ilpAddress: 'g.a',
      routing: { prefixes: [{ prefix: 'g.a', cost: 0 }, { prefix: 'g.b' }], adjacency: [PK] },
    });
    expect(routing).toEqual({
      prefixes: [{ prefix: 'g.a', cost: 0 }, { prefix: 'g.b' }],
      adjacency: [PK],
    });
  });

  it('returns null when the block is absent or malformed', () => {
    expect(parseRoutingInfo(null)).toBeNull();
    expect(parseRoutingInfo('str')).toBeNull();
    expect(parseRoutingInfo({})).toBeNull();
    expect(parseRoutingInfo({ routing: 'x' })).toBeNull();
    expect(parseRoutingInfo({ routing: [] })).toBeNull();
    expect(parseRoutingInfo({ routing: { prefixes: 'x', adjacency: [] } })).toBeNull();
    expect(parseRoutingInfo({ routing: { prefixes: [], adjacency: {} } })).toBeNull();
  });

  it('drops malformed entries but keeps the valid remainder, never throwing', () => {
    const routing = parseRoutingInfo({
      routing: {
        prefixes: [
          { prefix: 'g.good' },
          { prefix: '' },
          { prefix: 42 },
          { prefix: 'g.neg', cost: -1 },
          { prefix: 'g.inf', cost: Number.POSITIVE_INFINITY },
          null,
          'string',
        ],
        adjacency: [PK, PK.toUpperCase(), 'short', 7, null],
      },
    });
    expect(routing).toEqual({ prefixes: [{ prefix: 'g.good' }], adjacency: [PK] });
  });

  it('round-trips through a signed kind:10032 event content', () => {
    const withRouting: IlpPeerInfo = {
      ilpAddress: 'g.proxy.relay',
      btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
      assetCode: 'USDC',
      assetScale: 6,
      routing: { prefixes: [{ prefix: 'g.proxy.relay', cost: 0 }], adjacency: [PK] },
    };
    const event = buildIlpPeerInfoEvent(withRouting, generateSecretKey());
    expect(verifyEvent(event)).toBe(true);
    const parsed = parseRoutingInfo(JSON.parse(event.content));
    expect(parsed).toEqual(withRouting.routing);
  });
});
