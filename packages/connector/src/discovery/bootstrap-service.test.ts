/**
 * Tests for the cold-start BootstrapService (toon-meta#153).
 *
 * Covers: the resolution order + fallback chain (signed registry →
 * learned-peer cache → config seeds → hardcoded fallback), whole-manifest
 * signature accept/reject, sample-and-verify wave probing that skips failed
 * relays, persistence of verified relays with timestamps, cache staleness
 * filtering, the getRelayUrls()/onRelaysResolved() consumer surface, and the
 * start/stop refresh-loop lifecycle.
 *
 * All dependencies are injected hand-written fakes (in-memory cache store,
 * canned fetch, scripted probe) — NO network, NO library mocks. Registry
 * manifests are signed with real schnorr keys.
 *
 * @module discovery/bootstrap-service.test
 */

import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { createLogger } from '../utils/logger';
import type { BootstrapConfig } from '../config/types';
import {
  BootstrapService,
  DEFAULT_CACHE_MAX_AGE_MS,
  DEFAULT_SAMPLE_SIZE,
  type FetchFn,
  type RelayProbeFn,
} from './bootstrap-service';
import { signSeedManifest, type SeedManifest } from './bootstrap-manifest';
import { FALLBACK_RELAY_SEEDS } from './bootstrap-seeds';
import type { BootstrapCacheStore, CachedRelaySeed } from './bootstrap-cache';

const logger = createLogger('bootstrap-service-test', 'silent');

const curatorSecret = schnorr.utils.randomPrivateKey();
const curatorPubkey = bytesToHex(schnorr.getPublicKey(curatorSecret));
const rogueSecret = schnorr.utils.randomPrivateKey();

const REGISTRY_URL = 'https://seeds.toonprotocol.dev/relays.json';
const NOW = Date.parse('2026-07-16T12:00:00Z');

/** In-memory BootstrapCacheStore fake (hand-written, no jest mocks). */
class MemoryCacheStore implements BootstrapCacheStore {
  entries: CachedRelaySeed[] = [];
  loadCalls = 0;
  saveCalls = 0;
  failLoad = false;
  failSave = false;

  load(): Promise<CachedRelaySeed[]> {
    this.loadCalls += 1;
    if (this.failLoad) {
      return Promise.reject(new Error('cache load boom'));
    }
    return Promise.resolve([...this.entries]);
  }

  save(entries: CachedRelaySeed[]): Promise<void> {
    this.saveCalls += 1;
    if (this.failSave) {
      return Promise.reject(new Error('cache save boom'));
    }
    this.entries = [...entries];
    return Promise.resolve();
  }
}

/** Canned-response FetchFn recorder. */
function cannedFetch(body: unknown, ok = true, status = 200): FetchFn & { calls: string[] } {
  const calls: string[] = [];
  const fn: FetchFn = (url) => {
    calls.push(url);
    return Promise.resolve({
      ok,
      status,
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    });
  };
  return Object.assign(fn, { calls });
}

/** Scripted probe: URLs in `failing` fail, everything else verifies. */
function scriptedProbe(failing: string[] = []): RelayProbeFn & { probed: string[] } {
  const probed: string[] = [];
  const fn: RelayProbeFn = (relayUrl) => {
    probed.push(relayUrl);
    return failing.includes(relayUrl)
      ? Promise.resolve({ ok: false, detail: 'scripted failure' })
      : Promise.resolve({ ok: true, detail: 'eose' });
  };
  return Object.assign(fn, { probed });
}

function signedManifest(relayUrls: string[], secret: Uint8Array = curatorSecret): SeedManifest {
  return signSeedManifest(
    {
      version: 1,
      updatedAt: '2026-07-15T00:00:00Z',
      entries: relayUrls.map((relayUrl) => ({ relayUrl })),
    },
    secret
  );
}

function baseConfig(overrides: Partial<BootstrapConfig> = {}): BootstrapConfig {
  return { enabled: true, curatorPubkey, ...overrides };
}

