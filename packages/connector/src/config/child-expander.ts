/**
 * Child-prefix expansion (toon-meta#153 — general child-prefix registration).
 *
 * Expands the first-class `children` config section into ordinary
 * {@link RouteConfig} entries under the node's apex, BEFORE the RoutingTable
 * and RouteTerminationRegistry are constructed — so the packet path stays
 * topology-blind and needs no changes:
 *
 * - `upstream` children become locally-terminated routes
 *   (`prefix: <apex>.<name>`, `nextHop: <nodeId>`, `upstream`, `price`) that
 *   the HttpProxyHandler reverse-proxies to the internal handler;
 * - `peerId` children become forwarding routes
 *   (`prefix: <apex>.<name>`, `nextHop: <peerId>`) over an external child
 *   peer link, and require that peer to exist with `relation: 'child'`.
 *
 * The apex is the explicit top-level `apex` config field when present, else
 * derived from the node's first self route (nextHop === nodeId || 'local').
 *
 * Expansion is idempotent: re-validating an already-expanded config skips
 * children whose expanded route is already present with an identical binding.
 *
 * @module config/child-expander
 */

import { isValidILPAddress } from '@toon-protocol/shared';
import { isValidNonNegativeIntegerString } from '../settlement/types';
import { normalizeCapabilityName } from '../discovery/ilp-peer-info-event';
import type { ChildConfig, PeerConfig, RouteConfig, TerminationChain } from './types';

/**
 * Error thrown when the `children`/`apex` config section is invalid.
 * The boot config loader wraps it into a `ConfigurationError`.
 */
export class ChildConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChildConfigError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ChildConfigError);
    }
  }
}

/**
 * A child `name` is a single ILP label: lowercase alphanumeric plus `-`/`_`,
 * starting with an alphanumeric character. Dots are rejected — a child binds
 * exactly one label under the apex.
 */
const CHILD_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Default chains for an `upstream` child when nothing is inheritable. */
const DEFAULT_CHILD_CHAINS: TerminationChain[] = ['evm'];

/** The advertised address for a route: its explicit `ilpAddress`, else its `prefix`. */
function routeAddress(route: Pick<RouteConfig, 'prefix' | 'ilpAddress'>): string {
  return route.ilpAddress ?? route.prefix;
}

/**
 * Resolve the node's apex address: the explicit `apex` config field when
 * present, else the first self route's address (a route whose `nextHop` is
 * the node itself — `nodeId` or `'local'`), preferring its `ilpAddress` over
 * its `prefix`. Returns undefined when neither exists (pure relay node).
 *
 * @param config - The apex/routes/nodeId slice of the connector config.
 * @returns The apex ILP address, or undefined when none is derivable.
 */
export function deriveApex(config: {
  apex?: string;
  routes: RouteConfig[];
  nodeId: string;
}): string | undefined {
  if (config.apex !== undefined) {
    return config.apex;
  }
  const selfRoute = config.routes.find((r) => r.nextHop === config.nodeId || r.nextHop === 'local');
  return selfRoute ? routeAddress(selfRoute) : undefined;
}

/**
 * Expand the `children` config section into routes under the apex.
 *
 * Validation performed per child (throws {@link ChildConfigError}):
 * - `name` is a single valid ILP label and `<apex>.<name>` is a valid ILP
 *   address (`isValidILPAddress`);
 * - exactly one of `upstream` | `peerId` is set;
 * - names are unique across `children`;
 * - `price` (when present) is a non-negative integer string;
 * - `capability` (when present) satisfies the capability name grammar and
 *   `schema` (when present) is a non-empty string (toon-meta#153 — both feed
 *   the kind:10032 `capabilities` directory);
 * - a `peerId` child's peer exists in `peers` with `relation: 'child'`;
 * - the expanded prefix does not collide with an existing route bound
 *   elsewhere (an identical existing binding is skipped — idempotent).
 *
 * `upstream` children inherit termination metadata (`chains`,
 * `settlementAddresses`, `asset`) from the apex's own terminated route when
 * one exists (else the first terminated route, else `chains: ['evm']`), so
 * the expanded route passes the same `validateRouteTermination` checks as a
 * hand-written one.
 *
 * @param children - The `children` config entries (may be undefined/empty).
 * @param apexInput - The explicit top-level `apex` config field.
 * @param routes - The node's configured routes (pre-expansion).
 * @param peers - The node's configured peers (for `peerId` admission).
 * @param nodeId - This node's id (self `nextHop` for `upstream` children).
 * @returns The NEW routes to append (already-present identical bindings are
 *   omitted). Empty when `children` is absent or empty.
 */
