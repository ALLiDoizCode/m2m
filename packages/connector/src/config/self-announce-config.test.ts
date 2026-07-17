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

  it('rejects a non-object selfAnnounce block', () => {
    expect(() => ConfigLoader.validateConfig({ ...baseRaw(), selfAnnounce: 'yes' })).toThrow(
      /selfAnnounce must be an object/
    );
    expect(() => ConfigLoader.validateConfig({ ...baseRaw(), selfAnnounce: [] })).toThrow(
      /selfAnnounce must be an object/
    );
  });
});

describe('ConfigLoader — selfAnnounce.capabilities validation (toon-meta#153)', () => {
  const withCapabilities = (capabilities: unknown): Record<string, unknown> => ({
    ...baseRaw(),
    selfAnnounce: { enabled: true, announceTo: 'g.proxy.relay', capabilities },
  });

  it('passes valid explicit capability entries through unchanged', () => {
    const capabilities = [
      { capability: 'os.run', address: 'g.proxy.run', price: '5', schema: 'sha256:ab01' },
      { capability: 'nostr-relay', address: 'g.proxy.relay' },
    ];
    const config = ConfigLoader.validateConfig(withCapabilities(capabilities));
    expect(config.selfAnnounce?.capabilities).toEqual(capabilities);
  });

  it('accepts an absent capabilities list (opt-in)', () => {
    const raw = {
      ...baseRaw(),
      selfAnnounce: { enabled: true, announceTo: 'g.proxy.relay' },
    };
    expect(() => ConfigLoader.validateConfig(raw)).not.toThrow();
  });

  it('rejects a non-array capabilities list and non-object entries', () => {
    expect(() => ConfigLoader.validateConfig(withCapabilities('x'))).toThrow(
      /selfAnnounce\.capabilities must be an array/
    );
    expect(() => ConfigLoader.validateConfig(withCapabilities(['x']))).toThrow(
      /entries must be objects/
    );
    expect(() => ConfigLoader.validateConfig(withCapabilities([null]))).toThrow(
      /entries must be objects/
    );
  });

  it('rejects a malformed capability name', () => {
    expect(() =>
      ConfigLoader.validateConfig(withCapabilities([{ capability: '.bad', address: 'g.x' }]))
    ).toThrow(/capability must be a name/);
    expect(() => ConfigLoader.validateConfig(withCapabilities([{ address: 'g.x' }]))).toThrow(
      /capability must be a name/
    );
  });

  it('rejects an invalid ILP address', () => {
    expect(() =>
      ConfigLoader.validateConfig(
        withCapabilities([{ capability: 'os.run', address: 'not an address!' }])
      )
    ).toThrow(/address must be a valid ILP address/);
    expect(() => ConfigLoader.validateConfig(withCapabilities([{ capability: 'os.run' }]))).toThrow(
      /address must be a valid ILP address/
    );
  });

  it('rejects a malformed price', () => {
    expect(() =>
      ConfigLoader.validateConfig(
        withCapabilities([{ capability: 'os.run', address: 'g.proxy.run', price: '-1' }])
      )
    ).toThrow(/price must be a non-negative decimal string/);
    expect(() =>
      ConfigLoader.validateConfig(
        withCapabilities([{ capability: 'os.run', address: 'g.proxy.run', price: 5 }])
      )
    ).toThrow(/price must be a non-negative decimal string/);
  });

  it('rejects an empty or non-string schema', () => {
    expect(() =>
      ConfigLoader.validateConfig(
        withCapabilities([{ capability: 'os.run', address: 'g.proxy.run', schema: '' }])
      )
    ).toThrow(/schema must be a non-empty string/);
    expect(() =>
      ConfigLoader.validateConfig(
        withCapabilities([{ capability: 'os.run', address: 'g.proxy.run', schema: 42 }])
      )
    ).toThrow(/schema must be a non-empty string/);
  });
});
