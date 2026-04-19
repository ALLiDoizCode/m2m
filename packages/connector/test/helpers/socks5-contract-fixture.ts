/**
 * SOCKS5 protocol contract test, NOT ATOR integration — see
 * transport-ator-real-binary.test.ts for real-binary coverage.
 *
 * Minimal in-process SOCKS5 proxy for tests (originally Epic 35 / Story 35.6;
 * renamed in Epic 36 / Story 36.3 to make the scope explicit vs the new
 * real-binary integration suite).
 *
 * Implements just enough of RFC 1928 to let integration tests tunnel BTP
 * WebSocket traffic through a controllable proxy without installing any new
 * npm dev dependency. Supports:
 *
 *   - METHOD=0x00 (no authentication)
 *   - CMD=0x01 (CONNECT)
 *   - ATYP=0x01 (IPv4) / 0x03 (DOMAINNAME) / 0x04 (IPv6)
 *
 * Does NOT support UDP ASSOCIATE, BIND, or any authentication method beyond
 * no-auth. If a future story needs more, extend this helper then.
 *
 * Design rationale (Story 35.6 Task 2.4): a ~150-line hand-rolled helper is
 * cheaper than adding `socks`/`socksv5` as a dev-dep and going through audit
 * + approval for a test-only helper. The helper also exposes an `onResolve`
 * hook so the DNS-leak test (T-35.6-SEC-01) can assert that the ATOR-side
 * DNS-resolution path is exercised with a non-resolvable hostname.
 *
 * @module test/helpers/socks5-contract-fixture
 */

import { createServer, Server, Socket, connect as netConnect } from 'net';
import * as dns from 'dns';

/**
 * Record of a single SOCKS5 CONNECT request observed by the proxy.
 */
export interface ProxyConnectRecord {
  /** SOCKS5 ATYP value -- 1 = IPv4, 3 = DOMAIN, 4 = IPv6. */
  atyp: number;
  /** Destination host as sent by the client (dotted IP or hostname). */
  destHost: string;
  /** Destination port (1..65535). */
  destPort: number;
}

export interface StartOpts {
  /** Listen port (default: 0 = ephemeral). */
  port?: number;
  /**
   * Optional DNS resolver override for ATYP=DOMAIN requests. Invoked instead
   * of `dns.lookup`. Allows tests to hermetically redirect all hostnames to
   * a known IP without patching globals.
   */
  onResolve?: (
    host: string,
    cb: (err: Error | null, addr?: string, family?: 4 | 6) => void
  ) => void;
}

export interface RunningProxy {
  /** Bound port (useful when opts.port was 0). */
  port: number;
  /** Accumulated CONNECT records (chronological order). */
  connects: ProxyConnectRecord[];
  /**
   * Force-close the server AND destroy every active tunneled socket (both
   * sides). This is the abrupt-RST behavior T-35.6-INT-03 needs to simulate
   * a proxy dying mid-session.
   */
  stop: () => Promise<void>;
}

/**
 * Start an in-process SOCKS5 proxy listening on 127.0.0.1.
 */
