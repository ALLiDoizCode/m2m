/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * Branch Coverage Tests for NIP59ClaimWrapper
 *
 * Targets uncovered branches in nip59-claim-wrapper.ts:
 * - Lines 260,332-341,362,375-383,476,506,551-552,572,585-586,720,785,805
 *
 * Focus areas:
 * 1. Decryption failure handling (wrong receiver key) — partially covered by T-34.6-10,
 *    but seal-layer non-NIP59WrapError catches are not.
 * 2. Invalid MAC authentication failures — _verifyCiphertext invalid signature (line 720).
 * 3. NIP-59 disabled passthrough branches — wrapClaimWithCondition disabled (line 476 is
 *    the catch block, not the passthrough itself).
 * 4. ECDH key derivation edge cases — via mocking secp256k1.
 *
 * @module nip59-claim-wrapper.coverage.test
 */

import { randomBytes } from 'crypto';
import pino from 'pino';
import { secp256k1 } from '@noble/curves/secp256k1';

import {
  NIP59ClaimWrapper,
  NIP59WrapError,
  WrappedClaim,
  deserializeWrappedClaim,
} from './nip59-claim-wrapper';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper(enabled = true): NIP59ClaimWrapper {
  return new NIP59ClaimWrapper({
    nip59Enabled: enabled,
    logger: pino({ level: 'silent' }),
  });
}

function createFakeWrappedClaim(overrides: Partial<WrappedClaim> = {}): WrappedClaim {
  return {
    ephemeralPublicKey: '02' + '00'.repeat(32),
    encryptedPayload: Buffer.from('fake-payload-for-tests').toString('base64'),
    timestamp: Date.now(),
    version: '1.0',
    ...overrides,
  };
}

function createValidSealPayloadBytes(): Uint8Array {
  const sealPayload = {
    senderPublicKey: '02' + '00'.repeat(32),
    signature: Buffer.from('fake-sig').toString('base64'),
    sealCiphertext: Buffer.from('fake-ciphertext').toString('base64'),
  };
  return new Uint8Array(Buffer.from(JSON.stringify(sealPayload), 'utf8'));
}

function utf8ToBytes(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, 'utf8'));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Branch: wrapClaim catch block (line 260)
// ---------------------------------------------------------------------------

describe('Branch coverage: wrapClaim error handling (line 260)', () => {
  test('wrapClaim throws NIP59WrapError when secp256k1.getPublicKey fails', () => {
    const wrapper = createWrapper();
    const claim = {
      version: '2.0',
      blockchain: 'evm',
      messageId: 'test-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      senderId: 'peer-a',
      channelId: '0x' + '00'.repeat(32),
      nonce: 1,
      cumulativeAmount: '1000',
      recipient: '0x' + '11'.repeat(20),
      signature: '0x' + '00'.repeat(65),
      signerAddress: '0x' + '00'.repeat(20),
      chainId: 8453,
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    } as const;

    const senderPrivKey = randomBytes(32);
    const receiverPubKey = randomBytes(33);

    jest.spyOn(secp256k1, 'getPublicKey').mockImplementation(() => {
      throw new Error('secp256k1.getPublicKey failure');
    });

    expect(() => wrapper.wrapClaim(claim, senderPrivKey, receiverPubKey)).toThrow(NIP59WrapError);
    expect(() => wrapper.wrapClaim(claim, senderPrivKey, receiverPubKey)).toThrow(
      /Failed to wrap claim/
    );
  });
});

// ---------------------------------------------------------------------------
// Branch: unwrapClaim seal-layer non-NIP59WrapError catch (lines 332-341)
// ---------------------------------------------------------------------------

