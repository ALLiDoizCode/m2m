import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AccountsView } from './AccountsView';

// Mock the hooks
vi.mock('@/hooks/useAccountBalances', () => ({
  useAccountBalances: vi.fn(),
}));

vi.mock('@/hooks/usePaymentChannels', () => ({
  usePaymentChannels: vi.fn(),
}));

vi.mock('@/hooks/useWalletBalances', () => ({
  useWalletBalances: vi.fn(),
}));

import { useAccountBalances } from '@/hooks/useAccountBalances';
import { usePaymentChannels } from '@/hooks/usePaymentChannels';
import { useWalletBalances } from '@/hooks/useWalletBalances';

const mockUseAccountBalances = vi.mocked(useAccountBalances);
const mockUsePaymentChannels = vi.mocked(usePaymentChannels);
const mockUseWalletBalances = vi.mocked(useWalletBalances);

describe('AccountsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock returns
    mockUsePaymentChannels.mockReturnValue({
      channels: [],
      channelsMap: new Map(),
      status: 'connected',
      error: null,
      totalChannels: 0,
      activeChannelCount: 0,
      clearChannels: vi.fn(),
      reconnect: vi.fn(),
    });

    mockUseWalletBalances.mockReturnValue({
      data: null,
      loading: false,
      error: null,
      lastUpdated: null,
      refresh: vi.fn(),
    });
  });

  describe('empty state', () => {
    it('renders empty state when no accounts', () => {
      mockUseAccountBalances.mockReturnValue({
        accounts: [],
        accountsMap: new Map(),
        status: 'connected',
        error: null,
        totalAccounts: 0,
        nearThresholdCount: 0,
        clearAccounts: vi.fn(),
        reconnect: vi.fn(),
      });

      render(<AccountsView />);

      expect(screen.getByText('No peer accounts yet')).toBeInTheDocument();
      expect(
        screen.getByText('Balance events will appear as packets flow through the connector.')
      ).toBeInTheDocument();
    });

    it('shows skeleton loaders when status is connecting', () => {
      mockUseAccountBalances.mockReturnValue({
        accounts: [],
        accountsMap: new Map(),
        status: 'connecting',
        error: null,
        totalAccounts: 0,
        nearThresholdCount: 0,
        clearAccounts: vi.fn(),
        reconnect: vi.fn(),
      });

      const { container } = render(<AccountsView />);

      // Skeleton loaders should be present (animate-pulse divs)
      const skeletonElements = container.querySelectorAll('.animate-pulse');
      expect(skeletonElements.length).toBeGreaterThan(0);
    });

    it('shows error message when status is error', () => {
      mockUseAccountBalances.mockReturnValue({
        accounts: [],
        accountsMap: new Map(),
        status: 'error',
        error: 'Connection failed',
        totalAccounts: 0,
        nearThresholdCount: 0,
        clearAccounts: vi.fn(),
        reconnect: vi.fn(),
      });

      render(<AccountsView />);

      expect(
        screen.getByText(
          'Failed to connect to event stream. Please check the connector is running.'
        )
      ).toBeInTheDocument();
    });
  });

  describe('with accounts', () => {
    it('renders grid of AccountCards when accounts exist', () => {
      mockUseAccountBalances.mockReturnValue({
        accounts: [
          {
            peerId: 'peer-a',
            tokenId: 'ILP',
            debitBalance: 0n,
            creditBalance: 1000n,
            netBalance: 1000n,
            settlementState: 'IDLE',
            balanceHistory: [],
            lastUpdated: Date.now(),
          },
          {
            peerId: 'peer-b',
            tokenId: 'ETH',
            debitBalance: 500n,
            creditBalance: 0n,
            netBalance: -500n,
            settlementState: 'IDLE',
            balanceHistory: [],
            lastUpdated: Date.now(),
          },
        ],
        accountsMap: new Map(),
        status: 'connected',
        error: null,
        totalAccounts: 2,
        nearThresholdCount: 0,
        clearAccounts: vi.fn(),
        reconnect: vi.fn(),
      });

      render(<AccountsView />);

      expect(screen.getByText('peer-a')).toBeInTheDocument();
      expect(screen.getByText('peer-b')).toBeInTheDocument();
    });

    it('displays summary stats correctly', () => {
      mockUseAccountBalances.mockReturnValue({
        accounts: [
          {
            peerId: 'peer-a',
            tokenId: 'ILP',
            debitBalance: 0n,
            creditBalance: 0n,
            netBalance: 0n,
            settlementState: 'IDLE',
            balanceHistory: [],
            lastUpdated: Date.now(),
          },
        ],
        accountsMap: new Map(),
        status: 'connected',
        error: null,
        totalAccounts: 3,
        nearThresholdCount: 1,
        clearAccounts: vi.fn(),
        reconnect: vi.fn(),
      });

      render(<AccountsView />);

      expect(screen.getByText('Total Accounts')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('Near Threshold')).toBeInTheDocument();
      expect(screen.getByText('1')).toBeInTheDocument();
    });
  });

  describe('responsive layout', () => {
    it('renders Peer Accounts section header', () => {
      mockUseAccountBalances.mockReturnValue({
        accounts: [
          {
            peerId: 'peer-a',
            tokenId: 'ILP',
            debitBalance: 0n,
            creditBalance: 0n,
            netBalance: 0n,
            settlementState: 'IDLE',
            balanceHistory: [],
            lastUpdated: Date.now(),
          },
        ],
        accountsMap: new Map(),
        status: 'connected',
        error: null,
        totalAccounts: 1,
        nearThresholdCount: 0,
        clearAccounts: vi.fn(),
        reconnect: vi.fn(),
      });

      render(<AccountsView />);

      expect(screen.getByText('Peer Accounts')).toBeInTheDocument();
    });
  });
});
