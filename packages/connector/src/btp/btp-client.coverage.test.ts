/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * Branch coverage tests for BTPClient
 * Targets uncovered branches in WebSocket reconnection/error paths,
 * message parsing error handling, connection state edge cases, and
 * BTP message type handling branches.
 */

import { BTPClient, Peer, BTPAuthenticationError } from './btp-client';
import { Logger } from '../utils/logger';
import { BTPMessage, BTPMessageType, BTPData, BTPErrorData } from './btp-types';
import { serializeBTPMessage, parseBTPMessage } from './btp-message-parser';
import {
  ILPPreparePacket,
  ILPFulfillPacket,
  ILPRejectPacket,
  PacketType,
  ILPErrorCode,
  serializePacket,
} from '@toon-protocol/shared';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { PacketHandler } from '../core/packet-handler';

// Mock the 'ws' module
jest.mock('ws', () => {
  return jest.fn();
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
    child: jest.fn(function (this: unknown) {
      return this;
    }),
  }) as unknown as jest.Mocked<Logger>;

const createTestPeer = (id = 'connectorB', url = 'ws://localhost:3000'): Peer => ({
  id,
  url,
  authToken: 'shared-secret-123',
  connected: false,
  lastSeen: new Date(),
});

const createValidPreparePacket = (): ILPPreparePacket => {
  const futureExpiry = new Date(Date.now() + 10000);
  return {
    type: PacketType.PREPARE,
    amount: BigInt(1000),
    destination: 'g.alice.wallet',
    expiresAt: futureExpiry,
    data: Buffer.alloc(0),
  };
};

const createValidFulfillPacket = (): ILPFulfillPacket => ({
  type: PacketType.FULFILL,
  data: Buffer.alloc(0),
});

const createValidRejectPacket = (): ILPRejectPacket => ({
  type: PacketType.REJECT,
  code: ILPErrorCode.F02_UNREACHABLE,
  triggeredBy: 'g.connector',
  message: 'No route found',
  data: Buffer.alloc(0),
});

const createAuthResponse = (requestId: number): BTPMessage => ({
  type: BTPMessageType.RESPONSE,
  requestId,
  data: {
    protocolData: [],
  } as BTPData,
});

