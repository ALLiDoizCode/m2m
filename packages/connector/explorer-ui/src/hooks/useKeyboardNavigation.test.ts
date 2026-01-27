import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { useKeyboardNavigation } from './useKeyboardNavigation';
import { TelemetryEvent } from '../lib/event-types';

function makeEvent(index: number): TelemetryEvent {
  return {
    type: 'PACKET_RECEIVED',
    timestamp: Date.now() - index * 1000,
    nodeId: 'node-0',
    peerId: `peer-${index}`,
  } as TelemetryEvent;
}

describe('useKeyboardNavigation', () => {
  let onEventClick: (event: TelemetryEvent) => void;
  let scrollToIndex: (index: number) => void;
  let events: TelemetryEvent[];

  beforeEach(() => {
    onEventClick = vi.fn() as unknown as (event: TelemetryEvent) => void;
    scrollToIndex = vi.fn() as unknown as (index: number) => void;
    events = [makeEvent(0), makeEvent(1), makeEvent(2), makeEvent(3), makeEvent(4)];
  });

  it('should initialize with selectedIndex null', () => {
    const { result } = renderHook(() =>
      useKeyboardNavigation({ events, onEventClick, scrollToIndex })
    );
    expect(result.current.selectedIndex).toBeNull();
  });

  describe('j/k navigation', () => {
    it('should set selectedIndex to 0 on first j press', () => {
      const { result } = renderHook(() =>
        useKeyboardNavigation({ events, onEventClick, scrollToIndex })
      );

      act(() => {
        fireEvent.keyDown(document, { key: 'j' });
      });

      expect(result.current.selectedIndex).toBe(0);
      expect(scrollToIndex).toHaveBeenCalledWith(0);
    });

    it('should increment selectedIndex on j press', () => {
      const { result } = renderHook(() =>
        useKeyboardNavigation({ events, onEventClick, scrollToIndex })
      );

      act(() => {
        fireEvent.keyDown(document, { key: 'j' });
      });
      act(() => {
        fireEvent.keyDown(document, { key: 'j' });
      });

      expect(result.current.selectedIndex).toBe(1);
      expect(scrollToIndex).toHaveBeenCalledWith(1);
    });

    it('should decrement selectedIndex on k press', () => {
      const { result } = renderHook(() =>
        useKeyboardNavigation({ events, onEventClick, scrollToIndex })
      );

      // Move down twice
      act(() => {
        fireEvent.keyDown(document, { key: 'j' });
      });
      act(() => {
        fireEvent.keyDown(document, { key: 'j' });
      });
      // Move up once
      act(() => {
        fireEvent.keyDown(document, { key: 'k' });
      });

      expect(result.current.selectedIndex).toBe(0);
      expect(scrollToIndex).toHaveBeenCalledWith(0);
    });

    it('should work with ArrowDown/ArrowUp keys', () => {
      const { result } = renderHook(() =>
        useKeyboardNavigation({ events, onEventClick, scrollToIndex })
      );

      act(() => {
        fireEvent.keyDown(document, { key: 'ArrowDown' });
      });

      expect(result.current.selectedIndex).toBe(0);

      act(() => {
        fireEvent.keyDown(document, { key: 'ArrowDown' });
      });

      expect(result.current.selectedIndex).toBe(1);

      act(() => {
        fireEvent.keyDown(document, { key: 'ArrowUp' });
      });

      expect(result.current.selectedIndex).toBe(0);
    });

    it('should not go below 0', () => {
      const { result } = renderHook(() =>
        useKeyboardNavigation({ events, onEventClick, scrollToIndex })
      );

      act(() => {
        fireEvent.keyDown(document, { key: 'j' });
      });
      act(() => {
        fireEvent.keyDown(document, { key: 'k' });
      });
      act(() => {
        fireEvent.keyDown(document, { key: 'k' });
      });

      expect(result.current.selectedIndex).toBe(0);
    });

    it('should not exceed events length', () => {
      const { result } = renderHook(() =>
        useKeyboardNavigation({ events, onEventClick, scrollToIndex })
      );

      for (let i = 0; i < 10; i++) {
        act(() => {
          fireEvent.keyDown(document, { key: 'j' });
        });
      }

      expect(result.current.selectedIndex).toBe(4); // max index = events.length - 1
    });
  });

  describe('Enter key', () => {
    it('should trigger onEventClick with correct event', () => {
      const { result } = renderHook(() =>
        useKeyboardNavigation({ events, onEventClick, scrollToIndex })
      );

      // Navigate to index 2
      act(() => {
        fireEvent.keyDown(document, { key: 'j' });
      });
      act(() => {
        fireEvent.keyDown(document, { key: 'j' });
      });
      act(() => {
        fireEvent.keyDown(document, { key: 'j' });
      });

      expect(result.current.selectedIndex).toBe(2);

      act(() => {
        fireEvent.keyDown(document, { key: 'Enter' });
      });

      expect(onEventClick).toHaveBeenCalledWith(events[2]);
    });

    it('should not trigger onEventClick when no row is selected', () => {
      renderHook(() => useKeyboardNavigation({ events, onEventClick, scrollToIndex }));

      act(() => {
        fireEvent.keyDown(document, { key: 'Enter' });
      });

      expect(onEventClick).not.toHaveBeenCalled();
    });
  });

  describe('input focus guard', () => {
    it('should suppress shortcuts when input element is focused', () => {
      const { result } = renderHook(() =>
        useKeyboardNavigation({ events, onEventClick, scrollToIndex })
      );

      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      act(() => {
        fireEvent.keyDown(document, { key: 'j' });
      });

      expect(result.current.selectedIndex).toBeNull();

      document.body.removeChild(input);
    });

    it('should suppress shortcuts when textarea element is focused', () => {
      const { result } = renderHook(() =>
        useKeyboardNavigation({ events, onEventClick, scrollToIndex })
      );

      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);
      textarea.focus();

      act(() => {
        fireEvent.keyDown(document, { key: 'j' });
      });

      expect(result.current.selectedIndex).toBeNull();

      document.body.removeChild(textarea);
    });

    it('should suppress shortcuts when contenteditable element is focused', () => {
      const { result } = renderHook(() =>
        useKeyboardNavigation({ events, onEventClick, scrollToIndex })
      );

      const div = document.createElement('div');
      div.setAttribute('contenteditable', 'true');
      div.tabIndex = 0;
      document.body.appendChild(div);
      div.focus();

      // jsdom doesn't properly support contenteditable focus,
      // so we also verify via a spy on activeElement
      vi.spyOn(document, 'activeElement', 'get').mockReturnValue(div);

      act(() => {
        fireEvent.keyDown(document, { key: 'j' });
      });

      expect(result.current.selectedIndex).toBeNull();

      vi.restoreAllMocks();
      document.body.removeChild(div);
    });
  });

  describe('events reset', () => {
    it('should reset selectedIndex when events array reference changes', () => {
      const { result, rerender } = renderHook(
        ({ events: evts }) => useKeyboardNavigation({ events: evts, onEventClick, scrollToIndex }),
        { initialProps: { events } }
      );

      // Navigate to index 2
      act(() => {
        fireEvent.keyDown(document, { key: 'j' });
      });
      act(() => {
        fireEvent.keyDown(document, { key: 'j' });
      });
      act(() => {
        fireEvent.keyDown(document, { key: 'j' });
      });

      expect(result.current.selectedIndex).toBe(2);

      // Change events reference
      const newEvents = [makeEvent(10), makeEvent(11)];
      rerender({ events: newEvents });

      expect(result.current.selectedIndex).toBeNull();
    });
  });

  describe('enabled flag', () => {
    it('should not respond to keys when disabled', () => {
      const { result } = renderHook(() =>
        useKeyboardNavigation({ events, onEventClick, scrollToIndex, enabled: false })
      );

      act(() => {
        fireEvent.keyDown(document, { key: 'j' });
      });

      expect(result.current.selectedIndex).toBeNull();
    });
  });
});
