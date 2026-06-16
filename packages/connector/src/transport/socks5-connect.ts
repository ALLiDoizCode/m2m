/**
 * Minimal SOCKS5 CONNECT probe (no new dependency).
 *
 * Performs just enough of RFC 1928 (no-auth method, CMD=CONNECT, ATYP=DOMAIN)
 * to verify that a target host:port is reachable *through* a SOCKS5 proxy. It
 * is used by {@link ManagedAnonClient} to self-dial the connector's own
 * `.anyone` hidden service before reporting it as published — proving the v3
 * descriptor is actually fetchable on the overlay network, not merely that the
 * local `hostname` file exists.
 *
 * Why hand-rolled rather than the `socks` npm package: the test suite already
 * hand-rolls a SOCKS5 fixture for exactly this reason (avoid an extra runtime
 * dependency + audit). This mirrors the raw-`net` approach in
 * {@link probe-tcp-port}. We deliberately implement only the no-auth CONNECT
 * path with a DOMAINNAME target so the proxy resolves the `.anyone` name
 * (no client-side DNS leak).
 *
 * @module transport/socks5-connect
 */

import net from 'net';

/** SOCKS5 reply code (REP field) returned by the proxy on a CONNECT reply. */
export class Socks5ConnectError extends Error {
  /** The RFC 1928 REP byte, or -1 when the failure was not a CONNECT reply. */
  readonly replyCode: number;
  constructor(message: string, replyCode: number) {
    super(message);
    this.name = 'Socks5ConnectError';
    this.replyCode = replyCode;
  }
}

/**
 * Open a SOCKS5 (no-auth) CONNECT tunnel to `destHost:destPort` via the proxy
 * at `socksHost:socksPort`, then immediately close it. The connection is never
 * used to carry data — a successful CONNECT reply (REP=0x00) is the entire
 * signal we want: it means the proxy reached the destination (for a `.anyone`
 * target, that the hidden-service descriptor was fetched and a rendezvous was
 * established).
 *
 * @param opts.socksHost   Proxy host (typically `127.0.0.1`).
 * @param opts.socksPort   Proxy SOCKS5 port.
 * @param opts.destHost    Destination hostname, sent as ATYP=DOMAIN so the
 *                         proxy resolves it (1..255 bytes once UTF-8 encoded).
 * @param opts.destPort    Destination port (1..65535).
 * @param opts.timeoutMs   Max time for the whole greeting+connect exchange.
 * @returns Resolves on REP=0x00. Rejects with {@link Socks5ConnectError} on a
 *          non-zero REP, malformed reply, socket error, or timeout.
 */
export function socks5Connect(opts: {
  socksHost: string;
  socksPort: number;
  destHost: string;
  destPort: number;
  timeoutMs: number;
}): Promise<void> {
  const { socksHost, socksPort, destHost, destPort, timeoutMs } = opts;

  return new Promise<void>((resolve, reject) => {
    const hostBytes = Buffer.from(destHost, 'utf8');
    if (hostBytes.length < 1 || hostBytes.length > 255) {
      reject(
        new Socks5ConnectError(`destHost length ${hostBytes.length} out of SOCKS5 DOMAIN range`, -1)
      );
      return;
    }
    if (!Number.isInteger(destPort) || destPort < 1 || destPort > 65535) {
      reject(new Socks5ConnectError(`destPort ${destPort} out of range`, -1));
      return;
    }

    const socket = net.createConnection({ host: socksHost, port: socksPort });
    let settled = false;
    /** 0 = awaiting method-selection reply, 1 = awaiting CONNECT reply. */
    let phase = 0;
    let buf = Buffer.alloc(0);

    const cleanup = (): void => {
      socket.removeAllListeners();
      socket.destroy();
    };
    const done = (err?: Socks5ConnectError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => done(new Socks5ConnectError('SOCKS5 connect timed out', -1)));
    socket.once('error', (err) =>
      done(new Socks5ConnectError(`SOCKS5 socket error: ${err.message}`, -1))
    );
    socket.once('close', () =>
      done(new Socks5ConnectError('SOCKS5 proxy closed connection before reply', -1))
    );

    socket.once('connect', () => {
      // Greeting: VER=5, NMETHODS=1, METHODS=[0x00 no-auth].
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      if (phase === 0) {
        if (buf.length < 2) return;
        const ver = buf[0];
        const method = buf[1];
        if (ver !== 0x05 || method !== 0x00) {
          done(
            new Socks5ConnectError(
              `SOCKS5 method-selection failed (ver=${ver}, method=${method})`,
              -1
            )
          );
          return;
        }
        buf = buf.subarray(2);
        phase = 1;
        // CONNECT: VER=5, CMD=1 (connect), RSV=0, ATYP=3 (domain), LEN, host, port.
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
          hostBytes,
          Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff]),
        ]);
        socket.write(req);
        // fall through in case the reply was coalesced with the greeting reply
      }

      if (phase === 1) {
        // Reply header: VER, REP, RSV, ATYP, ... We only need the first 2 bytes.
        if (buf.length < 2) return;
        const rep = buf[1];
        if (rep === undefined) return;
        if (rep === 0x00) {
          done();
        } else {
          done(
            new Socks5ConnectError(
              `SOCKS5 proxy rejected connection (REP=0x${rep.toString(16).padStart(2, '0')})`,
              rep
            )
          );
        }
      }
    });
  });
}
