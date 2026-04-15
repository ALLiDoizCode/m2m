/**
 * Tests for ManagedAnonClient (Story 35.5)
 *
 * ATDD RED-phase tests: these fail until `managed-anon-client.ts` is implemented
 * per the story spec. All SDK interactions go through an injected `anonFactory`
 * — the real `@anyone-protocol/anyone-client` package is never imported here.
 *
 * | Test ID     | AC  | What it verifies                                                                 |
 * |-------------|-----|----------------------------------------------------------------------------------|
 * | T-35.5-01   | 1   | start() awaits sdk.start() AND a TCP probe of the SOCKS port                    |
 * | T-35.5-02   | 2   | stop() invokes sdk.stop() and is idempotent                                     |
 * | T-35.5-03   | 5   | healthCheck() returns false when sdk.isRunning()===false; single WARN on flip   |
 * | T-35.5-04   | 6   | stop() resolves on hung / throwing sdk.stop(); WARN logged; state cleared       |
 * | T-35.5-05   | 4   | ENOENT from sdk.start() → descriptive error + install guidance + Error.cause    |
 * | T-35.5-06   | 3   | SOCKS port never binds within startupTimeoutMs → rejection mentions timeout     |
 * | T-35.5-08   | 10  | factory throws MODULE_NOT_FOUND → rejection names @anyone-protocol/anyone-client|
 * | T-35.5-09   | 8   | hidden-service options propagate through factory                                |
 * | T-35.5-10   | 9   | Log audit: zero .anon substrings at INFO/WARN/ERROR/FATAL                       |
 *
 * @module managed-anon-client.test
 */
import net from 'net';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import pino from 'pino';
import type { Logger } from 'pino';

// RED: module does not exist yet → TS2307.
import {
  ManagedAnonClient,
  type AnonSdkHandle,
  type ManagedAnonClientOptions,
} from './managed-anon-client';

/** Minimal fake of the Anyone Protocol SDK's `Anon` surface. */
interface FakeSdkOverrides {
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
  isRunning?: () => boolean;
  getSOCKSPort?: () => number;
}

function makeFakeSdk(overrides: FakeSdkOverrides = {}): jest.Mocked<AnonSdkHandle> {
  let running = false;
  return {
    start: jest.fn(
      overrides.start ??
        (async () => {
          running = true;
        })
    ),
    stop: jest.fn(
      overrides.stop ??
        (async () => {
          running = false;
        })
    ),
    isRunning: jest.fn(overrides.isRunning ?? (() => running)),
    getSOCKSPort: jest.fn(overrides.getSOCKSPort ?? (() => 9050)),
  } as jest.Mocked<AnonSdkHandle>;
}

/** Start an ephemeral TCP listener to simulate a bound SOCKS5 port. */
async function startListener(): Promise<{ port: number; close: () => Promise<void> }> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('unexpected address'));
        return;
      }
      resolve({
        port: addr.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

/** Capture every pino log entry by swapping the transport to a memory sink. */
function makeCapturingLogger(): { logger: Logger; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: 'trace' },
    {
      write(chunk: string): void {
        try {
          entries.push(JSON.parse(chunk));
        } catch {
          // ignore non-JSON sinks (shouldn't happen with pino default)
        }
      },
    }
  );
  return { logger, entries };
}

function makeOpts(overrides: Partial<ManagedAnonClientOptions> = {}): ManagedAnonClientOptions {
  return {
    socksProxy: 'socks5h://127.0.0.1:9050',
    startupTimeoutMs: 500,
    stopTimeoutMs: 200,
    logger: pino({ level: 'silent' }),
    anonFactory: () => makeFakeSdk(),
    ...overrides,
  };
}

