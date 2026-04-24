/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * BTP Server Branch Coverage Tests - Part 2
 * Tests: handleConnection(), handleWebSocketMessage() - authentication,
 *        handleWebSocketMessage() - response correlation
 */

import { EventEmitter } from 'events';
import { BTPServer } from './btp-server';
import { Logger } from '../utils/logger';
import { PacketHandler } from '../core/packet-handler';
import { BTPMessage, BTPMessageType, BTPErrorData } from './btp-types';
import { parseBTPMessage, serializeBTPMessage } from './btp-message-parser';
import {
  deserializePacket,
  serializePacket,
  ILPPreparePacket,
  ILPFulfillPacket,
  ILPRejectPacket,
  PacketType,
  ILPErrorCode,
} from '@toon-protocol/shared';
import WebSocket from 'ws';

// ─── Mock ws module ───
let wsSendError: Error | null = null;

jest.mock('ws', () => {
  const { EventEmitter } = require('events');

  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = MockWebSocket.OPEN;
    sentMessages: Buffer[] = [];

    send(data: Buffer, cb?: (err?: Error) => void): void {
      if (wsSendError) {
        if (cb) {
          cb(wsSendError);
          return;
        }
        throw wsSendError;
      }
      this.sentMessages.push(data);
      if (cb) cb();
    }

    close(code?: number, reason?: string): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
    }
  }

  class MockWebSocketServer extends EventEmitter {
    options: any;
    constructor(options: any) {
      super();
      this.options = options;
    }
    address() {
      return { port: this.options.port || 3000, family: 'IPv4', address: '127.0.0.1' };
    }
    close(cb?: (err?: Error) => void): void {
      if (cb) cb();
    }
  }

  return {
    __esModule: true,
    default: MockWebSocket,
    WebSocketServer: MockWebSocketServer,
  };
});

// ─── Helpers ───
const createMockLogger = (): jest.Mocked<Logger> =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    trace: jest.fn(),
    silent: jest.fn(),
    level: 'info',
    child: jest.fn(function (this: any) {
      return this;
    }),
  }) as unknown as jest.Mocked<Logger>;

const createMockPacketHandler = (): jest.Mocked<PacketHandler> =>
  ({ handlePreparePacket: jest.fn() }) as unknown as jest.Mocked<PacketHandler>;

const createBTPResponse = (requestId: number, ilpPacket?: Buffer): BTPMessage => ({
  type: BTPMessageType.RESPONSE,
  requestId,
  data: { protocolData: [], ilpPacket },
});

const createBTPErrorMessage = (requestId: number, code = 'F00'): BTPMessage => ({
  type: BTPMessageType.ERROR,
  requestId,
  data: { code, name: 'Error', triggeredAt: new Date().toISOString(), data: Buffer.alloc(0) },
});

const createBTPMessageWithILP = (ilpPacket: Buffer, requestId = 1): BTPMessage => ({
  type: BTPMessageType.MESSAGE,
  requestId,
  data: { protocolData: [], ilpPacket },
});

const createBTPProtocolOnlyMessage = (requestId = 1): BTPMessage => ({
  type: BTPMessageType.MESSAGE,
  requestId,
  data: { protocolData: [] },
});

const createILPPreparePacket = (): ILPPreparePacket => ({
  type: PacketType.PREPARE,
  amount: BigInt(1000),
  destination: 'g.alice.wallet',
  expiresAt: new Date(Date.now() + 10000),
  data: Buffer.alloc(0),
});

const createILPFulfillPacket = (): ILPFulfillPacket => ({
  type: PacketType.FULFILL,
  data: Buffer.alloc(0),
});

const createILPRejectPacket = (): ILPRejectPacket => ({
  type: PacketType.REJECT,
  code: ILPErrorCode.F02_UNREACHABLE,
  triggeredBy: 'g.connector',
  message: 'No route',
  data: Buffer.alloc(0),
});

