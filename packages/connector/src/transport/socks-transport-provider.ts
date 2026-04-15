/**
 * SOCKS5 Transport Provider
 *
 * Routes outbound BTP WebSocket connections through a SOCKS5 proxy
 * (e.g., ATOR / Tor) so the connector can peer through `.anon` hidden
 * services without exposing its real IP.
 *
 * Security invariants (load-bearing):
 *   - `socks5h://` scheme REQUIRED (DNS leak prevention -- defense-in-depth)
 *   - FAIL CLOSED: `start()` throws when the proxy is unreachable (never
 *     silently falls back to direct connections)
 *   - `.anon` addresses MUST NOT appear in structured INFO/WARN/ERROR/FATAL
 *     log fields (DEBUG/TRACE is OK for developer diagnostics)
 *   - Fresh `SocksProxyAgent` per `createAgent()` call (no shared per-peer
 *     connection state)
 *
 * Epic 35 Story 35.2
 *
 * @module socks-transport-provider
 */

import type http from 'http';
import type pino from 'pino';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { ManagedAnonClient } from './managed-anon-client';
import { probeTcpPort } from './probe-tcp-port';
import { parseSocks5hUrl } from './socks-url';
import type { TransportProvider } from './transport-provider';

/**
 * Constructor options for `SocksTransportProvider`.
 */
export interface SocksTransportProviderOptions {
  /** SOCKS5 proxy URL. Must start with "socks5h://". DNS leak prevention. */
  socksProxy: string;
  /** This node's externally reachable URL for inbound peering (typically wss://<hidden>.anon/btp). */
  externalUrl: string;
  /** Pino logger -- a child logger with component="socks-transport-provider" is created internally. */
  logger: pino.Logger;
  /**
   * Optional managed `anon` binary lifecycle client (Story 35.5). When
   * present, `start()` boots the managed client BEFORE probing the proxy,
   * `stop()` tears it down, and `healthCheck()` requires both the managed
   * client and the TCP probe to succeed.
   */
  managedClient?: ManagedAnonClient;
  /**
   * Optional async resolver invoked AFTER the managed client has started but
   * BEFORE the TCP probe. Used to implement `externalUrl: 'auto'` (Story 35.5
   * AC #8): the caller reads the hidden service `hostname` file and returns
   * the resolved `wss://<hostname>/btp` URL, which replaces the construction-
   * time placeholder. If the resolver throws, `start()` fails closed.
   */
  resolveExternalUrlOnStart?: () => Promise<string>;
}

/** Timeout for the one-shot startup TCP probe (ms). */
const START_PROBE_TIMEOUT_MS = 2000;
/** Timeout for periodic health-check TCP probes (ms). */
const HEALTH_PROBE_TIMEOUT_MS = 1000;

/**
 * SOCKS5 transport provider -- routes BTP connections through a SOCKS5 proxy.
 *
 * The provider assumes an externally running SOCKS5 proxy (e.g., system Tor
 * or an `anon` binary started manually). Binary lifecycle management is out
 * of scope for this story (see Story 35.5).
 */
export class SocksTransportProvider implements TransportProvider {
  private readonly _socksProxy: string;
  private _externalUrl: string;
  private readonly _logger: pino.Logger;
  private readonly _proxyHost: string;
  private readonly _proxyPort: number;
  private readonly _managedClient: ManagedAnonClient | undefined;
  private readonly _resolveExternalUrlOnStart: (() => Promise<string>) | undefined;
  private _managedHealthy = true;