describe('ManagedAnonClient', () => {
  // T-35.5-01 (AC #1) -------------------------------------------------------
  it('start() awaits sdk.start() AND a TCP probe of the SOCKS port', async () => {
    const listener = await startListener();
    try {
      const fake = makeFakeSdk({
        getSOCKSPort: () => listener.port,
      });
      const client = new ManagedAnonClient(
        makeOpts({ anonFactory: () => fake, startupTimeoutMs: 2000 })
      );
      await client.start();
      expect(fake.start).toHaveBeenCalledTimes(1);
      expect(client.isRunning()).toBe(true);
      await client.stop();
    } finally {
      await listener.close();
    }
  });

  // T-35.5-02 (AC #2) -------------------------------------------------------
  it('stop() invokes sdk.stop() and is idempotent', async () => {
    const listener = await startListener();
    try {
      const fake = makeFakeSdk({ getSOCKSPort: () => listener.port });
      const client = new ManagedAnonClient(
        makeOpts({ anonFactory: () => fake, startupTimeoutMs: 2000 })
      );
      await client.start();
      await client.stop();
      await client.stop(); // MUST NOT throw
      expect(fake.stop).toHaveBeenCalledTimes(1);
      expect(client.isRunning()).toBe(false);
    } finally {
      await listener.close();
    }
  });

  // T-35.5-03 (AC #5) -------------------------------------------------------
  it('healthCheck() returns false when sdk.isRunning()===false and emits single WARN on transition', async () => {
    const listener = await startListener();
    try {
      const { logger, entries } = makeCapturingLogger();
      let running = true;
      const fake = makeFakeSdk({
        getSOCKSPort: () => listener.port,
        isRunning: () => running,
        start: async () => {
          running = true;
        },
      });
      const client = new ManagedAnonClient(
        makeOpts({ anonFactory: () => fake, startupTimeoutMs: 2000, logger })
      );
      await client.start();

      expect(await client.healthCheck()).toBe(true);
      running = false;
      expect(await client.healthCheck()).toBe(false);
      expect(await client.healthCheck()).toBe(false);

      const warns = entries.filter(
        (e) => e.level === 40 && e.event === 'managed_anon_crash_detected'
      );
      expect(warns).toHaveLength(1);
      await client.stop();
    } finally {
      await listener.close();
    }
  });

  // T-35.5-04 (AC #6) hung sdk.stop() --------------------------------------
  it('stop() resolves within stopTimeoutMs even when sdk.stop() hangs; WARN event=managed_anon_stop_timeout', async () => {
    const listener = await startListener();
    try {
      const { logger, entries } = makeCapturingLogger();
      const fake = makeFakeSdk({
        getSOCKSPort: () => listener.port,
        stop: () => new Promise<void>(() => {}), // never resolves
      });
      const client = new ManagedAnonClient(
        makeOpts({
          anonFactory: () => fake,
          startupTimeoutMs: 2000,
          stopTimeoutMs: 50,
          logger,
        })
      );
      await client.start();
      const start = Date.now();
      await expect(client.stop()).resolves.toBeUndefined();
      expect(Date.now() - start).toBeLessThan(1000);
      expect(client.isRunning()).toBe(false);
      const warns = entries.filter(
        (e) => e.level === 40 && e.event === 'managed_anon_stop_timeout'
      );
      expect(warns.length).toBeGreaterThanOrEqual(1);
    } finally {
      await listener.close();
    }
  });

  // T-35.5-04 (AC #6) throwing sdk.stop() ----------------------------------
  it('stop() resolves when sdk.stop() throws; WARN event=managed_anon_stop_error; state cleared', async () => {
    const listener = await startListener();
    try {
      const { logger, entries } = makeCapturingLogger();
      const fake = makeFakeSdk({
        getSOCKSPort: () => listener.port,
        stop: async () => {
          throw new Error('boom');
        },
      });
      const client = new ManagedAnonClient(
        makeOpts({ anonFactory: () => fake, startupTimeoutMs: 2000, logger })
      );
      await client.start();
      await expect(client.stop()).resolves.toBeUndefined();
      expect(client.isRunning()).toBe(false);
      const warns = entries.filter((e) => e.level === 40 && e.event === 'managed_anon_stop_error');
      expect(warns.length).toBeGreaterThanOrEqual(1);
    } finally {
      await listener.close();
    }
  });

  // T-35.5-05 (AC #4) -------------------------------------------------------
  it('start() surfaces ENOENT with "anon binary not found" + install guidance + Error.cause', async () => {
    const enoent = Object.assign(new Error('spawn anon ENOENT'), { code: 'ENOENT' });
    const fake = makeFakeSdk({
      start: async () => {
        throw enoent;
      },
    });
    const client = new ManagedAnonClient(makeOpts({ anonFactory: () => fake }));
    let caught: Error | undefined;
    try {
      await client.start();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/anon binary not found/i);
    expect(caught!.message).toMatch(/@anyone-protocol\/anyone-client/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((caught as any).cause).toBe(enoent);
    expect(client.isRunning()).toBe(false);
  });

  // T-35.5-06 (AC #3) -------------------------------------------------------
  it('start() rejects with timeout+port wording when SOCKS port never binds within startupTimeoutMs', async () => {
    // Acquire a port guaranteed-closed: bind then immediately close.
    const ephemeral = await startListener();
    const closedPort = ephemeral.port;
    await ephemeral.close();

    const fake = makeFakeSdk({
      start: async () => {},
      getSOCKSPort: () => closedPort,
    });
    const client = new ManagedAnonClient(
      makeOpts({ anonFactory: () => fake, startupTimeoutMs: 100 })
    );
    await expect(client.start()).rejects.toThrow(
      new RegExp(`(timeout|timed out).*${closedPort}|${closedPort}.*(timeout|timed out)`, 'i')
    );
    // Best-effort: sdk.stop MUST have been attempted during failure cleanup.
    expect(fake.stop).toHaveBeenCalled();
    expect(client.isRunning()).toBe(false);
  });

  // T-35.5-08 (AC #10 scenario 2) ------------------------------------------
  it('factory throws MODULE_NOT_FOUND → rejection names @anyone-protocol/anyone-client with npm install hint', async () => {
    const missing = Object.assign(
      new Error("Cannot find module '@anyone-protocol/anyone-client'"),
      { code: 'MODULE_NOT_FOUND' }
    );
    const client = new ManagedAnonClient(
      makeOpts({
        anonFactory: () => {
          throw missing;
        },
      })
    );
    await expect(client.start()).rejects.toThrow(/@anyone-protocol\/anyone-client/);
    // Second call is safe: state cleared, still rejects with the same template.
    await expect(client.start()).rejects.toThrow(/npm install/);
  });

  // T-35.5-09 (AC #8) -------------------------------------------------------
  it('anonFactory receives hidden-service options when configured', async () => {
    const hsDir = await mkdtemp(path.join(tmpdir(), 'ator-hs-'));
    await writeFile(path.join(hsDir, 'hostname'), 'abcdef1234567890.anon\n', 'utf8');
    const listener = await startListener();
    try {
      const factory = jest.fn(() => makeFakeSdk({ getSOCKSPort: () => listener.port }));
      const client = new ManagedAnonClient(
        makeOpts({
          socksProxy: `socks5h://127.0.0.1:${listener.port}`,
          anonFactory: factory,
          startupTimeoutMs: 2000,
          hiddenServiceDir: hsDir,
          hiddenServicePort: 443,
        })
      );
      await client.start();

      expect(factory).toHaveBeenCalledTimes(1);
      const call = factory.mock.calls[0] as unknown[];
      const arg = call[0] as Record<string, unknown>;
      expect(arg.socksPort).toBe(listener.port);
      // Either the SDK accepts HS options natively, OR the client wrote anonrc and passed configFilePath.
      const hasNativeOpts = arg.hiddenServiceDir === hsDir && arg.hiddenServicePort === 443;
      const hasConfigPathFallback =
        typeof arg.configFilePath === 'string' && (arg.configFilePath as string).startsWith(hsDir);
      expect(hasNativeOpts || hasConfigPathFallback).toBe(true);
      await client.stop();
    } finally {
      await listener.close();
    }
  });

  // T-35.5-10 (AC #9) -------------------------------------------------------
  it('log audit: zero .anon substrings at INFO/WARN/ERROR/FATAL across lifecycle', async () => {
    const listener = await startListener();
    try {
      const { logger, entries } = makeCapturingLogger();
      const hsDir = await mkdtemp(path.join(tmpdir(), 'ator-hs-'));
      await writeFile(path.join(hsDir, 'hostname'), 'supersecret.anon\n', 'utf8');
      let running = true;
      const fake = makeFakeSdk({
        getSOCKSPort: () => listener.port,
        isRunning: () => running,
      });
      const client = new ManagedAnonClient(
        makeOpts({
          anonFactory: () => fake,
          startupTimeoutMs: 2000,
          hiddenServiceDir: hsDir,
          hiddenServicePort: 443,
          logger,
        })
      );
      await client.start();
      running = false;
      await client.healthCheck(); // triggers crash-detected WARN
      await client.stop();

      const highSeverity = entries.filter((e) => {
        const lvl = e.level;
        return typeof lvl === 'number' && lvl >= 30; // info=30, warn=40, error=50, fatal=60
      });
      for (const entry of highSeverity) {
        expect(JSON.stringify(entry)).not.toMatch(/\.anon/i);
      }
    } finally {
      await listener.close();
    }
  });
});
