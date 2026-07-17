/**
 * Cold-start bootstrap service (toon-meta#153).
 *
 * Everything in the TOON network is discovered THROUGH a relay (kind:10032
 * `IlpPeerInfo` announcements), so a cold node's only real problem is finding
 * its FIRST relay. This service solves exactly that:
 *
 *  1. **Resolve** candidate relay seeds, in trust order:
 *     fresh curated signed registry (`bootstrap.registryUrl`, whole-manifest
 *     schnorr signature against the pinned curator key) → persisted
 *     learned-peer cache from previous runs → operator config seeds
 *     (`bootstrap.seeds`) → hardcoded fallback of last resort. Candidates are
 *     merged and deduped by relay URL, first tier wins.
 *  2. **Sample-and-verify** BEFORE trusting: probe up to N (default 3)
 *     candidates concurrently per wave with the injected `relayProbe` ("can I
 *     connect and fetch at least one valid kind:10032 event, or an EOSE,
 *     within the timeout"). A relay that fails the probe is skipped with a
 *     warn; the result is an ordered list of verified relay URLs.
 *  3. **Persist** verified relays to the cache with timestamps, so the next
 *     cold start bootstraps from learned data — seeds are refreshable data,
 *     not frozen config (the connector#289 lesson).
 *
 * Consumers (self-announce `announceTo` targets, the future kind:10032
 * route-learning client) read `getRelayUrls()` or subscribe via
 * `onRelaysResolved()`. The probe is injected behind `RelayProbeFn` so it can
 * later share the real route-learning relay client.
 *
 * @module discovery/bootstrap-service
 */

import type { Logger } from 'pino';
import type { BootstrapConfig } from '../config/types';
import { FALLBACK_CURATOR_PUBKEY, FALLBACK_RELAY_SEEDS, type RelaySeed } from './bootstrap-seeds';
import { parseSeedManifest, verifySeedManifest } from './bootstrap-manifest';
import type { BootstrapCacheStore, CachedRelaySeed, RelaySeedSource } from './bootstrap-cache';

/** Default sample-and-verify width (candidates probed per wave / relays kept). */
export const DEFAULT_SAMPLE_SIZE = 3;
/** Default seed re-resolution cadence (seconds): 1 hour. */
export const DEFAULT_BOOTSTRAP_REFRESH_INTERVAL_SECS = 3600;
/** Default per-relay probe timeout (ms). */
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;
/** Cached learned relays older than this are ignored at resolution time: 7 days. */
export const DEFAULT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A candidate relay seed annotated with the resolution tier it came from. */
export interface ResolvedRelaySeed extends RelaySeed {
  source: RelaySeedSource;
}

/** Outcome of probing one relay candidate. */
export interface RelayProbeResult {
  /** Whether the relay verified (connected + valid kind:10032 event or EOSE). */
  ok: boolean;
  /** Optional detail for logging (e.g. `'eose'`, `'timeout'`, an error message). */
  detail?: string;
}

/**
 * Probes one relay WS URL: can we connect and fetch at least one valid
 * kind:10032 event (or an EOSE) within `timeoutMs`? Injected so tests use
 * fakes and so the future route-learning relay client can back it.
 * Should not throw; a throw is treated as a failed probe.
 */
export type RelayProbeFn = (relayUrl: string, timeoutMs: number) => Promise<RelayProbeResult>;

/** Minimal fetch-response surface the registry fetch needs. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** Minimal fetch function for the HTTPS registry (defaults to global fetch). */
export type FetchFn = (url: string) => Promise<FetchResponseLike>;

/** Callback invoked with the ordered verified relay URLs after each refresh. */
export type RelaysResolvedListener = (relayUrls: string[]) => void;

export interface BootstrapServiceDeps {
  /** The validated `bootstrap` config block. */
  config: BootstrapConfig;
  /** HTTPS fetch for the curated registry. Defaults to global `fetch`. */
  fetchFn?: FetchFn;
  /** Relay sample-and-verify probe. */
  relayProbe: RelayProbeFn;
  /** Learned-peer cache persistence. */
  cacheStore: BootstrapCacheStore;
  /** Pino logger. */
  logger: Logger;
  /** Clock seam for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Per-relay probe timeout override (ms). Defaults to 5000. */
  probeTimeoutMs?: number;
  /** Cache staleness cutoff override (ms). Defaults to 7 days. */
  cacheMaxAgeMs?: number;
}

/**
 * Resolves, verifies, caches, and periodically refreshes the relay seeds a
 * cold connector bootstraps from.
 */
