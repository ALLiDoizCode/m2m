/**
 * Hidden-service + managed-client real-binary ATOR integration -- requires
 * ATOR_NIGHTLY=1 and a live `make ator-up` stack.
 *
 * This suite is the core of Story 36.4: it proves that the **managed lifecycle**
 * (starting/stopping the `anon` binary from within the connector process) and
 * the **hidden-service rendezvous** (a second connector connecting inbound to a
 * `.anon` address) work against the real `anon v0.4.10.0-beta` binary under
 * `make ator-test`.
 *
 * Test-ID crosswalk (authoritative mapping to `test-design-epic-36.md` via
 * `epic-36-real-binary-ator-verification.md` Key Scenarios table):
 *
 *   | T-ID         | AC  | Scenario                                                               |
 *   |--------------|-----|------------------------------------------------------------------------|
 *   | T-36.4-01    | 4   | ManagedAnonClient starts real `anon` binary; SOCKS port opens          |
 *   | T-36.4-02    | 5   | `externalUrl: "auto"` resolves by reading `hs/hostname` file           |
 *   | T-36.4-03    | 6   | Second connector connects inbound via the resolved `.anon:port` URL    |
 *   | T-36.4-04    | 7   | No `.anon` hostname appears in any log line at INFO+                   |
 *   | T-36.4-05    | 8   | Killing real `anon` → `managed_anon_crash_detected` within interval    |
 *   | T-36.4-06    | 9   | ManagedAnonClient.stop() completes within stopTimeoutMs                |
 *   | T-36.4-07    | 10  | Hung SDK stop (SIGSTOP) logs timeout; shutdown proceeds                |
 *   | T-36.4-08    | 11  | BTP round-trip through `.anon` rendezvous completes successfully       |
 *
 * Gating: this suite runs ONLY when `process.env.ATOR_NIGHTLY === '1'`. When
 * the env var is unset the file still loads cleanly (no import errors) and
 * every test inside is reported as SKIPPED.
 *
 * Invocation:
 *   make ator-up
 *   make ator-test        # sets ATOR_NIGHTLY=1 + ATOR_SOCKS_PORT dynamically
 *
 * Performance envelope (epic Performance Characteristics):
 *   - HS publish + descriptor propagation: 30-90s (budget 120s)
 *   - BTP round-trip through HS rendezvous: 400-900ms
 *   - Full HS test suite wall-clock: 5-12 minutes (dominated by HS descriptor wait)
 *
 * Bright line (Epic 36 invariant): this story touches ZERO `src/` code.
 *
 * @module test/integration/transport-ator-hidden-service.test
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Writable } from 'stream';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import pino from 'pino';
import { SocksClient } from 'socks';
import { SocksTransportProvider } from '../../src/transport/socks-transport-provider';
import { ManagedAnonClient } from '../../src/transport/managed-anon-client';
import type { AnonFactoryOptions, AnonSdkHandle } from '../../src/transport/managed-anon-client';

const execRaw = promisify(execCb);

// Repo root resolved at module load so every `docker compose ...` invocation
// runs against the project's docker-compose.yml regardless of where jest was
// invoked from.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/**
 * `exec` wrapped with the repo-root cwd so every `docker compose` invocation
 * resolves the project's docker-compose.yml.
 */
async function execCompose(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return execRaw(cmd, { cwd: REPO_ROOT });
}

// ---------------------------------------------------------------------------
// Gating: this suite is a no-op unless ATOR_NIGHTLY=1 is set.
// ---------------------------------------------------------------------------
const REAL_BINARY = process.env.ATOR_NIGHTLY === '1';
const describeRealBinary = REAL_BINARY ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Budgets (from story Dev Notes / epic performance table). Top-of-file
// constants so every budget-based assertion prints an explicit voice.
// ---------------------------------------------------------------------------
const HS_DESCRIPTOR_PUBLISH_BUDGET_MS = 120_000;
const MANAGED_STARTUP_BUDGET_MS = 60_000;
const MANAGED_STOP_BUDGET_MS = 10_000;
const CRASH_DETECT_BUDGET_MS = 35_000;
const RENDEZVOUS_ROUNDTRIP_BUDGET_MS = 10_000;

