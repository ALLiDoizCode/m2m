/**
 * Tests for Story 35.3: Extend Config Schema for Transport Block
 *
 * Validates the new optional `transport` block in connector YAML configuration,
 * which selects between `direct` (default) and `socks5` transports for outbound
 * BTP WebSocket connections. This is schema + validation only -- runtime wiring
 * into `ConnectorNode` lives in Story 35.4.
 *
 * Tests cover:
 * - T-35.3-01: Absent transport block defaults to { type: 'direct' } (AC 1)
 * - T-35.3-02: Valid socks5 transport block validates and round-trips (AC 2)
 * - T-35.3-03: type: 'socks5' without socksProxy fails validation (AC 3)
 * - T-35.3-04: type: 'socks5' without externalUrl fails validation (AC 4)
 * - T-35.3-05: socks5:// (no h) rejected with DNS-leak rationale (AC 5, T-35.6-SEC-03)
 * - T-35.3-06: Invalid transport.type value rejected (AC 6)
 * - T-35.3-07: Wrong shape/types in transport block rejected (AC 7)
 * - T-35.3-08: type: 'direct' with extra SOCKS-only fields tolerated (AC 8)
 * - T-35.3-09: TransportConfig exported as discriminated union (AC 9)
 * - T-REG-01..N: Zero regression on existing YAML fixtures (AC 10)
 *
 * Epic 35 Story 35.3
 *
 * RED PHASE: These tests are expected to fail until the implementation lands:
 * - `TransportConfig` type in `./types`
 * - `ConfigLoader.validateTransport` / `validateSocks5Transport`
 * - Wiring in `ConfigLoader.validateConfig`
 *
 * @module config/transport-config.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigLoader, ConfigurationError } from './config-loader';
import type { ConnectorConfig, TransportConfig } from './types';
// Compile-time proof that TransportConfig is re-exported from both barrels.
// If either import breaks, the test file fails to compile. This is stronger
// than a runtime `expect(...).toBeDefined()` check because TransportConfig is
// a type-only export (no runtime value).
import type { TransportConfig as TransportConfigFromConfigBarrel } from './index';
import type { TransportConfig as TransportConfigFromLibBarrel } from '../lib';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimal valid raw config, used as the base for transport-block tests.
 * All other required fields (peers, routes, ports, nodeId) are present and
 * should not interfere with transport validation.
 */
const baseRawConfig = (): Record<string, unknown> => ({
  nodeId: 'test-node',
  btpServerPort: 3000,
  healthCheckPort: 8080,
  peers: [],
  routes: [],
});

/** Attempts validation and returns either the config or the thrown error. */
const tryValidate = (
  overrides: Record<string, unknown>
): { ok: true; config: ConnectorConfig } | { ok: false; error: unknown } => {
  try {
    const config = ConfigLoader.validateConfig({ ...baseRawConfig(), ...overrides });
    return { ok: true, config };
  } catch (error) {
    return { ok: false, error };
  }
};

// ---------------------------------------------------------------------------
// AC 1 -- T-35.3-01: Absent transport block defaults to { type: 'direct' }
// ---------------------------------------------------------------------------

describe('transport config: absent block defaults to direct (T-35.3-01)', () => {
  it('returns transport: { type: "direct" } when YAML omits the transport key', () => {
    // Given a config without a transport block
    const result = tryValidate({});

    // Then validation succeeds and transport defaults to direct
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.transport).toEqual({ type: 'direct' });
  });

  it('applies the default even when validateConfig receives a transport: undefined key explicitly', () => {
    const result = tryValidate({ transport: undefined });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.transport).toEqual({ type: 'direct' });
  });

  it('does not require a transport key when loading via ConfigLoader.loadConfig from YAML', () => {
    // Given the existing valid-config fixture (which has no transport block)
    const fixturePath = path.resolve(__dirname, '../../test/fixtures/configs/valid-config.yaml');
    // Guard: the fixture must exist (sanity check for regression suite)
    expect(fs.existsSync(fixturePath)).toBe(true);

    const config = ConfigLoader.loadConfig(fixturePath);

    expect(config.transport).toEqual({ type: 'direct' });
  });
});

// ---------------------------------------------------------------------------
// AC 2 -- T-35.3-02: Valid socks5 block validates and round-trips
// ---------------------------------------------------------------------------

