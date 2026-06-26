/**
 * Tests for deriving the connector's own kind:10032 announcement from its
 * config (relay#37 / store#22).
 *
 * Uses the REAL canonical deploy route shapes (relay/deploy/connector.yaml and
 * store/deploy/connector.yaml) so the derivation is exercised against the
 * topologies it must support: a relay-connector apex (terminates `g.proxy.relay`,
 * forwards `g.proxy.store`/`g.proxy.relay.store`) and a store-connector apex
 * (terminates `g.proxy.store` + `g.proxy.relay.store`).
 *
 * @module discovery/self-announce-builder.test
 */

import type { ConnectorConfig, SelfAnnounceConfig } from '../config/types';
import { buildSelfAnnouncementInfo, resolveRouteHints } from './self-announce-builder';

const APEX_EVM = '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab';
const STORE_EVM = '0x1f4E12A9357a3c46477F95F6f9813eeBF49f106e';

/** Mirror of relay/deploy/connector.yaml (the relay-connector / g.proxy apex). */
function relayConnectorConfig(): ConnectorConfig {
  return {
    nodeId: 'connector',
    btpServerPort: 3000,
    environment: 'development',
    peers: [],
    chainProviders: [
      {
        chainType: 'evm',
        chainId: 'evm:31337',
        rpcUrl: 'https://evm-rpc.devnet.toonprotocol.dev',
        registryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
        keyId: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      } as ConnectorConfig['chainProviders'] extends (infer T)[] ? T : never,
    ],
    routes: [
      {
        prefix: 'g.proxy.relay',
        nextHop: 'connector',
        upstream: 'http://relay:3100',
        price: '1000',
        chains: ['evm'],
        ilpAddress: 'g.proxy.relay',
        settlementAddresses: { evm: APEX_EVM },
      },
      {
        prefix: 'g.proxy.relay.store',
        nextHop: 'store-box',
        price: '1000',
        chains: ['evm'],
        ilpAddress: 'g.proxy.relay.store',
        settlementAddresses: { evm: APEX_EVM },
      },
      {
        prefix: 'g.proxy.store',
        nextHop: 'store-box',
        price: '1000',
        chains: ['evm'],
        ilpAddress: 'g.proxy.store',
        settlementAddresses: { evm: APEX_EVM },
      },
    ],
  };
}

/** Mirror of store/deploy/connector.yaml (the store-connector apex). */
function storeConnectorConfig(): ConnectorConfig {
  return {
    nodeId: 'connector',
    btpServerPort: 3000,
    environment: 'development',
    peers: [],
    chainProviders: [
      {
        chainType: 'evm',
        chainId: 'evm:31337',
        rpcUrl: 'https://evm-rpc.devnet.toonprotocol.dev',
        registryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
        keyId: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      } as ConnectorConfig['chainProviders'] extends (infer T)[] ? T : never,
    ],
    routes: [
      {
        prefix: 'g.proxy.store',
        nextHop: 'connector',
        upstream: 'http://store:3300',
        price: '1000',
        chains: ['evm'],
        ilpAddress: 'g.proxy.store',
        settlementAddresses: { evm: STORE_EVM },
      },
      {
        prefix: 'g.proxy.relay.store',
        nextHop: 'connector',
        upstream: 'http://store:3300',
        price: '1000',
        chains: ['evm'],
        ilpAddress: 'g.proxy.relay.store',
        settlementAddresses: { evm: STORE_EVM },
      },
    ],
  };
}

const baseSelfAnnounce: SelfAnnounceConfig = {
  enabled: true,
  announceTo: 'g.proxy.relay',
  btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
};

describe('buildSelfAnnouncementInfo — relay-connector apex', () => {
  it('advertises the terminated relay route as the primary ilpAddress', () => {
    const info = buildSelfAnnouncementInfo(relayConnectorConfig(), baseSelfAnnounce);
    // Only g.proxy.relay is locally terminated (has an upstream).
    expect(info.ilpAddress).toBe('g.proxy.relay');
    // A single terminated route → no ilpAddresses array.
    expect(info.ilpAddresses).toBeUndefined();
  });

  it('derives supportedChains, settlement, asset, and endpoints from config', () => {
    const info = buildSelfAnnouncementInfo(relayConnectorConfig(), baseSelfAnnounce);
    expect(info.supportedChains).toEqual(['evm:31337']);
    expect(info.settlementAddresses).toEqual({ evm: APEX_EVM });
    expect(info.assetCode).toBe('USDC');
    expect(info.assetScale).toBe(6);
    expect(info.btpEndpoint).toBe('wss://proxy.devnet.toonprotocol.dev:443');
  });

  it('derives route hints: publish=g.proxy.relay, store=g.proxy.store', () => {
    const info = buildSelfAnnouncementInfo(relayConnectorConfig(), baseSelfAnnounce);
    expect(info.routes).toEqual({ publish: 'g.proxy.relay', store: 'g.proxy.store' });
  });

  it('passes through advertised httpEndpoint and relayUrl when set', () => {
    const info = buildSelfAnnouncementInfo(relayConnectorConfig(), {
      ...baseSelfAnnounce,
      httpEndpoint: 'https://proxy.devnet.toonprotocol.dev/ilp',
      relayUrl: 'wss://relay.devnet.toonprotocol.dev',
    });
    expect(info.httpEndpoint).toBe('https://proxy.devnet.toonprotocol.dev/ilp');
    expect(info.relayUrl).toBe('wss://relay.devnet.toonprotocol.dev');
  });
});

describe('buildSelfAnnouncementInfo — store-connector apex', () => {
  it('advertises both terminated store routes (multi-address)', () => {
    const info = buildSelfAnnouncementInfo(storeConnectorConfig(), baseSelfAnnounce);
    expect(info.ilpAddress).toBe('g.proxy.store');
    expect(info.ilpAddresses).toEqual(['g.proxy.store', 'g.proxy.relay.store']);
    expect(info.settlementAddresses).toEqual({ evm: STORE_EVM });
  });

  it('derives route hints: publish swapped from store, store=direct g.proxy.store', () => {
    const info = buildSelfAnnouncementInfo(storeConnectorConfig(), baseSelfAnnounce);
    // No `.relay` route on the store box → publish is derived by swapping the
    // trailing `.store` of the direct store route for `.relay`.
    expect(info.routes).toEqual({ publish: 'g.proxy.relay', store: 'g.proxy.store' });
  });
});

describe('resolveRouteHints', () => {
  const routes = relayConnectorConfig().routes;

  it('honors explicit overrides over derivation', () => {
    expect(
      resolveRouteHints(routes, { publish: 'g.custom.publish', store: 'g.custom.store' })
    ).toEqual({ publish: 'g.custom.publish', store: 'g.custom.store' });
  });

  it('fills only the missing side from an override', () => {
    expect(resolveRouteHints(routes, { store: 'g.override.store' })).toEqual({
      publish: 'g.proxy.relay',
      store: 'g.override.store',
    });
  });

  it('prefers the DIRECT .store route over the .relay.store hop path', () => {
    expect(resolveRouteHints(routes).store).toBe('g.proxy.store');
  });

  it('falls back to the first route when no .relay/.store labels exist', () => {
    const plain = [
      { prefix: 'g.connector.greet', nextHop: 'local', ilpAddress: 'g.connector.greet' },
    ] as ConnectorConfig['routes'];
    expect(resolveRouteHints(plain)).toEqual({
      publish: 'g.connector.greet',
      store: 'g.connector.greet',
    });
  });
});
