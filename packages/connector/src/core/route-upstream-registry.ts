/**
 * Route → Upstream Termination Registry (issue #218)
 *
 * Holds the connector's per-route local-termination config — the keystone
 * {@link RouteTermination} keyed by ILP address prefix — and exposes it to two
 * consumers:
 *
 *  1. The #216 {@link ../core/handlers/http-proxy-handler.HttpProxyHandler}, via
 *     {@link RouteTerminationRegistry.resolveUpstream} bound as the handler's
 *     `upstreamResolver`. The handler asks "what upstream should I proxy this
 *     delivery to?" and the registry answers by longest-prefix matching the ILP
 *     destination against the configured terminated routes.
 *
 *  2. The #217 greeting / #220 price-binding layers, via
 *     {@link RouteTerminationRegistry.match} which returns the full
 *     {@link RouteTermination} (price, chains, ilpAddress, settlementAddresses,
 *     asset) for the matched route, not just the upstream URL.
 *
 * The config surface (#218) feeds this registry; #216 consumes the resolver
 * seam. Boot-load (config-loader) and runtime mutation (PUT /admin/desired-state)
 * both converge here so there is a single in-memory source of truth.
 *
 * @module core/route-upstream-registry
 */

import type { LocalDeliveryRequest, RouteTermination } from '../config/types';

/**
 * In-memory map of ILP-address prefix → {@link RouteTermination}, with
 * longest-prefix matching for delivery resolution.
 *
 * Matching mirrors the {@link ../routing/routing-table.RoutingTable} idiom: a
 * prefix matches a destination when the destination equals the prefix or begins
 * with `prefix + '.'`; the longest matching prefix wins (most specific route).
 */
export class RouteTerminationRegistry {
  private readonly byPrefix = new Map<string, RouteTermination>();

  /**
   * Construct a registry from route entries. Only entries carrying a
   * {@link RouteTermination} (i.e. terminated routes) are stored; ordinary
   * forwarding routes are ignored.
   */
  constructor(entries?: Iterable<{ prefix: string; termination?: RouteTermination }>) {
    if (entries) {
      for (const entry of entries) {
        if (entry.termination) {
          this.byPrefix.set(entry.prefix, entry.termination);
        }
      }
    }
  }

  /** Number of terminated routes currently registered. */
  get size(): number {
    return this.byPrefix.size;
  }

  /** All registered terminated-route prefixes (snapshot). */
  prefixes(): string[] {
    return [...this.byPrefix.keys()];
  }

  /**
   * Exact-prefix lookup. Returns the {@link RouteTermination} registered under
   * `prefix`, or `undefined` if none. Use {@link match} to resolve a full ILP
   * destination address.
   */
  lookup(prefix: string): RouteTermination | undefined {
    return this.byPrefix.get(prefix);
  }

  /**
   * Longest-prefix match against a full ILP destination address. Returns the
   * most-specific terminated route covering `destination`, or `undefined` when
   * no terminated route matches.
   */
  match(destination: string): RouteTermination | undefined {
    let best: RouteTermination | undefined;
    let bestLen = -1;
    for (const [prefix, termination] of this.byPrefix) {
      if (destination === prefix || destination.startsWith(prefix + '.')) {
        if (prefix.length > bestLen) {
          bestLen = prefix.length;
          best = termination;
        }
      }
    }
    return best;
  }

  /** Upsert a terminated route. */
  set(prefix: string, termination: RouteTermination): void {
    this.byPrefix.set(prefix, termination);
  }

  /** Remove a terminated route by prefix (idempotent). Returns whether it existed. */
  delete(prefix: string): boolean {
    return this.byPrefix.delete(prefix);
  }

  /** Remove all registered terminated routes. */
  clear(): void {
    this.byPrefix.clear();
  }

  /**
   * The {@link ../core/handlers/http-proxy-handler.UpstreamResolver} seam for
   * #216. Bind this method and pass it as `HttpProxyHandlerOptions.upstreamResolver`:
   *
   * ```ts
   * const registry = new RouteTerminationRegistry(entries);
   * const proxy = new HttpProxyHandler({ upstreamResolver: registry.resolveUpstream });
   * node.setLocalDeliveryHandler(proxy.handler);
   * ```
   *
   * Returns the matched route's `upstream` base URL, or `undefined` (→ the
   * handler rejects the delivery with F02 "no route") when no terminated route
   * covers the delivery's destination. Bound as an arrow property so callers can
   * pass it by reference without losing `this`.
   */
  readonly resolveUpstream = (request: LocalDeliveryRequest): string | undefined => {
    return this.match(request.destination)?.upstream;
  };
}
