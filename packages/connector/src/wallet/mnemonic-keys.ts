/**
 * Canonical multi-chain key derivation from a single BIP-39 mnemonic.
 *
 * This module replicates — byte-for-byte — the derivation performed by
 * `@toon-protocol/sdk`'s `fromMnemonicFull(mnemonic, { accountIndex })`, so the
 * connector's settlement keys match what any TOON client computes from the same
 * seed phrase via `deriveFullIdentity`. The three chains use the canonical
 * NIP-06 / SLIP-0010 / Mina paths:
 *
 * - **EVM** (secp256k1): `m/44'/1237'/0'/0/{accountIndex}` — the NIP-06 path
 *   (shared with the Nostr identity); the EVM address is Keccak-256 of the
 *   uncompressed public key. The connector consumes the **raw 0x-hex private
 *   key** (ethers `new Wallet(...)`).
 * - **Solana** (Ed25519): `m/44'/501'/{accountIndex}'/0'` via SLIP-0010
 *   (hardened-only). The connector consumes a **base58 64-byte keypair**
 *   (priv‖pub), which `resolveSolanaSigner` decodes.
 * - **Mina** (Pallas): `m/44'/12586'/{accountIndex}'/0/0` via BIP-32 secp256k1,
 *   then the top two bits of the big-endian scalar are clamped
 *   (`keyBytes[0] &= 0x3f`) to keep it inside the Pallas base-field order, and
 *   converted to the Mina base58check (`EK…`) private-key form mina-signer /
 *   the Mina SDK require. The connector consumes that **base58 EK… string**.
 *
 * Why replicate instead of depending on `@toon-protocol/sdk`?
 * The published SDK pulls a heavy, settlement-irrelevant transitive tree
 * (`@ardrive/turbo-sdk`, `arweave`, `simple-git`, `@toon-protocol/core`) and is
 * pinned to `@noble/*` v2, which conflicts with the connector's v1. It also
 * declares an optional peer dep on `@toon-protocol/connector`, which collides
 * with this repo's own `@toon-protocol/*` workspace namespace and made npm drop
 * a large part of the install tree. Replicating just the three derivation paths
 * with the primitives the connector already ships (`@scure/bip32`,
 * `@scure/bip39`, `@noble/curves`, `@noble/hashes`) is the correct, verified
 * fallback. A unit test asserts these derived addresses equal `fromMnemonicFull`
 * output exactly, so the single-source-of-truth guarantee is preserved.
 *
 * SECURITY: this module never logs the mnemonic or any derived private key, and
 * best-effort zeroes intermediate seed material. Callers must keep derived keys
 * out of logs, config files, and disk.
 *
 * @module mnemonic-keys
 */

import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

/** Maximum valid BIP-32 non-hardened child index (2^31 - 1). */
const MAX_BIP32_INDEX = 0x7fffffff;

/**
 * Per-chain settlement keys derived from a mnemonic, in the exact string forms
 * the connector's `chainProviders[].keyId` slots expect.
 */
export interface DerivedChainKeys {
  /** EVM raw private key, 0x-prefixed hex (consumed by ethers `Wallet`). */
  readonly evm: {
    /** 0x-prefixed 32-byte private key hex. */
    readonly privateKey: string;
    /** EIP-55 checksummed address (for logging/advertisement, never the key). */
    readonly address: string;
  };
  /** Solana base58 64-byte keypair (consumed by `resolveSolanaSigner`). */
  readonly solana: {
    /** Base58-encoded 64-byte keypair (priv‖pub). */
    readonly privateKey: string;
    /** Base58 Ed25519 public key (Solana address). */
    readonly address: string;
  };
  /** Mina base58check (`EK…`) private key (consumed by the Mina SDK). */
  readonly mina: {
    /** Mina base58check `EK…` private key. */
    readonly privateKey: string;
  };
}

/**
 * Derive the connector's EVM + Solana + Mina settlement keys from a single
 * BIP-39 mnemonic, matching `@toon-protocol/sdk`'s `fromMnemonicFull` exactly.
 *
 * @param mnemonic - A valid BIP-39 mnemonic (12 or 24 words).
 * @param accountIndex - NIP-06 / SLIP-0010 account index (default 0).
 * @returns The per-chain keys in `chainProviders[].keyId` string forms.
 * @throws Error if the mnemonic is invalid or the accountIndex is out of range.
 */
export function deriveChainKeysFromMnemonic(mnemonic: string, accountIndex = 0): DerivedChainKeys {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error(
      'Invalid TOON_MNEMONIC: the provided words do not form a valid BIP-39 mnemonic phrase'
    );
  }
  if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex > MAX_BIP32_INDEX) {
    throw new Error(
      `Invalid mnemonic accountIndex: expected a non-negative integer (0 to ${MAX_BIP32_INDEX}), got ${String(
        accountIndex
      )}`
    );
  }

  let seed: Uint8Array | undefined;
  try {
    seed = mnemonicToSeedSync(mnemonic);

    return {
      evm: deriveEvm(seed, accountIndex),
      solana: deriveSolana(seed, accountIndex),
      mina: deriveMina(seed, accountIndex),
    };
  } finally {
    // Best-effort zeroing of the seed to limit the window during which
    // sensitive material remains in memory (JS has no secure-erase primitive).
    if (seed) {
      seed.fill(0);
    }
  }
}

