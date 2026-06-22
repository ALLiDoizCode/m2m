/**
 * Connector CLI E2E (issue #219)
 *
 * Drives the real `connector` CLI as a child process against a REAL
 * {@link ConnectorNode} booted in `deploymentMode: 'standalone'` with the admin
 * API enabled on a random port. No mocks — the CLI talks to the live admin HTTP
 * surface and we assert against real admin state.
 *
 * Coverage:
 *  - `route add` → `route ls --json` round-trips a real route (AC3/AC5).
 *  - A bad ILP prefix → non-zero exit + error message.
 *  - A wrong `--api-key` → exit 1 (admin API 401).
 *  - `app add` → a terminated route exists carrying the upstream/price/chains,
 *    surfaced by `app ls --json` (AC2/AC3).
 *  - `connector up -c <fixture.yaml>` child process → poll /health until healthy
 *    → SIGTERM → graceful exit 0 (AC1/AC4: standalone, no hub).
 *
 * The CLI is executed as the built `dist/cli/index.js` via `node`. The test
 * suite assumes `npm run build` has produced `dist/` (it runs in `beforeAll`
 * if missing).
 *
 * @packageDocumentation
 */

import { execFile, execFileSync, spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { promisify } from 'util';
import { ConnectorNode } from '../../src/core/connector-node';
import { createLogger } from '../../src/utils/logger';
import type { ConnectorConfig } from '../../src/config/types';

const execFileAsync = promisify(execFile);

jest.setTimeout(180_000);

const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const CLI_DIST = path.resolve(PACKAGE_ROOT, 'dist/cli/index.js');

/** Ensure the CLI is built (idempotent — only builds when dist is missing). */
function ensureBuilt(): void {
  if (!fs.existsSync(CLI_DIST)) {
    execFileSync('npm', ['run', 'build'], { cwd: PACKAGE_ROOT, stdio: 'inherit' });
  }
}

/** Run the built CLI via `node` and capture stdout/stderr/exit code. */
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI_DIST, ...args], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function randomPortBase(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const API_KEY = 'cli-e2e-secret-key';

describe('Connector CLI E2E (issue #219)', () => {
  let node: ConnectorNode;
  let adminUrl: string;

  beforeAll(async () => {
    ensureBuilt();
    const base = randomPortBase();
    const config: ConnectorConfig = {
      nodeId: 'cli-node',
      btpServerPort: base,
      healthCheckPort: base + 1,
      logLevel: 'warn',
      environment: 'development',
      deploymentMode: 'standalone',
      adminApi: { enabled: true, port: base + 2, host: '127.0.0.1', apiKey: API_KEY },
      peers: [],
      routes: [{ prefix: 'g.cli-node', nextHop: 'cli-node' }],
    };
    adminUrl = `http://127.0.0.1:${base + 2}`;
    node = new ConnectorNode(config, createLogger('cli-node', 'warn'));
    await node.start();
  });

  afterAll(async () => {
    await node?.stop().catch(() => undefined);
  });

  it('route add then route ls --json shows the route', async () => {
    const add = await runCli([
      'route',
      'add',
      'g.cli-node.alice',
      '--next-hop',
      'cli-node',
      '--url',
      adminUrl,
      '--api-key',
      API_KEY,
    ]);
    expect(add.code).toBe(0);
    expect(add.stdout).toContain('Route added');

    const ls = await runCli(['route', 'ls', '--json', '--url', adminUrl, '--api-key', API_KEY]);
    expect(ls.code).toBe(0);
    const parsed = JSON.parse(ls.stdout) as {
      routes: Array<{ prefix: string; nextHop: string }>;
    };
    expect(parsed.routes.some((r) => r.prefix === 'g.cli-node.alice')).toBe(true);
  });

  it('rejects a bad ILP prefix with a non-zero exit and an error message', async () => {
    const res = await runCli([
      'route',
      'add',
      'not a valid prefix!!',
      '--next-hop',
      'cli-node',
      '--url',
      adminUrl,
      '--api-key',
      API_KEY,
    ]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/Error:/);
  });

  it('rejects a wrong --api-key with exit 1', async () => {
    const res = await runCli([
      'route',
      'ls',
      '--json',
      '--url',
      adminUrl,
      '--api-key',
      'wrong-key',
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/Error:/);
  });

  it('app add registers a terminated route; app ls --json surfaces it', async () => {
    const add = await runCli([
      'app',
      'add',
      'greet',
      '--upstream',
      'http://127.0.0.1:8080',
      '--route',
      'g.cli-node.greet',
      '--price',
      '1000',
      '--chains',
      'base,solana,mina',
      '--url',
      adminUrl,
      '--api-key',
      API_KEY,
    ]);
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("App 'greet' added");

    const ls = await runCli(['app', 'ls', '--json', '--url', adminUrl, '--api-key', API_KEY]);
    expect(ls.code).toBe(0);
    const parsed = JSON.parse(ls.stdout) as {
      apps: Array<{
        prefix: string;
        termination?: { upstream?: string; price?: string; chains?: string[] };
      }>;
    };
    const app = parsed.apps.find((a) => a.prefix === 'g.cli-node.greet');
    expect(app).toBeDefined();
    expect(app?.termination?.upstream).toBe('http://127.0.0.1:8080');
    expect(app?.termination?.price).toBe('1000');
    expect(app?.termination?.chains).toEqual(['evm', 'solana', 'mina']);
  });

  it('connector up boots a bare standalone connector and exits 0 on SIGTERM', async () => {
    const base = randomPortBase();
    const adminPort = base + 2;
    const healthPort = base + 1;
    const fixture = `nodeId: cli-up-node
btpServerPort: ${base}
healthCheckPort: ${healthPort}
environment: development
deploymentMode: standalone
logLevel: warn
adminApi:
  enabled: true
  port: ${adminPort}
  host: 127.0.0.1
transport:
  type: direct
peers: []
routes: []
`;
    const cfgPath = path.join(os.tmpdir(), `cli-up-${base}.yaml`);
    fs.writeFileSync(cfgPath, fixture);

    const child = spawn('node', [CLI_DIST, 'up', '-c', cfgPath], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const exitPromise = new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? -1));
    });

    try {
      // Poll /health until healthy (no hub dependency — AC4).
      const healthUrl = `http://127.0.0.1:${healthPort}/health`;
      const deadline = Date.now() + 60_000;
      let healthy = false;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
          if (r.ok) {
            healthy = true;
            break;
          }
        } catch {
          // not ready yet
        }
        await sleep(500);
      }
      expect(healthy).toBe(true);

      // Graceful shutdown via SIGTERM → exit 0.
      child.kill('SIGTERM');
      const code = await Promise.race([exitPromise, sleep(20_000).then(() => -2)]);
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      fs.rmSync(cfgPath, { force: true });
    }
  });
});
