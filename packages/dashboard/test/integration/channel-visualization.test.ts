/**
 * Payment Channel Visualization Integration Test (Story 8.10)
 *
 * Tests end-to-end event flow from connector to dashboard for payment channels.
 * Validates PAYMENT_CHANNEL_OPENED, PAYMENT_CHANNEL_BALANCE_UPDATE, and
 * PAYMENT_CHANNEL_SETTLED events.
 *
 * Test Flow:
 * 1. Start telemetry server
 * 2. Connect mock connector and dashboard client
 * 3. Emit PAYMENT_CHANNEL_OPENED event
 * 4. Verify channel state stored and broadcasted
 * 5. Emit PAYMENT_CHANNEL_BALANCE_UPDATE event
 * 6. Verify balance update stored and broadcasted
 * 7. Emit PAYMENT_CHANNEL_SETTLED event
 * 8. Verify settlement stored and broadcasted
 * 9. Test REST API /api/channels endpoint
 *
 * @packageDocumentation
 */

import WebSocket from 'ws';
import { TelemetryServer } from '../../server/telemetry-server.js';
import { logger } from '../../server/logger.js';
import type {
  PaymentChannelOpenedEvent,
  PaymentChannelBalanceUpdateEvent,
  PaymentChannelSettledEvent,
} from '@m2m/shared';

// Test timeout - 10 seconds
jest.setTimeout(10000);

