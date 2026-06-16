/**
 * Connector Admin-API wire contract (hub → connector), zod-validated.
 *
 * FOCUSED SLICE: peer registration — the highest-traffic admin DTO (`registerPeer`
 * / `POST /admin/peers`). The remaining admin DTOs (routes / channels / earnings /
 * settlement / inventory) are a documented backlog — see toon-meta
 * `context/contracts.md`. The connector derives its richer internal type from this
 * base (refining `settlement`); the hub orchestrator imports this to construct calls.
 */
import { z } from 'zod';

/** ILP peering relationship. `child` is forwarded value without a per-packet claim. */
export const PeerRelationSchema = z.enum(['parent', 'peer', 'child']);
export type PeerRelation = z.infer<typeof PeerRelationSchema>;

export const PeerRouteSchema = z.object({
  /** ILP address prefix */
  prefix: z.string(),
  /** Route priority (higher wins, default 0) */
  priority: z.number().optional(),
});
export type PeerRoute = z.infer<typeof PeerRouteSchema>;

/** Canonical peer-registration request shape sent to the connector admin API. */
export const PeerRegistrationRequestSchema = z.object({
  /** Unique peer identifier */
  id: z.string(),
  /** WebSocket URL for the BTP connection (e.g. ws://peer:3000) */
  url: z.string(),
  /** Authentication token for the BTP handshake */
  authToken: z.string(),
  /** Optional routes to add for this peer */
  routes: z.array(PeerRouteSchema).optional(),
  /** ILP peering relationship (defaults to 'peer' when omitted) */
  relation: PeerRelationSchema.optional(),
  /** Per-peer transport override */
  transport: z.enum(['direct', 'socks5']).optional(),
  /**
   * Optional settlement configuration. Left as `unknown` at the wire boundary;
   * the connector refines this to its internal `AdminSettlementConfig`.
   */
  settlement: z.unknown().optional(),
});
export type PeerRegistrationRequest = z.infer<typeof PeerRegistrationRequestSchema>;