export class BootstrapService {
  private readonly _config: BootstrapConfig;
  private readonly _fetchFn: FetchFn;
  private readonly _relayProbe: RelayProbeFn;
  private readonly _cacheStore: BootstrapCacheStore;
  private readonly _logger: Logger;
  private readonly _now: () => number;
  private readonly _sampleSize: number;
  private readonly _refreshIntervalSecs: number;
  private readonly _probeTimeoutMs: number;
  private readonly _cacheMaxAgeMs: number;
  private readonly _listeners = new Set<RelaysResolvedListener>();

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _refreshing: Promise<void> | null = null;
  /** Last successfully verified relays, in resolution order. */
  private _verified: ResolvedRelaySeed[] = [];

  constructor(deps: BootstrapServiceDeps) {
    this._config = deps.config;
    this._fetchFn = deps.fetchFn ?? defaultFetch;
    this._relayProbe = deps.relayProbe;
    this._cacheStore = deps.cacheStore;
    this._logger = deps.logger.child({ component: 'BootstrapService' });
    this._now = deps.now ?? Date.now;
    this._sampleSize =
      deps.config.sampleSize && deps.config.sampleSize > 0
        ? Math.floor(deps.config.sampleSize)
        : DEFAULT_SAMPLE_SIZE;
    this._refreshIntervalSecs =
      deps.config.refreshIntervalSecs && deps.config.refreshIntervalSecs > 0
        ? Math.floor(deps.config.refreshIntervalSecs)
        : DEFAULT_BOOTSTRAP_REFRESH_INTERVAL_SECS;
    this._probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this._cacheMaxAgeMs = deps.cacheMaxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS;
  }

  /** Whether the refresh loop is active. */
  get running(): boolean {
    return this._running;
  }

  /**
   * The most recently verified relay URLs, in resolution (trust) order.
   * Empty until the first successful refresh; retains the last known-good
   * list across a refresh in which nothing verifies.
   */
  getRelayUrls(): string[] {
    return this._verified.map((seed) => seed.relayUrl);
  }

