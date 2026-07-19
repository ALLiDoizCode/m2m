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
  parseCapabilityDirectory,
  normalizeCapabilityName,
  ILP_PEER_INFO_KIND,
  EXPIRATION_TAG,
  type IlpCapabilityEntry,
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

/**
 * parseCapabilityDirectory (toon-meta#153): defensive extraction of the
 * optional `capabilities` directory from OTHER nodes' kind:10032 content.
 */
describe('parseCapabilityDirectory', () => {
  it('parses a well-formed directory', () => {
    const entries = parseCapabilityDirectory({
      ilpAddress: 'g.peer1',
      capabilities: [
        { capability: 'os.store', address: 'g.peer1.store', price: '2', schema: 'sha256:ab01' },
        { capability: 'os.publish', address: 'g.peer1.relay' },
      ],
    });
    expect(entries).toEqual([
      { capability: 'os.store', address: 'g.peer1.store', price: '2', schema: 'sha256:ab01' },
      { capability: 'os.publish', address: 'g.peer1.relay' },
    ]);
  });

  it('returns [] when the block is absent or structurally unusable', () => {
    expect(parseCapabilityDirectory(null)).toEqual([]);
    expect(parseCapabilityDirectory('str')).toEqual([]);
    expect(parseCapabilityDirectory({})).toEqual([]);
    expect(parseCapabilityDirectory({ capabilities: 'x' })).toEqual([]);
    expect(parseCapabilityDirectory({ capabilities: {} })).toEqual([]);
    expect(parseCapabilityDirectory({ capabilities: null })).toEqual([]);
  });

  it('drops malformed entries individually, keeping the valid remainder, never throwing', () => {
    const entries = parseCapabilityDirectory({
      capabilities: [
        { capability: 'os.get', address: 'g.peer1.store' }, // valid
        null,
        'string',
        42,
        [],
        { capability: 42, address: 'g.peer1.store' }, // non-string name
        { capability: '.bad', address: 'g.peer1.store' }, // bad name shape
        { capability: 'os bad', address: 'g.peer1.store' }, // bad name shape
        { capability: 'os.run' }, // missing address
        { capability: 'os.run', address: 'not an ilp address!' }, // bad address
        { capability: 'os.run', address: 42 }, // non-string address
        { capability: 'os.run', address: 'g.peer1.run', price: '-1' }, // bad price
        { capability: 'os.run', address: 'g.peer1.run', price: 7 }, // non-string price
        { capability: 'os.run', address: 'g.peer1.run', price: '1.5' }, // non-integer price
        { capability: 'os.swap', address: 'g.peer1.swap', schema: '' }, // empty schema
        { capability: 'os.swap', address: 'g.peer1.swap', schema: 9 }, // non-string schema
        { capability: 'os.send', address: 'g.peer1', price: '0' }, // valid (free)
      ],
    });
    expect(entries).toEqual([
      { capability: 'os.get', address: 'g.peer1.store' },
      { capability: 'os.send', address: 'g.peer1', price: '0' },
    ]);
  });

  it('normalizes capability names to lowercase and allows bare names (forward-compat)', () => {
    const entries = parseCapabilityDirectory({
      capabilities: [
        { capability: ' OS.Put ', address: 'g.peer1.store' },
        { capability: 'nostr-relay', address: 'g.peer1.relay' },
      ],
    });
    expect(entries).toEqual([
      { capability: 'os.put', address: 'g.peer1.store' },
      { capability: 'nostr-relay', address: 'g.peer1.relay' },
    ]);
  });

  it('round-trips through a signed kind:10032 event content, alongside legacy hints', () => {
    const capabilities: IlpCapabilityEntry[] = [
      { capability: 'os.store', address: 'g.proxy.store', price: '1000', schema: 'sha256:ab01' },
    ];
    const info: IlpPeerInfo = {
      ilpAddress: 'g.proxy.relay',
      btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
      assetCode: 'USDC',
      assetScale: 6,
      capabilities,
      routes: { publish: 'g.proxy.relay', store: 'g.proxy.store' },
    };
    const event = buildIlpPeerInfoEvent(info, generateSecretKey());
    expect(verifyEvent(event)).toBe(true);
    const content = JSON.parse(event.content) as IlpPeerInfo;
    expect(parseCapabilityDirectory(content)).toEqual(capabilities);
    // Legacy hints ride along unchanged (deployed consumers parse them).
    expect(content.routes).toEqual({ publish: 'g.proxy.relay', store: 'g.proxy.store' });
  });
});

describe('normalizeCapabilityName', () => {
  it('trims and lowercases valid names', () => {
    expect(normalizeCapabilityName('os.put')).toBe('os.put');
    expect(normalizeCapabilityName('  OS.TRANSFER ')).toBe('os.transfer');
    expect(normalizeCapabilityName('blob-store')).toBe('blob-store');
    expect(normalizeCapabilityName('a1._x-y')).toBe('a1._x-y');
  });

  it('returns null for malformed names', () => {
    expect(normalizeCapabilityName('')).toBeNull();
    expect(normalizeCapabilityName('   ')).toBeNull();
    expect(normalizeCapabilityName('.leading-dot')).toBeNull();
    expect(normalizeCapabilityName('-leading-dash')).toBeNull();
    expect(normalizeCapabilityName('has space')).toBeNull();
    expect(normalizeCapabilityName('bad/slash')).toBeNull();
  });
});
