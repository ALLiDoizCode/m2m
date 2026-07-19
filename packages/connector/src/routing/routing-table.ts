/**
 * In-memory routing table for ILP connector
 * @packageDocumentation
 * @see {@link https://github.com/interledger/rfcs/blob/master/0027-interledger-protocol-4/0027-interledger-protocol-4.md|RFC-0027: Interledger Protocol v4}
 */

import { ILPAddress, RoutingTableEntry, isValidILPAddress } from '@toon-protocol/shared';

/**
 * Minimal write-through sink for persisting routing-table mutations. Satisfied
 * by {@link ../core/registry-store.RegistryStore}; kept as a structural type so
 * the routing table has no hard dependency on the persistence layer.
 */
export interface RoutePersistenceSink {
  saveRoute(record: { prefix: string; nextHop: string; priority: number; source: 'runtime' }): void;
  deleteRoute(prefix: string): void;
}

/**
 * In-memory routing table implementing longest-prefix matching per RFC-0027
 * @remarks
 * Maintains mappings from ILP address prefixes to next-hop peer identifiers.
 * Uses longest-prefix matching algorithm to determine packet forwarding destinations.
 * Thread-safe for concurrent reads (JavaScript single-threaded execution model).
 * Map operations are atomic at the JavaScript level, no explicit locking needed for MVP.
 *
 * @example
 * ```typescript
 * const routingTable = new RoutingTable([
 *   { prefix: 'g.alice', nextHop: 'peer-alice', priority: 10 },
 *   { prefix: 'g.bob', nextHop: 'peer-bob', priority: 5 }
 * ]);
 *
 * const nextHop = routingTable.getNextHop('g.alice.wallet.USD');
 * // Returns: 'peer-alice' (longest prefix match)
 * ```
 */
export class RoutingTable {
  /**
   * Internal storage for route entries
   * Key: ILP address prefix
   * Value: RoutingTableEntry
   */
  private readonly routes: Map<string, RoutingTableEntry>;

  /**
   * Optional logger instance for structured logging
   * @remarks
   * If provided, logs route additions/removals at INFO level.
   * Will be integrated with Pino logger in Story 1.6.
   */
  private readonly logger?: {
    info: (obj: object, msg?: string) => void;
    error: (obj: object, msg?: string) => void;
  };

  /**
   * Optional write-through persistence. Set after construction (the persistent
   * store opens during start(), after the constructor has already loaded the
   * static-config routes from YAML). Because it is unset during construction,
   * config routes never reach the sink — only routes added/removed at runtime
   * are persisted, which is exactly the additive-over-config model: config
   * routes reload from YAML each boot, runtime routes replay from the store.
   */
  private persistence?: RoutePersistenceSink;

  /**
   * Prefixes installed via {@link addLearnedRoute} (link-state route learning,
   * toon-meta#153). Learned routes are SOFT state: they are derived from live
   * relay announcements, so they deliberately bypass the persistence sink
   * (persisting them as `'runtime'` would replay stale routes on boot) and are
   * re-learned from the relay after every restart. This set also fences the
   * two route populations off from each other: a learned install never
   * overwrites a config/runtime route for the same prefix, and a learned
   * withdraw never removes one.
   */
  private readonly learnedPrefixes = new Set<string>();

  /**
   * Creates a new RoutingTable instance
   * @param initialRoutes - Optional array of routes to initialize the table
   * @param logger - Optional logger instance for structured logging
   * @throws {Error} If any initial route has invalid ILP address prefix
   */
  constructor(
    initialRoutes?: RoutingTableEntry[],
    logger?: {
      info: (obj: object, msg?: string) => void;
      error: (obj: object, msg?: string) => void;
    }
  ) {
    this.routes = new Map();
    this.logger = logger;

    if (initialRoutes && initialRoutes.length > 0) {
      for (const route of initialRoutes) {
        this.addRoute(route.prefix, route.nextHop, route.priority);
      }
      this.logger?.info(
        { routeCount: initialRoutes.length },
        `Initialized routing table with ${initialRoutes.length} routes`
      );
    }
  }