interface ServiceHarness {
  service: BootstrapService;
  cache: MemoryCacheStore;
}

function makeService(
  config: BootstrapConfig,
  opts: {
    fetchFn?: FetchFn;
    probe?: RelayProbeFn;
    cache?: MemoryCacheStore;
    now?: () => number;
  } = {}
): ServiceHarness {
  const cache = opts.cache ?? new MemoryCacheStore();
  const service = new BootstrapService({
    config,
    fetchFn: opts.fetchFn ?? cannedFetch({}, false, 404),
    relayProbe: opts.probe ?? scriptedProbe(),
    cacheStore: cache,
    logger,
    now: opts.now ?? ((): number => NOW),
  });
  return { service, cache };
}

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('BootstrapService — resolution order + fallback chain (toon-meta#153)', () => {
  it('prefers registry entries, then cache, then config seeds, then hardcoded fallback', async () => {
    const cache = new MemoryCacheStore();
    cache.entries = [
      {
        relayUrl: 'wss://cached.example.org',
        verifiedAt: new Date(NOW - 60_000).toISOString(),
        source: 'registry',
      },
    ];
    const { service } = makeService(
      baseConfig({
        registryUrl: REGISTRY_URL,
        seeds: [{ relayUrl: 'wss://config-seed.example.org' }],
        sampleSize: 10,
      }),
      { fetchFn: cannedFetch(signedManifest(['wss://registry.example.org'])), cache }
    );

    await service.refresh();

    const firstFallback = FALLBACK_RELAY_SEEDS[0]!.relayUrl;
    expect(service.getRelayUrls()).toEqual([
      'wss://registry.example.org',
      'wss://cached.example.org',
      'wss://config-seed.example.org',
      ...FALLBACK_RELAY_SEEDS.map((seed) => seed.relayUrl),
    ]);
    expect(service.getRelayUrls()).toContain(firstFallback);
  });

  it('dedupes by relay URL with the earlier (more trusted) tier winning', async () => {
    const url = 'wss://shared.example.org';
    const cache = new MemoryCacheStore();
    const { service } = makeService(
      baseConfig({ registryUrl: REGISTRY_URL, seeds: [{ relayUrl: url }], sampleSize: 10 }),
      { fetchFn: cannedFetch(signedManifest([url])), cache }
    );

    await service.refresh();

    const occurrences = service.getRelayUrls().filter((relayUrl) => relayUrl === url);
    expect(occurrences).toHaveLength(1);
    // Persisted provenance reflects the registry tier, not config.
    expect(cache.entries.find((entry) => entry.relayUrl === url)?.source).toBe('registry');
  });

  it('falls back to config seeds + hardcoded list when the registry fetch fails', async () => {
    const { service } = makeService(
      baseConfig({
        registryUrl: REGISTRY_URL,
        seeds: [{ relayUrl: 'wss://config-seed.example.org' }],
        sampleSize: 10,
      }),
      {
        fetchFn: () => Promise.reject(new Error('network down')),
      }
    );

    await service.refresh();

    expect(service.getRelayUrls()).toEqual([
      'wss://config-seed.example.org',
      ...FALLBACK_RELAY_SEEDS.map((seed) => seed.relayUrl),
    ]);
  });

  it('reaches the hardcoded fallback of last resort when everything else is empty', async () => {
    const { service } = makeService(baseConfig({ sampleSize: 10 }));
    await service.refresh();
    expect(service.getRelayUrls()).toEqual(FALLBACK_RELAY_SEEDS.map((seed) => seed.relayUrl));
  });
});

