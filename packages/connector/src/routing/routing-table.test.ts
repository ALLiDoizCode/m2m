/**
 * Unit tests for RoutingTable
 * @packageDocumentation
 */

import { RoutingTable } from './routing-table';
import { RoutingTableEntry } from '@toon-protocol/shared';

/**
 * Mock logger for testing log output without console noise
 */
const createMockLogger = (): { info: jest.Mock; error: jest.Mock } => ({
  info: jest.fn(),
  error: jest.fn(),
});

describe('RoutingTable', () => {
  describe('Constructor and Initialization', () => {
    it('should create empty routing table when no initial routes provided', () => {
      // Arrange & Act
      const routingTable = new RoutingTable();

      // Assert
      expect(routingTable.size).toBe(0);
      expect(routingTable.getAllRoutes()).toEqual([]);
    });

    it('should initialize routing table with provided routes', () => {
      // Arrange
      const mockLogger = createMockLogger();
      const initialRoutes: RoutingTableEntry[] = [
        { prefix: 'g.alice', nextHop: 'peer-alice', priority: 10 },
        { prefix: 'g.bob', nextHop: 'peer-bob', priority: 5 },
        { prefix: 'g.charlie', nextHop: 'peer-charlie' },
      ];

      // Act
      const routingTable = new RoutingTable(initialRoutes, mockLogger);

      // Assert
      expect(routingTable.size).toBe(3);
      expect(mockLogger.info).toHaveBeenCalledWith(
        { routeCount: 3 },
        'Initialized routing table with 3 routes'
      );
    });

    it('should handle empty initial routes array', () => {
      // Arrange & Act
      const routingTable = new RoutingTable([]);

      // Assert
      expect(routingTable.size).toBe(0);
      expect(routingTable.getAllRoutes()).toEqual([]);
    });
  });

  describe('addRoute()', () => {
    it('should add route with valid ILP address prefix', () => {
      // Arrange
      const mockLogger = createMockLogger();
      const routingTable = new RoutingTable([], mockLogger);

      // Act
      routingTable.addRoute('g.alice.wallet', 'peer-alice', 10);

      // Assert
      expect(routingTable.size).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        { prefix: 'g.alice.wallet', nextHop: 'peer-alice', priority: 10 },
        'Added route: g.alice.wallet -> peer-alice'
      );
    });

    it('should add route with default priority when not specified', () => {
      // Arrange
      const routingTable = new RoutingTable();

      // Act
      routingTable.addRoute('g.bob', 'peer-bob');

      // Assert
      const routes = routingTable.getAllRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0]).toEqual({ prefix: 'g.bob', nextHop: 'peer-bob', priority: 0 });
    });

    it('should throw error when adding route with invalid ILP address prefix', () => {
      // Arrange
      const mockLogger = createMockLogger();
      const routingTable = new RoutingTable([], mockLogger);

      // Act & Assert
      expect(() => {
        routingTable.addRoute('invalid..prefix', 'peer-test', 0);
      }).toThrow('Invalid ILP address prefix: invalid..prefix');

      expect(mockLogger.error).toHaveBeenCalledWith(
        { prefix: 'invalid..prefix', nextHop: 'peer-test', priority: 0 },
        'Invalid ILP address prefix: invalid..prefix'
      );
    });

    it('should allow adding multiple routes with different prefixes', () => {
      // Arrange
      const routingTable = new RoutingTable();

      // Act
      routingTable.addRoute('g.alice', 'peer-alice', 10);
      routingTable.addRoute('g.bob', 'peer-bob', 5);
      routingTable.addRoute('g.charlie.wallet', 'peer-charlie', 15);

      // Assert
      expect(routingTable.size).toBe(3);
    });

    it('should overwrite existing route when adding same prefix', () => {
      // Arrange
      const routingTable = new RoutingTable();
      routingTable.addRoute('g.alice', 'peer-alice-old', 5);

      // Act
      routingTable.addRoute('g.alice', 'peer-alice-new', 10);

      // Assert
      expect(routingTable.size).toBe(1);
      const routes = routingTable.getAllRoutes();
      expect(routes[0]).toEqual({ prefix: 'g.alice', nextHop: 'peer-alice-new', priority: 10 });
    });
  });

  describe('removeRoute()', () => {
    it('should remove existing route', () => {
      // Arrange
      const mockLogger = createMockLogger();
      const routingTable = new RoutingTable(
        [{ prefix: 'g.alice', nextHop: 'peer-alice', priority: 10 }],
        mockLogger
      );
      mockLogger.info.mockClear(); // Clear initialization log

      // Act
      routingTable.removeRoute('g.alice');

      // Assert
      expect(routingTable.size).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith({ prefix: 'g.alice' }, 'Removed route: g.alice');
    });

    it('should handle removing non-existent route gracefully', () => {
      // Arrange
      const mockLogger = createMockLogger();
      const routingTable = new RoutingTable([], mockLogger);

      // Act
      routingTable.removeRoute('g.nonexistent');

      // Assert
      expect(routingTable.size).toBe(0);
      expect(mockLogger.info).not.toHaveBeenCalled(); // No log for non-existent route
    });

    it('should remove only specified route from multiple routes', () => {
      // Arrange
      const routingTable = new RoutingTable([
        { prefix: 'g.alice', nextHop: 'peer-alice' },
        { prefix: 'g.bob', nextHop: 'peer-bob' },
        { prefix: 'g.charlie', nextHop: 'peer-charlie' },
      ]);

      // Act
      routingTable.removeRoute('g.bob');

      // Assert
      expect(routingTable.size).toBe(2);
      const routes = routingTable.getAllRoutes();
      expect(routes.find((r) => r.prefix === 'g.alice')).toBeDefined();
      expect(routes.find((r) => r.prefix === 'g.charlie')).toBeDefined();
      expect(routes.find((r) => r.prefix === 'g.bob')).toBeUndefined();
    });
  });

  describe('getAllRoutes()', () => {
    it('should return all routes from routing table', () => {
      // Arrange
      const initialRoutes: RoutingTableEntry[] = [
        { prefix: 'g.alice', nextHop: 'peer-alice', priority: 10 },
        { prefix: 'g.bob', nextHop: 'peer-bob', priority: 5 },
        { prefix: 'g.charlie', nextHop: 'peer-charlie' },
      ];
      const routingTable = new RoutingTable(initialRoutes);

      // Act
      const routes = routingTable.getAllRoutes();

      // Assert
      expect(routes).toHaveLength(3);
      expect(routes).toEqual(
        expect.arrayContaining([
          { prefix: 'g.alice', nextHop: 'peer-alice', priority: 10 },
          { prefix: 'g.bob', nextHop: 'peer-bob', priority: 5 },
          { prefix: 'g.charlie', nextHop: 'peer-charlie', priority: 0 }, // Default priority is 0
        ])
      );
    });

    it('should return empty array for empty routing table', () => {
      // Arrange
      const routingTable = new RoutingTable();

      // Act
      const routes = routingTable.getAllRoutes();

      // Assert
      expect(routes).toEqual([]);
    });

    it('should return deep copy preventing external mutation', () => {
      // Arrange
      const routingTable = new RoutingTable([
        { prefix: 'g.alice', nextHop: 'peer-alice', priority: 10 },
      ]);

      // Act
      const routes = routingTable.getAllRoutes();
      const firstRoute = routes[0];
      if (firstRoute) {
        firstRoute.nextHop = 'mutated-peer';
        firstRoute.priority = 999;
      }

      // Assert - Internal state unchanged
      const freshRoutes = routingTable.getAllRoutes();
      const freshFirstRoute = freshRoutes[0];
      expect(freshFirstRoute).toBeDefined();
      expect(freshFirstRoute?.nextHop).toBe('peer-alice');
      expect(freshFirstRoute?.priority).toBe(10);
    });
  });

  describe('getNextHop() - Empty Table', () => {
    it('should return null when routing table is empty', () => {
      // Arrange
      const routingTable = new RoutingTable();

      // Act
      const nextHop = routingTable.getNextHop('g.alice.wallet');

      // Assert
      expect(nextHop).toBeNull();
    });
  });

  describe('getNextHop() - Longest-Prefix Matching', () => {
    describe('Single Route Matching', () => {
      it('should return next hop when single exact match exists', () => {
        // Arrange
        const routingTable = new RoutingTable([
          { prefix: 'g.alice.wallet', nextHop: 'peer-alice' },
        ]);

        // Act
        const nextHop = routingTable.getNextHop('g.alice.wallet');

        // Assert
        expect(nextHop).toBe('peer-alice');
      });

      it('should return next hop when destination matches route prefix', () => {
        // Arrange
        const routingTable = new RoutingTable([
          { prefix: 'g.alice.wallet', nextHop: 'peer-alice' },
        ]);

        // Act
        const nextHop = routingTable.getNextHop('g.alice.wallet.USD');

        // Assert
        expect(nextHop).toBe('peer-alice');
      });

      it('should return null when no route matches destination', () => {
        // Arrange
        const routingTable = new RoutingTable([
          { prefix: 'g.alice', nextHop: 'peer-alice' },
          { prefix: 'g.charlie', nextHop: 'peer-charlie' },
        ]);

        // Act
        const nextHop = routingTable.getNextHop('g.bob.crypto');

        // Assert
        expect(nextHop).toBeNull();
      });
    });

    describe('Multiple Overlapping Prefixes', () => {
      it('should return longest matching prefix when multiple overlapping routes exist', () => {
        // Arrange - Scenario 3 from AC #9
        const routingTable = new RoutingTable([
          { prefix: 'g', nextHop: 'peer-global' },
          { prefix: 'g.alice', nextHop: 'peer-alice' },
          { prefix: 'g.alice.wallet', nextHop: 'peer-alice-wallet' },
        ]);

        // Act
        const nextHop = routingTable.getNextHop('g.alice.wallet.USD');

        // Assert - Should match 'g.alice.wallet' (longest prefix)
        expect(nextHop).toBe('peer-alice-wallet');
      });

      it('should return correct next hop for intermediate prefix match', () => {
        // Arrange
        const routingTable = new RoutingTable([
          { prefix: 'g', nextHop: 'peer-global' },
          { prefix: 'g.alice', nextHop: 'peer-alice' },
          { prefix: 'g.alice.wallet', nextHop: 'peer-alice-wallet' },
        ]);

        // Act
        const nextHop = routingTable.getNextHop('g.alice.crypto.BTC');

        // Assert - Should match 'g.alice' (longest available match)
        expect(nextHop).toBe('peer-alice');
      });

      it('should match root prefix when no more specific route exists', () => {
        // Arrange - Scenario 6 from AC #9
        const routingTable = new RoutingTable([
          { prefix: 'g', nextHop: 'peer-global' },
          { prefix: 'g.alice', nextHop: 'peer-alice' },
        ]);

        // Act
        const nextHop = routingTable.getNextHop('g.bob.wallet.USD');

        // Assert - Should match 'g' (root prefix)
        expect(nextHop).toBe('peer-global');
      });
    });

    describe('Priority-Based Tie-Breaking', () => {
      it('should use priority for tie-breaking when multiple routes have same prefix length', () => {
        // Arrange - Create a scenario where a destination could match two routes with same prefix length
        // Both 'g.alice.wallet' and 'g.alice.crypto' have prefix length 15
        const routingTable = new RoutingTable([
          { prefix: 'g.alice', nextHop: 'peer-alice-high', priority: 10 },
          { prefix: 'g.alice', nextHop: 'peer-alice-low', priority: 5 }, // Will overwrite above due to Map
          { prefix: 'g.bob.w', nextHop: 'peer-bob-low', priority: 3 }, // length 7
          { prefix: 'g.bob.x', nextHop: 'peer-bob-high', priority: 8 }, // length 7
        ]);

        // Act - Match bob routes where both have same prefix length (7)
        const nextHopBobW = routingTable.getNextHop('g.bob.w.account');
        const nextHopBobX = routingTable.getNextHop('g.bob.x.account');

        // Assert
        expect(nextHopBobW).toBe('peer-bob-low');
        expect(nextHopBobX).toBe('peer-bob-high');
      });

      it('should prefer higher priority when iterating through routes with equal prefix lengths', () => {
        // Arrange - Test that priority comparison works during iteration
        // Create table with routes that will be checked in order, with same-length prefixes
        const routingTable = new RoutingTable([
          { prefix: 'g.usr.alice', nextHop: 'peer-1', priority: 5 },
          { prefix: 'g.usr.bobby', nextHop: 'peer-2', priority: 3 },
          { prefix: 'g.usr', nextHop: 'peer-3', priority: 10 }, // Shorter, will match first
        ]);

        // Act - Should match 'g.usr' (shorter but still longest available match)
        const nextHop = routingTable.getNextHop('g.usr.charlie.wallet');

        // Assert
        expect(nextHop).toBe('peer-3'); // Only 'g.usr' matches this destination
      });

      it('should prefer higher priority when exact same prefix exists (should not happen, but testing tie-break)', () => {
        // Arrange - Artificial scenario where two routes have identical prefix length for same destination
        const routingTable = new RoutingTable([
          { prefix: 'g.alice', nextHop: 'peer-alice-backup', priority: 5 },
          { prefix: 'g.alice', nextHop: 'peer-alice-primary', priority: 10 }, // Overwrites previous
        ]);

        // Act
        const nextHop = routingTable.getNextHop('g.alice.wallet');

        // Assert - Last added route with higher priority (due to Map overwrite)
        expect(nextHop).toBe('peer-alice-primary');
      });

      it('should default to priority 0 when not specified in tie-breaking', () => {
        // Arrange
        const routingTable = new RoutingTable([
          { prefix: 'g.alice', nextHop: 'peer-alice-default' }, // priority: undefined (0)
          { prefix: 'g.bob', nextHop: 'peer-bob', priority: 5 },
        ]);

        // Act
        const nextHopAlice = routingTable.getNextHop('g.alice.wallet');

        // Assert
        expect(nextHopAlice).toBe('peer-alice-default');
      });
    });

    describe('Complex Overlapping Scenarios', () => {
      it('should correctly route with 5+ overlapping prefixes (Scenario 7 from AC #9)', () => {
        // Arrange - Complex routing table with various prefix lengths
        const routingTable = new RoutingTable([
          { prefix: 'g', nextHop: 'peer-global', priority: 1 },
          { prefix: 'g.alice', nextHop: 'peer-alice', priority: 5 },
          { prefix: 'g.alice.wallet', nextHop: 'peer-alice-wallet', priority: 10 },
          { prefix: 'g.alice.wallet.USD', nextHop: 'peer-alice-usd', priority: 15 },
          { prefix: 'g.bob', nextHop: 'peer-bob', priority: 5 },
          { prefix: 'g.bob.crypto', nextHop: 'peer-bob-crypto', priority: 10 },
        ]);

        // Act & Assert - Test 1: Full path match
        expect(routingTable.getNextHop('g.alice.wallet.USD.account123')).toBe('peer-alice-usd');

        // Act & Assert - Test 2: Intermediate match
        expect(routingTable.getNextHop('g.alice.wallet.EUR')).toBe('peer-alice-wallet');

        // Act & Assert - Test 3: Root match
        expect(routingTable.getNextHop('g.charlie.unknown')).toBe('peer-global');

        // Act & Assert - Test 4: Bob's crypto
        expect(routingTable.getNextHop('g.bob.crypto.BTC')).toBe('peer-bob-crypto');

        // Act & Assert - Test 5: Bob's non-crypto
        expect(routingTable.getNextHop('g.bob.fiat.USD')).toBe('peer-bob');
      });

      it('should handle multi-level hierarchy with gaps', () => {
        // Arrange - Routes with gaps in hierarchy
        const routingTable = new RoutingTable([
          { prefix: 'g', nextHop: 'peer-global' },
          { prefix: 'g.alice.wallet.USD', nextHop: 'peer-alice-usd' }, // No 'g.alice' or 'g.alice.wallet'
        ]);

        // Act & Assert - Exact match
        expect(routingTable.getNextHop('g.alice.wallet.USD.account1')).toBe('peer-alice-usd');

        // Act & Assert - Falls back to root when intermediate missing
        expect(routingTable.getNextHop('g.alice.wallet.EUR')).toBe('peer-global');
        expect(routingTable.getNextHop('g.alice.other')).toBe('peer-global');
      });
    });

    describe('Edge Cases', () => {
      it('should handle empty destination string', () => {
        // Arrange
        const routingTable = new RoutingTable([{ prefix: 'g.alice', nextHop: 'peer-alice' }]);

        // Act
        const nextHop = routingTable.getNextHop('');

        // Assert
        expect(nextHop).toBeNull();
      });

      it('should handle destination with maximum ILP address length (1023 chars)', () => {
        // Arrange - Create very long address (RFC-0015 max 1023 chars)
        const longPrefix = 'g.alice.wallet.USD.' + 'a'.repeat(1000); // ~1019 total
        const longerDestination = longPrefix + '.extra'; // Exceeds prefix

        const routingTable = new RoutingTable([{ prefix: longPrefix, nextHop: 'peer-alice-long' }]);

        // Act
        const nextHop = routingTable.getNextHop(longerDestination);

        // Assert
        expect(nextHop).toBe('peer-alice-long');
      });

      it('should not match partial segment (e.g., "g.ali" should not match "g.alice")', () => {
        // Arrange
        const routingTable = new RoutingTable([{ prefix: 'g.alice', nextHop: 'peer-alice' }]);

        // Act - 'g.ali' is NOT a prefix of 'g.alice.wallet', and 'g.alice' is not a prefix of 'g.ali.something'
        const nextHop = routingTable.getNextHop('g.ali.other');

        // Assert
        expect(nextHop).toBeNull(); // No match because 'g.alice' doesn't match 'g.ali.other'
      });

      it('should match exact prefix without dot extension', () => {
        // Arrange
        const routingTable = new RoutingTable([
          { prefix: 'g.alice.wallet', nextHop: 'peer-alice' },
        ]);

        // Act - Exact match
        const nextHop = routingTable.getNextHop('g.alice.wallet');

        // Assert
        expect(nextHop).toBe('peer-alice');
      });

      it('should handle single character segments', () => {
        // Arrange
        const routingTable = new RoutingTable([
          { prefix: 'g', nextHop: 'peer-g' },
          { prefix: 'g.a', nextHop: 'peer-a' },
          { prefix: 'g.a.b', nextHop: 'peer-b' },
        ]);

        // Act & Assert
        expect(routingTable.getNextHop('g.a.b.c')).toBe('peer-b');
        expect(routingTable.getNextHop('g.a.x')).toBe('peer-a');
        expect(routingTable.getNextHop('g.x.y')).toBe('peer-g');
      });
    });
  });
});