describe('Branch coverage: unwrapClaim seal-layer non-NIP59WrapError catch (lines 332-341)', () => {
  test('unwrapClaim logs warning and throws NIP59WrapError when seal layer throws generic Error', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();
    const receiverPrivKey = randomBytes(32);

    // Access the private logger through the wrapper instance
    const internalLogger = (wrapper as any)._logger;
    const warnSpy = jest.spyOn(internalLogger, 'warn').mockImplementation(() => {});

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockReturnValue({
      plaintext: createValidSealPayloadBytes(),
      sharedSecret: new Uint8Array(32),
    });

    jest.spyOn(wrapper as any, '_verifyCiphertext').mockImplementation(() => {
      /* no-op: let verification pass so we reach _decryptSeal */
    });

    jest.spyOn(wrapper as any, '_decryptSeal').mockImplementation(() => {
      throw new Error('seal decryption failure');
    });

    expect(() => wrapper.unwrapClaim(fakeWrapped, receiverPrivKey)).toThrow(NIP59WrapError);
    expect(() => wrapper.unwrapClaim(fakeWrapped, receiverPrivKey)).toThrow(/seal layer/);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ layer: 'seal' }),
      expect.stringContaining('Failed to unwrap NIP-59 seal layer')
    );
  });
});

// ---------------------------------------------------------------------------
// Branch: unwrapClaim invalid BTPClaimMessage validation (line 362)
// ---------------------------------------------------------------------------

describe('Branch coverage: unwrapClaim invalid BTPClaimMessage validation (line 362)', () => {
  test('unwrapClaim throws NIP59WrapError when rumor is valid JSON but not a BTPClaimMessage', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();
    const receiverPrivKey = randomBytes(32);

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockReturnValue({
      plaintext: createValidSealPayloadBytes(),
      sharedSecret: new Uint8Array(32),
    });

    jest.spyOn(wrapper as any, '_verifyCiphertext').mockImplementation(() => {
      /* no-op: let verification pass */
    });

    // Return a JSON object that is missing required BTPClaimMessage fields
    jest.spyOn(wrapper as any, '_decryptSeal').mockReturnValue(utf8ToBytes(JSON.stringify({})));

    expect(() => wrapper.unwrapClaim(fakeWrapped, receiverPrivKey)).toThrow(NIP59WrapError);
    expect(() => wrapper.unwrapClaim(fakeWrapped, receiverPrivKey)).toThrow(
      /Rumor payload is not a valid BTPClaimMessage/
    );
  });
});

// ---------------------------------------------------------------------------
// Branch: unwrapClaim rumor-layer catch block (lines 375-383)
// ---------------------------------------------------------------------------

describe('Branch coverage: unwrapClaim rumor-layer catch block (lines 375-383)', () => {
  test('unwrapClaim logs warning and throws NIP59WrapError when rumor is not valid JSON', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();
    const receiverPrivKey = randomBytes(32);

    const internalLogger = (wrapper as any)._logger;
    const warnSpy = jest.spyOn(internalLogger, 'warn').mockImplementation(() => {});

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockReturnValue({
      plaintext: createValidSealPayloadBytes(),
      sharedSecret: new Uint8Array(32),
    });

    jest.spyOn(wrapper as any, '_verifyCiphertext').mockImplementation(() => {
      /* no-op: let verification pass */
    });

    // Return bytes that are not valid JSON, causing JSON.parse to throw SyntaxError
    jest.spyOn(wrapper as any, '_decryptSeal').mockReturnValue(utf8ToBytes('this-is-not-json'));

    expect(() => wrapper.unwrapClaim(fakeWrapped, receiverPrivKey)).toThrow(NIP59WrapError);
    expect(() => wrapper.unwrapClaim(fakeWrapped, receiverPrivKey)).toThrow(/rumor layer/);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ layer: 'rumor' }),
      expect.stringContaining('Failed to parse NIP-59 rumor layer')
    );
  });
});

// ---------------------------------------------------------------------------
// Branch: wrapClaimWithCondition catch block (line 476)
// ---------------------------------------------------------------------------

describe('Branch coverage: wrapClaimWithCondition catch block (line 476)', () => {
  test('wrapClaimWithCondition throws NIP59WrapError when crypto fails', () => {
    const wrapper = createWrapper();
    const claim = {
      version: '2.0',
      blockchain: 'evm',
      messageId: 'test-2',
      timestamp: '2026-01-01T00:00:00.000Z',
      senderId: 'peer-b',
      channelId: '0x' + '00'.repeat(32),
      nonce: 2,
      cumulativeAmount: '2000',
      recipient: '0x' + '11'.repeat(20),
      signature: '0x' + '00'.repeat(65),
      signerAddress: '0x' + '00'.repeat(20),
      chainId: 8453,
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    } as const;

    const senderPrivKey = randomBytes(32);
    const receiverPubKey = randomBytes(33);

    jest.spyOn(secp256k1, 'getPublicKey').mockImplementation(() => {
      throw new Error('getPublicKey failure in wrapClaimWithCondition');
    });

    expect(() => wrapper.wrapClaimWithCondition(claim, senderPrivKey, receiverPubKey)).toThrow(
      NIP59WrapError
    );
    expect(() => wrapper.wrapClaimWithCondition(claim, senderPrivKey, receiverPubKey)).toThrow(
      /Failed to wrap claim with condition/
    );
  });
});

