/**
 * Branch Coverage Tests for SolanaPaymentChannelSDK
 *
 * Targets uncovered branches identified in coverage report:
 * - readInt64LE negative value path (line 173)
 * - sortParticipants equal-address path (line 192)
 * - parseSolanaError InstructionError regex branch (lines 250-252)
 * - Transaction method error paths via parseSolanaError (lines 544-921)
 * - getChannelState data format branches (lines 1007-1030)
 * - Subscription loop error handling (lines 1097-1166)
 * - findProgramDerivedAddressSync no-viable-PDA throw (line 1225)
 * - isOnCurve y >= P branch (line 1251)
 */

import pino from 'pino';
import * as crypto from 'crypto';
import {
  SolanaPaymentChannelSDK,
  SolanaChannelError,
  deserializeChannelState,
  parseSolanaError,
  generateKeyPairSigner,
} from './solana-payment-channel-sdk';

jest.mock('crypto', () => {
  const actual = jest.requireActual<typeof import('crypto')>('crypto');
  return {
    ...actual,
    createHash: jest.fn().mockImplementation(actual.createHash),
  };
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PROGRAM_ID = '11111111111111111111111111111111';
const TEST_PUBKEY_A = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM';
const TEST_PUBKEY_B = 'CiDwVBFgWV9E5MvXWoLgnEgn2hK7rJikbvfWavzAQz3';
const TEST_TOKEN_MINT = 'So11111111111111111111111111111111111111112';
const CHANNEL_DISCRIMINATOR = new Uint8Array([0x70, 0x63, 0x68, 0x61, 0x6e, 0x6e, 0x65, 0x6c]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

/**
 * Create an SDK instance whose private _sendTransaction method throws the
 * supplied error. This lets us exercise every transaction builder's catch
 * block without touching the network.
 */
function createSDKWithSendTransactionError(error: Error): SolanaPaymentChannelSDK {
  const logger = createMockLogger();
  const sdk = new SolanaPaymentChannelSDK('http://localhost:8899', TEST_PROGRAM_ID, logger);
  (sdk as unknown as { _sendTransaction: jest.Mock })._sendTransaction = jest
    .fn()
    .mockRejectedValue(error);
  return sdk;
}

/**
 * Build a minimal 178-byte channel account buffer with the correct discriminator.
 */
function buildMinimalChannelData(
  stateByte: number,
  overrides?: { closeTimestamp?: bigint }
): Uint8Array {
  const data = new Uint8Array(178);
  data.set(CHANNEL_DISCRIMINATOR, 0);
  data[160] = stateByte;
  if (overrides?.closeTimestamp !== undefined) {
    for (let i = 0; i < 8; i++) {
      data[161 + i] = Number((overrides.closeTimestamp >> BigInt(i * 8)) & 0xffn);
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SolanaPaymentChannelSDK - Branch Coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // readInt64LE negative branch (line 173)
  // =========================================================================

  describe('deserializeChannelState negative closeTimestamp', () => {
    it('deserializes negative i64 closeTimestamp (high bit set)', () => {
      // When the high bit is set, readInt64LE subtracts 2^64 to produce a negative value.
      const data = buildMinimalChannelData(0);
      // Write -1n as two's complement (all 0xFF) at offset 161
      for (let i = 161; i < 169; i++) {
        data[i] = 0xff;
      }
      const state = deserializeChannelState(data);
      expect(state.closeTimestamp).toBe(-1n);
    });

    it('deserializes large negative i64 closeTimestamp', () => {
      const data = buildMinimalChannelData(0);
      // Write -42n in two's complement
      const value = -42n;
      const unsigned = value + (1n << 64n);
      for (let i = 0; i < 8; i++) {
        data[161 + i] = Number((unsigned >> BigInt(i * 8)) & 0xffn);
      }
      const state = deserializeChannelState(data);
      expect(state.closeTimestamp).toBe(-42n);
    });
  });

  // =========================================================================
  // sortParticipants equal addresses (line 192)
  // =========================================================================

  describe('sortParticipants equal-address branch', () => {
    it('deriveChannelPDA handles identical participant addresses', () => {
      // When both participants are the same, sortParticipants falls through to
      // the return [a, b] branch after comparing all 32 bytes as equal.
      const result = SolanaPaymentChannelSDK.deriveChannelPDA(
        TEST_PUBKEY_A,
        TEST_PUBKEY_A,
        TEST_TOKEN_MINT,
        TEST_PROGRAM_ID
      );
      expect(result.pda).toBeDefined();
      expect(typeof result.pda).toBe('string');
      expect(result.bump).toBeGreaterThanOrEqual(0);
      expect(result.bump).toBeLessThanOrEqual(255);
    });
  });

  // =========================================================================
  // parseSolanaError InstructionError regex (lines 250-252)
  // =========================================================================

  describe('parseSolanaError InstructionError branch', () => {
    it('matches InstructionError.*Custom pattern without colon prefix', () => {
      // This message matches instructionErrorMatch but NOT customMatch,
      // forcing execution through lines 248-254 (including the inner range check).
      const err = new Error('Transaction failed: InstructionError [0, {Custom 3}]');
      expect(() => parseSolanaError(err)).toThrow(SolanaChannelError);
      try {
        parseSolanaError(err);
      } catch (e) {
        expect((e as SolanaChannelError).code).toBe(3);
        expect((e as SolanaChannelError).errorName).toBe('ChannelChallengeNotExpired');
      }
    });

    it('matches InstructionError.*Custom with code at boundary 12', () => {
      const err = new Error('Simulation: InstructionError [0, {Custom 12}]');
      expect(() => parseSolanaError(err)).toThrow(SolanaChannelError);
      try {
        parseSolanaError(err);
      } catch (e) {
        expect((e as SolanaChannelError).code).toBe(12);
        expect((e as SolanaChannelError).errorName).toBe('InvalidVaultPDA');
      }
    });

    it('ignores InstructionError code > 12 and re-throws', () => {
      const err = new Error('Simulation: InstructionError [0, {Custom 13}]');
      expect(() => parseSolanaError(err)).toThrow(err);
    });
  });

  // =========================================================================
  // Transaction builder error paths (lines 544-921)
  // =========================================================================

  describe('transaction method error paths', () => {
    it('openChannel throws SolanaChannelError on custom program error hex', async () => {
      const sdk = createSDKWithSendTransactionError(
        new Error('Transaction failed: custom program error: 0x04')
      );
      const signer = await generateKeyPairSigner();
      await expect(
        sdk.openChannel(signer, TEST_PUBKEY_A, TEST_PUBKEY_B, TEST_TOKEN_MINT, 300n)
      ).rejects.toBeInstanceOf(SolanaChannelError);
    });

    it('openChannel re-throws unknown errors', async () => {
      const original = new Error('RPC timeout');
      const sdk = createSDKWithSendTransactionError(original);
      const signer = await generateKeyPairSigner();
      await expect(
        sdk.openChannel(signer, TEST_PUBKEY_A, TEST_PUBKEY_B, TEST_TOKEN_MINT, 300n)
      ).rejects.toBe(original);
    });

    it('deposit throws SolanaChannelError on Custom decimal pattern', async () => {
      const sdk = createSDKWithSendTransactionError(new Error('Instruction failed: Custom: 5'));
      const signer = await generateKeyPairSigner();
      await expect(sdk.deposit(signer, TEST_PUBKEY_A, TEST_TOKEN_MINT, 1000n)).rejects.toThrow(
        SolanaChannelError
      );
    });

    it('deposit re-throws unrecognized error', async () => {
      const original = new Error('Insufficient funds');
      const sdk = createSDKWithSendTransactionError(original);
      const signer = await generateKeyPairSigner();
      await expect(sdk.deposit(signer, TEST_PUBKEY_A, TEST_TOKEN_MINT, 1000n)).rejects.toBe(
        original
      );
    });

    it('claimFromChannel throws SolanaChannelError on program error', async () => {
      const sdk = createSDKWithSendTransactionError(new Error('custom program error: 0x08'));
      const signer = await generateKeyPairSigner();
      await expect(
        sdk.claimFromChannel(signer, TEST_PUBKEY_A, 1n, 500n, new Uint8Array(64))
      ).rejects.toThrow(SolanaChannelError);
    });

    it('claimFromChannel re-throws non-program errors', async () => {
      const original = new Error('Blockhash not found');
      const sdk = createSDKWithSendTransactionError(original);
      const signer = await generateKeyPairSigner();
      await expect(
        sdk.claimFromChannel(signer, TEST_PUBKEY_A, 1n, 500n, new Uint8Array(64))
      ).rejects.toBe(original);
    });

    it('closeChannel throws SolanaChannelError on program error', async () => {
      const sdk = createSDKWithSendTransactionError(new Error('Custom: 2'));
      const signer = await generateKeyPairSigner();
      await expect(sdk.closeChannel(signer, TEST_PUBKEY_A)).rejects.toThrow(SolanaChannelError);
    });

    it('closeChannel re-throws original error when unmapped', async () => {
      const original = new Error('Signature verification failed');
      const sdk = createSDKWithSendTransactionError(original);
      const signer = await generateKeyPairSigner();
      await expect(sdk.closeChannel(signer, TEST_PUBKEY_A)).rejects.toBe(original);
    });

    it('settleChannel throws SolanaChannelError on program error', async () => {
      const sdk = createSDKWithSendTransactionError(new Error('custom program error: 0x0A'));
      const signer = await generateKeyPairSigner();
      await expect(
        sdk.settleChannel(signer, TEST_PUBKEY_A, TEST_PUBKEY_B, TEST_TOKEN_MINT, TEST_PUBKEY_A)
      ).rejects.toThrow(SolanaChannelError);
    });

    it('settleChannel re-throws unmapped errors', async () => {
      const original = new Error('Account not found');
      const sdk = createSDKWithSendTransactionError(original);
      const signer = await generateKeyPairSigner();
      await expect(
        sdk.settleChannel(signer, TEST_PUBKEY_A, TEST_PUBKEY_B, TEST_TOKEN_MINT, TEST_PUBKEY_A)
      ).rejects.toBe(original);
    });

    it('forceCloseExpired throws SolanaChannelError on program error', async () => {
      const sdk = createSDKWithSendTransactionError(new Error('Custom: 3'));
      const signer = await generateKeyPairSigner();
      await expect(
        sdk.forceCloseExpired(signer, TEST_PUBKEY_A, TEST_PUBKEY_B, TEST_TOKEN_MINT, TEST_PUBKEY_A)
      ).rejects.toThrow(SolanaChannelError);
    });

    it('forceCloseExpired re-throws non-program errors', async () => {
      const original = new Error('Network unreachable');
      const sdk = createSDKWithSendTransactionError(original);
      const signer = await generateKeyPairSigner();
      await expect(
        sdk.forceCloseExpired(signer, TEST_PUBKEY_A, TEST_PUBKEY_B, TEST_TOKEN_MINT, TEST_PUBKEY_A)
      ).rejects.toBe(original);
    });
  });

  // =========================================================================
  // getChannelState data format branches (lines 1007-1030)
  // =========================================================================

  describe('getChannelState data format branches', () => {
    let sdk: SolanaPaymentChannelSDK;

    beforeEach(() => {
      const logger = createMockLogger();
      sdk = new SolanaPaymentChannelSDK('http://localhost:8899', TEST_PROGRAM_ID, logger);
    });

    function mockRpcAccountInfo(returnValue: unknown) {
      const mockSend = jest.fn().mockResolvedValue(returnValue);
      const mockGetAccountInfo = jest.fn().mockReturnValue({ send: mockSend });
      (sdk as unknown as { _rpc: { getAccountInfo: jest.Mock } })._rpc = {
        getAccountInfo: mockGetAccountInfo,
      } as unknown as { getAccountInfo: jest.Mock };
      return { mockGetAccountInfo, mockSend };
    }

    it('throws when channel account does not exist', async () => {
      mockRpcAccountInfo({ value: null });
      await expect(sdk.getChannelState(TEST_PUBKEY_A)).rejects.toThrow('Channel account not found');
    });

    it('deserializes Uint8Array account data directly', async () => {
      const data = buildMinimalChannelData(0);
      mockRpcAccountInfo({ value: { data } });
      const state = await sdk.getChannelState(TEST_PUBKEY_A);
      expect(state.state).toBe('opened');
    });

    it('deserializes base64 tuple account data', async () => {
      const data = buildMinimalChannelData(1);
      const base64Str = Buffer.from(data).toString('base64');
      mockRpcAccountInfo({ value: { data: [base64Str, 'base64'] } });
      const state = await sdk.getChannelState(TEST_PUBKEY_A);
      expect(state.state).toBe('closed');
    });

    it('throws on unexpected account data format', async () => {
      mockRpcAccountInfo({
        value: {
          data: { unexpected: 'object-shape' },
        },
      });
      await expect(sdk.getChannelState(TEST_PUBKEY_A)).rejects.toThrow(
        'Unexpected account data format'
      );
    });
  });

  // =========================================================================
  // Subscription loop error handling (lines 1097-1166)
  // =========================================================================

  describe('subscribeToChannel error handling', () => {
    it('handles unknown data format, deserialization error, and connection loss', async () => {
      const logger = createMockLogger();
      const sdk = new SolanaPaymentChannelSDK('http://localhost:8899', TEST_PROGRAM_ID, logger);

      const mockAccountNotifications = jest.fn().mockReturnValue({
        subscribe: jest.fn().mockResolvedValue(
          (async function* () {
            // 1) Unknown format -> hits lines 1099-1104 (else branch with continue)
            yield { value: { data: 'random-string-format' } };
            // 2) Deserialization error -> hits lines 1109-1118
            yield { value: { data: new Uint8Array(10) } };
            // 3) Iterable throws -> hits outer catch lines 1125-1128
            throw new Error('Subscription transport error');
          })()
        ),
      });

      (
        sdk as unknown as { _rpcSubscriptions: { accountNotifications: jest.Mock } }
      )._rpcSubscriptions = {
        accountNotifications: mockAccountNotifications,
      };

      const callback = jest.fn();
      const handle = sdk.subscribeToChannel(TEST_PUBKEY_A, callback);

      // Allow the background async loop to consume all notifications and errors.
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Callback should never fire because both notifications were unparseable.
      expect(callback).not.toHaveBeenCalled();

      // Clean up
      handle.unsubscribe();
    });
  });

  // =========================================================================
  // findProgramDerivedAddressSync throw (line 1225)
  // =========================================================================

  describe('findProgramDerivedAddressSync failure branch', () => {
    it('throws when every bump seed produces a point on the Ed25519 curve', () => {
      // By returning all zeros (which we know is on the curve), every bump
      // candidate is rejected, forcing the loop to exhaust and hit line 1225.
      (crypto.createHash as jest.Mock).mockImplementation(
        () =>
          ({
            update: jest.fn(() => ({
              digest: jest.fn(() => Buffer.alloc(32, 0)),
            })),
          }) as unknown as crypto.Hash
      );

      try {
        expect(() =>
          SolanaPaymentChannelSDK.deriveChannelPDA(
            TEST_PUBKEY_A,
            TEST_PUBKEY_B,
            TEST_TOKEN_MINT,
            TEST_PROGRAM_ID
          )
        ).toThrow('Could not find a viable PDA bump seed');
      } finally {
        (crypto.createHash as jest.Mock).mockRestore();
      }
    });
  });

  // =========================================================================
  // isOnCurve y >= P branch (line 1251)
  // =========================================================================

  describe('isOnCurve y >= P branch', () => {
    it('accepts hash with y-coordinate >= P as valid PDA (covers line 1251)', () => {
      // A buffer where the y-coordinate (sign bit cleared) is 2^255 - 1,
      // which is strictly greater than P = 2^255 - 19. isOnCurve returns false
      // at line 1251, so the hash is treated as a valid PDA.
      const hash = Buffer.alloc(32, 0xff);
      hash[31] = 0x7f; // clear sign bit

      (crypto.createHash as jest.Mock).mockImplementation(
        () =>
          ({
            update: jest.fn(() => ({
              digest: jest.fn(() => hash),
            })),
          }) as unknown as crypto.Hash
      );

      try {
        const result = SolanaPaymentChannelSDK.deriveChannelPDA(
          TEST_PUBKEY_A,
          TEST_PUBKEY_B,
          TEST_TOKEN_MINT,
          TEST_PROGRAM_ID
        );
        // Should succeed because the mocked hash is NOT on the curve (y >= P)
        expect(result.pda).toBeDefined();
        expect(typeof result.pda).toBe('string');
      } finally {
        (crypto.createHash as jest.Mock).mockRestore();
      }
    });
  });
});
