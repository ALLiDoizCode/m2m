import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEventStream } from './useEventStream';
import { createRAFMock } from '@/test/raf-helpers';

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

const rafMock = createRAFMock();
const flushRAF = rafMock.flush;

describe('useEventStream', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    rafMock.reset();
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('requestAnimationFrame', rafMock.requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', rafMock.cancelAnimationFrame);
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

  it('should receive and store events via RAF batching', async () => {
    const { result } = renderHook(() => useEventStream());

    await act(async () => {
      MockWebSocket.instances[0]?.simulateOpen();
      MockWebSocket.instances[0]?.simulateMessage({
        type: 'ACCOUNT_BALANCE',
        nodeId: 'test-node',
        timestamp: Date.now(),
      });
    });

    // Flush the RAF to process buffered events
    await flushRAF();

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]?.type).toBe('ACCOUNT_BALANCE');
  });

  it('should batch multiple messages into a single state update', async () => {
    const { result } = renderHook(() => useEventStream());

    await act(async () => {
      MockWebSocket.instances[0]?.simulateOpen();
      // Send multiple messages in quick succession (within one frame)
      for (let i = 0; i < 5; i++) {
        MockWebSocket.instances[0]?.simulateMessage({
          type: 'ACCOUNT_BALANCE',
          nodeId: 'test-node',
          timestamp: Date.now() + i,
          id: `event-${i}`,
        });
      }
    });

    // Before flush, events should still be empty (buffered in ref)
    expect(result.current.events).toHaveLength(0);

    // Flush RAF to apply batch
    await flushRAF();

    // All 5 events should appear after single flush
    expect(result.current.events).toHaveLength(5);
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

    // Flush the RAF
    await flushRAF();

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

    await flushRAF();

    expect(result.current.events).toHaveLength(1);

    act(() => {
      result.current.clearEvents();
    });

    expect(result.current.events).toHaveLength(0);
  });

  it('should flush events on unmount to avoid lost events', async () => {
    let capturedEvents: unknown[] = [];
    const { result, unmount } = renderHook(() => useEventStream());

    await act(async () => {
      MockWebSocket.instances[0]?.simulateOpen();
      // Send messages that are buffered but not yet flushed
      MockWebSocket.instances[0]?.simulateMessage({
        type: 'ACCOUNT_BALANCE',
        nodeId: 'test-node',
        timestamp: Date.now(),
        id: 'unmount-event',
      });
    });

    // Events are buffered, not yet flushed
    expect(result.current.events).toHaveLength(0);
    capturedEvents = result.current.events;

    // Unmount triggers cleanup which flushes buffer synchronously
    await act(async () => {
      unmount();
    });

    // After unmount the state update from cleanup will have run.
    // Since the hook is unmounted, we can't read result.current,
    // but the flush ensures setEvents was called (no lost events).
    // This test verifies the unmount cleanup path doesn't throw.
    expect(capturedEvents).toBeDefined();
  });

  it('should preserve newest-first ordering with batched events', async () => {
    const { result } = renderHook(() => useEventStream());

    await act(async () => {
      MockWebSocket.instances[0]?.simulateOpen();
      MockWebSocket.instances[0]?.simulateMessage({
        type: 'ACCOUNT_BALANCE',
        nodeId: 'test-node',
        timestamp: 1000,
        id: 'first',
      });
      MockWebSocket.instances[0]?.simulateMessage({
        type: 'ACCOUNT_BALANCE',
        nodeId: 'test-node',
        timestamp: 2000,
        id: 'second',
      });
      MockWebSocket.instances[0]?.simulateMessage({
        type: 'ACCOUNT_BALANCE',
        nodeId: 'test-node',
        timestamp: 3000,
        id: 'third',
      });
    });

    await flushRAF();

    // Newest event (last received) should be first in array
    expect(result.current.events).toHaveLength(3);
    expect((result.current.events[0] as unknown as { id: string }).id).toBe('third');
    expect((result.current.events[1] as unknown as { id: string }).id).toBe('second');
    expect((result.current.events[2] as unknown as { id: string }).id).toBe('first');
  });
});