// ---------------------------------------------------------------------------
// Branch: unwrapClaimWithPreimage missing encryptedPayload (line 506)
// ---------------------------------------------------------------------------

describe('Branch coverage: unwrapClaimWithPreimage missing encryptedPayload (line 506)', () => {
  test('unwrapClaimWithPreimage throws NIP59WrapError when encryptedPayload is empty', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim({ encryptedPayload: '' });
    const receiverPrivKey = randomBytes(32);

    expect(() => wrapper.unwrapClaimWithPreimage(fakeWrapped, receiverPrivKey)).toThrow(
      NIP59WrapError
    );
    expect(() => wrapper.unwrapClaimWithPreimage(fakeWrapped, receiverPrivKey)).toThrow(
      /missing encryptedPayload/
    );
  });
});

// ---------------------------------------------------------------------------
// Branch: unwrapClaimWithPreimage seal non-NIP59WrapError catch (lines 551-552)
// ---------------------------------------------------------------------------

describe('Branch coverage: unwrapClaimWithPreimage seal non-NIP59WrapError catch (lines 551-552)', () => {
  test('unwrapClaimWithPreimage throws NIP59WrapError when seal layer throws generic Error', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();
    const receiverPrivKey = randomBytes(32);

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockReturnValue({
      plaintext: createValidSealPayloadBytes(),
      sharedSecret: new Uint8Array(32),
    });

    jest.spyOn(wrapper as any, '_verifyCiphertext').mockImplementation(() => {
      /* no-op: let verification pass */
    });

    jest.spyOn(wrapper as any, '_decryptSeal').mockImplementation(() => {
      throw new Error('seal decryption failure in preimage flow');
    });

    expect(() => wrapper.unwrapClaimWithPreimage(fakeWrapped, receiverPrivKey)).toThrow(
      NIP59WrapError
    );
    expect(() => wrapper.unwrapClaimWithPreimage(fakeWrapped, receiverPrivKey)).toThrow(
      /seal layer/
    );
  });
});

// ---------------------------------------------------------------------------
// Branch: unwrapClaimWithPreimage invalid BTPClaimMessage (line 572)
// ---------------------------------------------------------------------------

describe('Branch coverage: unwrapClaimWithPreimage invalid BTPClaimMessage (line 572)', () => {
  test('unwrapClaimWithPreimage throws NIP59WrapError when rumor is not a valid BTPClaimMessage', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();
    const receiverPrivKey = randomBytes(32);

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockReturnValue({
      plaintext: createValidSealPayloadBytes(),
      sharedSecret: new Uint8Array(32),
    });

    jest.spyOn(wrapper as any, '_verifyCiphertext').mockImplementation(() => {
      /* no-op: let verification pass */
    });

    jest.spyOn(wrapper as any, '_decryptSeal').mockReturnValue(utf8ToBytes(JSON.stringify({})));

    expect(() => wrapper.unwrapClaimWithPreimage(fakeWrapped, receiverPrivKey)).toThrow(
      NIP59WrapError
    );
    expect(() => wrapper.unwrapClaimWithPreimage(fakeWrapped, receiverPrivKey)).toThrow(
      /Rumor payload is not a valid BTPClaimMessage/
    );
  });
});

// ---------------------------------------------------------------------------
// Branch: unwrapClaimWithPreimage rumor non-NIP59WrapError catch (lines 585-586)
// ---------------------------------------------------------------------------

