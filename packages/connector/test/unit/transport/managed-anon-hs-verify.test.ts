/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

/**
 * Focused unit tests for the hidden-service reachability-verification gate
 * added to ManagedAnonClient: the hostname is only reported as *published*
 * once a self-dial through the local SOCKS proxy succeeds, proving the v3
 * descriptor is actually fetchable — not merely that the `hostname` file
 * exists on disk. Regression guard for the "node reports live but is
 * unreachable" class of bug.
 */

import net from 'net';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import pino from 'pino';
import {
  ManagedAnonClient,
  type AnonSdkHandle,
  type AnonFactoryOptions,
} from '../../../src/transport/managed-anon-client';

const silentLogger = pino({ level: 'silent' });

/** Fake Anon SDK that binds a real ephemeral TCP port so the startup probe passes. */
function makeFakeSdk(): AnonSdkHandle {
  let server: net.Server | undefined;
  let port = 0;
  return {
    start: () =>
      new Promise<void>((resolve) => {
        server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
          const addr = server!.address();
          port = typeof addr === 'object' && addr ? addr.port : 0;
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        if (server) server.close(() => resolve());
        else resolve();
      }),
    isRunning: () => true,
    getSOCKSPort: () => port,
  };
}

async function makeHsDir(hostname: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hs-verify-'));
  await fsp.writeFile(path.join(dir, 'hostname'), `${hostname}\n`, 'utf8');
  return dir;
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

describe('ManagedAnonClient hidden-service reachability verification', () => {
  let client: ManagedAnonClient | undefined;
  let hsDir: string | undefined;

  afterEach(async () => {
    if (client) await client.stop();
    client = undefined;
    if (hsDir) await fsp.rm(hsDir, { recursive: true, force: true });
    hsDir = undefined;
  });

  it('does NOT publish on file detection alone — waits for a successful self-dial', async () => {
    hsDir = await makeHsDir('abc.anyone');
    const calls: Array<{ destHost: string; destPort: number }> = [];
    let allowDial = false;

    client = new ManagedAnonClient({
      socksProxy: 'socks5h://127.0.0.1:9050',
      hiddenServiceDir: hsDir,
      hiddenServicePort: 3000,
      logger: silentLogger,
      anonFactory: (_opts: AnonFactoryOptions) => makeFakeSdk(),
      selfDial: async ({ destHost, destPort }) => {
        calls.push({ destHost, destPort });
        if (!allowDial) throw new Error('descriptor not yet published');
      },
    });

    await client.start();

    // Self-dial is attempted but failing → hostname must NOT be reported published.
    await waitFor(() => calls.length > 0, 1000);
    expect(calls[0]).toEqual({ destHost: 'abc.anyone', destPort: 3000 });
    expect(client.getHostnameSnapshot().publishedAt).toBeNull();

    // Once the descriptor becomes reachable, the next self-dial succeeds and it publishes.
    allowDial = true;
    const published = await waitFor(() => client!.getHostnameSnapshot().publishedAt !== null, 4000);
    expect(published).toBe(true);
    expect(client.getHostnameSnapshot().hostname).toBe('abc.anyone');
  });

  it('publishes promptly when the self-dial succeeds', async () => {
    hsDir = await makeHsDir('xyz.anyone');
    client = new ManagedAnonClient({
      socksProxy: 'socks5h://127.0.0.1:9050',
      hiddenServiceDir: hsDir,
      hiddenServicePort: 7100,
      logger: silentLogger,
      anonFactory: (_opts: AnonFactoryOptions) => makeFakeSdk(),
      selfDial: async () => {
        /* reachable */
      },
    });

    await client.start();
    const published = await waitFor(() => client!.getHostnameSnapshot().publishedAt !== null, 2000);
    expect(published).toBe(true);
  });

  it('skips verification (legacy behaviour) when verifyReachability is false', async () => {
    hsDir = await makeHsDir('legacy.anyone');
    let dialed = false;
    client = new ManagedAnonClient({
      socksProxy: 'socks5h://127.0.0.1:9050',
      hiddenServiceDir: hsDir,
      hiddenServicePort: 3000,
      verifyReachability: false,
      logger: silentLogger,
      anonFactory: (_opts: AnonFactoryOptions) => makeFakeSdk(),
      selfDial: async () => {
        dialed = true;
      },
    });

    await client.start();
    const published = await waitFor(() => client!.getHostnameSnapshot().publishedAt !== null, 2000);
    expect(published).toBe(true);
    expect(dialed).toBe(false);
  });
});
