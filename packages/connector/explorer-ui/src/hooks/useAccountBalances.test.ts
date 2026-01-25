import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAccountBalances } from './useAccountBalances';

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

describe('useAccountBalances', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('initialization', () => {
    it('initializes with empty accounts map', () => {
      const { result } = renderHook(() => useAccountBalances());

      expect(result.current.accounts).toEqual([]);
      expect(result.current.totalAccounts).toBe(0);
    });

    it('starts with connecting status', () => {
      const { result } = renderHook(() => useAccountBalances());

      expect(result.current.status).toBe('connecting');
    });

    it('transitions to connected after WebSocket opens', async () => {
      const { result } = renderHook(() => useAccountBalances());

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      await waitFor(() => {
        expect(result.current.status).toBe('connected');
      });
    });
  });

  describe('account state updates', () => {
    it('updates account state on ACCOUNT_BALANCE event', async () => {
      const { result } = renderHook(() => useAccountBalances());

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'ACCOUNT_BALANCE',
          nodeId: 'connector-a',
          peerId: 'peer-b',
          tokenId: 'ILP',
          debitBalance: '0',
          creditBalance: '1000',
          netBalance: '-1000',
          settlementState: 'IDLE',
          timestamp: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(result.current.totalAccounts).toBe(1);
      });

      expect(result.current.accounts[0].peerId).toBe('peer-b');
      expect(result.current.accounts[0].tokenId).toBe('ILP');
      expect(result.current.accounts[0].creditBalance).toBe(1000n);
    });

    it('ignores non-ACCOUNT_BALANCE events', async () => {
      const { result } = renderHook(() => useAccountBalances());

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'PACKET_RECEIVED',
          nodeId: 'connector-a',
          timestamp: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(result.current.status).toBe('connected');
      });

      expect(result.current.totalAccounts).toBe(0);
    });
  });

  describe('balance history tracking', () => {
    it('tracks balance history entries', async () => {
      const { result } = renderHook(() => useAccountBalances());

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      // Send multiple balance updates
      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'ACCOUNT_BALANCE',
          peerId: 'peer-b',
          tokenId: 'ILP',
          debitBalance: '0',
          creditBalance: '1000',
          netBalance: '-1000',
          settlementState: 'IDLE',
          timestamp: new Date().toISOString(),
        });
      });

      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'ACCOUNT_BALANCE',
          peerId: 'peer-b',
          tokenId: 'ILP',
          debitBalance: '0',
          creditBalance: '2000',
          netBalance: '-2000',
          settlementState: 'IDLE',
          timestamp: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(result.current.accounts[0].balanceHistory.length).toBe(2);
      });
    });
  });

  describe('sorting', () => {
    it('returns accounts sorted by net balance (highest first)', async () => {
      const { result } = renderHook(() => useAccountBalances());

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'ACCOUNT_BALANCE',
          peerId: 'peer-low',
          tokenId: 'ILP',
          debitBalance: '0',
          creditBalance: '0',
          netBalance: '-1000',
          settlementState: 'IDLE',
          timestamp: new Date().toISOString(),
        });
      });

      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'ACCOUNT_BALANCE',
          peerId: 'peer-high',
          tokenId: 'ILP',
          debitBalance: '0',
          creditBalance: '0',
          netBalance: '5000',
          settlementState: 'IDLE',
          timestamp: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(result.current.totalAccounts).toBe(2);
      });

      // Highest net balance should be first
      expect(result.current.accounts[0].peerId).toBe('peer-high');
      expect(result.current.accounts[1].peerId).toBe('peer-low');
    });
  });

  describe('near threshold count', () => {
    it('counts accounts near settlement threshold (>70%)', async () => {
      const { result } = renderHook(() => useAccountBalances());

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'ACCOUNT_BALANCE',
          peerId: 'peer-near',
          tokenId: 'ILP',
          debitBalance: '0',
          creditBalance: '8000',
          netBalance: '-8000',
          settlementThreshold: '10000',
          settlementState: 'IDLE',
          timestamp: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(result.current.nearThresholdCount).toBe(1);
      });
    });
  });

  describe('clear accounts', () => {
    it('clears all account data', async () => {
      const { result } = renderHook(() => useAccountBalances());

      act(() => {
        MockWebSocket.instances[0].simulateOpen();
      });

      act(() => {
        MockWebSocket.instances[0].simulateMessage({
          type: 'ACCOUNT_BALANCE',
          peerId: 'peer-b',
          tokenId: 'ILP',
          debitBalance: '0',
          creditBalance: '1000',
          netBalance: '-1000',
          settlementState: 'IDLE',
          timestamp: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(result.current.totalAccounts).toBe(1);
      });

      act(() => {
        result.current.clearAccounts();
      });

      expect(result.current.totalAccounts).toBe(0);
    });
  });
});
