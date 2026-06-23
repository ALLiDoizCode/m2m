/**
 * Relation ↔ route consistency validation for peer registration.
 *
 * The connector's single most common misconfiguration is registering a node
 * with a `relation` that contradicts its ILP-address topology — e.g. a `child`
 * whose route prefix is not under the connector's own address. At runtime this
 * surfaces only as an opaque F06/T00 reject on the first paid packet (the
 * "pay-the-child with no channel" path). Validating at admission turns that
 * latent runtime failure into an immediate, actionable registration error.
 *
 * The connector has no single configured "own address"; its self-prefixes are
 * the routes whose nextHop is the connector itself (`nodeId`) or `'local'`.
 * When no such prefix exists (a pure relay, or a fresh apex before any local
 * route), the subtree checks are skipped — validation degrades to structural
 * checks rather than guessing.
 *
 * @module routing/relation-route-validator
 */

import type { PeerRelation } from '@toon-protocol/shared';
import type { RoutingTableEntry } from '@toon-protocol/shared';

/** Result of a relation/route consistency check. */
export type RelationRouteValidation = { ok: true } | { ok: false; error: string };

/**
 * Derive the connector's own ILP self-prefixes from its routing table: the
 * prefixes of routes that terminate locally (nextHop === nodeId or 'local').
 */
export function deriveLocalPrefixes(
  routes: Array<Pick<RoutingTableEntry, 'prefix' | 'nextHop'>>,
  nodeId: string
): string[] {
  return routes.filter((r) => r.nextHop === nodeId || r.nextHop === 'local').map((r) => r.prefix);
}

/** True when `candidate` is a strict descendant of `ancestor` in the ILP hierarchy. */
function isStrictDescendant(candidate: string, ancestor: string): boolean {
  return candidate.startsWith(ancestor + '.');
}

/**
 * Validate that a peer's `relation` is consistent with its route prefixes,
 * given the connector's own self-prefixes.
 *
 * - `child`  — every route must be a strict descendant of one of the
 *   connector's self-prefixes (e.g. `g.connector.town` under `g.connector`).
 *   This is the guard against the F06/T00 mis-tagged-child trap.
 * - `parent` — no route may be a strict descendant of the connector's own
 *   subtree (a parent sits above us, not under us); broader/lateral prefixes
 *   are allowed.
 * - `peer`   — lateral; no subtree constraint.
 *
 * If `localPrefixes` is empty the subtree checks are skipped (returns ok).
 */
export function validateRelationRoute(
  relation: PeerRelation | undefined,
  localPrefixes: string[],
  routePrefixes: string[]
): RelationRouteValidation {
  const effectiveRelation = relation ?? 'peer';
  if (localPrefixes.length === 0 || routePrefixes.length === 0) {
    return { ok: true };
  }

  if (effectiveRelation === 'child') {
    for (const prefix of routePrefixes) {
      const underSelf = localPrefixes.some((self) => isStrictDescendant(prefix, self));
      if (!underSelf) {
        return {
          ok: false,
          error: `Invalid route for child peer: prefix '${prefix}' must be under the connector's own address (one of: ${localPrefixes.join(', ')})`,
        };
      }
    }
  }

  if (effectiveRelation === 'parent') {
    for (const prefix of routePrefixes) {
      const underSelf = localPrefixes.some((self) => isStrictDescendant(prefix, self));
      if (underSelf) {
        return {
          ok: false,
          error: `Invalid route for parent peer: prefix '${prefix}' must not be under the connector's own address subtree (one of: ${localPrefixes.join(', ')})`,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Derive a default child route when a `child` peer is registered without an
 * explicit route: `<connector self-prefix>.<peerId>` (e.g. apex `g.connector`
 * + child id `town` → `g.connector.town`). Returns null when no self-prefix is
 * known (cannot derive without an anchor) or the relation is not `child`.
 */
export function deriveDefaultChildRoute(
  relation: PeerRelation | undefined,
  localPrefixes: string[],
  peerId: string
): { prefix: string; priority: number } | null {
  if (relation !== 'child' || localPrefixes.length === 0) {
    return null;
  }
  return { prefix: `${localPrefixes[0]}.${peerId}`, priority: 0 };
}
