/**
 * Solana Payment Channel SDK -- TypeScript Integration
 *
 * Story 33.4: Wraps the on-chain Solana payment channel program (Stories 33.1-33.3)
 * with TypeScript methods using `@solana/kit` v3. This is the Solana equivalent of
 * `PaymentChannelSDK` (EVM) in `payment-channel-sdk.ts`.
 *
 * @packageDocumentation
 */

import * as crypto from 'crypto';
import type { Logger } from '../utils/logger';
import {
  address,
  getAddressEncoder,
  getAddressDecoder,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  pipe,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  signBytes,
  generateKeyPairSigner,
  AccountRole,
} from '@solana/kit';
import type {
  Address,
  TransactionSigner,
  Instruction,
  AccountMeta,
  Rpc,
  SolanaRpcApi,
  RpcSubscriptions,
  SolanaRpcSubscriptionsApi,
  ReadonlyUint8Array,
} from '@solana/kit';

/**
 * Ed25519 key pair type compatible with Web Crypto API.
 * Defined locally since the project does not include DOM lib types.
 * The `signBytes` function from `@solana/keys` accepts these opaque key objects.
 */
interface Ed25519KeyPair {
  readonly publicKey: unknown;
  readonly privateKey: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** On-chain discriminator for the channel account: ASCII "pchannel" */
const CHANNEL_DISCRIMINATOR = new Uint8Array([0x70, 0x63, 0x68, 0x61, 0x6e, 0x6e, 0x65, 0x6c]);

/** Instruction discriminators -- must match Rust exactly */
const DISCRIMINATORS = {
  INITIALIZE_CHANNEL: new Uint8Array([0x01, 0, 0, 0, 0, 0, 0, 0]),
  DEPOSIT: new Uint8Array([0x02, 0, 0, 0, 0, 0, 0, 0]),
  CLOSE_CHANNEL: new Uint8Array([0x03, 0, 0, 0, 0, 0, 0, 0]),
  SETTLE_CHANNEL: new Uint8Array([0x04, 0, 0, 0, 0, 0, 0, 0]),
  FORCE_CLOSE_EXPIRED: new Uint8Array([0x05, 0, 0, 0, 0, 0, 0, 0]),
  CLAIM_FROM_CHANNEL: new Uint8Array([0x06, 0, 0, 0, 0, 0, 0, 0]),
} as const;

/** Account data size: 178 bytes total */
const ACCOUNT_SIZE = 178;

/** Well-known Solana program addresses */
const SYSTEM_PROGRAM = '11111111111111111111111111111111' as Address;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111' as Address;
const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111' as Address;
const INSTRUCTIONS_SYSVAR = 'Sysvar1nstructions1111111111111111111111111' as Address;
const ED25519_PROGRAM = 'Ed25519SigVerify111111111111111111111111111' as Address;

/** Error code to name mapping (codes 0-12) */
const ERROR_CODE_MAP: Record<number, string> = {
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
// Types
// ---------------------------------------------------------------------------

/**
 * Deserialized on-chain channel state.
 * Field layout matches the Rust `ChannelState` struct in state.rs.
 */
export interface SolanaChannelState {
  participantA: string; // base58 pubkey
  participantB: string; // base58 pubkey
  tokenMint: string; // base58 pubkey
  depositA: bigint;
  depositB: bigint;
  transferredAmountA: bigint;
  transferredAmountB: bigint;
  nonceA: bigint;
  nonceB: bigint;
  challengeDuration: bigint;
  state: 'opened' | 'closed' | 'settled';
  closeTimestamp: bigint;
  bump: number;
}

/**
 * Custom error class for Solana payment channel program errors.
 * Maps program error codes 0-12 to descriptive names.
 */
export class SolanaChannelError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly errorName: string
  ) {
    super(message);
    this.name = 'SolanaChannelError';
    Error.captureStackTrace(this, SolanaChannelError);
  }
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/** Convert a ReadonlyUint8Array to a mutable Uint8Array (needed for type compatibility). */
function toMutableBytes(readonly: ReadonlyUint8Array): Uint8Array {
  return new Uint8Array(readonly as Uint8Array);
}

/** Maximum value for a u64: 2^64 - 1 */
const MAX_U64 = (1n << 64n) - 1n;

/** Write a u64 value as little-endian bytes into a Uint8Array at the given offset. */
function writeUint64LE(buf: Uint8Array, offset: number, value: bigint): void {
  if (value < 0n || value > MAX_U64) {
    throw new RangeError(`Value ${value} is outside u64 range [0, 2^64-1]`);
  }
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
}

/** Read a u64 value as little-endian from a Uint8Array at the given offset. */
function readUint64LE(buf: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result |= BigInt(buf[offset + i] ?? 0) << BigInt(i * 8);
  }
  return result;
}

/** Read an i64 value as little-endian from a Uint8Array at the given offset. */
function readInt64LE(buf: Uint8Array, offset: number): bigint {
  const unsigned = readUint64LE(buf, offset);
  // Convert to signed: if high bit is set, the value is negative
  if (unsigned >= 1n << 63n) {
    return unsigned - (1n << 64n);
  }
  return unsigned;
}

/**
 * Sort two addresses lexicographically by their raw byte representation.
 * Matches the Rust sort_participants() function.
 */
