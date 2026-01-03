/**
 * Integration tests for BTPClient and BTPServer
 * Tests end-to-end packet exchange between client and server
 */

import { BTPClient, Peer } from '../../src/btp/btp-client';
import { BTPServer } from '../../src/btp/btp-server';
import { createLogger } from '../../src/utils/logger';
import { PacketHandler } from '../../src/core/packet-handler';
import { RoutingTable } from '../../src/routing/routing-table';
import {
  ILPPreparePacket,
  ILPFulfillPacket,
  ILPRejectPacket,
  PacketType,
  ILPErrorCode,
} from '@m2m/shared';

/**
 * Create valid ILP Prepare packet for testing
 */
const createValidPreparePacket = (
  destination = 'g.alice.wallet',
  amount = BigInt(1000)
): ILPPreparePacket => {
  const futureExpiry = new Date(Date.now() + 10000);
  return {
    type: PacketType.PREPARE,
    amount,
    destination,
    executionCondition: Buffer.alloc(32, 1),
    expiresAt: futureExpiry,
    data: Buffer.alloc(0),
  };
};

/**
 * Create valid ILP Fulfill packet
 */
const createValidFulfillPacket = (): ILPFulfillPacket => ({
  type: PacketType.FULFILL,
  fulfillment: Buffer.alloc(32, 1),
  data: Buffer.alloc(0),
});

/**
 * Create valid ILP Reject packet
 */
const createValidRejectPacket = (): ILPRejectPacket => ({
  type: PacketType.REJECT,
  code: ILPErrorCode.F02_UNREACHABLE,
  triggeredBy: 'g.connector',
  message: 'No route found',
  data: Buffer.alloc(0),
});

// Skip tests unless E2E_TESTS is enabled (requires real BTP server/client setup)
const e2eEnabled = process.env.E2E_TESTS === 'true';
const describeIfE2E = e2eEnabled ? describe : describe.skip;

