/**
 * Tests for the `peeringPolicy` config block (toon-meta#153,
 * discovered-vs-peered split): shape validation in
 * `ConfigLoader.validateConfig`, backward compatibility (absent block →
 * undefined, unlimited funding), and the v0 hard rejection of
 * `autoRegister: true` — funding stays a deliberate operator choice.
 *
 * @module config/peering-policy-config.test
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

describe('ConfigLoader — peeringPolicy validation', () => {
  it('validates and passes a full peeringPolicy block through', () => {
    const config: ConnectorConfig = ConfigLoader.validateConfig({
      ...baseRaw(),
      peeringPolicy: { maxFundedChannels: 3, autoRegister: false },
    });
    expect(config.peeringPolicy).toEqual({ maxFundedChannels: 3, autoRegister: false });
  });

  it('accepts an empty block (all fields optional)', () => {
    const config = ConfigLoader.validateConfig({ ...baseRaw(), peeringPolicy: {} });
    expect(config.peeringPolicy).toEqual({});
  });

  it('leaves peeringPolicy undefined when the block is absent (unlimited funding, backward compatible)', () => {
    const config = ConfigLoader.validateConfig(baseRaw());
    expect(config.peeringPolicy).toBeUndefined();
  });

  it('rejects a non-object block', () => {
    expect(() => ConfigLoader.validateConfig({ ...baseRaw(), peeringPolicy: 'strict' })).toThrow(
      ConfigurationError
    );
    expect(() => ConfigLoader.validateConfig({ ...baseRaw(), peeringPolicy: [1] })).toThrow(
      'peeringPolicy must be an object'
    );
  });

  it.each([0, -1, 1.5, '3', NaN, Infinity])(
    'rejects malformed maxFundedChannels: %p',
    (maxFundedChannels) => {
      expect(() =>
        ConfigLoader.validateConfig({ ...baseRaw(), peeringPolicy: { maxFundedChannels } })
      ).toThrow('peeringPolicy.maxFundedChannels must be a positive integer');
    }
  );

  it('rejects a non-boolean autoRegister', () => {
    expect(() =>
      ConfigLoader.validateConfig({ ...baseRaw(), peeringPolicy: { autoRegister: 'no' } })
    ).toThrow('peeringPolicy.autoRegister must be a boolean');
  });

  it('rejects autoRegister: true — not yet supported in v0 (funding stays a deliberate operator action)', () => {
    expect(() =>
      ConfigLoader.validateConfig({ ...baseRaw(), peeringPolicy: { autoRegister: true } })
    ).toThrow(/peeringPolicy\.autoRegister: true is not yet supported/);
  });

  it('accepts autoRegister: false explicitly', () => {
    const config = ConfigLoader.validateConfig({
      ...baseRaw(),
      peeringPolicy: { autoRegister: false },
    });
    expect(config.peeringPolicy).toEqual({ autoRegister: false });
  });
});
