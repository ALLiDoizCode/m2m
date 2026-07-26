/**
 * @toon-protocol/connector — client library
 *
 * Issue #457: the embedded `ConnectorNode` (and every in-process local-delivery
 * handler) has been removed. This package is now a client only: a thin HTTP
 * shim over a Rust connector's client edge (docs/protocol/client-edge-spec.md
 * §1.1). See README.md's "Migrating from the embedded ConnectorNode" section
 * for `swap`/`town`/`mill`'s migration notes.
 *
 * @packageDocumentation
 */

// Client-edge HTTP client (issue #456) — a thin `sendPacket`-shaped shim over
// `POST /ilp`, OER-encoded PREPARE in, OER-encoded FULFILL/REJECT out.
export { ConnectorHttpClient, ConnectorHttpTransportError } from './client/connector-http-client';
export type {
  ConnectorHttpClientOptions,
  SendIlpPacketParams,
} from './client/connector-http-client';

// Re-export ILP packet types for library consumers
export type { ILPPreparePacket, ILPFulfillPacket, ILPRejectPacket } from '@toon-protocol/shared';
