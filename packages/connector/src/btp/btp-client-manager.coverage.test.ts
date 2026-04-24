/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * Branch coverage tests for BTPClientManager
 * Targets uncovered branches in setPacketHandler, addPeer packetHandler wiring,
 * sendToPeer connection/timeout/error paths, health-check helpers, and event
 * listener callback branches.
 */

import { BTPClientManager } from './btp-client-manager';
import { BTPClient, Peer, BTPConnectionError } from './btp-client';
import { Logger } from '../utils/logger';
import { ILPPreparePacket, ILPFulfillPacket, PacketType } from '@toon-protocol/shared';

// Mock BTPClient at module level, but keep BTPConnectionError and
// BTPAuthenticationError as real classes so instanceof and .message work.
jest.mock('./btp-client', () => {
  const actual = jest.requireActual('./btp-client');
  return {
    ...actual,
    BTPClient: jest.fn(),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    child: jest.fn().mockReturnThis(),
  }) as unknown as jest.Mocked<Logger>;

const createTestPeer = (id: string, overrides?: Partial<Peer>): Peer => ({
  id,
  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
  url: `ws://connector-${id}:3000`,
  authToken: `secret-${id}`,
  connected: false,
  lastSeen: new Date(),
  ...overrides,
});

const createTestPreparePacket = (expiresAt?: Date): ILPPreparePacket => ({
  type: PacketType.PREPARE,
  amount: BigInt(1000),
  destination: 'g.test.destination',
  expiresAt: expiresAt ?? new Date(Date.now() + 10000),
  data: Buffer.alloc(0),
});

/**
 * Build a mock BTPClient whose `isConnected` is a real getter so it can be
 * toggled dynamically in tests.
 */
const createMockBTPClient = (connected = true): jest.Mocked<BTPClient> => {
  const state = { connected };
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    sendPacket: jest.fn(),
    setPacketHandler: jest.fn(),
    on: jest.fn(),
    get isConnected() {
      return state.connected;
    },
    set isConnected(value: boolean) {
      state.connected = value;
    },
  } as unknown as jest.Mocked<BTPClient>;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BTPClientManager branch coverage', () => {
  let manager: BTPClientManager;
  let mockLogger: jest.Mocked<Logger>;
  let MockedBTPClient: jest.MockedClass<typeof BTPClient>;
  const pendingNeverRejecters: Array<(reason?: unknown) => void> = [];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    jest.clearAllTimers();
    pendingNeverRejecters.length = 0;
    mockLogger = createMockLogger();
    manager = new BTPClientManager('test-node', mockLogger);
    MockedBTPClient = BTPClient as jest.MockedClass<typeof BTPClient>;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllTimers();
    // Reject any never-resolving promises so Jest can exit cleanly
    for (const reject of pendingNeverRejecters) {
      reject(new Error('test cleanup'));
    }
    pendingNeverRejecters.length = 0;
  });

  // ========================================================================
  // setPacketHandler with existing clients
  // ========================================================================
  describe('setPacketHandler', () => {
    it('updates packetHandler on existing clients when some are already stored', async () => {
      const peerA = createTestPeer('peerA');
      const peerB = createTestPeer('peerB');
      const mockClientA = createMockBTPClient();
      const mockClientB = createMockBTPClient();

      MockedBTPClient.mockImplementationOnce(
        () => mockClientA as unknown as BTPClient
      ).mockImplementationOnce(() => mockClientB);

      await manager.addPeer(peerA);
      await manager.addPeer(peerB);

      const handler = {
        handlePreparePacket: jest.fn(),
      } as unknown as import('../core/packet-handler').PacketHandler;

      manager.setPacketHandler(handler);

      expect(mockClientA.setPacketHandler).toHaveBeenCalledWith(handler);
      expect(mockClientB.setPacketHandler).toHaveBeenCalledWith(handler);
    });

    it('does nothing when no clients exist', () => {
      const handler = {
        handlePreparePacket: jest.fn(),
      } as unknown as import('../core/packet-handler').PacketHandler;
      manager.setPacketHandler(handler);
      // No errors, no calls
      expect(mockLogger.info).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // addPeer branches
  // ========================================================================
  describe('addPeer branches', () => {
    it('wires packetHandler to new client when handler is already set', async () => {
      const handler = {
        handlePreparePacket: jest.fn(),
      } as unknown as import('../core/packet-handler').PacketHandler;
      manager.setPacketHandler(handler);

      const peer = createTestPeer('peerZ');
      const mockClient = createMockBTPClient();
      MockedBTPClient.mockImplementation(() => mockClient as unknown as BTPClient);

      await manager.addPeer(peer);

      expect(mockClient.setPacketHandler).toHaveBeenCalledWith(handler);
    });

    it('handles non-Error rejection from connect (line 132 false branch)', async () => {
      const peer = createTestPeer('peerNonError');
      const mockClient = {
        ...createMockBTPClient(),
        connect: jest.fn().mockRejectedValue('string-rejection'),
      };
      MockedBTPClient.mockImplementation(() => mockClient as unknown as BTPClient);

      await manager.addPeer(peer);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'btp_client_add_peer_failed',
          peerId: 'peerNonError',
          error: 'string-rejection',
        }),
        expect.any(String)
      );
      expect(manager.getPeerStatus().has('peerNonError')).toBe(true);
    });
  });

  // ========================================================================
  // sendToPeer branches
  // ========================================================================
  describe('sendToPeer branches', () => {
    it('throws BTPConnectionError when peer is not connected', async () => {
      const peer = createTestPeer('peerNotConn');
      const mockClient = createMockBTPClient(false);
      MockedBTPClient.mockImplementation(() => mockClient as unknown as BTPClient);

      await manager.addPeer(peer);

      const packet = createTestPreparePacket();
      try {
        await manager.sendToPeer('peerNotConn', packet);
        fail('Expected sendToPeer to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(BTPConnectionError);
        expect((error as Error).message).toBe('BTP connection to peerNotConn not established');
      }

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'btp_client_not_connected',
          peerId: 'peerNotConn',
        }),
        expect.any(String)
      );
    });

    it('uses env fallback timeout when packet has no expiresAt', async () => {
      const originalEnv = process.env.BTP_SEND_TIMEOUT_MS;
      process.env.BTP_SEND_TIMEOUT_MS = '100';

      try {
        jest.useFakeTimers({ legacyFakeTimers: true });
        const peer = createTestPeer('peerNoExpiry');
        const mockClient = createMockBTPClient();
        mockClient.sendPacket.mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              pendingNeverRejecters.push(reject as unknown as (reason?: unknown) => void);
            })
        );
        MockedBTPClient.mockImplementation(() => mockClient as unknown as BTPClient);

        await manager.addPeer(peer);

        const packet = createTestPreparePacket();
        delete (packet as unknown as Record<string, unknown>).expiresAt;

        const sendPromise = manager.sendToPeer('peerNoExpiry', packet);
        jest.advanceTimersByTime(101);

        try {
          await sendPromise;
          fail('Expected sendToPeer to reject');
        } catch (error) {
          expect((error as Error).message).toContain('BTP send timeout');
        }
      } finally {
        jest.useRealTimers();
        if (originalEnv === undefined) {
          delete process.env.BTP_SEND_TIMEOUT_MS;
        } else {
          process.env.BTP_SEND_TIMEOUT_MS = originalEnv;
        }
      }
    });

    it('uses default 30000ms fallback when env var and expiresAt are missing', async () => {
      const originalEnv = process.env.BTP_SEND_TIMEOUT_MS;
      delete process.env.BTP_SEND_TIMEOUT_MS;

      try {
        jest.useFakeTimers({ legacyFakeTimers: true });
        const peer = createTestPeer('peerDefaultTimeout');
        const mockClient = createMockBTPClient();
        mockClient.sendPacket.mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              pendingNeverRejecters.push(reject as unknown as (reason?: unknown) => void);
            })
        );
        MockedBTPClient.mockImplementation(() => mockClient as unknown as BTPClient);

        await manager.addPeer(peer);

        const packet = createTestPreparePacket();
        delete (packet as unknown as Record<string, unknown>).expiresAt;

        const sendPromise = manager.sendToPeer('peerDefaultTimeout', packet);
        jest.advanceTimersByTime(30001);

        try {
          await sendPromise;
          fail('Expected sendToPeer to reject');
        } catch (error) {
          expect((error as Error).message).toContain('30000ms');
        }
      } finally {
        jest.useRealTimers();
        if (originalEnv !== undefined) {
          process.env.BTP_SEND_TIMEOUT_MS = originalEnv;
        }
      }
    });

    it('uses 1000ms floor when remaining time is very short', async () => {
      jest.useFakeTimers({ legacyFakeTimers: true });
      const peer = createTestPeer('peerShortExpiry');
      const mockClient = createMockBTPClient();
      mockClient.sendPacket.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            pendingNeverRejecters.push(reject as unknown as (reason?: unknown) => void);
          })
      );
      MockedBTPClient.mockImplementation(() => mockClient as unknown as BTPClient);

      await manager.addPeer(peer);

      // expiresAt is 200ms in the future: remaining - 500 = negative, so Math.max -> 1000
      const packet = createTestPreparePacket(new Date(Date.now() + 200));

      const sendPromise = manager.sendToPeer('peerShortExpiry', packet);
      jest.advanceTimersByTime(1001);

      try {
        await sendPromise;
        fail('Expected sendToPeer to reject');
      } catch (error) {
        expect((error as Error).message).toContain('BTP send timeout');
      }
      jest.useRealTimers();
    });

    it('logs non-Error rejection from sendPacket (line 239 false branch)', async () => {
      const peer = createTestPeer('peerNonErrorSend');
      const mockClient = createMockBTPClient();
      mockClient.sendPacket.mockRejectedValue('send-fail');
      MockedBTPClient.mockImplementation(() => mockClient as unknown as BTPClient);

      await manager.addPeer(peer);

      const packet = createTestPreparePacket();
      await expect(manager.sendToPeer('peerNonErrorSend', packet)).rejects.toBe('send-fail');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'btp_client_send_failed',
          peerId: 'peerNonErrorSend',
          error: 'send-fail',
        }),
        expect.any(String)
      );
    });

    it('passes protocolData when provided', async () => {
      const peer = createTestPeer('peerProto');
      const fulfillResponse: ILPFulfillPacket = {
        type: PacketType.FULFILL,
        data: Buffer.alloc(0),
      };
      const mockClient = createMockBTPClient();
      mockClient.sendPacket.mockResolvedValue(fulfillResponse);
      MockedBTPClient.mockImplementation(() => mockClient as unknown as BTPClient);

      await manager.addPeer(peer);

      const protocolData = [{ protocolName: 'test', contentType: 1, data: Buffer.from('data') }];
      const packet = createTestPreparePacket();
      const response = await manager.sendToPeer('peerProto', packet, protocolData);

      expect(response).toEqual(fulfillResponse);
      expect(mockClient.sendPacket).toHaveBeenCalledWith(packet, protocolData);
    });

    it('wins the race when sendPacket resolves before timeout', async () => {
      const peer = createTestPeer('peerRaceWin');
      const fulfillResponse: ILPFulfillPacket = {
        type: PacketType.FULFILL,
        data: Buffer.alloc(0),
      };
      const mockClient = createMockBTPClient();
      mockClient.sendPacket.mockResolvedValue(fulfillResponse);
      MockedBTPClient.mockImplementation(() => mockClient as unknown as BTPClient);

      await manager.addPeer(peer);

      const packet = createTestPreparePacket();
      const response = await manager.sendToPeer('peerRaceWin', packet);

      expect(response).toEqual(fulfillResponse);
    });
  });

  // ========================================================================
  // Health-check helpers
  // ========================================================================
  describe('health-check helpers', () => {
    it('getConnectedPeerCount returns 0 with no peers', () => {
      expect(manager.getConnectedPeerCount()).toBe(0);
    });

    it('getConnectedPeerCount returns count of connected peers only', async () => {
      const peerA = createTestPeer('ha');
      const peerB = createTestPeer('hb');
      const peerC = createTestPeer('hc');

      MockedBTPClient.mockImplementationOnce(() => createMockBTPClient(true))
        .mockImplementationOnce(() => createMockBTPClient(false))
        .mockImplementationOnce(() => createMockBTPClient(true));

      await manager.addPeer(peerA);
      await manager.addPeer(peerB);
      await manager.addPeer(peerC);

      expect(manager.getConnectedPeerCount()).toBe(2);
    });

    it('getConnectionHealth returns 100 when no peers configured', () => {
      expect(manager.getConnectionHealth()).toBe(100);
    });

    it('getConnectionHealth calculates percentage correctly', async () => {
      const peerA = createTestPeer('ha');
      const peerB = createTestPeer('hb');

      MockedBTPClient.mockImplementationOnce(() =>
        createMockBTPClient(true)
      ).mockImplementationOnce(() => createMockBTPClient(false));

      await manager.addPeer(peerA);
      await manager.addPeer(peerB);

      expect(manager.getConnectionHealth()).toBe(50);
    });

    it('getConnectionHealth returns 0 when all peers disconnected', async () => {
      const peerA = createTestPeer('ha');
      const peerB = createTestPeer('hb');

      MockedBTPClient.mockImplementationOnce(() =>
        createMockBTPClient(false)
      ).mockImplementationOnce(() => createMockBTPClient(false));

      await manager.addPeer(peerA);
      await manager.addPeer(peerB);

      expect(manager.getConnectionHealth()).toBe(0);
    });

    it('getTotalPeerCount returns correct size', async () => {
      const peerA = createTestPeer('ha');
      const peerB = createTestPeer('hb');

      MockedBTPClient.mockImplementation(() => createMockBTPClient());

      expect(manager.getTotalPeerCount()).toBe(0);
      await manager.addPeer(peerA);
      expect(manager.getTotalPeerCount()).toBe(1);
      await manager.addPeer(peerB);
      expect(manager.getTotalPeerCount()).toBe(2);
    });
  });

  // ========================================================================
  // Event listener callbacks (coverage of inner log branches)
  // ========================================================================
  describe('event listener callback branches', () => {
    it('connected callback logs with correct peerId', async () => {
      const peer = createTestPeer('peerEvtConn');
      let connectedHandler: (() => void) | undefined;

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        sendPacket: jest.fn(),
        get isConnected() {
          return true;
        },
        on: jest.fn((event, handler) => {
          if (event === 'connected') connectedHandler = handler;
        }),
      } as unknown as jest.Mocked<BTPClient>;

      MockedBTPClient.mockImplementation(() => mockClient as unknown as BTPClient);
      await manager.addPeer(peer);
      jest.clearAllMocks();

      connectedHandler?.();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_client_connected', peerId: 'peerEvtConn' }),
        expect.any(String)
      );
    });

    it('disconnected callback logs with correct peerId', async () => {
      const peer = createTestPeer('peerEvtDisc');
      let disconnectedHandler: (() => void) | undefined;

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        sendPacket: jest.fn(),
        get isConnected() {
          return true;
        },
        on: jest.fn((event, handler) => {
          if (event === 'disconnected') disconnectedHandler = handler;
        }),
      } as unknown as jest.Mocked<BTPClient>;

      MockedBTPClient.mockImplementation(() => mockClient as unknown as BTPClient);
      await manager.addPeer(peer);
      jest.clearAllMocks();

      disconnectedHandler?.();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_client_disconnected', peerId: 'peerEvtDisc' }),
        expect.any(String)
      );
    });

    it('error callback redacts .anon in message and logs correctly', async () => {
      const peer = createTestPeer('peerEvtErr');
      let errorHandler: ((error: Error) => void) | undefined;

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        sendPacket: jest.fn(),
        get isConnected() {
          return true;
        },
        on: jest.fn((event, handler) => {
          if (event === 'error') errorHandler = handler;
        }),
      } as unknown as jest.Mocked<BTPClient>;

      MockedBTPClient.mockImplementation(() => mockClient as unknown as BTPClient);
      await manager.addPeer(peer);
      jest.clearAllMocks();

      const anonError = new Error('Connection to wss://abc123.anon failed');
      errorHandler?.(anonError);

      const errorLogCall = (mockLogger.error as jest.Mock).mock.calls.find(
        (call) => call[0]?.event === 'btp_client_error'
      );
      expect(errorLogCall).toBeDefined();
      expect(errorLogCall![0].error).not.toContain('.anon');
      expect(errorLogCall![0].peerId).toBe('peerEvtErr');
    });
  });

  // ========================================================================
  // setAgentFactory branches
  // ========================================================================
  describe('setAgentFactory', () => {
    it('sets factory and forwards it through 5-arg constructor', async () => {
      const factory = jest.fn().mockReturnValue(undefined);
      manager.setAgentFactory(factory);

      const peer = createTestPeer('peerFactory');
      MockedBTPClient.mockImplementation(() => createMockBTPClient());

      await manager.addPeer(peer);

      expect(MockedBTPClient).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'peerFactory' }),
        'test-node',
        mockLogger,
        undefined,
        factory
      );
    });

    it('allows null to disable factory (falls back to 3-arg constructor)', async () => {
      manager.setAgentFactory(() => ({}) as import('http').Agent);
      manager.setAgentFactory(null);

      const peer = createTestPeer('peerNoFactory');
      MockedBTPClient.mockImplementation(() => createMockBTPClient());

      await manager.addPeer(peer);

      expect(MockedBTPClient).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'peerNoFactory' }),
        'test-node',
        mockLogger
      );
    });
  });

  // ========================================================================
  // removePeer branches
  // ========================================================================
  describe('removePeer branches', () => {
    it('removes peer even when disconnect resolves successfully (finally branch)', async () => {
      const peer = createTestPeer('peerRemOk');
      const mockClient = createMockBTPClient();
      MockedBTPClient.mockImplementation(() => mockClient as unknown as BTPClient);

      await manager.addPeer(peer);
      await manager.removePeer('peerRemOk');

      expect(mockClient.disconnect).toHaveBeenCalled();
      expect(manager.getPeerStatus().has('peerRemOk')).toBe(false);
    });
  });

  // ========================================================================
  // sendToPeer error propagation branches
  // ========================================================================
  describe('sendToPeer error propagation', () => {
    it('re-throws BTPConnectionError from sendPacket with correct log', async () => {
      const peer = createTestPeer('peerErrProp');
      const mockClient = createMockBTPClient();
      const btpErr = new BTPConnectionError('send exploded');
      mockClient.sendPacket.mockRejectedValue(btpErr);
      MockedBTPClient.mockImplementation(() => mockClient as unknown as BTPClient);

      await manager.addPeer(peer);

      const packet = createTestPreparePacket();
      try {
        await manager.sendToPeer('peerErrProp', packet);
        fail('Expected sendToPeer to reject');
      } catch (error) {
        expect((error as Error).message).toBe('send exploded');
      }

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'btp_client_send_failed',
          peerId: 'peerErrProp',
          error: 'send exploded',
        }),
        expect.any(String)
      );
    });

    it('re-throws plain Error from sendPacket', async () => {
      const peer = createTestPeer('peerPlainErr');
      const mockClient = createMockBTPClient();
      mockClient.sendPacket.mockRejectedValue(new Error('plain error'));
      MockedBTPClient.mockImplementation(() => mockClient as unknown as BTPClient);

      await manager.addPeer(peer);

      const packet = createTestPreparePacket();
      await expect(manager.sendToPeer('peerPlainErr', packet)).rejects.toThrow('plain error');
    });
  });
});
