/**
 * Tests for NIP59ClaimWrapper -- NIP-59-Inspired Claim Wrapping for Transport Privacy
 *
 * Covers:
 * - Three-layer wrapping: rumor -> seal -> gift wrap (T-34.6-01)
 * - Gift wrap uses ephemeral key, no sender identity (T-34.6-02)
 * - Seal decrypted with shared secret, reveals signed rumor (T-34.6-03)
 * - Rumor contains valid claim message (T-34.6-04)
 * - Each wrap uses fresh ephemeral key (T-34.6-05)
 * - Full round-trip correctness (T-34.6-06)
 * - Wrapped claim indistinguishable (T-34.6-07)
 * - NIP-59 disabled -> plaintext claim (T-34.6-08)
 * - NIP-59 enabled -> claim-wrapped protocol (T-34.6-09)
 * - Wrong private key -> graceful error (T-34.6-10)
 * - Wrapping overhead measurement (T-34.6-11)
 * - Gift wrap timestamp is randomized (T-34.6-12)
 * - Malformed/truncated WrappedClaim -> graceful error (T-34.6-13)
 *
 * Epic 34 Story 34.6
 *
 * @module nip59-claim-wrapper.test
 */

import { randomBytes } from 'crypto';
import pino from 'pino';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import type {
  EVMClaimMessage,
  SolanaClaimMessage,
  MinaClaimMessage,
} from '../../btp/btp-claim-types';
import { validateClaimMessage } from '../../btp/btp-claim-types';

// Import from the not-yet-existing implementation module (TDD red phase).
// All tests will fail with "Cannot find module" until the implementation is created.
import {
  NIP59ClaimWrapper,
  NIP59TransportWrapper,
  NIP59WrapError,
  BTP_WRAPPED_CLAIM_PROTOCOL,
  serializeWrappedClaim,
  deserializeWrappedClaim,
} from './nip59-claim-wrapper';
import type { WrappedClaim } from './nip59-claim-wrapper';

// ---------------------------------------------------------------------------
// Test Keypairs -- generated fresh per test suite run
// ---------------------------------------------------------------------------

let senderPrivKey: Uint8Array;
let senderPubKey: Uint8Array;
let receiverPrivKey: Uint8Array;
let receiverPubKey: Uint8Array;
let wrongPrivKey: Uint8Array;

