/**
 * Tests that the `selfAnnounce` config block (relay#37 / store#22) survives
 * `ConfigLoader.validateConfig` unchanged, and that absent it the config still
 * loads (backward compatible / opt-in).
 *
 * @module config/self-announce-config.test
 */

import { ConfigLoader } from './config-loader';
import type { ConnectorConfig } from './types';

function baseRaw(): Record<string, unknown> {
  return {
    nodeId: 'connector',
    btpServerPort: 3000,
    healthCheckPort: 8080,
    peers: [],
    routes: [
      {
        prefix: 'g.proxy.relay',
        nextHop: 'connector',
        upstream: 'http://relay:3100',
        price: '1000',
        chains: ['evm'],
        ilpAddress: 'g.proxy.relay',
        settlementAddresses: { evm: '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab' },
      },
    ],
  };
}

describe('ConfigLoader — selfAnnounce passthrough', () => {
  it('passes the selfAnnounce block through unchanged', () => {
    const raw = {
      ...baseRaw(),
      selfAnnounce: {
        enabled: true,
        announceTo: 'g.proxy.relay',
        announcePrice: '1000',
        refreshIntervalSecs: 300,
        btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
        relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev',
      },
    };
    const config: ConnectorConfig = ConfigLoader.validateConfig(raw);
    expect(config.selfAnnounce).toEqual({
      enabled: true,
      announceTo: 'g.proxy.relay',
      announcePrice: '1000',
      refreshIntervalSecs: 300,
      btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
      relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev',
    });
  });

  it('leaves selfAnnounce undefined when the block is absent (opt-in)', () => {
    const config = ConfigLoader.validateConfig(baseRaw());
    expect(config.selfAnnounce).toBeUndefined();
  });
});