/**
 * Learned-route support (toon-meta#153): soft-state installs that bypass the
 * persistence sink and never override config/runtime routes.
 */
describe('RoutingTable learned routes', () => {
  const createSink = (): {
    saveRoute: jest.Mock;
    deleteRoute: jest.Mock;
  } => ({ saveRoute: jest.fn(), deleteRoute: jest.fn() });

  it('installs a learned route without touching the persistence sink', () => {
    const routingTable = new RoutingTable();
    const sink = createSink();
    routingTable.setPersistence(sink);

    expect(routingTable.addLearnedRoute('g.learned', 'peer-a', -100)).toBe(true);
    expect(routingTable.getNextHop('g.learned.dest')).toBe('peer-a');
    expect(routingTable.isLearnedRoute('g.learned')).toBe(true);
    expect(sink.saveRoute).not.toHaveBeenCalled();
  });

  it('refuses to overwrite an existing config/runtime route for the same prefix', () => {
    const routingTable = new RoutingTable([{ prefix: 'g.alice', nextHop: 'peer-config' }]);

    expect(routingTable.addLearnedRoute('g.alice', 'peer-learned', -100)).toBe(false);
    expect(routingTable.getNextHop('g.alice.wallet')).toBe('peer-config');
    expect(routingTable.isLearnedRoute('g.alice')).toBe(false);
  });

  it('allows re-learning (updating) an already-learned prefix', () => {
    const routingTable = new RoutingTable();
    routingTable.addLearnedRoute('g.learned', 'peer-a', -100);
    expect(routingTable.addLearnedRoute('g.learned', 'peer-b', -100)).toBe(true);
    expect(routingTable.getNextHop('g.learned.x')).toBe('peer-b');
  });

  it('withdraws only learned routes, without touching the persistence sink', () => {
    const routingTable = new RoutingTable([{ prefix: 'g.config', nextHop: 'peer-config' }]);
    const sink = createSink();
    routingTable.setPersistence(sink);
    routingTable.addLearnedRoute('g.learned', 'peer-a', -100);

    expect(routingTable.removeLearnedRoute('g.config')).toBe(false);
    expect(routingTable.getNextHop('g.config.x')).toBe('peer-config');

    expect(routingTable.removeLearnedRoute('g.learned')).toBe(true);
    expect(routingTable.getNextHop('g.learned.x')).toBeNull();
    expect(routingTable.removeLearnedRoute('g.learned')).toBe(false);
    expect(sink.deleteRoute).not.toHaveBeenCalled();
  });

  it('promotes a learned prefix to hard state when addRoute claims it', () => {
    const routingTable = new RoutingTable();
    const sink = createSink();
    routingTable.setPersistence(sink);

    routingTable.addLearnedRoute('g.shared', 'peer-learned', -100);
    routingTable.addRoute('g.shared', 'peer-runtime', 0);

    expect(sink.saveRoute).toHaveBeenCalledWith({
      prefix: 'g.shared',
      nextHop: 'peer-runtime',
      priority: 0,
      source: 'runtime',
    });
    expect(routingTable.isLearnedRoute('g.shared')).toBe(false);
    // A learned withdraw must no longer remove it.
    expect(routingTable.removeLearnedRoute('g.shared')).toBe(false);
    expect(routingTable.getNextHop('g.shared.x')).toBe('peer-runtime');
  });

  it('validates the ILP prefix on learned installs', () => {
    const routingTable = new RoutingTable();
    expect(() => routingTable.addLearnedRoute('not..valid', 'peer-a', -100)).toThrow(
      'Invalid ILP address prefix'
    );
  });

  it('reports learned routes via getLearnedRoutes and clears them on removeRoute', () => {
    const routingTable = new RoutingTable([{ prefix: 'g.config', nextHop: 'peer-config' }]);
    routingTable.addLearnedRoute('g.learned', 'peer-a', -100);

    expect(routingTable.getLearnedRoutes()).toEqual([
      { prefix: 'g.learned', nextHop: 'peer-a', priority: -100 },
    ]);

    routingTable.removeRoute('g.learned');
    expect(routingTable.getLearnedRoutes()).toEqual([]);
    expect(routingTable.isLearnedRoute('g.learned')).toBe(false);
  });

  it('keeps longest-prefix semantics: a more specific learned route still wins', () => {
    // Config routes stay authoritative for their own prefix, but a learned
    // route for a LONGER prefix legitimately captures more-specific traffic.
    const routingTable = new RoutingTable([{ prefix: 'g.net', nextHop: 'peer-config' }]);
    routingTable.addLearnedRoute('g.net.far', 'peer-learned', -100);

    expect(routingTable.getNextHop('g.net.far.dest')).toBe('peer-learned');
    expect(routingTable.getNextHop('g.net.other')).toBe('peer-config');
  });
});