  /**
   * @param options - Configuration options (see {@link SocksTransportProviderOptions}).
   * @throws {Error} If `socksProxy` is missing, has the wrong scheme, or is not parseable.
   * @throws {Error} If `externalUrl` is empty.
   */
  constructor(options: SocksTransportProviderOptions) {
    const { socksProxy, externalUrl, logger, managedClient, resolveExternalUrlOnStart } = options;

    // Defensive pre-check so we can prefix the error with the provider name,
    // matching the historical error surface relied on by Story 35.2 tests.
    if (!socksProxy || typeof socksProxy !== 'string') {
      throw new Error(
        'SocksTransportProvider: socksProxy must be a non-empty string starting with "socks5h://" ' +
          '(socks5h:// is required to prevent DNS leaks -- the proxy, not the local resolver, ' +
          'must resolve target hostnames)'
      );
    }

    let host: string;
    let port: number;
    try {
      const parsed = parseSocks5hUrl(socksProxy);
      host = parsed.host;
      port = parsed.port;
    } catch (err) {
      throw new Error(
        `SocksTransportProvider: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!externalUrl || typeof externalUrl !== 'string') {
      throw new Error('SocksTransportProvider: externalUrl must be a non-empty string');
    }

    this._socksProxy = socksProxy;
    this._externalUrl = externalUrl;
    this._proxyHost = host;
    this._proxyPort = port;
    this._logger = logger.child({ component: 'socks-transport-provider' });
    this._managedClient = managedClient;
    this._resolveExternalUrlOnStart = resolveExternalUrlOnStart;
  }

  /**
   * Create a new `SocksProxyAgent` for the given peer URL. Synchronous -- no
   * network I/O happens here; the actual connect occurs when the `ws`
   * WebSocket client opens the socket. A fresh agent is returned on every
   * call (no shared per-peer state).
   *
   * @param peerUrl - WebSocket URL of the peer (may be a `.anon` address -- NOT logged at INFO+).
   * @returns A new `SocksProxyAgent` compatible with the `ws` library's `agent` option.
   */
  createAgent(peerUrl: string): http.Agent {
    // DEBUG only -- peerUrl may be a .anon address and must not surface at INFO+.
    this._logger.debug({ event: 'socks_create_agent', peerUrl }, 'Creating SOCKS5 agent for peer');
    return new SocksProxyAgent(this._socksProxy);
  }

  /** @returns The externally reachable (typically `.anon`) URL for this node. */
  getExternalUrl(): string {
    return this._externalUrl;
  }

  /**
   * Probe the configured SOCKS5 proxy for TCP reachability. FAIL CLOSED --
   * throws if the proxy port is not listening. Does NOT perform a SOCKS5
   * handshake (that would require picking an arbitrary target and could
   * itself leak metadata).
   *
   * @returns Resolves when the proxy has been verified reachable.
   * @throws {Error} If the proxy host:port is unreachable within the probe timeout.
   */
  async start(): Promise<void> {
    // Story 35.5 AC #1 / T-35.5-11: if a managed client is supplied, boot it
    // BEFORE the TCP probe. The managed client is responsible for awaiting
    // SOCKS readiness itself; the probe below is belt-and-suspenders.
    if (this._managedClient) {
      await this._managedClient.start();
    }
    // Story 35.5 AC #8: resolve `externalUrl: 'auto'` AFTER the managed client
    // has started (so the hidden-service hostname file exists on disk) and
    // BEFORE the TCP probe. Fail-closed on any resolver error.
    if (this._resolveExternalUrlOnStart) {
      try {
        const resolved = await this._resolveExternalUrlOnStart();
        if (!resolved || typeof resolved !== 'string') {
          throw new Error('resolver returned a non-string value');
        }
        if (!resolved.startsWith('ws://') && !resolved.startsWith('wss://')) {
          throw new Error('resolved externalUrl must start with ws:// or wss://');
        }
        this._externalUrl = resolved;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `SocksTransportProvider: failed to resolve externalUrl from managed hidden service (${reason})`
        );
      }
    }
    try {
      await this._probeProxy(START_PROBE_TIMEOUT_MS);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `SocksTransportProvider: SOCKS5 proxy unreachable at ${this._proxyHost}:${this._proxyPort} (${reason})`
      );
    }
    this._managedHealthy = true;
    this._logger.info(
      { event: 'socks_transport_started', proxyHost: this._proxyHost, proxyPort: this._proxyPort },
      'SOCKS5 transport started'
    );
  }

  /**
   * Stop the provider. No-op in the non-managed (external proxy) mode used
   * by this story -- binary lifecycle is Story 35.5.
   *
   * @returns Resolves immediately after marking the provider stopped.
   */
  async stop(): Promise<void> {
    this._logger.info({ event: 'socks_transport_stopped' }, 'SOCKS5 transport stopped');
    // Story 35.5 AC #2: after the no-op log, chain the managed client
    // teardown. The managed client.stop() is idempotent and never throws.
    if (this._managedClient) {
      await this._managedClient.stop();
    }
  }

  /**
   * Check SOCKS5 proxy reachability. Never throws -- returns `false` on any
   * connectivity failure so the health endpoint stays responsive.
   *
   * @returns `true` if the proxy port is reachable, `false` otherwise.
   */
  async healthCheck(): Promise<boolean> {
    // Story 35.5 AC #5: when a managed client is present, require BOTH the
    // managed health signal AND the TCP probe to succeed. Never throw (Story
    // 35.2 AC #6 invariant). Emit a single WARN on the healthy->unhealthy
    // transition with event="managed_anon_crash_detected" (no `.anon` fields).
    let managedOk = true;
    if (this._managedClient) {
      try {
        managedOk = await this._managedClient.healthCheck();
      } catch {
        managedOk = false;
      }
      if (!managedOk && this._managedHealthy) {
        this._managedHealthy = false;
        this._logger.warn(
          {
            // Spec-required event name (AC #5 / Task 2.5). The inner
            // ManagedAnonClient also emits the same event name on its own
            // crash detection — operators relying on log counts should filter
            // on `component` to disambiguate source.
            event: 'managed_anon_crash_detected',
            proxyHost: this._proxyHost,
            proxyPort: this._proxyPort,
          },
          'Managed anon client reports not running'
        );
      } else if (managedOk) {
        this._managedHealthy = true;
      }
    }

    try {
      await this._probeProxy(HEALTH_PROBE_TIMEOUT_MS);
      if (!managedOk) {
        return false;
      }
      this._logger.debug(
        {
          event: 'socks_transport_health_ok',
          proxyHost: this._proxyHost,
          proxyPort: this._proxyPort,
        },
        'SOCKS5 proxy healthy'
      );
      return true;
    } catch {
      this._logger.warn(
        {
          event: 'socks_transport_health_failed',
          proxyHost: this._proxyHost,
          proxyPort: this._proxyPort,
        },
        'SOCKS5 proxy health check failed'
      );
      return false;
    }
  }

  /**
   * Raw TCP probe against the configured proxy host:port. Resolves on
   * successful connect; rejects on error or timeout. The probe socket is
   * always destroyed before return.
   */
  private _probeProxy(timeoutMs: number): Promise<void> {
    return probeTcpPort(this._proxyHost, this._proxyPort, timeoutMs);
  }
}
