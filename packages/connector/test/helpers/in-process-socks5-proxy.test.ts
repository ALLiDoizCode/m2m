/**
 * Unit tests for the in-process SOCKS5 proxy test helper (Story 35.6 Task 2.5).
 *
 * Uses raw SOCKS5 framing (RFC 1928) rather than an npm client so the helper
 * is tested end-to-end without adding dev-deps.
 */

import * as net from 'net';
import { startSocks5Proxy } from './in-process-socks5-proxy';

async function startEchoServer(): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.on('data', (d) => socket.write(d));
    socket.on('error', () => void 0);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('unexpected addr');
  return {
    port: addr.port,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Connect to the SOCKS5 proxy and complete the greeting + CONNECT handshake. */
async function socksConnect(
  proxyPort: number,
  destHost: string,
  destPort: number,
  useDomainAtyp = false
): Promise<net.Socket> {
  const sock = net.connect({ host: '127.0.0.1', port: proxyPort });
  await new Promise<void>((resolve, reject) => {
    sock.once('error', reject);
    sock.once('connect', () => resolve());
  });
  // Greeting: VER=5, NMETHODS=1, METHOD=0 (no auth)
  sock.write(Buffer.from([0x05, 0x01, 0x00]));
  await readN(sock, 2); // [5, 0]

  // Request
  let req: Buffer;
  if (useDomainAtyp) {
    const host = Buffer.from(destHost, 'utf8');
    req = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
      host,
      Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff]),
    ]);
  } else {
    const parts = destHost.split('.').map((p) => Number.parseInt(p, 10));
    req = Buffer.from([
      0x05,
      0x01,
      0x00,
      0x01,
      parts[0]!,
      parts[1]!,
      parts[2]!,
      parts[3]!,
      (destPort >> 8) & 0xff,
      destPort & 0xff,
    ]);
  }
  sock.write(req);
  const resp = await readN(sock, 10);
  if (resp[1] !== 0x00) {
    sock.destroy();
    throw new Error(`SOCKS5 CONNECT failed, REP=${resp[1]}`);
  }
  return sock;
}

function readN(sock: net.Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let have = 0;
    const onData = (d: Buffer): void => {
      chunks.push(d);
      have += d.length;
      if (have >= n) {
        sock.off('data', onData);
        sock.off('error', onErr);
        const full = Buffer.concat(chunks);
        // Push back any over-read bytes so subsequent reads see them.
        if (full.length > n) sock.unshift(full.subarray(n));
        resolve(full.subarray(0, n));
      }
    };
    const onErr = (e: Error): void => {
      sock.off('data', onData);
      reject(e);
    };
    sock.on('data', onData);
    sock.once('error', onErr);
  });
}

describe('in-process SOCKS5 proxy helper', () => {
  it('tunnels bytes through a CONNECT by IPv4 ATYP', async () => {
    const echo = await startEchoServer();
    const proxy = await startSocks5Proxy();
    try {
      const sock = await socksConnect(proxy.port, '127.0.0.1', echo.port);
      const received = new Promise<Buffer>((resolve) => sock.once('data', (d) => resolve(d)));
      sock.write('hello');
      const data = await received;
      expect(data.toString()).toBe('hello');
      sock.destroy();
      expect(proxy.connects).toHaveLength(1);
      expect(proxy.connects[0]?.atyp).toBe(1);
      expect(proxy.connects[0]?.destHost).toBe('127.0.0.1');
      expect(proxy.connects[0]?.destPort).toBe(echo.port);
    } finally {
      await proxy.stop();
      await echo.stop();
    }
  });

  it('records ATYP=DOMAIN when client uses hostname addressing (via onResolve hook)', async () => {
    const echo = await startEchoServer();
    const proxy = await startSocks5Proxy({
      onResolve: (_host, cb) => cb(null, '127.0.0.1', 4),
    });
    try {
      const sock = await socksConnect(proxy.port, 'peer.test.invalid', echo.port, true);
      sock.destroy();
      expect(proxy.connects).toHaveLength(1);
      expect(proxy.connects[0]?.atyp).toBe(3);
      expect(proxy.connects[0]?.destHost).toBe('peer.test.invalid');
    } finally {
      await proxy.stop();
      await echo.stop();
    }
  });
});
