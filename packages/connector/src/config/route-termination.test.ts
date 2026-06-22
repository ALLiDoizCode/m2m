/**
 * Tests for issue #218 — per-route local-termination config surface (boot-load).
 *
 * Validates the optional `RouteTermination` fields on a YAML `route`
 * (`upstream`, `price`, `chains`, `ilpAddress`, `settlementAddresses`, `asset`):
 *
 * - Boot-load: a real temp YAML with termination fields covering all three
 *   chains (evm + solana + mina) round-trips through ConfigLoader unchanged.
 * - Invalid upstream / price / chain throw ConfigurationError.
 * - Backward compat: a route with no termination fields still loads.
 * - The shared `validateRouteTermination` helper used by both boot and runtime.
 *
 * @module config/route-termination.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigLoader, ConfigurationError } from './config-loader';
import { validateRouteTermination, toRouteTermination, TERMINATION_CHAINS } from './types';
import type { ConnectorConfig, RouteConfig, RouteTermination } from './types';
// Compile-time proof the keystone type is re-exported from the lib barrel
// (consumed by #217 / #220 / #219). Type-only — fails the build if it breaks.
import type { RouteTermination as RouteTerminationFromBarrel } from '../lib';
import { isValidNonNegativeIntegerString } from '../settlement/types';

const _barrelProof: RouteTerminationFromBarrel | undefined = undefined;
void _barrelProof;

const baseRawConfig = (routes: RouteConfig[]): Record<string, unknown> => ({
  nodeId: 'test-node',
  btpServerPort: 3000,
  healthCheckPort: 8080,
  peers: [],
  routes,
});

const tryValidate = (
  routes: RouteConfig[]
): { ok: true; config: ConnectorConfig } | { ok: false; error: unknown } => {
  try {
    return { ok: true, config: ConfigLoader.validateConfig(baseRawConfig(routes)) };
  } catch (error) {
    return { ok: false, error };
  }
};

const fullTermination: RouteTermination = {
  upstream: 'http://127.0.0.1:8080',
  price: '1000',
  chains: ['evm', 'solana', 'mina'],
  ilpAddress: 'g.connector.greet',
  settlementAddresses: {
    evm: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
    solana: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2',
    mina: 'B62qiy32p8kAKnny8ZFwoMhYpBppM1DWVCqAPBYNcXnsAHhnfAAuXgg',
  },
  asset: {
    evm: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
};

describe('issue #218 — route termination boot-load', () => {
  it('round-trips all three chains (evm + solana + mina) via YAML -> loadConfig', () => {
    const route: RouteConfig = {
      prefix: 'g.connector.greet',
      nextHop: 'local',
      ...fullTermination,
    };
    const tmpYaml = yaml.dump(baseRawConfig([route]));
    const tmpPath = path.join(os.tmpdir(), `__tmp_route_term_${process.pid}_${Date.now()}.yaml`);
    fs.writeFileSync(tmpPath, tmpYaml, 'utf8');
    try {
      const config = ConfigLoader.loadConfig(tmpPath);
      const loaded = config.routes[0]!;
      expect(loaded.upstream).toBe('http://127.0.0.1:8080');
      expect(loaded.price).toBe('1000');
      expect(loaded.chains).toEqual(['evm', 'solana', 'mina']);
      expect(loaded.ilpAddress).toBe('g.connector.greet');
      expect(loaded.settlementAddresses?.mina).toMatch(/^B62q/);
      expect(loaded.asset?.evm).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
      // Mina is carried (never dropped) so #217 can split it into the
      // toon-channel `extra` while evm/solana ride the vanilla x402 entry.
      expect(loaded.chains).toContain('mina');
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('loads a route WITHOUT termination fields (backward compatible)', () => {
    const result = tryValidate([{ prefix: 'g.alice', nextHop: 'peer-a', priority: 5 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const loaded = result.config.routes[0]!;
    expect(loaded.upstream).toBeUndefined();
    expect(toRouteTermination(loaded)).toBeUndefined();
  });

  it('throws ConfigurationError on a non-http(s) upstream', () => {
    const result = tryValidate([
      { prefix: 'g.x', nextHop: 'local', ...fullTermination, upstream: 'ftp://bad/host' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    expect((result.error as Error).message).toMatch(/upstream must be an http\(s\) URL/);
  });

  it('throws ConfigurationError on a non-integer price', () => {
    const result = tryValidate([
      { prefix: 'g.x', nextHop: 'local', ...fullTermination, price: '1.5' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    expect((result.error as Error).message).toMatch(/price must be a non-negative integer string/);
  });

  it('throws ConfigurationError on a negative price', () => {
    const result = tryValidate([
      { prefix: 'g.x', nextHop: 'local', ...fullTermination, price: '-1' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('throws ConfigurationError on an unknown chain', () => {
    const result = tryValidate([
      {
        prefix: 'g.x',
        nextHop: 'local',
        ...fullTermination,
        chains: ['evm', 'bitcoin'] as unknown as RouteConfig['chains'],
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    expect((result.error as Error).message).toMatch(/unknown termination chain/);
  });

  it('throws when a settlementAddresses key is not in chains', () => {
    const result = tryValidate([
      {
        prefix: 'g.x',
        nextHop: 'local',
        ...fullTermination,
        chains: ['evm'],
        settlementAddresses: { solana: 'sol-addr' },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as Error).message).toMatch(/settlementAddresses has key 'solana'/);
  });
});

describe('issue #218 — validateRouteTermination helper (shared boot+runtime)', () => {
  it('is a no-op for an ordinary forwarding route', () => {
    expect(
      validateRouteTermination(
        { prefix: 'g.a', nextHop: 'p' } as never,
        isValidNonNegativeIntegerString
      )
    ).toEqual({ ok: true });
  });

  it('accepts a fully-specified termination', () => {
    expect(
      validateRouteTermination(
        { prefix: 'g.greet', ...fullTermination },
        isValidNonNegativeIntegerString
      )
    ).toEqual({ ok: true });
  });

  it('exposes the canonical chain set', () => {
    expect([...TERMINATION_CHAINS].sort()).toEqual(['evm', 'mina', 'solana']);
  });

  // RFC 9421 request-binding opt-in flag (#220 wiring).
  it('accepts requireRequestBinding: true on a terminated route', () => {
    expect(
      validateRouteTermination(
        { prefix: 'g.greet', ...fullTermination, requireRequestBinding: true },
        isValidNonNegativeIntegerString
      )
    ).toEqual({ ok: true });
  });

  it('rejects a non-boolean requireRequestBinding', () => {
    const result = validateRouteTermination(
      {
        prefix: 'g.greet',
        ...fullTermination,
        requireRequestBinding: 'yes' as unknown as boolean,
      },
      isValidNonNegativeIntegerString
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(
      'requireRequestBinding must be a boolean'
    );
  });

  it('defaults requireRequestBinding to false via toRouteTermination (do-no-harm)', () => {
    expect(toRouteTermination(fullTermination)?.requireRequestBinding).toBe(false);
    expect(
      toRouteTermination({ ...fullTermination, requireRequestBinding: true })?.requireRequestBinding
    ).toBe(true);
  });
});
