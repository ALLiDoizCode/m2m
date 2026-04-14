/**
 * Tests for SocksTransportProvider (Story 35.2)
 *
 * ATDD RED-phase tests: these must fail until `socks-transport-provider.ts` is
 * implemented per the story spec. The tests cover:
 *
 * | Test ID        | AC  | What it verifies                                             |
 * |----------------|-----|--------------------------------------------------------------|
 * | T-35.2-01      | 1   | createAgent returns a SocksProxyAgent with socks5h:// URL    |
 * | T-35.2-02      | 2   | getExternalUrl returns the configured .anon URL              |
 * | T-35.2-05      | 3   | Constructor rejects socks5:// (DNS-leak defense in depth)    |
 * | T-35.6-SEC-03  | 3   | Constructor rejects any non-socks5h scheme                   |
 * | T-35.2-03      | 4   | start() throws FAIL-CLOSED when proxy unreachable            |
 * | T-35.6-SEC-02  | 4   | Error message includes host:port and no silent fallback      |
 * | T-35.2-09      | 5   | start() resolves when proxy is reachable                     |
 * | T-35.2-04      | 6   | healthCheck() returns false (does NOT throw) when down       |
 * | T-35.2-07      | 6   | healthCheck() returns true when proxy reachable              |
 * | T-35.2-08      | 7   | stop() is a safe no-op                                       |
 * | T-35.2-10      | 8   | Class satisfies the TransportProvider interface              |
 * | T-35.2-11      | 9   | createAgent() does not throw even when proxy down            |
 * | T-35.2-06      | 9   | createAgent() returns a fresh agent per call                 |
 * | T-35.6-SEC-05  | 10  | .anon never appears in INFO/WARN/ERROR/FATAL log calls       |
 *
 * @module socks-transport-provider.test
 */

import net from 'net';
import pino from 'pino';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { TransportProvider } from './transport-provider';
import {
  SocksTransportProvider,
  type SocksTransportProviderOptions,
} from './socks-transport-provider';

/**
 * Start a TCP listener on 127.0.0.1 and return {port, close()}. Simulates a
 * reachable SOCKS5 proxy for probe tests (does NOT implement SOCKS5 handshake;
 * the provider only verifies that the TCP port is listening).
 */
async function startEphemeralListener(): Promise<{ port: number; close: () => Promise<void> }> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Unexpected address type'));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

/**
 * Acquire a port that is guaranteed closed (bind, read port, close, reuse).
 * Used to assert fail-closed behavior against an unreachable proxy.
 */
async function getClosedPort(): Promise<number> {
  const { port, close } = await startEphemeralListener();
  await close();
  return port;
}

function makeLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function makeOpts(
  overrides: Partial<SocksTransportProviderOptions> = {}
): SocksTransportProviderOptions {
  return {
    socksProxy: 'socks5h://127.0.0.1:9050',
    externalUrl: 'wss://testabcdef123456.anon/btp',
    logger: makeLogger(),
    ...overrides,
  };
}

