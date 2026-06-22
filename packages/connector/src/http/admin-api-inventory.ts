/**
 * Admin API Inventory
 * @packageDocumentation
 * @remarks
 * Machine-readable manifest of all HTTP endpoints exposed by the connector.
 * Used by test automation (Story 38.2) to assert "every inventoried route has a surface test".
 * This is the authoritative source; `docs/admin-api-inventory.md` is generated from this file.
 *
 * **Story 38.1** — HTTP Endpoint Inventory Doc
 *
 * @example
 * ```typescript
 * import { ADMIN_API_INVENTORY, InventoryEntry, AuthModel } from './admin-api-inventory';
 *
 * // Iterate all endpoints
 * for (const route of ADMIN_API_INVENTORY) {
 *   console.log(`${route.method} ${route.path}`);
 * }
 *
 * // Filter by server
 * const adminEndpoints = ADMIN_API_INVENTORY.filter(r => r.server === 'AdminServer');
 *
 * // Filter by cross-surface group
 * const peerExistenceEndpoints = ADMIN_API_INVENTORY.filter(
 *   r => r.crossSurfaceGroupId === 'peer-existence'
 * );
 * ```
 */

/**
 * HTTP method for an inventoried endpoint
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/**
 * Server that mounts the endpoint
 */
export type ServerName = 'AdminServer' | 'HealthServer';

/**
 * Authentication model for an endpoint.
 *
 * **Semantics:** this is the *minimal required* auth posture of the route
 * when no optional server-level features are configured. Optional IP
 * allowlist (AdminServer `allowedIPs`) is described in the server-level
 * prose of `docs/admin-api-inventory.md` — it is not re-encoded per row.
 * 403 "IP not in allowlist" entries in per-row `failureModes` are conditional
 * on that optional configuration.
 */
export type AuthModel = 'X-Api-Key' | 'unauthenticated' | 'ip-allowlist';

/**
 * Cross-surface invariant group identifiers
 * Used by Story 38.3 and 38.4 to test parallel-surface consistency
 */
export type CrossSurfaceGroupId =
  | 'peer-existence'
  | 'packet-counters'
  | 'channel-state'
  | 'health-liveness-readiness';

/**
 * Single HTTP endpoint entry in the admin API inventory
 */
export interface InventoryEntry {
  /** Exact Express path including params, e.g., /admin/peers/:peerId */
  path: string;

  /** HTTP method */
  method: HttpMethod;

  /** Server that mounts this endpoint */
  server: ServerName;

  /** Mount prefix for the router (e.g., /admin, empty for root) */
  mountPrefix: string;

  /** Authentication model required to access this endpoint */
  authModel: AuthModel;

  /** Expected HTTP status code on success (200, 201, 204) */
  successStatus: number;

  /** Documented failure modes with status codes */
  failureModes: Array<{
    status: number;
    description: string;
    condition?: string;
  }>;

  /** Request body shape / query params, or "none" */
  requestContract: string;

  /** Response shape with TypeScript type pointer, or "none" */
  responseContract: string;

  /** Source file(s) for the handler (relative to packages/connector/src/) */
  owningModule: string;

  /** Story IDs that touched this endpoint (for archeology) */
  relatedStories: string[];

  /** Cross-surface invariant group (for 38.3/38.4 testing) */
  crossSurfaceGroupId?: CrossSurfaceGroupId;

  /** Operational notes: caching, polling, Docker port mapping */
  operationalNotes: string;
}

/**
 * Complete inventory of HTTP endpoints exposed by the connector.
 *
 * **Two-Server Topology:**
 * - AdminServer (default port 8081): mounts /admin/*, own /health at root
 * - HealthServer (default port 8080): mounts /metrics, /health*, optional /settlement/*
 *
 * **Auth Model Summary:**
 * - AdminServer /admin/* routes: X-Api-Key when apiKey configured; also supports IP allowlist
 * - AdminServer /health (root): unauthenticated (mounted outside /admin router)
 * - HealthServer routes: all unauthenticated
 * - Settlement router on HealthServer: inherits HealthServer's unauthenticated posture
 */