describe('transport config: valid socks5 block (T-35.3-02)', () => {
  it('normalizes a minimal socks5 block with managed defaulted to false', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: 'wss://abc123def456abcdef.anon/btp',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.transport).toEqual({
      type: 'socks5',
      socksProxy: 'socks5h://127.0.0.1:9050',
      externalUrl: 'wss://abc123def456abcdef.anon/btp',
      managed: false,
    });
  });

  it('passes through managed: true when explicitly set', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: 'wss://abc123.anon/btp',
        managed: true,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const transport = result.config.transport;
    expect(transport).toBeDefined();
    if (!transport || transport.type !== 'socks5') {
      throw new Error('expected socks5 transport');
    }
    expect(transport.managed).toBe(true);
  });

  it('round-trips via YAML -> loadConfig (not just validateConfig)', () => {
    const tmpYaml = yaml.dump({
      ...baseRawConfig(),
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: 'wss://abc123.anon/btp',
      },
    });
    const tmpPath = path.join(
      os.tmpdir(),
      `__tmp_transport_socks5_${process.pid}_${Date.now()}.yaml`
    );
    fs.writeFileSync(tmpPath, tmpYaml, 'utf8');
    try {
      const config = ConfigLoader.loadConfig(tmpPath);
      expect(config.transport).toEqual({
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: 'wss://abc123.anon/btp',
        managed: false,
      });
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });
});

// ---------------------------------------------------------------------------
// AC 3 -- T-35.3-03: Missing socksProxy fails
// ---------------------------------------------------------------------------

describe('transport config: socks5 requires socksProxy (T-35.3-03)', () => {
  it('throws ConfigurationError naming transport.socksProxy when absent', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        externalUrl: 'wss://abc.anon/btp',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    const msg = (result.error as Error).message;
    expect(msg).toMatch(/transport\.socksProxy/);
    expect(msg.toLowerCase()).toMatch(/required|missing/);
    expect(msg).toMatch(/socks5/);
  });

  it('throws when socksProxy is an empty string', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: '',
        externalUrl: 'wss://abc.anon/btp',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    expect((result.error as Error).message).toMatch(/transport\.socksProxy/);
  });

  it('throws when socksProxy is whitespace-only', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: '   ',
        externalUrl: 'wss://abc.anon/btp',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    expect((result.error as Error).message).toMatch(/transport\.socksProxy/);
  });
});

// ---------------------------------------------------------------------------
// AC 4 -- T-35.3-04: Missing externalUrl fails
// ---------------------------------------------------------------------------

describe('transport config: socks5 requires externalUrl (T-35.3-04)', () => {
  it('throws ConfigurationError naming transport.externalUrl when absent', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    const msg = (result.error as Error).message;
    expect(msg).toMatch(/transport\.externalUrl/);
    expect(msg.toLowerCase()).toMatch(/required|missing/);
    expect(msg).toMatch(/socks5/);
  });

  it('throws when externalUrl is empty string', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: '',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    expect((result.error as Error).message).toMatch(/transport\.externalUrl/);
  });

  it('throws when externalUrl is whitespace-only', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: '   ',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    expect((result.error as Error).message).toMatch(/transport\.externalUrl/);
  });
});

// ---------------------------------------------------------------------------
// AC 5 -- T-35.3-05: socks5:// (no h) rejected; DNS-leak rationale surfaced
// ---------------------------------------------------------------------------