  /**
   * Add a routing entry to the table
   * @param prefix - ILP address prefix (e.g., "g.alice" or "g.bob.crypto")
   * @param nextHop - Peer identifier matching BTP connection
   * @param priority - Optional route priority for tie-breaking (default: 0, higher wins)
   * @throws {Error} If prefix is not a valid ILP address per RFC-0015
   * @remarks
   * Per RFC-0027, routing tables maintain mappings from address prefixes to next-hop peers.
   * Priority field enables tie-breaking when multiple routes have equal prefix lengths.
   */
  addRoute(prefix: ILPAddress, nextHop: string, priority: number = 0): void {
    if (!isValidILPAddress(prefix)) {
      const error = new Error(`Invalid ILP address prefix: ${prefix}`);
      this.logger?.error({ prefix, nextHop, priority }, error.message);
      throw error;
    }

    const entry: RoutingTableEntry = { prefix, nextHop, priority };
    this.routes.set(prefix, entry);
    // A config/runtime add for a prefix that was previously LEARNED promotes
    // it to hard state: it must now persist and survive learned withdrawal.
    this.learnedPrefixes.delete(prefix);
    this.persistence?.saveRoute({ prefix, nextHop, priority: priority ?? 0, source: 'runtime' });

    this.logger?.info({ prefix, nextHop, priority }, `Added route: ${prefix} -> ${nextHop}`);
  }

  /**
   * Install a LEARNED route (link-state route learning, toon-meta#153).
   *
   * Differences from {@link addRoute}:
   * - never reaches the persistence sink (learned routes are soft state,
   *   re-derived from live announcements after every boot);
   * - never overwrites an existing config/runtime route for the same prefix —
   *   returns `false` instead, so operator configuration always wins.
   *
   * Callers should pass a priority BELOW the config-route default (0) so that
   * equal-length-prefix ties across different prefixes also resolve in favor
   * of config routes.
   *
   * @param prefix - ILP address prefix (validated per RFC-0015).
   * @param nextHop - Directly-connected peer id to forward to.
   * @param priority - Route priority (negative for below-config precedence).
   * @returns `true` when installed/updated; `false` when a non-learned route
   *   already owns the prefix.
   * @throws {Error} If prefix is not a valid ILP address per RFC-0015.
   */
  addLearnedRoute(prefix: ILPAddress, nextHop: string, priority: number): boolean {
    if (!isValidILPAddress(prefix)) {
      const error = new Error(`Invalid ILP address prefix: ${prefix}`);
      this.logger?.error({ prefix, nextHop, priority }, error.message);
      throw error;
    }

    if (this.routes.has(prefix) && !this.learnedPrefixes.has(prefix)) {
      return false;
    }

    this.routes.set(prefix, { prefix, nextHop, priority });
    this.learnedPrefixes.add(prefix);
    this.logger?.info(
      { event: 'route_learned', prefix, nextHop, priority },
      `Learned route: ${prefix} -> ${nextHop}`
    );
    return true;
  }

  /**
   * Withdraw a LEARNED route. Only removes the prefix when it was installed
   * via {@link addLearnedRoute} — config/runtime routes are never touched.
   * Bypasses the persistence sink (learned routes were never persisted).
   *
   * @param prefix - ILP address prefix to withdraw.
   * @returns `true` when a learned route was removed; `false` otherwise.
   */
  removeLearnedRoute(prefix: string): boolean {
    if (!this.learnedPrefixes.has(prefix)) {
      return false;
    }
    this.learnedPrefixes.delete(prefix);
    this.routes.delete(prefix);
    this.logger?.info({ event: 'route_withdrawn', prefix }, `Withdrew learned route: ${prefix}`);
    return true;
  }

