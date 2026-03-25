/**
 * BTP Payment Channel Claim Protocol Message Types
 *
 * This module defines the standardized message format for exchanging payment channel
 * claims over the Bilateral Transfer Protocol (BTP). Claims are sent via BTP's
 * protocolData field with protocol name "payment-channel-claim" and content type 1 (JSON).
 *
 * Supports EVM-compatible chains (Raiden-style payment channels), with stub types
 * for Solana and Mina chains (Epic 32 chain abstraction).
 *
 * Reference: RFC-0023 (Bilateral Transfer Protocol), Epic 17 PRD
 *
 * @module btp-claim-types
 */

/**
 * Supported blockchain types for payment channel claims.
 */
export type BlockchainType = 'evm' | 'solana' | 'mina';

/**
 * Base claim message structure shared across all blockchain types.
 *
 * Common fields:
 * - `version`: Protocol version (currently '1.0')
 * - `blockchain`: Discriminator for blockchain-specific claim structure
 * - `messageId`: Unique identifier for idempotent message processing
 * - `timestamp`: ISO 8601 timestamp for message creation time
 * - `senderId`: Peer ID of the sender (for correlation with BTP connection)
 */
export interface BaseClaimMessage {
  version: '1.0';
  blockchain: BlockchainType;
  messageId: string;
  timestamp: string;
  senderId: string;
}

/**
 * EVM-compatible blockchain claim message (Raiden-style balance proofs).
 *
 * Fields:
 * - `channelId`: bytes32 hex string (0x-prefixed) identifying the payment channel
 * - `nonce`: Monotonically increasing balance proof nonce (prevents replay attacks)
 * - `transferredAmount`: Cumulative transferred amount (bigint precision)
 * - `lockedAmount`: Locked amount for pending transfers (0 for simple transfers)
 * - `locksRoot`: Merkle root of locked transfers (32-byte hex, zeros if no locks)
 * - `signature`: EIP-712 typed signature (hex string)
 * - `signerAddress`: Ethereum address of the signer (0x-prefixed, 40 hex chars)
 * - `chainId`: (Optional) EVM chain ID (e.g., 8453 for Base, 84532 for Base Sepolia)
 * - `tokenNetworkAddress`: (Optional) TokenNetwork contract address (0x-prefixed, 40 hex chars)
 * - `tokenAddress`: (Optional) ERC20 token contract address (0x-prefixed, 40 hex chars)
 *
 * The optional self-describing fields enable dynamic on-chain verification of unknown channels
 * without pre-registration. These fields are cryptographically bound to the EIP-712 signature
 * via the domain separator (chainId and tokenNetworkAddress are part of the signing domain).
 *
 * Example:
 * ```typescript
 * const evmClaim: EVMClaimMessage = {
 *   version: '1.0',
 *   blockchain: 'evm',
 *   messageId: 'claim-002',
 *   timestamp: '2026-02-02T12:00:00.000Z',
 *   senderId: 'peer-bob',
 *   channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
 *   nonce: 5,
 *   transferredAmount: '1000000000000000000', // 1 ETH in wei
 *   lockedAmount: '0',
 *   locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
 *   signature: '0xabcdef...', // EIP-712 signature
 *   signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
 *   chainId: 8453, // Base mainnet
 *   tokenNetworkAddress: '0x1234567890123456789012345678901234567890',
 *   tokenAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
 * };
 * ```
 */
export interface EVMClaimMessage extends BaseClaimMessage {
  blockchain: 'evm';
  channelId: string;
  nonce: number;
  transferredAmount: string;
  lockedAmount: string;
  locksRoot: string;
  signature: string;
  signerAddress: string;
  chainId?: number;
  tokenNetworkAddress?: string;
  tokenAddress?: string;
}

