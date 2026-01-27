import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KeyboardHelpDialog } from './KeyboardHelpDialog';

describe('KeyboardHelpDialog', () => {
  it('should render shortcuts table when open', () => {
    render(<KeyboardHelpDialog open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText('Keyboard Shortcuts')).toBeDefined();
    expect(screen.getByText('Move selection down')).toBeDefined();
    expect(screen.getByText('Switch to Events tab')).toBeDefined();
    expect(screen.getByText('Switch to Peers tab')).toBeDefined();
    expect(screen.getByText('Focus search input')).toBeDefined();
    expect(screen.getByText('Show this help')).toBeDefined();
  });

  it('should not render when closed', () => {
    render(<KeyboardHelpDialog open={false} onOpenChange={vi.fn()} />);

    expect(screen.queryByText('Keyboard Shortcuts')).toBeNull();
  });
});