// ---------------------------------------------------------------------------
// EVM (secp256k1, NIP-06 path)
// ---------------------------------------------------------------------------

function deriveEvm(seed: Uint8Array, accountIndex: number): DerivedChainKeys['evm'] {
  const path = `m/44'/1237'/0'/0/${accountIndex}`;
  const hdKey = HDKey.fromMasterSeed(seed).derive(path);
  if (!hdKey.privateKey) {
    throw new Error(`Failed to derive EVM private key at path ${path}`);
  }
  const privateKey = `0x${bytesToHex(hdKey.privateKey)}`;
  const address = computeEvmAddress(hdKey.privateKey);
  return { privateKey, address };
}

function computeEvmAddress(secretKey: Uint8Array): string {
  // Uncompressed public key (65 bytes: 0x04 prefix + 64 bytes X,Y)
  const uncompressed = secp256k1.getPublicKey(secretKey, false);
  const hash = keccak_256(uncompressed.slice(1));
  const addressHex = bytesToHex(hash.slice(-20));
  return toChecksumAddress(addressHex);
}

function toChecksumAddress(addressHex: string): string {
  const lower = addressHex.toLowerCase();
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const char = lower[i] as string;
    const hashChar = hash[i] as string;
    out += parseInt(hashChar, 16) >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Solana (Ed25519, SLIP-0010 hardened-only path)
// ---------------------------------------------------------------------------

function deriveSolana(seed: Uint8Array, accountIndex: number): DerivedChainKeys['solana'] {
  const privateKey = slip0010Derive(seed, [
    0x8000002c, // 44'
    0x800001f5, // 501'
    (0x80000000 + accountIndex) >>> 0, // {accountIndex}'
    0x80000000, // 0'
  ]);
  const publicKey = ed25519.getPublicKey(privateKey);

  // Solana keypair = 32-byte private key ‖ 32-byte public key = 64 bytes
  const keypair = new Uint8Array(64);
  keypair.set(privateKey, 0);
  keypair.set(publicKey, 32);

  return {
    privateKey: base58Encode(keypair),
    address: base58Encode(publicKey),
  };
}

/**
 * SLIP-0010 Ed25519 hardened-only derivation. Master key is
 * HMAC-SHA512("ed25519 seed", seed); each hardened child hashes
 * `0x00 ‖ key ‖ index_be32` under the chain code.
 */
function slip0010Derive(seed: Uint8Array, path: number[]): Uint8Array {
  const encoder = new TextEncoder();
  let I = hmac(sha512, encoder.encode('ed25519 seed'), seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);

  for (const index of path) {
    const data = new Uint8Array(37);
    data[0] = 0x00;
    data.set(key, 1);
    data[33] = (index >>> 24) & 0xff;
    data[34] = (index >>> 16) & 0xff;
    data[35] = (index >>> 8) & 0xff;
    data[36] = index & 0xff;

    I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }

  return key;
}

// ---------------------------------------------------------------------------
// Mina (Pallas, BIP-32 secp256k1 path + clamp + base58check encode)
// ---------------------------------------------------------------------------

function deriveMina(seed: Uint8Array, accountIndex: number): DerivedChainKeys['mina'] {
  const path = `m/44'/12586'/${accountIndex}'/0/0`;
  const hdKey = HDKey.fromMasterSeed(seed).derive(path);
  if (!hdKey.privateKey) {
    throw new Error(`Failed to derive Mina private key at path ${path}`);
  }

  const keyBytes = new Uint8Array(hdKey.privateKey);
  // Clamp the top 2 bits so the big-endian scalar is within the Pallas
  // base-field order (a raw BIP-32 child scalar can exceed it). Matches the
  // SDK/client/swap derivation so all produce the SAME Mina key.
  keyBytes[0] = (keyBytes[0] ?? 0) & 0x3f;
  const hexKey = bytesToHex(keyBytes);

  return { privateKey: hexToMinaBase58PrivateKey(hexKey) };
}

/**
 * Mina private-key version byte for the base58check (`EK…`) encoding mina-signer
 * expects, followed by a `0x01` non-zero tag, the 32-byte field scalar in
 * LITTLE-ENDIAN order, then a 4-byte double-sha256 checksum.
 *
 * Mirrors `@toon-protocol/core`'s `hexToMinaBase58PrivateKey`.
 */
const MINA_PRIVATE_KEY_VERSION = 0x5a;

/**
 * Convert a big-endian 32-byte hex scalar into the Mina base58check (`EK…`)
 * private-key string the Mina SDK / mina-signer require. If the input already
 * looks like a base58 `EK…` key it is returned unchanged.
 */
function hexToMinaBase58PrivateKey(privateKey: string): string {
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
    return privateKey;
  }
  const beScalar = hexToBytes(privateKey.replace(/^0x/, ''));
  const leScalar = Uint8Array.from(beScalar).reverse();
  const payload = concatBytes(Uint8Array.from([MINA_PRIVATE_KEY_VERSION, 0x01]), leScalar);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return base58Encode(concatBytes(payload, checksum));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 encode (Bitcoin/Solana alphabet). */
function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) zeros++;

  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }

  let result = '';
  while (value > 0n) {
    result = (BASE58_ALPHABET[Number(value % 58n)] as string) + result;
    value = value / 58n;
  }

  for (let i = 0; i < zeros; i++) {
    result = '1' + result;
  }

  return result || '1';
}
