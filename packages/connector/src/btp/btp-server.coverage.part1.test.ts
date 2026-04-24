/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * BTP Server Branch Coverage Tests - Part 1
 * Tests: constructor, start(), stop(), hasPeer(), event handlers, sendPacketToPeer()
 */

import { EventEmitter } from 'events';
import { BTPServer } from './btp-server';
import { Logger } from '../utils/logger';
import { PacketHandler } from '../core/packet-handler';
import { BTPMessage, BTPMessageType, BTPErrorData } from './btp-types';
import { parseBTPMessage, serializeBTPMessage } from './btp-message-parser';
import {
  deserializePacket,
  ILPPreparePacket,
  PacketType,
  ILPErrorCode,
} from '@toon-protocol/shared';
import WebSocket from 'ws';

// ─── Mock ws module ───
let wssThrowOnConstruction = false;
let wssCloseError: Error | null = null;
let wsSendError: Error | null = null;
let wsCloseError: Error | null = null;

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
        if (cb) cb(wsSendError);
        return;
      }
      this.sentMessages.push(data);
      if (cb) cb();
    }

    close(code?: number, reason?: string): void {
      if (wsCloseError) {
        throw wsCloseError;
      }
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
    }
  }

  class MockWebSocketServer extends EventEmitter {
    options: any;
    constructor(options: any) {
      super();
      if (wssThrowOnConstruction) {
        throw new Error('WSS construction failed');
      }
      this.options = options;
    }
    address() {
      return { port: this.options.port || 3000, family: 'IPv4', address: '127.0.0.1' };
    }
    close(cb?: (err?: Error) => void): void {
      if (wssCloseError) {
        if (cb) cb(wssCloseError);
        return;
      }
      this.emit('close');
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

const createBTPProtocolOnlyMessage = (requestId = 1): BTPMessage => ({
  type: BTPMessageType.MESSAGE,
  requestId,
  data: { protocolData: [] },
});

const createILPPreparePacket = (expiresAt?: Date): ILPPreparePacket => ({
  type: PacketType.PREPARE,
  amount: BigInt(1000),
  destination: 'g.alice.wallet',
  expiresAt: expiresAt ?? new Date(Date.now() + 10000),
  data: Buffer.alloc(0),
});

// Re-export required imports/helpers to satisfy TypeScript noUnusedLocals
export {
  EventEmitter,
  serializeBTPMessage,
  deserializePacket,
  ILPErrorCode,
  createBTPProtocolOnlyMessage,
};
export type { BTPErrorData };

// ─── Tests ───
describe('BTPServer Coverage Part 1', () => {
  let server: BTPServer;
  let mockLogger: jest.Mocked<Logger>;
  let mockPacketHandler: jest.Mocked<PacketHandler>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockPacketHandler = createMockPacketHandler();
    server = new BTPServer(mockLogger, mockPacketHandler);
    originalEnv = { ...process.env };
    wssThrowOnConstruction = false;
    wssCloseError = null;
    wsSendError = null;
    wsCloseError = null;
    jest.clearAllMocks();
  });

  afterEach(async () => {
    wssThrowOnConstruction = false;
    wssCloseError = null;
    wsCloseError = null;
    wsSendError = null;
    await server.stop();
    process.env = originalEnv;
  });

  describe('constructor', () => {
    it('creates instance with logger and packet handler', () => {
      const s = new BTPServer(mockLogger, mockPacketHandler);
      expect(s).toBeDefined();
      expect(s).toBeInstanceOf(BTPServer);
    });
  });

  describe('start()', () => {
    it('resolves when wss emits listening', async () => {
      const p = server.start(3001);
      const wss = (server as any).wss;
      wss.emit('listening');
      await p;
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_server_started', port: 3001 }),
        expect.any(String)
      );
    });

    it('uses BTP_SERVER_PORT env var when port omitted', async () => {
      process.env['BTP_SERVER_PORT'] = '3002';
      const p = server.start();
      const wss = (server as any).wss;
      wss.emit('listening');
      await p;
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_server_started', port: 3002 }),
        expect.any(String)
      );
    });

    it('rejects when wss emits error', async () => {
      const p = server.start(3003);
      const wss = (server as any).wss;
      wss.emit('error', new Error('WSS error'));
      await expect(p).rejects.toThrow('WSS error');
    });

    it('catches WebSocketServer construction error', async () => {
      wssThrowOnConstruction = true;
      await expect(server.start(3004)).rejects.toThrow('WSS construction failed');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_server_start_failed' }),
        expect.any(String)
      );
    });
  });

  describe('stop()', () => {
    it('closes peers and server gracefully', async () => {
      const p = server.start(3005);
      const wss = (server as any).wss;
      wss.emit('listening');
      await p;

      const mockWs = new (jest.requireMock('ws').default)();
      (server as any).peers.set('peer-a', { peerId: 'peer-a', ws: mockWs, authenticated: true });

      await server.stop();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_server_shutdown' }),
        expect.any(String)
      );
    });

    it('returns early when not started', async () => {
      await expect(server.stop()).resolves.toBeUndefined();
    });

    it('handles peer ws.close error during shutdown', async () => {
      const p = server.start(3006);
      const wss = (server as any).wss;
      wss.emit('listening');
      await p;

      wsCloseError = new Error('Close failed');
      const mockWs = new (jest.requireMock('ws').default)();
      (server as any).peers.set('peer-b', { peerId: 'peer-b', ws: mockWs, authenticated: true });

      await server.stop();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_connection_close_failed', peerId: 'peer-b' }),
        expect.any(String)
      );
    });

    it('handles wss close error', async () => {
      const p = server.start(3007);
      const wss = (server as any).wss;
      wss.emit('listening');
      await p;

      wssCloseError = new Error('Close failed');
      await expect(server.stop()).rejects.toThrow('Close failed');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_server_shutdown_error' }),
        expect.any(String)
      );
    });
  });

  describe('hasPeer()', () => {
    it('returns true for authenticated peer', () => {
      (server as any).peers.set('peer-a', { peerId: 'peer-a', ws: {}, authenticated: true });
      expect(server.hasPeer('peer-a')).toBe(true);
    });

    it('returns false for unauthenticated peer', () => {
      (server as any).peers.set('peer-b', { peerId: 'peer-b', ws: {}, authenticated: false });
      expect(server.hasPeer('peer-b')).toBe(false);
    });

    it('returns false for missing peer', () => {
      expect(server.hasPeer('missing')).toBe(false);
    });
  });

  describe('event handler registration', () => {
    it('stores onConnection callback', () => {
      const cb = jest.fn();
      server.onConnection(cb);
      expect((server as any).onConnectionCallback).toBe(cb);
    });

    it('stores onMessage callback', () => {
      const cb = jest.fn();
      server.onMessage(cb);
      expect((server as any).onMessageCallback).toBe(cb);
    });
  });

  describe('sendPacketToPeer()', () => {
    it('throws when peer not found', async () => {
      await expect(server.sendPacketToPeer('missing', createILPPreparePacket())).rejects.toThrow(
        'Incoming peer not found or not authenticated'
      );
    });

    it('throws when peer not authenticated', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      (server as any).peers.set('peer-a', { peerId: 'peer-a', ws: mockWs, authenticated: false });
      await expect(server.sendPacketToPeer('peer-a', createILPPreparePacket())).rejects.toThrow(
        'Incoming peer not found or not authenticated'
      );
    });

    it('throws when websocket not open', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      mockWs.readyState = WebSocket.CLOSED;
      (server as any).peers.set('peer-a', { peerId: 'peer-a', ws: mockWs, authenticated: true });
      await expect(server.sendPacketToPeer('peer-a', createILPPreparePacket())).rejects.toThrow(
        'not in OPEN state'
      );
    });

    it('rejects on send callback error', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      (server as any).peers.set('peer-a', { peerId: 'peer-a', ws: mockWs, authenticated: true });
      wsSendError = new Error('Send failed');
      await expect(server.sendPacketToPeer('peer-a', createILPPreparePacket())).rejects.toThrow(
        'Send failed'
      );
    });

    it('rejects on timeout', async () => {
      jest.useFakeTimers();
      const mockWs = new (jest.requireMock('ws').default)();
      (server as any).peers.set('peer-a', { peerId: 'peer-a', ws: mockWs, authenticated: true });
      const packet = createILPPreparePacket(new Date(Date.now() + 2000));
      const promise = server.sendPacketToPeer('peer-a', packet);
      jest.advanceTimersByTime(3000);
      await expect(promise).rejects.toThrow('Timeout');
      jest.useRealTimers();
    });

    it('sends BTP message and creates pending request', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      const mockWs = new (jest.requireMock('ws').default)();
      (server as any).peers.set('peer-a', { peerId: 'peer-a', ws: mockWs, authenticated: true });

      const packet = createILPPreparePacket();
      server.sendPacketToPeer('peer-a', packet).catch(() => {});

      expect(mockWs.sentMessages.length).toBe(1);
      const parsed = parseBTPMessage(mockWs.sentMessages[0]!);
      expect(parsed.type).toBe(BTPMessageType.MESSAGE);

      const pending = (server as any).pendingRequests;
      expect(pending.size).toBe(1);
      expect(pending.has(Math.floor(0.5 * 0xffffffff))).toBe(true);

      jest.spyOn(Math, 'random').mockRestore();
    });
  });
});
