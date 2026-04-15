/**
 * Tests for TransportProvider Interface + DirectTransportProvider
 *
 * Covers:
 * - TransportProvider interface compile-time contract (AC 1)
 * - DirectTransportProvider.createAgent() returns undefined (AC 2)
 * - DirectTransportProvider.healthCheck() returns true (AC 3)
 * - DirectTransportProvider.start()/stop() are no-ops (AC 4)
 * - DirectTransportProvider.getExternalUrl() returns configured URL (AC 5)
 *
 * Epic 35 Story 35.1
 *
 * @module direct-transport-provider.test
 */

import type { TransportProvider } from './transport-provider';
import { DirectTransportProvider } from './direct-transport-provider';

describe('DirectTransportProvider (Story 35.1)', () => {
  // ---------------------------------------------------------------------------
  // T-35.1-07: DirectTransportProvider implements TransportProvider interface
  // ---------------------------------------------------------------------------

  describe('TransportProvider interface compliance (T-35.1-07)', () => {
    it('should satisfy the TransportProvider interface at compile time', () => {
      // Compile-time assertion: if DirectTransportProvider does not implement
      // TransportProvider, this assignment will cause a TypeScript compile error.
      const provider: TransportProvider = new DirectTransportProvider('wss://test:3000/btp');

      // Runtime assertions proving all required methods exist
      expect(typeof provider.createAgent).toBe('function');
      expect(typeof provider.getExternalUrl).toBe('function');
      expect(typeof provider.start).toBe('function');
      expect(typeof provider.stop).toBe('function');
      expect(typeof provider.healthCheck).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  // T-35.1-01: TransportProvider interface compiles with all required methods
  // ---------------------------------------------------------------------------

  describe('TransportProvider interface contract (T-35.1-01)', () => {
    it('should enforce the full method contract via a mock implementation', () => {
      // A manual mock that satisfies the interface -- proves the contract shape
      const mockProvider: TransportProvider = {
        createAgent: (_peerUrl: string) => undefined,
        getExternalUrl: () => 'wss://mock:3000/btp',
        start: async () => {},
        stop: async () => {},
        healthCheck: async () => true,
      };

      expect(typeof mockProvider.createAgent).toBe('function');
      expect(typeof mockProvider.getExternalUrl).toBe('function');
      expect(typeof mockProvider.start).toBe('function');
      expect(typeof mockProvider.stop).toBe('function');
      expect(typeof mockProvider.healthCheck).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  // T-35.1-02: DirectTransportProvider.createAgent() returns undefined
  // ---------------------------------------------------------------------------

  describe('DirectTransportProvider.createAgent() (T-35.1-02)', () => {
    it('should return undefined for any peer URL', () => {
      const provider = new DirectTransportProvider('wss://mynode:3000/btp');

      expect(provider.createAgent('wss://peer1:3000/btp')).toBeUndefined();
      expect(provider.createAgent('wss://peer2:4000/btp')).toBeUndefined();
      expect(provider.createAgent('wss://secure-peer:443/btp')).toBeUndefined();
      expect(provider.createAgent('wss://testabcdef123456.anon/btp')).toBeUndefined();
      expect(provider.createAgent('')).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // T-35.1-03: DirectTransportProvider.getExternalUrl() returns configured URL
  // ---------------------------------------------------------------------------

  describe('DirectTransportProvider.getExternalUrl() (T-35.1-03)', () => {
    it('should return the constructor-provided URL', () => {
      const url = 'wss://mynode:3000/btp';
      const provider = new DirectTransportProvider(url);

      expect(provider.getExternalUrl()).toBe(url);
    });

    it('should return different URLs for different instances', () => {
      const provider1 = new DirectTransportProvider('wss://node-a:3000/btp');
      const provider2 = new DirectTransportProvider('wss://node-b:443/btp');

      expect(provider1.getExternalUrl()).toBe('wss://node-a:3000/btp');
      expect(provider2.getExternalUrl()).toBe('wss://node-b:443/btp');
    });

    it('should return the URL unchanged (no normalization)', () => {
      const url = 'wss://UPPERCASE-HOST:3000/btp';
      const provider = new DirectTransportProvider(url);

      expect(provider.getExternalUrl()).toBe(url);
    });
  });

  // ---------------------------------------------------------------------------
  // T-35.1-04: DirectTransportProvider.healthCheck() returns true
  // ---------------------------------------------------------------------------

  describe('DirectTransportProvider.healthCheck() (T-35.1-04)', () => {
    it('should resolve to true', async () => {
      const provider = new DirectTransportProvider('wss://mynode:3000/btp');

      const result = await provider.healthCheck();

      expect(result).toBe(true);
    });

    it('should always return true regardless of how many times called', async () => {
      const provider = new DirectTransportProvider('wss://mynode:3000/btp');

      expect(await provider.healthCheck()).toBe(true);
      expect(await provider.healthCheck()).toBe(true);
      expect(await provider.healthCheck()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // T-35.1-05: DirectTransportProvider.start() resolves without error
  // ---------------------------------------------------------------------------

  describe('DirectTransportProvider.start() (T-35.1-05)', () => {
    it('should resolve immediately without error', async () => {
      const provider = new DirectTransportProvider('wss://mynode:3000/btp');

      await expect(provider.start()).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // T-35.1-06: DirectTransportProvider.stop() resolves without error
  // ---------------------------------------------------------------------------

  describe('DirectTransportProvider.stop() (T-35.1-06)', () => {
    it('should resolve immediately without error', async () => {
      const provider = new DirectTransportProvider('wss://mynode:3000/btp');

      await expect(provider.stop()).resolves.toBeUndefined();
    });

    it('should be safe to call start then stop', async () => {
      const provider = new DirectTransportProvider('wss://mynode:3000/btp');

      await provider.start();
      await expect(provider.stop()).resolves.toBeUndefined();
    });

    it('should be safe to call stop without start', async () => {
      const provider = new DirectTransportProvider('wss://mynode:3000/btp');

      await expect(provider.stop()).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Constructor validation
  // ---------------------------------------------------------------------------

  describe('DirectTransportProvider constructor validation', () => {
    it('should throw if externalUrl is empty', () => {
      expect(() => new DirectTransportProvider('')).toThrow(
        'DirectTransportProvider: externalUrl must not be empty'
      );
    });
  });
}); // end DirectTransportProvider (Story 35.1)
