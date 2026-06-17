/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * Branch-coverage extension tests for ManagedAnonClient
 *
 * Targets the uncovered branches identified in the coverage report:
 *   - early-return when already started
 *   - factory non-MODULE_NOT_FOUND errors
 *   - sdk.start() non-ENOENT errors
 *   - late sdk.stop() rejection after timeout race
 *   - healthCheck edge cases (not started, recovery, probe failures)
 *   - anonrc file-exists and write-failure paths
 *   - best-effort stop error handling
 *   - safeIsRunning defensive wrapper
 *
 * @module managed-anon-client.coverage.test
 */

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: jest.fn(),
      access: jest.fn(),
      writeFile: jest.fn(),
      readFile: jest.fn(),
      rename: jest.fn(),
    },
  };
});

jest.mock('./probe-tcp-port', () => ({
  probeTcpPort: jest.fn(),
  waitForTcpPort: jest.fn(),
}));

jest.mock(
  '@anyone-protocol/anyone-client',
  () => (globalThis as Record<string, unknown>).__anyoneClientMock__,
  { virtual: true }
);

import pino from 'pino';
import type { Logger } from 'pino';
import * as fs from 'fs';
import { probeTcpPort, waitForTcpPort } from './probe-tcp-port';
import {
  ManagedAnonClient,
  createDefaultAnonFactory,
  type AnonSdkHandle,
  type ManagedAnonClientOptions,
  type AnonFactoryOptions,
} from './managed-anon-client';

const mockedProbeTcpPort = jest.mocked(probeTcpPort);
const mockedWaitForTcpPort = jest.mocked(waitForTcpPort);
const mockedMkdir = fs.promises.mkdir as jest.MockedFunction<typeof fs.promises.mkdir>;
const mockedAccess = fs.promises.access as jest.MockedFunction<typeof fs.promises.access>;
const mockedWriteFile = fs.promises.writeFile as jest.MockedFunction<typeof fs.promises.writeFile>;
const mockedReadFile = fs.promises.readFile as jest.MockedFunction<typeof fs.promises.readFile>;
const mockedRename = fs.promises.rename as jest.MockedFunction<typeof fs.promises.rename>;

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

