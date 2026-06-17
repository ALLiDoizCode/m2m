/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

/**
 * Unit tests for the dependency-free anon control-port `HS_DESC` monitor used
 * as the primary hidden-service reachability signal. Exercised against an
 * in-process fake control server (mirrors the fake-SOCKS-proxy approach of
 * socks5-connect.test.ts) so no real `anon` binary is required.
 */

import { createServer, Server, Socket } from 'net';
import {
  waitForHsDescUpload,
  HsDescMonitorError,
  normalizeHsAddress,
} from '../../../src/transport/hs-desc-monitor';

interface FakeControl {
  port: number;
  /** Raw command lines the server received (AUTHENTICATE, SETEVENTS, ...). */
  commands: string[];
  close: () => Promise<void>;
}

/**
 * Minimal fake anon control port. Replies `250 OK` to AUTHENTICATE and
 * SETEVENTS (unless configured to reject auth), then emits the configured
 * `HS_DESC` event line(s) once subscribed.
 */
function startFakeControl(opts: {
  /** Reply to AUTHENTICATE: true → `250 OK`, false → `515 Bad authentication`. */
  authOk?: boolean;
  /** Event line(s) to emit after SETEVENTS, without the trailing CRLF. */
  events?: string[];
  /** Emit each event one byte at a time to exercise partial reads. */
  splitEvents?: boolean;
  /** Destroy the socket right after SETEVENTS instead of emitting events. */
  closeAfterSubscribe?: boolean;
  /** Never reply at all (exercise the timeout path). */
  silent?: boolean;
}): Promise<FakeControl> {
  const authOk = opts.authOk ?? true;
  const sockets = new Set<Socket>();
  const state: FakeControl = { port: 0, commands: [], close: async () => {} };

  return new Promise((resolve) => {
    const server: Server = createServer((sock: Socket) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      sock.setEncoding('utf8');
      let buf = '';

      const emitEvents = (): void => {
        for (const ev of opts.events ?? []) {
          const line = `${ev}\r\n`;
          if (opts.splitEvents) {
            for (const ch of line) sock.write(ch);
          } else {
            sock.write(line);
          }
        }
      };

      sock.on('data', (chunk: string) => {
        if (opts.silent) return;
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          state.commands.push(line);
          if (line.startsWith('AUTHENTICATE')) {
            sock.write(authOk ? '250 OK\r\n' : '515 Bad authentication\r\n');
            if (!authOk) sock.destroy();
          } else if (line.startsWith('SETEVENTS')) {
            sock.write('250 OK\r\n');
            if (opts.closeAfterSubscribe) {
              sock.destroy();
            } else {
              emitEvents();
            }
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

const ADDR = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwxy';

describe('normalizeHsAddress', () => {
  it('strips a trailing .anyone/.anon/.onion TLD and lower-cases', () => {
    expect(normalizeHsAddress(`${ADDR}.anyone`)).toBe(ADDR);
    expect(normalizeHsAddress(`${ADDR}.anon`)).toBe(ADDR);
    expect(normalizeHsAddress(`${ADDR.toUpperCase()}.onion`)).toBe(ADDR);
    expect(normalizeHsAddress(ADDR)).toBe(ADDR);
  });
});

describe('waitForHsDescUpload', () => {
  it('authenticates, subscribes to HS_DESC, and resolves on UPLOADED for our address', async () => {
    const control = await startFakeControl({
      events: [`650 HS_DESC UPLOADED ${ADDR} NO_AUTH $FINGERPRINT`],
    });
    await expect(
      waitForHsDescUpload({
        controlHost: '127.0.0.1',
        controlPort: control.port,
        address: `${ADDR}.anyone`,
        timeoutMs: 2000,
      })
    ).resolves.toBeUndefined();
    expect(control.commands).toEqual(['AUTHENTICATE ""', 'SETEVENTS HS_DESC']);
    await control.close();
  });

  it('ignores UPLOADED for a different address, then resolves when ours arrives', async () => {
    const control = await startFakeControl({
      events: [
        '650 HS_DESC UPLOADED someotheraddress NO_AUTH $FP',
        `650 HS_DESC UPLOADED ${ADDR} NO_AUTH $FP`,
      ],
    });
    await expect(
      waitForHsDescUpload({
        controlHost: '127.0.0.1',
        controlPort: control.port,
        address: ADDR,
        timeoutMs: 2000,
      })
    ).resolves.toBeUndefined();
    await control.close();
  });

  it('ignores non-UPLOADED actions for our address (REQUESTED/FAILED) and times out', async () => {
    const control = await startFakeControl({
      events: [
        `650 HS_DESC REQUESTED ${ADDR} NO_AUTH $FP`,
        `650 HS_DESC FAILED ${ADDR} NO_AUTH $FP REASON=NOT_FOUND`,
      ],
    });
    await expect(
      waitForHsDescUpload({
        controlHost: '127.0.0.1',
        controlPort: control.port,
        address: ADDR,
        timeoutMs: 200,
      })
    ).rejects.toThrow(/Timed out/i);
    await control.close();
  });

  it('handles an event split across TCP chunks', async () => {
    const control = await startFakeControl({
      events: [`650 HS_DESC UPLOADED ${ADDR} NO_AUTH $FP`],
      splitEvents: true,
    });
    await expect(
      waitForHsDescUpload({
        controlHost: '127.0.0.1',
        controlPort: control.port,
        address: ADDR,
        timeoutMs: 2000,
      })
    ).resolves.toBeUndefined();
    await control.close();
  });

  it('rejects when authentication is refused', async () => {
    const control = await startFakeControl({ authOk: false });
    await expect(
      waitForHsDescUpload({
        controlHost: '127.0.0.1',
        controlPort: control.port,
        address: ADDR,
        timeoutMs: 2000,
      })
    ).rejects.toThrow(/AUTHENTICATE rejected/i);
    await control.close();
  });

  it('rejects when the control port closes before the event', async () => {
    const control = await startFakeControl({ closeAfterSubscribe: true });
    await expect(
      waitForHsDescUpload({
        controlHost: '127.0.0.1',
        controlPort: control.port,
        address: ADDR,
        timeoutMs: 2000,
      })
    ).rejects.toThrow(/closed connection|socket error/i);
    await control.close();
  });

  it('rejects on timeout when the control port never replies', async () => {
    const control = await startFakeControl({ silent: true });
    await expect(
      waitForHsDescUpload({
        controlHost: '127.0.0.1',
        controlPort: control.port,
        address: ADDR,
        timeoutMs: 150,
      })
    ).rejects.toThrow(/Timed out/i);
    await control.close();
  });

  it('rejects promptly when the abort signal fires', async () => {
    const control = await startFakeControl({ silent: true });
    const ac = new AbortController();
    const p = waitForHsDescUpload({
      controlHost: '127.0.0.1',
      controlPort: control.port,
      address: ADDR,
      timeoutMs: 5000,
      signal: ac.signal,
    });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(HsDescMonitorError);
    await expect(p).rejects.toThrow(/aborted/i);
    await control.close();
  });
});
