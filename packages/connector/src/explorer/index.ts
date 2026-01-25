/**
 * Explorer Module - Packet/Event Explorer for connector telemetry
 *
 * Provides persistence, querying, and real-time streaming of telemetry events
 * for the Explorer UI.
 *
 * @packageDocumentation
 */

export { EventStore } from './event-store';
export type { EventStoreConfig, EventQueryFilter, StoredEvent } from './event-store';
export { ExplorerServer } from './explorer-server';
export type { ExplorerServerConfig } from './explorer-server';
export { EventBroadcaster } from './event-broadcaster';
