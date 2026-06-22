/**
 * Real `node:http` ILP-over-HTTP receiver fixture (Epic 38, Story 38.1 tests).
 *
 * A minimal, mock-free server that accepts the symmetric `POST /ilp` emitted by
 * {@link HttpPeerClientManager} and replies with an OER FULFILL/REJECT. It
 * captures the last request (headers + decoded PREPARE + rebuilt claim
 * protocolData) so tests can assert wire symmetry against the real ingress
 * format, and supports configurable behaviors: fulfill, reject, a fixed HTTP
 * status, or a slow response (to exercise the egress timeout → R00 path).
 *
 * No mocks: this is a genuine HTTP server on an ephemeral port.
 */

import http from 'http';
import { AddressInfo } from 'net';
import {
  deserializePacket,
  serializePacket,
  PacketType,
  ILPErrorCode,
  type ILPPreparePacket,
  type ILPFulfillPacket,
  type ILPRejectPacket,
} from '@toon-protocol/shared';

export interface CapturedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  /** The decoded ILP PREPARE from the request body. */
  prepare: ILPPreparePacket;
  /** Raw plaintext claim bytes (base64-decoded from ILP-Payment-Channel-Claim), if present. */
  claim?: Buffer;
  /** Raw wrapped-claim bytes (base64-decoded from ILP-Payment-Channel-Claim-Wrapped), if present. */
  wrappedClaim?: Buffer;
}

export type ServerBehavior =
  | { kind: 'fulfill'; fulfillment?: Buffer; data?: Buffer }
  | { kind: 'reject'; code: ILPErrorCode; message?: string; triggeredBy?: string }
  | { kind: 'http-status'; status: number; body?: Buffer }
  | { kind: 'slow'; delayMs: number };

export class HttpPeerTestServer {
  private readonly _server: http.Server;
  private _port = 0;
  private _behavior: ServerBehavior = { kind: 'fulfill' };
  /** Every request captured, in order. */
  public readonly requests: CapturedRequest[] = [];
  /** Concurrency tracking for the pooling test. */
  public maxConcurrent = 0;
  private _inFlight = 0;

  constructor() {
    this._server = http.createServer((req, res) => void this.handle(req, res));
  }

  setBehavior(behavior: ServerBehavior): void {
    this._behavior = behavior;
  }

  get port(): number {
    return this._port;
  }

  get url(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  get lastRequest(): CapturedRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this._server.listen(0, '127.0.0.1', resolve));
    this._port = (this._server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this._server.close((err) => (err ? reject(err) : resolve()))
    );
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this._inFlight++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this._inFlight);
    try {
      const body = await this.readBody(req);
      const prepare = deserializePacket(body) as ILPPreparePacket;

      const claimHeader = this.firstHeader(req.headers['ilp-payment-channel-claim']);
      const wrappedHeader = this.firstHeader(req.headers['ilp-payment-channel-claim-wrapped']);
      this.requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        prepare,
        claim: claimHeader ? Buffer.from(claimHeader, 'base64') : undefined,
        wrappedClaim: wrappedHeader ? Buffer.from(wrappedHeader, 'base64') : undefined,
      });

      await this.respond(res, prepare);
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`bad request: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      this._inFlight--;
    }
  }

  private async respond(res: http.ServerResponse, prepare: ILPPreparePacket): Promise<void> {
    const b = this._behavior;
    switch (b.kind) {
      case 'fulfill': {
        const packet: ILPFulfillPacket = {
          type: PacketType.FULFILL,
          fulfillment: b.fulfillment ?? Buffer.alloc(32),
          data: b.data ?? Buffer.alloc(0),
        };
        this.writePacket(res, packet);
        return;
      }
      case 'reject': {
        const packet: ILPRejectPacket = {
          type: PacketType.REJECT,
          code: b.code,
          triggeredBy: b.triggeredBy ?? 'test.http.peer',
          message: b.message ?? 'rejected by test server',
          data: Buffer.alloc(0),
        };
        this.writePacket(res, packet);
        return;
      }
      case 'http-status': {
        res.writeHead(b.status, { 'Content-Type': 'text/plain' });
        res.end(b.body ?? Buffer.from(`status ${b.status}`));
        return;
      }
      case 'slow': {
        await new Promise<void>((resolve) => setTimeout(resolve, b.delayMs));
        // After the delay, fulfill (the egress should already have timed out).
        const packet: ILPFulfillPacket = {
          type: PacketType.FULFILL,
          fulfillment: Buffer.alloc(32),
          data: Buffer.alloc(0),
        };
        this.writePacket(res, packet);
        return;
      }
    }
    // exhaustiveness — fulfill PREPARE referenced to keep param used
    void prepare;
  }

  private writePacket(res: http.ServerResponse, packet: ILPFulfillPacket | ILPRejectPacket): void {
    const buf = serializePacket(packet);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': buf.length,
    });
    res.end(buf);
  }

  private readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private firstHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
