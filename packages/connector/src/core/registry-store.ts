/**
 * Persistent Peer/Route Registry Store
 *
 * Write-through persistence for the connector's peer registry and routing
 * table. Every runtime mutation funneled through `ConnectorNode`
 * (`registerPeer` / `removePeer` / `addRoute` / `removeRoute`) mirrors itself
 * here so that, on the next boot, runtime-added peers/routes are replayed
 * instead of being silently dropped (the "re-POST the town route after a
 * restart" RUNBOOK workaround).
 *
 * Backed by the same `libsql` (better-sqlite3-compatible) driver the settlement
 * claim stores use (see `connector-node.ts` claims wiring). All writes are
 * best-effort: a failure to persist is logged but never breaks the in-memory
 * mutation, so a connector with no `libsql` available degrades to today's
 * in-memory-only behavior rather than failing registration.
 *
 * @module core/registry-store
 */

import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';

/** Provenance of a registry row: static YAML config vs runtime admin-API addition. */
export type RegistrySource = 'config' | 'runtime';

/** Persisted form of a registered peer — everything needed to re-register on boot. */
export interface PeerRecord {
  id: string;
  url: string;
  authToken: string;
  relation?: string;
  transport?: string;
  /** Connector-internal settlement config, serialized as JSON (opaque to the store). */
  settlementJson?: string;
  source: RegistrySource;
}

/** Persisted form of a routing-table entry. */
export interface RouteRecord {
  prefix: string;
  nextHop: string;
  priority: number;
  source: RegistrySource;
  /**
   * Issue #218: per-route local-termination config
   * ({@link ../config/types.RouteTermination}) serialized as JSON, or undefined
   * for ordinary forwarding routes. Opaque to the store.
   */
  terminationJson?: string;
}

/**
 * SQLite-backed registry store. Synchronous (better-sqlite3 API) but all methods
 * swallow-and-log errors so persistence is never on the critical path of a
 * registration. Construct only after the schema has been initialized
 * ({@link initializeRegistrySchema}).
 */
export class RegistryStore {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger
  ) {}

  /** Upsert a peer row. */
  savePeer(record: PeerRecord): void {
    try {
      this.db
        .prepare(
          `INSERT INTO peers (id, url, auth_token, relation, transport, settlement_json, source, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             url = excluded.url,
             auth_token = excluded.auth_token,
             relation = excluded.relation,
             transport = excluded.transport,
             settlement_json = excluded.settlement_json,
             source = excluded.source,
             updated_at = excluded.updated_at`
        )
        .run(
          record.id,
          record.url,
          record.authToken,
          record.relation ?? null,
          record.transport ?? null,
          record.settlementJson ?? null,
          record.source,
          Date.now()
        );
    } catch (error) {
      this.logFailure('save_peer', { peerId: record.id }, error);
    }
  }

  /** Delete a peer row (idempotent). */
  deletePeer(id: string): void {
    try {
      this.db.prepare(`DELETE FROM peers WHERE id = ?`).run(id);
    } catch (error) {
      this.logFailure('delete_peer', { peerId: id }, error);
    }
  }

  /** Upsert a route row (keyed by prefix, matching the in-memory Map semantics). */
  saveRoute(record: RouteRecord): void {
    try {
      this.db
        .prepare(
          `INSERT INTO routes (prefix, next_hop, priority, source, termination_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(prefix) DO UPDATE SET
             next_hop = excluded.next_hop,
             priority = excluded.priority,
             source = excluded.source,
             termination_json = excluded.termination_json,
             updated_at = excluded.updated_at`
        )
        .run(
          record.prefix,
          record.nextHop,
          record.priority,
          record.source,
          record.terminationJson ?? null,
          Date.now()
        );
    } catch (error) {
      this.logFailure('save_route', { prefix: record.prefix }, error);
    }
  }

  /** Delete a route row by prefix (idempotent). */
  deleteRoute(prefix: string): void {
    try {
      this.db.prepare(`DELETE FROM routes WHERE prefix = ?`).run(prefix);
    } catch (error) {
      this.logFailure('delete_route', { prefix }, error);
    }
  }

  /** Load the full persisted registry. Returns empty arrays on error or empty store. */
  loadAll(): { peers: PeerRecord[]; routes: RouteRecord[] } {
    try {
      const peerRows = this.db
        .prepare(
          `SELECT id, url, auth_token, relation, transport, settlement_json, source FROM peers`
        )
        .all() as Array<{
        id: string;
        url: string;
        auth_token: string;
        relation: string | null;
        transport: string | null;
        settlement_json: string | null;
        source: RegistrySource;
      }>;
      const routeRows = this.db
        .prepare(`SELECT prefix, next_hop, priority, source, termination_json FROM routes`)
        .all() as Array<{
        prefix: string;
        next_hop: string;
        priority: number;
        source: RegistrySource;
        termination_json: string | null;
      }>;

      return {
        peers: peerRows.map((r) => ({
          id: r.id,
          url: r.url,
          authToken: r.auth_token,
          relation: r.relation ?? undefined,
          transport: r.transport ?? undefined,
          settlementJson: r.settlement_json ?? undefined,
          source: r.source,
        })),
        routes: routeRows.map((r) => ({
          prefix: r.prefix,
          nextHop: r.next_hop,
          priority: r.priority,
          source: r.source,
          terminationJson: r.termination_json ?? undefined,
        })),
      };
    } catch (error) {
      this.logFailure('load_all', {}, error);
      return { peers: [], routes: [] };
    }
  }

  private logFailure(op: string, ctx: Record<string, unknown>, error: unknown): void {
    this.logger.warn(
      {
        event: 'registry_store_error',
        op,
        ...ctx,
        error: error instanceof Error ? error.message : String(error),
      },
      `RegistryStore ${op} failed (continuing in-memory)`
    );
  }
}
