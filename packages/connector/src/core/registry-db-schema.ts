/**
 * Database Schema for the Peer/Route Registry
 *
 * Defines the schema for persisting the connector's peer registry and routing
 * table so that runtime-added peers/routes (registered via the admin API)
 * survive a process restart. Without this, the in-memory routing table and BTP
 * client map are rebuilt from static YAML only, and any runtime additions are
 * lost — the long-standing "re-POST the routes after restart" RUNBOOK step.
 *
 * Mirrors the schema-file style of {@link ./../settlement/claim-receiver-db-schema}.
 *
 * @module registry-db-schema
 */

import type { Database } from 'better-sqlite3';

/**
 * SQL schema for the `peers` table.
 *
 * Stores every registered peer (both static-config and runtime-added) with the
 * fields needed to faithfully re-register it on boot. `settlement_json` holds
 * the connector-internal settlement config (opaque here) as serialized JSON.
 * `source` distinguishes YAML-config peers from runtime (admin API) additions
 * so boot reconciliation only *replays* runtime entries (config peers are
 * already applied from YAML).
 */
export const REGISTRY_PEERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    auth_token TEXT NOT NULL,
    relation TEXT,
    transport TEXT,
    settlement_json TEXT,
    source TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_peers_source ON peers(source);
`;

/**
 * SQL schema for the `routes` table.
 *
 * One row per routing-table entry, keyed by prefix (matching the in-memory
 * `Map<prefix, entry>` semantics where a prefix is unique). `next_hop` is the
 * peer id (or `'local'`). `source` mirrors the peers table.
 */
export const REGISTRY_ROUTES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS routes (
    prefix TEXT PRIMARY KEY,
    next_hop TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_routes_next_hop ON routes(next_hop);
  CREATE INDEX IF NOT EXISTS idx_routes_source ON routes(source);
`;

/**
 * Initialize the registry schema (peers + routes tables).
 *
 * @param db - SQLite database instance
 */
export function initializeRegistrySchema(db: Database): void {
  db.exec(REGISTRY_PEERS_SCHEMA);
  db.exec(REGISTRY_ROUTES_SCHEMA);
}
