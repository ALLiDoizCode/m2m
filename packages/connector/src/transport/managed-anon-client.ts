/**
 * Managed `anon` binary lifecycle wrapper (Epic 35 / Story 35.5).
 *
 * Optionally boots and tears down the `@anyone-protocol/anyone-client` SDK's
 * `Anon` instance in-process, so operators can run a single connector
 * process that starts/stops the ATOR overlay SOCKS proxy (and optional
 * hidden service) together with the connector.
 *
 * The SDK is an OPTIONAL dependency. It is never eagerly imported; callers
 * pass a factory that performs `await import('@anyone-protocol/anyone-client')`
 * only on the `managed: true` path. Unit tests pass a fake factory.
 *
 * Security invariants (load-bearing):
 *   - FAIL CLOSED: `start()` rejects on any SDK error, on SOCKS port
 *     binding timeout, or on missing binary. The transport provider
 *     propagates the rejection up and refuses to serve traffic.
 *   - `.anon` addresses MUST NOT appear in structured INFO/WARN/ERROR/FATAL
 *     log fields (DEBUG/TRACE is OK for developer diagnostics).
 *   - `stop()` never rejects; a hung or throwing `sdk.stop()` is logged at
 *     WARN and the reference is cleared so shutdown is not blocked.
 *
 * @module transport/managed-anon-client
 */

import { promises as fsp, watch as fsWatch, type FSWatcher } from 'fs';
import path from 'path';
import type pino from 'pino';
import { probeTcpPort, waitForTcpPort } from './probe-tcp-port';
import { parseSocks5hUrl } from './socks-url';
import { socks5Connect } from './socks5-connect';
import { normalizeHsAddress, waitForHsDescUpload } from './hs-desc-monitor';

/**
 * Minimal surface of the `Anon` class we depend on. Declared here rather than
 * imported from the optional SDK so the connector package can build/type-check
 * without `@anyone-protocol/anyone-client` installed.
 */
export interface AnonSdkHandle {
  /** Spawn the `anon` binary. Resolves once the binary is alive (not necessarily listening). */
  start(): Promise<void>;
  /** Terminate the `anon` binary. Resolves once the process has exited. */
  stop(): Promise<void>;
  /** Synchronous probe: has the SDK seen the binary alive since last start? */
  isRunning(): boolean;
  /** Returns the bound SOCKS port (useful when `socksPort: 0` ephemeral binding is used). */
  getSOCKSPort(): number;
  /**
   * Returns the control-port number the `anon` process is listening on (the
   * SDK default is 9051). Optional: older/alternate handles may not expose it,
   * in which case {@link ManagedAnonClient} falls back to the self-dial probe
   * for reachability verification.
   */
  getControlPort?(): number;
}

/**
 * Options passed to `anonFactory` (our best-effort superset of the SDK's own
 * `Anon` constructor options -- the SDK tolerates extra fields via an internal
 * config merge, so forward-compat is fine).
 */
export interface AnonFactoryOptions {
  /** Silence the SDK's own stdout/stderr spam unless DEBUG logging. */
  displayLog: boolean;
  /** `false` uses `spawn()`; `true` uses `execFile()`. Library default is `false`. */
  useExecFile: boolean;
  /** SOCKS5 listener port inside the `anon` process. */
  socksPort: number;
  /** OR relay port (0 = disabled; we NEVER run as a relay). */
  orPort: 0;
  /** Optional override for the anon binary path. */
  binaryPath?: string;
  /** Optional anonrc config file path (used when writing HS config to disk). */
  configFilePath?: string;
  /** Optional hidden service directory (native SDK passthrough if supported). */
  hiddenServiceDir?: string;
  /** Optional hidden service port (native SDK passthrough if supported). */
  hiddenServicePort?: number;
  /** Control-port number to enable on the anon process (bound to 127.0.0.1). */
  controlPort?: number;
  /** Accept the Anyone Protocol terms of service non-interactively. */
  autoTermsAgreement?: boolean;
}

/**
 * Constructor options for `ManagedAnonClient`.
 */