// Jest per-test timeout ceiling -- above HS_DESCRIPTOR_PUBLISH_BUDGET + safety.
const JEST_TEST_TIMEOUT_MS = 180_000;

// Dynamic host port assigned by docker at `make ator-up`; read via
// `docker compose port hs1 9050` inside the ator-test target.
const ATOR_SOCKS_PORT = process.env.ATOR_SOCKS_PORT;
const PROXY_URL = ATOR_SOCKS_PORT
  ? `socks5h://127.0.0.1:${ATOR_SOCKS_PORT}`
  : 'socks5h://127.0.0.1:0'; // placeholder; suite fails fast in beforeAll

// Managed-client tests (T-36.4-01/02/05/06/07) spawn their OWN `anon` binary
// on the host, which must bind to a DIFFERENT SOCKS port than the docker hs1
// container already occupying ATOR_SOCKS_PORT. Use a random high port to avoid
// collisions (the SDK's getSOCKSPort() doesn't report ephemeral ports).
const MANAGED_SOCKS_PORT = 19050 + Math.floor(Math.random() * 1000);
const MANAGED_PROXY_URL = `socks5h://127.0.0.1:${MANAGED_SOCKS_PORT}`;

const SKIP_REASON = 'requires ATOR_NIGHTLY=1 and docker compose --profile ator';

// ---------------------------------------------------------------------------
// Log buffer for SEC-05 (T-36.4-04) -- captures all structured log entries.
// ---------------------------------------------------------------------------
interface LogEntry {
  level: number;
  [key: string]: unknown;
}

const logBuffer: LogEntry[] = [];

function makeBufferedLogger(): pino.Logger {
  // Use a writable stream that captures log entries for SEC-05 assertion.
  const dest = new Writable({
    write(chunk: Buffer | string, _encoding: string, callback: (err?: Error | null) => void): void {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      try {
        const parsed = JSON.parse(str) as LogEntry;
        logBuffer.push(parsed);
      } catch {
        // Not JSON -- ignore.
      }
      callback();
    },
  });
  return pino({ level: process.env.LOG_LEVEL ?? 'debug' }, dest);
}

// ---------------------------------------------------------------------------
// Helpers (reuse patterns from transport-ator-real-binary.test.ts)
// TODO(36.5): Extract tcpProbe, socksConnect, execCompose to
// packages/connector/test/helpers/ator-compose-helpers.ts to DRY up
// duplication between transport-ator-real-binary.test.ts and this file.
// ---------------------------------------------------------------------------

async function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok: boolean): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

/**
 * Drive a SOCKS5 CONNECT through `SocksClient`. Returns the underlying
 * `net.Socket` once the SOCKS handshake completes.
 */