describe('BootstrapService — signed registry verification (toon-meta#153)', () => {
  it('accepts a manifest signed by the pinned curator key', async () => {
    const { service } = makeService(baseConfig({ registryUrl: REGISTRY_URL, sampleSize: 1 }), {
      fetchFn: cannedFetch(signedManifest(['wss://registry.example.org'])),
    });
    await service.refresh();
    expect(service.getRelayUrls()).toEqual(['wss://registry.example.org']);
  });

  it('REJECTS a manifest signed by the wrong key and falls back', async () => {
    const { service } = makeService(
      baseConfig({
        registryUrl: REGISTRY_URL,
        seeds: [{ relayUrl: 'wss://config-seed.example.org' }],
        sampleSize: 1,
      }),
      { fetchFn: cannedFetch(signedManifest(['wss://evil.example.org'], rogueSecret)) }
    );
    await service.refresh();
    expect(service.getRelayUrls()).toEqual(['wss://config-seed.example.org']);
    expect(service.getRelayUrls()).not.toContain('wss://evil.example.org');
  });

  it('rejects a tampered manifest (valid sig, altered entries)', async () => {
    const manifest = signedManifest(['wss://registry.example.org']);
    const tampered = {
      ...manifest,
      entries: [...manifest.entries, { relayUrl: 'wss://injected.example.org' }],
    };
    const { service } = makeService(
      baseConfig({ registryUrl: REGISTRY_URL, seeds: [{ relayUrl: 'wss://safe.example.org' }] }),
      { fetchFn: cannedFetch(tampered) }
    );
    await service.refresh();
    expect(service.getRelayUrls()).not.toContain('wss://registry.example.org');
    expect(service.getRelayUrls()).not.toContain('wss://injected.example.org');
  });

  it('handles non-OK HTTP, invalid JSON, and malformed manifests gracefully', async () => {
    for (const fetchFn of [
      cannedFetch({}, false, 503),
      cannedFetch('{oops'),
      cannedFetch({ version: 'x' }),
    ]) {
      const { service } = makeService(
        baseConfig({ registryUrl: REGISTRY_URL, seeds: [{ relayUrl: 'wss://safe.example.org' }] }),
        { fetchFn }
      );
      await service.refresh();
      expect(service.getRelayUrls()[0]).toBe('wss://safe.example.org');
    }
  });
});

describe('BootstrapService — sample-and-verify (toon-meta#153)', () => {
  it('skips relays that fail the probe and keeps walking the candidate list', async () => {
    const probe = scriptedProbe(['wss://dead-1.example.org', 'wss://dead-2.example.org']);
    const { service } = makeService(
      baseConfig({
        seeds: [
          { relayUrl: 'wss://dead-1.example.org' },
          { relayUrl: 'wss://dead-2.example.org' },
          { relayUrl: 'wss://live-1.example.org' },
          { relayUrl: 'wss://live-2.example.org' },
        ],
        sampleSize: 2,
      }),
      { probe }
    );

    await service.refresh();

    // Wave 1 (dead-1, dead-2) both fail → wave 2 (live-1, live-2) verifies.
    expect(service.getRelayUrls()).toEqual([
      'wss://live-1.example.org',
      'wss://live-2.example.org',
    ]);
    expect(probe.probed).toEqual([
      'wss://dead-1.example.org',
      'wss://dead-2.example.org',
      'wss://live-1.example.org',
      'wss://live-2.example.org',
    ]);
  });

  it('caps the verified list at sampleSize and stops probing once satisfied', async () => {
    const probe = scriptedProbe();
    const { service } = makeService(
      baseConfig({
        seeds: [
          { relayUrl: 'wss://a.example.org' },
          { relayUrl: 'wss://b.example.org' },
          { relayUrl: 'wss://c.example.org' },
          { relayUrl: 'wss://d.example.org' },
        ],
        sampleSize: 2,
      }),
      { probe }
    );

    await service.refresh();

    expect(service.getRelayUrls()).toEqual(['wss://a.example.org', 'wss://b.example.org']);
    // Fallback candidates beyond the first satisfied wave were never probed.
    expect(probe.probed).toEqual(['wss://a.example.org', 'wss://b.example.org']);
  });

  it('treats a throwing probe as a failed verification, not a crash', async () => {
    const probe: RelayProbeFn = (relayUrl) => {
      if (relayUrl === 'wss://boom.example.org') {
        return Promise.reject(new Error('probe exploded'));
      }
      // Only the intended seed verifies; fallback candidates stay dark.
      return Promise.resolve({ ok: relayUrl === 'wss://ok.example.org' });
    };
    const { service } = makeService(
      baseConfig({
        seeds: [{ relayUrl: 'wss://boom.example.org' }, { relayUrl: 'wss://ok.example.org' }],
        sampleSize: 2,
      }),
      { probe }
    );

    await service.refresh();
    expect(service.getRelayUrls()).toEqual(['wss://ok.example.org']);
  });

  it('keeps the last known-good relays when no candidate verifies', async () => {
    let failEverything = false;
    const probe: RelayProbeFn = () =>
      Promise.resolve(failEverything ? { ok: false, detail: 'down' } : { ok: true });
    const { service } = makeService(
      baseConfig({ seeds: [{ relayUrl: 'wss://only.example.org' }], sampleSize: 1 }),
      { probe }
    );

    await service.refresh();
    expect(service.getRelayUrls()).toEqual(['wss://only.example.org']);

    failEverything = true;
    await service.refresh();
    expect(service.getRelayUrls()).toEqual(['wss://only.example.org']);
  });

  it('defaults sampleSize to 3', async () => {
    const probe = scriptedProbe();
    const seeds = ['a', 'b', 'c', 'd', 'e'].map((name) => ({
      relayUrl: `wss://${name}.example.org`,
    }));
    const { service } = makeService(baseConfig({ seeds }), { probe });
    await service.refresh();
    expect(DEFAULT_SAMPLE_SIZE).toBe(3);
    expect(service.getRelayUrls()).toHaveLength(3);
  });
});

