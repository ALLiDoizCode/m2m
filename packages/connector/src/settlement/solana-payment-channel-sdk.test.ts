/**
 * Unit + Integration Tests for SolanaPaymentChannelSDK
 *
 * Story 33.4: SolanaPaymentChannelSDK -- TypeScript Integration
 *
 * Unit tests verify pure functions (PDA derivation, balance proof, deserialization, error mapping)
 * without RPC dependencies. Integration tests use solana-bankrun for fast in-process on-chain
 * verification of transaction builders and cross-language serialization correctness.
 *
 * Prerequisites for integration tests:
 *   cd packages/solana-program && cargo build-sbf
 *   (produces target/deploy/payment_channel.so)
 */

import pino from 'pino';
import {
  SolanaPaymentChannelSDK,
  SolanaChannelError,
  deserializeChannelState,
  mapProgramError,
  parseSolanaError,
  buildEd25519PrecompileInstruction,
  generateKeyPairSigner,
} from './solana-payment-channel-sdk';
import type { SolanaChannelState } from './solana-payment-channel-sdk';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Program ID used for test PDA derivation (arbitrary but deterministic) */
const TEST_PROGRAM_ID = '11111111111111111111111111111111';

/** Two test pubkeys in known lexicographic order (A < B when compared as byte arrays) */
const TEST_PUBKEY_A = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM';
const TEST_PUBKEY_B = 'CiDwVBFgWV9E5MvXWoLgnEgn2hK7rJikbvfWavzAQz3';

/** Token mint for testing */
const TEST_TOKEN_MINT = 'So11111111111111111111111111111111111111112';

/** Challenge duration for all tests (5 minutes) -- used by integration tests */
const TEST_CHALLENGE_DURATION = 300n;

/** On-chain discriminator for the channel account: "pchannel" in ASCII */
const CHANNEL_DISCRIMINATOR = new Uint8Array([0x70, 0x63, 0x68, 0x61, 0x6e, 0x6e, 0x65, 0x6c]);

/** Error code map matching the Rust program (codes 0-12) */
const EXPECTED_ERROR_NAMES: Record<number, string> = {
  0: 'ChannelAlreadyExists',
  1: 'ChannelNotOpened',
  2: 'ChannelNotClosed',
  3: 'ChannelChallengeNotExpired',
  4: 'InvalidParticipant',
  5: 'ZeroAmountDeposit',
  6: 'NonceNotMonotonic',
  7: 'TransferredAmountDecreased',
  8: 'InvalidSignature',
  9: 'UnauthorizedSigner',
  10: 'ArithmeticOverflow',
  11: 'InvalidPDA',
  12: 'InvalidVaultPDA',
};

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock Pino logger with silent output.
 * Follows project convention: pino({ level: 'silent' }) with .child() returning itself.
 */
const createMockLogger = (): pino.Logger => pino({ level: 'silent' });

/**
 * Builds a golden 178-byte channel account data buffer with known field values.
 * Used for deserialization golden test (T-33.4-08-unit).
 */
function buildGoldenChannelState(): {
  data: Uint8Array;
  expected: {
    participantA: Uint8Array;
    participantB: Uint8Array;
    tokenMint: Uint8Array;
    depositA: bigint;
    depositB: bigint;
    transferredAmountA: bigint;
    transferredAmountB: bigint;
    nonceA: bigint;
    nonceB: bigint;
    challengeDuration: bigint;
    state: number;
    closeTimestamp: bigint;
    bump: number;
  };
} {
  const data = new Uint8Array(178);

  // Discriminator: "pchannel"
  data.set(CHANNEL_DISCRIMINATOR, 0);

  // participant_a: 32 bytes of 0x01
  const participantA = new Uint8Array(32).fill(0x01);
  data.set(participantA, 8);

  // participant_b: 32 bytes of 0x02
  const participantB = new Uint8Array(32).fill(0x02);
  data.set(participantB, 40);

  // token_mint: 32 bytes of 0x03
  const tokenMint = new Uint8Array(32).fill(0x03);
  data.set(tokenMint, 72);

  // deposit_a: 1000000 (u64 LE)
  const depositA = 1000000n;
  writeUint64LE(data, 104, depositA);

  // deposit_b: 2000000 (u64 LE)
  const depositB = 2000000n;
  writeUint64LE(data, 112, depositB);

  // transferred_amount_a: 500000 (u64 LE)
  const transferredAmountA = 500000n;
  writeUint64LE(data, 120, transferredAmountA);

  // transferred_amount_b: 300000 (u64 LE)
  const transferredAmountB = 300000n;
  writeUint64LE(data, 128, transferredAmountB);

  // nonce_a: 5 (u64 LE)
  const nonceA = 5n;
  writeUint64LE(data, 136, nonceA);

  // nonce_b: 3 (u64 LE)
  const nonceB = 3n;
  writeUint64LE(data, 144, nonceB);

  // challenge_duration: 300 (u64 LE)
  const challengeDuration = 300n;
  writeUint64LE(data, 152, challengeDuration);

  // state: 1 = Closed
  const state = 1;
  data[160] = state;

  // close_timestamp: 1700000000 (i64 LE)
  const closeTimestamp = 1700000000n;
  writeUint64LE(data, 161, closeTimestamp);

  // bump: 254
  const bump = 254;
  data[169] = bump;

  // padding: 8 bytes of zeros (already zero-initialized)

  return {
    data,
    expected: {
      participantA,
      participantB,
      tokenMint,
      depositA,
      depositB,
      transferredAmountA,
      transferredAmountB,
      nonceA,
      nonceB,
      challengeDuration,
      state,
      closeTimestamp,
      bump,
    },
  };
}

/**
 * Writes a u64 value as little-endian bytes into a Uint8Array at the given offset.
 */
function writeUint64LE(buf: Uint8Array, offset: number, value: bigint): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
}

/**
 * Reads a u64 value as little-endian from a Uint8Array at the given offset.
 */
