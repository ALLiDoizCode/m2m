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
import net from 'net';
import type pino from 'pino';
import { SocksProxyAgent } from 'socks-proxy-agent';
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
  private readonly _externalUrl: string;
  private readonly _logger: pino.Logger;
  private readonly _proxyHost: string;
  private readonly _proxyPort: number;

  /**
   * @param options - Configuration options (see {@link SocksTransportProviderOptions}).
   * @throws {Error} If `socksProxy` is missing, has the wrong scheme, or is not parseable.
   * @throws {Error} If `externalUrl` is empty.
   */
  constructor(options: SocksTransportProviderOptions) {
    const { socksProxy, externalUrl, logger } = options;

    if (!socksProxy || typeof socksProxy !== 'string') {
      throw new Error(
        'SocksTransportProvider: socksProxy must be a non-empty string starting with "socks5h://" ' +
          '(socks5h:// is required to prevent DNS leaks -- the proxy, not the local resolver, ' +
          'must resolve target hostnames)'
      );
    }

    if (!socksProxy.startsWith('socks5h://')) {
      throw new Error(
        `SocksTransportProvider: socksProxy scheme must be "socks5h://" (got "${socksProxy.split('://')[0]}://"). ` +
          'The "h" suffix is required to prevent DNS leaks: with socks5h, hostname resolution ' +
          'happens at the proxy (Tor exit / ATOR), not on the local host.'
      );
    }

    let parsed: URL;
    try {
      // URL won't parse "socks5h://" natively -- swap to a parseable scheme for extraction only.
      parsed = new URL(socksProxy.replace(/^socks5h:\/\//, 'http://'));
    } catch {
      throw new Error(
        `SocksTransportProvider: socksProxy is not a valid URL (expected socks5h://host:port)`
      );
    }

    const host = parsed.hostname;
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : NaN;
    if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new Error(
        'SocksTransportProvider: socksProxy must include a valid host and port (e.g., socks5h://127.0.0.1:9050)'
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
    try {
      await this._probeProxy(START_PROBE_TIMEOUT_MS);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `SocksTransportProvider: SOCKS5 proxy unreachable at ${this._proxyHost}:${this._proxyPort} (${reason})`
      );
    }
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
  }

  /**
   * Check SOCKS5 proxy reachability. Never throws -- returns `false` on any
   * connectivity failure so the health endpoint stays responsive.
   *
   * @returns `true` if the proxy port is reachable, `false` otherwise.
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this._probeProxy(HEALTH_PROBE_TIMEOUT_MS);
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
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this._proxyHost, port: this._proxyPort });
      let settled = false;

      const cleanup = (): void => {
        socket.removeAllListeners();
        socket.destroy();
      };

      socket.setTimeout(timeoutMs);

      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      });

      socket.once('timeout', () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`probe timed out after ${timeoutMs}ms`));
      });

      socket.once('error', (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });
    });
  }
}