beforeAll(() => {
  senderPrivKey = randomBytes(32);
  senderPubKey = secp256k1.getPublicKey(senderPrivKey, true);
  receiverPrivKey = randomBytes(32);
  receiverPubKey = secp256k1.getPublicKey(receiverPrivKey, true);
  wrongPrivKey = randomBytes(32);
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Claim Fixtures -- chain-agnostic test coverage
// ---------------------------------------------------------------------------

function createEVMClaimFixture(): EVMClaimMessage {
  return {
    version: '2.0',
    blockchain: 'evm',
    messageId: `claim-evm-${Date.now()}`,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    senderId: 'peer-alice',
    channelId: '0x' + '1234567890abcdef'.repeat(4),
    nonce: 42,
    cumulativeAmount: '1000000000000000000',
    recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    signature: '0x' + 'ab'.repeat(65),
    signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    chainId: 8453,
    verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    tokenAddress: '0x' + 'ef'.repeat(20),
  };
}

function createSolanaClaimFixture(): SolanaClaimMessage {
  return {
    version: '1.0',
    blockchain: 'solana',
    messageId: `claim-sol-${Date.now()}`,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    senderId: 'peer-bob',
    programId: '11111111111111111111111111111111',
    channelAccount: '22222222222222222222222222222222',
    nonce: 7,
    transferredAmount: '5000000000',
    signature: Buffer.from('solana-sig-placeholder').toString('base64'),
    signerPublicKey: '33333333333333333333333333333333',
    cluster: 'devnet',
  };
}

function createMinaClaimFixture(): MinaClaimMessage {
  return {
    version: '1.0',
    blockchain: 'mina',
    messageId: `claim-mina-${Date.now()}`,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    senderId: 'peer-charlie',
    zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
    tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
    balanceCommitment: '12345678901234567890123456789012345678901234567890',
    nonce: 1,
    proof: 'eyJwcm9vZiI6InRlc3QifQ==',
    salt: 'abcdef1234567890',
    network: 'devnet',
  };
}

// ---------------------------------------------------------------------------
// Wrapper instance factory
// ---------------------------------------------------------------------------

function createWrapper(nip59Enabled = true): NIP59ClaimWrapper {
  const logger = pino({ level: 'silent' });
  return new NIP59ClaimWrapper({
    nip59Enabled,
    logger,
  });
}

/**
 * Helper: wrap a claim and assert the result is non-null (for enabled wrapper).
 */
function wrapClaimNonNull(
  wrapper: NIP59ClaimWrapper,
  claim: EVMClaimMessage | SolanaClaimMessage | MinaClaimMessage,
  senderKey: Uint8Array,
  receiverKey: Uint8Array
): WrappedClaim {
  const result = wrapper.wrapClaim(claim, senderKey, receiverKey);
  expect(result).not.toBeNull();
  return result!;
}

// ---------------------------------------------------------------------------
// T-34.6-01: Three-layer wrapping (rumor -> seal -> gift wrap)
// ---------------------------------------------------------------------------

describe('T-34.6-01: Three-layer wrapping', () => {
  test('claim is wrapped in three layers: rumor -> seal -> gift wrap', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    // Gift wrap layer must contain ephemeral public key, encrypted payload, timestamp, version
    expect(wrapped.ephemeralPublicKey).toBeDefined();
    expect(typeof wrapped.ephemeralPublicKey).toBe('string');
    expect(wrapped.encryptedPayload).toBeDefined();
    expect(typeof wrapped.encryptedPayload).toBe('string');
    expect(wrapped.timestamp).toBeDefined();
    expect(typeof wrapped.timestamp).toBe('number');
    expect(wrapped.version).toBe('1.0');
  });

  test('wrapped claim has valid WrappedClaim structure', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    // Verify the ephemeral public key is a valid compressed secp256k1 key (66 hex chars)
    expect(wrapped.ephemeralPublicKey).toMatch(/^[0-9a-f]{66}$/);

    // Verify encrypted payload is base64 encoded
    expect(() => Buffer.from(wrapped.encryptedPayload, 'base64')).not.toThrow();
    expect(wrapped.encryptedPayload.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// T-34.6-02: Gift wrap uses ephemeral key, no sender identity
// ---------------------------------------------------------------------------

describe('T-34.6-02: Gift wrap uses ephemeral key, no sender identity', () => {
  test('ephemeral public key in gift wrap is not the sender public key', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    const senderPubHex = Buffer.from(senderPubKey).toString('hex');
    expect(wrapped.ephemeralPublicKey).not.toBe(senderPubHex);
  });

  test('gift wrap layer does not contain sender identity in any field', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    // The serialized WrappedClaim should not contain the sender public key
    const serialized = JSON.stringify(wrapped);
    const senderPubHex = Buffer.from(senderPubKey).toString('hex');
    expect(serialized).not.toContain(senderPubHex);
  });
});

// ---------------------------------------------------------------------------
// T-34.6-03: Seal decrypted with shared secret, reveals signed rumor
// ---------------------------------------------------------------------------

describe('T-34.6-03: Seal layer verification', () => {
  test('unwrapping reveals sender identity after seal decryption', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const unwrapped = wrapper.unwrapClaim(wrapped, receiverPrivKey);

    // After successful unwrap, we have the original claim back
    // The seal layer verified the sender signature internally
    expect(unwrapped).toBeDefined();
    expect(unwrapped.senderId).toBe(claim.senderId);
  });
});

// ---------------------------------------------------------------------------
// T-34.6-04: Rumor contains valid claim message
// ---------------------------------------------------------------------------

describe('T-34.6-04: Rumor contains valid claim message', () => {
  test('unwrapped EVM claim passes validateClaimMessage', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const unwrapped = wrapper.unwrapClaim(wrapped, receiverPrivKey);

    // EVM claims have full validation support
    expect(() => validateClaimMessage(unwrapped)).not.toThrow();
    expect(unwrapped.blockchain).toBe('evm');
  });

  test('unwrapped Solana claim passes validateClaimMessage', () => {
    const wrapper = createWrapper();
    const claim = createSolanaClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const unwrapped = wrapper.unwrapClaim(wrapped, receiverPrivKey);

    expect(() => validateClaimMessage(unwrapped)).not.toThrow();
    expect(unwrapped.blockchain).toBe('solana');
  });

  test('unwrapped Mina claim matches original and passes validation (Story 34.7)', () => {
    const wrapper = createWrapper();
    const claim = createMinaClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const unwrapped = wrapper.unwrapClaim(wrapped, receiverPrivKey);

    // Story 34.7 added validateMinaClaim -- Mina validation now works
    expect(() => validateClaimMessage(unwrapped)).not.toThrow();
    expect(unwrapped).toEqual(claim);
    expect(unwrapped.blockchain).toBe('mina');
  });
});

// ---------------------------------------------------------------------------
// T-34.6-05: Each wrap uses fresh ephemeral key
// ---------------------------------------------------------------------------

describe('T-34.6-05: Fresh ephemeral key per wrapping', () => {
  test('two successive wraps of the same claim produce different ephemeral keys', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped1 = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const wrapped2 = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    expect(wrapped1.ephemeralPublicKey).not.toBe(wrapped2.ephemeralPublicKey);
  });

  test('two successive wraps produce different encrypted payloads', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped1 = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const wrapped2 = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    expect(wrapped1.encryptedPayload).not.toBe(wrapped2.encryptedPayload);
  });
});

