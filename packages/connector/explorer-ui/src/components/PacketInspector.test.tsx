import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PacketInspector, isPacketEvent } from './PacketInspector';
import { TelemetryEvent } from '@/lib/event-types';

// Mock the countdown hook to avoid timer issues in tests
vi.mock('@/hooks/useExpiryCountdown', () => ({
  useExpiryCountdown: () => ({
    countdown: '5m 30s',
    isExpired: false,
    diffMs: 330000,
  }),
}));

describe('PacketInspector', () => {
  const createPacketEvent = (overrides = {}): TelemetryEvent =>
    ({
      type: 'PACKET_RECEIVED',
      nodeId: 'connector-a',
      timestamp: Date.now(),
      packetType: 'PREPARE',
      source: 'peer-a',
      destination: 'g.test.receiver',
      amount: '1000000',
      packetId: 'abc123def456',
      ...overrides,
    }) as TelemetryEvent;

  describe('isPacketEvent', () => {
    it('returns true for PACKET_RECEIVED events', () => {
      const event = createPacketEvent({ type: 'PACKET_RECEIVED' });
      expect(isPacketEvent(event)).toBe(true);
    });

    it('returns true for PACKET_FORWARDED events', () => {
      const event = createPacketEvent({ type: 'PACKET_FORWARDED' });
      expect(isPacketEvent(event)).toBe(true);
    });

    it('returns true for PACKET_SENT events', () => {
      const event = createPacketEvent({ type: 'PACKET_SENT' });
      expect(isPacketEvent(event)).toBe(true);
    });

    it('returns false for non-packet events', () => {
      const event = { type: 'SETTLEMENT_COMPLETED' } as TelemetryEvent;
      expect(isPacketEvent(event)).toBe(false);
    });
  });

  describe('Prepare packet display', () => {
    it('shows Prepare badge for PREPARE packets', () => {
      const event = createPacketEvent({ packetType: 'PREPARE' });
      render(<PacketInspector event={event} />);

      expect(screen.getByText('Prepare')).toBeInTheDocument();
      expect(screen.getByText('Type 12')).toBeInTheDocument();
    });

    it('displays destination address', () => {
      const event = createPacketEvent({ destination: 'g.test.receiver' });
      render(<PacketInspector event={event} />);

      expect(screen.getByText('g.test.receiver')).toBeInTheDocument();
    });

    it('formats amount with thousands separator', () => {
      const event = createPacketEvent({ amount: '1000000' });
      render(<PacketInspector event={event} />);

      expect(screen.getByText(/1,000,000/)).toBeInTheDocument();
    });

    it('displays source', () => {
      const event = createPacketEvent({ source: 'peer-sender' });
      render(<PacketInspector event={event} />);

      expect(screen.getByText('peer-sender')).toBeInTheDocument();
    });

    it('shows expiry countdown for future dates', () => {
      const futureDate = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const event = createPacketEvent({ expiresAt: futureDate });
      render(<PacketInspector event={event} />);

      expect(screen.getByText('5m 30s')).toBeInTheDocument();
    });
  });

  describe('Fulfill packet display', () => {
    it('shows Fulfill badge for FULFILL packets', () => {
      const event = createPacketEvent({ packetType: 'FULFILL' });
      render(<PacketInspector event={event} />);

      expect(screen.getByText('Fulfill')).toBeInTheDocument();
      expect(screen.getByText('Type 13')).toBeInTheDocument();
    });

    it('displays fulfillment hex', () => {
      const event = createPacketEvent({
        packetType: 'FULFILL',
        fulfillment: 'aabbccdd11223344',
      });
      render(<PacketInspector event={event} />);

      expect(screen.getByText(/aabbccdd/)).toBeInTheDocument();
    });
  });

  describe('Reject packet display', () => {
    it('shows Reject badge for REJECT packets', () => {
      const event = createPacketEvent({ packetType: 'REJECT' });
      render(<PacketInspector event={event} />);

      expect(screen.getByText('Reject')).toBeInTheDocument();
      expect(screen.getByText('Type 14')).toBeInTheDocument();
    });

    it('displays error code with description', () => {
      const event = createPacketEvent({
        packetType: 'REJECT',
        errorCode: 'F02',
      });
      render(<PacketInspector event={event} />);

      expect(screen.getByText('F02')).toBeInTheDocument();
      expect(screen.getByText(/Unreachable/)).toBeInTheDocument();
    });

    it('shows triggered by address', () => {
      const event = createPacketEvent({
        packetType: 'REJECT',
        triggeredBy: 'g.connector.fail',
      });
      render(<PacketInspector event={event} />);

      expect(screen.getByText('g.connector.fail')).toBeInTheDocument();
    });

    it('shows error message', () => {
      const event = createPacketEvent({
        packetType: 'REJECT',
        errorMessage: 'No route found',
      });
      render(<PacketInspector event={event} />);

      expect(screen.getByText('No route found')).toBeInTheDocument();
    });
  });

  describe('non-packet events', () => {
    it('shows message for non-packet events', () => {
      const event = { type: 'SETTLEMENT_COMPLETED' } as TelemetryEvent;
      render(<PacketInspector event={event} />);

      expect(screen.getByText(/does not contain ILP packet data/)).toBeInTheDocument();
    });
  });
});
