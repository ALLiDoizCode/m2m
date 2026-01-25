import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePaymentChannels } from './usePaymentChannels';

// Mock WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState: number = 0; // WebSocket.CONNECTING

  constructor() {
    MockWebSocket.instances.push(this);
  }

  close() {
    this.readyState = 3; // WebSocket.CLOSED
  }

  simulateOpen() {
    this.readyState = 1; // WebSocket.OPEN
    this.onopen?.();
  }

  simulateMessage(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose() {
    this.readyState = 3; // WebSocket.CLOSED
    this.onclose?.();
  }
}

describe('usePaymentChannels', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('initialization', () => {
    it('initializes with empty channels map', () => {
      const { result } = renderHook(() => usePaymentChannels());

      expect(result.current.channels).toEqual([]);
      expect(result.current.totalChannels).toBe(0);
    });

    it('starts with connecting status', () => {
      const { result } = renderHook(() => usePaymentChannels());

      expect(result.current.status).toBe('connecting');
    });
  });

  describe('EVM channel events', () => {
    it('creates channel on PAYMENT_CHANNEL_OPENED event', async () => {
      const { result } = renderHook(() => usePaymentChannels());

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'PAYMENT_CHANNEL_OPENED',
          channelId: '0x123',
          nodeId: 'connector-a',
          peerId: 'connector-b',
          participants: ['0xabc', '0xdef'],
          tokenAddress: '0xtoken',
          tokenSymbol: 'USDC',
          settlementTimeout: 86400,
          initialDeposits: { '0xabc': '1000000' },
          timestamp: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(result.current.totalChannels).toBe(1);
      });

      expect(result.current.channels[0].channelId).toBe('0x123');
      expect(result.current.channels[0].status).toBe('active');
      expect(result.current.channels[0].settlementMethod).toBe('evm');
    });

    it('updates channel on PAYMENT_CHANNEL_BALANCE_UPDATE event', async () => {
      const { result } = renderHook(() => usePaymentChannels());

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      // First, open the channel
      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'PAYMENT_CHANNEL_OPENED',
          channelId: '0x123',
          nodeId: 'connector-a',
          peerId: 'connector-b',
          participants: ['0xabc', '0xdef'],
          tokenAddress: '0xtoken',
          tokenSymbol: 'USDC',
          settlementTimeout: 86400,
          initialDeposits: {},
          timestamp: new Date().toISOString(),
        });
      });

      // Then, update the balance
      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'PAYMENT_CHANNEL_BALANCE_UPDATE',
          channelId: '0x123',
          myNonce: 5,
          theirNonce: 3,
          myTransferred: '5000',
          theirTransferred: '2000',
          timestamp: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(result.current.channels[0].myNonce).toBe(5);
      });

      expect(result.current.channels[0].myTransferred).toBe('5000');
      expect(result.current.channels[0].theirTransferred).toBe('2000');
    });

    it('marks channel settled on PAYMENT_CHANNEL_SETTLED event', async () => {
      const { result } = renderHook(() => usePaymentChannels());

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      // First, open the channel
      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'PAYMENT_CHANNEL_OPENED',
          channelId: '0x123',
          nodeId: 'connector-a',
          peerId: 'connector-b',
          participants: ['0xabc', '0xdef'],
          tokenAddress: '0xtoken',
          tokenSymbol: 'USDC',
          settlementTimeout: 86400,
          initialDeposits: {},
          timestamp: new Date().toISOString(),
        });
      });

      // Then, settle the channel
      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'PAYMENT_CHANNEL_SETTLED',
          channelId: '0x123',
          finalBalances: { '0xabc': '3000', '0xdef': '2000' },
          settlementType: 'cooperative',
          timestamp: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(result.current.channels[0].status).toBe('settled');
      });
    });
  });

  describe('XRP channel events', () => {
    it('creates XRP channel on XRP_CHANNEL_OPENED event', async () => {
      const { result } = renderHook(() => usePaymentChannels());

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'XRP_CHANNEL_OPENED',
          channelId: 'xrp123',
          nodeId: 'connector-a',
          peerId: 'connector-b',
          account: 'rSender',
          destination: 'rReceiver',
          amount: '1000000',
          settleDelay: 3600,
          publicKey: 'pk123',
          timestamp: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(result.current.totalChannels).toBe(1);
      });

      expect(result.current.channels[0].settlementMethod).toBe('xrp');
      expect(result.current.channels[0].xrpAccount).toBe('rSender');
      expect(result.current.channels[0].xrpDestination).toBe('rReceiver');
    });

    it('updates XRP balance on XRP_CHANNEL_CLAIMED event', async () => {
      const { result } = renderHook(() => usePaymentChannels());

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      // First, open the XRP channel
      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'XRP_CHANNEL_OPENED',
          channelId: 'xrp123',
          account: 'rSender',
          destination: 'rReceiver',
          amount: '1000000',
          settleDelay: 3600,
          publicKey: 'pk123',
          timestamp: new Date().toISOString(),
        });
      });

      // Then, claim from channel
      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'XRP_CHANNEL_CLAIMED',
          channelId: 'xrp123',
          balance: '500000',
          timestamp: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(result.current.channels[0].xrpBalance).toBe('500000');
      });
    });

    it('marks XRP channel settled on XRP_CHANNEL_CLOSED event', async () => {
      const { result } = renderHook(() => usePaymentChannels());

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      // First, open the XRP channel
      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'XRP_CHANNEL_OPENED',
          channelId: 'xrp123',
          account: 'rSender',
          destination: 'rReceiver',
          amount: '1000000',
          settleDelay: 3600,
          publicKey: 'pk123',
          timestamp: new Date().toISOString(),
        });
      });

      // Then, close the channel
      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'XRP_CHANNEL_CLOSED',
          channelId: 'xrp123',
          timestamp: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(result.current.channels[0].status).toBe('settled');
      });
    });
  });

  describe('sorting', () => {
    it('returns channels sorted by lastActivityAt (most recent first)', async () => {
      const { result } = renderHook(() => usePaymentChannels());

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      const oldTime = new Date(Date.now() - 10000).toISOString();
      const newTime = new Date().toISOString();

      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'PAYMENT_CHANNEL_OPENED',
          channelId: 'old-channel',
          nodeId: 'connector-a',
          peerId: 'connector-b',
          participants: ['0xabc', '0xdef'],
          tokenAddress: '0xtoken',
          tokenSymbol: 'USDC',
          settlementTimeout: 86400,
          initialDeposits: {},
          timestamp: oldTime,
        });
      });

      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'PAYMENT_CHANNEL_OPENED',
          channelId: 'new-channel',
          nodeId: 'connector-a',
          peerId: 'connector-c',
          participants: ['0xabc', '0xghi'],
          tokenAddress: '0xtoken',
          tokenSymbol: 'USDC',
          settlementTimeout: 86400,
          initialDeposits: {},
          timestamp: newTime,
        });
      });

      await waitFor(() => {
        expect(result.current.totalChannels).toBe(2);
      });

      // Most recent should be first
      expect(result.current.channels[0].channelId).toBe('new-channel');
    });
  });

  describe('active channel count', () => {
    it('counts only active channels', async () => {
      const { result } = renderHook(() => usePaymentChannels());

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      // Open two channels
      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'PAYMENT_CHANNEL_OPENED',
          channelId: 'active-channel',
          nodeId: 'connector-a',
          peerId: 'connector-b',
          participants: ['0xabc', '0xdef'],
          tokenAddress: '0xtoken',
          tokenSymbol: 'USDC',
          settlementTimeout: 86400,
          initialDeposits: {},
          timestamp: new Date().toISOString(),
        });
      });

      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'PAYMENT_CHANNEL_OPENED',
          channelId: 'settled-channel',
          nodeId: 'connector-a',
          peerId: 'connector-c',
          participants: ['0xabc', '0xghi'],
          tokenAddress: '0xtoken',
          tokenSymbol: 'USDC',
          settlementTimeout: 86400,
          initialDeposits: {},
          timestamp: new Date().toISOString(),
        });
      });

      // Settle one of them
      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'PAYMENT_CHANNEL_SETTLED',
          channelId: 'settled-channel',
          finalBalances: {},
          settlementType: 'cooperative',
          timestamp: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(result.current.totalChannels).toBe(2);
      });

      expect(result.current.activeChannelCount).toBe(1);
    });
  });
});