// ---------------------------------------------------------------------------
// T-34.6-06: Full round-trip correctness
// ---------------------------------------------------------------------------

describe('T-34.6-06: Full round-trip correctness', () => {
  test('EVM claim: wrap -> unwrap matches original exactly', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const unwrapped = wrapper.unwrapClaim(wrapped, receiverPrivKey);

    expect(unwrapped).toEqual(claim);
  });

  test('Solana claim: wrap -> unwrap matches original exactly', () => {
    const wrapper = createWrapper();
    const claim = createSolanaClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const unwrapped = wrapper.unwrapClaim(wrapped, receiverPrivKey);

    expect(unwrapped).toEqual(claim);
  });

  test('Mina claim: wrap -> unwrap matches original exactly', () => {
    const wrapper = createWrapper();
    const claim = createMinaClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const unwrapped = wrapper.unwrapClaim(wrapped, receiverPrivKey);

    expect(unwrapped).toEqual(claim);
  });

  test('round-trip with serialization: wrap -> serialize -> deserialize -> unwrap', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const serialized = serializeWrappedClaim(wrapped);
    const deserialized = deserializeWrappedClaim(serialized);
    const unwrapped = wrapper.unwrapClaim(deserialized, receiverPrivKey);

    expect(unwrapped).toEqual(claim);
  });
});

// ---------------------------------------------------------------------------
// T-34.6-07: Wrapped claim indistinguishable (encrypted bytes + ephemeral key only)
// ---------------------------------------------------------------------------

describe('T-34.6-07: Wrapped claim indistinguishable', () => {
  test('wrapped claim does not contain any plaintext claim fields', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const serialized = JSON.stringify(wrapped);

    // None of the claim's plaintext fields should be visible
    expect(serialized).not.toContain(claim.messageId);
    expect(serialized).not.toContain(claim.senderId);
    expect(serialized).not.toContain(claim.channelId);
    expect(serialized).not.toContain(claim.signerAddress);
    expect(serialized).not.toContain(claim.cumulativeAmount);
  });

  test('wrapped claim only exposes ephemeralPublicKey, encryptedPayload, timestamp, version', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const keys = Object.keys(wrapped).sort();

    expect(keys).toEqual(['encryptedPayload', 'ephemeralPublicKey', 'timestamp', 'version']);
  });
});

// ---------------------------------------------------------------------------
// T-34.6-08: NIP-59 disabled -> plaintext claim
// ---------------------------------------------------------------------------