  /**
   * Subscribe to resolution results. The listener fires after every refresh
   * that verified at least one relay. Returns an unsubscribe function.
   */
  onRelaysResolved(listener: RelaysResolvedListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /**
   * Start: resolve immediately, then re-resolve on the interval. The timer is
   * `unref()`'d so it never keeps the process alive on its own. No-op when
   * `bootstrap.enabled` is false.
   */
  start(): void {
    if (this._running) {
      this._logger.warn('Bootstrap service already running');
      return;
    }
    if (!this._config.enabled) {
      this._logger.info({ event: 'bootstrap_disabled' }, 'Cold-start bootstrap disabled');
      return;
    }

    this._running = true;
    this._logger.info(
      {
        event: 'bootstrap_started',
        registryUrl: this._config.registryUrl,
        configSeeds: this._config.seeds?.length ?? 0,
        sampleSize: this._sampleSize,
        refreshIntervalSecs: this._refreshIntervalSecs,
      },
      'Cold-start bootstrap service started'
    );

    // Boot refresh (fire-and-forget; refresh() never throws).
    void this.refresh();

    this._timer = setInterval(() => {
      void this.refresh();
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
      this._logger.info({ event: 'bootstrap_stopped' }, 'Cold-start bootstrap service stopped');
    }
    this._running = false;
  }

  /**
   * Resolve → sample-and-verify → persist → notify. Never throws; every
   * failure mode logs and falls through to the next tier or keeps the last
   * known-good result. Concurrent calls coalesce onto the in-flight refresh.
   */
  refresh(): Promise<void> {
    if (this._refreshing) {
      return this._refreshing;
    }
    this._refreshing = this._refreshOnce().finally(() => {
      this._refreshing = null;
    });
    return this._refreshing;
  }

  private async _refreshOnce(): Promise<void> {
    const candidates = await this._resolveCandidates();
    if (candidates.length === 0) {
      this._logger.warn(
        { event: 'bootstrap_no_candidates' },
        'Bootstrap produced no relay seed candidates (registry, cache, config, and fallback all empty)'
      );
      return;
    }

    const verified = await this._sampleAndVerify(candidates);
    if (verified.length === 0) {
      this._logger.warn(
        {
          event: 'bootstrap_no_relays_verified',
          candidates: candidates.map((seed) => seed.relayUrl),
          lastKnownGood: this.getRelayUrls(),
        },
        'No relay candidate passed sample-and-verify; keeping last known-good relays (will retry on next refresh)'
      );
      return;
    }

    this._verified = verified;
    this._logger.info(
      {
        event: 'bootstrap_seed_resolved',
        relays: verified.map((seed) => ({ relayUrl: seed.relayUrl, source: seed.source })),
        candidateCount: candidates.length,
        verifiedCount: verified.length,
      },
      'Bootstrap relay seeds resolved and verified'
    );

    await this._persistVerified(verified);

    const relayUrls = this.getRelayUrls();
    for (const listener of this._listeners) {
      try {
        listener(relayUrls);
      } catch (err) {
        this._logger.warn(
          { event: 'bootstrap_listener_failed', err: errMsg(err) },
          'A bootstrap relays-resolved listener threw; continuing'
        );
      }
    }
  }

  /**
   * Build the ordered, deduped candidate list:
   * registry → cache → config seeds → hardcoded fallback. First tier wins on
   * duplicate relay URLs.
   */
  private async _resolveCandidates(): Promise<ResolvedRelaySeed[]> {
    const merged = new Map<string, ResolvedRelaySeed>();
    const add = (seed: RelaySeed, source: RelaySeedSource): void => {
      const key = normalizeRelayUrl(seed.relayUrl);
      if (key === null || merged.has(key)) {
        return;
      }
      const resolved: ResolvedRelaySeed = { relayUrl: seed.relayUrl, source };
      if (seed.pubkey !== undefined) {
        resolved.pubkey = seed.pubkey;
      }
      merged.set(key, resolved);
    };

    // 1. Fresh curated signed registry.
    for (const seed of await this._fetchRegistrySeeds()) {
      add(seed, 'registry');
    }
    // 2. Persisted learned-peer cache (fresh entries only).
    for (const seed of await this._loadFreshCacheSeeds()) {
      add(seed, 'cache');
    }
    // 3. Operator config seeds.
    for (const seed of this._config.seeds ?? []) {
      add(seed, 'config');
    }
    // 4. Hardcoded fallback of last resort.
    for (const seed of FALLBACK_RELAY_SEEDS) {
      add(seed, 'fallback');
    }

    return [...merged.values()];
  }

  /**
   * Fetch + parse + signature-verify the curated registry manifest. Any
   * failure (network, HTTP status, JSON, schema, signature) logs a warn and
   * returns `[]` so resolution falls through to the next tier.
   */
  private async _fetchRegistrySeeds(): Promise<RelaySeed[]> {
    const registryUrl = this._config.registryUrl;
    if (!registryUrl) {
      return [];
    }

    let body: string;
    try {
      const response = await this._fetchFn(registryUrl);
      if (!response.ok) {
        this._logger.warn(
          { event: 'bootstrap_registry_fetch_failed', registryUrl, status: response.status },
          'Bootstrap seed registry returned a non-OK status; falling back'
        );
        return [];
      }
      body = await response.text();
    } catch (err) {
      this._logger.warn(
        { event: 'bootstrap_registry_fetch_failed', registryUrl, err: errMsg(err) },
        'Failed to fetch bootstrap seed registry; falling back'
      );
      return [];
    }

    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch (err) {
      this._logger.warn(
        { event: 'bootstrap_registry_invalid', registryUrl, err: errMsg(err) },
        'Bootstrap seed registry is not valid JSON; falling back'
      );
      return [];
    }

    const parsed = parseSeedManifest(raw);
    if (!parsed.ok) {
      this._logger.warn(
        { event: 'bootstrap_registry_invalid', registryUrl, error: parsed.error },
        'Bootstrap seed registry manifest is malformed; falling back'
      );
      return [];
    }

    // Verification ALWAYS uses the pinned key (config, else the hardcoded
    // placeholder) — never the manifest's own embedded curatorPubkey.
    const pinnedKey = this._config.curatorPubkey ?? FALLBACK_CURATOR_PUBKEY;
    if (!verifySeedManifest(parsed.manifest, pinnedKey)) {
      this._logger.warn(
        {
          event: 'bootstrap_registry_signature_invalid',
          registryUrl,
          manifestVersion: parsed.manifest.version,
          updatedAt: parsed.manifest.updatedAt,
        },
        'Bootstrap seed registry signature does not verify against the pinned curator key; REJECTING manifest and falling back'
      );
      return [];
    }

    this._logger.info(
      {
        event: 'bootstrap_registry_verified',
        registryUrl,
        manifestVersion: parsed.manifest.version,
        updatedAt: parsed.manifest.updatedAt,
        entryCount: parsed.manifest.entries.length,
      },
      'Bootstrap seed registry fetched and signature-verified'
    );
    return parsed.manifest.entries;
  }

  /** Load cached learned relays, dropping entries older than the staleness cutoff. */
  private async _loadFreshCacheSeeds(): Promise<CachedRelaySeed[]> {
    let cached: CachedRelaySeed[];
    try {
      cached = await this._cacheStore.load();
    } catch (err) {
      this._logger.warn(
        { event: 'bootstrap_cache_load_failed', err: errMsg(err) },
        'Failed to load bootstrap relay cache; skipping cache tier'
      );
      return [];
    }

    const cutoff = this._now() - this._cacheMaxAgeMs;
    const fresh = cached.filter((entry) => {
      const verifiedAt = Date.parse(entry.verifiedAt);
      return !Number.isNaN(verifiedAt) && verifiedAt >= cutoff;
    });
    if (fresh.length < cached.length) {
      this._logger.debug(
        {
          event: 'bootstrap_cache_stale_dropped',
          dropped: cached.length - fresh.length,
          kept: fresh.length,
        },
        'Dropped stale bootstrap cache entries'
      );
    }
    return fresh;
  }

  /**
   * Probe candidates in waves of `sampleSize` (concurrent within a wave),
   * walking down the candidate list until `sampleSize` relays verified or the
   * list is exhausted. Failed probes are skipped with a warn. Returns
   * verified seeds in candidate (trust) order.
   */
  private async _sampleAndVerify(candidates: ResolvedRelaySeed[]): Promise<ResolvedRelaySeed[]> {
    const verified: ResolvedRelaySeed[] = [];
    for (
      let i = 0;
      i < candidates.length && verified.length < this._sampleSize;
      i += this._sampleSize
    ) {
      const wave = candidates.slice(i, i + this._sampleSize);
      const results = await Promise.all(
        wave.map(async (seed): Promise<RelayProbeResult> => {
          try {
            return await this._relayProbe(seed.relayUrl, this._probeTimeoutMs);
          } catch (err) {
            return { ok: false, detail: errMsg(err) };
          }
        })
      );
      for (const [index, seed] of wave.entries()) {
        const result = results[index];
        if (result?.ok) {
          if (verified.length < this._sampleSize) {
            verified.push(seed);
          }
        } else {
          this._logger.warn(
            {
              event: 'bootstrap_relay_probe_failed',
              relayUrl: seed.relayUrl,
              source: seed.source,
              detail: result?.detail,
            },
            'Bootstrap relay candidate failed sample-and-verify; skipping'
          );
        }
      }
    }
    return verified;
  }

  /**
   * Persist newly verified relays (timestamped now) merged over the still-
   * fresh existing cache entries, deduped by URL with the new verification
   * winning. Best-effort: a save failure logs and never fails the refresh.
   */
  private async _persistVerified(verified: ResolvedRelaySeed[]): Promise<void> {
    try {
      const nowIso = new Date(this._now()).toISOString();
      const merged = new Map<string, CachedRelaySeed>();
      for (const entry of await this._loadFreshCacheSeeds()) {
        const key = normalizeRelayUrl(entry.relayUrl);
        if (key !== null) {
          merged.set(key, entry);
        }
      }
      for (const seed of verified) {
        const key = normalizeRelayUrl(seed.relayUrl);
        if (key === null) {
          continue;
        }
        const cachedSeed: CachedRelaySeed = {
          relayUrl: seed.relayUrl,
          verifiedAt: nowIso,
          source: seed.source,
        };
        if (seed.pubkey !== undefined) {
          cachedSeed.pubkey = seed.pubkey;
        }
        merged.set(key, cachedSeed);
      }
      await this._cacheStore.save([...merged.values()]);
      this._logger.debug(
        { event: 'bootstrap_cache_saved', entries: merged.size },
        'Persisted verified bootstrap relays to the learned-peer cache'
      );
    } catch (err) {
      this._logger.warn(
        { event: 'bootstrap_cache_save_failed', err: errMsg(err) },
        'Failed to persist verified bootstrap relays; continuing'
      );
    }
  }
}

/**
 * Normalize a relay URL for dedupe: lowercase scheme+host, strip a single
 * trailing slash. Returns null for strings that are not ws(s) URLs.
 */
function normalizeRelayUrl(relayUrl: string): string | null {
  if (typeof relayUrl !== 'string' || !/^wss?:\/\/.+/i.test(relayUrl)) {
    return null;
  }
  try {
    const url = new URL(relayUrl);
    const pathname = url.pathname === '/' ? '' : url.pathname;
    return `${url.protocol}//${url.host}${pathname}${url.search}`;
  } catch {
    return null;
  }
}

/** Global-fetch adapter (Node >= 22 always provides `fetch`). */
const defaultFetch: FetchFn = async (url) => {
  const response = await fetch(url);
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
  };
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
