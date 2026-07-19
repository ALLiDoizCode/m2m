/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * BTP Server Branch Coverage Tests - Part 3
 * Tests: handleWebSocketMessage() - authenticated routing, authenticatePeer(), handleMessage()
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
import { BTPData, BTPError, isBTPData } from './btp-types';
import { InboundClaimValidator } from './inbound-claim-validator';
import { ChainProviderRegistry } from '../settlement/provider/chain-provider-registry';
import type { SolanaClaimMessage } from './btp-claim-types';

// ─── Mock ws module ───
let wsSendError: Error | null = null;
let wsReadyStateOverride: number | null = null;

jest.mock('ws', () => {
  const { EventEmitter } = require('events');
  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = wsReadyStateOverride ?? MockWebSocket.OPEN;
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
  return { __esModule: true, default: MockWebSocket, WebSocketServer: MockWebSocketServer };
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
export { EventEmitter, deserializePacket, isBTPData };
export type { BTPErrorData, BTPData };

// ─── Tests ───
describe('BTPServer Coverage Part 3', () => {
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
    wsReadyStateOverride = null;
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await server.stop();
    process.env = originalEnv;
  });

  async function startAndConnect() {
    const p = server.start(0);
    const wss = (server as any).wss;
    wss.emit('listening');
    await p;
    const mockWs = new (jest.requireMock('ws').default)();
    wss.emit('connection', mockWs, { socket: { remoteAddress: '127.0.0.1', remotePort: 12345 } });
    return mockWs;
  }

  async function authenticate(mockWs: any, peerId: string, secret: string) {
    process.env[`BTP_PEER_${peerId.toUpperCase().replace(/-/g, '_')}_SECRET`] = secret;
    mockWs.emit('message', serializeBTPMessage(authMsg(peerId, secret)));
    await new Promise((r) => setTimeout(r, 20));
  }

  function makePeerConn(mockWs: any, peerId: string, authenticated = true) {
    return { peerId, ws: mockWs, authenticated };
  }

  describe('handleWebSocketMessage() - authenticated routing', () => {
    it('routes MESSAGE to handleMessage when authenticated', async () => {
      const mockWs = await startAndConnect();
      await authenticate(mockWs, 'peer-a', 'secret-a');
      mockPacketHandler.handlePreparePacket.mockResolvedValue(createILPFulfillPacket());
      const prepare = createILPPreparePacket();
      mockWs.emit(
        'message',
        serializeBTPMessage(createBTPMessageWithILP(serializePacket(prepare), 2))
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(mockPacketHandler.handlePreparePacket).toHaveBeenCalled();
      const lastMsg = parseBTPMessage(mockWs.sentMessages[mockWs.sentMessages.length - 1]!);
      expect(lastMsg.type).toBe(BTPMessageType.RESPONSE);
    });

    it('warns on unexpected message type when authenticated', async () => {
      const mockWs = await startAndConnect();
      await authenticate(mockWs, 'peer-b', 'secret-b');
      const transferMsg: BTPMessage = {
        type: BTPMessageType.TRANSFER,
        requestId: 99,
        data: { protocolData: [] },
      };
      mockWs.emit('message', serializeBTPMessage(transferMsg));
      await new Promise((r) => setTimeout(r, 20));
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_unexpected_message_type' }),
        expect.any(String)
      );
    });

    it('calls onMessage callback', async () => {
      const mockWs = await startAndConnect();
      await authenticate(mockWs, 'peer-c', 'secret-c');
      const msgCb = jest.fn();
      server.onMessage(msgCb);
      mockWs.emit('message', serializeBTPMessage(createBTPProtocolOnlyMessage(5)));
      await new Promise((r) => setTimeout(r, 20));
      expect(msgCb).toHaveBeenCalledWith('peer-c', expect.objectContaining({ requestId: 5 }));
    });
  });

  describe('authenticatePeer()', () => {
    it('rejects wrong message type', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      await (server as any).authenticatePeer(makePeerConn(mockWs, 'tmp'), {
        type: BTPMessageType.RESPONSE,
        requestId: 1,
        data: { protocolData: [] },
      });
      expect(parseBTPMessage(mockWs.sentMessages[0]!).type).toBe(BTPMessageType.ERROR);
    });

    it('rejects non-BTP-data message', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      const errMsg: BTPMessage = {
        type: BTPMessageType.ERROR,
        requestId: 1,
        data: {
          code: 'F00',
          name: 'Error',
          triggeredAt: new Date().toISOString(),
          data: Buffer.alloc(0),
        },
      };
      await (server as any).authenticatePeer(makePeerConn(mockWs, 'tmp'), errMsg);
      expect(parseBTPMessage(mockWs.sentMessages[0]!).type).toBe(BTPMessageType.ERROR);
    });

    it('rejects missing auth protocol data', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      await (server as any).authenticatePeer(
        makePeerConn(mockWs, 'tmp'),
        createBTPProtocolOnlyMessage(1)
      );
      expect(parseBTPMessage(mockWs.sentMessages[0]!).type).toBe(BTPMessageType.ERROR);
    });

    it('rejects missing peerId', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      const msg: BTPMessage = {
        type: BTPMessageType.MESSAGE,
        requestId: 1,
        data: {
          protocolData: [
            {
              protocolName: 'auth',
              contentType: 0,
              data: Buffer.from(JSON.stringify({ secret: 'x' }), 'utf8'),
            },
          ],
        },
      };
      await (server as any).authenticatePeer(makePeerConn(mockWs, 'tmp'), msg);
      expect(parseBTPMessage(mockWs.sentMessages[0]!).type).toBe(BTPMessageType.ERROR);
    });

    it('rejects missing secret field', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      const msg: BTPMessage = {
        type: BTPMessageType.MESSAGE,
        requestId: 1,
        data: {
          protocolData: [
            {
              protocolName: 'auth',
              contentType: 0,
              data: Buffer.from(JSON.stringify({ peerId: 'p' }), 'utf8'),
            },
          ],
        },
      };
      await (server as any).authenticatePeer(makePeerConn(mockWs, 'tmp'), msg);
      expect(parseBTPMessage(mockWs.sentMessages[0]!).type).toBe(BTPMessageType.ERROR);
    });

    it('accepts no-auth mode by default', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      await (server as any).authenticatePeer(
        makePeerConn(mockWs, 'tmp'),
        authMsg('noauth-peer', '')
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'btp_auth',
          peerId: 'noauth-peer',
          success: true,
          mode: 'no-auth',
        }),
        expect.any(String)
      );
      expect(server.hasPeer('noauth-peer')).toBe(true);
    });

    it('rejects no-auth when BTP_ALLOW_NOAUTH=false', async () => {
      process.env['BTP_ALLOW_NOAUTH'] = 'false';
      const mockWs = new (jest.requireMock('ws').default)();
      await (server as any).authenticatePeer(
        makePeerConn(mockWs, 'tmp'),
        authMsg('noauth-peer2', '')
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'btp_auth',
          peerId: 'noauth-peer2',
          success: false,
          reason: 'no-auth disabled',
        }),
        expect.any(String)
      );
      expect(server.hasPeer('noauth-peer2')).toBe(false);
    });

    it('rejects unconfigured peer', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      await (server as any).authenticatePeer(
        makePeerConn(mockWs, 'tmp'),
        authMsg('unknown-peer', 'some-secret')
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'btp_auth',
          peerId: 'unknown-peer',
          success: false,
          reason: 'no configured secret for peer',
        }),
        expect.any(String)
      );
    });

    it('rejects invalid secret', async () => {
      process.env['BTP_PEER_PEER_X_SECRET'] = 'correct';
      const mockWs = new (jest.requireMock('ws').default)();
      await (server as any).authenticatePeer(
        makePeerConn(mockWs, 'tmp'),
        authMsg('peer-x', 'wrong')
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'btp_auth',
          peerId: 'peer-x',
          success: false,
          reason: 'invalid secret',
        }),
        expect.any(String)
      );
    });

    it('accepts valid secret and calls onConnection', async () => {
      process.env['BTP_PEER_PEER_Y_SECRET'] = 'correct-y';
      const connCb = jest.fn();
      server.onConnection(connCb);
      const mockWs = new (jest.requireMock('ws').default)();
      await (server as any).authenticatePeer(
        makePeerConn(mockWs, 'tmp'),
        authMsg('peer-y', 'correct-y')
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_auth', peerId: 'peer-y', success: true }),
        expect.any(String)
      );
      expect(connCb).toHaveBeenCalledWith('peer-y', mockWs);
      expect(server.hasPeer('peer-y')).toBe(true);
    });

    it('handles send error during error response in catch', async () => {
      wsSendError = new Error('Send failed');
      process.env['BTP_ALLOW_NOAUTH'] = 'false';
      const mockWs = new (jest.requireMock('ws').default)();
      await expect(
        (server as any).authenticatePeer(makePeerConn(mockWs, 'tmp'), authMsg('peer-z', ''))
      ).resolves.toBeUndefined();
    });

    it('handles non-BTPError in catch block', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      const msg: BTPMessage = {
        type: BTPMessageType.MESSAGE,
        requestId: 1,
        data: {
          protocolData: [
            { protocolName: 'auth', contentType: 0, data: Buffer.from('not-json', 'utf8') },
          ],
        },
      };
      await (server as any).authenticatePeer(makePeerConn(mockWs, 'tmp'), msg);
      expect(parseBTPMessage(mockWs.sentMessages[0]!).type).toBe(BTPMessageType.ERROR);
    });
  });

  describe('handleMessage()', () => {
    it('rejects wrong message type', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      await expect(
        (server as any).handleMessage(makePeerConn(mockWs, 'peer-msg', true), {
          type: BTPMessageType.RESPONSE,
          requestId: 1,
          data: { protocolData: [] },
        })
      ).rejects.toThrow('Expected MESSAGE, got RESPONSE');
      expect(parseBTPMessage(mockWs.sentMessages[0]!).type).toBe(BTPMessageType.ERROR);
    });

    it('rejects ERROR message type', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      const errMsg: BTPMessage = {
        type: BTPMessageType.ERROR,
        requestId: 1,
        data: {
          code: 'F00',
          name: 'Error',
          triggeredAt: new Date().toISOString(),
          data: Buffer.alloc(0),
        },
      };
      await expect(
        (server as any).handleMessage(makePeerConn(mockWs, 'peer-msg', true), errMsg)
      ).rejects.toThrow('Expected MESSAGE, got ERROR');
      expect(parseBTPMessage(mockWs.sentMessages[0]!).type).toBe(BTPMessageType.ERROR);
    });

    it('handles protocol-data-only message', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      await (server as any).handleMessage(
        makePeerConn(mockWs, 'peer-msg', true),
        createBTPProtocolOnlyMessage(2)
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_protocol_data_received' }),
        expect.any(String)
      );
      expect(mockWs.sentMessages.length).toBe(0);
    });

    it('rejects non-PREPARE ILP packet', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      const msg = createBTPMessageWithILP(serializePacket(createILPFulfillPacket()), 3);
      await expect(
        (server as any).handleMessage(makePeerConn(mockWs, 'peer-msg', true), msg)
      ).rejects.toThrow('Expected ILP PREPARE packet');
      expect(parseBTPMessage(mockWs.sentMessages[0]!).type).toBe(BTPMessageType.ERROR);
    });

    it('rejects when inbound claim validator returns reject', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      server.setInboundClaimValidator(async () => createILPRejectPacket());
      const msg = createBTPMessageWithILP(serializePacket(createILPPreparePacket()), 4);
      await (server as any).handleMessage(makePeerConn(mockWs, 'peer-msg', true), msg);
      expect(parseBTPMessage(mockWs.sentMessages[0]!).type).toBe(BTPMessageType.RESPONSE);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_claim_validation_rejected' }),
        expect.any(String)
      );
    });

    it('F06-rejects a stale-nonce replay through the REAL validator: packet handler and crypto never invoked (#353)', async () => {
      const mockWs = new (jest.requireMock('ws').default)();

      // Real InboundClaimValidator with always-verifying crypto (isolating the
      // freshness decision) and a received-claim watermark at nonce 6.
      const solClaim = (nonce: number): SolanaClaimMessage => ({
        version: '1.0',
        blockchain: 'solana',
        messageId: `sol-replay-${nonce}`,
        timestamp: '2026-07-17T12:00:00.000Z',
        senderId: 'peer-msg',
        programId: '11111111111111111111111111111111',
        channelAccount: 'ChanAcct1111111111111111111111111111111111',
        nonce,
        transferredAmount: String(1000 * nonce),
        signature: 'c2lnbmF0dXJl',
        signerPublicKey: 'SiGnEr111111111111111111111111111111111111',
        cluster: 'devnet',
      });
      const verifyBalanceProof = jest.fn(async () => true);
      const registry = new ChainProviderRegistry();
      registry.register({
        chainType: 'solana',
        chainId: 'solana:devnet',
        verifyBalanceProof,
      } as any);
      const validator = new InboundClaimValidator(
        undefined,
        'g.connector',
        createMockLogger() as any,
        undefined,
        undefined,
        undefined,
        undefined,
        registry,
        async () => solClaim(6) // watermark: latest verified nonce is 6
      );
      server.setInboundClaimValidator((pd, pkt, peer) => validator.validate(pd, pkt, peer));

      // Replay an old claim (nonce 4 <= watermark 6) on a value-bearing PREPARE.
      const msg: BTPMessage = {
        type: BTPMessageType.MESSAGE,
        requestId: 11,
        data: {
          protocolData: [
            {
              protocolName: 'payment-channel-claim',
              contentType: 1,
              data: Buffer.from(JSON.stringify(solClaim(4)), 'utf8'),
            },
          ],
          ilpPacket: serializePacket(createILPPreparePacket()),
        },
      };
      await (server as any).handleMessage(makePeerConn(mockWs, 'peer-msg', true), msg);

      // The backend seam is never reached and no crypto verification ran —
      // the replay dies on the local watermark read alone.
      expect(mockPacketHandler.handlePreparePacket).not.toHaveBeenCalled();
      expect(verifyBalanceProof).not.toHaveBeenCalled();

      const parsed = parseBTPMessage(mockWs.sentMessages[0]!);
      expect(parsed.type).toBe(BTPMessageType.RESPONSE);
      const ilp = deserializePacket((parsed.data as BTPData).ilpPacket!);
      expect(ilp.type).toBe(PacketType.REJECT);
      expect((ilp as ILPRejectPacket).code).toBe(ILPErrorCode.F06_UNEXPECTED_PAYMENT);
      expect((ilp as ILPRejectPacket).message).toContain('Stale payment claim');
    });

    it('F06-rejects an UNDERPAYING claim through the REAL validator: packet handler and crypto never invoked (#359)', async () => {
      const mockWs = new (jest.requireMock('ws').default)();

      // A FRESH claim (nonce 7 > watermark 6) that advances the cumulative by
      // only 1000 base units, on a route priced at 2000 → underpaid. This is
      // exactly the #359 hole: fresh enough to pass #358, but paying below price.
      const solClaim = (nonce: number): SolanaClaimMessage => ({
        version: '1.0',
        blockchain: 'solana',
        messageId: `sol-underpay-${nonce}`,
        timestamp: '2026-07-17T12:00:00.000Z',
        senderId: 'peer-msg',
        programId: '11111111111111111111111111111111',
        channelAccount: 'ChanAcct1111111111111111111111111111111111',
        nonce,
        transferredAmount: String(1000 * nonce),
        signature: 'c2lnbmF0dXJl',
        signerPublicKey: 'SiGnEr111111111111111111111111111111111111',
        cluster: 'devnet',
      });
      const verifyBalanceProof = jest.fn(async () => true);
      const registry = new ChainProviderRegistry();
      registry.register({
        chainType: 'solana',
        chainId: 'solana:devnet',
        verifyBalanceProof,
      } as any);
      const validator = new InboundClaimValidator(
        undefined,
        'g.connector',
        createMockLogger() as any,
        undefined,
        undefined,
        undefined,
        undefined,
        registry,
        async () => solClaim(6), // watermark: cumulative 6000 at nonce 6
        () => '2000' // route price 2000 > claim delta (7000 − 6000 = 1000)
      );
      server.setInboundClaimValidator((pd, pkt, peer) => validator.validate(pd, pkt, peer));

      const msg: BTPMessage = {
        type: BTPMessageType.MESSAGE,
        requestId: 12,
        data: {
          protocolData: [
            {
              protocolName: 'payment-channel-claim',
              contentType: 1,
              data: Buffer.from(JSON.stringify(solClaim(7)), 'utf8'),
            },
          ],
          ilpPacket: serializePacket(createILPPreparePacket()),
        },
      };
      await (server as any).handleMessage(makePeerConn(mockWs, 'peer-msg', true), msg);

      // Underpayment dies on local data (watermark + in-memory route price)
      // before the backend seam or any crypto verification.
      expect(mockPacketHandler.handlePreparePacket).not.toHaveBeenCalled();
      expect(verifyBalanceProof).not.toHaveBeenCalled();

      const parsed = parseBTPMessage(mockWs.sentMessages[0]!);
      expect(parsed.type).toBe(BTPMessageType.RESPONSE);
      const ilp = deserializePacket((parsed.data as BTPData).ilpPacket!);
      expect(ilp.type).toBe(PacketType.REJECT);
      expect((ilp as ILPRejectPacket).code).toBe(ILPErrorCode.F06_UNEXPECTED_PAYMENT);
      expect((ilp as ILPRejectPacket).message).toContain('Insufficient claim value');
    });

    it('passes when inbound claim validator returns null', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      server.setInboundClaimValidator(async () => null);
      mockPacketHandler.handlePreparePacket.mockResolvedValue(createILPFulfillPacket());
      const msg = createBTPMessageWithILP(serializePacket(createILPPreparePacket()), 5);
      await (server as any).handleMessage(makePeerConn(mockWs, 'peer-msg', true), msg);
      expect(mockPacketHandler.handlePreparePacket).toHaveBeenCalled();
    });

    it('returns FULFILL response', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      mockPacketHandler.handlePreparePacket.mockResolvedValue(createILPFulfillPacket());
      const msg = createBTPMessageWithILP(serializePacket(createILPPreparePacket()), 6);
      await (server as any).handleMessage(makePeerConn(mockWs, 'peer-msg', true), msg);
      expect(parseBTPMessage(mockWs.sentMessages[mockWs.sentMessages.length - 1]!).type).toBe(
        BTPMessageType.RESPONSE
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_response_sent', responseType: 'FULFILL' }),
        expect.any(String)
      );
    });

    it('returns REJECT response', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      mockPacketHandler.handlePreparePacket.mockResolvedValue(createILPRejectPacket());
      const msg = createBTPMessageWithILP(serializePacket(createILPPreparePacket()), 7);
      await (server as any).handleMessage(makePeerConn(mockWs, 'peer-msg', true), msg);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_response_sent', responseType: 'REJECT' }),
        expect.any(String)
      );
    });

    it('handles error and sends BTP ERROR', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      mockPacketHandler.handlePreparePacket.mockRejectedValue(new Error('Handler error'));
      const msg = createBTPMessageWithILP(serializePacket(createILPPreparePacket()), 8);
      await expect(
        (server as any).handleMessage(makePeerConn(mockWs, 'peer-msg', true), msg)
      ).rejects.toThrow('Handler error');
      expect(parseBTPMessage(mockWs.sentMessages[mockWs.sentMessages.length - 1]!).type).toBe(
        BTPMessageType.ERROR
      );
    });

    it('handles BTPError and sends it', async () => {
      const mockWs = new (jest.requireMock('ws').default)();
      mockPacketHandler.handlePreparePacket.mockImplementation(() => {
        throw new BTPError('F99', 'Custom BTP error');
      });
      const msg = createBTPMessageWithILP(serializePacket(createILPPreparePacket()), 9);
      await expect(
        (server as any).handleMessage(makePeerConn(mockWs, 'peer-msg', true), msg)
      ).rejects.toThrow('Custom BTP error');
      expect(parseBTPMessage(mockWs.sentMessages[mockWs.sentMessages.length - 1]!).type).toBe(
        BTPMessageType.ERROR
      );
    });

    it('handles error when ws not open', async () => {
      wsReadyStateOverride = WebSocket.CLOSED;
      const mockWs = new (jest.requireMock('ws').default)();
      mockPacketHandler.handlePreparePacket.mockRejectedValue(new Error('Handler error'));
      const msg = createBTPMessageWithILP(serializePacket(createILPPreparePacket()), 10);
      await expect(
        (server as any).handleMessage(makePeerConn(mockWs, 'peer-msg', true), msg)
      ).rejects.toThrow('Handler error');
      expect(mockWs.sentMessages.length).toBe(0);
      wsReadyStateOverride = null;
    });
  });

  it('setInboundClaimValidator stores validator', () => {
    const validator = async () => null;
    server.setInboundClaimValidator(validator);
    expect((server as any).inboundClaimValidator).toBe(validator);
  });
});