describe('T-34.6-08: NIP-59 disabled sends plaintext', () => {
  test('when nip59Enabled is false, wrapClaim returns null (passthrough)', () => {
    const wrapper = createWrapper(false);
    const claim = createEVMClaimFixture();

    const result = wrapper.wrapClaim(claim, senderPrivKey, receiverPubKey);

    expect(result).toBeNull();
  });

  test('when nip59Enabled is false, unwrapClaim is not needed', () => {
    const wrapper = createWrapper(false);

    // isEnabled should return false
    expect(wrapper.isEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-34.6-09: NIP-59 enabled -> claim-wrapped protocol
// ---------------------------------------------------------------------------

describe('T-34.6-09: NIP-59 enabled uses claim-wrapped protocol', () => {
  test('BTP_WRAPPED_CLAIM_PROTOCOL has correct constants', () => {
    expect(BTP_WRAPPED_CLAIM_PROTOCOL.NAME).toBe('claim-wrapped');
    expect(BTP_WRAPPED_CLAIM_PROTOCOL.CONTENT_TYPE).toBe(0); // APPLICATION_OCTET_STREAM
    expect(BTP_WRAPPED_CLAIM_PROTOCOL.VERSION).toBe('1.0');
  });

  test('when nip59Enabled is true, isEnabled returns true', () => {
    const wrapper = createWrapper(true);

    expect(wrapper.isEnabled()).toBe(true);
  });

  test('serializeWrappedClaim produces a Buffer', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();
    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    const serialized = serializeWrappedClaim(wrapped);

    expect(Buffer.isBuffer(serialized)).toBe(true);
    expect(serialized.length).toBeGreaterThan(0);
  });

  test('deserializeWrappedClaim recovers the WrappedClaim from Buffer', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();
    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    const serialized = serializeWrappedClaim(wrapped);
    const deserialized = deserializeWrappedClaim(serialized);

    expect(deserialized.ephemeralPublicKey).toBe(wrapped.ephemeralPublicKey);
    expect(deserialized.encryptedPayload).toBe(wrapped.encryptedPayload);
    expect(deserialized.timestamp).toBe(wrapped.timestamp);
    expect(deserialized.version).toBe(wrapped.version);
  });
});

// ---------------------------------------------------------------------------
// T-34.6-10: Wrong private key -> graceful error
// ---------------------------------------------------------------------------

describe('T-34.6-10: Wrong private key fails gracefully', () => {
  test('decryption with wrong private key throws NIP59WrapError', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    expect(() => wrapper.unwrapClaim(wrapped, wrongPrivKey)).toThrow(NIP59WrapError);
  });

  test('NIP59WrapError has descriptive message indicating which layer failed', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    try {
      wrapper.unwrapClaim(wrapped, wrongPrivKey);
      fail('Expected NIP59WrapError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NIP59WrapError);
      expect((err as NIP59WrapError).name).toBe('NIP59WrapError');
      expect((err as NIP59WrapError).message).toMatch(/gift.?wrap|seal|decrypt/i);
    }
  });

  test('NIP59WrapError preserves original error as cause', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    try {
      wrapper.unwrapClaim(wrapped, wrongPrivKey);
      fail('Expected NIP59WrapError to be thrown');
    } catch (err) {
      expect((err as NIP59WrapError).cause).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// T-34.6-11: Wrapping overhead measurement (advisory)
// ---------------------------------------------------------------------------

describe('T-34.6-11: Wrapping overhead measurement', () => {
  test('wrapped claim size is measured relative to plaintext (advisory)', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const plaintextSize = Buffer.byteLength(JSON.stringify(claim), 'utf8');

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const wrappedSize = Buffer.byteLength(JSON.stringify(wrapped), 'utf8');

    const overheadRatio = wrappedSize / plaintextSize;

    // Advisory: verify overhead is within expected bounds.
    // Typical NIP-59 wrapping adds ~2-4x overhead due to double encryption + keys + signatures
    expect(overheadRatio).toBeGreaterThan(1);
    // Sanity upper bound: wrapping should not exceed 10x overhead
    expect(overheadRatio).toBeLessThan(10);
  });
});

// ---------------------------------------------------------------------------
// T-34.6-12: Gift wrap timestamp is randomized
// ---------------------------------------------------------------------------

describe('T-34.6-12: Gift wrap timestamp randomization', () => {
  test('timestamp is within +-48 hours of actual send time', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();
    const beforeWrap = Date.now();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
    const diff = Math.abs(wrapped.timestamp - beforeWrap);
    expect(diff).toBeLessThanOrEqual(FORTY_EIGHT_HOURS_MS + 1000); // +1s tolerance for execution time
  });

  test('timestamp does not exactly equal actual send time (within 1s tolerance)', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    // Wrap multiple times and check at least one has a non-trivial offset
    const timestamps: number[] = [];
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
      timestamps.push(wrapped.timestamp);
    }

    // At least one timestamp should differ from "now" by more than 1 second
    const hasRandomized = timestamps.some((t) => Math.abs(t - now) > 1000);
    expect(hasRandomized).toBe(true);
  });

  test('wrapping same claim twice produces different timestamps', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped1 = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const wrapped2 = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    // With random offsets, timestamps should differ (statistically guaranteed)
    expect(wrapped1.timestamp).not.toBe(wrapped2.timestamp);
  });
});

// ---------------------------------------------------------------------------
// T-34.6-13: Malformed/truncated WrappedClaim -> graceful error
// ---------------------------------------------------------------------------

describe('T-34.6-13: Malformed WrappedClaim handling', () => {
  test('truncated encryptedPayload throws NIP59WrapError', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();
    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    // Truncate the encrypted payload
    const malformed: WrappedClaim = {
      ...wrapped,
      encryptedPayload: wrapped.encryptedPayload.slice(0, 10),
    };

    expect(() => wrapper.unwrapClaim(malformed, receiverPrivKey)).toThrow(NIP59WrapError);
  });

  test('invalid base64 in encryptedPayload throws NIP59WrapError', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();
    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    const malformed: WrappedClaim = {
      ...wrapped,
      encryptedPayload: '!!!not-valid-base64!!!',
    };

    expect(() => wrapper.unwrapClaim(malformed, receiverPrivKey)).toThrow(NIP59WrapError);
  });

  test('missing ephemeralPublicKey throws NIP59WrapError', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();
    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    const malformed = {
      ...wrapped,
      ephemeralPublicKey: '',
    } as WrappedClaim;

    expect(() => wrapper.unwrapClaim(malformed, receiverPrivKey)).toThrow(NIP59WrapError);
  });

  test('missing encryptedPayload throws NIP59WrapError', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();
    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    const malformed = {
      ...wrapped,
      encryptedPayload: '',
    } as WrappedClaim;

    expect(() => wrapper.unwrapClaim(malformed, receiverPrivKey)).toThrow(NIP59WrapError);
  });

  test('rumor with invalid JSON structure (not a BTPClaimMessage) throws NIP59WrapError', () => {
    // This tests the runtime validation of the unwrapped rumor payload.
    // We cannot easily inject a non-BTPClaimMessage through the encryption layers,
    // but we can verify the error class and message pattern for malformed inputs.
    const wrapper = createWrapper();

    const malformed: WrappedClaim = {
      ephemeralPublicKey: 'aa'.repeat(33),
      encryptedPayload: Buffer.from('not-real').toString('base64'),
      timestamp: Date.now(),
      version: '1.0',
    };

    expect(() => wrapper.unwrapClaim(malformed, receiverPrivKey)).toThrow(NIP59WrapError);
  });

  test('completely invalid object throws NIP59WrapError', () => {
    const wrapper = createWrapper();

    const malformed = {
      ephemeralPublicKey: 'not-a-valid-key',
      encryptedPayload: 'not-valid',
      timestamp: 0,
      version: '1.0' as const,
    };

    expect(() => wrapper.unwrapClaim(malformed, receiverPrivKey)).toThrow(NIP59WrapError);
  });

  test('deserializeWrappedClaim with garbage buffer throws NIP59WrapError', () => {
    const garbage = Buffer.from('this is not valid JSON');

    expect(() => deserializeWrappedClaim(garbage)).toThrow(NIP59WrapError);
  });
});

