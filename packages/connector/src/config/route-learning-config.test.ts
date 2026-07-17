/**
 * Tests for the `routeLearning` config block (toon-meta#153): shape validation
 * in `ConfigLoader.validateConfig`, defaults-by-omission, and backward
 * compatibility (absent block → undefined, opt-in).
 *
 * @module config/route-learning-config.test
 */

import { ConfigLoader, ConfigurationError } from './config-loader';
import type { ConnectorConfig } from './types';

function baseRaw(): Record<string, unknown> {
  return {
    nodeId: 'connector',
    btpServerPort: 3000,
    healthCheckPort: 8080,
    peers: [],
    routes: [],
  };
}

describe('ConfigLoader — routeLearning validation', () => {
  it('validates and passes a full routeLearning block through', () => {
    const raw = {
      ...baseRaw(),
      routeLearning: {
        enabled: true,
        relayUrls: ['wss://relay-ws.devnet.toonprotocol.dev', 'ws://local-relay:8080'],
        refreshIntervalSecs: 60,
        maxRoutes: 500,
      },
    };
    const config: ConnectorConfig = ConfigLoader.validateConfig(raw);
    expect(config.routeLearning).toEqual({
      enabled: true,
      relayUrls: ['wss://relay-ws.devnet.toonprotocol.dev', 'ws://local-relay:8080'],
      refreshIntervalSecs: 60,
      maxRoutes: 500,
    });
  });

  it('accepts a minimal block (enabled only) and leaves optionals undefined', () => {
    const config = ConfigLoader.validateConfig({
      ...baseRaw(),
      routeLearning: { enabled: false },
    });
    expect(config.routeLearning).toEqual({ enabled: false });
  });

  it('leaves routeLearning undefined when the block is absent (opt-in)', () => {
    const config = ConfigLoader.validateConfig(baseRaw());
    expect(config.routeLearning).toBeUndefined();
  });

  it('rejects a non-object block', () => {
    expect(() => ConfigLoader.validateConfig({ ...baseRaw(), routeLearning: 'yes' })).toThrow(
      ConfigurationError
    );
    expect(() => ConfigLoader.validateConfig({ ...baseRaw(), routeLearning: [1] })).toThrow(
      'routeLearning must be an object'
    );
  });

  it('rejects a missing or non-boolean enabled flag', () => {
    expect(() => ConfigLoader.validateConfig({ ...baseRaw(), routeLearning: {} })).toThrow(
      'routeLearning.enabled must be a boolean'
    );
    expect(() =>
      ConfigLoader.validateConfig({ ...baseRaw(), routeLearning: { enabled: 'true' } })
    ).toThrow('routeLearning.enabled must be a boolean');
  });

  it('rejects malformed relayUrls', () => {
    expect(() =>
      ConfigLoader.validateConfig({
        ...baseRaw(),
        routeLearning: { enabled: true, relayUrls: 'wss://one.test' },
      })
    ).toThrow('routeLearning.relayUrls must be an array');
    expect(() =>
      ConfigLoader.validateConfig({
        ...baseRaw(),
        routeLearning: { enabled: true, relayUrls: ['https://not-ws.test'] },
      })
    ).toThrow('must be ws:// or wss:// URLs');
  });

  it('rejects non-positive refreshIntervalSecs and maxRoutes', () => {
    expect(() =>
      ConfigLoader.validateConfig({
        ...baseRaw(),
        routeLearning: { enabled: true, refreshIntervalSecs: 0 },
      })
    ).toThrow('routeLearning.refreshIntervalSecs must be a positive number');
    expect(() =>
      ConfigLoader.validateConfig({
        ...baseRaw(),
        routeLearning: { enabled: true, maxRoutes: 2.5 },
      })
    ).toThrow('routeLearning.maxRoutes must be a positive integer');
    expect(() =>
      ConfigLoader.validateConfig({
        ...baseRaw(),
        routeLearning: { enabled: true, maxRoutes: -1 },
      })
    ).toThrow('routeLearning.maxRoutes must be a positive integer');
  });
});
