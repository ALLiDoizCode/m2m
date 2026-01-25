import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEventStream } from './useEventStream';

// WebSocket readyState constants
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readyState: number = WS_CONNECTING;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.readyState = WS_CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent('close'));
    }
  }

  send(_data: string) {}

  // Helper to simulate connection
  simulateOpen() {
    this.readyState = WS_OPEN;
    if (this.onopen) {
      this.onopen(new Event('open'));
    }
  }

  // Helper to simulate message
  simulateMessage(data: object) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data: JSON.stringify(data) }));
    }
  }
}

describe('useEventStream', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should start with connecting status', () => {
    const { result } = renderHook(() => useEventStream());
    expect(result.current.status).toBe('connecting');
  });

  it('should connect to WebSocket and update status', async () => {
    const { result } = renderHook(() => useEventStream());

    await act(async () => {
      MockWebSocket.instances[0]?.simulateOpen();
    });

    expect(result.current.status).toBe('connected');
  });

  it('should receive and store events', async () => {
    const { result } = renderHook(() => useEventStream());

    await act(async () => {
      MockWebSocket.instances[0]?.simulateOpen();
      MockWebSocket.instances[0]?.simulateMessage({
        type: 'ACCOUNT_BALANCE',
        nodeId: 'test-node',
        timestamp: Date.now(),
      });
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]?.type).toBe('ACCOUNT_BALANCE');
  });

  it('should limit events to maxEvents', async () => {
    const { result } = renderHook(() => useEventStream({ maxEvents: 5 }));

    await act(async () => {
      MockWebSocket.instances[0]?.simulateOpen();
      for (let i = 0; i < 10; i++) {
        MockWebSocket.instances[0]?.simulateMessage({
          type: 'ACCOUNT_BALANCE',
          nodeId: 'test-node',
          timestamp: Date.now() + i,
        });
      }
    });

    expect(result.current.events).toHaveLength(5);
  });

  it('should clear events when clearEvents is called', async () => {
    const { result } = renderHook(() => useEventStream());

    await act(async () => {
      MockWebSocket.instances[0]?.simulateOpen();
      MockWebSocket.instances[0]?.simulateMessage({
        type: 'ACCOUNT_BALANCE',
        nodeId: 'test-node',
        timestamp: Date.now(),
      });
    });

    expect(result.current.events).toHaveLength(1);

    act(() => {
      result.current.clearEvents();
    });

    expect(result.current.events).toHaveLength(0);
  });
});