// ---------------------------------------------------------------------------
// Gap Coverage: AC 3 -- Seal layer tamper detection (Story 34.6)
// ---------------------------------------------------------------------------

describe('AC 3 gap: Seal layer tamper detection', () => {
  test('tampered encryptedPayload (bit-flip) is detected and throws NIP59WrapError', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    // Corrupt a byte in the middle of the encrypted payload
    const payloadBytes = Buffer.from(wrapped.encryptedPayload, 'base64');
    const midpoint = Math.floor(payloadBytes.length / 2);
    payloadBytes[midpoint] = (payloadBytes[midpoint]! ^ 0xff) & 0xff;

    const tampered: WrappedClaim = {
      ...wrapped,
      encryptedPayload: payloadBytes.toString('base64'),
    };

    expect(() => wrapper.unwrapClaim(tampered, receiverPrivKey)).toThrow(NIP59WrapError);
  });

  test('corrupted gift wrap nonce is detected and throws NIP59WrapError', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    // Corrupt the first few bytes (the nonce region) of the encrypted payload
    const payloadBytes = Buffer.from(wrapped.encryptedPayload, 'base64');
    payloadBytes[0] = (payloadBytes[0]! ^ 0xff) & 0xff;
    payloadBytes[1] = (payloadBytes[1]! ^ 0xff) & 0xff;

    const tampered: WrappedClaim = {
      ...wrapped,
      encryptedPayload: payloadBytes.toString('base64'),
    };

    expect(() => wrapper.unwrapClaim(tampered, receiverPrivKey)).toThrow(NIP59WrapError);
  });
});