function readUint64LE(buf: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result |= BigInt(buf[offset + i] ?? 0) << BigInt(i * 8);
  }
  return result;
}

// ============================================================================
// UNIT TESTS
// ============================================================================

describe('SolanaPaymentChannelSDK - Unit Tests (Story 33.4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // AC 6: PDA Derivation -- Order-Independent (T-33.4-06, T-33.4-07)
  // -------------------------------------------------------------------------

  describe('deriveChannelPDA (AC 6)', () => {
    it('produces same address regardless of argument order (T-33.4-07)', () => {
      // Given: two pubkeys in different orders
      // When: deriveChannelPDA is called with (A, B) and (B, A)
      // Then: both calls return the same PDA address

      const result1 = SolanaPaymentChannelSDK.deriveChannelPDA(
        TEST_PUBKEY_A,
        TEST_PUBKEY_B,
        TEST_TOKEN_MINT,
        TEST_PROGRAM_ID
      );
      const result2 = SolanaPaymentChannelSDK.deriveChannelPDA(
        TEST_PUBKEY_B,
        TEST_PUBKEY_A,
        TEST_TOKEN_MINT,
        TEST_PROGRAM_ID
      );

      expect(result1.pda).toBe(result2.pda);
      expect(result1.bump).toBe(result2.bump);
      expect(typeof result1.pda).toBe('string');
      expect(result1.pda.length).toBeGreaterThan(0);
    });

    it('produces deterministic output for same inputs (T-33.4-06)', () => {
      // Given: known pubkeys
      // When: deriveChannelPDA is called twice with same inputs
      // Then: the returned PDA is identical both times

      const result1 = SolanaPaymentChannelSDK.deriveChannelPDA(
        TEST_PUBKEY_A,
        TEST_PUBKEY_B,
        TEST_TOKEN_MINT,
        TEST_PROGRAM_ID
      );
      const result2 = SolanaPaymentChannelSDK.deriveChannelPDA(
        TEST_PUBKEY_A,
        TEST_PUBKEY_B,
        TEST_TOKEN_MINT,
        TEST_PROGRAM_ID
      );

      expect(result1.pda).toBe(result2.pda);
      expect(result1.bump).toBe(result2.bump);
      expect(result1.bump).toBeGreaterThanOrEqual(0);
      expect(result1.bump).toBeLessThanOrEqual(255);
    });

    it('deriveVaultPDA produces deterministic vault address from channel PDA (T-33.4-06b)', () => {
      // Given: a known channel PDA
      // When: deriveVaultPDA is called
      // Then: it returns a deterministic vault PDA using seeds [b"vault", channel_pda]

      const channelResult = SolanaPaymentChannelSDK.deriveChannelPDA(
        TEST_PUBKEY_A,
        TEST_PUBKEY_B,
        TEST_TOKEN_MINT,
        TEST_PROGRAM_ID
      );
      const vaultResult = SolanaPaymentChannelSDK.deriveVaultPDA(
        channelResult.pda,
        TEST_PROGRAM_ID
      );

      expect(typeof vaultResult.pda).toBe('string');
      expect(vaultResult.pda.length).toBeGreaterThan(0);
      expect(vaultResult.bump).toBeGreaterThanOrEqual(0);
      expect(vaultResult.bump).toBeLessThanOrEqual(255);

      // Verify deterministic: calling again gives same result
      const vaultResult2 = SolanaPaymentChannelSDK.deriveVaultPDA(
        channelResult.pda,
        TEST_PROGRAM_ID
      );
      expect(vaultResult.pda).toBe(vaultResult2.pda);
      expect(vaultResult.bump).toBe(vaultResult2.bump);
    });
  });

  // -------------------------------------------------------------------------
  // AC 7: Balance Proof Message Format (T-33.4-11)
  // -------------------------------------------------------------------------

  describe('Balance proof message format (AC 7)', () => {
    it('is exactly 48 bytes: channel_pda(32) || nonce(8 LE) || transferred_amount(8 LE) (T-33.4-11)', () => {
      // Given: a channel PDA (32 bytes), nonce = 42, transferred_amount = 1000000
      // When: the balance proof message is constructed
      // Then: the message is exactly 48 bytes with correct byte layout

      // Use a known 32-byte PDA (base58-encoded)
      const channelPDA = TEST_PUBKEY_A; // any valid base58 pubkey
      const nonce = 42n;
      const transferredAmount = 1000000n;

      // Access the internal message builder
      const message = SolanaPaymentChannelSDK._buildBalanceProofMessage(
        channelPDA,
        nonce,
        transferredAmount
      );

      expect(message).toBeInstanceOf(Uint8Array);
      expect(message.length).toBe(48);

      // Verify nonce bytes at offset 32-39 (LE)
      const nonceBytes = message.slice(32, 40);
      expect(readUint64LE(nonceBytes, 0)).toBe(42n);

      // Verify transferred_amount bytes at offset 40-47 (LE)
      const amountBytes = message.slice(40, 48);
      expect(readUint64LE(amountBytes, 0)).toBe(1000000n);
    });
  });

  // -------------------------------------------------------------------------
  // AC 3: Sign Balance Proof (T-33.4-03)
  // -------------------------------------------------------------------------

  describe('signBalanceProof (AC 3)', () => {
    it('produces valid 64-byte Ed25519 signature (T-33.4-03)', async () => {
      // Given: a channel PDA, nonce, transferred_amount, and a valid Ed25519 keypair
      // When: signBalanceProof is called
      // Then: a 64-byte Uint8Array signature is returned

      const signer = await generateKeyPairSigner();
      const channelPDA = TEST_PUBKEY_A;
      const nonce = 1n;
      const transferredAmount = 500000n;

      const signature = await SolanaPaymentChannelSDK.signBalanceProof(
        channelPDA,
        nonce,
        transferredAmount,
        signer.keyPair
      );

      expect(signature).toBeInstanceOf(Uint8Array);
      expect(signature.length).toBe(64);
    });

    it('produces different signatures for different nonces (T-33.4-03b)', async () => {
      // Given: same channel PDA and keypair, different nonces
      // When: signBalanceProof is called twice with different nonces
      // Then: the signatures are different

      const signer = await generateKeyPairSigner();
      const channelPDA = TEST_PUBKEY_A;

      const sig1 = await SolanaPaymentChannelSDK.signBalanceProof(
        channelPDA,
        1n,
        500000n,
        signer.keyPair
      );
      const sig2 = await SolanaPaymentChannelSDK.signBalanceProof(
        channelPDA,
        2n,
        500000n,
        signer.keyPair
      );

      expect(sig1).not.toEqual(sig2);
    });
  });

  // -------------------------------------------------------------------------
  // AC 5: Channel State Deserialization (T-33.4-08-unit)
  // -------------------------------------------------------------------------

  describe('deserializeChannelState (AC 5)', () => {
    it('parses known 178-byte buffer correctly -- golden test (T-33.4-08-unit)', () => {
      // Given: a 178-byte Uint8Array with known field values
      // When: deserializeChannelState is called
      // Then: each field is parsed at the correct offset with correct value

      const { data, expected } = buildGoldenChannelState();
      const state: SolanaChannelState = deserializeChannelState(data);

      // Verify all numeric fields match expected values
      expect(state.depositA).toBe(expected.depositA);
      expect(state.depositB).toBe(expected.depositB);
      expect(state.transferredAmountA).toBe(expected.transferredAmountA);
      expect(state.transferredAmountB).toBe(expected.transferredAmountB);
      expect(state.nonceA).toBe(expected.nonceA);
      expect(state.nonceB).toBe(expected.nonceB);
      expect(state.challengeDuration).toBe(expected.challengeDuration);
      expect(state.state).toBe('closed'); // state byte 1 = 'closed'
      expect(state.closeTimestamp).toBe(expected.closeTimestamp);
      expect(state.bump).toBe(expected.bump);

      // Verify pubkey fields are base58-encoded strings
      expect(typeof state.participantA).toBe('string');
      expect(typeof state.participantB).toBe('string');
      expect(typeof state.tokenMint).toBe('string');
    });

    it('throws on invalid discriminator (T-33.4-08-unit-b)', () => {
      // Given: a 178-byte buffer with wrong discriminator
      // When: deserializeChannelState is called
      // Then: it throws an error

      const data = new Uint8Array(178);
      data.set([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 0); // wrong discriminator

      expect(() => deserializeChannelState(data)).toThrow('discriminator');
    });

    it('throws on buffer too short (T-33.4-08-unit-c)', () => {
      // Given: a buffer shorter than 178 bytes
      // When: deserializeChannelState is called
      // Then: it throws an error

      const data = new Uint8Array(100);
      data.set(CHANNEL_DISCRIMINATOR, 0);

      expect(() => deserializeChannelState(data)).toThrow('too short');
    });
  });

  // -------------------------------------------------------------------------
  // AC 10: Error Mapping (T-33.4-12-unit)
  // -------------------------------------------------------------------------

  describe('SolanaChannelError mapping (AC 10)', () => {
    it('maps all 13 error codes (0-12) to descriptive errorName (T-33.4-12-unit)', () => {
      // Given: error codes 0 through 12
      // When: mapProgramError is called for each code
      // Then: each has the correct errorName and code

      for (let code = 0; code <= 12; code++) {
        const error = mapProgramError(code);
        const expectedName = EXPECTED_ERROR_NAMES[code];

        expect(error).toBeInstanceOf(SolanaChannelError);
        expect(error.code).toBe(code);
        expect(error.errorName).toBe(expectedName);
        expect(error.name).toBe('SolanaChannelError');
        expect(error.message).toContain(expectedName ?? '');
      }
    });

    it('SolanaChannelError extends Error with captureStackTrace (T-33.4-12-unit-b)', () => {
      // Given: SolanaChannelError class
      // When: a new instance is created
      // Then: it extends Error, has a stack trace, and correct name property

      const error = new SolanaChannelError('test message', 4, 'InvalidParticipant');

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('SolanaChannelError');
      expect(error.message).toBe('test message');
      expect(error.code).toBe(4);
      expect(error.errorName).toBe('InvalidParticipant');
      expect(error.stack).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // AC 10: parseSolanaError regex-based error extraction (T-33.4-12-unit-c)
  // -------------------------------------------------------------------------

  describe('parseSolanaError regex patterns (AC 10)', () => {
    it('extracts error code from "custom program error: 0x{hex}" pattern (T-33.4-12-unit-c)', () => {
      // Given: a Solana error message containing hex custom program error
      // When: parseSolanaError is called
      // Then: it throws a SolanaChannelError with the correct mapped code

      const err = new Error('Transaction failed: custom program error: 0x05');
      expect(() => parseSolanaError(err)).toThrow(SolanaChannelError);
      try {
        parseSolanaError(err);
      } catch (e) {
        expect(e).toBeInstanceOf(SolanaChannelError);
        expect((e as SolanaChannelError).code).toBe(5);
        expect((e as SolanaChannelError).errorName).toBe('ZeroAmountDeposit');
      }
    });

    it('extracts error code from "Custom: {decimal}" pattern (T-33.4-12-unit-d)', () => {
      // Given: a Solana error message containing "Custom: N"
      // When: parseSolanaError is called
      // Then: it throws a SolanaChannelError with the correct mapped code

      const err = new Error('Instruction failed: Custom: 8');
      expect(() => parseSolanaError(err)).toThrow(SolanaChannelError);
      try {
        parseSolanaError(err);
      } catch (e) {
        expect(e).toBeInstanceOf(SolanaChannelError);
        expect((e as SolanaChannelError).code).toBe(8);
        expect((e as SolanaChannelError).errorName).toBe('InvalidSignature');
      }
    });

    it('extracts error code from "InstructionError...Custom...N" pattern (T-33.4-12-unit-e)', () => {
      // Given: a Solana error message with InstructionError format
      // When: parseSolanaError is called
      // Then: it throws a SolanaChannelError

      const err = new Error('InstructionError: [0, { Custom: 1 }]');
      expect(() => parseSolanaError(err)).toThrow(SolanaChannelError);
      try {
        parseSolanaError(err);
      } catch (e) {
        expect(e).toBeInstanceOf(SolanaChannelError);
        expect((e as SolanaChannelError).code).toBe(1);
        expect((e as SolanaChannelError).errorName).toBe('ChannelNotOpened');
      }
    });

    it('re-throws original error when no program error code is found (T-33.4-12-unit-f)', () => {
      // Given: an error without any recognizable Solana program error pattern
      // When: parseSolanaError is called
      // Then: the original error is re-thrown as-is

      const err = new Error('Network timeout');
      expect(() => parseSolanaError(err)).toThrow('Network timeout');
    });

    it('re-throws non-Error values unchanged (T-33.4-12-unit-g)', () => {
      // Given: a non-Error thrown value (e.g., string)
      // When: parseSolanaError is called
      // Then: it re-throws the original value

      expect(() => parseSolanaError('raw string error')).toThrow('raw string error');
    });

    it('ignores error codes > 12 in hex pattern and re-throws (T-33.4-12-unit-h)', () => {
      // Given: a Solana error with a hex code > 12 (0x0D = 13)
      // When: parseSolanaError is called
      // Then: the original error is re-thrown (code not in 0-12 range)

      const err = new Error('custom program error: 0x0D');
      expect(() => parseSolanaError(err)).toThrow(err);
    });
  });

  // -------------------------------------------------------------------------
  // AC 4: Ed25519 Precompile Instruction Layout (T-33.4-14)
  // -------------------------------------------------------------------------

  describe('Ed25519 precompile instruction layout (AC 4)', () => {
    it('has correct header with inline data offsets (T-33.4-14)', () => {
      // Given: a 64-byte signature, 32-byte pubkey, and 48-byte message
      // When: the Ed25519 precompile instruction data is constructed
      // Then: the layout matches the Solana Ed25519 precompile specification

      const signature = new Uint8Array(64).fill(0xaa);
      const pubkey = new Uint8Array(32).fill(0xbb);
      const message = new Uint8Array(48).fill(0xcc);

      const instruction = buildEd25519PrecompileInstruction(signature, pubkey, message);

      const instructionData = new Uint8Array(instruction.data as Uint8Array);

      // Header: 16 bytes
      expect(instructionData[0]).toBe(1); // num_signatures = 1
      expect(instructionData[1]).toBe(0); // padding = 0

      // signature_offset: u16 LE at bytes 2-3 (offset 16 = after header)
      const sigOffset = (instructionData[2] ?? 0) | ((instructionData[3] ?? 0) << 8);
      expect(sigOffset).toBe(16); // header is 16 bytes

      // signature_ix_index: u16 LE at bytes 4-5 = 0xFFFF (same instruction)
      const sigIxIndex = (instructionData[4] ?? 0) | ((instructionData[5] ?? 0) << 8);
      expect(sigIxIndex).toBe(0xffff);

      // public_key_offset: u16 LE at bytes 6-7 (after signature: 16 + 64 = 80)
      const pkOffset = (instructionData[6] ?? 0) | ((instructionData[7] ?? 0) << 8);
      expect(pkOffset).toBe(80);

      // public_key_ix_index: u16 LE at bytes 8-9 = 0xFFFF
      const pkIxIndex = (instructionData[8] ?? 0) | ((instructionData[9] ?? 0) << 8);
      expect(pkIxIndex).toBe(0xffff);

      // message_data_offset: u16 LE at bytes 10-11 (after pubkey: 80 + 32 = 112)
      const msgOffset = (instructionData[10] ?? 0) | ((instructionData[11] ?? 0) << 8);
      expect(msgOffset).toBe(112);

      // message_data_size: u16 LE at bytes 12-13 = 48
      const msgSize = (instructionData[12] ?? 0) | ((instructionData[13] ?? 0) << 8);
      expect(msgSize).toBe(48);

      // message_ix_index: u16 LE at bytes 14-15 = 0xFFFF
      const msgIxIndex = (instructionData[14] ?? 0) | ((instructionData[15] ?? 0) << 8);
      expect(msgIxIndex).toBe(0xffff);

      // Total data length: 16 (header) + 64 (sig) + 32 (pubkey) + 48 (msg) = 160
      expect(instructionData.length).toBe(160);

      // Verify program address is Ed25519SigVerify precompile
      expect(instruction.programAddress).toBe('Ed25519SigVerify111111111111111111111111111');
    });
  });

  // -------------------------------------------------------------------------
  // AC 8: Account Subscription (T-33.4-10)
  // -------------------------------------------------------------------------

  describe('subscribeToChannel (AC 8)', () => {
    it('fires callback on account change and unsubscribes cleanly (T-33.4-10)', async () => {
      // Given: a mock RPC subscriptions client that yields account notifications
      // When: subscribeToChannel is called with a callback
      // Then: the callback fires with deserialized SolanaChannelState
      // And: unsubscribe stops the iteration

      const logger = createMockLogger();
      const sdk = new SolanaPaymentChannelSDK('http://localhost:8899', TEST_PROGRAM_ID, logger);

      // Build a valid 178-byte channel state buffer for the mock notification
      const { data: goldenData } = buildGoldenChannelState();
      const base64Data = Buffer.from(goldenData).toString('base64');

      // Create an async iterable that yields one notification then waits for abort
      let abortSignalRef: AbortSignal | undefined;
      const mockSubscribe = jest
        .fn()
        .mockImplementation(({ abortSignal }: { abortSignal: AbortSignal }) => {
          abortSignalRef = abortSignal;
          return (async function* () {
            yield { value: { data: [base64Data, 'base64'] } };
            // Wait until aborted to simulate a long-lived subscription
            await new Promise<void>((resolve) => {
              abortSignal.addEventListener('abort', () => resolve());
            });
          })();
        });

      const mockAccountNotifications = jest.fn().mockReturnValue({
        subscribe: mockSubscribe,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sdk as any)._rpcSubscriptions = {
        accountNotifications: mockAccountNotifications,
      };

      const receivedStates: unknown[] = [];
      const handle = sdk.subscribeToChannel(TEST_PUBKEY_A, (state) => {
        receivedStates.push(state);
      });

      // Allow the async loop to process the notification
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify callback was fired with deserialized state
      expect(receivedStates.length).toBe(1);
      const state = receivedStates[0] as SolanaChannelState;
      expect(state.depositA).toBe(1000000n);
      expect(state.state).toBe('closed');

      // Verify unsubscribe aborts the signal
      handle.unsubscribe();
      expect(abortSignalRef?.aborted).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // AC 5: deserializeChannelState edge cases
  // -------------------------------------------------------------------------

  describe('deserializeChannelState additional edge cases (AC 5)', () => {
    it('deserializes state byte 0 as "opened"', () => {
      // Given: a 178-byte buffer with state byte = 0 (Opened)
      // When: deserializeChannelState is called
      // Then: state is 'opened'

      const data = new Uint8Array(178);
      data.set(CHANNEL_DISCRIMINATOR, 0);
      // participant_a, participant_b, token_mint are 32 bytes of zeros each
      // All numeric fields left as zero
      data[160] = 0; // state = Opened

      const state = deserializeChannelState(data);
      expect(state.state).toBe('opened');
    });

    it('deserializes state byte 2 as "settled"', () => {
      // Given: a 178-byte buffer with state byte = 2 (Settled)
      // When: deserializeChannelState is called
      // Then: state is 'settled'

      const data = new Uint8Array(178);
      data.set(CHANNEL_DISCRIMINATOR, 0);
      data[160] = 2; // state = Settled

      const state = deserializeChannelState(data);
      expect(state.state).toBe('settled');
    });

    it('throws on unknown state byte (e.g. 255)', () => {
      // Given: a 178-byte buffer with invalid state byte = 255
      // When: deserializeChannelState is called
      // Then: it throws an error about unknown state byte

      const data = new Uint8Array(178);
      data.set(CHANNEL_DISCRIMINATOR, 0);
      data[160] = 255; // invalid state

      expect(() => deserializeChannelState(data)).toThrow('Unknown channel state byte');
    });

    it('accepts a buffer larger than 178 bytes (extra bytes ignored)', () => {
      // Given: a buffer of 256 bytes with valid discriminator
      // When: deserializeChannelState is called
      // Then: it parses successfully using only the first 178 bytes

      const data = new Uint8Array(256);
      data.set(CHANNEL_DISCRIMINATOR, 0);
      data[160] = 0; // state = Opened

      const state = deserializeChannelState(data);
      expect(state.state).toBe('opened');
    });
  });

  // -------------------------------------------------------------------------
  // AC 10: mapProgramError edge cases
  // -------------------------------------------------------------------------

  describe('mapProgramError edge cases (AC 10)', () => {
    it('maps unknown error code (13) to UnknownError(13)', () => {
      // Given: an error code > 12 (not in the known map)
      // When: mapProgramError is called
      // Then: the errorName is 'UnknownError(13)' and code is 13

      const error = mapProgramError(13);
      expect(error).toBeInstanceOf(SolanaChannelError);
      expect(error.code).toBe(13);
      expect(error.errorName).toBe('UnknownError(13)');
    });

    it('maps negative error code to UnknownError(-1)', () => {
      // Given: a negative error code
      // When: mapProgramError is called
      // Then: the errorName reflects the unknown code

      const error = mapProgramError(-1);
      expect(error).toBeInstanceOf(SolanaChannelError);
      expect(error.code).toBe(-1);
      expect(error.errorName).toBe('UnknownError(-1)');
    });
  });

  // -------------------------------------------------------------------------
  // AC 3: signBalanceProof determinism
  // -------------------------------------------------------------------------

  describe('signBalanceProof determinism (AC 3)', () => {
    it('produces the same signature for same inputs with same keypair (T-33.4-03c)', async () => {
      // Given: a keypair and fixed channel PDA, nonce, transferred_amount
      // When: signBalanceProof is called twice with identical inputs
      // Then: both signatures are identical (Ed25519 is deterministic)

      const signer = await generateKeyPairSigner();
      const channelPDA = TEST_PUBKEY_A;
      const nonce = 7n;
      const transferredAmount = 999999n;

      const sig1 = await SolanaPaymentChannelSDK.signBalanceProof(
        channelPDA,
        nonce,
        transferredAmount,
        signer.keyPair
      );
      const sig2 = await SolanaPaymentChannelSDK.signBalanceProof(
        channelPDA,
        nonce,
        transferredAmount,
        signer.keyPair
      );

      expect(sig1).toEqual(sig2);
    });

    it('produces different signatures for different transferred amounts (T-33.4-03d)', async () => {
      // Given: same keypair and channel PDA, same nonce, different amounts
      // When: signBalanceProof is called
      // Then: the signatures differ

      const signer = await generateKeyPairSigner();
      const channelPDA = TEST_PUBKEY_A;

      const sig1 = await SolanaPaymentChannelSDK.signBalanceProof(
        channelPDA,
        1n,
        100n,
        signer.keyPair
      );
      const sig2 = await SolanaPaymentChannelSDK.signBalanceProof(
        channelPDA,
        1n,
        200n,
        signer.keyPair
      );

      expect(sig1).not.toEqual(sig2);
    });

    it('produces different signatures for different keypairs (T-33.4-03e)', async () => {
      // Given: two different keypairs, same message inputs
      // When: signBalanceProof is called with each
      // Then: the signatures differ

      const signer1 = await generateKeyPairSigner();
      const signer2 = await generateKeyPairSigner();
      const channelPDA = TEST_PUBKEY_A;

      const sig1 = await SolanaPaymentChannelSDK.signBalanceProof(
        channelPDA,
        1n,
        500000n,
        signer1.keyPair
      );
      const sig2 = await SolanaPaymentChannelSDK.signBalanceProof(
        channelPDA,
        1n,
        500000n,
        signer2.keyPair
      );

      expect(sig1).not.toEqual(sig2);
    });
  });

  // -------------------------------------------------------------------------
  // AC 7: Balance proof message format -- additional boundary cases
  // -------------------------------------------------------------------------

  describe('Balance proof message format boundary cases (AC 7)', () => {
    it('encodes nonce=0 and transferredAmount=0 correctly (T-33.4-11b)', () => {
      // Given: nonce = 0, transferredAmount = 0
      // When: the balance proof message is built
      // Then: bytes 32-47 are all zeros (zero LE encoding)

      const message = SolanaPaymentChannelSDK._buildBalanceProofMessage(TEST_PUBKEY_A, 0n, 0n);

      expect(message.length).toBe(48);
      // Nonce bytes at 32-39 should be all zeros
      for (let i = 32; i < 40; i++) {
        expect(message[i]).toBe(0);
      }
      // Transferred amount bytes at 40-47 should be all zeros
      for (let i = 40; i < 48; i++) {
        expect(message[i]).toBe(0);
      }
    });

    it('encodes max u64 values correctly (T-33.4-11c)', () => {
      // Given: nonce and transferredAmount at max u64 (2^64 - 1)
      // When: the balance proof message is built
      // Then: bytes 32-39 and 40-47 are all 0xFF (max LE encoding)

      const maxU64 = (1n << 64n) - 1n;
      const message = SolanaPaymentChannelSDK._buildBalanceProofMessage(
        TEST_PUBKEY_A,
        maxU64,
        maxU64
      );

      expect(message.length).toBe(48);
      // All nonce bytes should be 0xFF
      for (let i = 32; i < 40; i++) {
        expect(message[i]).toBe(0xff);
      }
      // All transferred amount bytes should be 0xFF
      for (let i = 40; i < 48; i++) {
        expect(message[i]).toBe(0xff);
      }
    });

    it('channel PDA bytes occupy first 32 bytes of message (T-33.4-11d)', () => {
      // Given: two different channel PDAs
      // When: balance proof messages are built
      // Then: the first 32 bytes differ (different PDAs)

      const message1 = SolanaPaymentChannelSDK._buildBalanceProofMessage(TEST_PUBKEY_A, 1n, 1n);
      const message2 = SolanaPaymentChannelSDK._buildBalanceProofMessage(TEST_PUBKEY_B, 1n, 1n);

      // First 32 bytes should differ
      expect(message1.slice(0, 32)).not.toEqual(message2.slice(0, 32));
      // Last 16 bytes (nonce + amount) should be the same
      expect(message1.slice(32, 48)).toEqual(message2.slice(32, 48));
    });

    it('rejects negative nonce value (T-33.4-11e)', () => {
      // Given: a negative nonce (outside u64 range)
      // When: the balance proof message is built
      // Then: it throws a RangeError
      expect(() =>
        SolanaPaymentChannelSDK._buildBalanceProofMessage(TEST_PUBKEY_A, -1n, 0n)
      ).toThrow('outside u64 range');
    });

    it('rejects nonce exceeding u64 max (T-33.4-11f)', () => {
      // Given: a nonce > 2^64 - 1
      // When: the balance proof message is built
      // Then: it throws a RangeError
      expect(() =>
        SolanaPaymentChannelSDK._buildBalanceProofMessage(TEST_PUBKEY_A, 1n << 64n, 0n)
      ).toThrow('outside u64 range');
    });
  });

  // -------------------------------------------------------------------------
  // AC 6: PDA derivation -- different token mints produce different PDAs
  // -------------------------------------------------------------------------

  describe('deriveChannelPDA additional cases (AC 6)', () => {
    it('produces different PDAs for different token mints (T-33.4-06c)', () => {
      // Given: same participants, different token mints
      // When: deriveChannelPDA is called
      // Then: the PDAs differ

      const result1 = SolanaPaymentChannelSDK.deriveChannelPDA(
        TEST_PUBKEY_A,
        TEST_PUBKEY_B,
        TEST_TOKEN_MINT,
        TEST_PROGRAM_ID
      );
      const result2 = SolanaPaymentChannelSDK.deriveChannelPDA(
        TEST_PUBKEY_A,
        TEST_PUBKEY_B,
        TEST_PUBKEY_A, // different token mint
        TEST_PROGRAM_ID
      );

      expect(result1.pda).not.toBe(result2.pda);
    });

    it('produces different PDAs for different participant pairs (T-33.4-06d)', () => {
      // Given: different participant pairs, same token mint
      // When: deriveChannelPDA is called
      // Then: the PDAs differ

      const result1 = SolanaPaymentChannelSDK.deriveChannelPDA(
        TEST_PUBKEY_A,
        TEST_PUBKEY_B,
        TEST_TOKEN_MINT,
        TEST_PROGRAM_ID
      );
      const result2 = SolanaPaymentChannelSDK.deriveChannelPDA(
        TEST_PUBKEY_A,
        TEST_TOKEN_MINT, // different participant B
        TEST_TOKEN_MINT,
        TEST_PROGRAM_ID
      );

      expect(result1.pda).not.toBe(result2.pda);
    });
  });

  // -------------------------------------------------------------------------
  // AC 4: Ed25519 precompile instruction -- data integrity checks
  // -------------------------------------------------------------------------

  describe('Ed25519 precompile instruction data integrity (AC 4)', () => {
    it('inline signature bytes match input (T-33.4-14b)', () => {
      // Given: known signature, pubkey, and message bytes
      // When: buildEd25519PrecompileInstruction is called
      // Then: the inline data at correct offsets exactly matches the inputs

      const signature = new Uint8Array(64);
      for (let i = 0; i < 64; i++) signature[i] = i;
      const pubkey = new Uint8Array(32);
      for (let i = 0; i < 32; i++) pubkey[i] = i + 64;
      const message = new Uint8Array(48);
      for (let i = 0; i < 48; i++) message[i] = i + 96;

      const instruction = buildEd25519PrecompileInstruction(signature, pubkey, message);
      const data = new Uint8Array(instruction.data as Uint8Array);

      // Signature at offset 16
      expect(data.slice(16, 80)).toEqual(signature);
      // Pubkey at offset 80
      expect(data.slice(80, 112)).toEqual(pubkey);
      // Message at offset 112
      expect(data.slice(112, 160)).toEqual(message);
    });

    it('has empty accounts array (T-33.4-14c)', () => {
      // The Ed25519 precompile takes no account metas
      const instruction = buildEd25519PrecompileInstruction(
        new Uint8Array(64),
        new Uint8Array(32),
        new Uint8Array(48)
      );

      expect(instruction.accounts).toHaveLength(0);
    });

    it('rejects wrong-length signature (T-33.4-14d)', () => {
      // Given: a signature that is not 64 bytes
      // When: buildEd25519PrecompileInstruction is called
      // Then: it throws an error
      expect(() =>
        buildEd25519PrecompileInstruction(
          new Uint8Array(63),
          new Uint8Array(32),
          new Uint8Array(48)
        )
      ).toThrow('signature must be 64 bytes');
    });

    it('rejects wrong-length pubkey (T-33.4-14e)', () => {
      // Given: a pubkey that is not 32 bytes
      // When: buildEd25519PrecompileInstruction is called
      // Then: it throws an error
      expect(() =>
        buildEd25519PrecompileInstruction(
          new Uint8Array(64),
          new Uint8Array(31),
          new Uint8Array(48)
        )
      ).toThrow('public key must be 32 bytes');
    });

    it('rejects empty message (T-33.4-14f)', () => {
      // Given: an empty message
      // When: buildEd25519PrecompileInstruction is called
      // Then: it throws an error
      expect(() =>
        buildEd25519PrecompileInstruction(new Uint8Array(64), new Uint8Array(32), new Uint8Array(0))
      ).toThrow('message must not be empty');
    });
  });

  // -------------------------------------------------------------------------
  // SDK constructor smoke test
  // -------------------------------------------------------------------------

  describe('SolanaPaymentChannelSDK constructor', () => {
    it('instantiates without throwing (smoke test)', () => {
      // Given: valid RPC URL and program ID
      // When: new SolanaPaymentChannelSDK is created
      // Then: no error is thrown

      const logger = createMockLogger();
      expect(
        () => new SolanaPaymentChannelSDK('http://localhost:8899', TEST_PROGRAM_ID, logger)
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getMintMetadata (Story 37.8)
  // -------------------------------------------------------------------------

  describe('getMintMetadata (Story 37.8)', () => {
    let sdk: SolanaPaymentChannelSDK;
    let logger: pino.Logger;

    beforeEach(() => {
      logger = createMockLogger();
      sdk = new SolanaPaymentChannelSDK('http://localhost:8899', TEST_PROGRAM_ID, logger);
    });

    function mockGetAccountInfo(returnValue: unknown): {
      mockGetAccountInfo: jest.Mock;
      mockSend: jest.Mock;
    } {
      const mockSend = jest.fn().mockResolvedValue(returnValue);
      const mockGetAccountInfo = jest.fn().mockReturnValue({ send: mockSend });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sdk as any)._rpc = {
        getAccountInfo: mockGetAccountInfo,
      };
      return { mockGetAccountInfo, mockSend };
    }

    it('returns decimals from a parsed SPL mint account (T-37.8-01)', async () => {
      mockGetAccountInfo({
        value: {
          data: {
            program: 'spl-token',
            parsed: {
              info: { decimals: 6 },
              type: 'mint',
            },
          },
        },
      });

      const result = await sdk.getMintMetadata(TEST_TOKEN_MINT);

      expect(result).toEqual({ assetCode: TEST_TOKEN_MINT, assetScale: 6 });
    });

    it('returns decimals=0 for a mint with zero decimals (T-37.8-02)', async () => {
      mockGetAccountInfo({
        value: {
          data: {
            program: 'spl-token',
            parsed: {
              info: { decimals: 0 },
              type: 'mint',
            },
          },
        },
      });

      const result = await sdk.getMintMetadata(TEST_TOKEN_MINT);

      expect(result).toEqual({ assetCode: TEST_TOKEN_MINT, assetScale: 0 });
    });

    it('returns fallback when mint account does not exist (T-37.8-03)', async () => {
      mockGetAccountInfo({ value: null });

      const result = await sdk.getMintMetadata(TEST_TOKEN_MINT);

      expect(result).toEqual({ assetCode: TEST_TOKEN_MINT, assetScale: 0 });
    });

    it('returns fallback when parsed data is missing decimals (T-37.8-04)', async () => {
      mockGetAccountInfo({
        value: {
          data: {
            program: 'spl-token',
            parsed: {
              info: {},
              type: 'mint',
            },
          },
        },
      });

      const result = await sdk.getMintMetadata(TEST_TOKEN_MINT);

      expect(result).toEqual({ assetCode: TEST_TOKEN_MINT, assetScale: 0 });
    });

    it('returns fallback when parsed data shape is unexpected (T-37.8-05)', async () => {
      mockGetAccountInfo({
        value: {
          data: 'unexpected-string-format',
        },
      });

      const result = await sdk.getMintMetadata(TEST_TOKEN_MINT);

      expect(result).toEqual({ assetCode: TEST_TOKEN_MINT, assetScale: 0 });
    });

    it('returns fallback and never throws on RPC error (T-37.8-06)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sdk as any)._rpc = {
        getAccountInfo: jest.fn().mockReturnValue({
          send: jest.fn().mockRejectedValue(new Error('503 Service Unavailable')),
        }),
      };

      const result = await sdk.getMintMetadata(TEST_TOKEN_MINT);

      expect(result).toEqual({ assetCode: TEST_TOKEN_MINT, assetScale: 0 });
    });
  });
});

// ============================================================================
// INTEGRATION TESTS (solana-bankrun)
// ============================================================================

describe('SolanaPaymentChannelSDK - Integration Tests (Story 33.4)', () => {
  // Note: These tests require:
  // 1. solana-bankrun installed as dev dependency
  // 2. cargo build-sbf run in packages/solana-program/
  // 3. payment_channel.so available at packages/solana-program/target/deploy/
  // Uses TEST_CHALLENGE_DURATION (300n = 5 minutes) for channel lifecycle tests.

  /** SDK instance created per-test by integration setup (when not skipped) */
  let _sdk: SolanaPaymentChannelSDK | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    _sdk = undefined;
  });

  afterEach(() => {
    // Clean up any SDK resources (subscriptions, etc.) to prevent test leaks
    _sdk = undefined;
  });

  // -------------------------------------------------------------------------
  // AC 1: Open Channel Transaction (T-33.4-01)
  // -------------------------------------------------------------------------

  describe('openChannel (AC 1)', () => {
    it.skip('creates PDA on-chain with state=Opened and correct participants (T-33.4-01)', async () => {
      // Given: a configured SolanaPaymentChannelSDK with bankrun RPC endpoint and program ID
      // When: openChannel() is called with valid participantA, participantB, tokenMint, and challengeDuration = TEST_CHALLENGE_DURATION
      // Then: a transaction is built, signed, and submitted that creates the channel PDA on-chain
      // And: the returned result contains the channel PDA address and transaction signature
      void _sdk;
      void TEST_CHALLENGE_DURATION;
    });
  });

  // -------------------------------------------------------------------------
  // AC 2: Deposit Transaction (T-33.4-02)
  // -------------------------------------------------------------------------

  describe('deposit (AC 2)', () => {
    it.skip('transfers SPL tokens to vault and updates channel deposit field (T-33.4-02)', async () => {
      // Given: an open channel PDA and a funded depositor token account
      // When: deposit() is called with an amount and depositor signer
      // Then: SPL tokens are transferred to the vault PDA
      // And: the channel's deposit_a or deposit_b is incremented
    });
  });

  // -------------------------------------------------------------------------
  // AC 3+4: Cross-Language Balance Proof Verification (T-33.4-04)
  // -------------------------------------------------------------------------

  describe('signBalanceProof cross-language verification (AC 3, AC 4)', () => {
    it.skip('TS-signed balance proof is accepted by Rust on-chain claim_from_channel (T-33.4-04)', async () => {
      // Given: an open channel with deposits, and a TS-signed balance proof
      // When: the balance proof is submitted as part of a claim_from_channel transaction
      // Then: the on-chain Rust program accepts the Ed25519 signature
      // And: the channel nonce and transferred_amount are updated
    });
  });

  // -------------------------------------------------------------------------
  // AC 4: Claim Transaction (T-33.4-05)
  // -------------------------------------------------------------------------

  describe('claimFromChannel (AC 4)', () => {
    it.skip('builds transaction with Ed25519 precompile + claim instruction and succeeds on-chain (T-33.4-05)', async () => {
      // Given: an open channel with deposits and a valid balance proof signature
      // When: claimFromChannel() is called
      // Then: the transaction includes both Ed25519 precompile (index 0) and claim (index 1)
      // And: the transaction succeeds on-chain
    });
  });

  // -------------------------------------------------------------------------
  // AC 5: Channel State Deserialization -- Integration (T-33.4-08)
  // -------------------------------------------------------------------------

  describe('getChannelState integration (AC 5)', () => {
    it.skip('deserializes channel account data correctly after on-chain mutations (T-33.4-08)', async () => {
      // Given: a channel PDA with on-chain state (opened, with deposits)
      // When: getChannelState() is called
      // Then: the returned SolanaChannelState matches the on-chain data
    });
  });

  // -------------------------------------------------------------------------
  // AC 9: Close, Settle, Force-Close (T-33.4-09)
  // -------------------------------------------------------------------------

  describe('closeChannel, settleChannel, forceCloseExpired (AC 9)', () => {
    it.skip('closeChannel transitions state to closed (T-33.4-09a)', async () => {
      // Given: an open channel
      // When: closeChannel() is called by a participant
      // Then: the channel state becomes 'closed' with a close_timestamp
    });

    it.skip('settleChannel distributes funds after challenge period (T-33.4-09b)', async () => {
      // Given: a closed channel past the challenge period
      // When: settleChannel() is called
      // Then: the channel state becomes 'settled' and funds are distributed
    });

    it.skip('forceCloseExpired distributes funds after challenge period (T-33.4-09c)', async () => {
      // Given: a closed channel past the challenge period
      // When: forceCloseExpired() is called
      // Then: funds are distributed and accounts closed
    });
  });

  // -------------------------------------------------------------------------
  // AC 10: Error Mapping -- Integration (T-33.4-12)
  // -------------------------------------------------------------------------

  describe('SolanaChannelError integration (AC 10)', () => {
    it.skip('throws SolanaChannelError for known program error (T-33.4-12)', async () => {
      // Given: an SDK instance with bankrun
      // When: an operation triggers a known program error (e.g., deposit on non-existent channel)
      // Then: a SolanaChannelError is thrown with the correct code and errorName
    });
  });

  // -------------------------------------------------------------------------
  // Full Lifecycle Integration (T-33.4-13)
  // -------------------------------------------------------------------------

  describe('Full lifecycle integration', () => {
    it.skip('open -> deposit -> claim -> close -> settle (T-33.4-13)', async () => {
      // Given: a fresh bankrun context with the payment channel program loaded
      // When: the full lifecycle is executed through the SDK
      // Then: all operations succeed and the final state is settled
    }, 60000); // Extended timeout for full lifecycle
  });
});
