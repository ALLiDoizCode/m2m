/**
 * Nostr relay READ client for route learning (toon-meta#153).
 *
 * The connector's first relay-consuming surface: a thin, injectable wrapper
 * around `nostr-tools`' `SimplePool` that subscribes to kind:10032 events on
 * one or more public relay WS endpoints (FREE reads — the relay's public read
 * port, never the paid write path).
 *
 * The `RouteLearningRelayClient` interface is what `RouteLearningService`
 * depends on, so unit tests inject a hand-written fake and never touch the
 * network; `createNostrRelayClient` is the production implementation wired by
 * `ConnectorNode`.
 *
 * `SimplePool` relies on the global `WebSocket` (available on Node >= 22,
 * this repo's floor), verifies event signatures before delivering them, and
 * transparently reconnects/deduplicates across relays.
 *
 * @module discovery/nostr-relay-client
 */

import { SimplePool, type NostrEvent } from 'nostr-tools';

/** Handle to an active relay subscription. */
export interface RelaySubscriptionHandle {
  /** Close the subscription (idempotent). */
  close(): void;
}

/** NIP-01 filter subset route learning uses. */
export interface RelayEventFilter {
  kinds: number[];
}

/**
 * Injectable relay READ transport for {@link RouteLearningService}. Implemented
 * by {@link createNostrRelayClient} in production and by in-memory fakes in
 * unit tests (no network).
 */
export interface RouteLearningRelayClient {
  /**
   * Subscribe to events matching `filter` on all `relayUrls`. Delivered events
   * are signature-verified by the implementation. Must not throw on relay
   * connectivity failures — those are retried/reconnected internally.
   */
  subscribe(
    relayUrls: string[],
    filter: RelayEventFilter,
    onEvent: (event: NostrEvent) => void
  ): RelaySubscriptionHandle;

  /** Tear down all connections held by this client (idempotent). */
  destroy(): void;
}

/**
 * Production {@link RouteLearningRelayClient} backed by `nostr-tools`'
 * `SimplePool` (auto-reconnect enabled).
 */
export function createNostrRelayClient(): RouteLearningRelayClient {
  const pool = new SimplePool({ enableReconnect: true });
  return {
    subscribe(relayUrls, filter, onEvent): RelaySubscriptionHandle {
      const sub = pool.subscribe(relayUrls, { kinds: filter.kinds }, { onevent: onEvent });
      return { close: () => sub.close() };
    },
    destroy(): void {
      pool.destroy();
    },
  };
}