export interface ManagedAnonClientOptions {
  /** SOCKS5 proxy URL. The port is parsed out and passed to the SDK. */
  socksProxy: string;
  /** Absolute or project-relative path to the hidden-service key directory. */
  hiddenServiceDir?: string;
  /** Port to expose on the hidden service (maps to HS config, not the OR port). */
  hiddenServicePort?: number;
  /**
   * anon control-port number. Enables the control port (bound to 127.0.0.1)
   * so HS publication can be gated on a `HS_DESC UPLOADED` event. Defaults to
   * `<socksPort> + 1`; override to avoid collisions across managed clients.
   */
  controlPort?: number;
  /** Optional binary override. When undefined, the SDK uses its bundled binary. */
  binaryPath?: string;
  /** Overall deadline for SOCKS port readiness (ms). Default 60000. */
  startupTimeoutMs?: number;
  /** Overall deadline for `sdk.stop()` (ms). Default 10000. */
  stopTimeoutMs?: number;
  /** Pino logger -- a child logger with component="managed-anon-client" is created internally. */
  logger: pino.Logger;
  /**
   * Factory returning an `AnonSdkHandle`. In production, this performs a lazy
   * dynamic `import('@anyone-protocol/anyone-client')` and constructs `new
   * Anon(opts)`. In tests, a fake factory is injected.
   */
  anonFactory: (opts: AnonFactoryOptions) => AnonSdkHandle;
  /**
   * When true (default), the hostname is only reported as published once the v3
   * descriptor is confirmed fetchable on the overlay, not merely that the local
   * `hostname` file exists. Two mechanisms, in order of preference:
   *
   *   1. **Control port (primary).** Subscribe to the anon control port's
   *      `HS_DESC` events and publish on the first `UPLOADED` for our own
   *      address — a direct, daemon-reported "descriptor is on an HSDir"
   *      signal. Used when the handle exposes {@link AnonSdkHandle.getControlPort}.
   *   2. **Self-dial (fallback).** When no control port is available, or the
   *      control-port path errors, self-dial the node's own `.anyone` address
   *      through the local SOCKS proxy and publish once that CONNECT succeeds.
   *
   * Requires `hiddenServicePort` to be set; if it is not, verification is
   * skipped and the hostname is reported on file detection (legacy behaviour).
   *
   * Set to false to restore the pre-verification behaviour (report on file
   * detection). Mainly useful for tests or constrained environments where
   * neither the control port nor a self-dial is possible.
   */
  verifyReachability?: boolean;
  /**
   * Override for the SOCKS5 self-dial fallback used by reachability
   * verification. Tests inject a fake (resolve = reachable, reject = not yet).
   * Defaults to the built-in {@link socks5Connect}.
   */
  selfDial?: (opts: {
    socksHost: string;
    socksPort: number;
    destHost: string;
    destPort: number;
    timeoutMs: number;
  }) => Promise<void>;
  /**
   * Override for the control-port `HS_DESC` monitor used as the primary
   * reachability signal. Tests inject a fake (resolve = our descriptor was
   * uploaded, reject = unavailable/timed out → fall back to self-dial).
   * Defaults to the built-in {@link waitForHsDescUpload}.
   */
  waitForHsDescUpload?: (opts: {
    controlHost: string;
    controlPort: number;
    address: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }) => Promise<void>;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

/** Hostname-watch fallback poll interval (ms). */
const HOSTNAME_POLL_INTERVAL_MS = 2_000;
/** Maximum total time the fallback poll runs before giving up (ms). */
const HOSTNAME_POLL_MAX_DURATION_MS = 5 * 60 * 1_000;
/** Per-attempt timeout for the self-dial reachability probe (ms). */
const SELF_DIAL_TIMEOUT_MS = 10_000;

/**
 * Snapshot of the cached hidden-service hostname.
 *
 * Both fields are `null` until the hidden service is confirmed published: the
 * anon process has written `${hiddenServiceDir}/hostname` AND (when
 * `verifyReachability` is enabled) a self-dial through the local SOCKS proxy to
 * the address succeeded, proving the v3 descriptor is fetchable on the overlay.
 * Once set, both fields are stable for the lifetime of the `ManagedAnonClient`
 * instance — there is no SIGHUP-style re-read; key rotation is a
 * process-restart event.
 */
export interface HostnameSnapshot {
  hostname: string | null;
  publishedAt: string | null;
}

/**
 * Managed wrapper around the `Anon` SDK. See module documentation for the
 * full security contract.
 */
export class ManagedAnonClient {
  private readonly _opts: ManagedAnonClientOptions;
  private readonly _logger: pino.Logger;
  private readonly _socksHost: string;
  private readonly _socksPort: number;
  /** Control-port number written into the anonrc (HS setups only). */
  private readonly _controlPortNum: number;
  private _sdk: AnonSdkHandle | undefined;
  /**
   * Public-facing running flag. We distinguish this from `sdk.isRunning()`
   * because a crashed SDK will report false while we still hold a reference.
   * `isRunning()` returns the conjunction of both.
   */
  private _started = false;
  private _lastHealthyFlag = true;
  private _consecutiveProbeFailures = 0;
  /** Cached hostname read from `${hiddenServiceDir}/hostname` (trimmed). */
  private _hostname: string | null = null;
  /**
   * ISO-8601 timestamp set once the hidden service is confirmed published —
   * i.e. the hostname file exists AND (when verification is enabled) the
   * descriptor was confirmed fetchable, either via a control-port `HS_DESC`
   * `UPLOADED` event or, as a fallback, a successful self-dial. `null` until
   * then.
   */
  private _publishedAt: string | null = null;
  /** True while a self-dial verification attempt is in flight (re-entrancy guard). */
  private _verifyInFlight = false;
  /** True once the (single) control-port `HS_DESC` monitor has been started. */
  private _hsDescMonitorStarted = false;
  /** Set when the control-port monitor confirms our descriptor was UPLOADED. */
  private _hsDescUploaded = false;
  /**
   * Set when the control-port monitor errors out (unavailable, auth failure,
   * timeout) — subsequent verification attempts fall back to the self-dial.
   */
  private _hsDescUnavailable = false;
  /** Aborts the in-flight control-port monitor on teardown. */
  private _hsDescAbort: AbortController | undefined;
  /** Active fs.watch handle for the hidden-service directory; closed on read or stop. */
  private _hostnameWatcher: FSWatcher | undefined;
  /** Active fallback-poll timer; cleared on read or stop. */
  private _hostnamePollTimer: NodeJS.Timeout | undefined;
  /** Wall-clock deadline (ms since epoch) at which the fallback poll gives up. */
  private _hostnamePollDeadlineMs = 0;
  /**
   * Set to true by `_cleanupHostnameWatch()` to short-circuit any in-flight
   * `_tryReadHostname()` chain or pending poll re-arm. Cleared on each
   * `_startHostnameWatch()` so the client can be restarted.
   */
  private _hostnameWatchStopped = false;

