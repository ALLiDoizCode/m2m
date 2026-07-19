/**
 * Golden-vector tests for the v2 EIP-712 claim verify helper (Phase 4a of
 * connector#329). These pin the exact byte contract of the published
 * `@toon-protocol/settlement-digest` leaf's RollingSwapChannel v2 digest and
 * secp256k1 recovery, so any drift in the leaf (or the noble ^2 coexistence
 * install) trips a red test.
 *
 * The signer is Hardhat/Anvil account #0
 * (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266); the signature below was produced
 * by signing the v2 claim digest with that account's well-known private key.
 */

import {
  recoverEVMClaimV2Signer,
  verifyEVMClaimV2,
  normalizeSignature65,
  type EVMClaimV2Params,
} from './eip712-v2-verifier';
import { balanceProofHashEvm, hexToBytes } from '@toon-protocol/settlement-digest';

/** Golden v2 claim vector. */
const GOLDEN_CLAIM: EVMClaimV2Params = {
  channelId: '0x' + '00'.repeat(31) + '5b', // 32 bytes, value 91
  cumulativeAmount: 24000000,
  nonce: 24,
  recipient: '0x' + '00'.repeat(16) + 'deadbeef', // 20 bytes ending 0xDEADBEEF
  chainId: 8453, // Base mainnet
  verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
};

/** keccak256 v2 claim digest for GOLDEN_CLAIM. */
const GOLDEN_DIGEST = '0x8e0b1e0baf4cb5490d8d8ebcad0c51feec55adff992680c21cbf137a4434fede';

/** 65-byte r||s||v signature over GOLDEN_DIGEST by the golden signer. */
const GOLDEN_SIGNATURE =
  '0xfa66a50c60bdd47c11b4b6a76f44255095d77cead2910b619d3b8e838237982b' +
  '196b22bc46254ff3e85923d0604bf7de9136d0ba79cfe85a3f38d636b262c9bb1b';

/** Expected signer — Hardhat account #0 (checksum form). */
const GOLDEN_SIGNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

function bytesToHex(b: Uint8Array): string {
  return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

describe('eip712-v2-verifier (Phase 4a — RollingSwapChannel v2)', () => {
  describe('v2 claim digest (leaf contract)', () => {
    it('reproduces the golden v2 claim digest from the plain params', () => {
      const digest = balanceProofHashEvm(
        hexToBytes(GOLDEN_CLAIM.channelId.slice(2)),
        BigInt(GOLDEN_CLAIM.cumulativeAmount),
        BigInt(GOLDEN_CLAIM.nonce),
        hexToBytes(GOLDEN_CLAIM.recipient.slice(2)),
        BigInt(GOLDEN_CLAIM.chainId),
        hexToBytes(GOLDEN_CLAIM.verifyingContract.slice(2))
      );
      expect(bytesToHex(digest)).toBe(GOLDEN_DIGEST);
    });
  });

  describe('recoverEVMClaimV2Signer', () => {
    it('recovers the golden signer round-trip (hex signature)', () => {
      const recovered = recoverEVMClaimV2Signer(GOLDEN_CLAIM, GOLDEN_SIGNATURE);
      expect(recovered).toBe(GOLDEN_SIGNER.toLowerCase());
    });

    it('recovers the golden signer from a raw Uint8Array signature', () => {
      const sigBytes = hexToBytes(GOLDEN_SIGNATURE.slice(2));
      const recovered = recoverEVMClaimV2Signer(GOLDEN_CLAIM, sigBytes);
      expect(recovered).toBe(GOLDEN_SIGNER.toLowerCase());
    });

    it('recovers a DIFFERENT address if any field is tampered (domain binding)', () => {
      const tampered: EVMClaimV2Params = { ...GOLDEN_CLAIM, cumulativeAmount: 24000001 };
      const recovered = recoverEVMClaimV2Signer(tampered, GOLDEN_SIGNATURE);
      expect(recovered).not.toBe(GOLDEN_SIGNER.toLowerCase());
    });

    it('recovers a DIFFERENT address on a different chainId (v2 chain binding)', () => {
      const otherChain: EVMClaimV2Params = { ...GOLDEN_CLAIM, chainId: 1 };
      const recovered = recoverEVMClaimV2Signer(otherChain, GOLDEN_SIGNATURE);
      expect(recovered).not.toBe(GOLDEN_SIGNER.toLowerCase());
    });

    it('recovers a DIFFERENT address on a different verifyingContract (v2 contract binding)', () => {
      const otherContract: EVMClaimV2Params = {
        ...GOLDEN_CLAIM,
        verifyingContract: '0x0000000000000000000000000000000000000001',
      };
      const recovered = recoverEVMClaimV2Signer(otherContract, GOLDEN_SIGNATURE);
      expect(recovered).not.toBe(GOLDEN_SIGNER.toLowerCase());
    });
  });

  describe('verifyEVMClaimV2', () => {
    it('returns valid:true for the golden signer (checksum address)', () => {
      const res = verifyEVMClaimV2(GOLDEN_CLAIM, GOLDEN_SIGNATURE, GOLDEN_SIGNER);
      expect(res.valid).toBe(true);
      expect(res.recovered).toBe(GOLDEN_SIGNER.toLowerCase());
    });

    it('returns valid:true when the expected address is lowercase (case-insensitive)', () => {
      const res = verifyEVMClaimV2(GOLDEN_CLAIM, GOLDEN_SIGNATURE, GOLDEN_SIGNER.toLowerCase());
      expect(res.valid).toBe(true);
    });

    it('returns valid:false for a wrong expected signer', () => {
      const res = verifyEVMClaimV2(
        GOLDEN_CLAIM,
        GOLDEN_SIGNATURE,
        '0x0000000000000000000000000000000000000000'
      );
      expect(res.valid).toBe(false);
      expect(res.recovered).toBe(GOLDEN_SIGNER.toLowerCase());
    });

    it('returns valid:false when the claim is tampered', () => {
      const tampered: EVMClaimV2Params = { ...GOLDEN_CLAIM, nonce: 25 };
      const res = verifyEVMClaimV2(tampered, GOLDEN_SIGNATURE, GOLDEN_SIGNER);
      expect(res.valid).toBe(false);
    });
  });

  describe('normalizeSignature65', () => {
    it('accepts a 0x-prefixed hex signature', () => {
      expect(normalizeSignature65(GOLDEN_SIGNATURE)).toHaveLength(65);
    });

    it('accepts an un-prefixed hex signature', () => {
      expect(normalizeSignature65(GOLDEN_SIGNATURE.slice(2))).toHaveLength(65);
    });

    it('passes a 65-byte Uint8Array through', () => {
      const b = hexToBytes(GOLDEN_SIGNATURE.slice(2));
      expect(normalizeSignature65(b)).toBe(b);
    });

    it('throws on a wrong-length signature', () => {
      expect(() => normalizeSignature65('0xdeadbeef')).toThrow(/expected 65 bytes/);
    });
  });
});
