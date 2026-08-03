import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPublicKey, verifyEvent } from 'nostr-tools';
import { buildIlpPeerInfoEvent, ILP_PEER_INFO_KIND, EXPIRATION_TAG } from './event';
import type { IlpPeerInfo } from './event';

const SECRET_KEY = Uint8Array.from(Buffer.from('1'.repeat(64), 'hex'));

const SAMPLE_INFO: IlpPeerInfo = {
  ilpAddress: 'g.toon',
  ilpAddresses: ['g.toon', 'g.toon.relay'],
  btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev/rust/ilp/btp',
  httpEndpoint: 'https://proxy.devnet.toonprotocol.dev/rust/ilp',
  assetCode: 'USDC',
  assetScale: 6,
  routes: { publish: 'g.toon.relay', store: 'g.toon.store' },
};

test('buildIlpPeerInfoEvent: kind is 10032', () => {
  const event = buildIlpPeerInfoEvent(SAMPLE_INFO, SECRET_KEY);
  assert.equal(event.kind, 10032);
  assert.equal(ILP_PEER_INFO_KIND, 10032);
});

test('buildIlpPeerInfoEvent: content is exactly JSON.stringify(info)', () => {
  const event = buildIlpPeerInfoEvent(SAMPLE_INFO, SECRET_KEY);
  assert.equal(event.content, JSON.stringify(SAMPLE_INFO));
  assert.deepEqual(JSON.parse(event.content), SAMPLE_INFO);
});

test('buildIlpPeerInfoEvent: signed by the given secret key, and verifies', () => {
  const event = buildIlpPeerInfoEvent(SAMPLE_INFO, SECRET_KEY);
  assert.equal(event.pubkey, getPublicKey(SECRET_KEY));
  assert.equal(verifyEvent(event), true);
});

test('buildIlpPeerInfoEvent: no ttlSeconds means no expiration tag and no d-tag ever (regular-replaceable 10032)', () => {
  const event = buildIlpPeerInfoEvent(SAMPLE_INFO, SECRET_KEY);
  assert.deepEqual(event.tags, []);
  assert.equal(
    event.tags.some((t) => t[0] === 'd'),
    false
  );
});

test('buildIlpPeerInfoEvent: a positive ttlSeconds adds a NIP-40 expiration tag = created_at + ttl', () => {
  const createdAt = 1_800_000_000;
  const event = buildIlpPeerInfoEvent(SAMPLE_INFO, SECRET_KEY, { ttlSeconds: 600, createdAt });
  assert.equal(event.created_at, createdAt);
  assert.deepEqual(event.tags, [[EXPIRATION_TAG, String(createdAt + 600)]]);
});

test('buildIlpPeerInfoEvent: a non-positive ttlSeconds omits the expiration tag', () => {
  const event = buildIlpPeerInfoEvent(SAMPLE_INFO, SECRET_KEY, { ttlSeconds: 0 });
  assert.deepEqual(event.tags, []);
});

test('buildIlpPeerInfoEvent: still never emits a d-tag even with extra content fields riding along', () => {
  const infoWithExtras: IlpPeerInfo = {
    ...SAMPLE_INFO,
    supportedChains: ['evm:84532', 'solana:devnet'],
    settlementAddresses: { 'evm:84532': '0xabc' },
    edgeIdentity: { keyId: 'k1', publicKey: '0xdead' },
  };
  const event = buildIlpPeerInfoEvent(infoWithExtras, SECRET_KEY, {
    ttlSeconds: 300,
    createdAt: 1000,
  });
  assert.deepEqual(event.tags, [[EXPIRATION_TAG, '1300']]);
  assert.deepEqual(JSON.parse(event.content), infoWithExtras);
});