describe('Payment Channel Visualization Integration Tests', () => {
  let telemetryServer: TelemetryServer;
  let connectorWs: WebSocket;
  let clientWs: WebSocket;
  const TEST_PORT = 19000; // Use different port to avoid conflicts

  /**
   * Helper: Wait for WebSocket to be ready
   */
  function waitForSocketReady(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
      setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000);
    });
  }

  /**
   * Helper: Wait for specific message type on WebSocket
   */
  function waitForMessage(
    ws: WebSocket,
    messageType: string,
    timeoutMs: number = 2000
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.removeAllListeners('message');
        reject(new Error(`Timeout waiting for ${messageType} message`));
      }, timeoutMs);

      const handler = (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === messageType) {
            clearTimeout(timeout);
            ws.removeListener('message', handler);
            resolve(message);
          }
        } catch (error) {
          // Ignore parse errors, continue waiting
        }
      };

      ws.on('message', handler);
    });
  }

  beforeEach(async () => {
    // Start telemetry server
    telemetryServer = new TelemetryServer(TEST_PORT, logger);
    telemetryServer.start();

    // Give server time to start
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  afterEach(async () => {
    // Close all WebSocket connections and wait for them to close
    const closePromises: Promise<void>[] = [];

    if (connectorWs) {
      const closePromise = new Promise<void>((resolve) => {
        if (connectorWs.readyState === WebSocket.CLOSED) {
          resolve();
        } else {
          connectorWs.once('close', () => resolve());
          if (connectorWs.readyState === WebSocket.OPEN) {
            connectorWs.close();
          }
        }
      });
      closePromises.push(closePromise);
    }

    if (clientWs) {
      const closePromise = new Promise<void>((resolve) => {
        if (clientWs.readyState === WebSocket.CLOSED) {
          resolve();
        } else {
          clientWs.once('close', () => resolve());
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close();
          }
        }
      });
      closePromises.push(closePromise);
    }

    // Wait for all sockets to close
    await Promise.all(closePromises);

    // Remove all event listeners to prevent memory leaks
    if (connectorWs) {
      connectorWs.removeAllListeners();
    }
    if (clientWs) {
      clientWs.removeAllListeners();
    }

    // Stop telemetry server
    if (telemetryServer) {
      telemetryServer.stop();
    }

    // Wait for cleanup and server shutdown
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  test('Channel opened event flow - connector to dashboard', async () => {
    // Arrange: Connect dashboard client first
    clientWs = new WebSocket(`ws://localhost:${TEST_PORT}`);
    await waitForSocketReady(clientWs);

    // Register as dashboard client
    clientWs.send(JSON.stringify({ type: 'CLIENT_CONNECT' }));

    // Wait for client registration to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Act: Connect mock connector and emit PAYMENT_CHANNEL_OPENED event
    connectorWs = new WebSocket(`ws://localhost:${TEST_PORT}`);
    await waitForSocketReady(connectorWs);

    const channelOpenedEvent: PaymentChannelOpenedEvent = {
      type: 'PAYMENT_CHANNEL_OPENED',
      timestamp: Date.now(),
      nodeId: 'test-connector-a',
      channelId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      participants: [
        '0xaabbccddee11223344556677889900112233445566',
        '0x1122334455667788990011223344556677889900aa',
      ],
      tokenAddress: '0x7f5c764cbc14f9669b88837ca1490cca17c31607',
      tokenSymbol: 'USDC',
      settlementTimeout: 86400,
      initialDeposits: {
        '0xaabbccddee11223344556677889900112233445566': '1000000000',
        '0x1122334455667788990011223344556677889900aa': '1000000000',
      },
    };

    // Wait for client to receive the event
    const clientEventPromise = waitForMessage(clientWs, 'PAYMENT_CHANNEL_OPENED');

    // Send event from connector
    connectorWs.send(JSON.stringify(channelOpenedEvent));

    // Assert: Verify client received channel opened event
    const receivedEvent = await clientEventPromise;
    expect(receivedEvent.type).toBe('PAYMENT_CHANNEL_OPENED');
    expect(receivedEvent.channelId).toBe(channelOpenedEvent.channelId);
    expect(receivedEvent.nodeId).toBe('test-connector-a');
    expect(receivedEvent.tokenSymbol).toBe('USDC');
    expect(receivedEvent.participants).toEqual(channelOpenedEvent.participants);

    // Assert: Verify channel state stored in telemetry server
    const channels = telemetryServer.getChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]?.channelId).toBe(channelOpenedEvent.channelId);
    expect(channels[0]?.status).toBe('active');
    expect(channels[0]?.tokenSymbol).toBe('USDC');
    expect(channels[0]?.currentBalances.myNonce).toBe(0);
    expect(channels[0]?.currentBalances.theirNonce).toBe(0);
  });

  test('Channel balance update event flow', async () => {
    // Arrange: Open channel first
    clientWs = new WebSocket(`ws://localhost:${TEST_PORT}`);
    await waitForSocketReady(clientWs);
    clientWs.send(JSON.stringify({ type: 'CLIENT_CONNECT' }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    connectorWs = new WebSocket(`ws://localhost:${TEST_PORT}`);
    await waitForSocketReady(connectorWs);

    const channelId = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

    const channelOpenedEvent: PaymentChannelOpenedEvent = {
      type: 'PAYMENT_CHANNEL_OPENED',
      timestamp: Date.now(),
      nodeId: 'test-connector-a',
      channelId: channelId,
      participants: [
        '0xaabbccddee11223344556677889900112233445566',
        '0x1122334455667788990011223344556677889900aa',
      ],
      tokenAddress: '0x7f5c764cbc14f9669b88837ca1490cca17c31607',
      tokenSymbol: 'USDC',
      settlementTimeout: 86400,
      initialDeposits: {
        '0xaabbccddee11223344556677889900112233445566': '1000000000',
        '0x1122334455667788990011223344556677889900aa': '1000000000',
      },
    };

    connectorWs.send(JSON.stringify(channelOpenedEvent));
    await waitForMessage(clientWs, 'PAYMENT_CHANNEL_OPENED');

    // Act: Emit PAYMENT_CHANNEL_BALANCE_UPDATE event
    const balanceUpdateEvent: PaymentChannelBalanceUpdateEvent = {
      type: 'PAYMENT_CHANNEL_BALANCE_UPDATE',
      timestamp: Date.now(),
      nodeId: 'test-connector-a',
      channelId: channelId,
      myNonce: 42,
      theirNonce: 38,
      myTransferred: '250000000',
      theirTransferred: '180000000',
    };

    const balanceUpdatePromise = waitForMessage(clientWs, 'PAYMENT_CHANNEL_BALANCE_UPDATE');
    connectorWs.send(JSON.stringify(balanceUpdateEvent));

    // Assert: Verify client received balance update
    const receivedUpdate = await balanceUpdatePromise;
    expect(receivedUpdate.type).toBe('PAYMENT_CHANNEL_BALANCE_UPDATE');
    expect(receivedUpdate.channelId).toBe(channelId);
    expect(receivedUpdate.myNonce).toBe(42);
    expect(receivedUpdate.theirNonce).toBe(38);
    expect(receivedUpdate.myTransferred).toBe('250000000');
    expect(receivedUpdate.theirTransferred).toBe('180000000');

    // Assert: Verify channel state updated
    const channels = telemetryServer.getChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]?.currentBalances.myNonce).toBe(42);
    expect(channels[0]?.currentBalances.theirNonce).toBe(38);
    expect(channels[0]?.currentBalances.myTransferred).toBe('250000000');
    expect(channels[0]?.currentBalances.theirTransferred).toBe('180000000');
  });

  test('Channel settled event flow', async () => {
    // Arrange: Open channel first
    clientWs = new WebSocket(`ws://localhost:${TEST_PORT}`);
    await waitForSocketReady(clientWs);
    clientWs.send(JSON.stringify({ type: 'CLIENT_CONNECT' }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    connectorWs = new WebSocket(`ws://localhost:${TEST_PORT}`);
    await waitForSocketReady(connectorWs);

    const channelId = '0x9876543210abcdef9876543210abcdef9876543210abcdef9876543210abcdef';

    const channelOpenedEvent: PaymentChannelOpenedEvent = {
      type: 'PAYMENT_CHANNEL_OPENED',
      timestamp: Date.now(),
      nodeId: 'test-connector-a',
      channelId: channelId,
      participants: [
        '0xaabbccddee11223344556677889900112233445566',
        '0x1122334455667788990011223344556677889900aa',
      ],
      tokenAddress: '0x7f5c764cbc14f9669b88837ca1490cca17c31607',
      tokenSymbol: 'USDC',
      settlementTimeout: 86400,
      initialDeposits: {
        '0xaabbccddee11223344556677889900112233445566': '1000000000',
        '0x1122334455667788990011223344556677889900aa': '1000000000',
      },
    };

    connectorWs.send(JSON.stringify(channelOpenedEvent));
    await waitForMessage(clientWs, 'PAYMENT_CHANNEL_OPENED');

    // Act: Emit PAYMENT_CHANNEL_SETTLED event
    const channelSettledEvent: PaymentChannelSettledEvent = {
      type: 'PAYMENT_CHANNEL_SETTLED',
      timestamp: Date.now(),
      nodeId: 'test-connector-a',
      channelId: channelId,
      finalBalances: {
        '0xaabbccddee11223344556677889900112233445566': '750000000',
        '0x1122334455667788990011223344556677889900aa': '1250000000',
      },
      settlementType: 'cooperative',
    };

    const settledPromise = waitForMessage(clientWs, 'PAYMENT_CHANNEL_SETTLED');
    connectorWs.send(JSON.stringify(channelSettledEvent));

    // Assert: Verify client received settlement event
    const receivedSettlement = await settledPromise;
    expect(receivedSettlement.type).toBe('PAYMENT_CHANNEL_SETTLED');
    expect(receivedSettlement.channelId).toBe(channelId);
    expect(receivedSettlement.settlementType).toBe('cooperative');

    // Assert: Verify channel status updated to settled
    const channels = telemetryServer.getChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]?.status).toBe('settled');
    expect(channels[0]?.settlementType).toBe('cooperative');
    expect(channels[0]?.settledAt).toBeDefined();
  });

  test('Multiple channels tracked correctly', async () => {
    // Arrange: Connect client and connector
    clientWs = new WebSocket(`ws://localhost:${TEST_PORT}`);
    await waitForSocketReady(clientWs);
    clientWs.send(JSON.stringify({ type: 'CLIENT_CONNECT' }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    connectorWs = new WebSocket(`ws://localhost:${TEST_PORT}`);
    await waitForSocketReady(connectorWs);

    // Act: Open 3 channels with different tokens and peers
    const channel1: PaymentChannelOpenedEvent = {
      type: 'PAYMENT_CHANNEL_OPENED',
      timestamp: Date.now(),
      nodeId: 'test-connector-a',
      channelId: '0x1111111111111111111111111111111111111111111111111111111111111111',
      participants: [
        '0xaaa1111111111111111111111111111111111111',
        '0xbbb1111111111111111111111111111111111111',
      ],
      tokenAddress: '0x7f5c764cbc14f9669b88837ca1490cca17c31607',
      tokenSymbol: 'USDC',
      settlementTimeout: 86400,
      initialDeposits: {
        '0xaaa1111111111111111111111111111111111111': '1000000000',
        '0xbbb1111111111111111111111111111111111111': '1000000000',
      },
    };

    const channel2: PaymentChannelOpenedEvent = {
      type: 'PAYMENT_CHANNEL_OPENED',
      timestamp: Date.now(),
      nodeId: 'test-connector-a',
      channelId: '0x2222222222222222222222222222222222222222222222222222222222222222',
      participants: [
        '0xaaa1111111111111111111111111111111111111',
        '0xccc2222222222222222222222222222222222222',
      ],
      tokenAddress: '0x4200000000000000000000000000000000000006',
      tokenSymbol: 'WETH',
      settlementTimeout: 86400,
      initialDeposits: {
        '0xaaa1111111111111111111111111111111111111': '500000000',
        '0xccc2222222222222222222222222222222222222': '500000000',
      },
    };

    const channel3: PaymentChannelOpenedEvent = {
      type: 'PAYMENT_CHANNEL_OPENED',
      timestamp: Date.now(),
      nodeId: 'test-connector-b',
      channelId: '0x3333333333333333333333333333333333333333333333333333333333333333',
      participants: [
        '0xddd3333333333333333333333333333333333333',
        '0xeee3333333333333333333333333333333333333',
      ],
      tokenAddress: '0x7f5c764cbc14f9669b88837ca1490cca17c31607',
      tokenSymbol: 'USDC',
      settlementTimeout: 86400,
      initialDeposits: {
        '0xddd3333333333333333333333333333333333333': '2000000000',
        '0xeee3333333333333333333333333333333333333': '2000000000',
      },
    };

    connectorWs.send(JSON.stringify(channel1));
    await waitForMessage(clientWs, 'PAYMENT_CHANNEL_OPENED');

    connectorWs.send(JSON.stringify(channel2));
    await waitForMessage(clientWs, 'PAYMENT_CHANNEL_OPENED');

    connectorWs.send(JSON.stringify(channel3));
    await waitForMessage(clientWs, 'PAYMENT_CHANNEL_OPENED');

    // Assert: Verify all 3 channels stored
    const channels = telemetryServer.getChannels();
    expect(channels).toHaveLength(3);

    // Verify channel IDs are unique
    const channelIds = channels.map((c) => c.channelId);
    expect(new Set(channelIds).size).toBe(3);

    // Verify tokens
    const usdcChannels = channels.filter((c) => c.tokenSymbol === 'USDC');
    const wethChannels = channels.filter((c) => c.tokenSymbol === 'WETH');
    expect(usdcChannels).toHaveLength(2);
    expect(wethChannels).toHaveLength(1);

    // Verify node IDs
    const connectorAChannels = channels.filter((c) => c.nodeId === 'test-connector-a');
    const connectorBChannels = channels.filter((c) => c.nodeId === 'test-connector-b');
    expect(connectorAChannels).toHaveLength(2);
    expect(connectorBChannels).toHaveLength(1);
  });

  test('Initial channel state sent to new client', async () => {
    // Arrange: Open channel before client connects
    connectorWs = new WebSocket(`ws://localhost:${TEST_PORT}`);
    await waitForSocketReady(connectorWs);

    const channelOpenedEvent: PaymentChannelOpenedEvent = {
      type: 'PAYMENT_CHANNEL_OPENED',
      timestamp: Date.now(),
      nodeId: 'test-connector-a',
      channelId: '0xaaaa111111111111111111111111111111111111111111111111111111111111',
      participants: [
        '0xaaa1111111111111111111111111111111111111',
        '0xbbb1111111111111111111111111111111111111',
      ],
      tokenAddress: '0x7f5c764cbc14f9669b88837ca1490cca17c31607',
      tokenSymbol: 'USDC',
      settlementTimeout: 86400,
      initialDeposits: {
        '0xaaa1111111111111111111111111111111111111': '1000000000',
        '0xbbb1111111111111111111111111111111111111': '1000000000',
      },
    };

    connectorWs.send(JSON.stringify(channelOpenedEvent));

    // Wait for channel to be processed
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Act: Connect new client AFTER channel exists
    clientWs = new WebSocket(`ws://localhost:${TEST_PORT}`);
    await waitForSocketReady(clientWs);

    // Wait for initial state message
    const initialStatePromise = waitForMessage(clientWs, 'INITIAL_CHANNEL_STATE');

    clientWs.send(JSON.stringify({ type: 'CLIENT_CONNECT' }));

    // Assert: Verify initial state includes existing channel
    const initialState = await initialStatePromise;
    expect(initialState.type).toBe('INITIAL_CHANNEL_STATE');
    expect(initialState.channels).toHaveLength(1);
    expect(initialState.channels[0].channelId).toBe(channelOpenedEvent.channelId);
    expect(initialState.channels[0].status).toBe('active');
  });
});
