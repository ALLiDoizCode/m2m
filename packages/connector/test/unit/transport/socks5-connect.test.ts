/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { createServer, Server, Socket } from 'net';
import { socks5Connect, Socks5ConnectError } from '../../../src/transport/socks5-connect';

/**
 * Minimal in-process SOCKS5 server for these tests. Implements just the no-auth
 * CONNECT handshake and lets each test dictate the method byte and CONNECT
 * reply code (REP). Mirrors the philosophy of test/helpers/socks5-contract-fixture
 * (hand-rolled, no extra dependency).
 */
interface FakeProxy {
  port: number;
  /** The CONNECT request the server parsed, available after a dial. */
  lastRequest?: { atyp: number; host: string; port: number };
  close: () => Promise<void>;
}

function startFakeProxy(opts: {
  /** Method-selection byte to send back (0x00 = no-auth accepted, 0xFF = none). */
  method?: number;
  /** REP byte to send in the CONNECT reply (0x00 = success). */
  rep?: number;
  /** If true, accept then never reply (to exercise the timeout path). */
  hang?: boolean;
  /** If true, destroy the socket right after the greeting (early close). */
  closeAfterGreeting?: boolean;
  /** If true, send the CONNECT reply one byte at a time (exercise partial reads). */
  splitReply?: boolean;
}): Promise<FakeProxy> {
  const method = opts.method ?? 0x00;
  const rep = opts.rep ?? 0x00;
  const sockets = new Set<Socket>();
  const state: FakeProxy = { port: 0, close: async () => {} };

  return new Promise((resolve) => {
    const server: Server = createServer((sock: Socket) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      let buf = Buffer.alloc(0);
      let phase = 0;
      const connectReply = Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);

      sock.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (phase === 0) {
          // greeting: VER, NMETHODS, METHODS...
          if (buf.length < 2) return;
          const nmethods = buf[1];
          if (nmethods === undefined || buf.length < 2 + nmethods) return;
          buf = buf.subarray(2 + nmethods);
          phase = 1;
          if (opts.closeAfterGreeting) {
            sock.destroy();
            return;
          }
          sock.write(Buffer.from([0x05, method]));
          if (method !== 0x00) return; // client will bail; no CONNECT coming
        }
        if (phase === 1) {
          // CONNECT: VER, CMD, RSV, ATYP, [len, host], port
          if (buf.length < 5) return;
          const atyp = buf[3];
          if (atyp === undefined || atyp !== 0x03) return;
          const len = buf[4];
          if (len === undefined || buf.length < 5 + len + 2) return;
          const host = buf.subarray(5, 5 + len).toString('utf8');
          const portHi = buf[5 + len];
          const portLo = buf[5 + len + 1];
          if (portHi === undefined || portLo === undefined) return;
          const port = (portHi << 8) | portLo;
          state.lastRequest = { atyp, host, port };
          if (opts.hang) return;
          if (opts.splitReply) {
            // Deliver the reply header across two chunks to exercise the
            // client's buffer accumulation across partial reads.
            sock.write(connectReply.subarray(0, 1));
            setTimeout(() => sock.write(connectReply.subarray(1)), 10);
          } else {
            sock.write(connectReply);
          }
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      state.port = typeof addr === 'object' && addr ? addr.port : 0;
      state.close = () =>
        new Promise<void>((res) => {
          for (const s of sockets) s.destroy();
          server.close(() => res());
        });
      resolve(state);
    });
  });
}

describe('socks5Connect', () => {
  it('resolves on a successful CONNECT reply (REP=0x00) and sends the target as ATYP=DOMAIN', async () => {
    const proxy = await startFakeProxy({ rep: 0x00 });
    await expect(
      socks5Connect({
        socksHost: '127.0.0.1',
        socksPort: proxy.port,
        destHost: 'abc.anyone',
        destPort: 3000,
        timeoutMs: 2000,
      })
    ).resolves.toBeUndefined();
    expect(proxy.lastRequest).toEqual({ atyp: 0x03, host: 'abc.anyone', port: 3000 });
    await proxy.close();
  });

  it('rejects with the REP code when the proxy rejects the connection (REP=0x01)', async () => {
    const proxy = await startFakeProxy({ rep: 0x01 });
    const err = await socks5Connect({
      socksHost: '127.0.0.1',
      socksPort: proxy.port,
      destHost: 'missing.anyone',
      destPort: 3000,
      timeoutMs: 2000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Socks5ConnectError);
    expect((err as Socks5ConnectError).replyCode).toBe(0x01);
    expect((err as Error).message).toMatch(/rejected connection/i);
    await proxy.close();
  });

  it('rejects when no auth method is acceptable (method=0xFF)', async () => {
    const proxy = await startFakeProxy({ method: 0xff });
    await expect(
      socks5Connect({
        socksHost: '127.0.0.1',
        socksPort: proxy.port,
        destHost: 'abc.anyone',
        destPort: 3000,
        timeoutMs: 2000,
      })
    ).rejects.toThrow(/method-selection failed/i);
    await proxy.close();
  });

  it('handles a CONNECT reply split across multiple TCP chunks', async () => {
    const proxy = await startFakeProxy({ rep: 0x00, splitReply: true });
    await expect(
      socks5Connect({
        socksHost: '127.0.0.1',
        socksPort: proxy.port,
        destHost: 'abc.anyone',
        destPort: 7100,
        timeoutMs: 2000,
      })
    ).resolves.toBeUndefined();
    await proxy.close();
  });

  it('rejects on timeout when the proxy never replies', async () => {
    const proxy = await startFakeProxy({ hang: true });
    await expect(
      socks5Connect({
        socksHost: '127.0.0.1',
        socksPort: proxy.port,
        destHost: 'abc.anyone',
        destPort: 3000,
        timeoutMs: 150,
      })
    ).rejects.toThrow(/timed out/i);
    await proxy.close();
  });

  it('rejects when the proxy closes before replying', async () => {
    const proxy = await startFakeProxy({ closeAfterGreeting: true });
    await expect(
      socks5Connect({
        socksHost: '127.0.0.1',
        socksPort: proxy.port,
        destHost: 'abc.anyone',
        destPort: 3000,
        timeoutMs: 2000,
      })
    ).rejects.toThrow(/closed connection|socket error/i);
    await proxy.close();
  });

  it('validates destHost and destPort bounds', async () => {
    await expect(
      socks5Connect({
        socksHost: '127.0.0.1',
        socksPort: 1,
        destHost: '',
        destPort: 3000,
        timeoutMs: 100,
      })
    ).rejects.toThrow(/DOMAIN range/i);
    await expect(
      socks5Connect({
        socksHost: '127.0.0.1',
        socksPort: 1,
        destHost: 'a.anyone',
        destPort: 0,
        timeoutMs: 100,
      })
    ).rejects.toThrow(/out of range/i);
  });
});