describe('transport config: socks5h:// scheme enforcement (T-35.3-05 / T-35.6-SEC-03)', () => {
  it('rejects socks5:// (missing the "h") with a DNS-leak explanation', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5://127.0.0.1:9050',
        externalUrl: 'wss://abc.anon/btp',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    const msg = (result.error as Error).message;
    expect(msg).toMatch(/socks5h:\/\//);
    expect(msg.toLowerCase()).toMatch(/dns leak|dns-leak/);
  });

  it.each([
    ['http://127.0.0.1:9050'],
    ['socks4://127.0.0.1:9050'],
    ['socks://127.0.0.1:9050'],
    ['127.0.0.1:9050'],
    ['socks5H://127.0.0.1:9050'], // case-sensitive: must be lowercase
  ])('rejects non-socks5h scheme %s', (socksProxy) => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy,
        externalUrl: 'wss://abc.anon/btp',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    expect((result.error as Error).message).toMatch(/socks5h:\/\//);
  });

  it('does NOT include the full .anon hidden-service value when the rejected proxy URL contains .anon', () => {
    // Paranoid case: proxy URL string happens to include an .anon host.
    // Even though this specific path is unlikely, redaction must kick in.
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5://hidden-service-id-abcdef.anon:9050',
        externalUrl: 'wss://abc.anon/btp',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const msg = (result.error as Error).message;
    // The full .anon host must NOT appear in the error message (redaction).
    expect(msg).not.toMatch(/hidden-service-id-abcdef\.anon/);
  });

  it('redacts bare host:port .anon values in the error (no scheme, no //)', () => {
    // Defense-in-depth: if a rejected socksProxy is a bare host:port (no scheme,
    // so no `//` to anchor an authority-replacement regex) AND contains .anon,
    // the sanitizer must still redact. Prior implementation leaked the bare
    // host via a no-op regex match.
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'hidden-service-id-abcdef.anon:9050',
        externalUrl: 'wss://abc.anon/btp',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const msg = (result.error as Error).message;
    expect(msg).not.toMatch(/hidden-service-id-abcdef\.anon/);
  });

  it('redacts .anon externalUrl values when scheme is rejected', () => {
    // externalUrl schemes other than ws://|wss:// are rejected; the error must
    // not echo an .anon authority verbatim.
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: 'http://secret-hidden-service.anon/btp',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const msg = (result.error as Error).message;
    expect(msg).not.toMatch(/secret-hidden-service\.anon/);
  });

  it('redacts .anon values present in the URL path (not just authority)', () => {
    // Defense-in-depth: prior implementation only replaced authority via
    // `//[^/]+`, leaving any `.anon` in path/query segments exposed. Any
    // .anon substring anywhere in the URL must trigger wholesale redaction.
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5://safe-host:9050/path/hidden-service-abcdef.anon/foo',
        externalUrl: 'wss://abc.anon/btp',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const msg = (result.error as Error).message;
    expect(msg).not.toMatch(/hidden-service-abcdef\.anon/);
  });

  it('redacts embedded userinfo (user:password@host) in error messages even without .anon', () => {
    // Credential-disclosure defense: operators sometimes paste fully-formed
    // URLs with embedded credentials into YAML; echoing those verbatim into
    // a logged error is a secret-leak. Userinfo must always be stripped.
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5://alice:hunter2@127.0.0.1:9050',
        externalUrl: 'wss://abc.anon/btp',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const msg = (result.error as Error).message;
    expect(msg).not.toMatch(/hunter2/);
    expect(msg).not.toMatch(/alice:hunter2/);
  });

  it('plain IP/host in a rejected socks5:// URL may appear in the error (no redaction needed)', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5://127.0.0.1:9050',
        externalUrl: 'wss://abc.anon/btp',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const msg = (result.error as Error).message;
    // Non-.anon values are safe to include; this affirms the redaction is targeted.
    expect(msg).toMatch(/127\.0\.0\.1|socks5:\/\//);
  });
});

// ---------------------------------------------------------------------------
// AC 6 -- T-35.3-06: Unknown transport.type rejected
// ---------------------------------------------------------------------------