function sortParticipants(a: Address, b: Address): [Address, Address] {
  const encoder = getAddressEncoder();
  const aBytes = toMutableBytes(encoder.encode(a));
  const bBytes = toMutableBytes(encoder.encode(b));
  for (let i = 0; i < 32; i++) {
    const aByte = aBytes[i] ?? 0;
    const bByte = bBytes[i] ?? 0;
    if (aByte < bByte) return [a, b];
    if (aByte > bByte) return [b, a];
  }
  return [a, b]; // equal (shouldn't happen for valid distinct participants)
}

/** Map a channel state byte to a human-readable string. */
function mapStateU8(val: number): 'opened' | 'closed' | 'settled' {
  switch (val) {
    case 0:
      return 'opened';
    case 1:
      return 'closed';
    case 2:
      return 'settled';
    default:
      throw new Error(`Unknown channel state byte: ${val}`);
  }
}

/**
 * Map a Solana program custom error code to a SolanaChannelError.
 *
 * @param code - The program error code (0-12)
 * @returns A SolanaChannelError with the mapped error name
 */
export function mapProgramError(code: number): SolanaChannelError {
  const errorName = ERROR_CODE_MAP[code] ?? `UnknownError(${code})`;
  return new SolanaChannelError(
    `Solana payment channel program error: ${errorName} (code ${code})`,
    code,
    errorName
  );
}

/**
 * Parse a Solana SendTransactionError to extract the custom program error code
 * and throw a SolanaChannelError if applicable.
 */
export function parseSolanaError(err: unknown): never {
  // Try to extract custom program error code from the error
  if (err instanceof Error) {
    const message = err.message;
    // Pattern: "custom program error: 0x{hex}" or "Custom: {decimal}"
    const hexMatch = /custom program error: 0x([0-9a-fA-F]+)/.exec(message);
    if (hexMatch?.[1]) {
      const code = parseInt(hexMatch[1], 16);
      if (code >= 0 && code <= 12) {
        throw mapProgramError(code);
      }
    }
    const customMatch = /Custom:\s*(\d+)/.exec(message);
    if (customMatch?.[1]) {
      const code = parseInt(customMatch[1], 10);
      if (code >= 0 && code <= 12) {
        throw mapProgramError(code);
      }
    }
    // Check for InstructionError with custom code in logs
    const instructionErrorMatch = /InstructionError.*Custom.*?(\d+)/.exec(message);
    if (instructionErrorMatch?.[1]) {
      const code = parseInt(instructionErrorMatch[1], 10);
      if (code >= 0 && code <= 12) {
        throw mapProgramError(code);
      }
    }
  }
  // If we can't parse it, re-throw the original error
  throw err;
}

// ---------------------------------------------------------------------------
// Public: Deserialization
// ---------------------------------------------------------------------------

/**
 * Deserialize a 178-byte on-chain channel account data buffer into a
 * SolanaChannelState object.
 *
 * @param data - Raw account data (must be >= 178 bytes)
 * @returns Deserialized channel state
 * @throws Error if data is too short or has an invalid discriminator
 */