/**
 * Solana-compatible blockchain claim message.
 *
 * Supports Solana payment channel claims using Ed25519 signatures
 * and PDA-based channel accounts. No runtime Solana SDK dependencies — types only.
 *
 * Fields:
 * - `programId`: Base58-encoded Solana program address for the payment channel program
 * - `channelAccount`: Base58-encoded PDA (program-derived address) for the channel state account
 * - `nonce`: Monotonically increasing balance proof nonce (prevents replay attacks)
 * - `transferredAmount`: Cumulative transferred amount in lamports (string for bigint precision)
 * - `signature`: Base64-encoded Ed25519 signature over the claim data
 * - `signerPublicKey`: Base58-encoded Ed25519 public key of the signer
 * - `cluster`: (Optional) Solana cluster identifier (e.g., 'mainnet-beta', 'devnet')
 */
export interface SolanaClaimMessage extends BaseClaimMessage {
  blockchain: 'solana';
  /** Solana program ID for the payment channel program (base58) */
  programId: string;
  /** On-chain PDA account address for the payment channel (base58) */
  channelAccount: string;
  /** Monotonically increasing balance proof nonce */
  nonce: number;
  /** Cumulative transferred amount in lamports (string for bigint precision) */
  transferredAmount: string;
  /** Ed25519 signature over the claim data (base64) */
  signature: string;
  /** Base58-encoded Ed25519 public key of the signer */
  signerPublicKey: string;
  /** Optional Solana cluster identifier */
  cluster?: string;
}

/**
 * Mina-compatible blockchain claim message stub.
 *
 * Placeholder for future Mina zkApp payment channel integration.
 * No runtime Mina SDK dependencies — types only.
 */
export interface MinaClaimMessage extends BaseClaimMessage {
  blockchain: 'mina';
  /** zkApp address for the payment channel contract */
  zkAppAddress: string;
  /** Zero-knowledge proof for the balance update */
  proof: string;
}

/**
 * Union type representing any valid BTP claim message.
 * Discriminated on the `blockchain` field.
 */
export type BTPClaimMessage = EVMClaimMessage | SolanaClaimMessage | MinaClaimMessage;

/**
 * BTP Claim Protocol Constants
 *
 * These constants define the BTP protocolData fields for claim messages:
 * - `NAME`: Protocol name used in BTPProtocolData.protocolName
 * - `CONTENT_TYPE`: Content type code (1 = application/json)
 * - `VERSION`: Current protocol version
 */
export const BTP_CLAIM_PROTOCOL = {
  NAME: 'payment-channel-claim',
  CONTENT_TYPE: 1,
  VERSION: '1.0',
} as const;

/**
 * Type guard to check if a claim message is an EVM claim.
 *
 * Usage:
 * ```typescript
 * if (isEVMClaim(msg)) {
 *   // TypeScript knows msg is EVMClaimMessage here
 *   console.log(msg.channelId);
 * }
 * ```
 */
export function isEVMClaim(msg: BTPClaimMessage): msg is EVMClaimMessage {
  return msg.blockchain === 'evm';
}

/**
 * Type guard to check if a claim message is a Solana claim.
 *
 * Usage:
 * ```typescript
 * if (isSolanaClaim(msg)) {
 *   // TypeScript knows msg is SolanaClaimMessage here
 *   console.log(msg.programId);
 * }
 * ```
 */
export function isSolanaClaim(msg: BTPClaimMessage): msg is SolanaClaimMessage {
  return msg.blockchain === 'solana';
}

/**
 * Type guard to check if a claim message is a Mina claim.
 *
 * Usage:
 * ```typescript
 * if (isMinaClaim(msg)) {
 *   // TypeScript knows msg is MinaClaimMessage here
 *   console.log(msg.zkAppAddress);
 * }
 * ```
 */
export function isMinaClaim(msg: BTPClaimMessage): msg is MinaClaimMessage {
  return msg.blockchain === 'mina';
}

/**
 * Validate Solana claim structure
 * @throws Error if claim is invalid
 */
