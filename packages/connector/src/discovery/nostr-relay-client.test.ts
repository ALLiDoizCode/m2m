/**
 * Tests for the production SimplePool-backed relay READ client
 * (toon-meta#153).
 *
 * Runs the REAL `createNostrRelayClient` (nostr-tools `SimplePool` over
 * Node's global WebSocket) against a REAL in-process `ws` relay speaking
 * just enough NIP-01 to answer the client's REQ with a signed kind:10032
 * EVENT — no mocks and no external network. Verifies the subscribe path
 * delivers signature-valid events, that `close()`/`destroy()` are
 * idempotent, and that subscribing to an unreachable relay does not throw.
 *
 * @module discovery/nostr-relay-client.test
 */

import { WebSocketServer } from 'ws';
import { generateSecretKey, finalizeEvent, type NostrEvent } from 'nostr-tools';
import { createNostrRelayClient } from './nostr-relay-client';
import { ILP_PEER_INFO_KIND } from './ilp-peer-info-event';

/** Builds a signature-valid kind:10032 event (SimplePool drops invalid ones). */
function buildValidPeerInfoEvent(): NostrEvent {
  return finalizeEvent(
    {
      kind: ILP_PEER_INFO_KIND,
      content: JSON.stringify({
        ilpAddress: 'g.pool.peer',
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

describe('createNostrRelayClient', () => {
  let server: WebSocketServer;
  let relayUrl: string;
  const publishedEvent = buildValidPeerInfoEvent();

  beforeAll(async () => {
    server = new WebSocketServer({ port: 0 });
    // Minimal NIP-01 relay: answer any REQ with one stored EVENT then EOSE.
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        let frame: unknown;
        try {
          frame = JSON.parse(String(data));
        } catch {
          return;
        }
        if (!Array.isArray(frame)) {
          return;
        }
        if (frame[0] === 'REQ') {
          const subId = frame[1] as string;
          socket.send(JSON.stringify(['EVENT', subId, publishedEvent]));
          socket.send(JSON.stringify(['EOSE', subId]));
        } else if (frame[0] === 'CLOSE') {
          socket.send(JSON.stringify(['CLOSED', frame[1] as string, '']));
        }
      });
    });
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('WebSocketServer did not bind to a TCP port');
    }
    relayUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const client of server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  it('delivers signature-verified kind:10032 events from a subscribed relay', async () => {
    const client = createNostrRelayClient();
    try {
      const received = await new Promise<NostrEvent>((resolve) => {
        client.subscribe([relayUrl], { kinds: [ILP_PEER_INFO_KIND] }, resolve);
      });
      expect(received.id).toBe(publishedEvent.id);
      expect(received.kind).toBe(ILP_PEER_INFO_KIND);
      expect(received.content).toBe(publishedEvent.content);
    } finally {
      client.destroy();
      // Let the pool's close handshake settle inside the test so no socket
      // handle outlives the suite.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });

  it('close() is idempotent and destroy() tears down all connections', async () => {
    const client = createNostrRelayClient();
    const handle = client.subscribe([relayUrl], { kinds: [ILP_PEER_INFO_KIND] }, () => undefined);
    // Give the pool a beat to establish the connection before closing.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => handle.close()).not.toThrow();
    expect(() => handle.close()).not.toThrow();
    expect(() => client.destroy()).not.toThrow();
    expect(() => client.destroy()).not.toThrow();
  });

  it('does not throw when subscribing to an unreachable relay', async () => {
    const client = createNostrRelayClient();
    try {
      const handle = client.subscribe(
        ['ws://127.0.0.1:1'], // Nothing listens here; SimplePool retries internally.
        { kinds: [ILP_PEER_INFO_KIND] },
        () => undefined
      );
      expect(typeof handle.close).toBe('function');
      handle.close();
    } finally {
      client.destroy();
      // Let the pool's in-flight (refused) connection attempt settle inside
      // the test so no socket handle outlives the suite.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });
});