describe('Branch coverage: unwrapClaimWithPreimage rumor non-NIP59WrapError catch (lines 585-586)', () => {
  test('unwrapClaimWithPreimage throws NIP59WrapError when rumor is not valid JSON', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();
    const receiverPrivKey = randomBytes(32);

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockReturnValue({
      plaintext: createValidSealPayloadBytes(),
      sharedSecret: new Uint8Array(32),
    });

    jest.spyOn(wrapper as any, '_verifyCiphertext').mockImplementation(() => {
      /* no-op: let verification pass */
    });

    // Return bytes that trigger SyntaxError in JSON.parse (non-NIP59WrapError)
    jest.spyOn(wrapper as any, '_decryptSeal').mockReturnValue(utf8ToBytes('not-valid-json'));

    expect(() => wrapper.unwrapClaimWithPreimage(fakeWrapped, receiverPrivKey)).toThrow(
      NIP59WrapError
    );
    expect(() => wrapper.unwrapClaimWithPreimage(fakeWrapped, receiverPrivKey)).toThrow(
      /rumor layer/
    );
  });
});

// ---------------------------------------------------------------------------
// Branch: _verifyCiphertext invalid signature (line 720)
// ---------------------------------------------------------------------------

describe('Branch coverage: _verifyCiphertext invalid signature (line 720)', () => {
  test('unwrapClaim throws NIP59WrapError when seal signature verification fails', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();
    const receiverPrivKey = randomBytes(32);

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockReturnValue({
      plaintext: createValidSealPayloadBytes(),
      sharedSecret: new Uint8Array(32),
    });

    // Mock secp256k1.verify to return false so _verifyCiphertext hits the invalid-signature branch
    jest.spyOn(secp256k1, 'verify').mockReturnValue(false);

    expect(() => wrapper.unwrapClaim(fakeWrapped, receiverPrivKey)).toThrow(NIP59WrapError);
    expect(() => wrapper.unwrapClaim(fakeWrapped, receiverPrivKey)).toThrow(
      /sender signature is invalid/
    );
  });
});

// ---------------------------------------------------------------------------
// Branch: deserializeWrappedClaim invalid structure (line 785)
// ---------------------------------------------------------------------------

describe('Branch coverage: deserializeWrappedClaim invalid structure (line 785)', () => {
  test('deserializeWrappedClaim throws NIP59WrapError when required fields are missing', () => {
    // Valid JSON but missing required WrappedClaim fields
    const missingFields = Buffer.from(JSON.stringify({ version: '1.0' }), 'utf8');

    expect(() => deserializeWrappedClaim(missingFields)).toThrow(NIP59WrapError);
    expect(() => deserializeWrappedClaim(missingFields)).toThrow(/Invalid WrappedClaim structure/);
  });

  test('deserializeWrappedClaim throws NIP59WrapError when version is wrong', () => {
    const wrongVersion = Buffer.from(
      JSON.stringify({
        ephemeralPublicKey: '02' + '00'.repeat(32),
        encryptedPayload: 'test',
        timestamp: Date.now(),
        version: '2.0',
      }),
      'utf8'
    );

    expect(() => deserializeWrappedClaim(wrongVersion)).toThrow(NIP59WrapError);
    expect(() => deserializeWrappedClaim(wrongVersion)).toThrow(/Invalid WrappedClaim structure/);
  });
});

// ---------------------------------------------------------------------------
// Branch: hexToBytes invalid hex character (line 805)
// ---------------------------------------------------------------------------

describe('Branch coverage: hexToBytes invalid hex character (line 805)', () => {
  test('unwrapClaim throws NIP59WrapError when ephemeralPublicKey contains invalid hex chars', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim({
      ephemeralPublicKey: 'gg' + '00'.repeat(31), // even length, but 'gg' is not hex
    });
    const receiverPrivKey = randomBytes(32);

    expect(() => wrapper.unwrapClaim(fakeWrapped, receiverPrivKey)).toThrow(NIP59WrapError);
    expect(() => wrapper.unwrapClaim(fakeWrapped, receiverPrivKey)).toThrow(/gift wrap layer/);
  });

  test('unwrapClaimWithPreimage throws NIP59WrapError when ephemeralPublicKey contains invalid hex chars', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim({
      ephemeralPublicKey: 'gg' + '00'.repeat(31),
    });
    const receiverPrivKey = randomBytes(32);

    expect(() => wrapper.unwrapClaimWithPreimage(fakeWrapped, receiverPrivKey)).toThrow(
      NIP59WrapError
    );
    expect(() => wrapper.unwrapClaimWithPreimage(fakeWrapped, receiverPrivKey)).toThrow(
      /gift wrap layer/
    );
  });
});