function validateSolanaClaim(claim: Partial<SolanaClaimMessage>): void {
  // Required fields
  if (!claim.programId || typeof claim.programId !== 'string') {
    throw new Error('Missing or invalid programId (expected non-empty string)');
  }
  if (!claim.channelAccount || typeof claim.channelAccount !== 'string') {
    throw new Error('Missing or invalid channelAccount (expected non-empty string)');
  }
  if (claim.nonce === undefined || typeof claim.nonce !== 'number' || claim.nonce < 0) {
    throw new Error('Missing or invalid nonce (expected non-negative number)');
  }
  if (!claim.transferredAmount || typeof claim.transferredAmount !== 'string') {
    throw new Error('Missing or invalid transferredAmount (expected non-empty string)');
  }
  if (!claim.signature || typeof claim.signature !== 'string') {
    throw new Error('Missing or invalid signature (expected non-empty string)');
  }
  if (!claim.signerPublicKey || typeof claim.signerPublicKey !== 'string') {
    throw new Error('Missing or invalid signerPublicKey (expected non-empty string)');
  }

  // Base58 format validation for Solana addresses (32-44 chars, no 0/O/I/l)
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  if (!base58Regex.test(claim.programId)) {
    throw new Error('Invalid programId format (expected base58-encoded Solana address)');
  }
  if (!base58Regex.test(claim.channelAccount)) {
    throw new Error('Invalid channelAccount format (expected base58-encoded Solana address)');
  }
  if (!base58Regex.test(claim.signerPublicKey)) {
    throw new Error('Invalid signerPublicKey format (expected base58-encoded Solana public key)');
  }

  // Amount validation (non-negative integers as strings)
  if (!/^\d+$/.test(claim.transferredAmount)) {
    throw new Error('Invalid transferredAmount (expected non-negative integer string)');
  }

  // Optional cluster validation
  if (claim.cluster !== undefined) {
    if (typeof claim.cluster !== 'string') {
      throw new Error('Invalid cluster (expected string)');
    }
    const validClusters = ['mainnet-beta', 'devnet', 'testnet', 'localnet'];
    if (!validClusters.includes(claim.cluster)) {
      throw new Error(`Invalid cluster (expected one of: ${validClusters.join(', ')})`);
    }
  }
}

/**
 * Validate EVM claim structure
 * @throws Error if claim is invalid
 */
function validateEVMClaim(claim: Partial<EVMClaimMessage>): void {
  // Required fields
  if (!claim.channelId || typeof claim.channelId !== 'string') {
    throw new Error('Missing or invalid channelId (expected non-empty string)');
  }
  if (claim.nonce === undefined || typeof claim.nonce !== 'number' || claim.nonce < 0) {
    throw new Error('Missing or invalid nonce (expected non-negative number)');
  }
  if (!claim.transferredAmount || typeof claim.transferredAmount !== 'string') {
    throw new Error('Missing or invalid transferredAmount (expected non-empty string)');
  }
  if (!claim.lockedAmount || typeof claim.lockedAmount !== 'string') {
    throw new Error('Missing or invalid lockedAmount (expected non-empty string)');
  }
  if (!claim.locksRoot || typeof claim.locksRoot !== 'string') {
    throw new Error('Missing or invalid locksRoot (expected non-empty string)');
  }
  if (!claim.signature || typeof claim.signature !== 'string') {
    throw new Error('Missing or invalid signature (expected non-empty string)');
  }
  if (!claim.signerAddress || typeof claim.signerAddress !== 'string') {
    throw new Error('Missing or invalid signerAddress (expected non-empty string)');
  }

  // channelId format validation
  if (!/^0x[0-9a-fA-F]{64}$/.test(claim.channelId)) {
    throw new Error('Invalid channelId format (expected 0x-prefixed 64-char hex)');
  }

  // signerAddress format validation
  if (!/^0x[0-9a-fA-F]{40}$/.test(claim.signerAddress)) {
    throw new Error('Invalid signerAddress format (expected 0x-prefixed 40-char hex)');
  }

  // locksRoot format validation
  if (!/^0x[0-9a-fA-F]{64}$/.test(claim.locksRoot)) {
    throw new Error('Invalid locksRoot format (expected 0x-prefixed 64-char hex)');
  }

  // Amount validation (non-negative integers as strings)
  if (!/^\d+$/.test(claim.transferredAmount)) {
    throw new Error('Invalid transferredAmount (expected non-negative integer string)');
  }
  if (!/^\d+$/.test(claim.lockedAmount)) {
    throw new Error('Invalid lockedAmount (expected non-negative integer string)');
  }

  // Optional self-describing fields validation (Epic 31)
  if (claim.chainId !== undefined) {
    if (
      typeof claim.chainId !== 'number' ||
      !Number.isInteger(claim.chainId) ||
      claim.chainId <= 0
    ) {
      throw new Error('Invalid chainId (expected positive integer)');
    }
  }

  if (claim.tokenNetworkAddress !== undefined) {
    if (typeof claim.tokenNetworkAddress !== 'string') {
      throw new Error('Invalid tokenNetworkAddress (expected string)');
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(claim.tokenNetworkAddress)) {
      throw new Error('Invalid tokenNetworkAddress format (expected 0x-prefixed 40-char hex)');
    }
  }

  if (claim.tokenAddress !== undefined) {
    if (typeof claim.tokenAddress !== 'string') {
      throw new Error('Invalid tokenAddress (expected string)');
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(claim.tokenAddress)) {
      throw new Error('Invalid tokenAddress format (expected 0x-prefixed 40-char hex)');
    }
  }
}

