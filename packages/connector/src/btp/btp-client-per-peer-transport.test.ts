/**
 * Unit tests for the per-peer agentFactory dispatch on BTPClient
 * (per-peer-transport tech spec, Task 10 / AC-1 + AC-11).
 *
 * Uses a real `BTPClient` (no `jest.mock('./btp-client')`) against a real
 * local `ws.WebSocketServer` that echoes a successful BTP AUTH RESPONSE.
 * The existing `btp-client-manager.test.ts` mocks the BTPClient module
 * entirely, so the call site at `btp-client.ts:216` (the agent-factory
 * invocation) is never exercised in that legacy harness — this NEW file
 * is the canonical proof that the signature change to `(peer: Peer) =>`
 * propagates end-to-end through real network IO.
 */

import http from 'http';
import { AddressInfo } from 'net';
import pino from 'pino';
import { WebSocketServer } from 'ws';

import { BTPClient, BTPConnectionError, type Peer } from './btp-client';
import { BTPMessageType, type BTPMessage, type BTPData } from './btp-types';
import { parseBTPMessage, serializeBTPMessage } from './btp-message-parser';
import type { Logger } from '../utils/logger';

function silentLogger(): Logger {
  return pino({ level: 'silent' }) as unknown as Logger;
}

/**
 * Tiny WS server that accepts a single BTP AUTH frame and responds with a
 * successful RESPONSE echoing the client's requestId. Closes cleanly on
 * teardown. Intentionally NOT a SocksProxyAgent / SOCKS5 sink — this is the
 * direct-dial counter-test to the SOCKS5 contract suite.
 */
async function startWsAuthSink(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.on('message', (data: Buffer) => {
      try {
        const msg = parseBTPMessage(data);
        // Echo a RESPONSE with matching requestId so BTPClient resolves.
        const reply: BTPMessage = {
          type: BTPMessageType.RESPONSE,
          requestId: msg.requestId,
          data: { protocolData: [] } as BTPData,
        };
        ws.send(serializeBTPMessage(reply));
      } catch {
        // Best-effort echo; the test asserts on the factory, not on AUTH bytes.
      }
    });
    ws.on('error', () => {
      /* swallow */
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => httpServer.close(() => resolve()));
      }),
  };
}

describe('BTPClient per-peer agentFactory dispatch (Task 10, no module mocks)', () => {
  let sink: Awaited<ReturnType<typeof startWsAuthSink>>;

  beforeAll(async () => {
    sink = await startWsAuthSink();
  });

  afterAll(async () => {
    await sink.close();
  });

  it('invokes the factory with the FULL Peer (including .transport) — never just the URL string', async () => {
    type Invocation = { peerId: string; peerTransport: 'direct' | 'socks5' | undefined };
    const invocations: Invocation[] = [];
    const factory = (peer: Peer): undefined => {
      // Defense check: the factory MUST receive a full Peer object with .id,
      // not just a URL string. Failing this assertion proves Task 2's
      // signature change regressed.
      expect(typeof peer).toBe('object');
      expect(typeof peer.id).toBe('string');
      expect(typeof peer.url).toBe('string');
      invocations.push({ peerId: peer.id, peerTransport: peer.transport });
      return undefined;
    };

    const directPeer: Peer = {
      id: 'p-direct',
      url: sink.url,
      authToken: '',
      connected: false,
      lastSeen: new Date(),
      transport: 'direct',
    };
    const inheritingPeer: Peer = {
      id: 'p-inherit',
      url: sink.url,
      authToken: '',
      connected: false,
      lastSeen: new Date(),
      // transport intentionally omitted — should arrive at the factory as undefined.
    };

    const c1 = new BTPClient(directPeer, 'node-A', silentLogger(), 0, factory);
    const c2 = new BTPClient(inheritingPeer, 'node-A', silentLogger(), 0, factory);

    try {
      await c1.connect();
      await c2.connect();

      expect(invocations).toHaveLength(2);
      expect(invocations[0]).toEqual({ peerId: 'p-direct', peerTransport: 'direct' });
      expect(invocations[1]).toEqual({ peerId: 'p-inherit', peerTransport: undefined });
    } finally {
      await c1.disconnect();
      await c2.disconnect();
    }
  });

  it('returns no agent for transport: direct → BTPClient direct-dials without instantiating a SocksProxyAgent', async () => {
    const factory = jest.fn((_peer: Peer): undefined => undefined);
    const peer: Peer = {
      id: 'p-direct-2',
      url: sink.url,
      authToken: '',
      connected: false,
      lastSeen: new Date(),
      transport: 'direct',
    };
    const client = new BTPClient(peer, 'node-A', silentLogger(), 0, factory);

    try {
      await client.connect();
      // The factory was invoked but returned undefined — the agent was never
      // wrapped. Recording the return value via the mock proves it.
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory.mock.results[0]?.value).toBeUndefined();
    } finally {
      await client.disconnect();
    }
  });

  // AC-11 / defense-in-depth: the per-peer dispatch closure in ConnectorNode
  // throws synchronously when a peer requests socks5 but no SOCKS5 provider
  // is wired. The BTPClient.connect() try/catch must catch that throw and
  // surface a BTPConnectionError rather than silently direct-dialing.
  it('surfaces a factory throw as BTPConnectionError (AC-11 invariant-violation backstop)', async () => {
    const factory = jest.fn((_peer: Peer): import('http').Agent | undefined => {
      throw new Error('SOCKS5 transport requested for peer but no SOCKS5 provider configured');
    });
    const peer: Peer = {
      id: 'p-invariant',
      url: sink.url,
      authToken: '',
      connected: false,
      lastSeen: new Date(),
      transport: 'socks5',
    };
    const client = new BTPClient(peer, 'node-A', silentLogger(), 0, factory);

    await expect(client.connect()).rejects.toBeInstanceOf(BTPConnectionError);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