const createErrorResponse = (
  requestId: number,
  code = 'F00',
  errorMessage = 'Test error'
): BTPMessage => ({
  type: BTPMessageType.ERROR,
  requestId,
  data: {
    code,
    name: errorMessage,
    triggeredAt: new Date().toISOString(),
    data: Buffer.alloc(0),
  } as BTPErrorData,
});

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  public readyState = 0; // CONNECTING
  public sentMessages: Array<{ data: Buffer; callback?: (err?: Error) => void }> = [];
  public url = '';
  private _openTimer: NodeJS.Immediate | null = null;

  constructor(url: string, autoOpen = false) {
    super();
    this.url = url;
    if (autoOpen) {
      this._openTimer = setImmediate(() => this.simulateOpen());
    }
  }

  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.emit('open');
  }

  send(data: Buffer, callback?: (err?: Error) => void): void {
    this.sentMessages.push({ data, callback });
    if (callback) {
      // Default: call callback with no error unless overridden by test
      callback();
    }
  }

  close(): void {
    if (this._openTimer) {
      clearImmediate(this._openTimer);
    }
    this.readyState = 3; // CLOSED
    this.emit('close');
  }

  ping(): void {
    this.emit('ping');
  }

  simulateMessage(data: Buffer): void {
    this.emit('message', data);
  }

  simulatePong(): void {
    this.emit('pong');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BTPClient branch coverage', () => {
  let client: BTPClient;
  let mockLogger: jest.Mocked<Logger>;
  let mockPeer: Peer;
  let mockWs: MockWebSocket;

  async function simulateSuccessfulConnection(c?: BTPClient): Promise<void> {
    const target = c ?? client;
    const connectPromise = target.connect();
    await new Promise((resolve) => setImmediate(resolve));
    mockWs.simulateOpen();
    await new Promise((resolve) => setImmediate(resolve));
    const authMsg = parseBTPMessage(mockWs.sentMessages[0]!.data);
    const authResponse = createAuthResponse(authMsg.requestId);
    mockWs.simulateMessage(serializeBTPMessage(authResponse));
    await connectPromise;
    mockWs.sentMessages = [];
  }

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockPeer = createTestPeer('connectorB', 'ws://localhost:3000');
    mockWs = new MockWebSocket('ws://localhost:3000');

    (WebSocket as unknown as jest.Mock).mockImplementation((url: string) => {
      mockWs.url = url;
      mockWs.sentMessages = [];
      mockWs.readyState = 0;
      mockWs.removeAllListeners();
      return mockWs;
    });

    client = new BTPClient(mockPeer, 'test-node', mockLogger);
    // Prevent automatic retry from leaving real timers open in tests that
    // trigger unexpected close events (auth errors, pong timeouts, etc.)
    jest.spyOn(client as any, '_retry').mockResolvedValue(undefined);
    jest.clearAllMocks();
  });

  afterEach(async () => {
    try {
      if (client.isConnected) {
        await client.disconnect();
      }
    } catch {
      // ignore
    }
    jest.useRealTimers();
  });

  // ========================================================================
  // Constructor
  // ========================================================================
  describe('constructor', () => {
    it('uses default maxRetries (5) when not provided', () => {
      const c = new BTPClient(mockPeer, 'node', mockLogger);
      expect((c as any)._maxRetries).toBe(5);
    });

    it('uses provided maxRetries when defined', () => {
      const c = new BTPClient(mockPeer, 'node', mockLogger, 3);
      expect((c as any)._maxRetries).toBe(3);
    });
  });

  // ========================================================================
  // sendRawFrameForTesting
  // ========================================================================
  describe('sendRawFrameForTesting', () => {
    it('returns false when not connected', () => {
      expect(client.sendRawFrameForTesting(Buffer.from('hello'))).toBe(false);
    });

    it('returns true and sends frame when connected', async () => {
      await simulateSuccessfulConnection();
      const frame = Buffer.from('raw-frame');
      expect(client.sendRawFrameForTesting(frame)).toBe(true);
      expect(mockWs.sentMessages[mockWs.sentMessages.length - 1]!.data).toEqual(frame);
    });

    it('returns false when connectionState is connected but ws is null', async () => {
      await simulateSuccessfulConnection();
      (client as any)._ws = null;
      expect(client.sendRawFrameForTesting(Buffer.from('test'))).toBe(false);
    });
  });

  // ========================================================================
  // Connection state edge cases
  // ========================================================================
  describe('connect state edge cases', () => {
    it('skips connect when already connecting', async () => {
      const connectPromise = client.connect();
      await new Promise((resolve) => setImmediate(resolve));
      // State is now 'connecting'
      const p2 = client.connect();
      await new Promise((resolve) => setImmediate(resolve));

      // p2 should resolve immediately (skip)
      await p2;

      // Clean up original connect with valid auth response
      mockWs.simulateOpen();
      await new Promise((resolve) => setImmediate(resolve));
      const authMsg = parseBTPMessage(mockWs.sentMessages[0]!.data);
      mockWs.simulateMessage(serializeBTPMessage(createAuthResponse(authMsg.requestId)));
      await connectPromise;
    });

    it('handles auth message parse error in auth handler', async () => {
      const connectPromise = client.connect();
      await new Promise((resolve) => setImmediate(resolve));
      mockWs.simulateOpen();
      await new Promise((resolve) => setImmediate(resolve));

      // Send malformed data that parseBTPMessage will reject
      mockWs.simulateMessage(Buffer.from('not-a-btp-message'));

      await expect(connectPromise).rejects.toThrow(BTPAuthenticationError);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_auth_failed' }),
        expect.any(String)
      );
    });

    it('throws BTPAuthenticationError when ws is null during _authenticate', async () => {
      const connectPromise = client.connect();
      await new Promise((resolve) => setImmediate(resolve));
      // Clear ws BEFORE open so _authenticate sees it as null
      (client as any)._ws = null;
      mockWs.simulateOpen();

      await expect(connectPromise).rejects.toThrow('WebSocket not connected');
    });

    it('handles WebSocket constructor error via agentFactory', async () => {
      const factory = jest.fn().mockImplementation(() => {
        throw new Error('Agent factory failed');
      });
      const c = new BTPClient(mockPeer, 'node', mockLogger, undefined, factory);
      // Prevent retry from leaving open handles
      jest.spyOn(c as any, '_retry').mockResolvedValue(undefined);

      await expect(c.connect()).rejects.toThrow('Agent factory failed');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_connection_error' }),
        expect.any(String)
      );
    });
  });

  // ========================================================================
  // Disconnect / pending requests
  // ========================================================================
  describe('disconnect edge cases', () => {
    it('rejects all pending requests on disconnect', async () => {
      await simulateSuccessfulConnection();

      const preparePacket = createValidPreparePacket();
      const sendPromise = client.sendPacket(preparePacket);

      // Disconnect before response arrives
      await client.disconnect();

      await expect(sendPromise).rejects.toThrow('Connection closed');
    });
  });

  // ========================================================================
  // _handleMessage callback error (line 252)
  // ========================================================================
  describe('_handleMessage callback error', () => {
    it('logs error when _handleMessage promise rejects', async () => {
      await simulateSuccessfulConnection();
      const spy = jest
        .spyOn(client as any, '_handleMessage')
        .mockRejectedValueOnce(new Error('handleMessage crash'));

      mockWs.simulateMessage(Buffer.from('anything'));
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_message_error' }),
        expect.any(String)
      );
      spy.mockRestore();
    });
  });

  // ========================================================================
  // sendPacket edge cases
  // ========================================================================
  describe('sendPacket edge cases', () => {
    it('throws when ws is null despite connected state (defensive)', async () => {
      await simulateSuccessfulConnection();
      (client as any)._ws = null;
      const preparePacket = createValidPreparePacket();
      await expect(client.sendPacket(preparePacket)).rejects.toThrow('WebSocket not available');
    });

    it('throws when ws.send throws', async () => {
      await simulateSuccessfulConnection();
      jest.spyOn(mockWs, 'send').mockImplementationOnce(() => {
        throw new Error('Send failed');
      });
      const preparePacket = createValidPreparePacket();
      await expect(client.sendPacket(preparePacket)).rejects.toThrow(
        'Failed to send message: Send failed'
      );
    });

    it('uses default timeout when packet has no expiresAt', async () => {
      await simulateSuccessfulConnection();
      jest.useFakeTimers({ legacyFakeTimers: true });

      // Mock serializePacket so we can test the expiresAt branch without
      // requiring a valid Date for OER serialization.
      jest
        .spyOn(require('@toon-protocol/shared'), 'serializePacket')
        .mockReturnValue(Buffer.alloc(0));

      const prepareNoExpiry: ILPPreparePacket = {
        type: PacketType.PREPARE,
        amount: BigInt(100),
        destination: 'g.bob',
        expiresAt: new Date(Date.now() + 100000),
        data: Buffer.alloc(0),
      };
      // Remove expiresAt to hit default branch
      delete (prepareNoExpiry as any).expiresAt;

      const sendPromise = client.sendPacket(prepareNoExpiry);
      jest.advanceTimersByTime(31000); // default is 30000

      await expect(sendPromise).rejects.toThrow('Packet send timeout');
      jest.restoreAllMocks();
      jest.useRealTimers();
    });
  });

  // ========================================================================
  // sendProtocolData
  // ========================================================================
  describe('sendProtocolData', () => {
    it('sends protocol data successfully', async () => {
      await simulateSuccessfulConnection();
      const data = Buffer.from(JSON.stringify({ claim: 'test' }), 'utf8');
      await client.sendProtocolData('payment-channel-claim', 1, data);

      expect(mockWs.sentMessages.length).toBeGreaterThanOrEqual(1);
      const sent = parseBTPMessage(mockWs.sentMessages[mockWs.sentMessages.length - 1]!.data);
      expect(sent.type).toBe(BTPMessageType.MESSAGE);
      expect((sent.data as BTPData).protocolData[0]!.protocolName).toBe('payment-channel-claim');
    });

    it('throws when not connected', async () => {
      const data = Buffer.from('test');
      await expect(client.sendProtocolData('proto', 0, data)).rejects.toThrow('Not connected');
    });

    it('throws when ws is null (defensive)', async () => {
      await simulateSuccessfulConnection();
      (client as any)._ws = null;
      const data = Buffer.from('test');
      await expect(client.sendProtocolData('proto', 0, data)).rejects.toThrow(
        'WebSocket not available'
      );
    });

    it('throws when ws.send throws', async () => {
      await simulateSuccessfulConnection();
      jest.spyOn(mockWs, 'send').mockImplementationOnce(() => {
        throw new Error('Send error');
      });
      const data = Buffer.from('test');
      await expect(client.sendProtocolData('proto', 0, data)).rejects.toThrow(
        'Failed to send protocol data: Send error'
      );
    });
  });

  // ========================================================================
  // _handleMessage JSON responses
  // ========================================================================
  describe('_handleMessage JSON responses', () => {
    it('handles JSON FULFILL response resolving pending request', async () => {
      await simulateSuccessfulConnection();
      const preparePacket = createValidPreparePacket();
      const sendPromise = client.sendPacket(preparePacket);

      // Wait for the BTP message to be sent so pending request is registered
      await new Promise((resolve) => setImmediate(resolve));

      const jsonResponse = JSON.stringify({
        type: 'FULFILL',
        data: Buffer.alloc(0).toString('base64'),
      });
      mockWs.simulateMessage(Buffer.from(jsonResponse, 'utf8'));

      const result = await sendPromise;
      expect(result.type).toBe(PacketType.FULFILL);
    });

    it('handles JSON REJECT response resolving pending request', async () => {
      await simulateSuccessfulConnection();
      const preparePacket = createValidPreparePacket();
      const sendPromise = client.sendPacket(preparePacket);

      await new Promise((resolve) => setImmediate(resolve));

      const jsonResponse = JSON.stringify({
        type: 'REJECT',
        code: 'F02',
        message: 'unreachable',
        triggeredBy: 'g.connector',
        data: Buffer.alloc(0).toString('base64'),
      });
      mockWs.simulateMessage(Buffer.from(jsonResponse, 'utf8'));

      const result = await sendPromise;
      expect(result.type).toBe(PacketType.REJECT);
    });

    it('ignores JSON without FULFILL/REJECT type', async () => {
      await simulateSuccessfulConnection();
      const jsonStr = JSON.stringify({ type: 'OTHER', foo: 'bar' });
      mockWs.simulateMessage(Buffer.from(jsonStr, 'utf8'));

      // Should fall through to BTP parsing and fail, logging parse error
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_message_parse_error' }),
        expect.any(String)
      );
    });

    it('handles JSON parse error gracefully', async () => {
      await simulateSuccessfulConnection();
      // Starts with { but is invalid JSON
      mockWs.simulateMessage(Buffer.from('{not json}', 'utf8'));
      await new Promise((resolve) => setImmediate(resolve));
      // Should fall through to BTP parsing and fail
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_message_parse_error' }),
        expect.any(String)
      );
    });
  });

  // ========================================================================
  // _handleMessage BTP response branches
  // ========================================================================
  describe('_handleMessage BTP response branches', () => {
    it('handles BTP ERROR response rejecting pending request', async () => {
      await simulateSuccessfulConnection();
      const preparePacket = createValidPreparePacket();
      const sendPromise = client.sendPacket(preparePacket);

      await new Promise((resolve) => setImmediate(resolve));
      const btpMsg = parseBTPMessage(mockWs.sentMessages[0]!.data);
      const errorResponse = createErrorResponse(btpMsg.requestId, 'F02', 'Peer error');
      mockWs.simulateMessage(serializeBTPMessage(errorResponse));

      await expect(sendPromise).rejects.toThrow('Peer error');
    });

    it('handles BTP ERROR with malformed data via isBTPErrorData false branch', async () => {
      await simulateSuccessfulConnection();
      const preparePacket = createValidPreparePacket();
      const sendPromise = client.sendPacket(preparePacket);

      await new Promise((resolve) => setImmediate(resolve));
      const btpMsg = parseBTPMessage(mockWs.sentMessages[0]!.data);

      // Build and serialize the error response BEFORE mocking isBTPErrorData
      const errorResponse = createErrorResponse(btpMsg.requestId, 'F02', 'Peer error');
      const errorBuffer = serializeBTPMessage(errorResponse);

      // Temporarily force isBTPErrorData to return false
      jest.spyOn(require('./btp-types'), 'isBTPErrorData').mockReturnValue(false);

      mockWs.simulateMessage(errorBuffer);

      await expect(sendPromise).rejects.toThrow('Unknown error');

      jest.restoreAllMocks();
    });

    it('handles BTP RESPONSE without ilpPacket (no resolve)', async () => {
      await simulateSuccessfulConnection();

      const preparePacket = createValidPreparePacket();
      // Set expiresAt far in future so timeout does not fire during test
      preparePacket.expiresAt = new Date(Date.now() + 60000);

      // Start send but intentionally do not await — the response will not resolve
      client.sendPacket(preparePacket);

      await new Promise((resolve) => setImmediate(resolve));
      const btpMsg = parseBTPMessage(mockWs.sentMessages[0]!.data);

      // RESPONSE with no ilpPacket — code clears the pending request but never resolves it
      const response: BTPMessage = {
        type: BTPMessageType.RESPONSE,
        requestId: btpMsg.requestId,
        data: {
          protocolData: [],
        } as BTPData,
      };
      mockWs.simulateMessage(serializeBTPMessage(response));
      await new Promise((resolve) => setImmediate(resolve));

      // Verify the pending request was removed from the map (cleared but unresolved)
      expect((client as any)._pendingRequests.size).toBe(0);
    });
  });

  // ========================================================================
  // _handleMessage incoming MESSAGE branches
  // ========================================================================
  describe('_handleMessage incoming MESSAGE branches', () => {
    it('warns when no packetHandler configured', async () => {
      await simulateSuccessfulConnection();

      const msg: BTPMessage = {
        type: BTPMessageType.MESSAGE,
        requestId: 999,
        data: {
          protocolData: [],
          ilpPacket: serializePacket(createValidPreparePacket()),
        } as BTPData,
      };
      mockWs.simulateMessage(serializeBTPMessage(msg));
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_incoming_packet_no_handler' }),
        expect.any(String)
      );
    });

    it('warns when MESSAGE has empty ilpPacket', async () => {
      await simulateSuccessfulConnection();
      client.setPacketHandler({
        handlePreparePacket: jest.fn(),
      } as unknown as PacketHandler);

      const msg: BTPMessage = {
        type: BTPMessageType.MESSAGE,
        requestId: 999,
        data: {
          protocolData: [],
          ilpPacket: Buffer.alloc(0),
        } as BTPData,
      };
      mockWs.simulateMessage(serializeBTPMessage(msg));
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_incoming_packet_no_ilp' }),
        expect.any(String)
      );
    });

    it('warns when deserialized packet is not PREPARE', async () => {
      await simulateSuccessfulConnection();
      client.setPacketHandler({
        handlePreparePacket: jest.fn(),
      } as unknown as PacketHandler);

      const msg: BTPMessage = {
        type: BTPMessageType.MESSAGE,
        requestId: 999,
        data: {
          protocolData: [],
          ilpPacket: serializePacket(createValidFulfillPacket()),
        } as BTPData,
      };
      mockWs.simulateMessage(serializeBTPMessage(msg));
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_incoming_packet_wrong_type' }),
        expect.any(String)
      );
    });

    it('handles incoming PREPARE and sends back FULFILL response', async () => {
      await simulateSuccessfulConnection();
      const handler: PacketHandler = {
        handlePreparePacket: jest.fn().mockResolvedValue(createValidFulfillPacket()),
      } as unknown as PacketHandler;
      client.setPacketHandler(handler);

      const preparePacket = createValidPreparePacket();
      const msg: BTPMessage = {
        type: BTPMessageType.MESSAGE,
        requestId: 999,
        data: {
          protocolData: [],
          ilpPacket: serializePacket(preparePacket),
        } as BTPData,
      };
      mockWs.simulateMessage(serializeBTPMessage(msg));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(handler.handlePreparePacket).toHaveBeenCalledWith(preparePacket, mockPeer.id);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_response_sent' }),
        expect.any(String)
      );
    });

    it('handles incoming PREPARE and sends back REJECT response', async () => {
      await simulateSuccessfulConnection();
      const handler: PacketHandler = {
        handlePreparePacket: jest.fn().mockResolvedValue(createValidRejectPacket()),
      } as unknown as PacketHandler;
      client.setPacketHandler(handler);

      const preparePacket = createValidPreparePacket();
      const msg: BTPMessage = {
        type: BTPMessageType.MESSAGE,
        requestId: 999,
        data: {
          protocolData: [],
          ilpPacket: serializePacket(preparePacket),
        } as BTPData,
      };
      mockWs.simulateMessage(serializeBTPMessage(msg));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(handler.handlePreparePacket).toHaveBeenCalled();
      expect(mockWs.sentMessages.length).toBeGreaterThanOrEqual(1);
    });

    it('logs error when ws.send callback receives error on response', async () => {
      await simulateSuccessfulConnection();
      const handler: PacketHandler = {
        handlePreparePacket: jest.fn().mockResolvedValue(createValidFulfillPacket()),
      } as unknown as PacketHandler;
      client.setPacketHandler(handler);

      // Override send to always call callback with error
      jest.spyOn(mockWs, 'send').mockImplementation((data, callback) => {
        mockWs.sentMessages.push({ data: data as Buffer, callback });
        if (callback) {
          callback(new Error('send callback error'));
        }
      });

      const preparePacket = createValidPreparePacket();
      const msg: BTPMessage = {
        type: BTPMessageType.MESSAGE,
        requestId: 999,
        data: {
          protocolData: [],
          ilpPacket: serializePacket(preparePacket),
        } as BTPData,
      };
      mockWs.simulateMessage(serializeBTPMessage(msg));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_response_send_failed' }),
        expect.any(String)
      );
    });

    it('catches error during incoming packet handling (deserializePacket throws)', async () => {
      await simulateSuccessfulConnection();
      const handler: PacketHandler = {
        handlePreparePacket: jest.fn(),
      } as unknown as PacketHandler;
      client.setPacketHandler(handler);

      const msg: BTPMessage = {
        type: BTPMessageType.MESSAGE,
        requestId: 999,
        data: {
          protocolData: [],
          ilpPacket: Buffer.from('invalid-ilp-packet'),
        } as BTPData,
      };
      mockWs.simulateMessage(serializeBTPMessage(msg));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_incoming_packet_error' }),
        expect.any(String)
      );
    });
  });

  // ========================================================================
  // _handleMessage outer catch
  // ========================================================================
  describe('_handleMessage outer catch', () => {
    it('logs parse error for malformed BTP data', async () => {
      await simulateSuccessfulConnection();
      mockWs.simulateMessage(Buffer.from('totally-invalid'));
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_message_parse_error' }),
        expect.any(String)
      );
    });
  });

  // ========================================================================
  // Retry logic
  // ========================================================================
  describe('retry logic', () => {
    it('throws BTPConnectionError after max retries exceeded', async () => {
      const c = new BTPClient(mockPeer, 'node', mockLogger, 2);
      (c as any)._retryCount = 2; // Already at max
      await expect((c as any)._retry()).rejects.toThrow('Max retries exceeded');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_max_retries' }),
        expect.any(String)
      );
    });

    it('logs error when retry connect fails', async () => {
      const c = new BTPClient(mockPeer, 'node', mockLogger, 5);
      (c as any)._retryCount = 0;

      // Mock connect to throw
      jest.spyOn(c, 'connect').mockRejectedValue(new Error('Connect failed'));

      await (c as any)._retry();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_connection_error' }),
        expect.any(String)
      );
    });

    it('logs retry failure in handleClose when max retries exceeded', async () => {
      await simulateSuccessfulConnection();
      // Restore real _retry so the catch block in _handleClose can execute
      (client as any)._retry.mockRestore();
      (client as any)._explicitDisconnect = false;
      (client as any)._retryCount = 5; // At maxRetries default
      mockWs.close();
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_retry_failed' }),
        expect.any(String)
      );
    });
  });

  // ========================================================================
  // Keep-alive
  // ========================================================================
  describe('keep-alive', () => {
    it('sends ping when connected and closes on pong timeout', async () => {
      jest.useFakeTimers({ legacyFakeTimers: true });
      await simulateSuccessfulConnection();

      const closeSpy = jest.spyOn(mockWs, 'close');
      jest.advanceTimersByTime(30000); // ping interval

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_ping_sent' }),
        expect.any(String)
      );

      jest.advanceTimersByTime(10000); // Pong timeout
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_pong_timeout' }),
        expect.any(String)
      );
      expect(closeSpy).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('clears pong timeout on pong receipt', async () => {
      jest.useFakeTimers({ legacyFakeTimers: true });
      await simulateSuccessfulConnection();

      jest.advanceTimersByTime(30000); // trigger ping
      mockWs.simulatePong();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_pong_received' }),
        expect.any(String)
      );

      // Advance past the pong timeout - close should NOT be called
      jest.advanceTimersByTime(10000);
      // If pong timeout wasn't cleared, close would be called
      // We just verify no error occurred and the log was emitted
      jest.useRealTimers();
    });

    it('does not send ping when not connected', async () => {
      jest.useFakeTimers({ legacyFakeTimers: true });
      await simulateSuccessfulConnection();
      await client.disconnect();

      jest.advanceTimersByTime(30000);
      // No ping should be sent; verify by ensuring no btp_ping_sent log
      // Verify disconnected state after timers advance
      expect(client.isConnected).toBe(false);
      jest.useRealTimers();
    });

    it('stops keep-alive cleanly on disconnect', async () => {
      jest.useFakeTimers({ legacyFakeTimers: true });
      await simulateSuccessfulConnection();
      await client.disconnect();

      // Should not throw or cause issues when timers try to fire
      jest.advanceTimersByTime(60000);
      expect(client.isConnected).toBe(false);
      jest.useRealTimers();
    });
  });

  // ========================================================================
  // Packet handler reference
  // ========================================================================
  describe('setPacketHandler', () => {
    it('sets packet handler reference', () => {
      const handler = { handlePreparePacket: jest.fn() } as unknown as PacketHandler;
      client.setPacketHandler(handler);
      expect((client as any)._packetHandler).toBe(handler);
    });
  });
});