// ---------------------------------------------------------------------------
// Gap Coverage: AC 6 -- No balance/blockchain info exposed (Story 34.6)
// ---------------------------------------------------------------------------

describe('AC 6 gap: No balance or blockchain info exposed to intermediary', () => {
  test('wrapped EVM claim does not expose blockchain discriminator', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const serialized = JSON.stringify(wrapped);

    // The blockchain field value should not appear in the outer wrapper
    expect(serialized).not.toContain('"evm"');
    // Balance information (cumulativeAmount is long enough to be a meaningful check)
    expect(serialized).not.toContain(claim.cumulativeAmount);
    // Channel ID and signer address should not be visible
    expect(serialized).not.toContain(claim.channelId);
    expect(serialized).not.toContain(claim.signerAddress);
  });

  test('wrapped Solana claim does not expose blockchain discriminator or amounts', () => {
    const wrapper = createWrapper();
    const claim = createSolanaClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const serialized = JSON.stringify(wrapped);

    expect(serialized).not.toContain('"solana"');
    expect(serialized).not.toContain(claim.transferredAmount);
    expect(serialized).not.toContain(claim.programId);
  });

  test('wrapped Mina claim does not expose blockchain discriminator or zkApp address', () => {
    const wrapper = createWrapper();
    const claim = createMinaClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const serialized = JSON.stringify(wrapped);

    expect(serialized).not.toContain('"mina"');
    expect(serialized).not.toContain(claim.zkAppAddress);
    expect(serialized).not.toContain(claim.proof);
  });

  test('receiver public key is not present in the wrapped claim', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const serialized = JSON.stringify(wrapped);

    const receiverPubHex = Buffer.from(receiverPubKey).toString('hex');
    expect(serialized).not.toContain(receiverPubHex);
  });
});

// ---------------------------------------------------------------------------
// Gap Coverage: AC 9 -- BTP protocolData framing round-trip (Story 34.6)
// ---------------------------------------------------------------------------

