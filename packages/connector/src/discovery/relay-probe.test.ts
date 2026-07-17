/**
 * Tests for the minimal kind:10032 relay probe (toon-meta#153).
 *
 * Each test runs the REAL probe against a REAL in-process `ws` WebSocket
 * server (no mocks) scripted to exercise one NIP-01 verdict path: a
 * signature-valid kind:10032 `EVENT` (`detail: 'event'`), an `EOSE`
 * (`detail: 'eose'`), invalid/foreign/non-JSON frames that must be ignored,
 * and the failure modes (timeout, connection refused, close, bad URL) that
 * must resolve `{ ok: false }` without ever rejecting.
 *
 * @module discovery/relay-probe.test
 */

import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { generateSecretKey, finalizeEvent, type NostrEvent } from 'nostr-tools';
import { createKind10032RelayProbe, BOOTSTRAP_PROBE_SUB_ID } from './relay-probe';
import { ILP_PEER_INFO_KIND } from './ilp-peer-info-event';
import { createLogger } from '../utils/logger';

const logger = createLogger('relay-probe-test', 'silent');

/** Builds a signature-valid kind:10032 event. */
function buildValidPeerInfoEvent(): NostrEvent {
  return finalizeEvent(
    {
      kind: ILP_PEER_INFO_KIND,
      content: JSON.stringify({
        ilpAddress: 'g.probe.peer',
        btpEndpoint: 'wss://peer.example.com:443',
        assetCode: 'USDC',
        assetScale: 6,
      }),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    generateSecretKey()
  );
}

/**
 * Starts an in-process relay whose behavior per connection is given by
 * `onConnection`. Returns its ws:// URL and a teardown fn.
 */
async function startRelay(
  onConnection: (socket: WsSocket) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = new WebSocketServer({ port: 0 });
  server.on('connection', onConnection);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('WebSocketServer did not bind to a TCP port');
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of server.clients) {
          client.terminate();
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe('createKind10032RelayProbe', () => {
  const probe = createKind10032RelayProbe(logger);

  it('verifies a relay that answers the REQ with a signature-valid kind:10032 EVENT', async () => {
    const relay = await startRelay((socket) => {
      socket.on('message', (data) => {
        const [type, subId] = JSON.parse(String(data)) as [string, string];
        expect(type).toBe('REQ');
        expect(subId).toBe(BOOTSTRAP_PROBE_SUB_ID);
        socket.send(JSON.stringify(['EVENT', subId, buildValidPeerInfoEvent()]));
      });
    });
    try {
      await expect(probe(relay.url, 2000)).resolves.toEqual({ ok: true, detail: 'event' });
    } finally {
      await relay.close();
    }
  });

  it('verifies an empty but protocol-conformant relay via EOSE', async () => {
    const relay = await startRelay((socket) => {
      socket.on('message', () => {
        socket.send(JSON.stringify(['EOSE', BOOTSTRAP_PROBE_SUB_ID]));
      });
    });
    try {
      await expect(probe(relay.url, 2000)).resolves.toEqual({ ok: true, detail: 'eose' });
    } finally {
      await relay.close();
    }
  });

  it('ignores non-JSON frames, foreign-sub frames, and invalid events, then accepts EOSE', async () => {
    const relay = await startRelay((socket) => {
      socket.on('message', () => {
        // Non-JSON frame: must be ignored.
        socket.send('not json at all');
        // Frame for a different subscription: must be ignored.
        socket.send(JSON.stringify(['EVENT', 'someone-elses-sub', buildValidPeerInfoEvent()]));
        // Wrong kind: fails the structural check.
        const wrongKind = { ...buildValidPeerInfoEvent(), kind: 1 };
        socket.send(JSON.stringify(['EVENT', BOOTSTRAP_PROBE_SUB_ID, wrongKind]));
        // Right kind but broken signature: fails verifyEvent.
        const badSig = { ...buildValidPeerInfoEvent(), sig: 'ff'.repeat(64) };
        socket.send(JSON.stringify(['EVENT', BOOTSTRAP_PROBE_SUB_ID, badSig]));
        // Non-object payload: fails the structural check.
        socket.send(JSON.stringify(['EVENT', BOOTSTRAP_PROBE_SUB_ID, null]));
        // Finally a conformant EOSE decides the verdict.
        socket.send(JSON.stringify(['EOSE', BOOTSTRAP_PROBE_SUB_ID]));
      });
    });
    try {
      await expect(probe(relay.url, 2000)).resolves.toEqual({ ok: true, detail: 'eose' });
    } finally {
      await relay.close();
    }
  });

  it('fails with detail "timeout" when the relay never answers', async () => {
    const relay = await startRelay(() => {
      // Accept the connection and say nothing.
    });
    try {
      await expect(probe(relay.url, 200)).resolves.toEqual({ ok: false, detail: 'timeout' });
    } finally {
      await relay.close();
    }
  });

  it('fails with detail "closed" when the relay hangs up before answering', async () => {
    const relay = await startRelay((socket) => {
      socket.on('message', () => socket.close());
    });
    try {
      const result = await probe(relay.url, 2000);
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('closed');
    } finally {
      await relay.close();
    }
  });

  it('fails (never rejects) when nothing listens on the port', async () => {
    // Bind-then-close to get a port that is definitely unoccupied.
    const relay = await startRelay(() => undefined);
    await relay.close();
    const result = await probe(relay.url, 2000);
    expect(result.ok).toBe(false);
    expect(typeof result.detail).toBe('string');
  });

  it('fails (never rejects) on a URL the WebSocket constructor rejects', async () => {
    const result = await probe('http://not-a-ws-url.example', 500);
    expect(result.ok).toBe(false);
    expect(typeof result.detail).toBe('string');
  });
});
