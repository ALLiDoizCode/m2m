import { useState, useEffect, useCallback, useRef } from 'react';
import { TelemetryEvent } from '../lib/event-types';

interface UseKeyboardNavigationOptions {
  events: TelemetryEvent[];
  onEventClick: (event: TelemetryEvent) => void;
  scrollToIndex: (index: number) => void;
  enabled?: boolean;
}

/**
 * Check if the currently focused element is an input-like element
 * where keyboard shortcuts should be suppressed
 */
function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tagName = el.tagName.toUpperCase();
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
  if (
    (el as HTMLElement).isContentEditable ||
    (el as HTMLElement).getAttribute('contenteditable') === 'true'
  ) {
    return true;
  }
  return false;
}

/**
 * Hook for keyboard navigation of event rows in EventTable.
 *
 * Supports:
 * - j / ArrowDown: move selection down
 * - k / ArrowUp: move selection up
 * - Enter: open detail panel for selected row
 *
 * Guards: shortcuts are suppressed when input/textarea/select/contenteditable has focus.
 * Resets selectedIndex when events array reference changes.
 */
export function useKeyboardNavigation({
  events,
  onEventClick,
  scrollToIndex,
  enabled = true,
}: UseKeyboardNavigationOptions): { selectedIndex: number | null } {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const eventsRef = useRef(events);
  eventsRef.current = events;

  // Reset selectedIndex when events array reference changes
  useEffect(() => {
    setSelectedIndex(null);
  }, [events]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return;
      if (isInputFocused()) return;

      const evts = eventsRef.current;
      if (evts.length === 0) return;

      switch (e.key) {
        case 'j':
        case 'ArrowDown': {
          e.preventDefault();
          setSelectedIndex((prev) => {
            const next = prev === null ? 0 : Math.min(prev + 1, evts.length - 1);
            scrollToIndex(next);
            return next;
          });
          break;
        }
        case 'k':
        case 'ArrowUp': {
          e.preventDefault();
          setSelectedIndex((prev) => {
            const next = prev === null ? 0 : Math.max(prev - 1, 0);
            scrollToIndex(next);
            return next;
          });
          break;
        }
        case 'Enter': {
          setSelectedIndex((prev) => {
            if (prev !== null && prev >= 0 && prev < evts.length) {
              onEventClick(evts[prev]);
            }
            return prev;
          });
          break;
        }
      }
    },
    [enabled, onEventClick, scrollToIndex]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return { selectedIndex };
}