export function deserializeChannelState(data: Uint8Array): SolanaChannelState {
  if (data.length < ACCOUNT_SIZE) {
    throw new Error(
      `Channel account data too short: expected ${ACCOUNT_SIZE} bytes, got ${data.length}`
    );
  }

  // Verify discriminator
  for (let i = 0; i < 8; i++) {
    if (data[i] !== CHANNEL_DISCRIMINATOR[i]) {
      throw new Error('Invalid channel account discriminator: expected "pchannel"');
    }
  }

  const decoder = getAddressDecoder();

  return {
    participantA: decoder.decode(data.slice(8, 40)),
    participantB: decoder.decode(data.slice(40, 72)),
    tokenMint: decoder.decode(data.slice(72, 104)),
    depositA: readUint64LE(data, 104),
    depositB: readUint64LE(data, 112),
    transferredAmountA: readUint64LE(data, 120),
    transferredAmountB: readUint64LE(data, 128),
    nonceA: readUint64LE(data, 136),
    nonceB: readUint64LE(data, 144),
    challengeDuration: readUint64LE(data, 152),
    state: mapStateU8(data[160] ?? 0),
    closeTimestamp: readInt64LE(data, 161),
    bump: data[169] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Public: Ed25519 Precompile Instruction Builder
// ---------------------------------------------------------------------------

/**
 * Build an Ed25519 precompile verification instruction with all data inline.
 *
 * Layout (160 bytes total for 48-byte message):
 *   [0]      num_signatures: u8 = 1
 *   [1]      padding: u8 = 0
 *   [2-3]    signature_offset: u16 LE = 16
 *   [4-5]    signature_ix_index: u16 LE = 0xFFFF (same instruction)
 *   [6-7]    public_key_offset: u16 LE = 80
 *   [8-9]    public_key_ix_index: u16 LE = 0xFFFF
 *   [10-11]  message_data_offset: u16 LE = 112
 *   [12-13]  message_data_size: u16 LE = 48
 *   [14-15]  message_ix_index: u16 LE = 0xFFFF
 *   [16-79]  signature (64 bytes)
 *   [80-111] public_key (32 bytes)
 *   [112-159] message (48 bytes)
 *
 * @param signature - 64-byte Ed25519 signature
 * @param pubkey - 32-byte public key
 * @param message - 48-byte balance proof message
 * @returns Instruction for the Ed25519 precompile program
 */
export function buildEd25519PrecompileInstruction(
  signature: Uint8Array,
  pubkey: Uint8Array,
  message: Uint8Array
): Instruction {
  if (signature.length !== 64) {
    throw new Error(`Ed25519 signature must be 64 bytes, got ${signature.length}`);
  }
  if (pubkey.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${pubkey.length}`);
  }
  if (message.length === 0) {
    throw new Error('Ed25519 precompile message must not be empty');
  }
  const HEADER_SIZE = 16;
  const totalSize = HEADER_SIZE + 64 + 32 + message.length;
  const instructionData = new Uint8Array(totalSize);

  // Header
  instructionData[0] = 1; // num_signatures
  instructionData[1] = 0; // padding

  const sigOffset = HEADER_SIZE; // 16
  const pkOffset = sigOffset + 64; // 80
  const msgOffset = pkOffset + 32; // 112

  // signature_offset (u16 LE)
  instructionData[2] = sigOffset & 0xff;
  instructionData[3] = (sigOffset >> 8) & 0xff;
  // signature_ix_index = 0xFFFF
  instructionData[4] = 0xff;
  instructionData[5] = 0xff;

  // public_key_offset (u16 LE)
  instructionData[6] = pkOffset & 0xff;
  instructionData[7] = (pkOffset >> 8) & 0xff;
  // public_key_ix_index = 0xFFFF
  instructionData[8] = 0xff;
  instructionData[9] = 0xff;

  // message_data_offset (u16 LE)
  instructionData[10] = msgOffset & 0xff;
  instructionData[11] = (msgOffset >> 8) & 0xff;
  // message_data_size (u16 LE)
  instructionData[12] = message.length & 0xff;
  instructionData[13] = (message.length >> 8) & 0xff;
  // message_ix_index = 0xFFFF
  instructionData[14] = 0xff;
  instructionData[15] = 0xff;

  // Inline data
  instructionData.set(signature, sigOffset);
  instructionData.set(pubkey, pkOffset);
  instructionData.set(message, msgOffset);

  return {
    programAddress: ED25519_PROGRAM,
    accounts: [] as readonly AccountMeta[],
    data: instructionData as ReadonlyUint8Array,
  };
}

// ---------------------------------------------------------------------------
// SDK Class
// ---------------------------------------------------------------------------

/**
 * SolanaPaymentChannelSDK wraps the on-chain Solana payment channel program
 * (Stories 33.1-33.3) with TypeScript methods using `@solana/kit` v3.
 *
 * Mirrors the pattern of `PaymentChannelSDK` (EVM) for off-chain operations.
 *
 * @remarks
 * - Static methods (PDA derivation, signing) work without RPC
 * - Instance methods build, sign, and submit transactions via RPC
 * - Uses `@solana/kit` v3 APIs (no legacy `Connection` or `PublicKey` classes)
 */
export class SolanaPaymentChannelSDK {
  private readonly _rpc: Rpc<SolanaRpcApi>;
  private readonly _rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  private readonly _programId: Address;
  private readonly _logger: Logger;
  private readonly _sendAndConfirmTransaction: ReturnType<typeof sendAndConfirmTransactionFactory>;

  constructor(rpcUrl: string, programId: string, logger: Logger) {
    this._programId = address(programId);
    this._logger = logger.child({ component: 'solana-payment-channel-sdk' });
    this._rpc = createSolanaRpc(rpcUrl);
    this._rpcSubscriptions = createSolanaRpcSubscriptions(rpcUrl.replace('http', 'ws'));
    this._sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
      rpc: this._rpc,
      rpcSubscriptions: this._rpcSubscriptions,
    });
  }

  // -------------------------------------------------------------------------
  // Static Utilities (no RPC needed)
  // -------------------------------------------------------------------------

  /**
   * Derive a channel PDA from two participant pubkeys and a token mint.
   * Order-independent: sorts pubkeys lexicographically to match Rust.
   *
   * Seeds: [b"channel", min_pubkey, max_pubkey, token_mint]
   */
  static deriveChannelPDA(
    participantA: string,
    participantB: string,
    tokenMint: string,
    programId: string
  ): { pda: string; bump: number } {
    const addrA = address(participantA);
    const addrB = address(participantB);
    const mint = address(tokenMint);
    const program = address(programId);

    const [min, max] = sortParticipants(addrA, addrB);

    const encoder = getAddressEncoder();
    const seeds: Uint8Array[] = [
      new TextEncoder().encode('channel'),
      toMutableBytes(encoder.encode(min)),
      toMutableBytes(encoder.encode(max)),
      toMutableBytes(encoder.encode(mint)),
    ];

    const pdaResult = findProgramDerivedAddressSync(seeds, program);
    return { pda: pdaResult[0], bump: pdaResult[1] };
  }

  /**
   * Derive the vault PDA from a channel PDA.
   *
   * Seeds: [b"vault", channel_pda]
   */
  static deriveVaultPDA(channelPDA: string, programId: string): { pda: string; bump: number } {
    const channel = address(channelPDA);
    const program = address(programId);

    const encoder = getAddressEncoder();
    const seeds: Uint8Array[] = [
      new TextEncoder().encode('vault'),
      toMutableBytes(encoder.encode(channel)),
    ];

    const pdaResult = findProgramDerivedAddressSync(seeds, program);
    return { pda: pdaResult[0], bump: pdaResult[1] };
  }

  /**
   * Build the canonical 48-byte balance proof message.
   *
   * Format: channel_pda (32 bytes) || nonce (8 bytes LE) || transferred_amount (8 bytes LE)
   *
   * @param channelPDA - Base58-encoded channel PDA address
   * @param nonce - Monotonically increasing nonce
   * @param transferredAmount - Total transferred amount
   * @returns 48-byte message buffer
   */
  static _buildBalanceProofMessage(
    channelPDA: string,
    nonce: bigint,
    transferredAmount: bigint
  ): Uint8Array {
    const message = new Uint8Array(48);
    const encoder = getAddressEncoder();
    const pdaBytes = toMutableBytes(encoder.encode(address(channelPDA)));
    message.set(pdaBytes, 0);
    writeUint64LE(message, 32, nonce);
    writeUint64LE(message, 40, transferredAmount);
    return message;
  }

  /**
   * Sign a balance proof message with an Ed25519 keypair.
   *
   * @param channelPDA - Base58-encoded channel PDA address
   * @param nonce - Monotonically increasing nonce
   * @param transferredAmount - Total transferred amount
   * @param keypair - Ed25519 CryptoKeyPair for signing
   * @returns 64-byte Ed25519 signature
   */
  static async signBalanceProof(
    channelPDA: string,
    nonce: bigint,
    transferredAmount: bigint,
    keypair: Ed25519KeyPair
  ): Promise<Uint8Array> {
    const message = SolanaPaymentChannelSDK._buildBalanceProofMessage(
      channelPDA,
      nonce,
      transferredAmount
    );
    const signature = await signBytes(keypair.privateKey, message);
    return new Uint8Array(signature);
  }

  // -------------------------------------------------------------------------
  // Transaction Builders
  // -------------------------------------------------------------------------

  /**
   * Build and submit an initialize_channel transaction.
   *
   * @param payer - Transaction fee payer and signer
   * @param participantA - Base58 pubkey of participant A
   * @param participantB - Base58 pubkey of participant B
   * @param tokenMint - Base58 pubkey of the SPL token mint
   * @param challengeDuration - Challenge period duration in seconds
   * @returns Channel PDA address and transaction signature
   */
  async openChannel(
    payer: TransactionSigner,
    participantA: string,
    participantB: string,
    tokenMint: string,
    challengeDuration: bigint
  ): Promise<{ channelPDA: string; txSignature: string }> {
    this._logger.info(
      {
        event: 'open_channel_start',
        participantA,
        participantB,
        tokenMint,
        challengeDuration: challengeDuration.toString(),
      },
      'Opening Solana payment channel'
    );

    const { pda: channelPDA } = SolanaPaymentChannelSDK.deriveChannelPDA(
      participantA,
      participantB,
      tokenMint,
      this._programId
    );
    const { pda: vaultPDA } = SolanaPaymentChannelSDK.deriveVaultPDA(channelPDA, this._programId);

    // Build instruction data: discriminator (8) + challenge_duration (8)
    const instructionData = new Uint8Array(16);
    instructionData.set(DISCRIMINATORS.INITIALIZE_CHANNEL, 0);
    writeUint64LE(instructionData, 8, challengeDuration);

    const accounts: AccountMeta[] = [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: address(participantA), role: AccountRole.READONLY },
      { address: address(participantB), role: AccountRole.READONLY },
      { address: address(tokenMint), role: AccountRole.READONLY },
      { address: address(channelPDA), role: AccountRole.WRITABLE },
      { address: address(vaultPDA), role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: RENT_SYSVAR, role: AccountRole.READONLY },
    ];

    const instruction: Instruction = {
      programAddress: this._programId,
      accounts,
      data: instructionData as ReadonlyUint8Array,
    };

    try {
      const txSignature = await this._sendTransaction(payer, [instruction]);

      this._logger.info(
        {
          event: 'open_channel_success',
          channelPDA,
          txSignature,
        },
        'Solana payment channel opened'
      );

      return { channelPDA, txSignature };
    } catch (err) {
      this._logger.error(
        { event: 'open_channel_error', error: String(err) },
        'Failed to open Solana payment channel'
      );
      parseSolanaError(err);
    }
  }

  /**
   * Build and submit a deposit transaction.
   *
   * @param depositor - Depositor signer
   * @param channelPDA - Base58 channel PDA address
   * @param depositorTokenAccount - Base58 depositor's SPL token account
   * @param amount - Amount to deposit
   * @returns Transaction signature
   */
  async deposit(
    depositor: TransactionSigner,
    channelPDA: string,
    depositorTokenAccount: string,
    amount: bigint
  ): Promise<{ txSignature: string }> {
    this._logger.info(
      {
        event: 'deposit_start',
        channelPDA,
        amount: amount.toString(),
      },
      'Depositing to Solana payment channel'
    );

    const { pda: vaultPDA } = SolanaPaymentChannelSDK.deriveVaultPDA(channelPDA, this._programId);

    // Build instruction data: discriminator (8) + amount (8)
    const instructionData = new Uint8Array(16);
    instructionData.set(DISCRIMINATORS.DEPOSIT, 0);
    writeUint64LE(instructionData, 8, amount);

    const accounts: AccountMeta[] = [
      { address: depositor.address, role: AccountRole.READONLY_SIGNER },
      { address: address(depositorTokenAccount), role: AccountRole.WRITABLE },
      { address: address(vaultPDA), role: AccountRole.WRITABLE },
      { address: address(channelPDA), role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    ];

    const instruction: Instruction = {
      programAddress: this._programId,
      accounts,
      data: instructionData as ReadonlyUint8Array,
    };

    try {
      const txSignature = await this._sendTransaction(depositor, [instruction]);

      this._logger.info(
        { event: 'deposit_success', channelPDA, txSignature },
        'Deposit to Solana payment channel succeeded'
      );

      return { txSignature };
    } catch (err) {
      this._logger.error(
        { event: 'deposit_error', error: String(err) },
        'Failed to deposit to Solana payment channel'
      );
      parseSolanaError(err);
    }
  }

  /**
   * Build and submit a claim_from_channel transaction with Ed25519 precompile verification.
   *
   * The transaction contains exactly 2 instructions:
   *   [0] Ed25519 precompile instruction (signature verification)
   *   [1] claim_from_channel program instruction
   *
   * @param claimer - Claimer signer
   * @param channelPDA - Base58 channel PDA address
   * @param nonce - Balance proof nonce
   * @param transferredAmount - Balance proof transferred amount
   * @param signature - 64-byte Ed25519 signature over the balance proof message
   * @returns Transaction signature
   */
  async claimFromChannel(
    claimer: TransactionSigner,
    channelPDA: string,
    nonce: bigint,
    transferredAmount: bigint,
    signature: Uint8Array
  ): Promise<{ txSignature: string }> {
    this._logger.info(
      {
        event: 'claim_start',
        channelPDA,
        nonce: nonce.toString(),
        transferredAmount: transferredAmount.toString(),
      },
      'Claiming from Solana payment channel'
    );

    // Get the claimer's public key bytes for the Ed25519 precompile instruction
    const encoder = getAddressEncoder();
    const claimerPubkey = toMutableBytes(encoder.encode(claimer.address));

    // Build the balance proof message
    const balanceProofMessage = SolanaPaymentChannelSDK._buildBalanceProofMessage(
      channelPDA,
      nonce,
      transferredAmount
    );

    // Instruction 0: Ed25519 precompile verification
    const ed25519Instruction = buildEd25519PrecompileInstruction(
      signature,
      claimerPubkey,
      balanceProofMessage
    );

    // Instruction 1: claim_from_channel
    // Data: discriminator (8) + nonce (8) + transferred_amount (8) = 24 bytes
    const claimData = new Uint8Array(24);
    claimData.set(DISCRIMINATORS.CLAIM_FROM_CHANNEL, 0);
    writeUint64LE(claimData, 8, nonce);
    writeUint64LE(claimData, 16, transferredAmount);

    const claimAccounts: AccountMeta[] = [
      { address: claimer.address, role: AccountRole.READONLY_SIGNER },
      { address: address(channelPDA), role: AccountRole.WRITABLE },
      { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
    ];

    const claimInstruction: Instruction = {
      programAddress: this._programId,
      accounts: claimAccounts,
      data: claimData as ReadonlyUint8Array,
    };

    try {
      const txSignature = await this._sendTransaction(claimer, [
        ed25519Instruction,
        claimInstruction,
      ]);

      this._logger.info(
        { event: 'claim_success', channelPDA, txSignature },
        'Claim from Solana payment channel succeeded'
      );

      return { txSignature };
    } catch (err) {
      this._logger.error(
        { event: 'claim_error', error: String(err) },
        'Failed to claim from Solana payment channel'
      );
      parseSolanaError(err);
    }
  }

  /**
   * Build and submit a close_channel transaction.
   *
   * @param closer - Participant signer initiating the close
   * @param channelPDA - Base58 channel PDA address
   * @returns Transaction signature
   */
  async closeChannel(
    closer: TransactionSigner,
    channelPDA: string
  ): Promise<{ txSignature: string }> {
    this._logger.info(
      { event: 'close_channel_start', channelPDA },
      'Closing Solana payment channel'
    );

    const accounts: AccountMeta[] = [
      { address: closer.address, role: AccountRole.READONLY_SIGNER },
      { address: address(channelPDA), role: AccountRole.WRITABLE },
      { address: CLOCK_SYSVAR, role: AccountRole.READONLY },
    ];

    const instruction: Instruction = {
      programAddress: this._programId,
      accounts,
      data: DISCRIMINATORS.CLOSE_CHANNEL as ReadonlyUint8Array,
    };

    try {
      const txSignature = await this._sendTransaction(closer, [instruction]);

      this._logger.info(
        { event: 'close_channel_success', channelPDA, txSignature },
        'Solana payment channel closed'
      );

      return { txSignature };
    } catch (err) {
      this._logger.error(
        { event: 'close_channel_error', error: String(err) },
        'Failed to close Solana payment channel'
      );
      parseSolanaError(err);
    }
  }

  /**
   * Build and submit a settle_channel transaction.
   *
   * @param caller - Caller signer
   * @param channelPDA - Base58 channel PDA address
   * @param participantAToken - Base58 participant A's token account
   * @param participantBToken - Base58 participant B's token account
   * @param rentRecipient - Base58 rent recipient address
   * @returns Transaction signature
   */
  async settleChannel(
    caller: TransactionSigner,
    channelPDA: string,
    participantAToken: string,
    participantBToken: string,
    rentRecipient: string
  ): Promise<{ txSignature: string }> {
    this._logger.info(
      { event: 'settle_channel_start', channelPDA },
      'Settling Solana payment channel'
    );

    const { pda: vaultPDA } = SolanaPaymentChannelSDK.deriveVaultPDA(channelPDA, this._programId);

    const accounts: AccountMeta[] = [
      { address: caller.address, role: AccountRole.READONLY_SIGNER },
      { address: address(channelPDA), role: AccountRole.WRITABLE },
      { address: address(vaultPDA), role: AccountRole.WRITABLE },
      { address: address(participantAToken), role: AccountRole.WRITABLE },
      { address: address(participantBToken), role: AccountRole.WRITABLE },
      { address: address(rentRecipient), role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: CLOCK_SYSVAR, role: AccountRole.READONLY },
    ];

    const instruction: Instruction = {
      programAddress: this._programId,
      accounts,
      data: DISCRIMINATORS.SETTLE_CHANNEL as ReadonlyUint8Array,
    };

    try {
      const txSignature = await this._sendTransaction(caller, [instruction]);

      this._logger.info(
        { event: 'settle_channel_success', channelPDA, txSignature },
        'Solana payment channel settled'
      );

      return { txSignature };
    } catch (err) {
      this._logger.error(
        { event: 'settle_channel_error', error: String(err) },
        'Failed to settle Solana payment channel'
      );
      parseSolanaError(err);
    }
  }

  /**
   * Build and submit a force_close_expired transaction.
   * Same account layout as settle_channel.
   *
   * @param caller - Caller signer
   * @param channelPDA - Base58 channel PDA address
   * @param participantAToken - Base58 participant A's token account
   * @param participantBToken - Base58 participant B's token account
   * @param rentRecipient - Base58 rent recipient address
   * @returns Transaction signature
   */
  async forceCloseExpired(
    caller: TransactionSigner,
    channelPDA: string,
    participantAToken: string,
    participantBToken: string,
    rentRecipient: string
  ): Promise<{ txSignature: string }> {
    this._logger.info(
      { event: 'force_close_start', channelPDA },
      'Force closing expired Solana payment channel'
    );

    const { pda: vaultPDA } = SolanaPaymentChannelSDK.deriveVaultPDA(channelPDA, this._programId);

    const accounts: AccountMeta[] = [
      { address: caller.address, role: AccountRole.READONLY_SIGNER },
      { address: address(channelPDA), role: AccountRole.WRITABLE },
      { address: address(vaultPDA), role: AccountRole.WRITABLE },
      { address: address(participantAToken), role: AccountRole.WRITABLE },
      { address: address(participantBToken), role: AccountRole.WRITABLE },
      { address: address(rentRecipient), role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: CLOCK_SYSVAR, role: AccountRole.READONLY },
    ];

    const instruction: Instruction = {
      programAddress: this._programId,
      accounts,
      data: DISCRIMINATORS.FORCE_CLOSE_EXPIRED as ReadonlyUint8Array,
    };

    try {
      const txSignature = await this._sendTransaction(caller, [instruction]);

      this._logger.info(
        { event: 'force_close_success', channelPDA, txSignature },
        'Force close expired Solana payment channel succeeded'
      );

      return { txSignature };
    } catch (err) {
      this._logger.error(
        { event: 'force_close_error', error: String(err) },
        'Failed to force close expired Solana payment channel'
      );
      parseSolanaError(err);
    }
  }

  // -------------------------------------------------------------------------
  // State Queries
  // -------------------------------------------------------------------------

  /**
   * Fetch SPL mint metadata (decimals + raw mint address as symbol).
   *
   * Uses `getAccountInfo` with `encoding: 'jsonParsed'` so the Solana RPC
   * parses the SPL Token mint account on the server side and returns
   * `{ parsed: { info: { decimals, supply, mintAuthority } } }`.
   *
   * Solana SPL mints do not carry a standard on-chain symbol string —
   * Metaplex Token Metadata Program adds that at a derived PDA, but is
   * out of scope for this helper. Returns the raw mint address as
   * `assetCode`; dashboard can display it in truncated form.
   *
   * Never throws: on any RPC or parse failure returns the raw-address
   * fallback so the caller (admin API earnings endpoint) stays up.
   *
   * @param mintAddress - Base58 SPL mint address
   * @returns `{ assetCode, assetScale }` — assetScale is the mint's decimals
   *   (0 on failure). Story 37.8.
   */
  async getMintMetadata(mintAddress: string): Promise<{ assetCode: string; assetScale: number }> {
    const fallback = { assetCode: mintAddress, assetScale: 0 };
    try {
      const accountInfo = await this._rpc
        .getAccountInfo(address(mintAddress), { encoding: 'jsonParsed' })
        .send();

      if (!accountInfo.value) {
        this._logger.warn(
          { event: 'spl_mint_not_found', mintAddress },
          'SPL mint account not found on-chain; using raw-address fallback'
        );
        return fallback;
      }

      // jsonParsed returns `data: { program: 'spl-token', parsed: { info: {...}, type: 'mint' } }`.
      const data = accountInfo.value.data as unknown;
      if (
        data &&
        typeof data === 'object' &&
        'parsed' in data &&
        data.parsed &&
        typeof data.parsed === 'object' &&
        'info' in data.parsed &&
        data.parsed.info &&
        typeof data.parsed.info === 'object' &&
        'decimals' in data.parsed.info &&
        typeof (data.parsed.info as { decimals: unknown }).decimals === 'number'
      ) {
        const decimals = (data.parsed.info as { decimals: number }).decimals;
        return { assetCode: mintAddress, assetScale: decimals };
      }

      this._logger.warn(
        { event: 'spl_mint_unparseable', mintAddress },
        'SPL mint account parsed data missing decimals; using raw-address fallback'
      );
      return fallback;
    } catch (err) {
      this._logger.warn(
        {
          event: 'spl_mint_rpc_failed',
          mintAddress,
          error: err instanceof Error ? err.message : String(err),
        },
        'SPL mint RPC lookup failed; using raw-address fallback'
      );
      return fallback;
    }
  }

  /**
   * Fetch and deserialize on-chain channel state.
   *
   * @param channelPDA - Base58 channel PDA address
   * @returns Deserialized channel state
   * @throws Error if the account does not exist or has invalid data
   */
  async getChannelState(channelPDA: string): Promise<SolanaChannelState> {
    this._logger.debug({ event: 'get_channel_state', channelPDA }, 'Fetching Solana channel state');

    const accountInfo = await this._rpc
      .getAccountInfo(address(channelPDA), { encoding: 'base64' })
      .send();

    if (!accountInfo.value) {
      throw new Error(`Channel account not found: ${channelPDA}`);
    }

    const data: unknown = accountInfo.value.data;

    // data comes as [base64string, "base64"] tuple when encoding is base64
    let rawBytes: Uint8Array;
    if (Array.isArray(data)) {
      const base64Str = data[0] as string;
      rawBytes = Uint8Array.from(Buffer.from(base64Str, 'base64'));
    } else if (data instanceof Uint8Array) {
      rawBytes = data;
    } else {
      throw new Error(`Unexpected account data format for ${channelPDA}`);
    }

    return deserializeChannelState(rawBytes);
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  /**
   * Subscribe to on-chain channel account changes.
   *
   * Uses @solana/kit v3 async iterable subscription API internally.
   * Fires the callback with deserialized SolanaChannelState on each change.
   *
   * @param channelPDA - Base58 channel PDA address
   * @param callback - Called with deserialized state on each account change
   * @returns Handle with unsubscribe method
   */
  subscribeToChannel(
    channelPDA: string,
    callback: (state: SolanaChannelState) => void
  ): { unsubscribe: () => void } {
    const abortController = new AbortController();

    this._logger.info(
      { event: 'subscribe_channel', channelPDA },
      'Subscribing to Solana channel account changes'
    );

    // Fire and forget the async subscription loop
    void this._runSubscriptionLoop(channelPDA, callback, abortController.signal);

    return {
      unsubscribe: (): void => {
        this._logger.info(
          { event: 'unsubscribe_channel', channelPDA },
          'Unsubscribing from Solana channel account changes'
        );
        abortController.abort();
      },
    };
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  /**
   * Internal: Run the subscription loop consuming async iterable notifications.
   */
  private async _runSubscriptionLoop(
    channelPDA: string,
    callback: (state: SolanaChannelState) => void,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const notifications = await this._rpcSubscriptions
        .accountNotifications(address(channelPDA), { commitment: 'confirmed' })
        .subscribe({ abortSignal: signal });

      for await (const notification of notifications) {
        try {
          const notificationValue = notification as { value?: { data?: unknown } };
          const data: unknown = notificationValue.value?.data;
          let rawBytes: Uint8Array;
          if (Array.isArray(data)) {
            const base64Str = data[0] as string;
            rawBytes = Uint8Array.from(Buffer.from(base64Str, 'base64'));
          } else if (data instanceof Uint8Array) {
            rawBytes = data;
          } else {
            this._logger.warn(
              { event: 'subscription_data_format_unknown', channelPDA },
              'Unknown account data format in subscription notification'
            );
            continue;
          }

          const state = deserializeChannelState(rawBytes);
          callback(state);
        } catch (deserError) {
          this._logger.warn(
            {
              event: 'subscription_deserialize_error',
              channelPDA,
              error: String(deserError),
            },
            'Failed to deserialize channel state from subscription notification'
          );
        }
      }
    } catch (err) {
      // AbortError is expected when unsubscribing
      if (signal.aborted) {
        return;
      }
      this._logger.error(
        { event: 'subscription_error', channelPDA, error: String(err) },
        'Subscription loop failed'
      );
    }
  }

  /**
   * Internal: Build, sign, and send a transaction with the given instructions.
   */
  private async _sendTransaction(
    feePayer: TransactionSigner,
    instructions: Instruction[]
  ): Promise<string> {
    // Fetch latest blockhash for transaction lifetime
    const { value: latestBlockhash } = await this._rpc.getLatestBlockhash().send();

    // Build the transaction message using pipe pattern.
    // Note: @solana/kit v3 uses deeply nested branded types that prevent type-safe
    // reduce over instructions. The `any` casts are unavoidable here due to the
    // library's type system limitations with dynamic instruction counts.
    const txMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) =>
        instructions.reduce(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (msg, ix) => appendTransactionMessageInstruction(ix, msg) as any,
          m
        )
    );

    // Sign with the signer-aware API. We use signTransactionMessageWithSigners
    // (not signAndSendTransactionMessageWithSigners) because the apex fee-payer is
    // a KeyPairSigner — a partial/message signer, NOT a TransactionSendingSigner.
    // signAndSend... asserts a single sending signer and throws Solana #5508010
    // when the fee-payer cannot send itself (issue #92). Sign here, then submit
    // explicitly over the RPC.
    const signedTransaction = await signTransactionMessageWithSigners(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      txMessage as any
    );

    // Submit and await confirmation over the RPC + WS subscription.
    // Cast: the `any` txMessage above erases the branded blockhash-lifetime /
    // size-limit types sendAndConfirm requires; the message is built correctly via
    // setTransactionMessageLifetimeUsingBlockhash above.
    await this._sendAndConfirmTransaction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signedTransaction as any,
      { commitment: 'confirmed' }
    );

    // The signature is derivable from the fully-signed transaction (base58 string).
    return getSignatureFromTransaction(signedTransaction);
  }
}

// ---------------------------------------------------------------------------
// Synchronous PDA Derivation
// ---------------------------------------------------------------------------

/**
 * Synchronous PDA derivation matching Solana's find_program_address algorithm.
 *
 * Tries bump seeds from 255 down to 0. For each bump, computes SHA-256 of
 * [seeds..., bump_byte, programId, "ProgramDerivedAddress"] and checks that
 * the result is NOT on the Ed25519 curve (i.e., is a valid PDA).
 *
 * @param seeds - Array of seed byte arrays
 * @param programId - Program address
 * @returns [address, bump] tuple
 */
function findProgramDerivedAddressSync(seeds: Uint8Array[], programId: Address): [string, number] {
  const encoder = getAddressEncoder();
  const decoder = getAddressDecoder();
  const programIdBytes = toMutableBytes(encoder.encode(programId));
  const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

  for (let bump = 255; bump >= 0; bump--) {
    // Build the hash input: all seeds + [bump] + programId + "ProgramDerivedAddress"
    const bumpSeed = new Uint8Array([bump]);
    const allSeeds = [...seeds, bumpSeed];

    // Calculate total length
    let totalLen = 0;
    for (const s of allSeeds) {
      totalLen += s.length;
    }
    totalLen += programIdBytes.length + PDA_MARKER.length;

    const hashInput = new Uint8Array(totalLen);
    let offset = 0;
    for (const s of allSeeds) {
      hashInput.set(s, offset);
      offset += s.length;
    }
    hashInput.set(programIdBytes, offset);
    offset += programIdBytes.length;
    hashInput.set(PDA_MARKER, offset);

    // SHA-256 hash (synchronous via Node.js crypto)
    const hash: Buffer = crypto.createHash('sha256').update(hashInput).digest();
    const hashBytes = new Uint8Array(hash);

    // Check if the point is NOT on the Ed25519 curve
    // A valid PDA must NOT be a valid Ed25519 public key
    if (!isOnCurve(hashBytes)) {
      const pdaAddress = decoder.decode(hashBytes);
      return [pdaAddress, bump];
    }
  }

  throw new Error('Could not find a viable PDA bump seed');
}

/**
 * Check if a 32-byte value is on the Ed25519 curve.
 *
 * Uses the standard decompression check from RFC 8032:
 * Given a y-coordinate, check if (y^2 - 1) / (d * y^2 + 1) is a quadratic
 * residue mod p, where p = 2^255 - 19 and d = -121665/121666 mod p.
 */
function isOnCurve(bytes: Uint8Array): boolean {
  // Ed25519 field prime p = 2^255 - 19
  const P = (1n << 255n) - 19n;

  // Clear sign bit and read y as little-endian
  const yBytes = new Uint8Array(32);
  yBytes.set(bytes);
  yBytes[31] = (yBytes[31] ?? 0) & 0x7f;

  let y = 0n;
  for (let i = 0; i < 32; i++) {
    y |= BigInt(yBytes[i] ?? 0) << BigInt(i * 8);
  }

  // y must be < p
  if (y >= P) {
    return false;
  }

  // d = -121665/121666 mod p
  const D = modP(-121665n * modInverse(121666n, P), P);

  const y2 = modP(y * y, P);
  const u = modP(y2 - 1n, P);
  const v = modP(D * y2 + 1n, P);

  // Check if u/v is a quadratic residue using Euler's criterion
  const vInv = modInverse(v, P);
  const ratio = modP(u * vInv, P);
  const euler = modPow(ratio, (P - 1n) / 2n, P);
  return euler === 0n || euler === 1n;
}

/** Modular arithmetic helpers */
function modP(a: bigint, p: bigint): bigint {
  return ((a % p) + p) % p;
}

function modInverse(a: bigint, p: bigint): bigint {
  return modPow(modP(a, p), p - 2n, p);
}

function modPow(base: bigint, exp: bigint, modulus: bigint): bigint {
  let result = 1n;
  base = modP(base, modulus);
  while (exp > 0n) {
    if (exp & 1n) {
      result = modP(result * base, modulus);
    }
    exp >>= 1n;
    base = modP(base * base, modulus);
  }
  return result;
}

// Re-export for testing
export { generateKeyPairSigner };
