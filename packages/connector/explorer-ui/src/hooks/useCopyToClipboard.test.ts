import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCopyToClipboard } from './useCopyToClipboard';

describe('useCopyToClipboard', () => {
  const mockWriteText = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    // Mock clipboard API
    Object.assign(navigator, {
      clipboard: {
        writeText: mockWriteText,
      },
    });
    mockWriteText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('calls navigator.clipboard.writeText on copy', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy('test text');
    });

    expect(mockWriteText).toHaveBeenCalledWith('test text');
  });

  it('sets copied state to true after successful copy', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    expect(result.current.copied).toBe(false);

    await act(async () => {
      await result.current.copy('test text');
    });

    expect(result.current.copied).toBe(true);
  });

  it('resets copied state after timeout', async () => {
    const { result } = renderHook(() => useCopyToClipboard(1000));

    await act(async () => {
      await result.current.copy('test text');
    });

    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current.copied).toBe(false);
  });

  it('handles clipboard API errors gracefully', async () => {
    mockWriteText.mockRejectedValue(new Error('Clipboard error'));

    const { result } = renderHook(() => useCopyToClipboard());

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.copy('test text');
    });

    // Should return false on error (fallback may also fail)
    expect(success).toBe(false);
    expect(result.current.error).toBeTruthy();
  });

  it('returns true on successful copy', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.copy('test text');
    });

    expect(success).toBe(true);
  });

  it('reset clears copied and error states', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy('test text');
    });

    expect(result.current.copied).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.copied).toBe(false);
    expect(result.current.error).toBe(null);
  });

  it('uses custom timeout duration', async () => {
    const { result } = renderHook(() => useCopyToClipboard(500));

    await act(async () => {
      await result.current.copy('test text');
    });

    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.copied).toBe(false);
  });

  it('clears previous timeout when copying again', async () => {
    const { result } = renderHook(() => useCopyToClipboard(1000));

    await act(async () => {
      await result.current.copy('first');
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    // Copy again before timeout
    await act(async () => {
      await result.current.copy('second');
    });

    // Advance past original timeout
    act(() => {
      vi.advanceTimersByTime(600);
    });

    // Should still be copied since second copy reset the timer
    expect(result.current.copied).toBe(true);

    // Advance to complete second timeout
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(result.current.copied).toBe(false);
  });
});