describeIfE2E('BTPClient and BTPServer Integration', () => {
  let server: BTPServer;
  let client: BTPClient;
  let serverPort: number;
  let mockPeer: Peer;
  let packetHandler: PacketHandler;
  let routingTable: RoutingTable;

  beforeAll(() => {
    // Use a random port for testing to avoid conflicts
    serverPort = 30000 + Math.floor(Math.random() * 10000);
  });

  beforeEach(async () => {
    // Set up authentication secret (just the secret value)
    process.env['BTP_PEER_CLIENTA_SECRET'] = 'shared-secret-123';

    // Create routing table and packet handler
    const logger = createLogger('integration-test', 'error');
    routingTable = new RoutingTable(undefined, logger);
    const mockBtpClientManager = {} as any; // Mock for integration test
    packetHandler = new PacketHandler(routingTable, mockBtpClientManager, 'test.connector', logger);

    // Start BTP server
    server = new BTPServer(logger, packetHandler);
    await server.start(serverPort);

    // Create BTP client peer configuration
    // The authToken must be JSON with peerId and secret for BTPServer to parse
    mockPeer = {
      id: 'clientA',
      url: `ws://localhost:${serverPort}`,
      authToken: JSON.stringify({
        peerId: 'clientA',
        secret: 'shared-secret-123',
      }),
      connected: false,
      lastSeen: new Date(),
    };

    client = new BTPClient(mockPeer, 'test-client', logger);
  });

  afterEach(async () => {
    await client.disconnect();
    await server.stop();
    delete process.env['BTP_PEER_CLIENT_A_SECRET'];
  });

  describe('Connection and Authentication', () => {
    it('should connect client to server and authenticate successfully', async () => {
      // Act
      await client.connect();

      // Assert
      expect(client.isConnected).toBe(true);
      expect(mockPeer.connected).toBe(true);
    });

    it('should fail authentication with invalid secret', async () => {
      // Arrange - create client with wrong secret
      const badPeer: Peer = {
        ...mockPeer,
        authToken: JSON.stringify({
          peerId: 'clientA',
          secret: 'wrong-secret',
        }),
      };
      const badClient = new BTPClient(badPeer, 'bad-client', createLogger('bad-client', 'error'));

      // Act & Assert
      await expect(badClient.connect()).rejects.toThrow();

      await badClient.disconnect();
    });

    it('should handle connection events', async () => {
      // Arrange
      const connectedHandler = jest.fn();
      const disconnectedHandler = jest.fn();

      client.on('connected', connectedHandler);
      client.on('disconnected', disconnectedHandler);

      // Act
      await client.connect();
      await client.disconnect();

      // Wait for events to propagate
      await new Promise((resolve) => setImmediate(resolve));

      // Assert
      expect(connectedHandler).toHaveBeenCalled();
      expect(disconnectedHandler).toHaveBeenCalled();
    });
  });

  describe('Packet Exchange', () => {
    beforeEach(async () => {
      await client.connect();

      // Configure packet handler to return fulfill responses
      jest
        .spyOn(packetHandler, 'handlePreparePacket')
        .mockResolvedValue(createValidFulfillPacket());
    });

    it('should send ILP Prepare and receive ILP Fulfill', async () => {
      // Arrange
      const preparePacket = createValidPreparePacket();

      // Act
      const response = await client.sendPacket(preparePacket);

      // Assert
      expect(response.type).toBe(PacketType.FULFILL);
      expect((response as ILPFulfillPacket).fulfillment).toEqual(Buffer.alloc(32, 1));
    });

    it('should handle ILP Reject response', async () => {
      // Arrange
      const preparePacket = createValidPreparePacket();
      const rejectPacket = createValidRejectPacket();

      // Mock packet handler to return reject
      jest.spyOn(packetHandler, 'handlePreparePacket').mockResolvedValue(rejectPacket);

      // Act
      const response = await client.sendPacket(preparePacket);

      // Assert
      expect(response.type).toBe(PacketType.REJECT);
      expect((response as ILPRejectPacket).code).toBe(ILPErrorCode.F02_UNREACHABLE);
    });

    it('should handle multiple sequential packet sends', async () => {
      // Arrange
      const packet1 = createValidPreparePacket('g.alice', BigInt(100));
      const packet2 = createValidPreparePacket('g.bob', BigInt(200));
      const packet3 = createValidPreparePacket('g.charlie', BigInt(300));

      // Act
      const response1 = await client.sendPacket(packet1);
      const response2 = await client.sendPacket(packet2);
      const response3 = await client.sendPacket(packet3);

      // Assert
      expect(response1.type).toBe(PacketType.FULFILL);
      expect(response2.type).toBe(PacketType.FULFILL);
      expect(response3.type).toBe(PacketType.FULFILL);
    });

    it('should handle concurrent packet sends', async () => {
      // Arrange
      const packet1 = createValidPreparePacket('g.alice', BigInt(100));
      const packet2 = createValidPreparePacket('g.bob', BigInt(200));
      const packet3 = createValidPreparePacket('g.charlie', BigInt(300));

      // Act - send all packets concurrently
      const [response1, response2, response3] = await Promise.all([
        client.sendPacket(packet1),
        client.sendPacket(packet2),
        client.sendPacket(packet3),
      ]);

      // Assert
      expect(response1.type).toBe(PacketType.FULFILL);
      expect(response2.type).toBe(PacketType.FULFILL);
      expect(response3.type).toBe(PacketType.FULFILL);
    });

    it('should verify packet handler receives correct packet data', async () => {
      // Arrange
      const preparePacket = createValidPreparePacket('g.test.destination', BigInt(5000));
      const handleSpy = jest.spyOn(packetHandler, 'handlePreparePacket');

      // Act
      await client.sendPacket(preparePacket);

      // Assert
      expect(handleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: PacketType.PREPARE,
          destination: 'g.test.destination',
          amount: BigInt(5000),
        })
      );
    });
  });

  describe('Connection Resilience', () => {
    it('should reconnect automatically after connection drop', async () => {
      // Arrange
      await client.connect();
      expect(client.isConnected).toBe(true);

      // Act - simulate server restart
      await server.stop();
      await new Promise((resolve) => setTimeout(resolve, 100));

      await server.start(serverPort);
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait for reconnection

      // Assert - client should have reconnected
      expect(client.isConnected).toBe(true);
    }, 10000);

    it('should handle server not available on initial connect', async () => {
      // Arrange - stop server
      await server.stop();

      const newClient = new BTPClient(
        {
          ...mockPeer,
          url: `ws://localhost:${serverPort + 1}`, // Different port
        },
        'test-client',
        createLogger('test-client', 'error'),
        2 // Max 2 retries for faster test
      );

      // Act & Assert - should fail after retries
      await expect(newClient.connect()).rejects.toThrow();

      await newClient.disconnect();
    }, 15000);
  });

  describe('Keep-Alive', () => {
    it('should maintain connection with ping/pong', async () => {
      // Arrange
      jest.useFakeTimers();
      await client.connect();

      // Act - advance time to trigger pings
      jest.advanceTimersByTime(35000); // 30s + buffer

      // Assert - connection should still be alive
      expect(client.isConnected).toBe(true);

      jest.useRealTimers();
    });
  });

  describe('Error Scenarios', () => {
    beforeEach(async () => {
      await client.connect();
    });

    it('should handle packet handler errors gracefully', async () => {
      // Arrange
      const preparePacket = createValidPreparePacket();
      jest
        .spyOn(packetHandler, 'handlePreparePacket')
        .mockRejectedValue(new Error('Processing failed'));

      // Act - should receive reject packet instead of throwing
      const response = await client.sendPacket(preparePacket);

      // Assert - server should send reject on error
      expect(response.type).toBe(PacketType.REJECT);
    });

    it('should handle disconnection during packet send', async () => {
      // Arrange
      const preparePacket = createValidPreparePacket();

      // Mock packet handler with delay
      jest.spyOn(packetHandler, 'handlePreparePacket').mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return createValidFulfillPacket();
      });

      // Act - send packet and disconnect immediately
      const sendPromise = client.sendPacket(preparePacket);
      await client.disconnect();

      // Assert - should reject with connection closed error
      await expect(sendPromise).rejects.toThrow('Connection closed');
    });
  });

  describe('Performance', () => {
    beforeEach(async () => {
      await client.connect();
    });

    it('should handle high throughput packet exchange', async () => {
      // Arrange
      const packetCount = 100;
      const packets = Array.from({ length: packetCount }, (_, i) =>
        createValidPreparePacket(`g.dest.${i}`, BigInt(i + 1))
      );

      // Act
      const startTime = Date.now();
      const responses = await Promise.all(packets.map((packet) => client.sendPacket(packet)));
      const duration = Date.now() - startTime;

      // Assert
      expect(responses).toHaveLength(packetCount);
      expect(responses.every((r) => r.type === PacketType.FULFILL)).toBe(true);

      // Log performance metric
      const throughput = (packetCount / duration) * 1000;
      console.log(`Throughput: ${throughput.toFixed(2)} packets/second`);
      expect(throughput).toBeGreaterThan(10); // At least 10 packets/sec
    }, 30000);
  });
});