describe('SocksTransportProvider (Story 35.2)', () => {
  // Hygiene: restore any jest.spyOn installed within a test (notably the .anon
  // log-audit test) so test ordering changes cannot leak mocks across cases.
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // AC 3 -- Constructor DNS-leak / scheme validation (T-35.2-05, T-35.6-SEC-03)
  // ---------------------------------------------------------------------------

  describe('constructor scheme validation', () => {
    it('rejects socks5:// (missing the "h" suffix -- DNS-leak prevention) (T-35.2-05)', () => {
      expect(
        () => new SocksTransportProvider(makeOpts({ socksProxy: 'socks5://127.0.0.1:9050' }))
      ).toThrow(/socks5h:\/\//);
    });

    it('includes a DNS-leak explanation in the error message (T-35.2-05)', () => {
      expect(
        () => new SocksTransportProvider(makeOpts({ socksProxy: 'socks5://127.0.0.1:9050' }))
      ).toThrow(/DNS/i);
    });

    it('rejects http:// proxy URLs (T-35.6-SEC-03)', () => {
      expect(
        () => new SocksTransportProvider(makeOpts({ socksProxy: 'http://127.0.0.1:9050' }))
      ).toThrow(/socks5h:\/\//);
    });

    it('rejects socks4:// proxy URLs (T-35.6-SEC-03)', () => {
      expect(
        () => new SocksTransportProvider(makeOpts({ socksProxy: 'socks4://127.0.0.1:9050' }))
      ).toThrow(/socks5h:\/\//);
    });

    it('rejects an empty socksProxy value', () => {
      expect(() => new SocksTransportProvider(makeOpts({ socksProxy: '' }))).toThrow();
    });

    it('rejects a non-URL string', () => {
      expect(() => new SocksTransportProvider(makeOpts({ socksProxy: 'not a url' }))).toThrow();
    });

    it('rejects an empty externalUrl', () => {
      expect(() => new SocksTransportProvider(makeOpts({ externalUrl: '' }))).toThrow();
    });

    it('accepts socks5h:// with valid host:port', () => {
      expect(
        () => new SocksTransportProvider(makeOpts({ socksProxy: 'socks5h://127.0.0.1:9050' }))
      ).not.toThrow();
    });

    it('constructor error message does NOT contain the .anon external URL', () => {
      let err: Error | undefined;
      try {
        new SocksTransportProvider(makeOpts({ socksProxy: 'socks5://127.0.0.1:9050' }));
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeDefined();
      expect(err?.message ?? '').not.toContain('.anon');
    });
  });

  // ---------------------------------------------------------------------------
  // AC 1 + AC 9 -- createAgent (T-35.2-01, T-35.2-06, T-35.2-11)
  // ---------------------------------------------------------------------------

  describe('createAgent()', () => {
    it('returns a SocksProxyAgent instance (T-35.2-01)', () => {
      const provider = new SocksTransportProvider(makeOpts());
      const agent = provider.createAgent('wss://peer.anon/btp');
      expect(agent).toBeInstanceOf(SocksProxyAgent);
    });

    it('configures the returned agent with the socks5h:// proxy URL (T-35.2-01)', () => {
      const provider = new SocksTransportProvider(
        makeOpts({ socksProxy: 'socks5h://127.0.0.1:9050' })
      );
      const agent = provider.createAgent('wss://peer.anon/btp') as SocksProxyAgent & {
        proxy?: { host?: string; port?: number | string; protocol?: string } | URL;
      };
      const proxy = agent.proxy as
        | { host?: string; port?: number | string; protocol?: string }
        | URL
        | undefined;
      expect(proxy).toBeDefined();
      // socks-proxy-agent normalizes the parsed proxy; verify host + port are present.
      const host = (proxy as { host?: string })?.host ?? (proxy as URL)?.hostname;
      const port = (proxy as { port?: number | string })?.port ?? (proxy as URL)?.port;
      expect(String(host)).toBe('127.0.0.1');
      expect(String(port)).toBe('9050');
    });

    it('returns a fresh agent per call (T-35.2-06)', () => {
      const provider = new SocksTransportProvider(makeOpts());
      const a1 = provider.createAgent('wss://peer.anon/btp');
      const a2 = provider.createAgent('wss://peer.anon/btp');
      expect(a1).not.toBe(a2);
    });

    it('does NOT throw when the proxy is unreachable (lazy connect) (T-35.2-11)', async () => {
      const closedPort = await getClosedPort();
      const provider = new SocksTransportProvider(
        makeOpts({ socksProxy: `socks5h://127.0.0.1:${closedPort}` })
      );
      expect(() => provider.createAgent('wss://peer.anon/btp')).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // AC 2 -- getExternalUrl (T-35.2-02)
  // ---------------------------------------------------------------------------

  describe('getExternalUrl()', () => {
    it('returns the configured .anon external URL (T-35.2-02)', () => {
      const provider = new SocksTransportProvider(
        makeOpts({ externalUrl: 'wss://testabcdef123456.anon/btp' })
      );
      expect(provider.getExternalUrl()).toBe('wss://testabcdef123456.anon/btp');
    });
  });

  // ---------------------------------------------------------------------------
  // AC 4 + AC 5 -- start() FAIL-CLOSED (T-35.2-03, T-35.2-09, T-35.6-SEC-02)
  // ---------------------------------------------------------------------------

  describe('start()', () => {
    it('resolves when the proxy TCP port is reachable (T-35.2-09)', async () => {
      const listener = await startEphemeralListener();
      try {
        const provider = new SocksTransportProvider(
          makeOpts({ socksProxy: `socks5h://127.0.0.1:${listener.port}` })
        );
        await expect(provider.start()).resolves.toBeUndefined();
      } finally {
        await listener.close();
      }
    });

    it('throws when the SOCKS5 proxy is unreachable -- FAIL CLOSED (T-35.2-03)', async () => {
      const closedPort = await getClosedPort();
      const provider = new SocksTransportProvider(
        makeOpts({ socksProxy: `socks5h://127.0.0.1:${closedPort}` })
      );
      await expect(provider.start()).rejects.toThrow(/SOCKS5/i);
    });

    it('error message includes proxy host:port (T-35.6-SEC-02)', async () => {
      const closedPort = await getClosedPort();
      const provider = new SocksTransportProvider(
        makeOpts({ socksProxy: `socks5h://127.0.0.1:${closedPort}` })
      );
      await expect(provider.start()).rejects.toThrow(new RegExp(`127\\.0\\.0\\.1:${closedPort}`));
    });
  });

  // ---------------------------------------------------------------------------
  // AC 6 -- healthCheck (T-35.2-07, T-35.2-04)
  // ---------------------------------------------------------------------------

  describe('healthCheck()', () => {
    it('resolves to true when the proxy is reachable (T-35.2-07)', async () => {
      const listener = await startEphemeralListener();
      try {
        const provider = new SocksTransportProvider(
          makeOpts({ socksProxy: `socks5h://127.0.0.1:${listener.port}` })
        );
        await expect(provider.healthCheck()).resolves.toBe(true);
      } finally {
        await listener.close();
      }
    });

    it('resolves to false (does NOT throw) when the proxy is unreachable (T-35.2-04)', async () => {
      const closedPort = await getClosedPort();
      const provider = new SocksTransportProvider(
        makeOpts({ socksProxy: `socks5h://127.0.0.1:${closedPort}` })
      );
      // Must not throw:
      let result: boolean | undefined;
      let threw = false;
      try {
        result = await provider.healthCheck();
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // AC 7 -- stop() no-op (T-35.2-08)
  // ---------------------------------------------------------------------------

  describe('stop()', () => {
    it('resolves immediately without error when never started (T-35.2-08)', async () => {
      const provider = new SocksTransportProvider(makeOpts());
      await expect(provider.stop()).resolves.toBeUndefined();
    });

    it('is safe after a successful start()', async () => {
      const listener = await startEphemeralListener();
      try {
        const provider = new SocksTransportProvider(
          makeOpts({ socksProxy: `socks5h://127.0.0.1:${listener.port}` })
        );
        await provider.start();
        await expect(provider.stop()).resolves.toBeUndefined();
      } finally {
        await listener.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // AC 8 -- TransportProvider interface compliance (T-35.2-10)
  // ---------------------------------------------------------------------------

  describe('TransportProvider interface compliance (T-35.2-10)', () => {
    it('satisfies the TransportProvider interface at compile time and runtime', () => {
      const provider: TransportProvider = new SocksTransportProvider(makeOpts());
      expect(typeof provider.createAgent).toBe('function');
      expect(typeof provider.getExternalUrl).toBe('function');
      expect(typeof provider.start).toBe('function');
      expect(typeof provider.stop).toBe('function');
      expect(typeof provider.healthCheck).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  // AC 10 -- .anon log audit at INFO+ (T-35.6-SEC-05, provider-level seed)
  // ---------------------------------------------------------------------------

  describe('.anon log audit at INFO/WARN/ERROR/FATAL (T-35.6-SEC-05)', () => {
    /**
     * Exercise every public lifecycle path both happy and sad, capture every
     * INFO/WARN/ERROR/FATAL call made against the provided logger, and assert
     * that the serialized arguments never contain the substring ".anon".
     */
    it('never emits ".anon" at INFO/WARN/ERROR/FATAL across full lifecycle', async () => {
      const logger = pino({ level: 'silent' });
      // Pino loggers return new child instances; stub child() to return the same
      // logger so our spies capture its calls regardless of component naming.
      (jest.spyOn(logger, 'child') as unknown as jest.Mock).mockReturnValue(logger);

      const calls: string[] = [];
      const record = (...args: unknown[]): void => {
        try {
          calls.push(JSON.stringify(args));
        } catch {
          calls.push(String(args));
        }
      };
      jest.spyOn(logger, 'info').mockImplementation(record as never);
      jest.spyOn(logger, 'warn').mockImplementation(record as never);
      jest.spyOn(logger, 'error').mockImplementation(record as never);
      jest.spyOn(logger, 'fatal').mockImplementation(record as never);

      const listener = await startEphemeralListener();
      const closedPort = await getClosedPort();

      try {
        // Happy path: construct with .anon externalUrl, createAgent with .anon peer,
        // start (success), healthCheck (true), stop.
        const okProvider = new SocksTransportProvider({
          socksProxy: `socks5h://127.0.0.1:${listener.port}`,
          externalUrl: 'wss://testabcdef123456.anon/btp',
          logger,
        });
        okProvider.createAgent('wss://peerabc.anon/btp');
        await okProvider.start();
        await okProvider.healthCheck();
        await okProvider.stop();

        // Sad path: start() against unreachable proxy (must throw)
        const badProvider = new SocksTransportProvider({
          socksProxy: `socks5h://127.0.0.1:${closedPort}`,
          externalUrl: 'wss://anotheranon456.anon/btp',
          logger,
        });
        await expect(badProvider.start()).rejects.toThrow();
        await expect(badProvider.healthCheck()).resolves.toBe(false);

        // Constructor error path
        expect(
          () =>
            new SocksTransportProvider({
              socksProxy: 'socks5://127.0.0.1:9050',
              externalUrl: 'wss://leaky.anon/btp',
              logger,
            })
        ).toThrow();
      } finally {
        await listener.close();
      }

      const offenders = calls.filter((c) => c.includes('.anon'));
      expect(offenders).toEqual([]);
    });
  });
}); // end SocksTransportProvider (Story 35.2)