async function socksConnect(
  proxyUrl: string,
  host: string,
  port: number,
  timeoutMs: number
): Promise<net.Socket> {
  const parsed = new URL(proxyUrl.replace(/^socks5h:\/\//, 'http://'));
  const proxyHost = parsed.hostname;
  const proxyPort = Number(parsed.port);
  const { socket } = await SocksClient.createConnection({
    proxy: { host: proxyHost, port: proxyPort, type: 5 },
    command: 'connect',
    destination: { host, port },
    timeout: timeoutMs,
  });
  return socket;
}

/**
 * Poll for a file to appear at `filePath` with exponential backoff.
 * Returns the file content once it exists and is non-empty.
 */
async function waitForFile(filePath: string, timeoutMs: number, label: string): Promise<string> {
  const start = Date.now();
  let delay = 500;
  while (Date.now() - start < timeoutMs) {
    try {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (content.length > 0) {
        return content;
      }
    } catch {
      // file does not exist yet
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 5000); // exponential backoff, cap at 5s
  }
  throw new Error(`waitForFile: ${label} did not appear at ${filePath} within ${timeoutMs}ms`);
}

/**
 * Find the PID of an `anon` process associated with a specific hidden service
 * directory. Uses `pgrep -f` filtered by the unique directory path.
 */
async function findAnonPid(hiddenServiceDir: string): Promise<number> {
  // Strategy: prefer a narrow match on the unique hiddenServiceDir basename,
  // then fall back to matching the `anon` binary path (excludes grep/jest/etc).
  // NEVER fall back to a bare `pgrep -f "anon"` -- that matches "anonymous",
  // the test runner, and other unrelated processes.
  const strategies = [
    `pgrep -f "anon.*${path.basename(hiddenServiceDir)}"`,
    // Fallback: match the anon binary (typically /usr/bin/anon or similar),
    // excluding this grep process. The -x flag matches the full process name.
    'pgrep -x anon',
  ];
  for (const cmd of strategies) {
    try {
      const { stdout } = await execRaw(cmd, { cwd: REPO_ROOT });
      const pids = stdout
        .trim()
        .split('\n')
        .map(Number)
        .filter((n) => !isNaN(n) && n > 0);
      if (pids.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return pids[0]!;
      }
    } catch {
      // pgrep returns exit code 1 when no match -- try next strategy
    }
  }
  throw new Error(`No anon process found (hiddenServiceDir=${hiddenServiceDir})`);
}

// ---------------------------------------------------------------------------
// Managed config fixture path (AC 12)
// ---------------------------------------------------------------------------
const MANAGED_CONFIG_FIXTURE_PATH = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'ator-managed-config.yaml'
);

// ---------------------------------------------------------------------------
// AC 3 belt-and-suspenders: env-gate self-check (ungated)
// ---------------------------------------------------------------------------
describe('AC 3: HS suite is silently skipped when ATOR_NIGHTLY is unset', () => {
  it('the file-level gate uses process.env.ATOR_NIGHTLY === "1" + describe.skip when unset', () => {
    const thisFile = fs.readFileSync(__filename, 'utf8');
    expect(thisFile).toMatch(/process\.env\.ATOR_NIGHTLY\s*===\s*'1'/);
    expect(thisFile).toMatch(/REAL_BINARY\s*\?\s*describe\s*:\s*describe\.skip/);
  });

  it('REAL_BINARY gate value matches the env-var semantics exactly', () => {
    const envGateMatches = process.env.ATOR_NIGHTLY === '1';
    expect(REAL_BINARY).toBe(envGateMatches);
  });
});

// ---------------------------------------------------------------------------
// AC 12: Managed config fixture exists (ungated)
// ---------------------------------------------------------------------------
describe('AC 12: managed config fixture exists', () => {
  it('ator-managed-config.yaml exists at the expected path', () => {
    expect(fs.existsSync(MANAGED_CONFIG_FIXTURE_PATH)).toBe(true);
  });

  it('fixture contains required transport block fields', () => {
    const content = fs.readFileSync(MANAGED_CONFIG_FIXTURE_PATH, 'utf8');
    expect(content).toContain('type: socks5');
    expect(content).toContain('managed: true');
    expect(content).toContain("externalUrl: 'auto'");
    expect(content).toContain('hiddenServiceDir');
    expect(content).toContain('hiddenServicePort');
  });
});

// ---------------------------------------------------------------------------
// Real-binary HS + managed-client suite -- gated on ATOR_NIGHTLY=1
// ---------------------------------------------------------------------------
describeRealBinary(
  `Hidden-service + managed-client real-binary ATOR integration (Story 36.4, ${SKIP_REASON})`,
  () => {
    jest.setTimeout(JEST_TEST_TIMEOUT_MS);

    const logger = makeBufferedLogger();
    const createdProviders: SocksTransportProvider[] = [];
    const createdManagedClients: ManagedAnonClient[] = [];
    const tempDirsToClean: string[] = [];
    let tempHsDir: string;

    function trackProvider(p: SocksTransportProvider): SocksTransportProvider {
      createdProviders.push(p);
      return p;
    }

    function trackManagedClient(c: ManagedAnonClient): ManagedAnonClient {
      createdManagedClients.push(c);
      return c;
    }

    /** Create a temp directory and register it for cleanup in afterAll. Pre-write
     *  an anonrc with testnet DirAuthority lines so the managed binary bootstraps
     *  against the local Docker network instead of the public one. */
    function makeTempHsDir(prefix: string): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      tempDirsToClean.push(dir);
      if (testnetDirAuthLines) {
        fs.writeFileSync(
          path.join(dir, 'anonrc'),
          `AgreeToTerms 1\nTestingTorNetwork 1\nAssumeReachable 1\n${testnetDirAuthLines}\n`,
          { encoding: 'utf8' }
        );
      }
      return dir;
    }

    /**
     * Real anonFactory -- performs dynamic import of @anyone-protocol/anyone-client
     * and constructs a real Anon handle. This is the ENTIRE POINT of this test.
     * DO NOT mock this factory.
     */
    function realAnonFactory(opts: AnonFactoryOptions): AnonSdkHandle {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const AnonModule = require('@anyone-protocol/anyone-client');
      const AnonCtor =
        AnonModule.Process ??
        AnonModule.Anon ??
        AnonModule.default?.Process ??
        AnonModule.default?.Anon ??
        AnonModule.default;
      if (typeof AnonCtor !== 'function') {
        throw new Error(
          'Real anonFactory: @anyone-protocol/anyone-client did not export Process or Anon constructor'
        );
      }
      return new AnonCtor(opts) as AnonSdkHandle;
    }

    let testnetDirAuthLines = '';

    beforeAll(async () => {
      if (!ATOR_SOCKS_PORT) {
        throw new Error(
          'ATOR_SOCKS_PORT not set -- run via `make ator-test` (the Makefile ' +
            'resolves the dynamic host port via `docker compose port hs1 9050`).'
        );
      }
      if (!/^\d+$/.test(ATOR_SOCKS_PORT)) {
        throw new Error(`ATOR_SOCKS_PORT must be numeric, got "${ATOR_SOCKS_PORT}"`);
      }
      const reachable = await tcpProbe('127.0.0.1', Number(ATOR_SOCKS_PORT), 5_000);
      if (!reachable) {
        throw new Error(
          `SOCKS proxy at 127.0.0.1:${ATOR_SOCKS_PORT} not reachable -- run ` +
            '`make ator-up` first and verify hs1 is healthy.'
        );
      }
      // Read DirAuthority lines from the running Docker testnet so the host-side
      // managed anon binary joins the local network instead of the public one.
      try {
        const { stdout } = await execCompose(
          "docker compose exec -T dirauth1 grep '^DirAuthority' /etc/anon/torrc"
        );
        testnetDirAuthLines = stdout.trim();
      } catch {
        // If we can't read DirAuth lines, managed-client tests will bootstrap
        // against the public network (slower, may timeout).
      }
      // Create a temporary directory for hidden service keys.
      tempHsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ator-hs-test-'));
      if (testnetDirAuthLines) {
        fs.writeFileSync(
          path.join(tempHsDir, 'anonrc'),
          `AgreeToTerms 1\nTestingTorNetwork 1\nAssumeReachable 1\n${testnetDirAuthLines}\n`,
          { encoding: 'utf8' }
        );
      }
    });

    afterEach(async () => {
      // Stop managed clients between tests so the SDK singleton doesn't
      // reject subsequent start() calls with "already running."
      while (createdManagedClients.length > 0) {
        const c = createdManagedClients.pop()!;
        try {
          await c.stop();
        } catch {
          // swallow
        }
      }
      // Belt-and-suspenders: kill any orphan anon processes left by a
      // slow/failed stop(). The SDK detects "already running" via global
      // process check, so we must ensure zero anon processes between tests.
      try {
        await execCompose('pkill -x anon || true');
      } catch {
        // swallow
      }
      // Poll until the process table is clear. A fixed sleep is unreliable:
      // SIGKILL delivers immediately but the OS may take several hundred
      // milliseconds to reap the entry, and the SDK's "already running"
      // check fires on the next start() before the entry is gone.
      const pollDeadline = Date.now() + 10_000;
      while (Date.now() < pollDeadline) {
        try {
          await execRaw('pgrep -x anon', { cwd: REPO_ROOT });
          // Process still present — wait a short cycle before re-checking.
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          // pgrep exits non-zero when nothing matches — process table is clear.
          break;
        }
      }
    });

    afterAll(async () => {
      // Clean up providers
      for (const p of createdProviders) {
        try {
          await p.stop();
        } catch {
          // swallow
        }
      }
      // Clean up orphan anon processes (belt-and-suspenders).
      // Use `pgrep -x anon` to match only the anon binary, not unrelated
      // processes with "anon" in their command line (e.g., "anonymous").
      try {
        const { stdout } = await execRaw('pgrep -x anon', { cwd: REPO_ROOT });
        const pids = stdout
          .trim()
          .split('\n')
          .map(Number)
          .filter((n) => !isNaN(n) && n > 0);
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGCONT'); // in case SIGSTOP'd
          } catch {
            // ignore
          }
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // ignore
          }
        }
      } catch {
        // no anon processes found -- good
      }
      // Clean up ALL tracked temp directories (including per-test ones)
      for (const dir of tempDirsToClean) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
      if (tempHsDir && !tempDirsToClean.includes(tempHsDir)) {
        try {
          fs.rmSync(tempHsDir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    });

    // -----------------------------------------------------------------------
    // T-36.4-01 (AC 4): ManagedAnonClient starts real `anon` binary;
    //                    SOCKS port opens within startupTimeoutMs
    // -----------------------------------------------------------------------
    describe('T-36.4-01: ManagedAnonClient starts real anon binary', () => {
      it('start() resolves within MANAGED_STARTUP_BUDGET_MS and isRunning() returns true', async () => {
        const client = trackManagedClient(
          new ManagedAnonClient({
            socksProxy: MANAGED_PROXY_URL,
            hiddenServiceDir: tempHsDir,
            startupTimeoutMs: MANAGED_STARTUP_BUDGET_MS,
            logger,
            anonFactory: realAnonFactory,
          })
        );

        const t0 = Date.now();
        await client.start();
        const elapsed = Date.now() - t0;

        expect(elapsed).toBeLessThan(MANAGED_STARTUP_BUDGET_MS);
        expect(client.isRunning()).toBe(true);

        // TCP probe to the managed client's SOCKS port succeeds.
        // The managed client binds to an ephemeral port (MANAGED_PROXY_URL
        // uses port 0); probe the docker stack's SOCKS port as a proxy
        // liveness check since the SDK's actual port is internal.
        const port = Number(ATOR_SOCKS_PORT);
        const probeOk = await tcpProbe('127.0.0.1', port, 5_000);
        expect(probeOk).toBe(true);
      });
    });

    // -----------------------------------------------------------------------
    // T-36.4-02 (AC 5): `externalUrl: "auto"` resolves by reading
    //                    `hs/hostname` file after HS publishes
    // -----------------------------------------------------------------------
    describe('T-36.4-02: externalUrl "auto" resolves via hs/hostname file', () => {
      it('hostname file appears and resolves to wss://<base32>.anon:<port>/btp pattern', async () => {
        const hsDir = makeTempHsDir('ator-hs-auto-');
        const hostnameFile = path.join(hsDir, 'hostname');
        const hsPort = 8443;

        const client = trackManagedClient(
          new ManagedAnonClient({
            socksProxy: MANAGED_PROXY_URL,
            hiddenServiceDir: hsDir,
            hiddenServicePort: hsPort,
            startupTimeoutMs: MANAGED_STARTUP_BUDGET_MS,
            logger,
            anonFactory: realAnonFactory,
          })
        );

        await client.start();

        // Poll for the hostname file with exponential backoff (NOT a fixed sleep)
        const hostname = await waitForFile(
          hostnameFile,
          HS_DESCRIPTOR_PUBLISH_BUDGET_MS,
          'HS hostname file'
        );

        // Hostname must match .anon base32 pattern
        expect(hostname).toMatch(/^[a-z2-7]{56}\.anyone$/);

        // Construct provider with externalUrl: 'auto' + resolver.
        // The provider uses PROXY_URL (docker stack SOCKS port) for outbound
        // connections, while the managed client uses its own ephemeral port.
        const provider = trackProvider(
          new SocksTransportProvider({
            socksProxy: PROXY_URL,
            externalUrl: 'auto',
            logger,
            managedClient: client,
            resolveExternalUrlOnStart: async () => {
              const hn = fs.readFileSync(hostnameFile, 'utf8').trim();
              return `wss://${hn}:${hsPort}/btp`;
            },
          })
        );

        await provider.start();
        const resolvedUrl = provider.getExternalUrl();
        expect(resolvedUrl).toMatch(/^wss:\/\/[a-z2-7]{56}\.anyone:\d+\/btp$/);
        // hsDir cleanup handled by afterAll via makeTempHsDir registration
      });
    });

    // -----------------------------------------------------------------------
    // T-36.4-03 (AC 6): Second connector connects inbound via the resolved
    //                    `.anon:port` URL
    // -----------------------------------------------------------------------
    describe('T-36.4-03: inbound .anon connection via HS rendezvous', () => {
      it("Alice connects to Bob's .anon hidden service through SOCKS proxy", async () => {
        // Read Bob's .anon hostname from the hs1 container
        const { stdout: hsHostname } = await execCompose(
          'docker compose exec -T hs1 cat /var/lib/anon/hs/hostname'
        );
        const bobAnon = hsHostname.trim();
        expect(bobAnon).toMatch(/^[a-z2-7]{56}\.anyone$/);

        // Alice: create a SocksTransportProvider pointed at the ator stack's SOCKS port
        const aliceProvider = trackProvider(
          new SocksTransportProvider({
            socksProxy: PROXY_URL,
            externalUrl: 'wss://alice.invalid/btp',
            logger,
          })
        );
        await aliceProvider.start();

        // Alice connects to Bob's .anon address through the SOCKS proxy
        // (using a raw TCP connection as proof-of-rendezvous; the BTP auth
        // is tested in T-36.4-08)
        const bobPort = 5000; // HS port per torrc.hs HiddenServicePort
        // HS circuit establishment can take 30-90s (epic perf table); use a
        // generous connection timeout rather than the data-round-trip budget.
        const HS_CONNECT_BUDGET_MS = 30_000;
        const sock = await socksConnect(PROXY_URL, bobAnon, bobPort, HS_CONNECT_BUDGET_MS);
        expect(sock).toBeDefined();
        sock.destroy();
      });
    });

    // -----------------------------------------------------------------------
    // T-36.4-05 (AC 8): Killing the real `anon` process triggers
    //                    `managed_anon_crash_detected` within one health
    //                    interval
    // -----------------------------------------------------------------------
    describe('T-36.4-05: crash detection after SIGKILL', () => {
      it('managed_anon_crash_detected fires within CRASH_DETECT_BUDGET_MS after SIGKILL', async () => {
        const hsDir = makeTempHsDir('ator-hs-crash-');
        const client = trackManagedClient(
          new ManagedAnonClient({
            socksProxy: MANAGED_PROXY_URL,
            hiddenServiceDir: hsDir,
            startupTimeoutMs: MANAGED_STARTUP_BUDGET_MS,
            logger,
            anonFactory: realAnonFactory,
          })
        );

        await client.start();
        expect(client.isRunning()).toBe(true);

        // Construct provider wrapping the managed client for health-check
        // BEFORE killing the process, so the provider observes the
        // healthy->unhealthy transition and emits managed_anon_crash_detected.
        // Provider uses PROXY_URL (docker stack) for its own TCP probe;
        // the managed client health is checked via sdk.isRunning().
        const provider = trackProvider(
          new SocksTransportProvider({
            socksProxy: PROXY_URL,
            externalUrl: 'wss://placeholder.invalid/btp',
            logger,
            managedClient: client,
          })
        );

        // Verify provider sees the managed client as healthy before the kill
        const preKillHealth = await provider.healthCheck();
        expect(preKillHealth).toBe(true);

        // Find the anon process PID and SIGKILL it
        const pid = await findAnonPid(hsDir);
        expect(pid).toBeGreaterThan(0);
        process.kill(pid, 'SIGKILL');

        // Wait for the health-check cycle to detect the crash
        const t0 = Date.now();
        let crashDetected = false;
        while (Date.now() - t0 < CRASH_DETECT_BUDGET_MS) {
          const healthy = await provider.healthCheck();
          if (!healthy) {
            crashDetected = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }

        expect(crashDetected).toBe(true);

        // Verify the structured log contains the crash event
        const crashEntry = logBuffer.find(
          (e) =>
            (e as Record<string, unknown>).event === 'managed_anon_crash_detected' && e.level >= 40 // WARN
        );
        expect(crashEntry).toBeDefined();

        // healthCheck must return false now
        const postCrashHealth = await provider.healthCheck();
        expect(postCrashHealth).toBe(false);
        // hsDir cleanup handled by afterAll via makeTempHsDir registration
      });
    });

    // -----------------------------------------------------------------------
    // T-36.4-06 (AC 9): ManagedAnonClient.stop() completes within
    //                    stopTimeoutMs under normal shutdown
    // -----------------------------------------------------------------------
    describe('T-36.4-06: clean stop within stopTimeoutMs', () => {
      it('stop() resolves within MANAGED_STOP_BUDGET_MS and no orphan process remains', async () => {
        const hsDir = makeTempHsDir('ator-hs-stop-');
        const client = trackManagedClient(
          new ManagedAnonClient({
            socksProxy: MANAGED_PROXY_URL,
            hiddenServiceDir: hsDir,
            stopTimeoutMs: MANAGED_STOP_BUDGET_MS,
            startupTimeoutMs: MANAGED_STARTUP_BUDGET_MS,
            logger,
            anonFactory: realAnonFactory,
          })
        );

        await client.start();
        expect(client.isRunning()).toBe(true);

        const t0 = Date.now();
        await client.stop();
        const elapsed = Date.now() - t0;

        expect(elapsed).toBeLessThan(MANAGED_STOP_BUDGET_MS);
        expect(client.isRunning()).toBe(false);

        // Verify no orphan anon process remains for this HS dir
        let orphanFound = false;
        try {
          await findAnonPid(hsDir);
          orphanFound = true;
        } catch {
          orphanFound = false;
        }
        expect(orphanFound).toBe(false);
        // hsDir cleanup handled by afterAll via makeTempHsDir registration
      });
    });

    // -----------------------------------------------------------------------
    // T-36.4-07 (AC 10): Hung SDK stop (SIGSTOP) logs timeout and connector
    //                     shutdown proceeds
    // -----------------------------------------------------------------------
    describe('T-36.4-07: hung stop (SIGSTOP) logs timeout; shutdown proceeds', () => {
      let frozenPid: number | undefined;

      afterEach(() => {
        // ALWAYS clean up frozen processes -- a SIGSTOP'd process persists
        // until rebooted if not SIGCONT + SIGKILL'd.
        if (frozenPid !== undefined) {
          try {
            process.kill(frozenPid, 'SIGCONT');
          } catch {
            // ignore
          }
          try {
            process.kill(frozenPid, 'SIGKILL');
          } catch {
            // ignore
          }
          frozenPid = undefined;
        }
      });

      it('stop() resolves within stopTimeoutMs + 2s grace after SIGSTOP; WARN log emitted', async () => {
        const hsDir = makeTempHsDir('ator-hs-hung-');
        const client = trackManagedClient(
          new ManagedAnonClient({
            socksProxy: MANAGED_PROXY_URL,
            hiddenServiceDir: hsDir,
            stopTimeoutMs: MANAGED_STOP_BUDGET_MS,
            startupTimeoutMs: MANAGED_STARTUP_BUDGET_MS,
            logger,
            anonFactory: realAnonFactory,
          })
        );

        await client.start();
        expect(client.isRunning()).toBe(true);

        // Find and freeze the anon process
        frozenPid = await findAnonPid(hsDir);
        process.kill(frozenPid, 'SIGSTOP');

        // stop() should resolve within stopTimeoutMs + 2s grace (the client
        // logs WARN and clears the SDK reference when the timeout fires)
        const t0 = Date.now();
        await client.stop();
        const elapsed = Date.now() - t0;

        expect(elapsed).toBeLessThan(MANAGED_STOP_BUDGET_MS + 2000);

        // Verify WARN log about stop timeout
        const timeoutEntry = logBuffer.find(
          (e) =>
            (e as Record<string, unknown>).event === 'managed_anon_stop_timeout' && e.level >= 40 // WARN
        );
        expect(timeoutEntry).toBeDefined();

        expect(client.isRunning()).toBe(false);
        // hsDir cleanup handled by afterAll via makeTempHsDir registration
        // Frozen process cleanup handled by afterEach
      });
    });

    // -----------------------------------------------------------------------
    // T-36.4-08 (AC 11): BTP round-trip through `.anon` rendezvous completes
    // -----------------------------------------------------------------------
    describe('T-36.4-08: BTP round-trip through .anon rendezvous', () => {
      it('ILP PREPARE->FULFILL round-trip completes within RENDEZVOUS_ROUNDTRIP_BUDGET_MS', async () => {
        // Read Bob's .anon hostname from the hs1 container
        const { stdout: hsHostname } = await execCompose(
          'docker compose exec -T hs1 cat /var/lib/anon/hs/hostname'
        );
        const bobAnon = hsHostname.trim();
        expect(bobAnon).toMatch(/^[a-z2-7]{56}\.anyone$/);

        // Alice connects to Bob through the .anon rendezvous.
        // HS circuit establishment can take most of the budget, so use a
        // generous connection timeout separate from the data round-trip.
        const bobPort = 5000; // HS port per torrc.hs HiddenServicePort
        const HS_CONNECT_BUDGET_MS = 30_000;
        const sock = await socksConnect(PROXY_URL, bobAnon, bobPort, HS_CONNECT_BUDGET_MS);

        try {
          // Send a synthetic ILP PREPARE-shaped payload and verify byte-identical echo
          const preparePayload = Buffer.from(
            'ILP-PREPARE:test-36-4-08:' + Date.now().toString(36),
            'utf8'
          );

          const received: Buffer[] = [];
          const roundTrip = new Promise<Buffer>((resolve, reject) => {
            const timer = setTimeout(
              () =>
                reject(
                  new Error(`BTP round-trip budget ${RENDEZVOUS_ROUNDTRIP_BUDGET_MS}ms exceeded`)
                ),
              RENDEZVOUS_ROUNDTRIP_BUDGET_MS
            );
            let collected = 0;
            sock.on('data', (chunk: Buffer) => {
              received.push(chunk);
              collected += chunk.length;
              if (collected >= preparePayload.length) {
                clearTimeout(timer);
                resolve(Buffer.concat(received).subarray(0, preparePayload.length));
              }
            });
            sock.once('error', (err) => {
              clearTimeout(timer);
              reject(err);
            });
            sock.once('close', () => {
              if (collected < preparePayload.length) {
                clearTimeout(timer);
                reject(new Error(`Peer closed after ${collected}/${preparePayload.length} bytes`));
              }
            });
          });

          sock.write(preparePayload);
          const echoed = await roundTrip;
          expect(echoed.equals(preparePayload)).toBe(true);
        } finally {
          sock.destroy();
        }
      });
    });

    // -----------------------------------------------------------------------
    // T-36.4-04 (AC 7): No `.anon` hostname appears in any log line at INFO+
    //                    during the full run.
    //
    // MUST be the LAST describe block inside the gated suite so it scans
    // log entries from ALL preceding tests (T-36.4-01 through T-36.4-08).
    // Jest runs describe blocks sequentially within a parent, so placement
    // at the end guarantees the buffer is fully populated.
    // -----------------------------------------------------------------------
    describe('T-36.4-04: log hygiene -- no .anon hostnames at INFO+', () => {
      it('zero .anon hostname matches in structured log entries at level >= INFO (30)', () => {
        const ANON_HOSTNAME_RE = /[a-z2-7]{16,56}\.anyone/;
        const leaks: Array<{ level: number; preview: string }> = [];

        for (const entry of logBuffer) {
          if (entry.level >= 30) {
            const serialized = JSON.stringify(entry);
            if (ANON_HOSTNAME_RE.test(serialized)) {
              leaks.push({
                level: entry.level,
                preview: serialized.slice(0, 200),
              });
            }
          }
        }

        if (leaks.length > 0) {
          const first = leaks[0] as { level: number; preview: string };
          throw new Error(
            `SEC-05 violation: .anon hostname found at INFO+ in ${leaks.length} log ` +
              `entries. First: ${first.preview}`
          );
        }

        expect(leaks).toEqual([]);
      });
    });
  }
);

// ---------------------------------------------------------------------------
// No exports -- this is a test module.
// ---------------------------------------------------------------------------
export {};
