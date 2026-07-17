/**
 * Curated signed seed-registry manifest (toon-meta#153).
 *
 * The bootstrap registry is a small HTTPS-hosted JSON document listing
 * well-known relay seeds, signed AS A WHOLE by a curator key pinned in the
 * connector's config (or the hardcoded fallback). Whole-manifest signature was
 * chosen over per-entry signatures for v0 simplicity: one schnorr verify, one
 * canonical payload, no partial-trust states.
 *
 * Signature scheme: BIP-340 schnorr (the same curve/scheme as Nostr event
 * signatures, via `@noble/curves` already in the dependency tree) over
 * `sha256(canonicalJson(manifest minus "sig"))`. Canonical JSON is
 * `JSON.stringify` with recursively sorted object keys and only the
 * RECOGNIZED manifest fields (`version`, `updatedAt`, `entries[].relayUrl`,
 * `entries[].pubkey`, `curatorPubkey`) — unrecognized fields are stripped
 * before hashing, so curators must sign exactly the normalized shape.
 *
 * This makes seeds REFRESHABLE DATA, not frozen config — the design answer to
 * connector#289 (a stale committed genesis-peer seed).
 *
 * @module discovery/bootstrap-manifest
 */

import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { RelaySeed } from './bootstrap-seeds';

/** 64-char lowercase hex (schnorr x-only pubkey / sha256 digest). */
const HEX_64 = /^[0-9a-f]{64}$/;
/** 128-char lowercase hex (64-byte schnorr signature). */
const HEX_128 = /^[0-9a-f]{128}$/;
/** Relay seed URL scheme (ws:// allowed for local dev). */
const WS_URL = /^wss?:\/\/.+/;

/** The unsigned manifest payload — everything the curator signature covers. */
export interface SeedManifestPayload {
  /** Manifest schema version. Currently `1`. */
  version: number;
  /** ISO-8601 timestamp of the last curation update. */
  updatedAt: string;
  /** Curated relay seeds. */
  entries: RelaySeed[];
  /**
   * OPTIONAL, informational curator pubkey embedded in the manifest. The
   * verifier NEVER trusts this field for verification — the pinned key from
   * config (or the hardcoded fallback) is always used. Covered by the
   * signature when present.
   */
  curatorPubkey?: string;
}

/** A signed seed-registry manifest as fetched from `bootstrap.registryUrl`. */
export interface SeedManifest extends SeedManifestPayload {
  /**
   * BIP-340 schnorr signature (128-char lowercase hex) over
   * `sha256(canonicalJson(payload))` where payload is the manifest minus this
   * field, normalized to recognized fields only.
   */
  sig: string;
}

/** Result of structurally parsing an untrusted manifest document. */
export type SeedManifestParseResult =
  | { ok: true; manifest: SeedManifest }
  | { ok: false; error: string };

/**
 * Deterministic JSON serialization: recursively sorts object keys, drops
 * `undefined` members, and otherwise matches `JSON.stringify`. Arrays keep
 * their order. This is the byte-exact payload encoding the curator signs.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const out = JSON.stringify(value);
    if (out === undefined) {
      throw new Error(`Value is not JSON-serializable: ${String(value)}`);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const members = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(',')}}`;
}

/**
 * Normalize an untrusted payload to EXACTLY the recognized signed fields, so
 * canonicalization is stable regardless of extra fields riding along.
 */
function normalizePayload(payload: SeedManifestPayload): SeedManifestPayload {
  const normalized: SeedManifestPayload = {
    version: payload.version,
    updatedAt: payload.updatedAt,
    entries: payload.entries.map((entry) =>
      entry.pubkey !== undefined
        ? { relayUrl: entry.relayUrl, pubkey: entry.pubkey }
        : { relayUrl: entry.relayUrl }
    ),
  };
  if (payload.curatorPubkey !== undefined) {
    normalized.curatorPubkey = payload.curatorPubkey;
  }
  return normalized;
}