export const ADMIN_API_INVENTORY: readonly InventoryEntry[] = [
  // ============================================================================
  // AdminServer endpoints (port 8081, mount prefix /admin)
  // ============================================================================

  /**
   * GET /admin/peers
   * List all configured peers with connection status
   */
  {
    path: '/peers',
    method: 'GET',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 200,
    failureModes: [
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
    ],
    requestContract: 'none',
    responseContract:
      'Array<{ id: string; url: string; connected: boolean; settlement?: SettlementPeerConfig }>',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['6.4', '37.1'],
    crossSurfaceGroupId: 'peer-existence',
    operationalNotes:
      'Returns live connection status from BTPClientManager. Poll at 1Hz for dashboard.',
  },

  /**
   * POST /admin/peers
   * Add a new peer with BTP connection and optional settlement config
   */
  {
    path: '/peers',
    method: 'POST',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 201,
    failureModes: [
      { status: 400, description: 'Invalid request body or missing required fields' },
      {
        status: 400,
        description:
          "Invalid transport value, or transport: 'socks5' requested on a connector with transport.type != 'socks5'",
      },
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
    ],
    requestContract: 'AddPeerRequest (http/admin-api.ts)',
    responseContract:
      "{ id: string; url: string; connected: boolean; transport?: 'direct' | 'socks5' }",
    owningModule: 'http/admin-api.ts',
    relatedStories: ['6.4', '37.1'],
    crossSurfaceGroupId: 'peer-existence',
    operationalNotes:
      'Automatically establishes BTP connection. Settlement config optional. ' +
      'Optional per-peer `transport` field (`direct` | `socks5`) overrides the connector-level ' +
      'transport for outbound BTP dial; omitted → inherits connector default. Returns 200 on ' +
      'idempotent re-registration (NOT 409); re-registration does NOT change a peer’s live ' +
      'transport — the response payload reflects the original live value, not the requested ' +
      'value. To change peer transport, DELETE + POST.',
  },

  /**
   * DELETE /admin/peers/:peerId
   * Remove a peer and close its BTP connection
   */
  {
    path: '/peers/:peerId',
    method: 'DELETE',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 204,
    failureModes: [
      { status: 400, description: 'Missing peerId parameter' },
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
      { status: 404, description: 'Peer not found' },
    ],
    requestContract: 'none',
    responseContract: 'none (204 No Content)',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['6.4', '37.1'],
    crossSurfaceGroupId: 'peer-existence',
    operationalNotes: 'Gracefully closes BTP connection before removing peer.',
  },

  /**
   * PUT /admin/peers/:peerId
   * Update peer configuration (reconnection, settlement config)
   */
  {
    path: '/peers/:peerId',
    method: 'PUT',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 200,
    failureModes: [
      { status: 400, description: 'Invalid request body' },
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
      { status: 404, description: 'Peer not found' },
    ],
    requestContract: 'Partial<AddPeerRequest> (http/admin-api.ts)',
    responseContract: '{ id: string; connected: boolean; settlement?: SettlementPeerConfig }',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['6.4'],
    crossSurfaceGroupId: 'peer-existence',
    operationalNotes:
      'Partial update - only provided fields are modified. PUT does NOT accept peer-identity ' +
      'fields (id / url / authToken) or the per-peer `transport` field — any such fields in the ' +
      'request body are silently ignored. To change peer transport, use DELETE + POST.',
  },

  /**
   * GET /admin/routes
   * List all routing table entries
   */
  {
    path: '/routes',
    method: 'GET',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 200,
    failureModes: [
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
    ],
    requestContract: 'none',
    responseContract: 'Array<{ prefix: string; nextHop: string; priority: number }>',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['6.4'],
    operationalNotes: 'Returns all routing table entries sorted by priority.',
  },

  /**
   * POST /admin/routes
   * Add a new routing table entry
   */
  {
    path: '/routes',
    method: 'POST',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 201,
    failureModes: [
      {
        status: 400,
        description: 'Invalid request body, missing prefix/nextHop, or invalid ILP address',
      },
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
      { status: 404, description: 'Next hop peer not found' },
    ],
    requestContract: 'AddRouteRequest (http/admin-api.ts)',
    responseContract: '{ prefix: string; nextHop: string; priority: number }',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['6.4'],
    operationalNotes: 'Higher priority routes win ties. Creates peer association.',
  },

  /**
   * DELETE /admin/routes/:prefix
   * Remove a routing table entry
   */
  {
    path: '/routes/:prefix(*)',
    method: 'DELETE',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 204,
    failureModes: [
      { status: 400, description: 'Missing prefix parameter' },
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
      { status: 404, description: 'Route not found' },
    ],
    requestContract: 'none',
    responseContract: 'none (204 No Content)',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['6.4'],
    operationalNotes: 'The (*) allows prefixes containing slashes (e.g., g.alice.USD).',
  },

  /**
   * PUT /admin/desired-state
   * Declaratively reconcile the full peer/route set to the supplied end-state.
   */
  {
    path: '/desired-state',
    method: 'PUT',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 200,
    failureModes: [
      {
        status: 400,
        description:
          'Invalid peer/route (bad relation, transport, ILP address, or relation↔route mismatch); validation is atomic — nothing is mutated',
      },
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
    ],
    requestContract: '{ peers?: AddPeerRequest[]; routes?: AddRouteRequest[] } (http/admin-api.ts)',
    responseContract:
      '{ peers: { added: string[]; removed: string[]; total: number }; routes: { desired: string[]; removed: string[] } }',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['6.4'],
    operationalNotes:
      'Idempotent. Converges to exactly the declared peers + routes; preserves the connector own local routes (nextHop === nodeId/local).',
  },

  /**
   * GET /admin/channels
   * List all payment channels
   */
  {
    path: '/channels',
    method: 'GET',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 200,
    failureModes: [
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
      { status: 503, description: 'ChannelManager not configured' },
    ],
    requestContract: 'none',
    responseContract: 'Array<AdminChannelStatus> (settlement/types.ts)',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['32.4', '32.5', '33.5', '34.5'],
    crossSurfaceGroupId: 'channel-state',
    operationalNotes: 'Multi-chain: returns channels across all registered chain providers.',
  },

  /**
   * POST /admin/channels
   * Open a new payment channel
   */
  {
    path: '/channels',
    method: 'POST',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 201,
    failureModes: [
      { status: 400, description: 'Invalid request body or chain parameters' },
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
      { status: 503, description: 'ChannelManager not configured or chain provider unavailable' },
    ],
    requestContract: '{ peerId: string; initialDeposit: string; chainId?: string }',
    responseContract: '{ channelId: string; txHash?: string; status: AdminChannelStatus }',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['32.4', '33.5', '34.5'],
    crossSurfaceGroupId: 'channel-state',
    operationalNotes: 'ChainId defaults to primary EVM provider if not specified.',
  },

  /**
   * GET /admin/channels/:channelId
   * Get payment channel details
   */
  {
    path: '/channels/:channelId',
    method: 'GET',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 200,
    failureModes: [
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
      { status: 404, description: 'Channel not found' },
      { status: 503, description: 'ChannelManager not configured' },
    ],
    requestContract: 'none',
    responseContract: 'AdminChannelStatus (settlement/types.ts)',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['32.4', '33.5', '34.5'],
    crossSurfaceGroupId: 'channel-state',
    operationalNotes: 'Returns full channel state including on-chain status.',
  },

  /**
   * GET /admin/channels/:channelId/claims
   * Get pending claims for a channel
   */
  {
    path: '/channels/:channelId/claims',
    method: 'GET',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 200,
    failureModes: [
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
      { status: 404, description: 'Channel not found' },
      { status: 503, description: 'ClaimReceiver not configured' },
    ],
    requestContract: 'none',
    responseContract: 'Array<ClaimRecord>',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['32.6', '33.6', '34.6', '34.7'],
    crossSurfaceGroupId: 'channel-state',
    operationalNotes: 'Returns claims received via BTP claim protocol.',
  },

  /**
   * POST /admin/channels/:channelId/deposit
   * Deposit funds into a payment channel
   */
  {
    path: '/channels/:channelId/deposit',
    method: 'POST',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 200,
    failureModes: [
      { status: 400, description: 'Invalid amount or channel state' },
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
      { status: 404, description: 'Channel not found' },
      { status: 503, description: 'ChannelManager not configured' },
    ],
    requestContract: '{ amount: string }',
    responseContract: '{ txHash: string; newBalance: string }',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['32.4', '33.5', '34.5'],
    crossSurfaceGroupId: 'channel-state',
    operationalNotes: 'Amount in wei/nanomina/lamports depending on chain.',
  },

  /**
   * POST /admin/channels/:channelId/close
   * Initiate channel closure
   */
  {
    path: '/channels/:channelId/close',
    method: 'POST',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 200,
    failureModes: [
      { status: 400, description: 'Invalid channel state for close operation' },
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
      { status: 404, description: 'Channel not found' },
      { status: 503, description: 'ChannelManager not configured' },
    ],
    requestContract: 'none (or { force?: boolean } for force-close)',
    responseContract: '{ channelId: string; status: AdminChannelStatus; txHash?: string }',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['32.4', '33.5', '34.5'],
    crossSurfaceGroupId: 'channel-state',
    operationalNotes: 'Starts settlement timeout; partner must claim before timeout expires.',
  },

  /**
   * GET /admin/balances/:peerId
   * Get balance information for a peer
   */
  {
    path: '/balances/:peerId',
    method: 'GET',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 200,
    failureModes: [
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
      { status: 404, description: 'Peer not found' },
      { status: 503, description: 'AccountManager not configured' },
    ],
    requestContract: 'none',
    responseContract: 'BalanceResponse (http/admin-api.ts)',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['37.1'],
    crossSurfaceGroupId: 'peer-existence',
    operationalNotes:
      'Uses btpClientManager.getPeerIds() as authoritative peer set. Returns 404 for unknown peer.',
  },

  /**
   * GET /admin/settlement/states
   * Get settlement states for all peers
   */
  {
    path: '/settlement/states',
    method: 'GET',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 200,
    failureModes: [
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
      { status: 503, description: 'SettlementMonitor not configured' },
    ],
    requestContract: 'none',
    responseContract: 'Array<{ peerId: string; state: SettlementState; pendingClaims: number }>',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['32.5'],
    crossSurfaceGroupId: 'channel-state',
    operationalNotes: 'Aggregated settlement view across all chain providers.',
  },

  /**
   * POST /admin/ilp/send
   * Send an ILP packet to a peer
   */
  {
    path: '/ilp/send',
    method: 'POST',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 200,
    failureModes: [
      { status: 400, description: 'Invalid request body or ILP address' },
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
      { status: 503, description: 'Connector not ready or packet sender unavailable' },
    ],
    requestContract: '{ destination: string; amount: string; condition?: string; expiry?: string }',
    responseContract: '{ fulfillment?: string; rejection?: IlpReject }',
    owningModule: 'http/admin-api.ts + http/ilp-send-handler.ts',
    relatedStories: ['6.4'],
    operationalNotes: 'Debug/diagnostic endpoint for manual ILP packet injection.',
  },

  /**
   * GET /admin/earnings.json
   * Per-peer per-asset earnings snapshot and recent claims ticker
   */
  {
    path: '/earnings.json',
    method: 'GET',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 200,
    failureModes: [
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
      { status: 503, description: 'AccountManager or ClaimReceiver not wired' },
    ],
    requestContract: 'none',
    responseContract:
      'AdminEarningsJsonResponse { peers: AdminEarningsJsonPeer[]; connectorFees: AdminEarningsConnectorFee[]; recentClaims: AdminEarningsRecentClaim[]; ... } (all types exported from http/admin-api.ts)',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['37.4', '37.7', '37.8'],
    operationalNotes:
      'Cache-Control: no-store. Dashboard polls at ~0.2 Hz. claimsSentTotal requires SentClaimsQueries (Story 37.7). Outbound-only peers surface with claimsReceivedTotal=0. connectorFees derived from incoming volume x fee percentage (approximation).',
  },

  /**
   * GET /admin/metrics.json
   * JSON projection of per-peer ILP metrics (dashboard)
   */
  {
    path: '/metrics.json',
    method: 'GET',
    server: 'AdminServer',
    mountPrefix: '/admin',
    authModel: 'X-Api-Key',
    successStatus: 200,
    failureModes: [
      { status: 401, description: 'Missing or invalid X-Api-Key' },
      { status: 403, description: 'IP not in allowlist' },
      { status: 503, description: 'Metrics registry not wired' },
    ],
    requestContract: 'none',
    responseContract:
      'AdminMetricsJsonResponse { peers: AdminMetricsJsonPeer[]; ... } (both types exported from http/admin-api.ts)',
    owningModule: 'http/admin-api.ts',
    relatedStories: ['37.2', '37.3'],
    crossSurfaceGroupId: 'packet-counters',
    operationalNotes:
      'Cache-Control: no-store. Dashboard polls at 1Hz. Prometheus families: toon_packets_forwarded_total, toon_packets_rejected_total, toon_bytes_sent_total, toon_last_packet_timestamp_seconds.',
  },

  /**
   * GET /health (AdminServer)
   * Health check for the admin server itself (separate from HealthServer)
   */
  {
    path: '/health',
    method: 'GET',
    server: 'AdminServer',
    mountPrefix: '',
    authModel: 'unauthenticated',
    successStatus: 200,
    failureModes: [],
    requestContract: 'none',
    responseContract:
      '{ status: "healthy"; service: "admin-api"; nodeId: string; timestamp: string }',
    owningModule: 'http/admin-server.ts',
    relatedStories: ['6.4'],
    crossSurfaceGroupId: 'health-liveness-readiness',
    operationalNotes:
      'Mounted at app root BEFORE /admin router. Port 8081. Used by Docker health checks.',
  },

  // ============================================================================
  // HealthServer endpoints (port 8080)
  // ============================================================================

  /**
   * GET /metrics
   * Prometheus metrics endpoint
   */
  {
    path: '/metrics',
    method: 'GET',
    server: 'HealthServer',
    mountPrefix: '',
    authModel: 'unauthenticated',
    successStatus: 200,
    failureModes: [{ status: 404, description: 'Metrics middleware not configured' }],
    requestContract: 'none',
    responseContract: 'text/plain (Prometheus exposition format)',
    owningModule: 'http/health-server.ts',
    relatedStories: ['37.2'],
    crossSurfaceGroupId: 'packet-counters',
    operationalNotes:
      'Prometheus families: toon_packets_forwarded_total, toon_packets_rejected_total, toon_bytes_sent_total, toon_last_packet_timestamp_seconds. Scraped by monitoring.',
  },

  /**
   * GET /health (HealthServer)
   * Basic health status
   */
  {
    path: '/health',
    method: 'GET',
    server: 'HealthServer',
    mountPrefix: '',
    authModel: 'unauthenticated',
    successStatus: 200,
    failureModes: [{ status: 503, description: 'Connector unhealthy or starting' }],
    requestContract: 'none',
    responseContract: 'HealthStatus | HealthStatusExtended (http/types.ts)',
    owningModule: 'http/health-server.ts',
    relatedStories: ['12.6'],
    crossSurfaceGroupId: 'health-liveness-readiness',
    operationalNotes:
      'Returns 200 for healthy/degraded, 503 for unhealthy/starting. Extended format if extendedProvider configured.',
  },

  /**
   * GET /health/live
   * Kubernetes liveness probe
   */
  {
    path: '/health/live',
    method: 'GET',
    server: 'HealthServer',
    mountPrefix: '',
    authModel: 'unauthenticated',
    successStatus: 200,
    failureModes: [],
    requestContract: 'none',
    responseContract: '{ status: "alive"; timestamp: string }',
    owningModule: 'http/health-server.ts',
    relatedStories: ['12.6'],
    crossSurfaceGroupId: 'health-liveness-readiness',
    operationalNotes: 'Always returns 200 unless process crashed. Kubernetes liveness probe.',
  },

  /**
   * GET /health/ready
   * Kubernetes readiness probe
   */
  {
    path: '/health/ready',
    method: 'GET',
    server: 'HealthServer',
    mountPrefix: '',
    authModel: 'unauthenticated',
    successStatus: 200,
    failureModes: [{ status: 503, description: 'Dependencies not ready (e.g., TigerBeetle down)' }],
    requestContract: 'none',
    responseContract: '{ status: "ready"; dependencies: object; timestamp: string }',
    owningModule: 'http/health-server.ts',
    relatedStories: ['12.6'],
    crossSurfaceGroupId: 'health-liveness-readiness',
    operationalNotes: 'Checks TigerBeetle and connector status. Kubernetes readiness probe.',
  },

  // ============================================================================
  // Settlement API (mounted on HealthServer when configured)
  // ============================================================================

  /**
   * POST /settlement/execute
   * Execute on-chain settlement for a peer
   */
  {
    path: '/settlement/execute',
    method: 'POST',
    server: 'HealthServer',
    mountPrefix: '',
    authModel: 'unauthenticated',
    successStatus: 200,
    failureModes: [
      { status: 400, description: 'Invalid request body or missing peerId' },
      { status: 404, description: 'Peer not found or no settlement configured' },
      { status: 503, description: 'Settlement infrastructure not available' },
    ],
    requestContract: '{ peerId: string; amount?: string }',
    responseContract: '{ txHash: string; amount: string; tokenId: string }',
    owningModule: 'settlement/settlement-api.ts',
    relatedStories: ['6.7'],
    operationalNotes:
      'Inherits HealthServer unauthenticated posture. Auth via authToken in body when settlement API configured.',
  },

  /**
   * GET /settlement/status/:peerId
   * Get settlement status for a peer
   */
  {
    path: '/settlement/status/:peerId',
    method: 'GET',
    server: 'HealthServer',
    mountPrefix: '',
    authModel: 'unauthenticated',
    successStatus: 200,
    failureModes: [
      { status: 404, description: 'Peer not found or no settlement configured' },
      { status: 503, description: 'Settlement infrastructure not available' },
    ],
    requestContract: 'none',
    responseContract:
      '{ peerId: string; pendingAmount: string; lastSettlement?: string; channelStatus?: string }',
    owningModule: 'settlement/settlement-api.ts',
    relatedStories: ['6.7'],
    operationalNotes: 'Inherits HealthServer unauthenticated posture.',
  },
] as const;

/**
 * Helper type for iterating over the inventory
 */
export type AdminApiInventoryEntry = (typeof ADMIN_API_INVENTORY)[number];

/**
 * Get all entries for a specific server
 */
export function getEntriesByServer(server: ServerName): readonly InventoryEntry[] {
  return ADMIN_API_INVENTORY.filter((entry) => entry.server === server);
}

/**
 * Get all entries in a cross-surface group
 */
export function getEntriesByGroup(groupId: CrossSurfaceGroupId): readonly InventoryEntry[] {
  return ADMIN_API_INVENTORY.filter((entry) => entry.crossSurfaceGroupId === groupId);
}

/**
 * Get all entries requiring a specific auth model
 */
export function getEntriesByAuthModel(authModel: AuthModel): readonly InventoryEntry[] {
  return ADMIN_API_INVENTORY.filter((entry) => entry.authModel === authModel);
}
