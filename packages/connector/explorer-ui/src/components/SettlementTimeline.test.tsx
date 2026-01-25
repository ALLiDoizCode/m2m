import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettlementTimeline, SettlementEntry } from './SettlementTimeline';

describe('SettlementTimeline', () => {
  const createSettlement = (overrides: Partial<SettlementEntry> = {}): SettlementEntry => ({
    triggeredAt: new Date().toISOString(),
    amount: '1000000',
    type: 'MOCK',
    ...overrides,
  });

  describe('empty state', () => {
    it('shows no activity message when settlements array is empty', () => {
      render(<SettlementTimeline peerId="peer-a" settlements={[]} />);

      expect(screen.getByText('No settlement activity for peer-a')).toBeInTheDocument();
    });
  });

  describe('settlement flow visualization', () => {
    it('shows triggered state for settlement without completion', () => {
      const settlements = [createSettlement({ completedAt: undefined })];

      render(<SettlementTimeline peerId="peer-a" settlements={settlements} />);

      // In progress state shows "In progress" text with elapsed time
      expect(screen.getByText(/In progress/i)).toBeInTheDocument();
    });

    it('shows completed state for successful settlement', () => {
      const settlements = [
        createSettlement({
          completedAt: new Date().toISOString(),
          success: true,
        }),
      ];

      render(<SettlementTimeline peerId="peer-a" settlements={settlements} />);

      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('shows failed state for unsuccessful settlement', () => {
      const settlements = [
        createSettlement({
          completedAt: new Date().toISOString(),
          success: false,
          errorMessage: 'Insufficient balance',
        }),
      ];

      render(<SettlementTimeline peerId="peer-a" settlements={settlements} />);

      expect(screen.getByText('Failed')).toBeInTheDocument();
      expect(screen.getByText('Error: Insufficient balance')).toBeInTheDocument();
    });
  });

  describe('settlement details', () => {
    it('displays settlement amount', () => {
      const settlements = [createSettlement({ amount: '1000000' })];

      render(<SettlementTimeline peerId="peer-a" settlements={settlements} />);

      // Amount is formatted with decimal places
      expect(screen.getByText('1.00M')).toBeInTheDocument();
    });

    it('displays settlement type badge (MOCK)', () => {
      const settlements = [createSettlement({ type: 'MOCK' })];

      render(<SettlementTimeline peerId="peer-a" settlements={settlements} />);

      expect(screen.getByText('MOCK')).toBeInTheDocument();
    });

    it('displays settlement type badge (EVM)', () => {
      const settlements = [createSettlement({ type: 'EVM' })];

      render(<SettlementTimeline peerId="peer-a" settlements={settlements} />);

      expect(screen.getByText('EVM')).toBeInTheDocument();
    });

    it('displays settlement type badge (XRP)', () => {
      const settlements = [createSettlement({ type: 'XRP' })];

      render(<SettlementTimeline peerId="peer-a" settlements={settlements} />);

      expect(screen.getByText('XRP')).toBeInTheDocument();
    });
  });

  describe('trigger reason', () => {
    it('shows Auto badge for threshold exceeded trigger', () => {
      const settlements = [createSettlement({ triggerReason: 'THRESHOLD_EXCEEDED' })];

      render(<SettlementTimeline peerId="peer-a" settlements={settlements} />);

      expect(screen.getByText('Auto')).toBeInTheDocument();
    });

    it('shows Manual badge for manual trigger', () => {
      const settlements = [createSettlement({ triggerReason: 'MANUAL' })];

      render(<SettlementTimeline peerId="peer-a" settlements={settlements} />);

      expect(screen.getByText('Manual')).toBeInTheDocument();
    });
  });

  describe('multiple settlements', () => {
    it('renders multiple settlement entries', () => {
      const settlements = [
        createSettlement({ amount: '1000000', type: 'MOCK' }),
        createSettlement({ amount: '2000000', type: 'EVM' }),
      ];

      render(<SettlementTimeline peerId="peer-a" settlements={settlements} />);

      // Amounts are formatted with decimal places
      expect(screen.getByText('1.00M')).toBeInTheDocument();
      expect(screen.getByText('2.00M')).toBeInTheDocument();
    });

    it('shows Settlement History header', () => {
      const settlements = [createSettlement()];

      render(<SettlementTimeline peerId="peer-a" settlements={settlements} />);

      expect(screen.getByText('Settlement History')).toBeInTheDocument();
    });
  });
});