function makeCapturingLogger(): { logger: Logger; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: 'debug' },
    {
      write(chunk: string): void {
        try {
          entries.push(JSON.parse(chunk));
        } catch {
          // ignore non-JSON
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

beforeEach(() => {
  jest.clearAllMocks();
  mockedWaitForTcpPort.mockResolvedValue(undefined);
  mockedProbeTcpPort.mockResolvedValue(undefined);
});

describe('ManagedAnonClient branch coverage', () => {
  // Line 138: already started
  it('start() returns early when already started', async () => {
    const fake = makeFakeSdk();
    const client = new ManagedAnonClient(makeOpts({ anonFactory: () => fake }));
    await client.start();
    expect(fake.start).toHaveBeenCalledTimes(1);
    await client.start(); // second call should be no-op
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(client.isRunning()).toBe(true);
    await client.stop();
  });

  // Line 157: factory throws non-MODULE_NOT_FOUND
  it('start() rejects when factory throws non-MODULE_NOT_FOUND error', async () => {
    const client = new ManagedAnonClient(
      makeOpts({
        anonFactory: () => {
          const err = new Error('unknown factory failure') as NodeJS.ErrnoException;
          err.code = 'UNKNOWN';
          throw err;
        },
      })
    );
    await expect(client.start()).rejects.toThrow(
      /Failed to construct @anyone-protocol\/anyone-client SDK handle/
    );
    expect(client.isRunning()).toBe(false);
  });

  // Line 182: sdk.start() throws non-ENOENT
  it('start() rejects with generic error when sdk.start() throws non-ENOENT', async () => {
    const fake = makeFakeSdk({
      start: async () => {
        const err = new Error('some random failure') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
    });
    const client = new ManagedAnonClient(makeOpts({ anonFactory: () => fake }));
    await expect(client.start()).rejects.toThrow(/Failed to start managed anon SDK/);
    expect(fake.stop).toHaveBeenCalled(); // best-effort cleanup
    expect(client.isRunning()).toBe(false);
  });

  // Line 242: late sdk.stop() rejection after timeout race settles
  it('stop() logs late sdk.stop() rejection after timeout race settles', async () => {
    const { logger, entries } = makeCapturingLogger();
    const fake = makeFakeSdk({
      stop: () =>
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('late rejection')), 300);
        }),
    });
    const client = new ManagedAnonClient(
      makeOpts({
        anonFactory: () => fake,
        stopTimeoutMs: 50,
        logger,
      })
    );
    await client.start();
    await client.stop();
    // Allow the late rejection handler to run
    await new Promise((r) => setTimeout(r, 400));
    const lateWarns = entries.filter(
      (e) => e.event === 'managed_anon_stop_late_error' && e.level === 40
    );
    expect(lateWarns.length).toBeGreaterThanOrEqual(1);
  });

  // Line 299: healthCheck when not started
  it('healthCheck() returns false when client has not been started', async () => {
    const client = new ManagedAnonClient(makeOpts());
    expect(await client.healthCheck()).toBe(false);
  });

  // Line 309: recovery of _lastHealthyFlag
  it('healthCheck() recovers _lastHealthyFlag when SDK resumes running', async () => {
    let running = true;
    const fake = makeFakeSdk({
      isRunning: () => running,
    });
    const client = new ManagedAnonClient(makeOpts({ anonFactory: () => fake }));
    await client.start();
    expect(await client.healthCheck()).toBe(true);
    running = false;
    expect(await client.healthCheck()).toBe(false);
    running = true;
    expect(await client.healthCheck()).toBe(true);
    await client.stop();
  });

  // Lines 320-330: probeTcpPort failures in healthCheck
  it('healthCheck() returns false after two consecutive probeTcpPort failures', async () => {
    const { logger, entries } = makeCapturingLogger();
    const fake = makeFakeSdk();
    const client = new ManagedAnonClient(
      makeOpts({
        anonFactory: () => fake,
        logger,
      })
    );
    await client.start();
    mockedProbeTcpPort.mockRejectedValue(new Error('connection refused'));
    // First failure: still true (only 1 consecutive failure)
    expect(await client.healthCheck()).toBe(true);
    // Second failure: false and logs warning
    expect(await client.healthCheck()).toBe(false);
    const warns = entries.filter((e) => e.event === 'managed_anon_probe_failed' && e.level === 40);
    expect(warns.length).toBeGreaterThanOrEqual(1);
    // Recovery: probe succeeds
    mockedProbeTcpPort.mockResolvedValue(undefined);
    expect(await client.healthCheck()).toBe(true);
  });

  // Line 370: existing anonrc file — not clobbered wholesale, but migrated
  // in place to add a ControlPort line (atomic temp-write + rename).
  it('does not rewrite an existing anonrc from scratch; migrates ControlPort in place', async () => {
    mockedAccess.mockResolvedValue(undefined);
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    mockedRename.mockResolvedValue(undefined);
    // Existing operator anonrc with no ControlPort line.
    mockedReadFile.mockResolvedValue('AgreeToTerms 1\nSocksPort 9050\n' as never);
    const factory = jest.fn<jest.Mocked<AnonSdkHandle>, [AnonFactoryOptions]>(() => makeFakeSdk());
    const client = new ManagedAnonClient(
      makeOpts({
        anonFactory: factory,
        hiddenServiceDir: '/tmp/hs-test',
        hiddenServicePort: 443,
      })
    );
    await client.start();
    expect(mockedAccess).toHaveBeenCalledWith('/tmp/hs-test/anonrc');
    // No full-file rewrite of the anonrc itself; the only write is the atomic
    // temp file, which is renamed over the original.
    const anonrcRewrite = mockedWriteFile.mock.calls.find((c) => c[0] === '/tmp/hs-test/anonrc');
    expect(anonrcRewrite).toBeUndefined();
    const tmpWrite = mockedWriteFile.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('/tmp/hs-test/anonrc.cp-')
    );
    expect(tmpWrite).toBeDefined();
    expect(tmpWrite![1] as string).toMatch(/^ControlPort 127\.0\.0\.1:9051$/m);
    expect(mockedRename).toHaveBeenCalledWith(tmpWrite![0], '/tmp/hs-test/anonrc');
    const call = factory.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(call.configFilePath).toBe('/tmp/hs-test/anonrc');
    await client.stop();
  });

  // Line 393: anonrc write failure
  it('continues when anonrc write fails', async () => {
    const { logger, entries } = makeCapturingLogger();
    mockedMkdir.mockResolvedValue(undefined);
    mockedAccess.mockRejectedValue(new Error('not found'));
    mockedWriteFile.mockRejectedValue(new Error('disk full'));
    const factory = jest.fn<jest.Mocked<AnonSdkHandle>, [AnonFactoryOptions]>(() => makeFakeSdk());
    const client = new ManagedAnonClient(
      makeOpts({
        anonFactory: factory,
        hiddenServiceDir: '/tmp/hs-test',
        hiddenServicePort: 443,
        logger,
      })
    );
    await client.start();
    const debugs = entries.filter((e) => e.event === 'managed_anon_anonrc_write_failed');
    expect(debugs.length).toBeGreaterThanOrEqual(1);
    const call = factory.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(call.configFilePath).toBeUndefined();
    await client.stop();
  });

  // Line 406: best-effort stop catches error during start failure cleanup
  it('logs warning when best-effort stop fails during startup cleanup', async () => {
    const { logger, entries } = makeCapturingLogger();
    const fake = makeFakeSdk({
      start: async () => {
        const err = new Error('spawn anon ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
      stop: async () => {
        throw new Error('cleanup stop boom');
      },
    });
    const client = new ManagedAnonClient(
      makeOpts({
        anonFactory: () => fake,
        logger,
      })
    );
    await expect(client.start()).rejects.toThrow(/anon binary not found/);
    const warns = entries.filter(
      (e) => e.event === 'managed_anon_cleanup_stop_failed' && e.level === 40
    );
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  // Line 406 (via waitForTcpPort catch): best-effort stop catches error during SOCKS timeout cleanup
  it('logs warning when best-effort stop fails during SOCKS timeout cleanup', async () => {
    const { logger, entries } = makeCapturingLogger();
    mockedWaitForTcpPort.mockRejectedValue(new Error('timeout'));
    const fake = makeFakeSdk({
      stop: async () => {
        throw new Error('cleanup stop boom');
      },
    });
    const client = new ManagedAnonClient(
      makeOpts({
        anonFactory: () => fake,
        logger,
      })
    );
    await expect(client.start()).rejects.toThrow(/timeout/);
    const warns = entries.filter(
      (e) => e.event === 'managed_anon_cleanup_stop_failed' && e.level === 40
    );
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  // Line 423: safeIsRunning catches throwing isRunning()
  it('isRunning() returns false when sdk.isRunning() throws', async () => {
    const fake = makeFakeSdk({
      isRunning: () => {
        throw new Error('isRunning boom');
      },
    });
    const client = new ManagedAnonClient(makeOpts({ anonFactory: () => fake }));
    await client.start();
    expect(client.isRunning()).toBe(false);
    expect(await client.healthCheck()).toBe(false);
    await client.stop();
  });

  // Additional branches: hiddenServiceDir without hiddenServicePort
  it('writes anonrc without HiddenServicePort when hiddenServicePort is omitted', async () => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedAccess.mockRejectedValue(new Error('not found'));
    mockedWriteFile.mockResolvedValue(undefined);
    const factory = jest.fn<jest.Mocked<AnonSdkHandle>, [AnonFactoryOptions]>(() => makeFakeSdk());
    const client = new ManagedAnonClient(
      makeOpts({
        anonFactory: factory,
        hiddenServiceDir: '/tmp/hs-test',
      })
    );
    await client.start();
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    const writtenContent = mockedWriteFile.mock.calls[0]![1] as string;
    expect(writtenContent).not.toContain('HiddenServicePort');
    await client.stop();
  });

  // Additional branches: displayLog true when logger level is debug
  it('sets displayLog to true when logger level is debug', async () => {
    const factory = jest.fn<jest.Mocked<AnonSdkHandle>, [AnonFactoryOptions]>(() => makeFakeSdk());
    const client = new ManagedAnonClient(
      makeOpts({
        anonFactory: factory,
        logger: pino({ level: 'debug' }),
      })
    );
    await client.start();
    const call = factory.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(call.displayLog).toBe(true);
    await client.stop();
  });

  // Additional branches: getSOCKSPort fallback
  it('falls back to configured socksPort when sdk.getSOCKSPort is undefined', async () => {
    const fake = {
      start: jest.fn(async () => {}),
      stop: jest.fn(async () => {}),
      isRunning: jest.fn(() => true),
      // intentionally omit getSOCKSPort
    } as unknown as jest.Mocked<AnonSdkHandle>;
    const client = new ManagedAnonClient(
      makeOpts({
        anonFactory: () => fake,
        socksProxy: 'socks5h://127.0.0.1:9999',
      })
    );
    await client.start();
    expect(mockedWaitForTcpPort).toHaveBeenCalledWith('127.0.0.1', 9999, expect.any(Number));
    await client.stop();
  });

  beforeAll(() => {
    (globalThis as Record<string, unknown>).__anyoneClientMock__ = { Process: jest.fn() };
  });

  // createDefaultAnonFactory success path via Process export
  it('createDefaultAnonFactory returns a working factory when SDK exports Process', async () => {
    const factory = await createDefaultAnonFactory();
    expect(typeof factory).toBe('function');
    const handle = factory({ displayLog: false, useExecFile: false, socksPort: 0, orPort: 0 });
    expect(handle).toBeDefined();
  });

  // createDefaultAnonFactory via Anon export
  it('createDefaultAnonFactory returns a working factory when SDK exports Anon', async () => {
    jest.resetModules();
    (globalThis as Record<string, unknown>).__anyoneClientMock__ = { Anon: jest.fn() };
    const factory = await createDefaultAnonFactory();
    const handle = factory({ displayLog: false, useExecFile: false, socksPort: 0, orPort: 0 });
    expect(handle).toBeDefined();
    jest.resetModules();
    (globalThis as Record<string, unknown>).__anyoneClientMock__ = { Process: jest.fn() };
  });

  // createDefaultAnonFactory via default.Anon export
  it('createDefaultAnonFactory returns a working factory when SDK exports default.Anon', async () => {
    jest.resetModules();
    (globalThis as Record<string, unknown>).__anyoneClientMock__ = { default: { Anon: jest.fn() } };
    const factory = await createDefaultAnonFactory();
    const handle = factory({ displayLog: false, useExecFile: false, socksPort: 0, orPort: 0 });
    expect(handle).toBeDefined();
    jest.resetModules();
    (globalThis as Record<string, unknown>).__anyoneClientMock__ = { Process: jest.fn() };
  });

  // createDefaultAnonFactory via default.Process export
  it('createDefaultAnonFactory returns a working factory when SDK exports default.Process', async () => {
    jest.resetModules();
    (globalThis as Record<string, unknown>).__anyoneClientMock__ = {
      default: { Process: jest.fn() },
    };
    const factory = await createDefaultAnonFactory();
    const handle = factory({ displayLog: false, useExecFile: false, socksPort: 0, orPort: 0 });
    expect(handle).toBeDefined();
    jest.resetModules();
    (globalThis as Record<string, unknown>).__anyoneClientMock__ = { Process: jest.fn() };
  });

  // createDefaultAnonFactory via default export
  it('createDefaultAnonFactory returns a working factory when SDK exports default constructor', async () => {
    jest.resetModules();
    (globalThis as Record<string, unknown>).__anyoneClientMock__ = { default: jest.fn() };
    const factory = await createDefaultAnonFactory();
    const handle = factory({ displayLog: false, useExecFile: false, socksPort: 0, orPort: 0 });
    expect(handle).toBeDefined();
    jest.resetModules();
    (globalThis as Record<string, unknown>).__anyoneClientMock__ = { Process: jest.fn() };
  });

  // createDefaultAnonFactory throws when export is not a function (line 469)
  it('createDefaultAnonFactory throws when SDK export is not a function', async () => {
    jest.resetModules();
    (globalThis as Record<string, unknown>).__anyoneClientMock__ = { Anon: 'not-a-function' };
    await expect(createDefaultAnonFactory()).rejects.toThrow(
      /did not export a `Process` or `Anon` constructor/
    );
    jest.resetModules();
    (globalThis as Record<string, unknown>).__anyoneClientMock__ = { Process: jest.fn() };
  });

  // createDefaultAnonFactory dynamic import failure (lines 446-460)
  it('createDefaultAnonFactory throws MODULE_NOT_FOUND when require and import both fail', async () => {
    jest.resetModules();
    const original = (globalThis as Record<string, unknown>).__anyoneClientMock__;
    Object.defineProperty(globalThis, '__anyoneClientMock__', {
      get() {
        throw new Error('factory boom');
      },
      configurable: true,
    });
    try {
      await expect(createDefaultAnonFactory()).rejects.toThrow(/@anyone-protocol\/anyone-client/);
      await expect(createDefaultAnonFactory()).rejects.toThrow(/npm install/);
    } finally {
      Object.defineProperty(globalThis, '__anyoneClientMock__', {
        value: original,
        writable: true,
        configurable: true,
      });
      jest.resetModules();
    }
  });

  // Additional branch: displayLog true when logger level is trace
  it('sets displayLog to true when logger level is trace', async () => {
    const factory = jest.fn<jest.Mocked<AnonSdkHandle>, [AnonFactoryOptions]>(() => makeFakeSdk());
    const client = new ManagedAnonClient(
      makeOpts({
        anonFactory: factory,
        logger: pino({ level: 'trace' }),
      })
    );
    await client.start();
    const call = factory.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(call.displayLog).toBe(true);
    await client.stop();
  });

  // Additional branch: mkdir failure for hiddenServiceDir
  it('continues when hiddenServiceDir mkdir fails', async () => {
    mockedMkdir.mockRejectedValue(new Error('permission denied'));
    const factory = jest.fn<jest.Mocked<AnonSdkHandle>, [AnonFactoryOptions]>(() => makeFakeSdk());
    const client = new ManagedAnonClient(
      makeOpts({
        anonFactory: factory,
        hiddenServiceDir: '/tmp/hs-test',
        hiddenServicePort: 443,
      })
    );
    await client.start();
    const call = factory.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(call.configFilePath).toBeUndefined();
    expect(call.hiddenServiceDir).toBe('/tmp/hs-test');
    await client.stop();
  });
});
