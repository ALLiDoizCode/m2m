/**
 * Tests for the curated signed seed-registry manifest (toon-meta#153).
 *
 * Covers: canonical JSON determinism, sign→verify round trip, tamper and
 * wrong-key rejection, structural parsing of untrusted documents, the
 * "unknown extra fields are stripped before hashing" normalization contract,
 * and that the COMMITTED devnet registry manifest verifies against the
 * shipped pinned fallback curator key (connector#343).
 *
 * Real schnorr signatures via `@noble/curves` (no crypto mocks).
 *
 * @module discovery/bootstrap-manifest.test
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { FALLBACK_CURATOR_PUBKEY, FALLBACK_RELAY_SEEDS } from './bootstrap-seeds';
import {
  canonicalJson,
  manifestDigest,
  parseSeedManifest,
  signSeedManifest,
  verifySeedManifest,
  type SeedManifestPayload,
} from './bootstrap-manifest';

const curatorSecret = schnorr.utils.randomPrivateKey();
const curatorPubkey = bytesToHex(schnorr.getPublicKey(curatorSecret));
const otherSecret = schnorr.utils.randomPrivateKey();
const otherPubkey = bytesToHex(schnorr.getPublicKey(otherSecret));

function payload(): SeedManifestPayload {
  return {
    version: 1,
    updatedAt: '2026-07-16T00:00:00Z',
    entries: [
      { relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev' },
      { relayUrl: 'wss://relay-2.example.org', pubkey: 'a'.repeat(64) },
    ],
  };
}

describe('canonicalJson (toon-meta#153)', () => {
  it('sorts object keys recursively and is insertion-order independent', () => {
    const a = { b: 2, a: { z: [1, 2], y: 'x' } };
    const b = { a: { y: 'x', z: [1, 2] }, b: 2 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"y":"x","z":[1,2]},"b":2}');
  });

  it('drops undefined members and preserves array order', () => {
    expect(canonicalJson({ a: undefined, b: [3, 1] })).toBe('{"b":[3,1]}');
  });
});

describe('signSeedManifest / verifySeedManifest (toon-meta#153)', () => {
  it('accepts a manifest signed by the pinned curator key', () => {
    const manifest = signSeedManifest(payload(), curatorSecret);
    expect(manifest.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifySeedManifest(manifest, curatorPubkey)).toBe(true);
  });

  it('rejects a manifest whose entries were tampered with after signing', () => {
    const manifest = signSeedManifest(payload(), curatorSecret);
    const tampered = {
      ...manifest,
      entries: [...manifest.entries, { relayUrl: 'wss://evil.example.org' }],
    };
    expect(verifySeedManifest(tampered, curatorPubkey)).toBe(false);
  });

  it('rejects a manifest signed by a different (unpinned) key', () => {
    const manifest = signSeedManifest(payload(), otherSecret);
    expect(verifySeedManifest(manifest, curatorPubkey)).toBe(false);
    // Sanity: it does verify under the key that actually signed it.
    expect(verifySeedManifest(manifest, otherPubkey)).toBe(true);
  });

  it('rejects malformed signature or pinned-key hex without throwing', () => {
    const manifest = signSeedManifest(payload(), curatorSecret);
    expect(verifySeedManifest({ ...manifest, sig: 'zz'.repeat(64) }, curatorPubkey)).toBe(false);
    expect(verifySeedManifest(manifest, 'not-a-key')).toBe(false);
    expect(verifySeedManifest(manifest, '00'.repeat(32))).toBe(false);
  });

  it('covers the optional curatorPubkey field with the signature', () => {
    const withCurator = signSeedManifest({ ...payload(), curatorPubkey }, curatorSecret);
    expect(verifySeedManifest(withCurator, curatorPubkey)).toBe(true);
    // Stripping the signed field breaks verification.
    const withoutField = { ...withCurator };
    delete withoutField.curatorPubkey;
    expect(verifySeedManifest(withoutField, curatorPubkey)).toBe(false);
  });
});

describe('parseSeedManifest (toon-meta#153)', () => {
  it('round-trips a signed manifest through JSON and still verifies', () => {
    const manifest = signSeedManifest(payload(), curatorSecret);
    const parsed = parseSeedManifest(JSON.parse(JSON.stringify(manifest)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(verifySeedManifest(parsed.manifest, curatorPubkey)).toBe(true);
      expect(parsed.manifest.entries).toHaveLength(2);
    }
  });

  it('strips unrecognized extra fields, keeping verification stable', () => {
    const manifest = signSeedManifest(payload(), curatorSecret);
    const withExtras = { ...manifest, banner: 'ignore-me', entries: manifest.entries };
    const parsed = parseSeedManifest(withExtras);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect('banner' in parsed.manifest).toBe(false);
      expect(verifySeedManifest(parsed.manifest, curatorPubkey)).toBe(true);
    }
  });

  it.each([
    ['non-object', 'nope'],
    ['null', null],
    ['missing version', { updatedAt: 'x', entries: [], sig: '0'.repeat(128) }],
    ['zero version', { version: 0, updatedAt: 'x', entries: [], sig: '0'.repeat(128) }],
    ['missing updatedAt', { version: 1, entries: [], sig: '0'.repeat(128) }],
    ['non-array entries', { version: 1, updatedAt: 'x', entries: {}, sig: '0'.repeat(128) }],
    [
      'http entry relayUrl',
      {
        version: 1,
        updatedAt: 'x',
        entries: [{ relayUrl: 'https://not-ws.example.org' }],
        sig: '0'.repeat(128),
      },
    ],
    [
      'bad entry pubkey',
      {
        version: 1,
        updatedAt: 'x',
        entries: [{ relayUrl: 'wss://r.example.org', pubkey: 'XYZ' }],
        sig: '0'.repeat(128),
      },
    ],
    ['missing sig', { version: 1, updatedAt: 'x', entries: [] }],
    ['short sig', { version: 1, updatedAt: 'x', entries: [], sig: 'abcd' }],
    [
      'bad curatorPubkey',
      { version: 1, updatedAt: 'x', entries: [], curatorPubkey: '123', sig: '0'.repeat(128) },
    ],
  ])('rejects a malformed manifest: %s', (_label, doc) => {
    const parsed = parseSeedManifest(doc);
    expect(parsed.ok).toBe(false);
  });

  it('digest is stable across key insertion order (canonical payload)', () => {
    const base = payload();
    const reordered = {
      entries: base.entries.map((entry) => ({ ...entry })),
      updatedAt: base.updatedAt,
      version: base.version,
    } as SeedManifestPayload;
    expect(bytesToHex(manifestDigest(base))).toBe(bytesToHex(manifestDigest(reordered)));
  });
});

describe('committed devnet registry manifest (connector#343)', () => {
  const manifestPath = join(__dirname, '../../../../infra/linode-node/seeds/relays.json');

  it('the committed relays.json parses and verifies against FALLBACK_CURATOR_PUBKEY', () => {
    const raw: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const parsed = parseSeedManifest(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    // The committed artifact must be genuinely signed by the shipped pinned
    // key — the exact check `BootstrapService` performs with default config.
    expect(verifySeedManifest(parsed.manifest, FALLBACK_CURATOR_PUBKEY)).toBe(true);
    expect(parsed.manifest.version).toBe(1);
    expect(parsed.manifest.entries.length).toBeGreaterThan(0);
    // The registry and the hardcoded fallback tier agree on the devnet seed.
    expect(parsed.manifest.entries.map((entry) => entry.relayUrl)).toEqual(
      FALLBACK_RELAY_SEEDS.map((seed) => seed.relayUrl)
    );
  });

  it('tampering with the committed manifest breaks verification', () => {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const tampered = {
      ...raw,
      entries: [{ relayUrl: 'wss://evil.example.org' }],
    };
    const parsed = parseSeedManifest(tampered);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(verifySeedManifest(parsed.manifest, FALLBACK_CURATOR_PUBKEY)).toBe(false);
    }
  });
});
