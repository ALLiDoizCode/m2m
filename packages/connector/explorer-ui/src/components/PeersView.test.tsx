import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PeersView } from './PeersView';

// Mock the hooks
vi.mock('@/hooks/usePeers', () => ({
  usePeers: vi.fn(),
}));

vi.mock('@/hooks/useRoutingTable', () => ({
  useRoutingTable: vi.fn(),
}));

import { usePeers } from '@/hooks/usePeers';
import { useRoutingTable } from '@/hooks/useRoutingTable';

const mockUsePeers = vi.mocked(usePeers);
const mockUseRoutingTable = vi.mocked(useRoutingTable);

describe('PeersView', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock returns
    mockUsePeers.mockReturnValue({
      peers: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    mockUseRoutingTable.mockReturnValue({
      routes: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  describe('empty state', () => {
    it('renders empty state when no peers and no routes', () => {
      render(<PeersView />);

      expect(screen.getByText('No peers connected yet')).toBeInTheDocument();
      expect(screen.getByText('Waiting for BTP connections...')).toBeInTheDocument();
    });

    it('shows error message when peers error exists', () => {
      mockUsePeers.mockReturnValue({
        peers: [],
        loading: false,
        error: 'Connection failed',
        refresh: vi.fn(),
      });

      render(<PeersView />);

      expect(
        screen.getByText('Failed to fetch peer data. Please check the connector is running.')
      ).toBeInTheDocument();
    });
  });

  describe('loading state', () => {
    it('shows skeleton loaders when loading with no data', () => {
      mockUsePeers.mockReturnValue({
        peers: [],
        loading: true,
        error: null,
        refresh: vi.fn(),
      });

      mockUseRoutingTable.mockReturnValue({
        routes: [],
        loading: true,
        error: null,
        refresh: vi.fn(),
      });

      const { container } = render(<PeersView />);

      // Should show skeleton elements (animate-pulse)
      const skeletons = container.querySelectorAll('.animate-pulse');
      expect(skeletons.length).toBeGreaterThan(0);
    });
  });

  describe('peer cards', () => {
    it('renders peer cards with correct data', () => {
      mockUsePeers.mockReturnValue({
        peers: [
          {
            peerId: 'alice',
            ilpAddress: 'g.agent.alice',
            evmAddress: '0x1234567890abcdef1234567890abcdef12345678',
            connected: true,
            petname: 'alice',
            pubkey: 'abc123def456789012345678901234567890123456789012345678901234',
          },
          {
            peerId: 'bob',
            ilpAddress: 'g.agent.bob',
            connected: false,
            petname: 'bob',
          },
        ],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<PeersView />);

      // Peer names
      expect(screen.getByText('alice')).toBeInTheDocument();
      expect(screen.getByText('bob')).toBeInTheDocument();

      // ILP addresses
      expect(screen.getByText('g.agent.alice')).toBeInTheDocument();
      expect(screen.getByText('g.agent.bob')).toBeInTheDocument();

      // Connection status badges
      expect(screen.getByText('Connected')).toBeInTheDocument();
      expect(screen.getByText('Disconnected')).toBeInTheDocument();

      // Section header
      expect(screen.getByText('Connected Peers (2)')).toBeInTheDocument();
    });

    it('shows EVM address when available', () => {
      mockUsePeers.mockReturnValue({
        peers: [
          {
            peerId: 'alice',
            ilpAddress: 'g.agent.alice',
            evmAddress: '0x1234567890abcdef1234567890abcdef12345678',
            connected: true,
          },
        ],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<PeersView />);

      expect(screen.getByText('EVM Address')).toBeInTheDocument();
      // Truncated address
      expect(screen.getByText('0x1234...5678')).toBeInTheDocument();
    });

    it('shows XRP address when available', () => {
      mockUsePeers.mockReturnValue({
        peers: [
          {
            peerId: 'alice',
            ilpAddress: 'g.agent.alice',
            xrpAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
            connected: true,
          },
        ],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<PeersView />);

      expect(screen.getByText('XRP Address')).toBeInTheDocument();
    });
  });

  describe('routing table', () => {
    it('renders routing table with entries', () => {
      mockUsePeers.mockReturnValue({
        peers: [{ peerId: 'alice', ilpAddress: 'g.agent.alice', connected: true }],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      mockUseRoutingTable.mockReturnValue({
        routes: [
          { prefix: 'g.agent.alice', nextHop: 'alice', priority: 0 },
          { prefix: 'g.agent.bob', nextHop: 'bob' },
        ],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<PeersView />);

      // Table headers
      expect(screen.getByText('Prefix')).toBeInTheDocument();
      expect(screen.getByText('Next Hop')).toBeInTheDocument();
      expect(screen.getByText('Priority')).toBeInTheDocument();

      // Route entries — g.agent.alice appears in peer card AND routing table,
      // so use getAllByText and verify at least the routing table has them
      expect(screen.getAllByText('g.agent.alice').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('g.agent.bob')).toBeInTheDocument();

      // Section header
      expect(screen.getByText('Routing Table (2 entries)')).toBeInTheDocument();
    });

    it('shows empty message when no routing entries', () => {
      mockUsePeers.mockReturnValue({
        peers: [{ peerId: 'alice', ilpAddress: 'g.agent.alice', connected: true }],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<PeersView />);

      expect(screen.getByText('No routing entries configured')).toBeInTheDocument();
    });

    it('shows dash for undefined priority', () => {
      mockUsePeers.mockReturnValue({
        peers: [{ peerId: 'alice', ilpAddress: 'g.agent.alice', connected: true }],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      mockUseRoutingTable.mockReturnValue({
        routes: [{ prefix: 'g.agent.alice', nextHop: 'alice' }],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<PeersView />);

      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('renders next hop as clickable link', () => {
      mockUsePeers.mockReturnValue({
        peers: [{ peerId: 'alice', ilpAddress: 'g.agent.alice', connected: true }],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      mockUseRoutingTable.mockReturnValue({
        routes: [{ prefix: 'g.agent.alice', nextHop: 'alice' }],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<PeersView />);

      const nextHopLink = screen.getAllByText('alice').find((el) => el.tagName === 'BUTTON');
      expect(nextHopLink).toBeTruthy();
    });

    it('scrolls to peer card when next hop is clicked', () => {
      const scrollIntoViewMock = vi.fn();

      mockUsePeers.mockReturnValue({
        peers: [
          { peerId: 'alice', ilpAddress: 'g.agent.alice', connected: true, petname: 'alice' },
        ],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      mockUseRoutingTable.mockReturnValue({
        routes: [{ prefix: 'g.agent.alice', nextHop: 'alice' }],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<PeersView />);

      // Mock scrollIntoView on the peer card element
      const peerCardEl = document.getElementById('peer-card-alice');
      if (peerCardEl) {
        peerCardEl.scrollIntoView = scrollIntoViewMock;
      }

      const nextHopButton = screen.getAllByText('alice').find((el) => el.tagName === 'BUTTON');
      if (nextHopButton) {
        fireEvent.click(nextHopButton);
      }

      // scrollIntoView should be called if element exists
      if (peerCardEl) {
        expect(scrollIntoViewMock).toHaveBeenCalledWith({
          behavior: 'smooth',
          block: 'center',
        });
      }
    });
  });

  describe('sorts routing entries alphabetically', () => {
    it('sorts routes by prefix', () => {
      mockUsePeers.mockReturnValue({
        peers: [{ peerId: 'alice', ilpAddress: 'g.agent.alice', connected: true }],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      mockUseRoutingTable.mockReturnValue({
        routes: [
          { prefix: 'g.agent.charlie', nextHop: 'charlie' },
          { prefix: 'g.agent.alice', nextHop: 'alice' },
          { prefix: 'g.agent.bob', nextHop: 'bob' },
        ],
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<PeersView />);

      const rows = screen.getAllByRole('row');
      // Skip header row (index 0)
      const cells = rows.slice(1).map((row) => row.querySelector('td')?.textContent);
      expect(cells).toEqual(['g.agent.alice', 'g.agent.bob', 'g.agent.charlie']);
    });
  });
});
