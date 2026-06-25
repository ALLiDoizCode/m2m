/**
 * Self-Announce Service (relay#37 / store#22).
 *
 * On boot (and on an interval), builds, signs, and publishes a fresh
 * `kind:10032` `IlpPeerInfo` announcement describing the connector's OWN apex
 * routes — refreshing it BEFORE the NIP-40 `expiration` lapses so discovery
 * never goes dark. The announcement is written to the relay's PRIVATE
 * `POST /write` event store (the same upstream the connector reverse-proxies
 * paid writes to); once stored it is served on the relay's FREE read WS, so a
 * client holding only the genesis seed can discover the publish/store routes +
 * settlement info out of band instead of hardcoding `publishDestination` /
 * `storeDestination`.
 *
 * The relay's free read WS rejects `EVENT` writes (writes are monetized), so
 * the private `/write` store is the correct internal publish channel — and it
 * is configurable (`writeUrl`) so a store-connector deploy with no local relay
 * can point at the apex relay.
 *
 * Identity: the connector signs with its Nostr key derived from its mnemonic
 * via NIP-06 (the SAME secp256k1 key it settles with). `kind:10032` is a
 * replaceable event (10000-19999), so each refresh supersedes the last.
 *
 * @module discovery/self-announce-service
 */

import type { Logger } from 'pino';
import type { NostrEvent } from 'nostr-tools';
import type { ConnectorConfig, SelfAnnounceConfig } from '../config/types';
import { buildIlpPeerInfoEvent } from './ilp-peer-info-event';
import { buildSelfAnnouncementInfo } from './self-announce-builder';

/** Default republish cadence (seconds). TTL = 2 × this. */
export const DEFAULT_REFRESH_INTERVAL_SECS = 300;

/** Minimal `fetch` shape, so tests can inject a stub without a network. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface SelfAnnounceServiceDeps {
  /** The full connector config (routes + chainProviders) the announcement derives from. */
  config: ConnectorConfig;
  /** The `selfAnnounce` block (endpoints + overrides). */
  selfAnnounce: SelfAnnounceConfig;
  /** The 32-byte Nostr secret key (NIP-06 key) to sign the announcement with. */
  secretKey: Uint8Array;
  /** Pino logger. */
  logger: Logger;
  /** Injectable fetch (defaults to global `fetch`). */
  fetchImpl?: FetchLike;
}

/**
 * Publishes + refreshes the connector's own kind:10032 announcement.
 */
export class SelfAnnounceService {
  private readonly _config: ConnectorConfig;
  private readonly _selfAnnounce: SelfAnnounceConfig;
  private readonly _secretKey: Uint8Array;
  private readonly _logger: Logger;
  private readonly _fetch: FetchLike;
  private readonly _refreshIntervalSecs: number;
  private readonly _ttlSeconds: number;

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  constructor(deps: SelfAnnounceServiceDeps) {
    this._config = deps.config;
    this._selfAnnounce = deps.selfAnnounce;
    this._secretKey = deps.secretKey;
    this._logger = deps.logger.child({ component: 'SelfAnnounceService' });
    this._fetch = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

    const refresh =
      deps.selfAnnounce.refreshIntervalSecs && deps.selfAnnounce.refreshIntervalSecs > 0
        ? Math.floor(deps.selfAnnounce.refreshIntervalSecs)
        : DEFAULT_REFRESH_INTERVAL_SECS;
    this._refreshIntervalSecs = refresh;
    // TTL = 2× the refresh interval so each republish (at half the TTL) always
    // lands a fresh, unexpired event before the previous one lapses.
    this._ttlSeconds = refresh * 2;
  }

  /** Whether the refresh loop is active. */
  get running(): boolean {
    return this._running;
  }

  /** The NIP-40 TTL (seconds) stamped on each announcement. */
  get ttlSeconds(): number {
    return this._ttlSeconds;
  }

  /**
   * Build (but do not publish) the signed kind:10032 event. Exposed for tests
   * and for callers that want to inspect the announcement.
   */
  buildEvent(): NostrEvent {
    const info = buildSelfAnnouncementInfo(this._config, this._selfAnnounce);
    return buildIlpPeerInfoEvent(info, this._secretKey, { ttlSeconds: this._ttlSeconds });
  }

  /**
   * Start: publish immediately, then republish on the interval. The timer is
   * `unref()`'d so it never keeps the process alive on its own.
   */
  start(): void {
    if (this._running) {
      this._logger.warn('Self-announce already running');
      return;
    }
    if (!this._selfAnnounce.enabled) {
      this._logger.info('Self-announce disabled');
      return;
    }
    if (!this._selfAnnounce.writeUrl) {
      this._logger.warn('Self-announce enabled but no writeUrl configured; not announcing');
      return;
    }

    this._running = true;
    this._logger.info(
      {
        event: 'self_announce_started',
        writeUrl: this._selfAnnounce.writeUrl,
        refreshIntervalSecs: this._refreshIntervalSecs,
        ttlSeconds: this._ttlSeconds,
      },
      'Self-announce service started'
    );

    // Boot publish (fire-and-forget; errors are logged, never thrown).
    void this.publish();

    this._timer = setInterval(() => {
      void this.publish();
    }, this._refreshIntervalSecs * 1000);
    // Don't let the refresh timer hold the event loop open.
    this._timer.unref?.();
  }

  /** Stop the refresh loop and clear the timer. Idempotent. */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._running) {
      this._logger.info({ event: 'self_announce_stopped' }, 'Self-announce service stopped');
    }
    this._running = false;
  }

  /**
   * Build, sign, and write a fresh announcement to the relay's `POST /write`
   * store. Never throws — failures are logged so a transient relay outage does
   * not crash the connector or abort the refresh loop.
   */
  async publish(): Promise<void> {
    let event: NostrEvent;
    try {
      event = this.buildEvent();
    } catch (err) {
      this._logger.error(
        { event: 'self_announce_build_failed', err: errMsg(err) },
        'Failed to build self-announce event'
      );
      return;
    }

    try {
      const response = await this._fetch(this._selfAnnounce.writeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // The relay echoes these without re-validating payment; the
          // self-announce is the connector writing on its OWN behalf.
          'X-TOON-Payer': event.pubkey,
          'X-TOON-Amount': '0',
        },
        body: JSON.stringify({ event }),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        this._logger.warn(
          {
            event: 'self_announce_write_rejected',
            status: response.status,
            writeUrl: this._selfAnnounce.writeUrl,
            body: text.slice(0, 200),
          },
          'Self-announce write was rejected by the relay store'
        );
        return;
      }

      this._logger.info(
        {
          event: 'self_announce_published',
          id: event.id.slice(0, 16),
          ilpAddress: extractIlpAddress(event),
          expiresInSecs: this._ttlSeconds,
        },
        'Published self-announce kind:10032 to relay store'
      );
    } catch (err) {
      this._logger.warn(
        {
          event: 'self_announce_write_failed',
          err: errMsg(err),
          writeUrl: this._selfAnnounce.writeUrl,
        },
        'Failed to write self-announce to the relay store (will retry on next refresh)'
      );
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best-effort pull of `ilpAddress` from the event content for logging only. */
function extractIlpAddress(event: NostrEvent): string | undefined {
  try {
    const parsed = JSON.parse(event.content) as { ilpAddress?: string };
    return parsed.ilpAddress;
  } catch {
    return undefined;
  }
}