describe('BootstrapService — learned-peer cache (toon-meta#153)', () => {
  it('persists verified relays with a verifiedAt timestamp and provenance', async () => {
    const cache = new MemoryCacheStore();
    const { service } = makeService(
      baseConfig({
        seeds: [{ relayUrl: 'wss://seed.example.org', pubkey: 'b'.repeat(64) }],
        sampleSize: 1,
      }),
      { cache }
    );

    await service.refresh();

    expect(cache.entries).toEqual([
      {
        relayUrl: 'wss://seed.example.org',
        pubkey: 'b'.repeat(64),
        verifiedAt: new Date(NOW).toISOString(),
        source: 'config',
      },
    ]);
  });

  it('uses fresh cached relays on the next cold start, ahead of config seeds', async () => {
    const cache = new MemoryCacheStore();
    cache.entries = [
      {
        relayUrl: 'wss://learned.example.org',
        verifiedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
        source: 'registry',
      },
    ];
    const { service } = makeService(
      baseConfig({ seeds: [{ relayUrl: 'wss://config-seed.example.org' }], sampleSize: 2 }),
      { cache }
    );

    await service.refresh();
    expect(service.getRelayUrls()).toEqual([
      'wss://learned.example.org',
      'wss://config-seed.example.org',
    ]);
  });

  it('ignores stale cache entries (older than the max age)', async () => {
    const cache = new MemoryCacheStore();
    cache.entries = [
      {
        relayUrl: 'wss://stale.example.org',
        verifiedAt: new Date(NOW - DEFAULT_CACHE_MAX_AGE_MS - 1).toISOString(),
        source: 'registry',
      },
      {
        relayUrl: 'wss://fresh.example.org',
        verifiedAt: new Date(NOW - DEFAULT_CACHE_MAX_AGE_MS + 60_000).toISOString(),
        source: 'registry',
      },
    ];
    const { service } = makeService(baseConfig({ sampleSize: 1 }), { cache });

    await service.refresh();
    expect(service.getRelayUrls()).toEqual(['wss://fresh.example.org']);
  });

  it('survives a failing cache store (load and save) without aborting the refresh', async () => {
    const cache = new MemoryCacheStore();
    cache.failLoad = true;
    cache.failSave = true;
    const { service } = makeService(
      baseConfig({ seeds: [{ relayUrl: 'wss://seed.example.org' }], sampleSize: 1 }),
      { cache }
    );

    await expect(service.refresh()).resolves.toBeUndefined();
    expect(service.getRelayUrls()).toEqual(['wss://seed.example.org']);
  });

  it('re-verification refreshes the cached timestamp (seeds stay refreshable data)', async () => {
    let clock = NOW;
    const cache = new MemoryCacheStore();
    const { service } = makeService(
      baseConfig({ seeds: [{ relayUrl: 'wss://seed.example.org' }], sampleSize: 1 }),
      { cache, now: () => clock }
    );

    await service.refresh();
    expect(cache.entries[0]?.verifiedAt).toBe(new Date(NOW).toISOString());

    clock = NOW + 5 * 60_000;
    await service.refresh();
    expect(cache.entries).toHaveLength(1);
    expect(cache.entries[0]?.verifiedAt).toBe(new Date(clock).toISOString());
  });
});