const authMsg = (peerId: string, secret: string, requestId = 1): BTPMessage => ({
  type: BTPMessageType.MESSAGE,
  requestId,
  data: {
    protocolData: [
      {
        protocolName: 'auth',
        contentType: 0,
        data: Buffer.from(JSON.stringify({ peerId, secret }), 'utf8'),
      },
    ],
  },
});

// Re-export required imports/helpers to satisfy TypeScript noUnusedLocals
export {
  EventEmitter,
  deserializePacket,
  WebSocket,
  createBTPMessageWithILP,
  createBTPProtocolOnlyMessage,
};
export type { BTPErrorData };

// ─── Tests ───
describe('BTPServer Coverage Part 2', () => {
  let server: BTPServer;
  let mockLogger: jest.Mocked<Logger>;
  let mockPacketHandler: jest.Mocked<PacketHandler>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockPacketHandler = createMockPacketHandler();
    server = new BTPServer(mockLogger, mockPacketHandler);
    originalEnv = { ...process.env };
    wsSendError = null;
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await server.stop();
    process.env = originalEnv;
  });

  async function startAndConnect(req?: {
    socket: { remoteAddress?: string; remotePort?: number };
  }) {
    const p = server.start(0);
    const wss = (server as any).wss;
    wss.emit('listening');
    await p;

    const mockWs = new (jest.requireMock('ws').default)();
    wss.emit(
      'connection',
      mockWs,
      req ?? { socket: { remoteAddress: '127.0.0.1', remotePort: 12345 } }
    );
    return mockWs;
  }

  async function authenticate(mockWs: any, peerId: string, secret: string) {
    process.env[`BTP_PEER_${peerId.toUpperCase().replace(/-/g, '_')}_SECRET`] = secret;
    mockWs.emit('message', serializeBTPMessage(authMsg(peerId, secret)));
    await new Promise((r) => setTimeout(r, 20));
  }

  describe('handleConnection()', () => {
    it('logs connection with remote address', async () => {
      await startAndConnect({ socket: { remoteAddress: '192.168.1.1', remotePort: 55555 } });
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_connection', remoteAddress: '192.168.1.1' }),
        expect.any(String)
      );
    });

    it('logs connection with unknown remote address', async () => {
      await startAndConnect({ socket: { remoteAddress: undefined, remotePort: 55555 } });
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_connection', remoteAddress: 'unknown' }),
        expect.any(String)
      );
    });

    it('removes authenticated peer on close', async () => {
      const mockWs = await startAndConnect();
      await authenticate(mockWs, 'peer-a', 'secret');
      expect(server.hasPeer('peer-a')).toBe(true);
      mockWs.close(1000, 'bye');
      expect(server.hasPeer('peer-a')).toBe(false);
    });

    it('handles close for unauthenticated peer', async () => {
      const mockWs = await startAndConnect();
      mockWs.close(1000, 'bye');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_disconnect' }),
        expect.any(String)
      );
    });

    it('handles ws error event', async () => {
      const mockWs = await startAndConnect();
      mockWs.emit('error', new Error('WS error'));
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_connection_error' }),
        expect.any(String)
      );
    });
  });

  describe('handleWebSocketMessage() - authentication', () => {
    it('authenticates peer with valid secret', async () => {
      const mockWs = await startAndConnect();
      await authenticate(mockWs, 'peer-b', 'secret-b');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_auth', peerId: 'peer-b', success: true }),
        expect.any(String)
      );
      expect(server.hasPeer('peer-b')).toBe(true);
      const response = parseBTPMessage(mockWs.sentMessages[0]!);
      expect(response.type).toBe(BTPMessageType.RESPONSE);
    });

    it('rejects auth with invalid secret', async () => {
      const mockWs = await startAndConnect();
      process.env['BTP_PEER_PEER_C_SECRET'] = 'correct';
      mockWs.emit('message', serializeBTPMessage(authMsg('peer-c', 'wrong')));
      await new Promise((r) => setTimeout(r, 20));
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_auth', peerId: 'peer-c', success: false }),
        expect.any(String)
      );
    });

    it('handles malformed message before auth', async () => {
      const mockWs = await startAndConnect();
      mockWs.emit('message', Buffer.from([1, 2, 3]));
      await new Promise((r) => setTimeout(r, 20));
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_message_error' }),
        expect.any(String)
      );
    });

    it('handles send error during error response on malformed message', async () => {
      const mockWs = await startAndConnect();
      wsSendError = new Error('Send failed');
      mockWs.emit('message', Buffer.from([1, 2, 3]));
      await new Promise((r) => setTimeout(r, 20));
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_error_response_failed' }),
        expect.any(String)
      );
    });
  });

  describe('handleWebSocketMessage() - response correlation', () => {
    it('correlates RESPONSE with FULFILL', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.123);
      const mockWs = await startAndConnect();
      await authenticate(mockWs, 'peer-d', 'secret-d');

      const prepare = createILPPreparePacket();
      const promise = server.sendPacketToPeer('peer-d', prepare);

      const fulfill = createILPFulfillPacket();
      const btpResponse = createBTPResponse(
        Math.floor(0.123 * 0xffffffff),
        serializePacket(fulfill)
      );
      mockWs.emit('message', serializeBTPMessage(btpResponse));

      const result = await promise;
      expect(result.type).toBe(PacketType.FULFILL);
      jest.spyOn(Math, 'random').mockRestore();
    });

    it('correlates RESPONSE with REJECT', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.234);
      const mockWs = await startAndConnect();
      await authenticate(mockWs, 'peer-e', 'secret-e');

      const promise = server.sendPacketToPeer('peer-e', createILPPreparePacket());

      const reject = createILPRejectPacket();
      const btpResponse = createBTPResponse(
        Math.floor(0.234 * 0xffffffff),
        serializePacket(reject)
      );
      mockWs.emit('message', serializeBTPMessage(btpResponse));

      const result = await promise;
      expect(result.type).toBe(PacketType.REJECT);
      jest.spyOn(Math, 'random').mockRestore();
    });

    it('correlates ERROR response', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.345);
      const mockWs = await startAndConnect();
      await authenticate(mockWs, 'peer-f', 'secret-f');

      const promise = server.sendPacketToPeer('peer-f', createILPPreparePacket());

      const btpError = createBTPErrorMessage(Math.floor(0.345 * 0xffffffff), 'F00');
      mockWs.emit('message', serializeBTPMessage(btpError));

      await expect(promise).rejects.toThrow('BTP Error from peer');
      jest.spyOn(Math, 'random').mockRestore();
    });

    it('correlates response missing ILP packet', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.456);
      const mockWs = await startAndConnect();
      await authenticate(mockWs, 'peer-g', 'secret-g');

      const promise = server.sendPacketToPeer('peer-g', createILPPreparePacket());

      const btpResponse = createBTPResponse(Math.floor(0.456 * 0xffffffff));
      mockWs.emit('message', serializeBTPMessage(btpResponse));

      await expect(promise).rejects.toThrow('Response missing ILP packet');
      jest.spyOn(Math, 'random').mockRestore();
    });

    it('correlates unexpected ILP packet type', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.567);
      const mockWs = await startAndConnect();
      await authenticate(mockWs, 'peer-h', 'secret-h');

      const promise = server.sendPacketToPeer('peer-h', createILPPreparePacket());

      const btpResponse = createBTPResponse(
        Math.floor(0.567 * 0xffffffff),
        serializePacket(createILPPreparePacket())
      );
      mockWs.emit('message', serializeBTPMessage(btpResponse));

      await expect(promise).rejects.toThrow('Unexpected ILP packet type');
      jest.spyOn(Math, 'random').mockRestore();
    });

    it('correlates response parse error', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.678);
      const mockWs = await startAndConnect();
      await authenticate(mockWs, 'peer-i', 'secret-i');

      const promise = server.sendPacketToPeer('peer-i', createILPPreparePacket());

      const btpResponse = createBTPResponse(Math.floor(0.678 * 0xffffffff), Buffer.from('garbage'));
      mockWs.emit('message', serializeBTPMessage(btpResponse));

      await expect(promise).rejects.toThrow('Error parsing response');
      jest.spyOn(Math, 'random').mockRestore();
    });
  });
});
