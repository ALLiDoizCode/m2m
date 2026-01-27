/**
 * Integration Tests: TelemetryEmitter + EventStore
 *
 * Tests end-to-end flow of telemetry events from emission to persistence.
 *
 * @packageDocumentation
 */

import { TelemetryEmitter } from '../../src/telemetry/telemetry-emitter';
import { EventStore } from '../../src/explorer/event-store';
import {
  AccountBalanceEvent,
  SettlementState,
  SettlementTriggeredEvent,
  SettlementCompletedEvent,
  AgentChannelOpenedEvent,
  XRPChannelOpenedEvent,
} from '@m2m/shared';
import pino from 'pino';

// Create mock logger for testing
function createMockLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

/**
 * Helper to create test events
 */
function createAccountBalanceEvent(
  overrides: Partial<AccountBalanceEvent> = {}
): AccountBalanceEvent {
  return {
    type: 'ACCOUNT_BALANCE',
    nodeId: 'connector-a',
    peerId: 'peer-b',
    tokenId: 'ILP',
    debitBalance: '0',
    creditBalance: '1000',
    netBalance: '-1000',
    settlementState: SettlementState.IDLE,
    timestamp: '2026-01-24T12:00:00.000Z',
    ...overrides,
  };
}

function createSettlementTriggeredEvent(
  overrides: Partial<SettlementTriggeredEvent> = {}
): SettlementTriggeredEvent {
  return {
    type: 'SETTLEMENT_TRIGGERED',
    nodeId: 'connector-a',
    peerId: 'peer-b',
    tokenId: 'ILP',
    currentBalance: '5500',
    threshold: '5000',
    exceedsBy: '500',
    triggerReason: 'THRESHOLD_EXCEEDED',
    timestamp: '2026-01-24T12:01:00.000Z',
    ...overrides,
  };
}

function createSettlementCompletedEvent(
  overrides: Partial<SettlementCompletedEvent> = {}
): SettlementCompletedEvent {
  return {
    type: 'SETTLEMENT_COMPLETED',
    nodeId: 'connector-a',
    peerId: 'peer-b',
    tokenId: 'ILP',
    previousBalance: '5500',
    newBalance: '0',
    settledAmount: '5500',
    settlementType: 'MOCK',
    success: true,
    timestamp: '2026-01-24T12:02:00.000Z',
    ...overrides,
  };
}

function createAgentChannelOpenedEvent(
  overrides: Partial<AgentChannelOpenedEvent> = {}
): AgentChannelOpenedEvent {
  return {
    type: 'AGENT_CHANNEL_OPENED',
    timestamp: 1737720000000,
    nodeId: 'connector-a',
    agentId: 'agent-001',
    channelId: '0xabc123',
    chain: 'evm',
    peerId: 'agent-002',
    amount: '1000000000000000000',
    ...overrides,
  };
}

function createXRPChannelOpenedEvent(
  overrides: Partial<XRPChannelOpenedEvent> = {}
): XRPChannelOpenedEvent {
  return {
    type: 'XRP_CHANNEL_OPENED',
    timestamp: '2026-01-24T12:03:00.000Z',
    nodeId: 'connector-a',
    channelId: 'A1B2C3D4E5F6789',
    account: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
    destination: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
    amount: '10000000000',
    settleDelay: 86400,
    publicKey: 'ED01234567890ABCDEF',
    peerId: 'peer-bob',
    ...overrides,
  };
}

