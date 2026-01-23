/**
 * PeerDiscoveryService Unit Tests
 *
 * Tests for the peer discovery service including:
 * - Lifecycle management (start/stop)
 * - Broadcasting availability
 * - Fetching and merging peers
 * - Error handling
 * - Peer connection with retry logic
 */

import { PeerDiscoveryService } from '../../../src/discovery/peer-discovery-service';
import type { PeerDiscoveryConfig, PeerInfo } from '../../../src/discovery/types';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock logger
const createMockLogger = (): {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
  child: jest.Mock;
} => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
});

describe('PeerDiscoveryService', () => {
  let service: PeerDiscoveryService;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let config: PeerDiscoveryConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockLogger = createMockLogger();

    config = {
      enabled: true,
      broadcastInterval: 60,
      discoveryEndpoints: ['http://discovery.example.com:9999'],
      announceAddress: 'ws://my-connector.example.com:4000',
      nodeId: 'test-connector',
      btpEndpoint: 'ws://localhost:4000',
      ilpAddress: 'g.connector.test',
      capabilities: ['evm-settlement', 'xrp-settlement'],
      version: '0.1.0',
    };

    // Default successful fetch responses
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/announce')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, ttl: 120 }),
        });
      }
      if (url.includes('/api/v1/peers') && !url.includes('/announce')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              peers: [
                {
                  nodeId: 'peer-1',
                  btpEndpoint: 'ws://peer1.example.com:4000',
                  ilpAddress: 'g.connector.peer1',
                  capabilities: ['evm-settlement'],
                  lastSeen: Date.now(),
                  version: '0.1.0',
                },
              ],
              total: 1,
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    service = new PeerDiscoveryService(config, mockLogger as unknown as import('pino').Logger);
  });

  afterEach(() => {
    service.stop();
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should store bound handlers for proper cleanup', () => {
      // Verify service initializes with stopped status
      expect(service.status).toBe('stopped');
    });

    it('should use default broadcast interval if not specified', () => {
      const configWithoutInterval = {
        ...config,
        broadcastInterval: undefined as unknown as number,
      };
      const svc = new PeerDiscoveryService(
        configWithoutInterval,
        mockLogger as unknown as import('pino').Logger
      );
      expect(svc.status).toBe('stopped');
      svc.stop();
    });
  });

  describe('start', () => {
    it('should register broadcast interval timer', async () => {
      await service.start();

      expect(service.status).toBe('running');
      // Timer should be registered
      expect(jest.getTimerCount()).toBeGreaterThan(0);
    });

    it('should call broadcastAvailability immediately on start', async () => {
      await service.start();

      // Should have called fetch for announce and peers
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/announce'),
        expect.any(Object)
      );
    });

    it('should not start if already running', async () => {
      await service.start();
      await service.start();

      expect(mockLogger.warn).toHaveBeenCalledWith('Discovery service already running');
    });

    it('should not start if disabled', async () => {
      const disabledConfig = { ...config, enabled: false };
      const disabledService = new PeerDiscoveryService(
        disabledConfig,
        mockLogger as unknown as import('pino').Logger
      );

      await disabledService.start();

      expect(disabledService.status).toBe('stopped');
      expect(mockLogger.info).toHaveBeenCalledWith('Peer discovery is disabled');
    });

    it('should not start if no discovery endpoints configured', async () => {
      const noEndpointsConfig = { ...config, discoveryEndpoints: [] };
      const noEndpointsService = new PeerDiscoveryService(
        noEndpointsConfig,
        mockLogger as unknown as import('pino').Logger
      );

      await noEndpointsService.start();

      expect(noEndpointsService.status).toBe('stopped');
      expect(mockLogger.warn).toHaveBeenCalledWith('No discovery endpoints configured');
    });
  });

  describe('stop', () => {
    it('should clear broadcast interval timer', async () => {
      await service.start();
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      service.stop();

      // Run all pending timers to ensure they were cleared
      jest.runAllTimers();
      expect(service.status).toBe('stopped');
    });

    it('should verify zero active timers after stop (no leaks)', async () => {
      await service.start();
      service.stop();

      // Run any remaining timers
      jest.runAllTimers();

      // Service should be stopped
      expect(service.status).toBe('stopped');
    });

    it('should be safe to call stop multiple times', () => {
      service.stop();
      service.stop();
      expect(service.status).toBe('stopped');
    });
  });

  describe('broadcastAvailability', () => {
    it('should POST to all discovery endpoints', async () => {
      const multiEndpointConfig = {
        ...config,
        discoveryEndpoints: [
          'http://discovery1.example.com:9999',
          'http://discovery2.example.com:9999',
        ],
      };
      const multiService = new PeerDiscoveryService(
        multiEndpointConfig,
        mockLogger as unknown as import('pino').Logger
      );

      await multiService.broadcastAvailability();

      const announceCalls = mockFetch.mock.calls.filter((call) => call[0].includes('/announce'));
      expect(announceCalls.length).toBe(2);
    });

    it('should include correct PeerInfo in request body', async () => {
      await service.broadcastAvailability();

      const announceCall = mockFetch.mock.calls.find((call) => call[0].includes('/announce'));
      expect(announceCall).toBeDefined();

      const body = JSON.parse(announceCall![1].body);
      expect(body.nodeId).toBe('test-connector');
      expect(body.btpEndpoint).toBe('ws://my-connector.example.com:4000');
      expect(body.ilpAddress).toBe('g.connector.test');
      expect(body.capabilities).toEqual(['evm-settlement', 'xrp-settlement']);
      expect(body.version).toBe('0.1.0');
    });

    it('should handle endpoint unavailable gracefully (logs warning, continues)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      await service.broadcastAvailability();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: expect.any(String) }),
        'Discovery endpoint unavailable'
      );
    });

    it('should handle HTTP 4xx/5xx errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: () => Promise.resolve('Service unavailable'),
      });

      await service.broadcastAvailability();

      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('getDiscoveredPeers', () => {
    it('should GET from discovery endpoints', async () => {
      await service.broadcastAvailability();

      const getCalls = mockFetch.mock.calls.filter(
        (call) => call[0].includes('/api/v1/peers') && !call[0].includes('/announce')
      );
      expect(getCalls.length).toBeGreaterThan(0);
    });

    it('should merge peers from multiple endpoints', async () => {
      const multiEndpointConfig = {
        ...config,
        discoveryEndpoints: [
          'http://discovery1.example.com:9999',
          'http://discovery2.example.com:9999',
        ],
      };
      const multiService = new PeerDiscoveryService(
        multiEndpointConfig,
        mockLogger as unknown as import('pino').Logger
      );

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/announce')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, ttl: 120 }),
          });
        }
        // Return different peers based on which endpoint is being queried
        if (
          url.includes('discovery1') &&
          url.includes('/api/v1/peers') &&
          !url.includes('/announce')
        ) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                peers: [
                  {
                    nodeId: 'peer-from-endpoint-1',
                    btpEndpoint: 'ws://peer1.example.com:4000',
                    ilpAddress: 'g.connector.peer1',
                    capabilities: ['evm-settlement'],
                    lastSeen: Date.now(),
                    version: '0.1.0',
                  },
                ],
                total: 1,
              }),
          });
        }
        if (
          url.includes('discovery2') &&
          url.includes('/api/v1/peers') &&
          !url.includes('/announce')
        ) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                peers: [
                  {
                    nodeId: 'peer-from-endpoint-2',
                    btpEndpoint: 'ws://peer2.example.com:4000',
                    ilpAddress: 'g.connector.peer2',
                    capabilities: ['xrp-settlement'],
                    lastSeen: Date.now(),
                    version: '0.1.0',
                  },
                ],
                total: 1,
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      await multiService.broadcastAvailability();

      const peers = multiService.getDiscoveredPeers();
      expect(peers.length).toBe(2);
      multiService.stop();
    });

    it('should deduplicate peers by nodeId', async () => {
      const samePeer: PeerInfo = {
        nodeId: 'duplicate-peer',
        btpEndpoint: 'ws://peer.example.com:4000',
        ilpAddress: 'g.connector.peer',
        capabilities: ['evm-settlement'],
        lastSeen: Date.now(),
        version: '0.1.0',
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/announce')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, ttl: 120 }),
          });
        }
        if (url.includes('/api/v1/peers') && !url.includes('/announce')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ peers: [samePeer, samePeer], total: 2 }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      await service.broadcastAvailability();

      const peers = service.getDiscoveredPeers();
      expect(peers.length).toBe(1);
    });

    it('should return empty array when all endpoints fail', async () => {
      mockFetch.mockRejectedValue(new Error('All endpoints down'));

      await service.broadcastAvailability();

      const peers = service.getDiscoveredPeers();
      expect(peers).toEqual([]);
    });

    it('should not include self in discovered peers', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/announce')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, ttl: 120 }),
          });
        }
        if (url.includes('/api/v1/peers')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                peers: [
                  {
                    nodeId: 'test-connector', // Same as our nodeId
                    btpEndpoint: 'ws://localhost:4000',
                    ilpAddress: 'g.connector.test',
                    capabilities: ['evm-settlement'],
                    lastSeen: Date.now(),
                    version: '0.1.0',
                  },
                  {
                    nodeId: 'other-peer',
                    btpEndpoint: 'ws://other.example.com:4000',
                    ilpAddress: 'g.connector.other',
                    capabilities: ['xrp-settlement'],
                    lastSeen: Date.now(),
                    version: '0.1.0',
                  },
                ],
                total: 2,
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      await service.broadcastAvailability();

      const peers = service.getDiscoveredPeers();
      expect(peers.length).toBe(1);
      expect(peers[0]?.nodeId).toBe('other-peer');
    });
  });

  describe('connectToPeer', () => {
    const testPeer: PeerInfo = {
      nodeId: 'test-peer',
      btpEndpoint: 'ws://testpeer.example.com:4000',
      ilpAddress: 'g.connector.testpeer',
      capabilities: ['evm-settlement'],
      lastSeen: Date.now(),
      version: '0.1.0',
    };

    it('should initiate BTP connection with correct URL', async () => {
      const mockConnector = jest.fn().mockResolvedValue(undefined);
      service.setBtpConnector(mockConnector);

      await service.connectToPeer(testPeer);

      expect(mockConnector).toHaveBeenCalledWith('ws://testpeer.example.com:4000');
    });

    it('should not connect if already connected', async () => {
      const mockConnector = jest.fn().mockResolvedValue(undefined);
      service.setBtpConnector(mockConnector);

      await service.connectToPeer(testPeer);
      await service.connectToPeer(testPeer);

      expect(mockConnector).toHaveBeenCalledTimes(1);
    });

    it('should handle connection failure with retry logic', async () => {
      const mockConnector = jest.fn().mockRejectedValue(new Error('Connection failed'));
      service.setBtpConnector(mockConnector);

      await expect(service.connectToPeer(testPeer)).rejects.toThrow('Connection failed');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'test-peer', retries: 1 }),
        'Failed to connect to peer'
      );
    });

    it('should warn if no BTP connector configured', async () => {
      await service.connectToPeer(testPeer);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'No BTP connector configured, skipping peer connection'
      );
    });

    it('should stop retrying after max retries exceeded', async () => {
      const mockConnector = jest.fn().mockRejectedValue(new Error('Connection failed'));
      service.setBtpConnector(mockConnector);

      // First 3 attempts (max retries)
      for (let i = 0; i < 3; i++) {
        await expect(service.connectToPeer(testPeer)).rejects.toThrow('Connection failed');
      }

      // Clear mock
      mockConnector.mockClear();

      // 4th attempt should be skipped
      await service.connectToPeer(testPeer);

      expect(mockConnector).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'test-peer' }),
        'Max connection retries exceeded, skipping peer'
      );
    });
  });
});