  constructor(options: ManagedAnonClientOptions) {
    this._opts = options;
    this._logger = options.logger.child({ component: 'managed-anon-client' });

    const { host, port } = parseSocks5hUrl(options.socksProxy);
    this._socksHost = host;
    this._socksPort = port;
    // Conventional Tor pairing (SocksPort 9050 / ControlPort 9051). Deriving
    // from the SOCKS port keeps control ports distinct when several managed
    // clients share a host; an explicit `controlPort` overrides it.
    this._controlPortNum = options.controlPort ?? this._socksPort + 1;
  }

  /**
   * Boot the managed SDK and block until the SOCKS port accepts TCP
   * connections. Rejects on ENOENT, missing SDK, or startup timeout.
   *
   * @throws {Error} FAIL-CLOSED on any unrecoverable startup failure.
   */
  async start(): Promise<void> {
    if (this._started && this._sdk) {
      return;
    }

    const factoryOpts = await this._buildFactoryOptions();

    // Construct (may throw MODULE_NOT_FOUND if SDK missing).
    let sdk: AnonSdkHandle;
    try {
      sdk = this._opts.anonFactory(factoryOpts);
    } catch (err) {
      const cause = err as NodeJS.ErrnoException;
      if (cause?.code === 'MODULE_NOT_FOUND') {
        throw new Error(
          `Managed ATOR transport requires the optional dependency ` +
            `"@anyone-protocol/anyone-client" but it was not found. ` +
            `Install it with: npm install @anyone-protocol/anyone-client`,
          { cause }
        );
      }
      throw new Error(
        `Failed to construct @anyone-protocol/anyone-client SDK handle: ${cause?.message ?? String(err)}`,
        { cause }
      );
    }

    // Boot the binary.
    try {
      await sdk.start();
    } catch (err) {
      const cause = err as NodeJS.ErrnoException;
      await this._bestEffortStop(sdk);
      this._sdk = undefined;
      this._started = false;
      if (cause?.code === 'ENOENT' || /ENOENT/.test(cause?.message ?? '')) {
        const hint = this._opts.binaryPath
          ? ` at configured binaryPath="${this._opts.binaryPath}"`
          : ' (the bundled binary shipped by @anyone-protocol/anyone-client could not be spawned)';
        throw new Error(
          `anon binary not found${hint}. Install @anyone-protocol/anyone-client ` +
            `and ensure a compatible binary is available for this platform ` +
            `(npm install @anyone-protocol/anyone-client).`,
          { cause }
        );
      }
      throw new Error(`Failed to start managed anon SDK: ${cause?.message ?? String(err)}`, {
        cause,
      });
    }

    // Wait for the SOCKS port to accept connections.
    const startupTimeoutMs = this._opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const socksPort = sdk.getSOCKSPort?.() ?? this._socksPort;
    try {
      await waitForTcpPort(this._socksHost, socksPort, startupTimeoutMs);
    } catch (err) {
      const cause = err as Error;
      await this._bestEffortStop(sdk);
      this._sdk = undefined;
      this._started = false;
      throw new Error(
        `Managed anon SOCKS port ${socksPort} did not bind within ${startupTimeoutMs}ms timeout ` +
          `(awaiting TCP readiness on ${this._socksHost}:${socksPort})`,
        { cause }
      );
    }

    this._sdk = sdk;
    this._started = true;
    this._lastHealthyFlag = true;
    this._logger.info({ event: 'managed_anon_started', socksPort }, 'Managed anon client started');

    // Kick off the hostname watcher in the background. Failures here are
    // non-fatal: the connector's transport is already up, the admin endpoint
    // simply reports `hostname: null` until detection succeeds.
    if (this._opts.hiddenServiceDir) {
      this._startHostnameWatch().catch((err: unknown) => {
        this._logger.warn(
          {
            event: 'managed_anon_hostname_watch_setup_failed',
            errorMessage: (err as Error)?.message ?? String(err),
          },
          'Hostname watch setup failed; admin /hs-hostname will report null'
        );
      });
    }
  }