describe('AC 9 gap: BTP protocolData framing round-trip', () => {
  test('wrapped claim uses claim-wrapped protocol name with APPLICATION_OCTET_STREAM', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    // Simulate BTP protocolData framing
    const protocolData = {
      protocolName: BTP_WRAPPED_CLAIM_PROTOCOL.NAME,
      contentType: BTP_WRAPPED_CLAIM_PROTOCOL.CONTENT_TYPE,
      data: serializeWrappedClaim(wrapped),
    };

    expect(protocolData.protocolName).toBe('claim-wrapped');
    expect(protocolData.contentType).toBe(0); // APPLICATION_OCTET_STREAM

    // Receiver side: deserialize and unwrap
    const deserialized = deserializeWrappedClaim(protocolData.data);
    const unwrapped = wrapper.unwrapClaim(deserialized, receiverPrivKey);
    expect(unwrapped).toEqual(claim);
  });

  test('NIP-59 wrapped Mina claim uses claim-wrapped protocol with APPLICATION_OCTET_STREAM (AC 8, Story 34.7)', () => {
    const wrapper = createWrapper();
    const claim = createMinaClaimFixture();

    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);

    // Simulate BTP protocolData framing for wrapped Mina claim
    const protocolData = {
      protocolName: BTP_WRAPPED_CLAIM_PROTOCOL.NAME,
      contentType: BTP_WRAPPED_CLAIM_PROTOCOL.CONTENT_TYPE,
      data: serializeWrappedClaim(wrapped),
    };

    // Then: protocolName is 'claim-wrapped' with APPLICATION_OCTET_STREAM content type
    expect(protocolData.protocolName).toBe('claim-wrapped');
    expect(protocolData.contentType).toBe(0); // APPLICATION_OCTET_STREAM

    // And: receiver can deserialize and unwrap to get the original Mina claim
    const deserialized = deserializeWrappedClaim(protocolData.data);
    const unwrapped = wrapper.unwrapClaim(deserialized, receiverPrivKey);
    expect(unwrapped).toEqual(claim);
    expect(unwrapped.blockchain).toBe('mina');

    // And: the unwrapped Mina claim passes validation (Story 34.7)
    expect(() => validateClaimMessage(unwrapped)).not.toThrow();
  });

  test('full BTP round-trip with Solana claim through protocolData framing', () => {
    const wrapper = createWrapper();
    const claim = createSolanaClaimFixture();

    // Sender side
    const wrapped = wrapClaimNonNull(wrapper, claim, senderPrivKey, receiverPubKey);
    const btpData = serializeWrappedClaim(wrapped);

    // Simulate transit -- intermediary sees only a Buffer
    expect(Buffer.isBuffer(btpData)).toBe(true);

    // Receiver side
    const recovered = deserializeWrappedClaim(btpData);
    const unwrapped = wrapper.unwrapClaim(recovered, receiverPrivKey);
    expect(unwrapped).toEqual(claim);
  });
});

// ---------------------------------------------------------------------------
// Gap Coverage: AC 5 -- Disabled wrapper does not encrypt (Story 34.6)
// ---------------------------------------------------------------------------