// ---------------------------------------------------------------------------
// Branch: ECDH key derivation edge cases via mocked secp256k1.getSharedSecret
// ---------------------------------------------------------------------------

describe('Branch coverage: ECDH key derivation edge cases', () => {
  test('wrapClaim throws NIP59WrapError when secp256k1.getSharedSecret fails', () => {
    const wrapper = createWrapper();
    const claim = {
      version: '2.0',
      blockchain: 'evm',
      messageId: 'test-3',
      timestamp: '2026-01-01T00:00:00.000Z',
      senderId: 'peer-c',
      channelId: '0x' + '00'.repeat(32),
      nonce: 3,
      cumulativeAmount: '3000',
      recipient: '0x' + '11'.repeat(20),
      signature: '0x' + '00'.repeat(65),
      signerAddress: '0x' + '00'.repeat(20),
      chainId: 8453,
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    } as const;

    const senderPrivKey = randomBytes(32);
    const receiverPubKey = randomBytes(33);

    // Mock getSharedSecret to simulate ECDH key derivation failure
    jest.spyOn(secp256k1, 'getSharedSecret').mockImplementation(() => {
      throw new Error('getSharedSecret failure');
    });

    expect(() => wrapper.wrapClaim(claim, senderPrivKey, receiverPubKey)).toThrow(NIP59WrapError);
    expect(() => wrapper.wrapClaim(claim, senderPrivKey, receiverPubKey)).toThrow(
      /Failed to wrap claim/
    );
  });
});

// ---------------------------------------------------------------------------
// Additional: wrapClaim / wrapClaimWithCondition disabled passthrough
// (These are already covered in the main test file, but included here
//  for completeness since they relate to the requested branch areas.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Branch: catch blocks with non-Error thrown values (covers String(err) branches)
// ---------------------------------------------------------------------------

