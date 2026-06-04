/**
 * Settlement signer resolution for non-EVM chains.
 *
 * Mirrors the EVM key contract: a chainProvider's `keyId` config field holds the
 * **raw base58 private key** (not a key-management identifier). When `keyId` is
 * absent, the resolver falls back to a chain-specific environment variable:
 * - Solana: `SOLANA_PRIVATE_KEY`
 * - Mina:   `MINA_PRIVATE_KEY`
 *
 * Chain SDKs are lazy-imported via `requireOptional` so that nodes which do not
 * settle on a given chain incur no hard dependency, matching the `ethers` pattern
 * used by the EVM backend.
 *
 * @module signer-resolution
 */

import { requireOptional } from '../../utils/optional-require';

/**
 * Resolve a Solana settlement signer from a raw base58 private key.
 *
 * Source key: `keyId ?? process.env.SOLANA_PRIVATE_KEY`. The base58 string is
 * decoded to bytes using `@solana/kit`'s base58 codec (no `bs58` dependency). A
 * 64-byte payload is treated as a full keypair; a 32-byte payload is treated as a
 * private-key seed.
 *
 * @param keyId - Raw base58 private key from config, or undefined to use the env fallback
 * @param logger - Pino logger instance
 * @returns A resolved `KeyPairSigner`
 * @throws Error if no key resolves or the decoded byte length is unexpected
 */
export async function resolveSolanaSigner(
  keyId: string | undefined,
  logger: import('pino').Logger
): Promise<import('@solana/kit').KeyPairSigner> {
  const key = keyId ?? process.env.SOLANA_PRIVATE_KEY;
  if (!key) {
    throw new Error('No Solana settlement key: set chainProviders[].keyId or SOLANA_PRIVATE_KEY');
  }

  const { getBase58Encoder, createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes } =
    await requireOptional<typeof import('@solana/kit')>('@solana/kit', 'Solana settlement');

  const bytes = Uint8Array.from(getBase58Encoder().encode(key));

  let signer: import('@solana/kit').KeyPairSigner;
  if (bytes.length === 64) {
    signer = await createKeyPairSignerFromBytes(bytes);
  } else if (bytes.length === 32) {
    signer = await createKeyPairSignerFromPrivateKeyBytes(bytes);
  } else {
    throw new Error(
      `Invalid Solana settlement key: decoded to ${bytes.length} bytes (expected 32 or 64)`
    );
  }

  logger.info({ address: signer.address }, 'Solana settlement signer resolved');
  return signer;
}

/**
 * Resolve a Mina settlement signer key from a raw base58 private key.
 *
 * Source key: `keyId ?? process.env.MINA_PRIVATE_KEY`. The key is returned
 * verbatim — the Mina SDK parses the base58 string when constructing a signer.
 *
 * @param keyId - Raw base58 private key from config, or undefined to use the env fallback
 * @returns The raw base58 private key string
 * @throws Error if no key resolves
 */
export function resolveMinaSignerKey(keyId: string | undefined): string {
  const key = keyId ?? process.env.MINA_PRIVATE_KEY;
  if (!key) {
    throw new Error('No Mina settlement key: set chainProviders[].keyId or MINA_PRIVATE_KEY');
  }
  return key;
}
