/**
 * Minimal anon/Tor control-port client for hidden-service descriptor readiness
 * (no new dependency).
 *
 * Speaks just enough of the Tor control protocol to learn when *our own* v3
 * hidden-service descriptor has been uploaded to an HSDir — the direct,
 * daemon-reported signal that the service is fetchable on the overlay. It is
 * used by {@link ManagedAnonClient} as the primary gate for reporting the
 * hostname as published, in preference to the indirect self-dial probe in
 * {@link socks5-connect} (which is retained only as a fallback for
 * environments where the control port is unavailable).
 *
 * Why hand-rolled rather than the SDK's own `Control` class: the same reasons
 * {@link socks5-connect} avoids the `socks` npm package. The control protocol
 * is a trivial CRLF line protocol; speaking it over raw `net` keeps the
 * connector decoupled from the optional `@anyone-protocol/anyone-client`
 * internals (which run their own persistent reader loops and log to the
 * console), keeps the address out of INFO+ logs, and is fully unit-testable
 * against an in-process fake control server — exactly as
 * {@link socks5-connect} is tested against a fake SOCKS proxy.
 *
 * Authentication: the SDK launches `anon` with a bare `ControlPort` line and no
 * `CookieAuthentication`/`HashedControlPassword`, i.e. null auth, and its own
 * `Control.authenticate()` sends `AUTHENTICATE ""`. We mirror that exactly.
 *
 * @module transport/hs-desc-monitor
 */

import net from 'net';

/** Failure reading the control port or authenticating to it. */
export class HsDescMonitorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HsDescMonitorError';
  }
}

/**
 * Normalise a hidden-service address for comparison: strip a trailing
 * `.anyone`/`.anon`/`.onion` TLD (the `hostname` file carries one; control-port
 * `HS_DESC` events carry the bare base32 address) and lower-case it.
 */
export function normalizeHsAddress(addr: string): string {
  return addr
    .trim()
    .replace(/\.(anyone|anon|onion)$/i, '')
    .toLowerCase();
}

/**
 * Connect to the anon control port, authenticate, subscribe to `HS_DESC`
 * events, and resolve once an `UPLOADED` event is seen for `address` — proving
 * the descriptor was published to at least one responsible HSDir and is
 * fetchable by remote clients.
 *
 * Never resolves on its own otherwise; rejects with {@link HsDescMonitorError}
 * on auth failure, socket error, the proxy closing the connection, the overall
 * `timeoutMs` elapsing, or `signal` aborting. The `address` is sent to the
 * control port but is deliberately never logged.
 *
 * @param opts.controlHost Control-port host (typically `127.0.0.1`).
 * @param opts.controlPort Control-port number (the SDK default is 9051).
 * @param opts.address     Our hidden-service address; TLD-insensitive match.
 * @param opts.timeoutMs   Max time to wait for the `UPLOADED` event.
 * @param opts.signal      Optional AbortSignal to cancel the wait (on teardown).
 * @returns Resolves once our descriptor is `UPLOADED`.
 */
export function waitForHsDescUpload(opts: {
  controlHost: string;
  controlPort: number;
  address: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  const { controlHost, controlPort, address, timeoutMs, signal } = opts;
  const wanted = normalizeHsAddress(address);

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HsDescMonitorError('HS_DESC monitor aborted before start'));
      return;
    }

    const socket = net.createConnection({ host: controlHost, port: controlPort });
    let settled = false;
    /** 0 = awaiting AUTHENTICATE reply, 1 = awaiting SETEVENTS reply, 2 = listening. */
    let phase = 0;
    let buf = '';

    const onAbort = (): void => done(new HsDescMonitorError('HS_DESC monitor aborted'));

    const cleanup = (): void => {
      if (signal) signal.removeEventListener('abort', onAbort);
      socket.removeAllListeners();
      socket.destroy();
    };
    const done = (err?: HsDescMonitorError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () =>
      done(new HsDescMonitorError('Timed out awaiting HS_DESC UPLOADED'))
    );
    socket.once('error', (err) =>
      done(new HsDescMonitorError(`Control-port socket error: ${err.message}`))
    );
    socket.once('close', () =>
      done(new HsDescMonitorError('Control port closed connection before HS_DESC UPLOADED'))
    );

    socket.once('connect', () => {
      // Null-auth, mirroring the SDK's own Control.authenticate().
      socket.write('AUTHENTICATE ""\r\n');
    });

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      // The control protocol is CRLF line-delimited. AUTHENTICATE/SETEVENTS
      // replies and HS_DESC events are all single-line, so a line splitter is
      // sufficient (we never subscribe to multi-line HS_DESC_CONTENT).
      let nl: number;
      while ((nl = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        handleLine(line);
        if (settled) return;
      }
    });

    const handleLine = (line: string): void => {
      if (phase === 0) {
        if (line.startsWith('250')) {
          phase = 1;
          socket.write('SETEVENTS HS_DESC\r\n');
        } else {
          done(new HsDescMonitorError(`AUTHENTICATE rejected by control port: ${line}`));
        }
        return;
      }
      if (phase === 1) {
        if (line.startsWith('250')) {
          phase = 2;
        } else {
          done(new HsDescMonitorError(`SETEVENTS HS_DESC rejected: ${line}`));
        }
        return;
      }
      // phase 2: async events arrive as `650 HS_DESC <Action> <HSAddress> ...`.
      if (!line.startsWith('650')) return;
      const parts = line.split(/\s+/);
      // parts: ['650', 'HS_DESC', '<Action>', '<HSAddress>', ...]
      if (parts[1] !== 'HS_DESC') return;
      if (parts[2] !== 'UPLOADED') return;
      const evAddr = parts[3];
      if (evAddr !== undefined && normalizeHsAddress(evAddr) === wanted) {
        done();
      }
    };
  });
}
