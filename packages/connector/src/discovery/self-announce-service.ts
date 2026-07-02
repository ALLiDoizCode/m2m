/**
 * Self-Announce Service (relay#37 / store#22).
 *
 * On boot (and on an interval), builds, signs, and publishes a fresh
 * `kind:10032` `IlpPeerInfo` announcement describing the connector's OWN apex
 * routes — refreshing it BEFORE the NIP-40 `expiration` lapses so discovery
 * never goes dark.
 *
 * This service owns ONLY the event lifecycle: derive the announcement from
 * config, sign it (NIP-06), and drive the refresh loop. The publish TRANSPORT
 * is injected as a `PublishFn` so the connector can route the write through its
 * OWN pipe — a locally-terminated `announceTo` delivers free through the route's
 * `RouteTermination`, a remote `announceTo` originates a paid write funded from
 * the connector's settlement channel (see `self-announce-publish.ts`). The
 * service never reaches the relay's private port directly.
 *
 * Identity: signed with the connector's Nostr key derived from its mnemonic via
 * NIP-06 (the SAME secp256k1 key it settles with). `kind:10032` is a replaceable
 * event (10000-19999), so each refresh supersedes the last.
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

/**
 * Outcome of a publish attempt, returned by the injected {@link PublishFn} for
 * logging. `mode` records whether routing resolved to a free local delivery or
 * a paid remote forward; `ok` is whether the write was accepted (FULFILL).
 */
export interface PublishOutcome {
  mode: 'local-free' | 'remote-paid';
  ok: boolean;
  /** Optional detail (e.g. an ILP reject code) for logging. */
  detail?: string;
}

/**
 * Publishes a signed announcement event through the connector's own routing.
 * Injected by `ConnectorNode` so the service stays transport-agnostic. May
 * throw; the service catches and logs (never-throw publish loop).
 */
export type PublishFn = (event: NostrEvent) => Promise<PublishOutcome>;

export interface SelfAnnounceServiceDeps {
  /** The full connector config (routes + chainProviders) the announcement derives from. */
  config: ConnectorConfig;
  /** The `selfAnnounce` block (endpoints + overrides). */
  selfAnnounce: SelfAnnounceConfig;
  /** The 32-byte Nostr secret key (NIP-06 key) to sign the announcement with. */
  secretKey: Uint8Array;
  /** Routes the signed event through the connector's own pipe (free local / paid remote). */
  publish: PublishFn;
  /** Pino logger. */
  logger: Logger;
}

/**
 * Publishes + refreshes the connector's own kind:10032 announcement.
 */
export class SelfAnnounceService {
  private readonly _config: ConnectorConfig;
  private readonly _selfAnnounce: SelfAnnounceConfig;
  private readonly _secretKey: Uint8Array;
  private readonly _publish: PublishFn;
  private readonly _logger: Logger;
  private readonly _refreshIntervalSecs: number;
  private readonly _ttlSeconds: number;

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  constructor(deps: SelfAnnounceServiceDeps) {
    this._config = deps.config;
    this._selfAnnounce = deps.selfAnnounce;
    this._secretKey = deps.secretKey;
    this._publish = deps.publish;
    this._logger = deps.logger.child({ component: 'SelfAnnounceService' });

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
    const info = buildSelfAnnouncementInfo(this._config, this._selfAnnounce, (context, message) =>
      this._logger.warn(context, message)
    );
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
    if (!this._selfAnnounce.announceTo) {
      this._logger.warn('Self-announce enabled but no announceTo configured; not announcing');
      return;
    }

    this._running = true;
    this._logger.info(
      {
        event: 'self_announce_started',
        announceTo: this._selfAnnounce.announceTo,
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
   * Build, sign, and publish a fresh announcement through the connector's pipe.
   * Never throws — a build error or a publish failure (rejected write, no
   * channel, transient outage) is logged so it does not crash the connector or
   * abort the refresh loop.
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
      const outcome = await this._publish(event);
      if (outcome.ok) {
        this._logger.info(
          {
            event: 'self_announce_published',
            id: event.id.slice(0, 16),
            mode: outcome.mode,
            announceTo: this._selfAnnounce.announceTo,
            expiresInSecs: this._ttlSeconds,
          },
          'Published self-announce kind:10032 through connector routing'
        );
      } else {
        this._logger.warn(
          {
            event: 'self_announce_rejected',
            id: event.id.slice(0, 16),
            mode: outcome.mode,
            announceTo: this._selfAnnounce.announceTo,
            detail: outcome.detail,
          },
          'Self-announce write was rejected (will retry on next refresh)'
        );
      }
    } catch (err) {
      this._logger.warn(
        {
          event: 'self_announce_publish_failed',
          err: errMsg(err),
          announceTo: this._selfAnnounce.announceTo,
        },
        'Failed to publish self-announce through connector routing (will retry on next refresh)'
      );
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