  /**
   * Tear down the managed SDK. Always resolves -- hung or throwing `sdk.stop()`
   * is logged at WARN and the reference is cleared.
   */
  async stop(): Promise<void> {
    // Always clean up hostname watch resources, even on the idempotent path,
    // in case start() set them up but a prior stop() left them lingering.
    this._cleanupHostnameWatch();

    const sdk = this._sdk;
    if (!sdk || !this._started) {
      // Idempotent no-op.
      this._sdk = undefined;
      this._started = false;
      return;
    }
    this._sdk = undefined;
    this._started = false;

    const stopTimeoutMs = this._opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), stopTimeoutMs);
    });

    // Capture the underlying sdk.stop() promise and separately attach a
    // fire-and-forget guard handler so a LATE rejection (after the timeout
    // branch of the race has already won) does not surface as an
    // UnhandledPromiseRejection — which on Node >=22 defaults can terminate
    // the process during shutdown. The guard logs the late rejection at WARN
    // so operators still see it.
    let raceSettled = false;
    const sdkStopPromise = sdk.stop();
    sdkStopPromise.catch((lateErr: unknown) => {
      if (raceSettled) {
        this._logger.warn(
          {
            event: 'managed_anon_stop_late_error',
            errorMessage: (lateErr as Error)?.message ?? String(lateErr),
          },
          'Managed anon SDK stop() rejected after the stop race had already settled'
        );
      }
      // If not settled yet, the race below will handle the rejection via its
      // own catch block.
    });

    try {
      const result = await Promise.race([sdkStopPromise.then(() => 'ok' as const), timeoutPromise]);
      raceSettled = true;
      if (result === 'timeout') {
        const stillRunning = safeIsRunning(sdk);
        this._logger.warn(
          {
            event: 'managed_anon_stop_timeout',
            stopTimeoutMs,
            sdkStillRunning: stillRunning,
          },
          'Managed anon SDK stop() did not resolve within timeout; ' +
            (stillRunning ? 'operator intervention may be required' : 'proceeding with shutdown')
        );
      } else {
        this._logger.info({ event: 'managed_anon_stopped' }, 'Managed anon client stopped');
      }
    } catch (err) {
      raceSettled = true;
      const cause = err as Error;
      this._logger.warn(
        {
          event: 'managed_anon_stop_error',
          errorMessage: cause?.message ?? String(err),
        },
        'Managed anon SDK stop() threw; continuing shutdown'
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * True iff `start()` completed AND the SDK still reports running.
   */
  isRunning(): boolean {
    return this._started && safeIsRunning(this._sdk);
  }

  /**
   * Health probe: returns false if the SDK reports not running. Emits a
   * single WARN log on the healthy->unhealthy transition. Never throws.
   */
  async healthCheck(): Promise<boolean> {
    if (!this._started || !this._sdk) {
      return false;
    }
    const ok = safeIsRunning(this._sdk);
    if (!ok && this._lastHealthyFlag) {
      this._lastHealthyFlag = false;
      this._logger.warn(
        { event: 'managed_anon_crash_detected' },
        'Managed anon SDK reports not running (binary may have crashed)'
      );
    } else if (ok && !this._lastHealthyFlag) {
      this._lastHealthyFlag = true;
    }
    // Additional TCP probe: defends against an SDK that reports isRunning()
    // but whose SOCKS port has silently stopped accepting connections (e.g.,
    // a deadlocked worker thread). We require TWO consecutive probe failures
    // before flipping the health signal to avoid single-probe flapping.
    if (ok) {
      try {
        await probeTcpPort(this._socksHost, this._sdk.getSOCKSPort(), 250);
        this._consecutiveProbeFailures = 0;
      } catch (err) {
        this._consecutiveProbeFailures += 1;
        if (this._consecutiveProbeFailures >= 2) {
          this._logger.warn(
            {
              event: 'managed_anon_probe_failed',
              consecutiveFailures: this._consecutiveProbeFailures,
              errorMessage: (err as Error)?.message ?? String(err),
            },
            'Managed anon SOCKS port probe failed on 2+ consecutive health checks'
          );
          return false;
        }
      }
    }
    return ok;
  }

  /**
   * True iff this client was constructed with a `hiddenServiceDir` (i.e. a
   * hidden service is configured to publish a `.anyone` descriptor).
   *
   * Returns false when only a plain SOCKS proxy is wired up — in that case
   * there is nothing to expose via the admin `/hs-hostname` endpoint.
   */
  isHiddenServiceConfigured(): boolean {
    return this._opts.hiddenServiceDir !== undefined && this._opts.hiddenServiceDir.length > 0;
  }

  /**
   * Snapshot of the hidden-service hostname.
   *
   * Returns `{ hostname: null, publishedAt: null }` until the anon process
   * publishes the v3 descriptor (~30–90s after `start()`). Once read, the
   * cached values are stable for the process lifetime — there is no SIGHUP
   * re-read; key rotation requires a connector restart.
   */
  getHostnameSnapshot(): HostnameSnapshot {
    return { hostname: this._hostname, publishedAt: this._publishedAt };
  }

  /**
   * Begin watching `${hiddenServiceDir}/hostname` for first publish.
   *
   * Strategy: try an immediate read (fast path for restarts where the file
   * already exists), then set up `fs.watch` on the directory. If `fs.watch`
   * is unavailable (ENOSYS on some Docker overlay filesystems, or any error
   * during setup), fall back to a bounded poll. Stops watching as soon as a
   * non-empty hostname is read.
   */
  private async _startHostnameWatch(): Promise<void> {
    const dir = this._opts.hiddenServiceDir;
    if (!dir) return;

    // Reset the stopped flag so a restart after stop() rearms the watcher.
    this._hostnameWatchStopped = false;

    if (await this._tryReadHostname()) return;

    try {
      this._hostnameWatcher = fsWatch(dir, { persistent: false });
      this._hostnameWatcher.on('change', (_event, filename) => {
        if (filename && filename.toString() !== 'hostname') return;
        void this._tryReadHostname();
      });
      this._hostnameWatcher.on('error', (err: Error) => {
        this._logger.debug(
          { event: 'managed_anon_hostname_watch_error', errorMessage: err.message },
          'fs.watch on hidden-service dir errored; relying on fallback poll'
        );
      });
    } catch (err) {
      // ENOSYS / EPERM / unsupported filesystem — fall through to polling.
      this._logger.debug(
        {
          event: 'managed_anon_hostname_watch_unavailable',
          errorMessage: (err as Error).message,
        },
        'fs.watch unavailable; using bounded fallback poll for hostname detection'
      );
    }

    // Always arm the fallback poll alongside fs.watch. If the watcher fires
    // first, the poll is a no-op (it short-circuits once `_hostname` is set);
    // if the watcher never fires (unsupported FS, missed event), the poll
    // catches it within HOSTNAME_POLL_INTERVAL_MS.
    this._hostnamePollDeadlineMs = Date.now() + HOSTNAME_POLL_MAX_DURATION_MS;
    this._scheduleHostnamePoll();
  }

  private _scheduleHostnamePoll(): void {
    if (this._hostnameWatchStopped) return;
    // Keep polling until the hostname is both detected AND (optionally) verified
    // reachable — `_publishedAt`, not `_hostname`, is the terminal condition.
    if (this._publishedAt !== null) return;
    if (Date.now() >= this._hostnamePollDeadlineMs) {
      this._logger.warn(
        {
          event: 'managed_anon_hostname_poll_giveup',
          maxDurationMs: HOSTNAME_POLL_MAX_DURATION_MS,
        },
        'Gave up waiting for hidden-service hostname publish; admin /hs-hostname will continue to report null until restart'
      );
      this._cleanupHostnameWatch();
      return;
    }
    this._hostnamePollTimer = setTimeout(() => {
      void this._tryReadHostname().then((found) => {
        if (!found) this._scheduleHostnamePoll();
      });
    }, HOSTNAME_POLL_INTERVAL_MS);
    // Avoid keeping the Node event loop alive solely for this timer.
    if (typeof this._hostnamePollTimer.unref === 'function') {
      this._hostnamePollTimer.unref();
    }
  }

  /**
   * Drive the hidden service toward the published state. Returns true once
   * `_publishedAt` is set (terminal); false while still pending.
   *
   * Two idempotent steps, safe to call repeatedly from the watcher and poll:
   *   1. Read `${hiddenServiceDir}/hostname` (once) to learn the address.
   *   2. When `verifyReachability` is enabled and `hiddenServicePort` is set,
   *      self-dial the address through the local SOCKS proxy and only publish
   *      once that CONNECT succeeds (descriptor fetched + rendezvous up).
   *      Otherwise publish on detection (legacy behaviour).
   */
  private async _tryReadHostname(): Promise<boolean> {
    if (this._hostnameWatchStopped) return false;
    if (this._publishedAt !== null) return true;

    // Step 1: ensure the hostname file has been read (once).
    if (this._hostname === null) {
      const dir = this._opts.hiddenServiceDir;
      if (!dir) return false;
      const hostnameFile = path.join(dir, 'hostname');
      try {
        const raw = await fsp.readFile(hostnameFile, 'utf8');
        // Re-check the stopped flag — `stop()` may have run while readFile was
        // in flight. Without this guard a late read could populate the cache
        // after the client is supposed to be torn down.
        if (this._hostnameWatchStopped) return false;
        const trimmed = raw.trim();
        if (trimmed.length === 0) return false;
        this._hostname = trimmed;
        this._logger.info(
          { event: 'managed_anon_hostname_detected' },
          'Hidden-service hostname file detected; verifying overlay reachability'
        );
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'EISDIR') {
          this._logger.debug(
            {
              event: 'managed_anon_hostname_read_error',
              code,
              errorMessage: (err as Error).message,
            },
            'Hostname file read failed (treating as not-yet-published)'
          );
        }
        return false;
      }
    }

    // Step 2: confirm the descriptor is actually reachable before publishing.
    const verify = this._opts.verifyReachability ?? true;
    const port = this._opts.hiddenServicePort;
    if (verify && port !== undefined) {
      const reachable = await this._verifyReachable(this._hostname, port);
      if (this._hostnameWatchStopped) return false;
      if (!reachable) return false;
    }

    this._markPublished();
    return true;
  }

  /**
   * Stamp `_publishedAt`, log at info, and tear down the watch/poll machinery.
   * The `.anon` address is deliberately NOT logged (security invariant:
   * addresses must not appear in INFO+ structured fields).
   */
  private _markPublished(): void {
    if (this._publishedAt !== null) return;
    this._publishedAt = new Date().toISOString();
    this._logger.info(
      { event: 'managed_anon_hostname_published', publishedAt: this._publishedAt },
      'Hidden-service hostname published'
    );
    this._cleanupHostnameWatch();
  }

  /**
   * Confirm the v3 descriptor is fetchable on the overlay before publishing.
   *
   * Primary path: when the SDK handle exposes a control port, subscribe to its
   * `HS_DESC` events (once) and publish on the first `UPLOADED` for our own
   * address — a direct, daemon-reported signal. While that monitor is pending
   * this returns false (the poll keeps re-checking) and the monitor itself
   * publishes promptly on the event.
   *
   * Fallback path: when no control port is available, or the control-port
   * monitor has errored, self-dial our own address through the local SOCKS
   * proxy and treat a successful CONNECT as proof of reachability.
   *
   * Returns true once reachability is confirmed; false while still pending.
   */
  private async _verifyReachable(hostname: string, port: number): Promise<boolean> {
    if (this._hsDescUploaded) return true;
    const controlPort = this._controlPort();
    if (controlPort !== undefined && !this._hsDescUnavailable) {
      this._ensureHsDescMonitor(hostname, controlPort);
      // The monitor resolves asynchronously and publishes itself; until then
      // (or until it errors and flips us to the self-dial fallback) we are
      // still pending.
      return false;
    }
    return this._selfDialReachable(hostname, port);
  }

  /** The anon control port, if one was enabled for this client. */
  private _controlPort(): number | undefined {
    const p = this._sdk?.getControlPort?.();
    if (typeof p === 'number' && p > 0) return p;
    // Fallback to the value we wrote into the anonrc. Only meaningful when the
    // control port was actually enabled, i.e. an HS dir is configured.
    return this._opts.hiddenServiceDir ? this._controlPortNum : undefined;
  }

  /**
   * Start (once) the control-port `HS_DESC` monitor. On the first `UPLOADED`
   * for our address it marks the service published; on any error it flips
   * `_hsDescUnavailable` so subsequent verification falls back to the self-dial.
   * The address is never logged (security invariant).
   */
  private _ensureHsDescMonitor(hostname: string, controlPort: number): void {
    if (this._hsDescMonitorStarted) return;
    this._hsDescMonitorStarted = true;
    const wait = this._opts.waitForHsDescUpload ?? waitForHsDescUpload;
    this._hsDescAbort = new AbortController();
    // Give the monitor the remaining poll budget so it shares the overall
    // 5-minute give-up deadline rather than imposing a second, shorter one.
    const timeoutMs = Math.max(1_000, this._hostnamePollDeadlineMs - Date.now());
    wait({
      controlHost: this._socksHost,
      controlPort,
      address: normalizeHsAddress(hostname),
      timeoutMs,
      signal: this._hsDescAbort.signal,
    })
      .then(() => {
        if (this._hostnameWatchStopped) return;
        this._hsDescUploaded = true;
        this._logger.debug(
          { event: 'managed_anon_hs_desc_uploaded' },
          'Control port reported HS_DESC UPLOADED for our descriptor'
        );
        this._markPublished();
      })
      .catch((err) => {
        if (this._hostnameWatchStopped) return;
        this._hsDescUnavailable = true;
        this._logger.debug(
          {
            event: 'managed_anon_hs_desc_monitor_failed',
            errorMessage: (err as Error)?.message ?? String(err),
          },
          'Control-port HS_DESC monitor unavailable; falling back to self-dial'
        );
        // Nudge the gate so the self-dial fallback starts without waiting for
        // the next poll tick.
        void this._tryReadHostname().then((found) => {
          if (!found) this._scheduleHostnamePoll();
        });
      });
  }

  /**
   * Self-dial the connector's own `.anon` address through the local SOCKS proxy
   * to confirm the v3 descriptor is published and a rendezvous can be
   * established. Never throws: returns false (retry later) on any failure and
   * logs at debug. Concurrent calls (watcher + poll firing together) are
   * coalesced via `_verifyInFlight` so only one self-dial runs at a time.
   */
  private async _selfDialReachable(hostname: string, port: number): Promise<boolean> {
    if (this._verifyInFlight) return false;
    this._verifyInFlight = true;
    const socksPort = this._sdk?.getSOCKSPort?.() ?? this._socksPort;
    const dial = this._opts.selfDial ?? socks5Connect;
    try {
      await dial({
        socksHost: this._socksHost,
        socksPort,
        destHost: hostname,
        destPort: port,
        timeoutMs: SELF_DIAL_TIMEOUT_MS,
      });
      return true;
    } catch (err) {
      this._logger.debug(
        {
          event: 'managed_anon_self_dial_failed',
          errorMessage: (err as Error)?.message ?? String(err),
        },
        'Self-dial to own hidden service not yet reachable; will retry'
      );
      return false;
    } finally {
      this._verifyInFlight = false;
    }
  }

  private _cleanupHostnameWatch(): void {
    this._hostnameWatchStopped = true;
    if (this._hsDescAbort) {
      this._hsDescAbort.abort();
      this._hsDescAbort = undefined;
    }
    if (this._hostnameWatcher) {
      try {
        this._hostnameWatcher.close();
      } catch {
        // Ignore: closing a watcher may throw on some platforms if it's
        // already been closed; harmless during shutdown.
      }
      this._hostnameWatcher = undefined;
    }
    if (this._hostnamePollTimer) {
      clearTimeout(this._hostnamePollTimer);
      this._hostnamePollTimer = undefined;
    }
  }

  /**
   * Build the factory options, writing an `anonrc` file to
   * `hiddenServiceDir` if configured so the SDK's own `configFilePath`
   * surface can pick up HS settings regardless of whether the installed
   * version exposes first-class JS HS options.
   */
  private async _buildFactoryOptions(): Promise<AnonFactoryOptions> {
    const opts: AnonFactoryOptions = {
      displayLog: this._opts.logger.level === 'debug' || this._opts.logger.level === 'trace',
      useExecFile: false,
      socksPort: this._socksPort,
      orPort: 0,
      binaryPath: this._opts.binaryPath,
      autoTermsAgreement: true,
    };
    if (this._opts.hiddenServiceDir) {
      // Surface both native (if SDK supports it) and config-file (fallback)
      // paths. The test asserts that at least one form is present.
      opts.hiddenServiceDir = this._opts.hiddenServiceDir;
      if (this._opts.hiddenServicePort !== undefined) {
        opts.hiddenServicePort = this._opts.hiddenServicePort;
      }
      // Enable the control port so reachability verification can gate
      // publication on a `HS_DESC UPLOADED` event. Mirrors the SOCKS port:
      // also surface it as a native option so `getControlPort()` agrees with
      // the value written into the anonrc.
      opts.controlPort = this._controlPortNum;
      try {
        await fsp.mkdir(this._opts.hiddenServiceDir, { recursive: true });
        const anonrcPath = path.join(this._opts.hiddenServiceDir, 'anonrc');
        // Do NOT clobber an operator-provided anonrc. Only write the default
        // file on first boot (when the file does not yet exist). This avoids
        // (a) overwriting operator customizations on every start() and
        // (b) racing with the running `anon` process if start() is called
        // while a prior instance is still reading the same file.
        let anonrcExists = false;
        try {
          await fsp.access(anonrcPath);
          anonrcExists = true;
        } catch {
          anonrcExists = false;
        }
        if (!anonrcExists) {
          const anonrc =
            `# Written by ManagedAnonClient (Epic 35 / Story 35.5) on first boot.\n` +
            `# Edit freely — ManagedAnonClient will NOT overwrite this file on subsequent starts.\n` +
            `AgreeToTerms 1\n` +
            `SocksPort ${this._socksPort}\n` +
            // Bound to 127.0.0.1 and unauthenticated (the anon binary warns:
            // "ControlPort is open, but no authentication method configured").
            // Localhost-only keeps it reachable solely from this connector,
            // which is what the HS_DESC reachability gate needs. Only takes
            // effect on first boot; existing anonrc files keep their content
            // (such nodes fall back to the self-dial reachability probe).
            `ControlPort 127.0.0.1:${this._controlPortNum}\n` +
            `HiddenServiceDir ${this._opts.hiddenServiceDir}\n` +
            (this._opts.hiddenServicePort !== undefined
              ? `HiddenServicePort ${this._opts.hiddenServicePort} 127.0.0.1:${this._opts.hiddenServicePort}\n`
              : '');
          await fsp.writeFile(anonrcPath, anonrc, { encoding: 'utf8', flag: 'wx' });
        }
        // The `@anyone-protocol/anyone-client` v1.1.x SDK reads this as
        // `options.configFile`; older/newer surfaces used `configFilePath`.
        // Set both so the anonrc actually reaches the anon binary regardless
        // of the SDK version pinned at install time.
        opts.configFilePath = anonrcPath;
        (opts as AnonFactoryOptions & { configFile?: string }).configFile = anonrcPath;
      } catch (err) {
        this._logger.debug(
          { event: 'managed_anon_anonrc_write_failed', error: (err as Error).message },
          'Could not write anonrc; continuing with native options only'
        );
      }
    }
    return opts;
  }

  private async _bestEffortStop(sdk: AnonSdkHandle): Promise<void> {
    try {
      await sdk.stop();
    } catch (err) {
      this._logger.warn(
        {
          event: 'managed_anon_cleanup_stop_failed',
          errorMessage: (err as Error).message,
        },
        'Best-effort SDK stop() during failure cleanup threw; ignoring'
      );
    }
  }
}