describe('TelemetryEmitter + EventStore Integration', () => {
  let eventStore: EventStore;
  let telemetryEmitter: TelemetryEmitter;
  let mockLogger: pino.Logger;

  beforeEach(async () => {
    mockLogger = createMockLogger();

    // Create EventStore with in-memory database
    eventStore = new EventStore({ path: ':memory:' }, mockLogger);
    await eventStore.initialize();

    // Create TelemetryEmitter with EventStore integration
    // Using an invalid URL since we're testing storage, not WebSocket
    telemetryEmitter = new TelemetryEmitter(
      'ws://localhost:9999', // Invalid URL - we don't need actual WebSocket
      'connector-a',
      mockLogger,
      eventStore
    );
  });

  afterEach(async () => {
    await telemetryEmitter.disconnect();
    await eventStore.close();
  });

  // ============================================
  // End-to-End Flow Tests
  // ============================================
  describe('end-to-end flow', () => {
    it('should persist telemetry events via emit()', async () => {
      const event = createAccountBalanceEvent();

      // Emit event (no WebSocket connected, but should still persist)
      telemetryEmitter.emit(event);

      // Wait for async storage to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Query EventStore to verify persistence
      const stored = await eventStore.queryEvents({});
      expect(stored).toHaveLength(1);
      expect(stored[0]!.event_type).toBe('ACCOUNT_BALANCE');
      expect(stored[0]!.peer_id).toBe('peer-b');
    });

    it('should persist multiple different event types', async () => {
      // Emit various event types
      telemetryEmitter.emit(createAccountBalanceEvent());
      telemetryEmitter.emit(createSettlementTriggeredEvent());
      telemetryEmitter.emit(createSettlementCompletedEvent());
      telemetryEmitter.emit(createAgentChannelOpenedEvent());
      telemetryEmitter.emit(createXRPChannelOpenedEvent());

      // Wait for async storage
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify all events persisted
      const count = await eventStore.getEventCount();
      expect(count).toBe(5);

      // Verify each event type
      const byType = await eventStore.queryEvents({ eventTypes: ['ACCOUNT_BALANCE'] });
      expect(byType).toHaveLength(1);

      const settlements = await eventStore.queryEvents({
        eventTypes: ['SETTLEMENT_TRIGGERED', 'SETTLEMENT_COMPLETED'],
      });
      expect(settlements).toHaveLength(2);

      const channels = await eventStore.queryEvents({
        eventTypes: ['AGENT_CHANNEL_OPENED', 'XRP_CHANNEL_OPENED'],
      });
      expect(channels).toHaveLength(2);
    });

    it('should extract indexed fields correctly for all event types', async () => {
      telemetryEmitter.emit(createAccountBalanceEvent({ peerId: 'test-peer', netBalance: '5000' }));
      telemetryEmitter.emit(createAgentChannelOpenedEvent({ channelId: 'ch-test', amount: '999' }));
      telemetryEmitter.emit(createXRPChannelOpenedEvent({ destination: 'rTestAddr' }));

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Query by extracted fields
      const byPeer = await eventStore.queryEvents({ peerId: 'test-peer' });
      expect(byPeer).toHaveLength(1);
      expect(byPeer[0]!.amount).toBe('5000');

      const byChannel = await eventStore.queryEvents({ packetId: 'ch-test' });
      expect(byChannel).toHaveLength(1);
      expect(byChannel[0]!.amount).toBe('999');

      const xrpEvents = await eventStore.queryEvents({ eventTypes: ['XRP_CHANNEL_OPENED'] });
      expect(xrpEvents).toHaveLength(1);
      expect(xrpEvents[0]!.destination).toBe('rTestAddr');
    });

    it('should preserve full event payload', async () => {
      const event = createSettlementCompletedEvent({
        previousBalance: '10000',
        newBalance: '500',
        settledAmount: '9500',
        settlementType: 'EVM',
        success: true,
      });

      telemetryEmitter.emit(event);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const stored = await eventStore.queryEvents({});
      expect(stored).toHaveLength(1);

      const payload = stored[0]!.payload as SettlementCompletedEvent;
      expect(payload.previousBalance).toBe('10000');
      expect(payload.newBalance).toBe('500');
      expect(payload.settledAmount).toBe('9500');
      expect(payload.settlementType).toBe('EVM');
      expect(payload.success).toBe(true);
    });
  });

  // ============================================
  // Non-Blocking Behavior Tests
  // ============================================
  describe('non-blocking behavior', () => {
    it('should not throw when EventStore fails', async () => {
      // Close EventStore to simulate failure
      await eventStore.close();

      // Emit should not throw
      expect(() => {
        telemetryEmitter.emit(createAccountBalanceEvent());
      }).not.toThrow();
    });

    it('should continue emitting after EventStore failure', async () => {
      // Emit first event
      telemetryEmitter.emit(createAccountBalanceEvent({ peerId: 'first' }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Close and reopen EventStore (simulating recovery)
      await eventStore.close();
      eventStore = new EventStore({ path: ':memory:' }, mockLogger);
      await eventStore.initialize();

      // Create new emitter with recovered store
      const recoveredEmitter = new TelemetryEmitter(
        'ws://localhost:9999',
        'connector-a',
        mockLogger,
        eventStore
      );

      // Emit should work again
      recoveredEmitter.emit(createAccountBalanceEvent({ peerId: 'second' }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const stored = await eventStore.queryEvents({});
      expect(stored).toHaveLength(1);
      expect(stored[0]!.peer_id).toBe('second');

      await recoveredEmitter.disconnect();
    });

    it('should emit to WebSocket even if storage fails', async () => {
      // Close EventStore
      await eventStore.close();

      // The emit should not throw and would attempt WebSocket send
      // (which will also fail since we're not connected, but that's expected)
      expect(() => {
        telemetryEmitter.emit(createAccountBalanceEvent());
      }).not.toThrow();
    });
  });

  // ============================================
  // TelemetryEmitter Without EventStore
  // ============================================
  describe('TelemetryEmitter without EventStore', () => {
    it('should work normally without EventStore configured', async () => {
      const emitterWithoutStore = new TelemetryEmitter(
        'ws://localhost:9999',
        'connector-a',
        mockLogger
        // No EventStore provided
      );

      // Should not throw
      expect(() => {
        emitterWithoutStore.emit(createAccountBalanceEvent());
      }).not.toThrow();

      await emitterWithoutStore.disconnect();
    });
  });

  // ============================================
  // Helper Method Tests (emitXRP*)
  // ============================================
  describe('XRP channel helper methods', () => {
    it('should persist XRP_CHANNEL_OPENED via emitXRPChannelOpened', async () => {
      const channelState = {
        channelId: 'XRP-CH-001',
        account: 'rSource123',
        destination: 'rDest456',
        amount: '5000000000',
        balance: '0',
        settleDelay: 3600,
        publicKey: 'ED0123456789',
        status: 'open' as const,
      };

      telemetryEmitter.emitXRPChannelOpened(channelState, 'peer-xrp');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const stored = await eventStore.queryEvents({ eventTypes: ['XRP_CHANNEL_OPENED'] });
      expect(stored).toHaveLength(1);
      expect(stored[0]!.packet_id).toBe('XRP-CH-001');
      expect(stored[0]!.peer_id).toBe('peer-xrp');
      expect(stored[0]!.destination).toBe('rDest456');
    });

    it('should persist XRP_CHANNEL_CLAIMED via emitXRPChannelClaimed', async () => {
      telemetryEmitter.emitXRPChannelClaimed('XRP-CH-002', '2500000000', '2500000000', 'peer-xrp');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const stored = await eventStore.queryEvents({ eventTypes: ['XRP_CHANNEL_CLAIMED'] });
      expect(stored).toHaveLength(1);
      expect(stored[0]!.packet_id).toBe('XRP-CH-002');
      expect(stored[0]!.amount).toBe('2500000000');
    });

    it('should persist XRP_CHANNEL_CLOSED via emitXRPChannelClosed', async () => {
      telemetryEmitter.emitXRPChannelClosed('XRP-CH-003', '1000000000', 'cooperative', 'peer-xrp');
      await new Promise((resolve) => setTimeout(resolve, 50));

      const stored = await eventStore.queryEvents({ eventTypes: ['XRP_CHANNEL_CLOSED'] });
      expect(stored).toHaveLength(1);
      expect(stored[0]!.packet_id).toBe('XRP-CH-003');
      expect(stored[0]!.amount).toBe('1000000000');
    });
  });

  // ============================================
  // Query After Emit Tests
  // ============================================
  describe('query after emit', () => {
    it('should support filtering by event type after multiple emits', async () => {
      // Emit mixed events
      for (let i = 0; i < 5; i++) {
        telemetryEmitter.emit(createAccountBalanceEvent({ peerId: `peer-${i}` }));
        telemetryEmitter.emit(createSettlementTriggeredEvent({ peerId: `peer-${i}` }));
      }

      await new Promise((resolve) => setTimeout(resolve, 150));

      const balanceEvents = await eventStore.queryEvents({
        eventTypes: ['ACCOUNT_BALANCE'],
      });
      expect(balanceEvents).toHaveLength(5);

      const triggeredEvents = await eventStore.queryEvents({
        eventTypes: ['SETTLEMENT_TRIGGERED'],
      });
      expect(triggeredEvents).toHaveLength(5);
    });

    it('should support filtering by peer ID after emit', async () => {
      telemetryEmitter.emit(createAccountBalanceEvent({ peerId: 'peer-alice' }));
      telemetryEmitter.emit(createAccountBalanceEvent({ peerId: 'peer-bob' }));
      telemetryEmitter.emit(createAccountBalanceEvent({ peerId: 'peer-alice' }));

      await new Promise((resolve) => setTimeout(resolve, 100));

      const aliceEvents = await eventStore.queryEvents({ peerId: 'peer-alice' });
      expect(aliceEvents).toHaveLength(2);

      const bobEvents = await eventStore.queryEvents({ peerId: 'peer-bob' });
      expect(bobEvents).toHaveLength(1);
    });

    it('should support pagination after emit', async () => {
      // Emit 10 events
      for (let i = 0; i < 10; i++) {
        telemetryEmitter.emit(createAgentChannelOpenedEvent({ timestamp: Date.now() + i }));
      }

      await new Promise((resolve) => setTimeout(resolve, 150));

      const firstPage = await eventStore.queryEvents({ limit: 3, offset: 0 });
      expect(firstPage).toHaveLength(3);

      const secondPage = await eventStore.queryEvents({ limit: 3, offset: 3 });
      expect(secondPage).toHaveLength(3);

      const thirdPage = await eventStore.queryEvents({ limit: 3, offset: 6 });
      expect(thirdPage).toHaveLength(3);

      const fourthPage = await eventStore.queryEvents({ limit: 3, offset: 9 });
      expect(fourthPage).toHaveLength(1);
    });
  });
});
