import * as React from 'react';

export interface UseCopyToClipboardResult {
  /** Copy text to clipboard */
  copy: (text: string) => Promise<boolean>;
  /** Whether content was recently copied (for visual feedback) */
  copied: boolean;
  /** Error message if copy failed */
  error: string | null;
  /** Reset the copied state */
  reset: () => void;
}

/**
 * Hook for copying text to clipboard with visual feedback
 *
 * @param timeout - Duration in ms to show "Copied!" feedback (default: 1500)
 * @returns Copy function, copied state, and error
 *
 * @example
 * ```tsx
 * function CopyButton({ text }: { text: string }) {
 *   const { copy, copied } = useCopyToClipboard();
 *   return (
 *     <button onClick={() => copy(text)}>
 *       {copied ? 'Copied!' : 'Copy'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useCopyToClipboard(timeout = 1500): UseCopyToClipboardResult {
  const [copied, setCopied] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const copy = React.useCallback(
    async (text: string): Promise<boolean> => {
      // Clear any existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      try {
        // Check if clipboard API is available
        if (!navigator.clipboard) {
          throw new Error('Clipboard API not available');
        }

        await navigator.clipboard.writeText(text);
        setCopied(true);
        setError(null);

        // Reset copied state after timeout
        timeoutRef.current = setTimeout(() => {
          setCopied(false);
        }, timeout);

        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to copy to clipboard';
        setError(message);
        setCopied(false);

        // Try fallback for older browsers
        try {
          const textArea = document.createElement('textarea');
          textArea.value = text;
          textArea.style.position = 'fixed';
          textArea.style.left = '-9999px';
          textArea.style.top = '-9999px';
          document.body.appendChild(textArea);
          textArea.focus();
          textArea.select();

          const success = document.execCommand('copy');
          document.body.removeChild(textArea);

          if (success) {
            setCopied(true);
            setError(null);
            timeoutRef.current = setTimeout(() => {
              setCopied(false);
            }, timeout);
            return true;
          }
        } catch {
          // Fallback also failed
        }

        return false;
      }
    },
    [timeout]
  );

  const reset = React.useCallback(() => {
    setCopied(false);
    setError(null);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  return {
    copy,
    copied,
    error,
    reset,
  };
}
