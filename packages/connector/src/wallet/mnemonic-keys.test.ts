/**
 * Coherence tests for canonical multi-chain mnemonic key derivation.
 *
 * The connector's `deriveChainKeysFromMnemonic` replicates the three derivation
 * paths of `@toon-protocol/sdk`'s `fromMnemonicFull(mnemonic, { accountIndex })`
 * (rather than depending on the SDK — see `mnemonic-keys.ts` for why). These
 * tests pin the derived EVM/Solana/Mina addresses to the EXACT values
 * `fromMnemonicFull` produces for the same fixed mnemonic, guaranteeing that a
 * client computing keys via `deriveFullIdentity` and the connector deriving its
 * settlement keys agree byte-for-byte.
 *
 * Oracle values were captured by running `@toon-protocol/sdk`'s
 * `fromMnemonicFull` against the fixed mnemonic below for accountIndex 0 and 1.
 * The Mina assertion derives the B62… public key from the connector's base58
 * `EK…` private key via `mina-signer` and compares it to the SDK's Mina pubkey,
 * verifying the full hex→clamp→base58check pipeline end to end.
 */

import { deriveChainKeysFromMnemonic } from './mnemonic-keys';

// The canonical Anvil/Hardhat dev mnemonic — a stable, well-known fixed BIP-39
// phrase. NOT a production secret; used purely as a derivation oracle.
const FIXED_MNEMONIC = 'test test test test test test test test test test test junk';

// Verified outputs of `@toon-protocol/sdk` fromMnemonicFull(FIXED_MNEMONIC, { accountIndex }).
const ORACLE = {
  0: {
    evmAddress: '0xc9ab3656993E8d8a13dbbCf656d6D338eF6DeD3f',
    solanaAddress: 'oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96',
    minaPublicKey: 'B62qrttSARHJCobNymsJAmKgJeqvmX63xTGLdby4baoxE1GqaedaAAS',
  },
  1: {
    evmAddress: '0x7c8D76F0B42a586838524d9Ed8e80c1fe104F675',
    solanaAddress: 'AqynRZwvVqUPRwRJXvm6odUb3t93fDjnWe3p6BeuUFxD',
    minaPublicKey: 'B62qpTaURzwFb1bhssf4vKairEXEVFMeuKqHCv3YZf9uiVWLKE9hajJ',
  },
} as const;

/**
 * Derive the Mina B62 public key from a base58 `EK…` private key using
 * mina-signer (an optional connector dep, present in the dev/test tree).
 */
async function minaPublicKeyFromEk(ek: string): Promise<string> {
  const mod = (await import('mina-signer')) as unknown as {
    default?: new (cfg: { network: string }) => {
      derivePublicKey(privateKey: string): string;
    };
  };
  const Client =
    mod.default ??
    (mod as unknown as new (cfg: { network: string }) => {
      derivePublicKey(privateKey: string): string;
    });
  const client = new Client({ network: 'mainnet' });
  return client.derivePublicKey(ek);
}

describe('deriveChainKeysFromMnemonic (coherence with @toon-protocol/sdk fromMnemonicFull)', () => {
  it('derives the canonical EVM address (accountIndex 0)', () => {
    const keys = deriveChainKeysFromMnemonic(FIXED_MNEMONIC, 0);
    expect(keys.evm.address).toBe(ORACLE[0].evmAddress);
    // The injected keyId is a 0x-prefixed 32-byte hex private key (ethers Wallet form).
    expect(keys.evm.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('derives the canonical Solana address (accountIndex 0)', () => {
    const keys = deriveChainKeysFromMnemonic(FIXED_MNEMONIC, 0);
    expect(keys.solana.address).toBe(ORACLE[0].solanaAddress);
    // The injected keyId is a base58 64-byte keypair (resolveSolanaSigner form).
    expect(keys.solana.privateKey.length).toBeGreaterThan(40);
  });

  it('derives the canonical Mina key whose B62 public key matches the SDK (accountIndex 0)', async () => {
    const keys = deriveChainKeysFromMnemonic(FIXED_MNEMONIC, 0);
    // The injected keyId is a Mina base58check EK… private key.
    expect(keys.mina.privateKey).toMatch(/^EK/);
    const minaPub = await minaPublicKeyFromEk(keys.mina.privateKey);
    expect(minaPub).toBe(ORACLE[0].minaPublicKey);
  });

  it('varies all three chains by accountIndex (1) and matches the SDK', async () => {
    const keys = deriveChainKeysFromMnemonic(FIXED_MNEMONIC, 1);
    expect(keys.evm.address).toBe(ORACLE[1].evmAddress);
    expect(keys.solana.address).toBe(ORACLE[1].solanaAddress);
    const minaPub = await minaPublicKeyFromEk(keys.mina.privateKey);
    expect(minaPub).toBe(ORACLE[1].minaPublicKey);
  });

  it('is deterministic for a given mnemonic + index', () => {
    const a = deriveChainKeysFromMnemonic(FIXED_MNEMONIC, 0);
    const b = deriveChainKeysFromMnemonic(FIXED_MNEMONIC, 0);
    expect(a).toEqual(b);
  });

  it('rejects an invalid mnemonic', () => {
    expect(() => deriveChainKeysFromMnemonic('not a valid mnemonic phrase', 0)).toThrow(
      /Invalid TOON_MNEMONIC/
    );
  });

  it('rejects an out-of-range accountIndex', () => {
    expect(() => deriveChainKeysFromMnemonic(FIXED_MNEMONIC, -1)).toThrow(/accountIndex/);
  });
});
