/**
 * AnnouncerService — the sidecar's refresh loop (connector#681's re-scope of
 * "implement self-announce in the Rust connector", which ADR 0022 forbids
 * inside the connector binary itself).
 *
 * Every cycle: poll the Rust edge (`GET /ilp/identity` + the x402 greeting
 * per probed route) -> build the kind:10032 content -> sign with the
 * sidecar's own dedicated announce identity -> publish to the configured
 * relay(s). Mirrors the retired `SelfAnnounceService`'s lifecycle contract
 * (boot-publish, then republish every `refreshIntervalSecs`, TTL = 2x that;
 * never let a build/publish failure crash the loop) without any of its
 * transport coupling to a connector's own routing.
 *
 * @module service
 */

import type { Logger } from 'pino';
import { getPublicKey, type NostrEvent } from 'nostr-tools';
import type { AnnouncerConfig } from './config';
import { fetchIdentity, fetchGreeting, type RouteGreeting } from './edge-client';
import { buildAnnouncementInfo } from './announce-builder';
import { buildIlpPeerInfoEvent } from './event';
import { publishToRelays, type RelayPublishResult, type WebSocketFactory } from './publisher';

export interface AnnouncerServiceDeps {
  config: AnnouncerConfig;
  logger: Logger;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the platform `WebSocket`. */
  webSocketFactory?: WebSocketFactory;
}

export class AnnouncerService {
  private readonly _config: AnnouncerConfig;
  private readonly _logger: Logger;
  private readonly _fetchImpl: typeof fetch | undefined;
  private readonly _webSocketFactory: WebSocketFactory | undefined;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  /** The outcome of the most recent cycle, for the health endpoint. */
  lastResult: { at: number; ok: boolean; detail?: string } | null = null;

  constructor(deps: AnnouncerServiceDeps) {
    this._config = deps.config;
    this._logger = deps.logger.child({ component: 'AnnouncerService' });
    this._fetchImpl = deps.fetchImpl;
    this._webSocketFactory = deps.webSocketFactory;
  }

  get running(): boolean {
    return this._running;
  }

  /** The announce pubkey this identity signs as — log this at startup so an operator can eyeball it against the LIVE edge identity (the dual-announce hazard connector#681 exists to close). */
  get announcePubkey(): string {
    return getPublicKey(this._config.secretKey);
  }

  start(): void {
    if (this._running) {
      this._logger.warn('AnnouncerService already running');
      return;
    }
    this._running = true;
    this._logger.info(
      {
        event: 'announcer_started',
        pubkey: this.announcePubkey,
        relayUrls: this._config.relayUrls,
        refreshIntervalSecs: this._config.refreshIntervalSecs,
        ttlSeconds: this._config.ttlSeconds,
      },
      'Announcer sidecar started'
    );

    void this.publishOnce();
    this._timer = setInterval(() => {
      void this.publishOnce();
    }, this._config.refreshIntervalSecs * 1000);
    this._timer.unref?.();
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._running) {
      this._logger.info({ event: 'announcer_stopped' }, 'Announcer sidecar stopped');
    }
    this._running = false;
  }

  /** Poll the edge, build + sign the event, and publish it. Never throws. */
  async publishOnce(): Promise<void> {
    let event: NostrEvent;
    try {
      event = await this.buildEvent();
    } catch (err) {
      this.lastResult = { at: Date.now(), ok: false, detail: errMsg(err) };
      this._logger.error(
        { event: 'announce_build_failed', err: errMsg(err) },
        'Failed to build announce event'
      );
      return;
    }

    const results = await publishToRelays(event, this._config.relayUrls, {
      timeoutMs: this._config.publishTimeoutMs,
      logger: this._logger,
      webSocketFactory: this._webSocketFactory,
    });
    const anyOk = results.some((r) => r.ok);
    this.lastResult = {
      at: Date.now(),
      ok: anyOk,
      detail: summarize(results),
    };
    if (anyOk) {
      this._logger.info(
        { event: 'announce_published', id: event.id.slice(0, 16), results },
        'Published kind:10032 announce'
      );
    } else {
      this._logger.warn(
        { event: 'announce_publish_failed', id: event.id.slice(0, 16), results },
        'Announce publish did not succeed at any relay (will retry next cycle)'
      );
    }
  }

  /** Poll the edge and build (but do not publish) the signed event. Exposed for tests. */
  async buildEvent(): Promise<NostrEvent> {
    const edgeOpts = {
      baseUrl: this._config.rustEdgeUrl,
      timeoutMs: this._config.edgePollTimeoutMs,
      logger: this._logger,
      fetchImpl: this._fetchImpl,
    };

    const identity = await fetchIdentity(edgeOpts);
    const greetings: RouteGreeting[] = [];
    for (const route of this._config.probeRoutes) {
      const greeting = await fetchGreeting(route, edgeOpts);
      if (greeting) greetings.push(greeting);
    }

    const info = buildAnnouncementInfo(
      {
        ilpAddress: this._config.ilpAddress,
        ilpAddresses: this._config.ilpAddresses,
        httpEndpoint: this._config.httpEndpoint,
        btpEndpoint: this._config.btpEndpoint,
        relayUrl: this._config.relayPublicUrl,
        assetCode: this._config.assetCode,
        assetScale: this._config.assetScale,
        routePublish: this._config.routePublish,
        routeStore: this._config.routeStore,
        solanaChainId: this._config.solanaChainId,
      },
      identity,
      greetings
    );

    return buildIlpPeerInfoEvent(info, this._config.secretKey, {
      ttlSeconds: this._config.ttlSeconds,
    });
  }
}

function summarize(results: RelayPublishResult[]): string {
  return results
    .map((r) => `${r.relay}=${r.ok ? 'ok' : `fail(${r.detail ?? 'unknown'})`}`)
    .join(', ');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
