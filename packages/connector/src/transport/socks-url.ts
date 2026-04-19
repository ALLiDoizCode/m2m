/**
 * Shared SOCKS5 URL parsing helper (Epic 35 / Story 35.5).
 *
 * Extracted from `SocksTransportProvider` constructor so that
 * `ManagedAnonClient` can reuse the exact same parsing/validation logic
 * without duplicating code.
 *
 * @module transport/socks-url
 */

/**
 * Parsed SOCKS5 proxy URL components.
 */
export interface ParsedSocks5Url {
  /** Proxy host (e.g., `127.0.0.1`). */
  host: string;
  /** Proxy port (1..65535). */
  port: number;
}

/**
 * Parse a `socks5h://host:port` URL.
 *
 * Security invariant: only `socks5h://` scheme is accepted. `socks5://`
 * resolves DNS locally and would leak `.anon` destinations -- reject it.
 *
 * @param socksProxy - URL string (must start with `socks5h://`).
 * @returns Parsed host/port.
 * @throws {Error} On any validation failure.
 */
export function parseSocks5hUrl(socksProxy: string): ParsedSocks5Url {
  if (!socksProxy || typeof socksProxy !== 'string') {
    throw new Error(
      'socksProxy must be a non-empty string starting with "socks5h://" ' +
        '(socks5h:// is required to prevent DNS leaks -- the proxy, not the local resolver, ' +
        'must resolve target hostnames)'
    );
  }

  if (!socksProxy.startsWith('socks5h://')) {
    throw new Error(
      `socksProxy scheme must be "socks5h://" (got "${socksProxy.split('://')[0]}://"). ` +
        'The "h" suffix is required to prevent DNS leaks: with socks5h, hostname resolution ' +
        'happens at the proxy (Tor exit / ATOR), not on the local host.'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(socksProxy.replace(/^socks5h:\/\//, 'http://'));
  } catch {
    throw new Error(`socksProxy is not a valid URL (expected socks5h://host:port)`);
  }

  const host = parsed.hostname;
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : NaN;
  if (!host || !Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(
      'socksProxy must include a valid host and port (e.g., socks5h://127.0.0.1:9050)'
    );
  }

  return { host, port };
}
