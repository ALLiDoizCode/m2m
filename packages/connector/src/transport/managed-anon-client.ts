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

import { promises as fsp } from 'fs';
import path from 'path';
import type pino from 'pino';
import { probeTcpPort, waitForTcpPort } from './probe-tcp-port';
import { parseSocks5hUrl } from './socks-url';

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
}

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

/**
 * Managed wrapper around the `Anon` SDK. See module documentation for the
 * full security contract.
 */
export class ManagedAnonClient {
  private readonly _opts: ManagedAnonClientOptions;
  private readonly _logger: pino.Logger;
  private readonly _socksHost: string;
  private readonly _socksPort: number;
  private _sdk: AnonSdkHandle | undefined;
  /**
   * Public-facing running flag. We distinguish this from `sdk.isRunning()`
   * because a crashed SDK will report false while we still hold a reference.
   * `isRunning()` returns the conjunction of both.
   */
  private _started = false;
  private _lastHealthyFlag = true;
  private _consecutiveProbeFailures = 0;

  constructor(options: ManagedAnonClientOptions) {
    this._opts = options;
    this._logger = options.logger.child({ component: 'managed-anon-client' });

    const { host, port } = parseSocks5hUrl(options.socksProxy);
    this._socksHost = host;
    this._socksPort = port;
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
  }

  /**
   * Tear down the managed SDK. Always resolves -- hung or throwing `sdk.stop()`
   * is logged at WARN and the reference is cleared.
   */
  async stop(): Promise<void> {
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