/** Defensive wrapper around a possibly-broken `isRunning()` implementation. */
function safeIsRunning(sdk: AnonSdkHandle | undefined): boolean {
  if (!sdk) return false;
  try {
    return sdk.isRunning() === true;
  } catch {
    return false;
  }
}

/**
 * Production factory: lazily imports the optional SDK and constructs a fresh
 * `Anon` instance. Never called during unit tests -- tests inject their own
 * factory via `ManagedAnonClientOptions.anonFactory`.
 */
export async function createDefaultAnonFactory(): Promise<
  (opts: AnonFactoryOptions) => AnonSdkHandle
> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  // The package is an optional runtime dependency; its types may not be
  // installed in node_modules. Indirect through variables so TS can't
  // statically resolve the specifier.
  const pkg = '@anyone-protocol/anyone-client';
  try {
    // CJS-friendly require() first; falls back to ESM import().
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(pkg);
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mod = await (new Function('p', 'return import(p)') as (p: string) => Promise<any>)(pkg);
    } catch (err) {
      const cause = err as NodeJS.ErrnoException;
      const wrapped = new Error(
        `Managed ATOR transport requires the optional dependency ` +
          `"@anyone-protocol/anyone-client" but it was not found. ` +
          `Install it with: npm install @anyone-protocol/anyone-client`,
        { cause }
      );
      // Surface a MODULE_NOT_FOUND-shaped error so ManagedAnonClient.start()
      // can detect and re-wrap it with the canonical template.
      (wrapped as NodeJS.ErrnoException).code = 'MODULE_NOT_FOUND';
      throw wrapped;
    }
  }
  // v1.1.x of `@anyone-protocol/anyone-client` exports `Process`; earlier and
  // newer surface expose `Anon`. Accept both so the default factory works
  // across the SDK versions pinned in peer/optionalDependencies.
  const AnonCtor =
    mod?.Process ?? mod?.Anon ?? mod?.default?.Process ?? mod?.default?.Anon ?? mod?.default;
  if (typeof AnonCtor !== 'function') {
    throw new Error(
      '@anyone-protocol/anyone-client did not export a `Process` or `Anon` constructor; ' +
        'SDK surface may have changed.'
    );
  }
  return (opts: AnonFactoryOptions) => new AnonCtor(opts) as AnonSdkHandle;
}