  /**
   * Whether the given prefix is currently installed as a LEARNED route.
   */
  isLearnedRoute(prefix: string): boolean {
    return this.learnedPrefixes.has(prefix);
  }

  /**
   * Snapshot of the currently-installed learned routes (deep copy).
   */
  getLearnedRoutes(): RoutingTableEntry[] {
    return Array.from(this.learnedPrefixes)
      .map((prefix) => this.routes.get(prefix))
      .filter((entry): entry is RoutingTableEntry => entry !== undefined)
      .map((entry) => ({ prefix: entry.prefix, nextHop: entry.nextHop, priority: entry.priority }));
  }

  /**
   * Attach a write-through persistence sink. Idempotent; intended to be called
   * once during connector startup after the static-config routes are loaded.
   */
  setPersistence(sink: RoutePersistenceSink): void {
    this.persistence = sink;
  }

  /**
   * Remove a routing entry from the table
   * @param prefix - ILP address prefix to remove
   * @remarks
   * Silently succeeds if prefix does not exist (idempotent operation).
   * Logs removal at INFO level if route existed.
   */
  removeRoute(prefix: string): void {
    const existed = this.routes.has(prefix);
    this.routes.delete(prefix);
    this.learnedPrefixes.delete(prefix);
    this.persistence?.deleteRoute(prefix);

    if (existed) {
      this.logger?.info({ prefix }, `Removed route: ${prefix}`);
    }
  }

  /**
   * Find next-hop peer for destination using longest-prefix matching
   * @param destination - Full ILP address of packet destination
   * @returns Next-hop peer identifier, or null if no route matches
   * @remarks
   * Per RFC-0027, implements longest-prefix matching algorithm:
   * 1. Find all route prefixes that match the destination
   * 2. Select the route with the longest matching prefix (most specific)
   * 3. If multiple routes have same prefix length, use priority field (higher wins)
   * 4. Return null if no route matches (caller generates F02 Unreachable error)
   *
   * Time complexity: O(n) where n is number of routes (acceptable for MVP).
   * Future optimization: Trie data structure for O(log n) lookup.
   *
   * @example
   * ```typescript
   * // Routes: ['g', 'g.alice', 'g.alice.wallet']
   * getNextHop('g.alice.wallet.USD') // Returns nextHop for 'g.alice.wallet' (longest match)
   * getNextHop('g.bob.crypto')       // Returns nextHop for 'g' (only match)
   * getNextHop('test.invalid')       // Returns null (no match)
   * ```
   */
  getNextHop(destination: ILPAddress): string | null {
    let bestMatch: RoutingTableEntry | null = null;
    let longestPrefixLength = -1;

    for (const route of this.routes.values()) {
      // Check if destination starts with this route's prefix
      if (destination === route.prefix || destination.startsWith(route.prefix + '.')) {
        const prefixLength = route.prefix.length;

        // Update best match if this prefix is longer, or same length with higher priority
        if (
          prefixLength > longestPrefixLength ||
          (prefixLength === longestPrefixLength &&
            (route.priority ?? 0) > (bestMatch?.priority ?? 0))
        ) {
          bestMatch = route;
          longestPrefixLength = prefixLength;
        }
      }
    }

    return bestMatch?.nextHop ?? null;
  }

  /**
   * Export all current routes for inspection/debugging
   * @returns Array of all routing table entries (deep copy)
   * @remarks
   * Returns a deep copy to prevent external mutation of internal state.
   * Useful for telemetry export to dashboard and debugging.
   */
  getAllRoutes(): RoutingTableEntry[] {
    return Array.from(this.routes.values()).map((route) => ({
      prefix: route.prefix,
      nextHop: route.nextHop,
      priority: route.priority,
    }));
  }

  /**
   * Get the number of routes in the table
   * @returns Total number of routing entries
   */
  get size(): number {
    return this.routes.size;
  }
}