/** sha256 digest of the canonical JSON encoding of the (normalized) payload. */
export function manifestDigest(payload: SeedManifestPayload): Uint8Array {
  return sha256(new TextEncoder().encode(canonicalJson(normalizePayload(payload))));
}

/**
 * Sign a manifest payload with the curator secret key (32 bytes), producing a
 * complete signed manifest. Exported for tests and curation tooling.
 */
export function signSeedManifest(
  payload: SeedManifestPayload,
  curatorSecretKey: Uint8Array
): SeedManifest {
  const normalized = normalizePayload(payload);
  const sig = bytesToHex(schnorr.sign(manifestDigest(normalized), curatorSecretKey));
  return { ...normalized, sig };
}

/**
 * Verify a manifest's whole-document schnorr signature against the PINNED
 * curator pubkey (64-char lowercase hex). Never throws — any malformed input
 * or crypto error is a verification failure.
 */
export function verifySeedManifest(manifest: SeedManifest, curatorPubkeyHex: string): boolean {
  if (!HEX_64.test(curatorPubkeyHex) || !HEX_128.test(manifest.sig)) {
    return false;
  }
  try {
    return schnorr.verify(
      hexToBytes(manifest.sig),
      manifestDigest(manifest),
      hexToBytes(curatorPubkeyHex)
    );
  } catch {
    return false;
  }
}

/**
 * Structurally parse an untrusted JSON document into a `SeedManifest`,
 * normalizing to recognized fields only. Signature is NOT checked here — call
 * {@link verifySeedManifest} on the result.
 */
export function parseSeedManifest(raw: unknown): SeedManifestParseResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'manifest must be a JSON object' };
  }
  const doc = raw as Record<string, unknown>;

  if (typeof doc.version !== 'number' || !Number.isInteger(doc.version) || doc.version < 1) {
    return { ok: false, error: 'manifest.version must be a positive integer' };
  }
  if (typeof doc.updatedAt !== 'string' || doc.updatedAt.trim() === '') {
    return { ok: false, error: 'manifest.updatedAt must be a non-empty string' };
  }
  if (!Array.isArray(doc.entries)) {
    return { ok: false, error: 'manifest.entries must be an array' };
  }
  const entries: RelaySeed[] = [];
  for (const [index, rawEntry] of doc.entries.entries()) {
    if (rawEntry === null || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      return { ok: false, error: `manifest.entries[${index}] must be an object` };
    }
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.relayUrl !== 'string' || !WS_URL.test(entry.relayUrl)) {
      return {
        ok: false,
        error: `manifest.entries[${index}].relayUrl must be a ws:// or wss:// URL`,
      };
    }
    if (
      entry.pubkey !== undefined &&
      (typeof entry.pubkey !== 'string' || !HEX_64.test(entry.pubkey))
    ) {
      return {
        ok: false,
        error: `manifest.entries[${index}].pubkey must be 64-char lowercase hex`,
      };
    }
    entries.push(
      entry.pubkey !== undefined
        ? { relayUrl: entry.relayUrl, pubkey: entry.pubkey as string }
        : { relayUrl: entry.relayUrl }
    );
  }
  if (
    doc.curatorPubkey !== undefined &&
    (typeof doc.curatorPubkey !== 'string' || !HEX_64.test(doc.curatorPubkey))
  ) {
    return { ok: false, error: 'manifest.curatorPubkey must be 64-char lowercase hex' };
  }
  if (typeof doc.sig !== 'string' || !HEX_128.test(doc.sig)) {
    return { ok: false, error: 'manifest.sig must be 128-char lowercase hex' };
  }

  const manifest: SeedManifest = {
    version: doc.version,
    updatedAt: doc.updatedAt,
    entries,
    sig: doc.sig,
  };
  if (doc.curatorPubkey !== undefined) {
    manifest.curatorPubkey = doc.curatorPubkey as string;
  }
  return { ok: true, manifest };
}