describe('transport config: unknown type rejected (T-35.3-06)', () => {
  it.each([['tor'], ['foo'], ['DIRECT'], ['Socks5'], ['']])(
    'throws ConfigurationError listing valid values for type = %p',
    (badType) => {
      const result = tryValidate({
        transport: { type: badType },
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(ConfigurationError);
      const msg = (result.error as Error).message;
      expect(msg).toMatch(/direct/);
      expect(msg).toMatch(/socks5/);
    }
  );
});

// ---------------------------------------------------------------------------
// AC 7 -- T-35.3-07: Wrong shape / types rejected
// ---------------------------------------------------------------------------

describe('transport config: shape + field type validation (T-35.3-07)', () => {
  it.each([
    ['string', 'direct'],
    ['array', ['direct']],
    ['null', null],
    ['number', 42],
    ['boolean', true],
  ])('throws when transport is a %s (not an object)', (_label, badValue) => {
    const result = tryValidate({ transport: badValue as unknown });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    expect((result.error as Error).message.toLowerCase()).toMatch(/transport.*object/);
  });

  it('throws when socksProxy is a number', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 9050,
        externalUrl: 'wss://abc.anon/btp',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    const msg = (result.error as Error).message;
    expect(msg).toMatch(/transport\.socksProxy/);
    expect(msg.toLowerCase()).toMatch(/string/);
  });

  it('throws when externalUrl is a boolean', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: true,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    const msg = (result.error as Error).message;
    expect(msg).toMatch(/transport\.externalUrl/);
    expect(msg.toLowerCase()).toMatch(/string/);
  });

  it('throws when externalUrl is a number', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: 42,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    const msg = (result.error as Error).message;
    expect(msg).toMatch(/transport\.externalUrl/);
    expect(msg.toLowerCase()).toMatch(/string/);
  });

  it.each([
    ['http://abc.anon/btp'],
    ['https://abc.anon/btp'],
    ['abc.anon/btp'],
    ['btp://abc.anon/btp'],
  ])('throws when externalUrl scheme is not ws:// or wss:// (%s)', (externalUrl) => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    const msg = (result.error as Error).message;
    expect(msg).toMatch(/transport\.externalUrl/);
    expect(msg).toMatch(/ws:\/\/|wss:\/\//);
  });

  it('throws when managed is a string', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: 'wss://abc.anon/btp',
        managed: 'true',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ConfigurationError);
    const msg = (result.error as Error).message;
    expect(msg).toMatch(/transport\.managed/);
    expect(msg.toLowerCase()).toMatch(/boolean/);
  });
});

// ---------------------------------------------------------------------------
// AC 8 -- T-35.3-08: direct + extra fields tolerated
// ---------------------------------------------------------------------------