export function expandChildren(
  children: ChildConfig[] | undefined,
  apexInput: string | undefined,
  routes: RouteConfig[],
  peers: PeerConfig[],
  nodeId: string
): RouteConfig[] {
  if (!children || children.length === 0) {
    return [];
  }

  const apex = deriveApex({ apex: apexInput, routes, nodeId });
  if (!apex) {
    throw new ChildConfigError(
      "children require an apex: set the top-level 'apex' field or configure a self route (nextHop = nodeId or 'local') to derive it from"
    );
  }
  if (!isValidILPAddress(apex)) {
    throw new ChildConfigError(`Invalid apex ILP address: '${apex}'`);
  }

  // Termination metadata inherited by `upstream` children: the apex's own
  // terminated route when present, else the first terminated route (the
  // canonical deploys share one settlement identity across terminated routes).
  const apexTermination =
    routes.find((r) => r.upstream !== undefined && routeAddress(r) === apex) ??
    routes.find((r) => r.upstream !== undefined);

  const peersById = new Map(peers.map((p) => [p.id, p]));
  const seenNames = new Set<string>();
  const expanded: RouteConfig[] = [];

  for (const child of children) {
    if (!child || typeof child !== 'object') {
      throw new ChildConfigError('Invalid children entry: expected an object');
    }
    if (typeof child.name !== 'string' || child.name.length === 0) {
      throw new ChildConfigError("children entry missing required field: 'name'");
    }
    const where = `child '${child.name}'`;

    if (!CHILD_NAME_PATTERN.test(child.name)) {
      throw new ChildConfigError(
        `${where}: name must be a single ILP label (lowercase alphanumeric, '-', '_'), got '${child.name}'`
      );
    }
    if (seenNames.has(child.name)) {
      throw new ChildConfigError(`Duplicate child name: '${child.name}'`);
    }
    seenNames.add(child.name);

    const hasUpstream = child.upstream !== undefined;
    const hasPeerId = child.peerId !== undefined;
    if (hasUpstream === hasPeerId) {
      throw new ChildConfigError(
        `${where}: exactly one of 'upstream' or 'peerId' must be set (got ${
          hasUpstream ? 'both' : 'neither'
        })`
      );
    }
    if (hasUpstream && (typeof child.upstream !== 'string' || child.upstream.length === 0)) {
      throw new ChildConfigError(`${where}: upstream must be a non-empty string`);
    }
    if (hasPeerId && (typeof child.peerId !== 'string' || child.peerId.length === 0)) {
      throw new ChildConfigError(`${where}: peerId must be a non-empty string`);
    }
    if (child.price !== undefined) {
      if (typeof child.price !== 'string' || !isValidNonNegativeIntegerString(child.price)) {
        throw new ChildConfigError(
          `${where}: price must be a non-negative integer string (atomic units), got ${String(
            child.price
          )}`
        );
      }
    }
    if (child.capability !== undefined) {
      if (
        typeof child.capability !== 'string' ||
        normalizeCapabilityName(child.capability) === null
      ) {
        throw new ChildConfigError(
          `${where}: capability must be a name like 'os.put' or 'nostr-relay' ` +
            `(alphanumeric start, then alphanumerics/'.'/'_'/'-'), got ${String(child.capability)}`
        );
      }
    }
    if (child.schema !== undefined) {
      if (typeof child.schema !== 'string' || child.schema.length === 0) {
        throw new ChildConfigError(
          `${where}: schema must be a non-empty string (content address / URI of the ` +
            `capability's interface descriptor), got ${String(child.schema)}`
        );
      }
    }

    const prefix = `${apex}.${child.name}`;
    if (!isValidILPAddress(prefix)) {
      throw new ChildConfigError(
        `${where}: expanded address '${prefix}' is not a valid ILP address`
      );
    }

    const expectedNextHop = hasUpstream ? nodeId : (child.peerId as string);

    // Idempotency / collision: an existing route at the same prefix with the
    // SAME binding means this config was already expanded — skip. A different
    // binding is a hard conflict.
    const existing = routes.find((r) => r.prefix === prefix);
    if (existing) {
      const sameBinding =
        existing.nextHop === expectedNextHop &&
        (!hasUpstream || existing.upstream === child.upstream);
      if (sameBinding) {
        continue;
      }
      throw new ChildConfigError(
        `${where}: expanded prefix '${prefix}' conflicts with an existing route (nextHop '${existing.nextHop}')`
      );
    }

    if (hasUpstream) {
      expanded.push({
        prefix,
        nextHop: nodeId,
        upstream: child.upstream as string,
        price: child.price ?? '0',
        chains: apexTermination?.chains ?? DEFAULT_CHILD_CHAINS,
        ilpAddress: prefix,
        settlementAddresses: apexTermination?.settlementAddresses ?? {},
        ...(apexTermination?.asset ? { asset: apexTermination.asset } : {}),
      });
    } else {
      const peerId = child.peerId as string;
      const peer = peersById.get(peerId);
      if (!peer) {
        throw new ChildConfigError(
          `${where}: peerId '${peerId}' does not reference a configured peer`
        );
      }
      if (peer.relation !== 'child') {
        throw new ChildConfigError(
          `${where}: peer '${peerId}' must have relation 'child' to be bound as a child prefix (got '${
            peer.relation ?? 'peer'
          }')`
        );
      }
      expanded.push({ prefix, nextHop: peerId });
    }
  }

  return expanded;
}
