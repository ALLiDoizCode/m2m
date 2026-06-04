import pino from 'pino';
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getBase58Decoder,
} from '@solana/kit';
import {
  resolveSolanaSigner,
  resolveMinaSignerKey,
} from '../../src/settlement/provider/signer-resolution';

const logger = pino({ level: 'silent' });

/**
 * Generate a real (mock-free) Ed25519 keypair via WebCrypto with extractable keys,
 * exporting it as base58 in both the 64-byte secret-key encoding (seed || public)
 * and the 32-byte seed encoding. The expected Solana address is derived from the
 * same seed so each encoding can be asserted against a single ground-truth address.
 */
async function generateBase58Keys(): Promise<{ full64: string; seed32: string; address: string }> {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  if (!('privateKey' in keyPair)) {
    throw new Error('expected a CryptoKeyPair');
  }

  // Ed25519 PKCS#8 wraps the 32-byte seed in a fixed prefix; take the trailing 32 bytes.
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const seed = pkcs8.slice(pkcs8.length - 32);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));

  const full = new Uint8Array(64);
  full.set(seed, 0);
  full.set(publicKey, 32);

  // Ground-truth address derived from the seed via the same SDK the resolver uses.
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);

  const decoder = getBase58Decoder();
  return {
    full64: decoder.decode(full),
    seed32: decoder.decode(seed),
    address: signer.address,
  };
}

describe('resolveSolanaSigner', () => {
  const originalEnv = process.env.SOLANA_PRIVATE_KEY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SOLANA_PRIVATE_KEY;
    } else {
      process.env.SOLANA_PRIVATE_KEY = originalEnv;
    }
  });

  it('resolves a 64-byte base58 secret key to a KeyPairSigner with a defined address', async () => {
    const { full64, address } = await generateBase58Keys();
    const signer = await resolveSolanaSigner(full64, logger);
    expect(signer.address).toBeDefined();
    expect(signer.address).toBe(address);
  });

  it('resolves a 32-byte base58 seed to a KeyPairSigner with a defined address', async () => {
    const { seed32, address } = await generateBase58Keys();
    const signer = await resolveSolanaSigner(seed32, logger);
    expect(signer.address).toBeDefined();
    expect(signer.address).toBe(address);
  });

  it('falls back to SOLANA_PRIVATE_KEY when keyId is undefined', async () => {
    const { full64, address } = await generateBase58Keys();
    process.env.SOLANA_PRIVATE_KEY = full64;
    const signer = await resolveSolanaSigner(undefined, logger);
    expect(signer.address).toBe(address);
  });

  it('throws a descriptive error when no key is available', async () => {
    delete process.env.SOLANA_PRIVATE_KEY;
    await expect(resolveSolanaSigner(undefined, logger)).rejects.toThrow(
      'No Solana settlement key'
    );
  });

  it('throws when the decoded key has an unexpected length', async () => {
    // Base58 of a 4-byte payload (neither 32 nor 64 bytes).
    const shortKey = getBase58Decoder().decode(new Uint8Array([1, 2, 3, 4]));
    await expect(resolveSolanaSigner(shortKey, logger)).rejects.toThrow(/expected 32 or 64/);
  });

  it('round-trips via createKeyPairSignerFromBytes', async () => {
    const { full64, address } = await generateBase58Keys();
    const bytes = Uint8Array.from(
      // re-decode using encoder path used by the resolver
      (await import('@solana/kit')).getBase58Encoder().encode(full64)
    );
    const direct = await createKeyPairSignerFromBytes(bytes);
    expect(direct.address).toBe(address);
  });
});

describe('resolveMinaSignerKey', () => {
  const originalEnv = process.env.MINA_PRIVATE_KEY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MINA_PRIVATE_KEY;
    } else {
      process.env.MINA_PRIVATE_KEY = originalEnv;
    }
  });

  it('returns the keyId verbatim', () => {
    expect(resolveMinaSignerKey('EKE_some_base58_mina_private_key')).toBe(
      'EKE_some_base58_mina_private_key'
    );
  });

  it('falls back to MINA_PRIVATE_KEY when keyId is undefined', () => {
    process.env.MINA_PRIVATE_KEY = 'EKE_env_key';
    expect(resolveMinaSignerKey(undefined)).toBe('EKE_env_key');
  });

  it('throws a descriptive error when no key is available', () => {
    delete process.env.MINA_PRIVATE_KEY;
    expect(() => resolveMinaSignerKey(undefined)).toThrow('No Mina settlement key');
  });
});