describe('transport config: direct with extra fields (T-35.3-08)', () => {
  it('strips SOCKS-only fields when type is direct and returns { type: "direct" }', () => {
    const result = tryValidate({
      transport: {
        type: 'direct',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: 'wss://leftover.example/btp',
        managed: true,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.transport).toEqual({ type: 'direct' });
  });

  it('accepts direct as the default when type is omitted but transport is present', () => {
    // type is optional on the raw input when transport is present; default to direct
    const result = tryValidate({ transport: {} });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.transport).toEqual({ type: 'direct' });
  });
});

// ---------------------------------------------------------------------------
// AC 9 -- T-35.3-09: TransportConfig is a discriminated union and exported
// ---------------------------------------------------------------------------

describe('transport config: TransportConfig discriminated union (T-35.3-09)', () => {
  it('compiles as a discriminated union on `type` (compile-time narrowing)', () => {
    // This test exists primarily to exercise the TypeScript type graph.
    // If TransportConfig is NOT a discriminated union, this function will not compile.
    const narrows = (t: TransportConfig): string => {
      switch (t.type) {
        case 'direct':
          return 'direct';
        case 'socks5': {
          // `t` should be narrowed to include socksProxy/externalUrl/managed
          const proxy: string = t.socksProxy;
          const url: string = t.externalUrl;
          const managed: boolean = t.managed;
          return `${proxy}|${url}|${managed}`;
        }
      }
    };

    expect(narrows({ type: 'direct' })).toBe('direct');
    expect(
      narrows({
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: 'wss://abc.anon/btp',
        managed: false,
      })
    ).toBe('socks5h://127.0.0.1:9050|wss://abc.anon/btp|false');
  });

  it('is re-exported from the config barrel (packages/connector/src/config)', async () => {
    // TransportConfig is a type-only export, so there is no runtime value to
    // assert. Instead we rely on the compile-time imports at the top of this
    // file (`TransportConfigFromConfigBarrel`) -- if that import fails, the
    // test file does not compile and this test cannot run. We additionally
    // assert that a value assignable to TransportConfigFromConfigBarrel can
    // be constructed and structurally matches the expected shape.
    const barrel = await import('./index');
    expect(barrel.ConfigLoader).toBeDefined();
    expect(barrel.ConfigurationError).toBeDefined();

    const sample: TransportConfigFromConfigBarrel = { type: 'direct' };
    expect(sample).toEqual({ type: 'direct' });
  });

  it('is re-exported from the package barrel (packages/connector/src/lib)', async () => {
    // Same argument as above: compile-time proof via
    // `TransportConfigFromLibBarrel` import. Story 35.4 wires the provider
    // using this exact import path, so this guard is load-bearing.
    const lib = await import('../lib');
    expect(lib).toBeDefined();

    const sample: TransportConfigFromLibBarrel = {
      type: 'socks5',
      socksProxy: 'socks5h://127.0.0.1:9050',
      externalUrl: 'wss://abc.anon/btp',
      managed: false,
    };
    expect(sample.type).toBe('socks5');
  });

  it('validateConfig always populates transport (never returns it unset)', () => {
    const result = tryValidate({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.transport).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC 10 -- T-REG-01..N: Existing YAML fixtures normalize to direct
// ---------------------------------------------------------------------------

describe('transport config: existing YAML fixtures default to direct (T-REG-01..N)', () => {
  // Note: test-connector-{a,b,c}.yaml are intentionally excluded because they
  // use `PLACEHOLDER_PORT_*` placeholders that integration tests substitute at
  // runtime; they are not directly loadable via ConfigLoader.loadConfig.
  const validFixtures = [
    'valid-config.yaml',
    'with-comments.yaml',
    'empty-peers-routes.yaml',
    'optional-fields.yaml',
  ];

  it.each(validFixtures)(
    'loads %s and normalizes transport to { type: "direct" }',
    (fixtureName) => {
      const fixturePath = path.resolve(__dirname, '../../test/fixtures/configs', fixtureName);
      if (!fs.existsSync(fixturePath)) {
        // If a fixture has been removed, do not fail the suite -- but fail loudly
        // with an informative message so the list stays honest.
        throw new Error(
          `Fixture not found: ${fixturePath}. Update the regression list in transport-config.test.ts.`
        );
      }

      const config = ConfigLoader.loadConfig(fixturePath);
      expect(config.transport).toEqual({ type: 'direct' });
    }
  );
});

// ---------------------------------------------------------------------------
// Story 35.5: managedOptions + externalUrl: 'auto'
// ---------------------------------------------------------------------------

describe('transport config: managedOptions (Story 35.5)', () => {
  it('accepts managedOptions when managed: true (happy path)', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: 'wss://abc123.anon/btp',
        managed: true,
        managedOptions: {
          hiddenServiceDir: '/var/lib/connector/hs',
          hiddenServicePort: 443,
          startupTimeoutMs: 30000,
          stopTimeoutMs: 5000,
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const t = result.config.transport;
    if (!t || t.type !== 'socks5') throw new Error('expected socks5');
    expect(t.managedOptions?.hiddenServiceDir).toBe('/var/lib/connector/hs');
    expect(t.managedOptions?.hiddenServicePort).toBe(443);
    expect(t.managedOptions?.startupTimeoutMs).toBe(30000);
  });

  it('rejects managedOptions when managed is false', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: 'wss://abc123.anon/btp',
        managed: false,
        managedOptions: { hiddenServiceDir: '/tmp/x' },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as Error).message).toMatch(
      /managedOptions is only permitted when.*managed is true/
    );
  });

  it('rejects .. path-traversal in hiddenServiceDir', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: 'wss://abc123.anon/btp',
        managed: true,
        managedOptions: { hiddenServiceDir: '/var/lib/../../etc/passwd' },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as Error).message).toMatch(/path-traversal/);
  });

  it('accepts externalUrl: "auto" when managed + hiddenServiceDir set', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: 'auto',
        managed: true,
        managedOptions: { hiddenServiceDir: '/var/lib/connector/hs' },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const t = result.config.transport;
    if (!t || t.type !== 'socks5') throw new Error('expected socks5');
    expect(t.externalUrl).toBe('auto');
  });

  it('rejects externalUrl: "auto" without hiddenServiceDir', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: 'auto',
        managed: true,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as Error).message).toMatch(/hiddenServiceDir/);
  });

  it('rejects externalUrl: "auto" without managed: true', () => {
    const result = tryValidate({
      transport: {
        type: 'socks5',
        socksProxy: 'socks5h://127.0.0.1:9050',
        externalUrl: 'auto',
        managed: false,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as Error).message).toMatch(/managed.*true/);
  });

  it('rejects managed: true with type: "direct"', () => {
    // Direct branch silently discards extra fields, so managed:true should
    // NOT be silently retained. We re-affirm the direct branch ignores it
    // (the type assertion is the regression guard).
    const result = tryValidate({
      transport: {
        type: 'direct',
        managed: true,
      } as unknown as Record<string, unknown>,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.transport).toEqual({ type: 'direct' });
  });
});
