#!/usr/bin/env node
/**
 * Sign (or re-sign / rotate) the curated bootstrap seed-registry manifest
 * (toon-meta#153, connector#343).
 *
 * Reads the manifest payload from an existing relays.json (default:
 * infra/linode-node/seeds/relays.json), refreshes `updatedAt`, signs the
 * whole document with the curator secret key via `signSeedManifest()`
 * (BIP-340 schnorr over sha256(canonicalJson(payload))), self-verifies with
 * `verifySeedManifest()`, and writes the signed manifest back.
 *
 * The curator SECRET key is read at runtime from ~/.toon-curator/ and is
 * NEVER printed or committed. Only the derived public key goes to stdout.
 *
 * Usage:
 *   npm run build --workspace=packages/connector   # dist/ must exist
 *   node scripts/sign-seed-manifest.mjs [options]
 *
 * Options:
 *   --manifest <path>   manifest to (re)sign      (default: infra/linode-node/seeds/relays.json)
 *   --key <path>        curator secret key file   (default: ~/.toon-curator/devnet-curator.key)
 *   --keep-date         do not refresh updatedAt
 *
 * To rotate the curator key: generate a new BIP-340 keypair into
 * ~/.toon-curator/, run this script with --key, update
 * FALLBACK_CURATOR_PUBKEY in packages/connector/src/discovery/bootstrap-seeds.ts
 * to the new public key, and republish the manifest wherever
 * `bootstrap.registryUrl` serves it.
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(repoRoot, 'package.json'));

const args = process.argv.slice(2);
function argValue(flag) {
  const index = args.indexOf(flag);
  return index !== -1 ? args[index + 1] : undefined;
}

const manifestPath = resolve(
  repoRoot,
  argValue('--manifest') ?? 'infra/linode-node/seeds/relays.json'
);
const keyPath = argValue('--key') ?? join(homedir(), '.toon-curator', 'devnet-curator.key');
const keepDate = args.includes('--keep-date');

// The signing/verification implementation is the connector's own — no
// parallel crypto here. Requires a prior `npm run build --workspace=packages/connector`.
let manifestLib;
try {
  manifestLib = require(join(repoRoot, 'packages/connector/dist/discovery/bootstrap-manifest.js'));
} catch (err) {
  console.error(
    'Could not load the built connector. Run: npm run build --workspace=packages/connector'
  );
  console.error(String(err));
  process.exit(1);
}
const { parseSeedManifest, signSeedManifest, verifySeedManifest } = manifestLib;
const { schnorr } = require('@noble/curves/secp256k1');
const { bytesToHex, hexToBytes } = require('@noble/hashes/utils');

// --- Load the curator secret (never printed). Refuse group/world-readable keys.
const keyMode = statSync(keyPath).mode & 0o077;
if (keyMode !== 0) {
  console.error(`Refusing to use ${keyPath}: permissions too open (chmod 600 it).`);
  process.exit(1);
}
const secretHex = readFileSync(keyPath, 'utf8').trim();
if (!/^[0-9a-f]{64}$/.test(secretHex)) {
  console.error(`Key file ${keyPath} is not 64-char lowercase hex.`);
  process.exit(1);
}
const secretKey = hexToBytes(secretHex);
const publicKey = bytesToHex(schnorr.getPublicKey(secretKey));

// --- Load the payload from the existing manifest (sig, if any, is discarded).
const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
const parsed = parseSeedManifest({ ...raw, sig: raw.sig ?? '0'.repeat(128) });
if (!parsed.ok) {
  console.error(`Manifest ${manifestPath} is structurally invalid: ${parsed.error}`);
  process.exit(1);
}
const payload = {
  version: parsed.manifest.version,
  updatedAt: keepDate ? parsed.manifest.updatedAt : new Date().toISOString(),
  entries: parsed.manifest.entries,
  // Informational only — the verifier always uses the pinned key, never this field.
  curatorPubkey: publicKey,
};

// --- Sign, self-verify, write.
const signed = signSeedManifest(payload, secretKey);
if (!verifySeedManifest(signed, publicKey)) {
  console.error('Self-verification failed after signing — aborting, manifest not written.');
  process.exit(1);
}
writeFileSync(manifestPath, `${JSON.stringify(signed, null, 2)}\n`);

console.log(`Signed manifest written: ${manifestPath}`);
console.log(`  version:   ${signed.version}`);
console.log(`  updatedAt: ${signed.updatedAt}`);
console.log(`  entries:   ${signed.entries.map((entry) => entry.relayUrl).join(', ')}`);
console.log(`  curator public key: ${publicKey}`);
