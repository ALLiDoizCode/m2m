/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * PeerDiscoveryService Branch Coverage Tests
 *
 * Comprehensive tests targeting uncovered branches to push branch coverage
 * of `src/discovery/peer-discovery-service.ts` as close to 100 % as possible.
 */

import { PeerDiscoveryService } from '../../../src/discovery/peer-discovery-service';
import type { PeerDiscoveryConfig, PeerInfo } from '../../../src/discovery/types';

const mockFetch = jest.fn();
global.fetch = mockFetch;

const createMockLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
});

describe('PeerDiscoveryService Branch Coverage', () => {
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
          json: () => Promise.resolve({ peers: [], total: 0 }),
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

  /* ------------------------------------------------------------------ */
  /*  Constructor logical operators                                      */
  /* ------------------------------------------------------------------ */

  describe('constructor || branches', () => {
    it('should preserve truthy broadcastInterval (first branch)', () => {
      const cfg = { ...config, broadcastInterval: 45 };
      const svc = new PeerDiscoveryService(cfg, mockLogger as unknown as import('pino').Logger);
      expect(svc.status).toBe('stopped');
      svc.stop();
    });

    it('should fallback to DEFAULT_BROADCAST_INTERVAL when broadcastInterval is 0 (falsy branch)', () => {
      const cfg = { ...config, broadcastInterval: 0 };
      const svc = new PeerDiscoveryService(cfg, mockLogger as unknown as import('pino').Logger);
      expect(svc.status).toBe('stopped');
      svc.stop();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  start() branches                                                   */
  /* ------------------------------------------------------------------ */

  describe('start branches', () => {
    it('should log periodic broadcast failure from setInterval catch (lines 115-116)', async () => {
      await service.start();
      // Override _boundBroadcast so the interval callback rejects
      const original = (service as any)._boundBroadcast;
      (service as any)._boundBroadcast = async () => {
        throw new Error('Periodic broadcast forced failure');
      };

      jest.advanceTimersByTime(60 * 1000);
      await Promise.resolve(); // flush microtasks

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Broadcast failed'
      );

      (service as any)._boundBroadcast = original;
    });

    it('should catch and rethrow when initial broadcast fails', async () => {
      // Override _boundBroadcast so that start()'s try/catch is exercised.
      const original = (service as any)._boundBroadcast;
      (service as any)._boundBroadcast = async () => {
        throw new Error('Forced broadcast failure');
      };

      await expect(service.start()).rejects.toThrow('Forced broadcast failure');
      expect(service.status).toBe('stopped');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        'Failed to start peer discovery service'
      );

      (service as any)._boundBroadcast = original;
    });

    it('should return early when discoveryEndpoints is undefined', async () => {
      const cfg = {
        ...config,
        discoveryEndpoints: undefined as unknown as string[],
      };
      const svc = new PeerDiscoveryService(cfg, mockLogger as unknown as import('pino').Logger);
      await svc.start();
      expect(svc.status).toBe('stopped');
      expect(mockLogger.warn).toHaveBeenCalledWith('No discovery endpoints configured');
    });
  });

  /* ------------------------------------------------------------------ */
  /*  stop() branches                                                    */
  /* ------------------------------------------------------------------ */

  describe('stop branches', () => {
    it('should handle stop when broadcastTimer is null but cleanupTimer exists', () => {
      (service as any)._status = 'running';
      (service as any)._broadcastTimer = null;
      (service as any)._cleanupTimer = setInterval(() => {}, 1000);

      service.stop();

      expect(service.status).toBe('stopped');
    });

    it('should handle stop when cleanupTimer is null but broadcastTimer exists', () => {
      (service as any)._status = 'running';
      (service as any)._broadcastTimer = setInterval(() => {}, 1000);
      (service as any)._cleanupTimer = null;

      service.stop();

      expect(service.status).toBe('stopped');
    });

    it('should catch deregistration promise rejection during stop', async () => {
      await service.start();
      const original = (service as any)._deregisterFromEndpoints;
      (service as any)._deregisterFromEndpoints = async () => {
        throw new Error('Deregister fail');
      };

      service.stop();
      // Flush the microtask so the .catch() callback runs
      await Promise.resolve();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Deregistration failed during shutdown'
      );

      (service as any)._deregisterFromEndpoints = original;
    });
  });

  /* ------------------------------------------------------------------ */
  /*  _performBroadcast branches                                         */
  /* ------------------------------------------------------------------ */

  describe('_performBroadcast branches', () => {
    it('should return early when discoveryEndpoints is undefined', async () => {
      const cfg = {
        ...config,
        discoveryEndpoints: undefined as unknown as string[],
      };
      const svc = new PeerDiscoveryService(cfg, mockLogger as unknown as import('pino').Logger);
      await svc.broadcastAvailability();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should use btpEndpoint fallback when announceAddress is not set', async () => {
      const cfg = { ...config, announceAddress: undefined };
      const svc = new PeerDiscoveryService(cfg, mockLogger as unknown as import('pino').Logger);

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/announce')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ peers: [], total: 0 }),
        });
      });

      await svc.broadcastAvailability();

      const announceCall = mockFetch.mock.calls.find((call) =>
        (call[0] as string).includes('/announce')
      );
      expect(announceCall).toBeDefined();
      const body = JSON.parse((announceCall as any)[1].body);
      expect(body.btpEndpoint).toBe(cfg.btpEndpoint);
      svc.stop();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  _announceToEndpoint branches                                       */
  /* ------------------------------------------------------------------ */

  describe('_announceToEndpoint branches', () => {
    it('should handle response.text() throwing on HTTP error', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/announce')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.reject(new Error('text read failed')),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ peers: [], total: 0 }),
        });
      });

      await service.broadcastAvailability();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: expect.any(String) }),
        'Discovery endpoint unavailable'
      );
    });

    it('should handle result.success = false with explicit error', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/announce')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: false, error: 'Rate limited' }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ peers: [], total: 0 }),
        });
      });

      await service.broadcastAvailability();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: expect.any(String) }),
        'Discovery endpoint unavailable'
      );
    });

    it('should handle result.success = false without error message (|| branch)', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/announce')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: false }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ peers: [], total: 0 }),
        });
      });

      await service.broadcastAvailability();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: expect.any(String) }),
        'Discovery endpoint unavailable'
      );
    });
  });

  /* ------------------------------------------------------------------ */
  /*  _fetchPeersFromEndpoint branches                                   */
  /* ------------------------------------------------------------------ */

  describe('_fetchPeersFromEndpoint branches', () => {
    it('should handle empty peers array', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/announce')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ peers: [], total: 0 }),
        });
      });

      await service.broadcastAvailability();
      expect(service.getDiscoveredPeers()).toEqual([]);
    });

    it('should update existing peer when newer lastSeen is received', async () => {
      const peerBase: PeerInfo = {
        nodeId: 'peer-1',
        btpEndpoint: 'ws://peer1.example.com:4000',
        ilpAddress: 'g.connector.peer1',
        capabilities: ['evm-settlement'],
        lastSeen: 1000,
        version: '0.1.0',
      };

      let peersCallCount = 0;
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/announce')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        peersCallCount++;
        if (peersCallCount === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ peers: [peerBase], total: 1 }),
          });
        }
        const updatedPeer = {
          ...peerBase,
          lastSeen: 2000,
          btpEndpoint: 'ws://peer1-updated.example.com:4000',
        };
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ peers: [updatedPeer], total: 1 }),
        });
      });

      await service.broadcastAvailability();
      expect(service.getDiscoveredPeers()[0]!.btpEndpoint).toBe('ws://peer1.example.com:4000');

      await service.broadcastAvailability();
      expect(service.getDiscoveredPeers()[0]!.btpEndpoint).toBe(
        'ws://peer1-updated.example.com:4000'
      );
    });

    it('should skip existing peer when older lastSeen is received', async () => {
      const peerBase: PeerInfo = {
        nodeId: 'peer-1',
        btpEndpoint: 'ws://peer1.example.com:4000',
        ilpAddress: 'g.connector.peer1',
        capabilities: ['evm-settlement'],
        lastSeen: 2000,
        version: '0.1.0',
      };

      let peersCallCount = 0;
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/announce')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        peersCallCount++;
        if (peersCallCount === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ peers: [peerBase], total: 1 }),
          });
        }
        const olderPeer = {
          ...peerBase,
          lastSeen: 1000,
          btpEndpoint: 'ws://peer1-older.example.com:4000',
        };
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ peers: [olderPeer], total: 1 }),
        });
      });

      await service.broadcastAvailability();
      await service.broadcastAvailability();
      expect(service.getDiscoveredPeers()[0]!.btpEndpoint).toBe('ws://peer1.example.com:4000');
    });

    it('should handle _fetchPeersFromEndpoint failure independently of announce', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/announce')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        if (url.includes('/api/v1/peers')) {
          return Promise.resolve({
            ok: false,
            status: 502,
            text: () => Promise.resolve('Bad Gateway'),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      await service.broadcastAvailability();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: expect.any(String) }),
        'Discovery endpoint unavailable'
      );
      expect(service.getDiscoveredPeers()).toEqual([]);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  connectToPeer branches                                             */
  /* ------------------------------------------------------------------ */

  describe('connectToPeer branches', () => {
    it('should succeed and add peer to connectedPeers', async () => {
      const mockConnector = jest.fn().mockResolvedValue(undefined);
      service.setBtpConnector(mockConnector);

      const peer: PeerInfo = {
        nodeId: 'peer-1',
        btpEndpoint: 'ws://peer1.example.com:4000',
        ilpAddress: 'g.connector.peer1',
        capabilities: ['evm-settlement'],
        lastSeen: Date.now(),
        version: '0.1.0',
      };

      await service.connectToPeer(peer);

      expect(mockConnector).toHaveBeenCalledWith(peer.btpEndpoint);
      expect((service as any)._connectedPeers.has(peer.nodeId)).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: peer.nodeId }),
        'Connected to peer'
      );
    });

    it('should use existing retry count from _connectionRetries (|| truthy branch)', async () => {
      (service as any)._connectionRetries.set('peer-1', 1);
      const mockConnector = jest.fn().mockRejectedValue(new Error('Connection failed'));
      service.setBtpConnector(mockConnector);

      const peer: PeerInfo = {
        nodeId: 'peer-1',
        btpEndpoint: 'ws://peer1.example.com:4000',
        ilpAddress: 'g.connector.peer1',
        capabilities: ['evm-settlement'],
        lastSeen: Date.now(),
        version: '0.1.0',
      };

      await expect(service.connectToPeer(peer)).rejects.toThrow('Connection failed');

      expect((service as any)._connectionRetries.get('peer-1')).toBe(2);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'peer-1', retries: 2 }),
        'Failed to connect to peer'
      );
    });

    it('should schedule retry when retries + 1 < MAX_CONNECTION_RETRIES', async () => {
      const mockConnector = jest.fn().mockRejectedValue(new Error('Connection failed'));
      service.setBtpConnector(mockConnector);

      const peer: PeerInfo = {
        nodeId: 'peer-1',
        btpEndpoint: 'ws://peer1.example.com:4000',
        ilpAddress: 'g.connector.peer1',
        capabilities: ['evm-settlement'],
        lastSeen: Date.now(),
        version: '0.1.0',
      };

      await expect(service.connectToPeer(peer)).rejects.toThrow('Connection failed');

      // retries was 0, now 1, 1 < 3 => retry scheduled
      expect(jest.getTimerCount()).toBe(1);
    });

    it('should hit retry catch block when scheduled retry fails (line 221)', async () => {
      const mockConnector = jest.fn().mockRejectedValue(new Error('Connection failed'));
      service.setBtpConnector(mockConnector);

      const peer: PeerInfo = {
        nodeId: 'peer-1',
        btpEndpoint: 'ws://peer1.example.com:4000',
        ilpAddress: 'g.connector.peer1',
        capabilities: ['evm-settlement'],
        lastSeen: Date.now(),
        version: '0.1.0',
      };

      await expect(service.connectToPeer(peer)).rejects.toThrow('Connection failed');
      expect((service as any)._connectionRetries.get('peer-1')).toBe(1);
      expect(jest.getTimerCount()).toBe(1);

      jest.advanceTimersByTime(5000);
      await Promise.resolve(); // flush microtasks so the retry promise settles

      // Retry ran, failed again, retries bumped to 2, another timer scheduled
      expect((service as any)._connectionRetries.get('peer-1')).toBe(2);
    });

    it('should NOT schedule retry when retries + 1 >= MAX_CONNECTION_RETRIES', async () => {
      (service as any)._connectionRetries.set('peer-1', 2);
      const mockConnector = jest.fn().mockRejectedValue(new Error('Connection failed'));
      service.setBtpConnector(mockConnector);

      const peer: PeerInfo = {
        nodeId: 'peer-1',
        btpEndpoint: 'ws://peer1.example.com:4000',
        ilpAddress: 'g.connector.peer1',
        capabilities: ['evm-settlement'],
        lastSeen: Date.now(),
        version: '0.1.0',
      };

      await expect(service.connectToPeer(peer)).rejects.toThrow('Connection failed');

      // retries was 2, now 3, 3 < 3 is false => no retry scheduled
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  _deregisterFromEndpoints branches                                  */
  /* ------------------------------------------------------------------ */

  describe('_deregisterFromEndpoints branches', () => {
    it('should return early when discoveryEndpoints is undefined (line 338)', () => {
      const cfg = {
        ...config,
        discoveryEndpoints: undefined as unknown as string[],
      };
      const svc = new PeerDiscoveryService(cfg, mockLogger as unknown as import('pino').Logger);
      // Force status so stop() reaches _deregisterFromEndpoints
      (svc as any)._status = 'running';
      svc.stop();
      expect(svc.status).toBe('stopped');
    });

    it('should handle fetch error inside deregister catch (line 354)', async () => {
      mockFetch.mockImplementation((url: string, init: any) => {
        if (init?.method === 'DELETE') {
          return Promise.reject(new Error('DELETE failed'));
        }
        if (url.includes('/announce')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ peers: [], total: 0 }),
        });
      });

      await service.start();
      service.stop();
      await Promise.resolve(); // flush microtasks

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: expect.any(String),
          error: expect.any(Error),
        }),
        'Deregistration failed'
      );
    });
  });

  /* ------------------------------------------------------------------ */
  /*  _cleanupStalePeers branches                                        */
  /* ------------------------------------------------------------------ */

  describe('_cleanupStalePeers branches', () => {
    it('should remove stale peers and keep fresh peers', () => {
      const now = Date.now();
      const stalePeer: PeerInfo = {
        nodeId: 'stale-peer',
        btpEndpoint: 'ws://stale.example.com:4000',
        ilpAddress: 'g.stale',
        capabilities: [],
        lastSeen: now - 120 * 1000 - 1, // > DEFAULT_PEER_TTL
        version: '0.1.0',
      };
      const freshPeer: PeerInfo = {
        nodeId: 'fresh-peer',
        btpEndpoint: 'ws://fresh.example.com:4000',
        ilpAddress: 'g.fresh',
        capabilities: [],
        lastSeen: now,
        version: '0.1.0',
      };

      (service as any)._discoveredPeers.set(stalePeer.nodeId, stalePeer);
      (service as any)._discoveredPeers.set(freshPeer.nodeId, freshPeer);
      (service as any)._connectedPeers.add(stalePeer.nodeId);
      (service as any)._connectionRetries.set(stalePeer.nodeId, 2);

      (service as any)._cleanupStalePeers();

      expect((service as any)._discoveredPeers.has('stale-peer')).toBe(false);
      expect((service as any)._discoveredPeers.has('fresh-peer')).toBe(true);
      expect((service as any)._connectedPeers.has('stale-peer')).toBe(false);
      expect((service as any)._connectionRetries.has('stale-peer')).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'stale-peer' }),
        'Removed stale peer'
      );
    });
  });
});
