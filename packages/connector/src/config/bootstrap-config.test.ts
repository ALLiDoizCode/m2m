/**
 * Tests for the `bootstrap` config block (toon-meta#153): loader mapping,
 * opt-in default (absent → undefined → disabled), and validation of URL
 * schemes (https:// registry, ws(s):// seeds), hex pubkeys, and positive
 * integer knobs.
 *
 * @module config/bootstrap-config.test
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

const HEX64 = 'a'.repeat(64);

describe('ConfigLoader — bootstrap block (toon-meta#153)', () => {
  it('maps a fully-populated bootstrap block through validateConfig', () => {
    const raw = {
      ...baseRaw(),
      bootstrap: {
        enabled: true,
        registryUrl: 'https://seeds.toonprotocol.dev/relays.json',
        curatorPubkey: HEX64,
        seeds: [
          { relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev' },
          { relayUrl: 'ws://localhost:7100', pubkey: HEX64 },
        ],
        cachePath: './data/custom-bootstrap-cache.json',
        sampleSize: 5,
        refreshIntervalSecs: 1800,
      },
    };
    const config: ConnectorConfig = ConfigLoader.validateConfig(raw);
    expect(config.bootstrap).toEqual({
      enabled: true,
      registryUrl: 'https://seeds.toonprotocol.dev/relays.json',
      curatorPubkey: HEX64,
      seeds: [
        { relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev' },
        { relayUrl: 'ws://localhost:7100', pubkey: HEX64 },
      ],
      cachePath: './data/custom-bootstrap-cache.json',
      sampleSize: 5,
      refreshIntervalSecs: 1800,
    });
  });

  it('leaves bootstrap undefined when the block is absent (opt-in, default disabled)', () => {
    const config = ConfigLoader.validateConfig(baseRaw());
    expect(config.bootstrap).toBeUndefined();
  });

  it('accepts a minimal block (enabled only) and strips unknown fields', () => {
    const config = ConfigLoader.validateConfig({
      ...baseRaw(),
      bootstrap: { enabled: false, banner: 'ignored' },
    });
    expect(config.bootstrap).toEqual({ enabled: false });
  });

  it.each([
    ['non-object bootstrap', 'yes'],
    ['array bootstrap', []],
    ['null bootstrap', null],
    ['missing enabled', {}],
    ['non-boolean enabled', { enabled: 'true' }],
    ['http registryUrl', { enabled: true, registryUrl: 'http://insecure.example.org/seeds.json' }],
    ['ws registryUrl', { enabled: true, registryUrl: 'wss://not-http.example.org' }],
    ['non-string registryUrl', { enabled: true, registryUrl: 42 }],
    ['short curatorPubkey', { enabled: true, curatorPubkey: 'abc123' }],
    ['uppercase curatorPubkey', { enabled: true, curatorPubkey: 'A'.repeat(64) }],
    ['non-array seeds', { enabled: true, seeds: 'wss://x' }],
    ['seed not an object', { enabled: true, seeds: ['wss://x.example.org'] }],
    ['seed missing relayUrl', { enabled: true, seeds: [{ pubkey: HEX64 }] }],
    ['seed https relayUrl', { enabled: true, seeds: [{ relayUrl: 'https://x.example.org' }] }],
    [
      'seed bad pubkey',
      { enabled: true, seeds: [{ relayUrl: 'wss://x.example.org', pubkey: 'nope' }] },
    ],
    ['empty cachePath', { enabled: true, cachePath: '   ' }],
    ['non-string cachePath', { enabled: true, cachePath: 7 }],
    ['zero sampleSize', { enabled: true, sampleSize: 0 }],
    ['negative sampleSize', { enabled: true, sampleSize: -1 }],
    ['fractional sampleSize', { enabled: true, sampleSize: 2.5 }],
    ['zero refreshIntervalSecs', { enabled: true, refreshIntervalSecs: 0 }],
    ['string refreshIntervalSecs', { enabled: true, refreshIntervalSecs: '3600' }],
  ])('rejects invalid bootstrap config: %s', (_label, bootstrap) => {
    expect(() => ConfigLoader.validateConfig({ ...baseRaw(), bootstrap })).toThrow(
      ConfigurationError
    );
  });
});