describe('BootstrapService — consumer surface + lifecycle (toon-meta#153)', () => {
  it('notifies onRelaysResolved listeners and supports unsubscribe', async () => {
    const { service } = makeService(
      baseConfig({ seeds: [{ relayUrl: 'wss://seed.example.org' }], sampleSize: 1 })
    );
    const seen: string[][] = [];
    const unsubscribe = service.onRelaysResolved((urls) => seen.push(urls));

    await service.refresh();
    expect(seen).toEqual([['wss://seed.example.org']]);

    unsubscribe();
    await service.refresh();
    expect(seen).toHaveLength(1);
  });

  it('a throwing listener never breaks the refresh or other listeners', async () => {
    const { service } = makeService(
      baseConfig({ seeds: [{ relayUrl: 'wss://seed.example.org' }], sampleSize: 1 })
    );
    const seen: string[][] = [];
    service.onRelaysResolved(() => {
      throw new Error('listener boom');
    });
    service.onRelaysResolved((urls) => seen.push(urls));

    await expect(service.refresh()).resolves.toBeUndefined();
    expect(seen).toEqual([['wss://seed.example.org']]);
  });

  it('start() is a no-op when bootstrap is disabled', () => {
    const probe = scriptedProbe();
    const { service } = makeService(baseConfig({ enabled: false }), { probe });
    service.start();
    expect(service.running).toBe(false);
    expect(probe.probed).toHaveLength(0);
    service.stop();
  });

  it('start() refreshes immediately, re-refreshes on the interval, and stop() halts it', async () => {
    jest.useFakeTimers();
    const probe = scriptedProbe();
    const { service } = makeService(
      baseConfig({
        seeds: [{ relayUrl: 'wss://seed.example.org' }],
        sampleSize: 1,
        refreshIntervalSecs: 60,
      }),
      { probe }
    );

    service.start();
    expect(service.running).toBe(true);
    await jest.advanceTimersByTimeAsync(0); // flush the boot refresh
    expect(probe.probed).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(probe.probed).toHaveLength(2);

    service.stop();
    expect(service.running).toBe(false);
    await jest.advanceTimersByTimeAsync(180_000);
    expect(probe.probed).toHaveLength(2);
    // Idempotent stop.
    service.stop();
  });

  it('coalesces concurrent refresh() calls onto one in-flight resolution', async () => {
    let probeCalls = 0;
    let release: (() => void) | null = null;
    const probe: RelayProbeFn = async () => {
      probeCalls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true };
    };
    const { service } = makeService(
      baseConfig({ seeds: [{ relayUrl: 'wss://seed.example.org' }], sampleSize: 1 }),
      { probe }
    );

    const first = service.refresh();
    const second = service.refresh();
    // Let the probe start, then release it.
    await Promise.resolve();
    while (release === null) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    (release as () => void)();
    await Promise.all([first, second]);
    expect(probeCalls).toBe(1);
  });
});
