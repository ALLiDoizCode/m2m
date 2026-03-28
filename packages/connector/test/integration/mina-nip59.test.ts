/**
 * Mina NIP-59 Wrapped Claim Round-Trip Tests
 *
 * Story 34.8: Validates that NIP-59 Gift Wrap encryption preserves Mina-specific
 * claim fields through the wrap/unwrap round-trip.
 *
 * Test IDs covered:
 * - T-34.8-05: NIP-59 wrapped claim round-trip preserves Mina fields
 *
 * @packageDocumentation
 */

import { randomBytes } from 'crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import pino from 'pino';
import {
  NIP59ClaimWrapper,
  BTP_WRAPPED_CLAIM_PROTOCOL,
} from '../../src/settlement/privacy/nip59-claim-wrapper';
import type { WrappedClaim } from '../../src/settlement/privacy/nip59-claim-wrapper';
import type { MinaClaimMessage } from '../../src/btp/btp-claim-types';
import { isMinaClaim } from '../../src/btp/btp-claim-types';

jest.setTimeout(60_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createTestLogger = (): pino.Logger => pino({ level: 'silent' });

function createValidMinaClaim(): MinaClaimMessage {
  return {
    version: '1.0',
    blockchain: 'mina',
    messageId: 'claim-mina-nip59-001',
    timestamp: '2026-03-28T12:00:00.000Z',
    senderId: 'peer-mina-alice',
    zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
    tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
    balanceCommitment: '12345678901234567890123456789012345678901234567890',
    nonce: 7,
    proof: 'eyJwcm9vZiI6InRlc3QifQ==',
    salt: 'abcdef1234567890',
    network: 'devnet',
  };
}

// ---------------------------------------------------------------------------
// T-34.8-05: NIP-59 Wrapped Claim Round-Trip (AC 5)
// ---------------------------------------------------------------------------

describe('Mina NIP-59 Wrapped Claim Round-Trip (Story 34.8)', () => {
  let logger: pino.Logger;
  let senderPrivKey: Uint8Array;
  let receiverPrivKey: Uint8Array;
  let receiverPubKey: Uint8Array;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = createTestLogger();

    // Generate keypairs for sender and receiver
    senderPrivKey = randomBytes(32);
    receiverPrivKey = randomBytes(32);
    receiverPubKey = secp256k1.getPublicKey(receiverPrivKey, true);
  });

  describe('[T-34.8-05] NIP-59: wrapped claim round-trip preserves Mina fields', () => {
    it('should wrap and unwrap a MinaClaimMessage preserving all fields', () => {
      // Given: NIP-59 wrapping enabled
      const wrapper = new NIP59ClaimWrapper({ nip59Enabled: true, logger });
      const originalClaim = createValidMinaClaim();

      // When: the claim is wrapped
      const wrapped = wrapper.wrapClaim(originalClaim, senderPrivKey, receiverPubKey);

      // Then: the wrapped output is encrypted (not null)
      expect(wrapped).not.toBeNull();
      const wrappedClaim = wrapped as WrappedClaim;

      // And: the wrapped output contains only ephemeral key + ciphertext
      expect(wrappedClaim.ephemeralPublicKey).toBeDefined();
      expect(typeof wrappedClaim.ephemeralPublicKey).toBe('string');
      expect(wrappedClaim.ephemeralPublicKey.length).toBeGreaterThan(0);
      expect(wrappedClaim.encryptedPayload).toBeDefined();
      expect(typeof wrappedClaim.encryptedPayload).toBe('string');
      expect(wrappedClaim.encryptedPayload.length).toBeGreaterThan(0);
      expect(wrappedClaim.version).toBe('1.0');
      expect(typeof wrappedClaim.timestamp).toBe('number');

      // When: the claim is unwrapped
      const unwrapped = wrapper.unwrapClaim(wrappedClaim, receiverPrivKey);

      // Then: the unwrapped claim matches the original MinaClaimMessage exactly
      expect(unwrapped.version).toBe(originalClaim.version);
      expect(unwrapped.blockchain).toBe(originalClaim.blockchain);
      expect(unwrapped.messageId).toBe(originalClaim.messageId);
      expect(unwrapped.timestamp).toBe(originalClaim.timestamp);
      expect(unwrapped.senderId).toBe(originalClaim.senderId);

      // And: Mina-specific fields are preserved
      expect(isMinaClaim(unwrapped)).toBe(true);
      if (isMinaClaim(unwrapped)) {
        expect(unwrapped.zkAppAddress).toBe(originalClaim.zkAppAddress);
        expect(unwrapped.tokenId).toBe(originalClaim.tokenId);
        expect(unwrapped.balanceCommitment).toBe(originalClaim.balanceCommitment);
        expect(unwrapped.nonce).toBe(originalClaim.nonce);
        expect(unwrapped.proof).toBe(originalClaim.proof);
        expect(unwrapped.salt).toBe(originalClaim.salt);
        expect(unwrapped.network).toBe(originalClaim.network);
      }
    });

    it('should preserve the zk proof field (base64 integrity) after round-trip', () => {
      // Given: a claim with a specific base64-encoded proof
      const wrapper = new NIP59ClaimWrapper({ nip59Enabled: true, logger });
      const originalClaim = createValidMinaClaim();
      const originalProof = originalClaim.proof;

      // Verify it is valid base64
      const decodedBefore = Buffer.from(originalProof, 'base64').toString('utf8');
      expect(decodedBefore).toBe('{"proof":"test"}');

      // When: wrapped and unwrapped
      const wrapped = wrapper.wrapClaim(originalClaim, senderPrivKey, receiverPubKey);
      expect(wrapped).not.toBeNull();
      const unwrapped = wrapper.unwrapClaim(wrapped!, receiverPrivKey);

      // Then: proof field is identical byte-for-byte
      expect(isMinaClaim(unwrapped)).toBe(true);
      if (isMinaClaim(unwrapped)) {
        expect(unwrapped.proof).toBe(originalProof);
        // And: base64 decoding produces the same result
        const decodedAfter = Buffer.from(unwrapped.proof, 'base64').toString('utf8');
        expect(decodedAfter).toBe(decodedBefore);
      }
    });

    it('should use correct protocol constants for wrapped claims', () => {
      // Then: protocol constants match NIP-59 specification
      expect(BTP_WRAPPED_CLAIM_PROTOCOL.NAME).toBe('claim-wrapped');
      expect(BTP_WRAPPED_CLAIM_PROTOCOL.CONTENT_TYPE).toBe(0); // APPLICATION_OCTET_STREAM
      expect(BTP_WRAPPED_CLAIM_PROTOCOL.VERSION).toBe('1.0');
    });

    it('should return null when nip59Enabled is false (passthrough)', () => {
      // Given: NIP-59 wrapping disabled
      const wrapper = new NIP59ClaimWrapper({ nip59Enabled: false, logger });
      const claim = createValidMinaClaim();

      // When: wrapClaim is called
      const result = wrapper.wrapClaim(claim, senderPrivKey, receiverPubKey);

      // Then: returns null (passthrough mode)
      expect(result).toBeNull();
    });

    it('should fail to unwrap with the wrong receiver private key', () => {
      // Given: a wrapped claim
      const wrapper = new NIP59ClaimWrapper({ nip59Enabled: true, logger });
      const claim = createValidMinaClaim();
      const wrapped = wrapper.wrapClaim(claim, senderPrivKey, receiverPubKey);
      expect(wrapped).not.toBeNull();

      // When: unwrapping with a different private key
      const wrongPrivKey = randomBytes(32);

      // Then: unwrapping fails
      expect(() => {
        wrapper.unwrapClaim(wrapped!, wrongPrivKey);
      }).toThrow();
    });

    it('should produce different ciphertexts for identical claims (non-deterministic)', () => {
      // Given: the same claim wrapped twice
      const wrapper = new NIP59ClaimWrapper({ nip59Enabled: true, logger });
      const claim = createValidMinaClaim();

      const wrapped1 = wrapper.wrapClaim(claim, senderPrivKey, receiverPubKey);
      const wrapped2 = wrapper.wrapClaim(claim, senderPrivKey, receiverPubKey);

      expect(wrapped1).not.toBeNull();
      expect(wrapped2).not.toBeNull();

      // Then: encrypted payloads are different (due to ephemeral keys and random nonces)
      expect(wrapped1!.encryptedPayload).not.toBe(wrapped2!.encryptedPayload);
      expect(wrapped1!.ephemeralPublicKey).not.toBe(wrapped2!.ephemeralPublicKey);
    });
  });
});
