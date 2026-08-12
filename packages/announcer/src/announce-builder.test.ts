import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnnouncementInfo } from './announce-builder';
import type { AnnounceStaticConfig } from './announce-builder';
import type { ClientEdgeIdentity, RouteGreeting } from './edge-client';

const CONFIG: AnnounceStaticConfig = {
  ilpAddress: 'g.toon',
  ilpAddresses: ['g.toon', 'g.toon.relay', 'g.toon.store'],
  httpEndpoint: 'https://proxy.devnet.toonprotocol.dev/rust/ilp',
  btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev/rust/ilp/btp',
  relayUrl: 'wss://relay.devnet.toonprotocol.dev',
  assetCode: 'USDC',
  assetScale: 6,
  routePublish: 'g.toon.relay',
  routeStore: 'g.toon.store',
  solanaChainId: 'solana:devnet',
};

const IDENTITY: ClientEdgeIdentity = { keyId: 'edge-key-1', publicKey: '0x04deadbeef' };

const EVM_GREETING: RouteGreeting = {
  destination: 'g.toon.relay',
  price: '1000',
  httpEndpoint: '/ilp',
  settlement: {
    chain: 'evm:84532',
    settlementAddress: '0xSettlement',
    tokenNetworkRegistry: '0xRegistry',
    tokenNetwork: '0xTokenNetwork',
    tokenAddress: '0xToken',
    decimals: 6,
  },
  settlements: [
    {
      chain: 'evm:84532',
      settlementAddress: '0xSettlement',
      tokenNetworkRegistry: '0xRegistry',
      tokenNetwork: '0xTokenNetwork',
      tokenAddress: '0xToken',
      decimals: 6,
    },
    {
      chain: 'solana',
      settlementAddress: 'SolSettlement111',
      programId: 'ProgramId1111',
      tokenAddress: 'MintAddress111',
      decimals: 6,
    },
  ],
};

test('buildAnnouncementInfo: given a mocked identity + greeting, produces the exact expected IlpPeerInfo shape', () => {
  const info = buildAnnouncementInfo(CONFIG, IDENTITY, [EVM_GREETING]);

  assert.deepEqual(info, {
    ilpAddress: 'g.toon',
    ilpAddresses: ['g.toon', 'g.toon.relay', 'g.toon.store'],
    btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev/rust/ilp/btp',
    httpEndpoint: 'https://proxy.devnet.toonprotocol.dev/rust/ilp',
    relayUrl: 'wss://relay.devnet.toonprotocol.dev',
    assetCode: 'USDC',
    assetScale: 6,
    supportedChains: ['evm:84532', 'solana:devnet'],
    settlementAddresses: {
      'evm:84532': '0xSettlement',
      'solana:devnet': 'SolSettlement111',
    },
    tokenNetworks: {
      'evm:84532': '0xTokenNetwork',
      'solana:devnet': 'ProgramId1111',
    },
    preferredTokens: {
      'evm:84532': '0xToken',
      'solana:devnet': 'MintAddress111',
    },
    routePrices: { 'g.toon.relay': '1000' },
    edgeIdentity: { keyId: 'edge-key-1', publicKey: '0x04deadbeef' },
    routes: { publish: 'g.toon.relay', store: 'g.toon.store' },
  });
});

test('buildAnnouncementInfo: re-qualifies the edge greeting\'s bare "solana" chain to the configured solanaChainId', () => {
  const info = buildAnnouncementInfo(CONFIG, null, [EVM_GREETING]);
  assert.ok(info.supportedChains?.includes('solana:devnet'));
  assert.ok(!info.supportedChains?.includes('solana'));
});

test('buildAnnouncementInfo: degrades gracefully when identity and every greeting failed to resolve', () => {
  const info = buildAnnouncementInfo(CONFIG, null, []);
  assert.deepEqual(info, {
    ilpAddress: 'g.toon',
    ilpAddresses: ['g.toon', 'g.toon.relay', 'g.toon.store'],
    btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev/rust/ilp/btp',
    httpEndpoint: 'https://proxy.devnet.toonprotocol.dev/rust/ilp',
    relayUrl: 'wss://relay.devnet.toonprotocol.dev',
    assetCode: 'USDC',
    assetScale: 6,
    routes: { publish: 'g.toon.relay', store: 'g.toon.store' },
  });
});

test('buildAnnouncementInfo: sets notice on the schema field when configured', () => {
  const notice = {
    id: 'maintenance-2026-08',
    severity: 'info' as const,
    summary: 'Scheduled maintenance this weekend',
    url: 'https://example.com/notices/maintenance-2026-08',
  };
  const info = buildAnnouncementInfo({ ...CONFIG, notice }, null, []);
  assert.deepEqual(info.notice, notice);
});

test('buildAnnouncementInfo: omits notice entirely when not configured — no key, no default', () => {
  const info = buildAnnouncementInfo(CONFIG, null, []);
  assert.equal('notice' in info, false);
});

test('buildAnnouncementInfo: omits ilpAddresses/relayUrl when there is only one address / no relayUrl configured', () => {
  const info = buildAnnouncementInfo(
    { ...CONFIG, ilpAddresses: ['g.toon'], relayUrl: undefined },
    null,
    []
  );
  assert.equal('ilpAddresses' in info, false);
  assert.equal('relayUrl' in info, false);
});
