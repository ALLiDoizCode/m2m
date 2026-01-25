import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EventDetailPanel } from './EventDetailPanel';
import { TelemetryEvent, StoredEvent } from '@/lib/event-types';

// Mock the hooks
vi.mock('@/hooks/useRelatedEvents', () => ({
  useRelatedEvents: () => ({
    relatedEvents: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
  hasPacketId: (event: unknown) => {
    if (!event) return false;
    const e = event as Record<string, unknown>;
    return 'packet_id' in e || 'packetId' in e;
  },
}));

// Mock localStorage
const mockLocalStorage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
};
Object.defineProperty(window, 'localStorage', { value: mockLocalStorage });

describe('EventDetailPanel', () => {
  const mockOnClose = vi.fn();
  const mockOnEventSelect = vi.fn();

  const mockTelemetryEvent: TelemetryEvent = {
    type: 'PACKET_RECEIVED',
    nodeId: 'connector-a',
    timestamp: '2026-01-25T12:00:00.000Z',
    peerId: 'peer-b',
  };

  const mockStoredEvent: StoredEvent = {
    id: 1,
    event_type: 'PACKET_RECEIVED',
    timestamp: Date.now(),
    node_id: 'connector-a',
    direction: 'received',
    peer_id: 'peer-b',
    packet_id: 'abc123',
    amount: '1000000',
    destination: 'g.test.receiver',
    payload: mockTelemetryEvent,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.getItem.mockReturnValue('raw');
  });

  it('renders nothing when event is null', () => {
    render(
      <EventDetailPanel event={null} onClose={mockOnClose} onEventSelect={mockOnEventSelect} />
    );

    // Sheet should not be visible
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders panel when event is provided', () => {
    render(
      <EventDetailPanel
        event={mockStoredEvent}
        onClose={mockOnClose}
        onEventSelect={mockOnEventSelect}
      />
    );

    // Should show event type
    expect(screen.getByText('PACKET_RECEIVED')).toBeInTheDocument();
  });

  it('displays event metadata correctly', () => {
    render(
      <EventDetailPanel
        event={mockStoredEvent}
        onClose={mockOnClose}
        onEventSelect={mockOnEventSelect}
      />
    );

    // Should show node ID
    expect(screen.getByText('connector-a')).toBeInTheDocument();
    // Should show peer ID
    expect(screen.getByText('peer-b')).toBeInTheDocument();
  });

  it('calls onClose when sheet is closed', () => {
    render(
      <EventDetailPanel
        event={mockStoredEvent}
        onClose={mockOnClose}
        onEventSelect={mockOnEventSelect}
      />
    );

    // Find and click close button
    const closeButton = screen.getByRole('button', { name: /close/i });
    fireEvent.click(closeButton);

    expect(mockOnClose).toHaveBeenCalled();
  });

  it('closes panel on Escape key', () => {
    render(
      <EventDetailPanel
        event={mockStoredEvent}
        onClose={mockOnClose}
        onEventSelect={mockOnEventSelect}
      />
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(mockOnClose).toHaveBeenCalled();
  });

  it('shows Raw tab by default', () => {
    render(
      <EventDetailPanel
        event={mockStoredEvent}
        onClose={mockOnClose}
        onEventSelect={mockOnEventSelect}
      />
    );

    expect(screen.getByRole('tab', { name: /raw/i })).toHaveAttribute('data-state', 'active');
  });

  it('shows multiple tabs when applicable', () => {
    render(
      <EventDetailPanel
        event={mockStoredEvent}
        onClose={mockOnClose}
        onEventSelect={mockOnEventSelect}
      />
    );

    // Raw tab should always be present
    expect(screen.getByRole('tab', { name: /raw/i })).toBeInTheDocument();
    // Related tab should be present since mockStoredEvent has packet_id
    expect(screen.getByRole('tab', { name: /related/i })).toBeInTheDocument();
  });

  it('renders JsonViewer in raw tab', () => {
    render(
      <EventDetailPanel
        event={mockStoredEvent}
        onClose={mockOnClose}
        onEventSelect={mockOnEventSelect}
      />
    );

    // Raw tab content should show the event type
    expect(screen.getByText('PACKET_RECEIVED')).toBeInTheDocument();
  });
});