/**
 * Validate a BTP claim message structure.
 *
 * This function performs comprehensive validation of a claim message:
 * - Checks base fields (version, blockchain, messageId, timestamp, senderId)
 * - Validates blockchain-specific fields based on the `blockchain` discriminator
 * - Throws descriptive errors if validation fails
 *
 * Validates base fields and dispatches to chain-specific validators based on the
 * `blockchain` discriminator. After validation, callers should use type guards
 * (`isEVMClaim`, `isSolanaClaim`, `isMinaClaim`) to narrow to chain-specific types.
 *
 * @param msg - Unknown value to validate as BTPClaimMessage
 * @throws Error if validation fails
 *
 * @example
 * ```typescript
 * try {
 *   validateClaimMessage(receivedData);
 *   // receivedData is now guaranteed to be BTPClaimMessage
 *   if (isEVMClaim(receivedData)) { ... }
 *   if (isSolanaClaim(receivedData)) { ... }
 * } catch (error) {
 *   logger.error({ error }, 'Invalid claim message received');
 * }
 * ```
 */
export function validateClaimMessage(msg: unknown): asserts msg is BTPClaimMessage {
  // Type check
  if (typeof msg !== 'object' || msg === null) {
    throw new Error('Claim message must be an object');
  }

  const claim = msg as Partial<BTPClaimMessage>;

  // Validate base fields
  if (claim.version !== '1.0') {
    throw new Error(`Invalid version (expected '1.0', got '${claim.version}')`);
  }

  if (!claim.blockchain) {
    throw new Error('Missing blockchain field');
  }

  if (!claim.messageId || typeof claim.messageId !== 'string') {
    throw new Error('Missing or invalid messageId (expected non-empty string)');
  }

  if (!claim.timestamp || typeof claim.timestamp !== 'string') {
    throw new Error('Missing or invalid timestamp (expected ISO 8601 string)');
  }

  // Validate ISO 8601 timestamp format
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(claim.timestamp)) {
    throw new Error('Invalid timestamp format (expected ISO 8601 with Z timezone)');
  }

  if (!claim.senderId || typeof claim.senderId !== 'string') {
    throw new Error('Missing or invalid senderId (expected non-empty string)');
  }

  // Validate blockchain-specific fields
  switch (claim.blockchain) {
    case 'evm':
      validateEVMClaim(claim as Partial<EVMClaimMessage>);
      break;
    case 'solana':
      validateSolanaClaim(claim as Partial<SolanaClaimMessage>);
      break;
    case 'mina':
      throw new Error("Blockchain type 'mina' validation not yet supported");
    default:
      throw new Error(`Unsupported blockchain type: ${claim.blockchain}`);
  }
}