export async function startSocks5Proxy(opts: StartOpts = {}): Promise<RunningProxy> {
  const connects: ProxyConnectRecord[] = [];
  const activeSockets = new Set<Socket>();

  const server: Server = createServer((client) => {
    activeSockets.add(client);
    client.on('error', () => {
      /* swallow -- test traffic is best-effort */
    });
    client.on('close', () => activeSockets.delete(client));

    // State machine: 0 = awaiting greeting, 1 = awaiting request,
    //                1.5 = request parsed, tunnel establishing (async),
    //                2 = tunneled (pipes engaged).
    //
    // The 1.5 intermediate state matters: `netConnect` / `dns.lookup` are
    // async, so between finishing the SOCKS request parse and the upstream
    // connect callback firing we MUST ignore any additional client data. If
    // we did not, a duplicate `connects` record could be pushed and state
    // would be re-entered. (A real client never pipelines payload before
    // seeing the REP=0 reply, but the helper is a test fixture and must be
    // robust to framing quirks regardless.)
    let state: 0 | 1 | 1.5 | 2 = 0;
    let buf = Buffer.alloc(0);

    client.on('data', (chunk) => {
      if (state === 1.5 || state === 2) return; // tunnel owns the bytes
      buf = Buffer.concat([buf, chunk]);

      // Greeting: [VER=5, NMETHODS, METHOD...]
      if (state === 0) {
        if (buf.length < 2) return;
        const nmethods = buf[1] as number;
        if (buf.length < 2 + nmethods) return;
        // Reply with no-auth selected.
        client.write(Buffer.from([0x05, 0x00]));
        buf = buf.subarray(2 + nmethods);
        state = 1;
      }

      // Request: [VER=5, CMD=1, RSV=0, ATYP, ADDR, PORT(u16 BE)]
      if (state === 1) {
        if (buf.length < 4) return;
        const ver = buf[0];
        const cmd = buf[1];
        const atyp = buf[3];
        if (ver !== 0x05 || cmd !== 0x01) {
          // Only CONNECT is supported. Reject with REP=0x07 (command not supported).
          client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
          client.end();
          return;
        }

        let destHost: string;
        let headerLen: number;
        if (atyp === 0x01) {
          if (buf.length < 4 + 4 + 2) return;
          destHost = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
          headerLen = 4 + 4 + 2;
        } else if (atyp === 0x03) {
          if (buf.length < 4 + 1) return;
          const hlen = buf[4] as number;
          if (buf.length < 4 + 1 + hlen + 2) return;
          destHost = buf.subarray(5, 5 + hlen).toString('utf8');
          headerLen = 4 + 1 + hlen + 2;
        } else if (atyp === 0x04) {
          if (buf.length < 4 + 16 + 2) return;
          // Raw 16-byte IPv6 as hex pairs (good enough for tests)
          const parts: string[] = [];
          for (let i = 0; i < 8; i++) {
            parts.push(buf.readUInt16BE(4 + i * 2).toString(16));
          }
          destHost = parts.join(':');
          headerLen = 4 + 16 + 2;
        } else {
          // Unknown ATYP -- REP=0x08 address type not supported.
          client.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
          client.end();
          return;
        }
        const destPort = buf.readUInt16BE(headerLen - 2);
        connects.push({ atyp, destHost, destPort });
        // Consume the parsed request bytes and advance to the intermediate
        // "establishing" state so any further client data during the async
        // resolve/connect is not re-parsed as a second request.
        buf = buf.subarray(headerLen);
        state = 1.5;

        const establishTunnel = (ipAddr: string): void => {
          const upstream = netConnect({ host: ipAddr, port: destPort }, () => {
            // REP=0x00 success; BND fields zeroed (clients don't need them).
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
            state = 2;
            client.pipe(upstream);
            upstream.pipe(client);
          });
          activeSockets.add(upstream);
          upstream.on('error', () => {
            client.destroy();
          });
          upstream.on('close', () => {
            activeSockets.delete(upstream);
            client.destroy();
          });
        };

        if (atyp === 0x03) {
          const resolver = opts.onResolve ?? dns.lookup;
          resolver(destHost, (err, addr) => {
            if (err || !addr) {
              client.write(
                Buffer.from([0x05, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
              );
              client.end();
              return;
            }
            establishTunnel(addr);
          });
        } else {
          establishTunnel(destHost);
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('startSocks5Proxy: unexpected server address shape');
  }
  const boundPort = addr.port;

  return {
    port: boundPort,
    connects,
    stop: async () => {
      // Close server to new connections, then force-destroy active sockets
      // so mid-session failure tests see abrupt RST behavior.
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of activeSockets) s.destroy();
        activeSockets.clear();
      });
    },
  };
}