describe('AC 5 gap: Disabled wrapper plaintext passthrough semantics', () => {
  test('disabled wrapper wrapClaim returns null for all blockchain types', () => {
    const wrapper = createWrapper(false);

    expect(wrapper.wrapClaim(createEVMClaimFixture(), senderPrivKey, receiverPubKey)).toBeNull();
    expect(wrapper.wrapClaim(createSolanaClaimFixture(), senderPrivKey, receiverPubKey)).toBeNull();
    expect(wrapper.wrapClaim(createMinaClaimFixture(), senderPrivKey, receiverPubKey)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Additional: NIP59TransportWrapper alias
// ---------------------------------------------------------------------------

describe('NIP59TransportWrapper alias', () => {
  test('NIP59TransportWrapper is an alias for NIP59ClaimWrapper', () => {
    expect(NIP59TransportWrapper).toBe(NIP59ClaimWrapper);
  });
});

// ---------------------------------------------------------------------------
// Dual HKDF Derivation: wrapClaimWithCondition / unwrapClaimWithPreimage
// ---------------------------------------------------------------------------

describe('Dual HKDF derivation: wrapClaimWithCondition', () => {
  test('returns 32-byte executionCondition (not all zeros)', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const result = wrapper.wrapClaimWithCondition(claim, senderPrivKey, receiverPubKey);

    expect(result).not.toBeNull();
    expect(result!.executionCondition).toBeInstanceOf(Uint8Array);
    expect(result!.executionCondition.length).toBe(32);
    expect(result!.executionCondition.every((b) => b === 0)).toBe(false);
  });

  test('unwrapClaimWithPreimage returns preimage where SHA-256(preimage) === executionCondition', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapResult = wrapper.wrapClaimWithCondition(claim, senderPrivKey, receiverPubKey);
    expect(wrapResult).not.toBeNull();

    const unwrapResult = wrapper.unwrapClaimWithPreimage(wrapResult!.wrapped, receiverPrivKey);

    expect(unwrapResult.fulfillmentPreimage).toBeInstanceOf(Uint8Array);
    expect(unwrapResult.fulfillmentPreimage.length).toBe(32);

    const computedCondition = sha256(unwrapResult.fulfillmentPreimage);
    expect(Buffer.from(computedCondition).equals(Buffer.from(wrapResult!.executionCondition))).toBe(
      true
    );
  });

  test('two successive wrapClaimWithCondition calls produce different executionConditions (per-packet uniqueness)', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const result1 = wrapper.wrapClaimWithCondition(claim, senderPrivKey, receiverPubKey);
    const result2 = wrapper.wrapClaimWithCondition(claim, senderPrivKey, receiverPubKey);

    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    expect(
      Buffer.from(result1!.executionCondition).equals(Buffer.from(result2!.executionCondition))
    ).toBe(false);
  });

  test('returns null when NIP-59 is disabled', () => {
    const wrapper = createWrapper(false);
    const claim = createEVMClaimFixture();

    const result = wrapper.wrapClaimWithCondition(claim, senderPrivKey, receiverPubKey);

    expect(result).toBeNull();
  });

  test('existing wrapClaim behavior unchanged after refactoring', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapped = wrapper.wrapClaim(claim, senderPrivKey, receiverPubKey);
    expect(wrapped).not.toBeNull();

    const unwrapped = wrapper.unwrapClaim(wrapped!, receiverPrivKey);
    expect(unwrapped).toEqual(claim);
  });

  test('unwrapClaimWithPreimage recovers original claim', () => {
    const wrapper = createWrapper();
    const claim = createMinaClaimFixture();

    const wrapResult = wrapper.wrapClaimWithCondition(claim, senderPrivKey, receiverPubKey);
    expect(wrapResult).not.toBeNull();

    const unwrapResult = wrapper.unwrapClaimWithPreimage(wrapResult!.wrapped, receiverPrivKey);
    expect(unwrapResult.claim).toEqual(claim);
  });

  test('unwrapClaimWithPreimage with wrong private key throws NIP59WrapError', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapResult = wrapper.wrapClaimWithCondition(claim, senderPrivKey, receiverPubKey);
    expect(wrapResult).not.toBeNull();

    expect(() => wrapper.unwrapClaimWithPreimage(wrapResult!.wrapped, wrongPrivKey)).toThrow(
      NIP59WrapError
    );
  });

  test('unwrapClaimWithPreimage with tampered ciphertext throws NIP59WrapError', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapResult = wrapper.wrapClaimWithCondition(claim, senderPrivKey, receiverPubKey);
    expect(wrapResult).not.toBeNull();

    const payloadBytes = Buffer.from(wrapResult!.wrapped.encryptedPayload, 'base64');
    const midpoint = Math.floor(payloadBytes.length / 2);
    payloadBytes[midpoint] = (payloadBytes[midpoint]! ^ 0xff) & 0xff;

    const tampered = {
      ...wrapResult!.wrapped,
      encryptedPayload: payloadBytes.toString('base64'),
    };

    expect(() => wrapper.unwrapClaimWithPreimage(tampered, receiverPrivKey)).toThrow(
      NIP59WrapError
    );
  });

  test('unwrapClaimWithPreimage with empty ephemeralPublicKey throws NIP59WrapError', () => {
    const wrapper = createWrapper();
    const claim = createEVMClaimFixture();

    const wrapResult = wrapper.wrapClaimWithCondition(claim, senderPrivKey, receiverPubKey);
    expect(wrapResult).not.toBeNull();

    const malformed = { ...wrapResult!.wrapped, ephemeralPublicKey: '' };

    expect(() => wrapper.unwrapClaimWithPreimage(malformed, receiverPrivKey)).toThrow(
      NIP59WrapError
    );
  });
});