describe('Branch coverage: catch blocks with non-Error thrown values', () => {
  test('wrapClaim catch uses String(err) when thrown value is not an Error (line 261)', () => {
    const wrapper = createWrapper();
    const claim = {
      version: '2.0',
      blockchain: 'evm',
      messageId: 'test-string-throw',
      timestamp: '2026-01-01T00:00:00.000Z',
      senderId: 'peer-e',
      channelId: '0x' + '00'.repeat(32),
      nonce: 5,
      cumulativeAmount: '5000',
      recipient: '0x' + '11'.repeat(20),
      signature: '0x' + '00'.repeat(65),
      signerAddress: '0x' + '00'.repeat(20),
      chainId: 8453,
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    } as const;

    jest.spyOn(secp256k1, 'getPublicKey').mockImplementation(() => {
      throw 'this is a string error, not an Error object';
    });

    expect(() => wrapper.wrapClaim(claim, randomBytes(32), randomBytes(33))).toThrow(
      /this is a string error/
    );
  });

  test('wrapClaimWithCondition catch uses String(err) when thrown value is not an Error (line 477)', () => {
    const wrapper = createWrapper();
    const claim = {
      version: '2.0',
      blockchain: 'evm',
      messageId: 'test-string-throw-2',
      timestamp: '2026-01-01T00:00:00.000Z',
      senderId: 'peer-f',
      channelId: '0x' + '00'.repeat(32),
      nonce: 6,
      cumulativeAmount: '6000',
      recipient: '0x' + '11'.repeat(20),
      signature: '0x' + '00'.repeat(65),
      signerAddress: '0x' + '00'.repeat(20),
      chainId: 8453,
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    } as const;

    jest.spyOn(secp256k1, 'getPublicKey').mockImplementation(() => {
      throw 'string-error-for-condition';
    });

    expect(() => wrapper.wrapClaimWithCondition(claim, randomBytes(32), randomBytes(33))).toThrow(
      /string-error-for-condition/
    );
  });

  test('unwrapClaim gift-wrap catch uses String(err) when thrown value is not an Error (lines 301-311)', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockImplementation(() => {
      throw 'gift-wrap-string-error';
    });

    expect(() => wrapper.unwrapClaim(fakeWrapped, randomBytes(32))).toThrow(
      /gift-wrap-string-error/
    );
  });

  test('unwrapClaim gift-wrap catch rethrows NIP59WrapError directly (line 301)', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockImplementation(() => {
      throw new NIP59WrapError('direct-gift-wrap-error');
    });

    expect(() => wrapper.unwrapClaim(fakeWrapped, randomBytes(32))).toThrow(
      'direct-gift-wrap-error'
    );
  });

  test('unwrapClaim seal catch uses String(err) when thrown value is not an Error (lines 337-342)', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();
    const internalLogger = (wrapper as any)._logger;
    jest.spyOn(internalLogger, 'warn').mockImplementation(() => {});

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockReturnValue({
      plaintext: createValidSealPayloadBytes(),
      sharedSecret: new Uint8Array(32),
    });

    jest.spyOn(wrapper as any, '_verifyCiphertext').mockImplementation(() => {
      throw 'seal-string-error';
    });

    expect(() => wrapper.unwrapClaim(fakeWrapped, randomBytes(32))).toThrow(/seal-string-error/);
  });

  test('unwrapClaim rumor catch uses String(err) when thrown value is not an Error (lines 379-384)', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();
    const internalLogger = (wrapper as any)._logger;
    jest.spyOn(internalLogger, 'warn').mockImplementation(() => {});

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockReturnValue({
      plaintext: createValidSealPayloadBytes(),
      sharedSecret: new Uint8Array(32),
    });

    jest.spyOn(wrapper as any, '_verifyCiphertext').mockImplementation(() => {});

    jest.spyOn(wrapper as any, '_decryptSeal').mockImplementation(() => {
      throw 'rumor-string-error';
    });

    expect(() => wrapper.unwrapClaim(fakeWrapped, randomBytes(32))).toThrow(/rumor-string-error/);
  });

  test('unwrapClaimWithPreimage gift-wrap catch rethrows NIP59WrapError directly (line 526)', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockImplementation(() => {
      throw new NIP59WrapError('direct-gift-wrap-preimage-error');
    });

    expect(() => wrapper.unwrapClaimWithPreimage(fakeWrapped, randomBytes(32))).toThrow(
      'direct-gift-wrap-preimage-error'
    );
  });

  test('unwrapClaimWithPreimage gift-wrap catch uses String(err) when thrown value is not an Error (lines 526-530)', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockImplementation(() => {
      throw 'gift-wrap-preimage-string';
    });

    expect(() => wrapper.unwrapClaimWithPreimage(fakeWrapped, randomBytes(32))).toThrow(
      /gift-wrap-preimage-string/
    );
  });

  test('unwrapClaimWithPreimage seal catch uses String(err) when thrown value is not an Error (lines 551-553)', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockReturnValue({
      plaintext: createValidSealPayloadBytes(),
      sharedSecret: new Uint8Array(32),
    });

    jest.spyOn(wrapper as any, '_verifyCiphertext').mockImplementation(() => {
      throw 'seal-preimage-string';
    });

    expect(() => wrapper.unwrapClaimWithPreimage(fakeWrapped, randomBytes(32))).toThrow(
      /seal-preimage-string/
    );
  });

  test('unwrapClaimWithPreimage rumor catch uses String(err) when thrown value is not an Error (lines 585-587)', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockReturnValue({
      plaintext: createValidSealPayloadBytes(),
      sharedSecret: new Uint8Array(32),
    });

    jest.spyOn(wrapper as any, '_verifyCiphertext').mockImplementation(() => {});

    jest.spyOn(wrapper as any, '_decryptSeal').mockImplementation(() => {
      throw 'rumor-preimage-string';
    });

    expect(() => wrapper.unwrapClaimWithPreimage(fakeWrapped, randomBytes(32))).toThrow(
      /rumor-preimage-string/
    );
  });

  test('unwrapClaimWithPreimage seal catch rethrows NIP59WrapError directly (line 551)', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockReturnValue({
      plaintext: createValidSealPayloadBytes(),
      sharedSecret: new Uint8Array(32),
    });

    // Make _verifyCiphertext throw NIP59WrapError so line 551 (if (err instanceof NIP59WrapError) throw err;) is hit
    jest.spyOn(wrapper as any, '_verifyCiphertext').mockImplementation(() => {
      throw new NIP59WrapError('seal-auth-fail');
    });

    expect(() => wrapper.unwrapClaimWithPreimage(fakeWrapped, randomBytes(32))).toThrow(
      'seal-auth-fail'
    );
  });
});

