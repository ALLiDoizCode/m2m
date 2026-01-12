/**
 * Payment Channel Telemetry Type Tests
 *
 * Tests for payment channel telemetry event type definitions (Story 8.10).
 * Verifies TypeScript type system, discriminated unions, and type guards.
 */

import {
  PaymentChannelOpenedEvent,
  PaymentChannelBalanceUpdateEvent,
  PaymentChannelSettledEvent,
  DashboardChannelState,
} from './payment-channel-telemetry';
import { TelemetryEvent, TelemetryEventType } from './telemetry';

describe('Payment Channel Telemetry Types', () => {
  describe('PaymentChannelOpenedEvent', () => {
    it('should create valid PaymentChannelOpenedEvent instance', () => {
      const event: PaymentChannelOpenedEvent = {
        type: 'PAYMENT_CHANNEL_OPENED',
        timestamp: '2026-01-09T12:00:00.000Z',
        nodeId: 'connector-a',
        channelId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        participants: [
          '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
          '0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199',
        ],
        peerId: 'connector-b',
        tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        tokenSymbol: 'USDC',
        settlementTimeout: 86400,
        initialDeposits: {
          '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb': '1000000000000000000',
          '0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199': '0',
        },
      };

      expect(event.type).toBe('PAYMENT_CHANNEL_OPENED');
      expect(event.nodeId).toBe('connector-a');
      expect(event.channelId).toBe(
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      );
      expect(event.peerId).toBe('connector-b');
      expect(event.tokenSymbol).toBe('USDC');
      expect(event.settlementTimeout).toBe(86400);
      expect(event.participants).toHaveLength(2);
      expect(Object.keys(event.initialDeposits)).toHaveLength(2);
    });

    it('should serialize bigint deposits as strings', () => {
      const depositAmount = BigInt('1000000000000000000');
      const event: PaymentChannelOpenedEvent = {
        type: 'PAYMENT_CHANNEL_OPENED',
        timestamp: '2026-01-09T12:00:00.000Z',
        nodeId: 'connector-a',
        channelId: '0xabc123',
        participants: ['0xAddress1', '0xAddress2'],
        peerId: 'connector-b',
        tokenAddress: '0xToken',
        tokenSymbol: 'TEST',
        settlementTimeout: 86400,
        initialDeposits: {
          '0xAddress1': depositAmount.toString(),
        },
      };

      expect(typeof event.initialDeposits['0xAddress1']).toBe('string');
      const deposit = event.initialDeposits['0xAddress1'];
      expect(deposit).toBeDefined();
      expect(BigInt(deposit!)).toEqual(depositAmount);
    });
  });

  describe('PaymentChannelBalanceUpdateEvent', () => {
    it('should create valid PaymentChannelBalanceUpdateEvent instance', () => {
      const event: PaymentChannelBalanceUpdateEvent = {
        type: 'PAYMENT_CHANNEL_BALANCE_UPDATE',
        timestamp: '2026-01-09T12:01:00.000Z',
        nodeId: 'connector-a',
        channelId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        myNonce: 5,
        theirNonce: 3,
        myTransferred: '5000000000000000000',
        theirTransferred: '2000000000000000000',
      };

      expect(event.type).toBe('PAYMENT_CHANNEL_BALANCE_UPDATE');
      expect(event.nodeId).toBe('connector-a');
      expect(event.myNonce).toBe(5);
      expect(event.theirNonce).toBe(3);
      expect(event.myTransferred).toBe('5000000000000000000');
      expect(event.theirTransferred).toBe('2000000000000000000');
    });

    it('should serialize bigint transferred amounts as strings', () => {
      const myTransferredAmount = BigInt('5000000000000000000');
      const theirTransferredAmount = BigInt('2000000000000000000');
      const event: PaymentChannelBalanceUpdateEvent = {
        type: 'PAYMENT_CHANNEL_BALANCE_UPDATE',
        timestamp: '2026-01-09T12:01:00.000Z',
        nodeId: 'connector-a',
        channelId: '0xabc123',
        myNonce: 5,
        theirNonce: 3,
        myTransferred: myTransferredAmount.toString(),
        theirTransferred: theirTransferredAmount.toString(),
      };

      expect(typeof event.myTransferred).toBe('string');
      expect(typeof event.theirTransferred).toBe('string');
      expect(BigInt(event.myTransferred)).toEqual(myTransferredAmount);
      expect(BigInt(event.theirTransferred)).toEqual(theirTransferredAmount);
    });
  });

  describe('PaymentChannelSettledEvent', () => {
    it('should create valid PaymentChannelSettledEvent instance', () => {
      const event: PaymentChannelSettledEvent = {
        type: 'PAYMENT_CHANNEL_SETTLED',
        timestamp: '2026-01-09T14:00:00.000Z',
        nodeId: 'connector-a',
        channelId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        finalBalances: {
          '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb': '3000000000000000000',
          '0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199': '2000000000000000000',
        },
        settlementType: 'cooperative',
      };

      expect(event.type).toBe('PAYMENT_CHANNEL_SETTLED');
      expect(event.nodeId).toBe('connector-a');
      expect(event.settlementType).toBe('cooperative');
      expect(Object.keys(event.finalBalances)).toHaveLength(2);
    });

    it('should support all settlement types', () => {
      const cooperativeEvent: PaymentChannelSettledEvent = {
        type: 'PAYMENT_CHANNEL_SETTLED',
        timestamp: '2026-01-09T14:00:00.000Z',
        nodeId: 'connector-a',
        channelId: '0xabc123',
        finalBalances: {},
        settlementType: 'cooperative',
      };

      const unilateralEvent: PaymentChannelSettledEvent = {
        type: 'PAYMENT_CHANNEL_SETTLED',
        timestamp: '2026-01-09T14:00:00.000Z',
        nodeId: 'connector-a',
        channelId: '0xabc123',
        finalBalances: {},
        settlementType: 'unilateral',
      };

      const disputedEvent: PaymentChannelSettledEvent = {
        type: 'PAYMENT_CHANNEL_SETTLED',
        timestamp: '2026-01-09T14:00:00.000Z',
        nodeId: 'connector-a',
        channelId: '0xabc123',
        finalBalances: {},
        settlementType: 'disputed',
      };

      expect(cooperativeEvent.settlementType).toBe('cooperative');
      expect(unilateralEvent.settlementType).toBe('unilateral');
      expect(disputedEvent.settlementType).toBe('disputed');
    });

    it('should serialize bigint final balances as strings', () => {
      const balance1 = BigInt('3000000000000000000');
      const balance2 = BigInt('2000000000000000000');
      const event: PaymentChannelSettledEvent = {
        type: 'PAYMENT_CHANNEL_SETTLED',
        timestamp: '2026-01-09T14:00:00.000Z',
        nodeId: 'connector-a',
        channelId: '0xabc123',
        finalBalances: {
          '0xAddress1': balance1.toString(),
          '0xAddress2': balance2.toString(),
        },
        settlementType: 'cooperative',
      };

      expect(typeof event.finalBalances['0xAddress1']).toBe('string');
      expect(typeof event.finalBalances['0xAddress2']).toBe('string');
      const balance1Str = event.finalBalances['0xAddress1'];
      const balance2Str = event.finalBalances['0xAddress2'];
      expect(balance1Str).toBeDefined();
      expect(balance2Str).toBeDefined();
      expect(BigInt(balance1Str!)).toEqual(balance1);
      expect(BigInt(balance2Str!)).toEqual(balance2);
    });
  });

  describe('DashboardChannelState', () => {
    it('should create valid DashboardChannelState instance', () => {
      const channelState: DashboardChannelState = {
        channelId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        nodeId: 'connector-a',
        peerId: 'connector-b',
        participants: [
          '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
          '0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199',
        ],
        tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        tokenSymbol: 'USDC',
        settlementTimeout: 86400,
        deposits: {
          '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb': '1000000000000000000',
          '0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199': '0',
        },
        myNonce: 5,
        theirNonce: 3,
        myTransferred: '5000000000000000000',
        theirTransferred: '2000000000000000000',
        status: 'active',
        openedAt: '2026-01-09T12:00:00.000Z',
        lastActivityAt: '2026-01-09T12:01:00.000Z',
      };

      expect(channelState.status).toBe('active');
      expect(channelState.myNonce).toBe(5);
      expect(channelState.theirNonce).toBe(3);
      expect(channelState.settledAt).toBeUndefined();
    });

    it('should support all channel status values', () => {
      const statuses: Array<DashboardChannelState['status']> = [
        'opening',
        'active',
        'closing',
        'settling',
        'settled',
      ];

      statuses.forEach((status) => {
        const channelState: DashboardChannelState = {
          channelId: '0xabc123',
          nodeId: 'connector-a',
          peerId: 'connector-b',
          participants: ['0xAddress1', '0xAddress2'],
          tokenAddress: '0xToken',
          tokenSymbol: 'TEST',
          settlementTimeout: 86400,
          deposits: {},
          myNonce: 0,
          theirNonce: 0,
          myTransferred: '0',
          theirTransferred: '0',
          status,
          openedAt: '2026-01-09T12:00:00.000Z',
          lastActivityAt: '2026-01-09T12:00:00.000Z',
        };

        expect(channelState.status).toBe(status);
      });
    });

    it('should include settledAt timestamp when settled', () => {
      const settledChannelState: DashboardChannelState = {
        channelId: '0xabc123',
        nodeId: 'connector-a',
        peerId: 'connector-b',
        participants: ['0xAddress1', '0xAddress2'],
        tokenAddress: '0xToken',
        tokenSymbol: 'TEST',
        settlementTimeout: 86400,
        deposits: {},
        myNonce: 5,
        theirNonce: 3,
        myTransferred: '5000000000000000000',
        theirTransferred: '2000000000000000000',
        status: 'settled',
        openedAt: '2026-01-09T12:00:00.000Z',
        settledAt: '2026-01-09T14:00:00.000Z',
        lastActivityAt: '2026-01-09T14:00:00.000Z',
      };

      expect(settledChannelState.settledAt).toBe('2026-01-09T14:00:00.000Z');
      expect(settledChannelState.status).toBe('settled');
    });
  });

  describe('TelemetryEvent Union Type', () => {
    it('should include payment channel events in TelemetryEvent union', () => {
      const openedEvent: TelemetryEvent = {
        type: 'PAYMENT_CHANNEL_OPENED',
        timestamp: '2026-01-09T12:00:00.000Z',
        nodeId: 'connector-a',
        channelId: '0xabc123',
        participants: ['0xAddress1', '0xAddress2'],
        peerId: 'connector-b',
        tokenAddress: '0xToken',
        tokenSymbol: 'TEST',
        settlementTimeout: 86400,
        initialDeposits: {},
      };

      const balanceUpdateEvent: TelemetryEvent = {
        type: 'PAYMENT_CHANNEL_BALANCE_UPDATE',
        timestamp: '2026-01-09T12:01:00.000Z',
        nodeId: 'connector-a',
        channelId: '0xabc123',
        myNonce: 5,
        theirNonce: 3,
        myTransferred: '5000000000000000000',
        theirTransferred: '2000000000000000000',
      };

      const settledEvent: TelemetryEvent = {
        type: 'PAYMENT_CHANNEL_SETTLED',
        timestamp: '2026-01-09T14:00:00.000Z',
        nodeId: 'connector-a',
        channelId: '0xabc123',
        finalBalances: {},
        settlementType: 'cooperative',
      };

      expect(openedEvent.type).toBe('PAYMENT_CHANNEL_OPENED');
      expect(balanceUpdateEvent.type).toBe('PAYMENT_CHANNEL_BALANCE_UPDATE');
      expect(settledEvent.type).toBe('PAYMENT_CHANNEL_SETTLED');
    });

    it('should support discriminated union pattern with type guards', () => {
      const events: TelemetryEvent[] = [
        {
          type: 'PAYMENT_CHANNEL_OPENED',
          timestamp: '2026-01-09T12:00:00.000Z',
          nodeId: 'connector-a',
          channelId: '0xabc123',
          participants: ['0xAddress1', '0xAddress2'],
          peerId: 'connector-b',
          tokenAddress: '0xToken',
          tokenSymbol: 'TEST',
          settlementTimeout: 86400,
          initialDeposits: {},
        },
        {
          type: 'PAYMENT_CHANNEL_BALANCE_UPDATE',
          timestamp: '2026-01-09T12:01:00.000Z',
          nodeId: 'connector-a',
          channelId: '0xabc123',
          myNonce: 5,
          theirNonce: 3,
          myTransferred: '5000000000000000000',
          theirTransferred: '2000000000000000000',
        },
        {
          type: 'PAYMENT_CHANNEL_SETTLED',
          timestamp: '2026-01-09T14:00:00.000Z',
          nodeId: 'connector-a',
          channelId: '0xabc123',
          finalBalances: {},
          settlementType: 'cooperative',
        },
      ];

      events.forEach((event) => {
        if (event.type === 'PAYMENT_CHANNEL_OPENED') {
          expect(event.peerId).toBeDefined();
          expect(event.tokenSymbol).toBeDefined();
          expect(event.initialDeposits).toBeDefined();
        } else if (event.type === 'PAYMENT_CHANNEL_BALANCE_UPDATE') {
          expect(event.myNonce).toBeDefined();
          expect(event.theirNonce).toBeDefined();
          expect(event.myTransferred).toBeDefined();
        } else if (event.type === 'PAYMENT_CHANNEL_SETTLED') {
          expect(event.finalBalances).toBeDefined();
          expect(event.settlementType).toBeDefined();
        }
      });
    });
  });

  describe('TelemetryEventType Enum', () => {
    it('should include payment channel event types in enum', () => {
      expect(TelemetryEventType.PAYMENT_CHANNEL_OPENED).toBe('PAYMENT_CHANNEL_OPENED');
      expect(TelemetryEventType.PAYMENT_CHANNEL_BALANCE_UPDATE).toBe(
        'PAYMENT_CHANNEL_BALANCE_UPDATE'
      );
      expect(TelemetryEventType.PAYMENT_CHANNEL_SETTLED).toBe('PAYMENT_CHANNEL_SETTLED');
    });
  });
});
