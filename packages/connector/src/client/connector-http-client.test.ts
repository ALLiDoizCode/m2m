/**
 * Tests for ConnectorHttpClient, driven against a real HTTP server that
 * implements the client-edge wire contract (`docs/protocol/client-edge-spec.md`
 * §1.1) — no fetch mocking, no fake packet handler.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import {
  deserializePacket,
  serializePacket,
  PacketType,
  ILPErrorCode,
  type ILPPreparePacket,
} from '@toon-protocol/shared';
import { ConnectorHttpClient, ConnectorHttpTransportError } from './connector-http-client';

/** A minimal stand-in for the client edge's `POST /ilp` (§1.1): decodes the
 * OER PREPARE it receives and returns a scripted OER FULFILL/REJECT, or the
 * configured transport-level status untouched — exactly the shapes the real
 * Rust connector's `connector-client-edge` router produces. */
function startFakeClientEdge(
  handle: (prepare: ILPPreparePacket) => { status: number; body: Buffer }
): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (req.method !== 'POST' || req.url !== '/ilp') {
          res.writeHead(404).end();
          return;
        }
        const body = Buffer.concat(chunks);
        let prepare: ILPPreparePacket;
        try {
          const decoded = deserializePacket(body);
          if (decoded.type !== PacketType.PREPARE) throw new Error('not a prepare');
          prepare = decoded;
        } catch {
          res.writeHead(400, { 'content-type': 'text/plain' }).end('Malformed request');
          return;
        }
        const { status, body: responseBody } = handle(prepare);
        res.writeHead(status, { 'content-type': 'application/octet-stream' }).end(responseBody);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('ConnectorHttpClient', () => {
  let server: http.Server;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends a PREPARE and decodes a real FULFILL response (200)', async () => {
    let received: ILPPreparePacket | undefined;
    const fixture = await startFakeClientEdge((prepare) => {
      received = prepare;
      return {
        status: 200,
        body: serializePacket({
          type: PacketType.FULFILL,
          fulfillment: new Uint8Array(32).fill(7),
          data: Buffer.from('app said yes'),
        }),
      };
    });
    server = fixture.server;

    const client = new ConnectorHttpClient({ baseUrl: fixture.baseUrl });
    const result = await client.sendPacket({
      destination: 'g.example.app',
      amount: 100n,
      expiresAt: new Date('2030-01-01T00:00:00Z'),
      data: Buffer.from('hello app'),
    });

    expect(received?.destination).toBe('g.example.app');
    expect(received?.amount).toBe(100n);
    expect(received?.data.toString()).toBe('hello app');
    expect(result.type).toBe(PacketType.FULFILL);
    if (result.type === PacketType.FULFILL) {
      expect(result.data.toString()).toBe('app said yes');
    }
  });

  it('decodes a real REJECT response (still HTTP 200 per spec §1.1)', async () => {
    const fixture = await startFakeClientEdge(() => ({
      status: 200,
      body: serializePacket({
        type: PacketType.REJECT,
        code: ILPErrorCode.F02_UNREACHABLE,
        triggeredBy: 'g.connector',
        message: 'No route to destination',
        data: Buffer.alloc(0),
      }),
    }));
    server = fixture.server;

    const client = new ConnectorHttpClient({ baseUrl: fixture.baseUrl });
    const result = await client.sendPacket({
      destination: 'g.nowhere',
      amount: 1n,
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });

    expect(result.type).toBe(PacketType.REJECT);
    if (result.type === PacketType.REJECT) {
      expect(result.code).toBe(ILPErrorCode.F02_UNREACHABLE);
    }
  });

  it('throws ConnectorHttpTransportError with status + body on a transport-level 400', async () => {
    const fixture = await startFakeClientEdge(() => ({
      status: 400,
      body: Buffer.from('Malformed request'),
    }));
    server = fixture.server;

    const client = new ConnectorHttpClient({ baseUrl: fixture.baseUrl });
    let caught: unknown;
    try {
      await client.sendPacket({
        destination: 'g.example.app',
        amount: 1n,
        expiresAt: new Date('2030-01-01T00:00:00Z'),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConnectorHttpTransportError);
    expect((caught as ConnectorHttpTransportError).status).toBe(400);
  });

  it('carries caller-supplied identity/claim headers (§1.2/§1.3) through unchanged', async () => {
    let receivedHeaders: http.IncomingHttpHeaders | undefined;
    const server2 = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(
          serializePacket({
            type: PacketType.FULFILL,
            data: Buffer.alloc(0),
          })
        );
      });
    });
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', () => resolve()));
    server = server2;
    const { port } = server2.address() as AddressInfo;

    const client = new ConnectorHttpClient({ baseUrl: `http://127.0.0.1:${port}` });
    await client.sendPacket({
      destination: 'g.example.app',
      amount: 1n,
      expiresAt: new Date('2030-01-01T00:00:00Z'),
      headers: { 'ILP-Peer-Id': 'peer-a', Authorization: 'Bearer secret' },
    });

    expect(receivedHeaders?.['ilp-peer-id']).toBe('peer-a');
    expect(receivedHeaders?.authorization).toBe('Bearer secret');
  });
});
