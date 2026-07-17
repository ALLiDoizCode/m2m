/**
 * Learned-peer (relay seed) cache for cold-start bootstrap (toon-meta#153).
 *
 * Every relay that survives sample-and-verify is persisted here with a
 * `verifiedAt` timestamp, so the NEXT cold start can bootstrap from what the
 * node actually learned — ahead of static config and the hardcoded fallback,
 * but behind a fresh signed registry (see `BootstrapService` resolution
 * order). Staleness filtering lives in the service, not the store.
 *
 * Why a small JSON file instead of a `RegistryStore` (SQLite) table? The
 * bootstrap cache must be readable on a COLD node before any heavier
 * subsystem is up, `RegistryStore` is itself optional (it degrades to nothing
 * when `libsql` is unavailable — bootstrap must not inherit that failure
 * mode), the payload is a handful of URLs, and a flat human-inspectable file
 * makes "seeds are refreshable data, not frozen config" (connector#289)
 * operationally obvious: an operator can read or delete it. Acceptable for
 * v0 per the epic; a store-backed implementation can slot in behind
 * {@link BootstrapCacheStore} later.
 *
 * @module discovery/bootstrap-cache
 */

import { promises as fsPromises } from 'fs';
import * as path from 'path';
import type { Logger } from 'pino';
import type { RelaySeed } from './bootstrap-seeds';

/** Which resolution tier a cached seed was learned from. */
export type RelaySeedSource = 'registry' | 'cache' | 'config' | 'fallback';

/** A relay seed that passed sample-and-verify, with provenance + timestamp. */
export interface CachedRelaySeed extends RelaySeed {
  /** ISO-8601 timestamp of the last successful probe verification. */
  verifiedAt: string;
  /** Resolution tier the seed came from when it was last verified. */
  source: RelaySeedSource;
}

/**
 * Persistence seam for the learned relay cache. Injected into
 * `BootstrapService` so tests use an in-memory fake and a future
 * store-backed implementation can share the real probe pipeline.
 */
export interface BootstrapCacheStore {
  /** Load all cached entries. Never throws for "no cache yet". */
  load(): Promise<CachedRelaySeed[]>;
  /** Replace the cache contents atomically. */
  save(entries: CachedRelaySeed[]): Promise<void>;
}

/** On-disk cache document shape. */
interface BootstrapCacheFile {
  version: 1;
  entries: CachedRelaySeed[];
}

const CACHE_FILE_VERSION = 1;

/**
 * JSON-file `BootstrapCacheStore` (default path:
 * `./data/bootstrap-cache-<nodeId>.json` under the connector's data dir).
 *
 * Load is forgiving: a missing, unreadable, or structurally corrupt file
 * yields `[]` (cold start proceeds down the resolution chain). Save is
 * atomic: write to a `.tmp` sibling, then rename over the target.
 */
export class FileBootstrapCacheStore implements BootstrapCacheStore {
  private readonly _filePath: string;
  private readonly _logger: Logger;

  constructor(filePath: string, logger: Logger) {
    this._filePath = filePath;
    this._logger = logger.child({ component: 'FileBootstrapCacheStore' });
  }

  /** The cache file path (exposed for logging/tests). */
  get filePath(): string {
    return this._filePath;
  }

  async load(): Promise<CachedRelaySeed[]> {
    let text: string;
    try {
      text = await fsPromises.readFile(this._filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this._logger.warn(
          { event: 'bootstrap_cache_read_failed', path: this._filePath, err: errMsg(err) },
          'Failed to read bootstrap relay cache; treating as empty'
        );
      }
      return [];
    }

    try {
      const doc = JSON.parse(text) as Partial<BootstrapCacheFile>;
      if (doc.version !== CACHE_FILE_VERSION || !Array.isArray(doc.entries)) {
        this._logger.warn(
          { event: 'bootstrap_cache_invalid', path: this._filePath },
          'Bootstrap relay cache has an unexpected shape; treating as empty'
        );
        return [];
      }
      return doc.entries.filter(isValidCachedSeed);
    } catch (err) {
      this._logger.warn(
        { event: 'bootstrap_cache_corrupt', path: this._filePath, err: errMsg(err) },
        'Bootstrap relay cache is not valid JSON; treating as empty'
      );
      return [];
    }
  }

  async save(entries: CachedRelaySeed[]): Promise<void> {
    const doc: BootstrapCacheFile = { version: CACHE_FILE_VERSION, entries };
    const tmpPath = `${this._filePath}.tmp`;
    await fsPromises.mkdir(path.dirname(this._filePath), { recursive: true });
    await fsPromises.writeFile(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    await fsPromises.rename(tmpPath, this._filePath);
  }
}

/** Structural guard for one cached entry (tolerates hand-edited files). */
function isValidCachedSeed(entry: unknown): entry is CachedRelaySeed {
  if (entry === null || typeof entry !== 'object') {
    return false;
  }
  const record = entry as Record<string, unknown>;
  return (
    typeof record.relayUrl === 'string' &&
    /^wss?:\/\/.+/.test(record.relayUrl) &&
    typeof record.verifiedAt === 'string' &&
    !Number.isNaN(Date.parse(record.verifiedAt)) &&
    (record.source === 'registry' ||
      record.source === 'cache' ||
      record.source === 'config' ||
      record.source === 'fallback') &&
    (record.pubkey === undefined || typeof record.pubkey === 'string')
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