// ---------------------------------------------------------------------------
// Branch: rumor-layer String(err) branches via JSON.parse throwing non-Error
// ---------------------------------------------------------------------------

describe('Branch coverage: rumor-layer String(err) via JSON.parse non-Error throws', () => {
  test('unwrapClaim rumor catch uses String(err) when JSON.parse throws a string (lines 379-384)', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();
    const internalLogger = (wrapper as any)._logger;
    jest.spyOn(internalLogger, 'warn').mockImplementation(() => {});

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockReturnValue({
      plaintext: createValidSealPayloadBytes(),
      sharedSecret: new Uint8Array(32),
    });

    jest.spyOn(wrapper as any, '_verifyCiphertext').mockImplementation(() => {});
    jest.spyOn(wrapper as any, '_decryptSeal').mockReturnValue(utf8ToBytes('{"valid":"json"}'));

    const parseSpy = jest.spyOn(JSON, 'parse').mockImplementation(() => {
      throw 'parse-string-error';
    });

    try {
      expect(() => wrapper.unwrapClaim(fakeWrapped, randomBytes(32))).toThrow(/parse-string-error/);
    } finally {
      parseSpy.mockRestore();
    }
  });

  test('unwrapClaimWithPreimage rumor catch uses String(err) when JSON.parse throws a string (lines 585-587)', () => {
    const wrapper = createWrapper();
    const fakeWrapped = createFakeWrappedClaim();

    jest.spyOn(wrapper as any, '_decryptGiftWrap').mockReturnValue({
      plaintext: createValidSealPayloadBytes(),
      sharedSecret: new Uint8Array(32),
    });

    jest.spyOn(wrapper as any, '_verifyCiphertext').mockImplementation(() => {});
    jest.spyOn(wrapper as any, '_decryptSeal').mockReturnValue(utf8ToBytes('{"valid":"json"}'));

    const parseSpy = jest.spyOn(JSON, 'parse').mockImplementation(() => {
      throw 'parse-string-error-preimage';
    });

    try {
      expect(() => wrapper.unwrapClaimWithPreimage(fakeWrapped, randomBytes(32))).toThrow(
        /parse-string-error-preimage/
      );
    } finally {
      parseSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Branch: deserializeWrappedClaim catch block (line 773)
// ---------------------------------------------------------------------------

describe('Branch coverage: deserializeWrappedClaim catch block (line 773)', () => {
  test('deserializeWrappedClaim catch preserves non-Error cause message (line 773)', () => {
    jest.spyOn(JSON, 'parse').mockImplementation(() => {
      throw 'raw-string-parse-error';
    });

    try {
      expect(() => deserializeWrappedClaim(Buffer.from('any'))).toThrow(/raw-string-parse-error/);
    } finally {
      // Restore
      (JSON.parse as any).mockRestore?.();
      // If restore failed, re-assign
      if (jest.isMockFunction(JSON.parse)) {
        (JSON.parse as jest.Mock).mockRestore();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Additional: wrapClaim / wrapClaimWithCondition disabled passthrough
// ---------------------------------------------------------------------------

describe('Branch coverage: NIP-59 disabled passthrough branches', () => {
  test('wrapClaimWithCondition returns null when NIP-59 is disabled', () => {
    const wrapper = createWrapper(false);
    const claim = {
      version: '2.0',
      blockchain: 'evm',
      messageId: 'test-4',
      timestamp: '2026-01-01T00:00:00.000Z',
      senderId: 'peer-d',
      channelId: '0x' + '00'.repeat(32),
      nonce: 4,
      cumulativeAmount: '4000',
      recipient: '0x' + '11'.repeat(20),
      signature: '0x' + '00'.repeat(65),
      signerAddress: '0x' + '00'.repeat(20),
      chainId: 8453,
      verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    } as const;

    const senderPrivKey = randomBytes(32);
    const receiverPubKey = randomBytes(33);

    expect(wrapper.wrapClaimWithCondition(claim, senderPrivKey, receiverPubKey)).toBeNull();
  });
});
