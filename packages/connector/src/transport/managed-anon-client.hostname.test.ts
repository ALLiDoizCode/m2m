/**
 * Tests for the hidden-service hostname watcher in `ManagedAnonClient`
 * (Story 38.1).
 *
 * Coverage:
 *   - `isHiddenServiceConfigured()` reflects the constructor option
 *   - `getHostnameSnapshot()` returns nulls before any successful read
 *   - Fast path: hostname file already present at start() → snapshot is
 *     populated shortly after start() resolves
 *   - Slow path: fs.watch detects a hostname file written after start()
 *   - Trim: trailing newline/whitespace is stripped from the cached value
 *   - Cleanup: stop() releases the watcher even when nothing was ever read
 *
 * The fallback poll path (fs.watch unavailable) is exercised indirectly: the
 * watcher and the poll are armed together, so even on platforms where
 * fs.watch silently drops the event the bounded poll catches it within
 * HOSTNAME_POLL_INTERVAL_MS. Tests use real fs.watch on a tmpdir.
 *
 * @module transport/managed-anon-client.hostname.test
 */
import net from 'net';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import pino from 'pino';

import {
  ManagedAnonClient,
  type AnonSdkHandle,
  type ManagedAnonClientOptions,
} from './managed-anon-client';

function makeFakeSdk(socksPort: number): AnonSdkHandle {
  let running = false;
  return {
    start: async () => {
      running = true;
    },
    stop: async () => {
      running = false;
    },
    isRunning: () => running,
    getSOCKSPort: () => socksPort,
  };
}

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

function makeOpts(
  overrides: Partial<ManagedAnonClientOptions> & { socksPort: number; hiddenServiceDir?: string }
): ManagedAnonClientOptions {
  const { socksPort, ...rest } = overrides;
  return {
    socksProxy: 'socks5h://127.0.0.1:9050',
    startupTimeoutMs: 1_000,
    stopTimeoutMs: 500,
    logger: pino({ level: 'silent' }),
    anonFactory: () => makeFakeSdk(socksPort),
    ...rest,
  };
}

async function waitFor<T>(
  predicate: () => T | undefined,
  { timeoutMs = 4_000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value !== undefined && value !== null && value !== false) return value as T;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('ManagedAnonClient hostname watcher (Story 38.1)', () => {
  let listener: { port: number; close: () => Promise<void> };
  let dir: string;

  beforeEach(async () => {
    listener = await startListener();
    dir = await mkdtemp(path.join(tmpdir(), 'hs-hostname-'));
  });

  afterEach(async () => {
    await listener.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('isHiddenServiceConfigured() is false when no hiddenServiceDir is provided', () => {
    const client = new ManagedAnonClient(makeOpts({ socksPort: listener.port }));
    expect(client.isHiddenServiceConfigured()).toBe(false);
  });

  it('isHiddenServiceConfigured() is true when hiddenServiceDir is provided', () => {
    const client = new ManagedAnonClient(
      makeOpts({ socksPort: listener.port, hiddenServiceDir: dir })
    );
    expect(client.isHiddenServiceConfigured()).toBe(true);
  });

  it('getHostnameSnapshot() returns nulls before start()', () => {
    const client = new ManagedAnonClient(
      makeOpts({ socksPort: listener.port, hiddenServiceDir: dir })
    );
    expect(client.getHostnameSnapshot()).toEqual({ hostname: null, publishedAt: null });
  });

  it('reads hostname via the fast path when the file already exists at start()', async () => {
    const expected = 'eag2qnhil4vpvfo2eu3qtqj3rzzkrzbmboivwwbbgzr4svfvjigoxpad.anyone';
    await writeFile(path.join(dir, 'hostname'), `${expected}\n`, 'utf8');

    const client = new ManagedAnonClient(
      makeOpts({ socksPort: listener.port, hiddenServiceDir: dir })
    );
    await client.start();

    const snap = await waitFor(() => {
      const s = client.getHostnameSnapshot();
      return s.hostname !== null ? s : undefined;
    });

    expect(snap.hostname).toBe(expected);
    expect(snap.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    await client.stop();
  });

  it('trims trailing whitespace and newlines from the cached hostname', async () => {
    await writeFile(path.join(dir, 'hostname'), '  abc.anyone   \n\n', 'utf8');

    const client = new ManagedAnonClient(
      makeOpts({ socksPort: listener.port, hiddenServiceDir: dir })
    );
    await client.start();

    const snap = await waitFor(() => {
      const s = client.getHostnameSnapshot();
      return s.hostname !== null ? s : undefined;
    });

    expect(snap.hostname).toBe('abc.anyone');
    await client.stop();
  });

  it('detects a hostname file written after start() (fs.watch / fallback poll path)', async () => {
    const client = new ManagedAnonClient(
      makeOpts({ socksPort: listener.port, hiddenServiceDir: dir })
    );
    await client.start();

    // Snapshot is null right after start() — the file does not exist yet.
    expect(client.getHostnameSnapshot()).toEqual({ hostname: null, publishedAt: null });

    // Simulate anon publishing the descriptor by writing the hostname file.
    await writeFile(path.join(dir, 'hostname'), 'late.anyone\n', 'utf8');

    const snap = await waitFor(
      () => {
        const s = client.getHostnameSnapshot();
        return s.hostname !== null ? s : undefined;
      },
      // fs.watch fires within ms; the bounded fallback poll runs every 2s. Allow
      // a generous window for slow CI filesystems.
      { timeoutMs: 6_000 }
    );

    expect(snap.hostname).toBe('late.anyone');
    expect(snap.publishedAt).not.toBeNull();
    await client.stop();
  });

  it('treats an empty hostname file as not-yet-published until it has content', async () => {
    // anon may create the file before writing the descriptor. The watcher must
    // not cache an empty value; it must wait until the file has real content.
    await writeFile(path.join(dir, 'hostname'), '', 'utf8');

    const client = new ManagedAnonClient(
      makeOpts({ socksPort: listener.port, hiddenServiceDir: dir })
    );
    await client.start();

    // Give the fast-path read a chance to (incorrectly) cache the empty value.
    await new Promise((r) => setTimeout(r, 50));
    expect(client.getHostnameSnapshot()).toEqual({ hostname: null, publishedAt: null });

    // Now write real content — the watcher should pick it up.
    await writeFile(path.join(dir, 'hostname'), 'real.anyone\n', 'utf8');
    const snap = await waitFor(
      () => {
        const s = client.getHostnameSnapshot();
        return s.hostname !== null ? s : undefined;
      },
      { timeoutMs: 6_000 }
    );
    expect(snap.hostname).toBe('real.anyone');
    await client.stop();
  });

  it('stop() releases the watcher and timer even when hostname was never read', async () => {
    const client = new ManagedAnonClient(
      makeOpts({ socksPort: listener.port, hiddenServiceDir: dir })
    );
    await client.start();

    // No hostname file ever written. stop() should still resolve cleanly and
    // not leave dangling handles. We can't directly observe handle counts, but
    // we can verify stop() resolves and that subsequent writes do not change
    // the (still-null) snapshot.
    await client.stop();

    await writeFile(path.join(dir, 'hostname'), 'after-stop.anyone\n', 'utf8');

    // Wait a moment to allow any latent watcher firings — the snapshot must
    // remain null because stop() removed the watcher.
    await new Promise((r) => setTimeout(r, 200));
    expect(client.getHostnameSnapshot()).toEqual({ hostname: null, publishedAt: null });
  });
});
