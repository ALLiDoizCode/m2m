/**
 * Payment Channel SDK for Off-Chain Operations
 * Source: Epic 8 Story 8.7 - Off-Chain Payment Channel SDK
 *
 * This SDK wraps ethers.js for Base L2 blockchain interactions with TokenNetwork contracts.
 * Supports opening channels, signing EIP-712 balance proofs, closing channels, settling channels,
 * querying on-chain state, and listening to on-chain events.
 */

import { ethers } from 'ethers';
import type {
  ChannelState,
  BalanceProof,
  ChannelOpenedEvent,
  ChannelClosedEvent,
  ChannelSettledEvent,
  ChannelCooperativeSettledEvent,
} from '@m2m/shared';
import { getDomainSeparator, getBalanceProofTypes } from './eip712-helper';
import type { Logger } from '../utils/logger';
import type { KeyManager } from '../security/key-manager';
import { KeyManagerSigner } from '../security/key-manager-signer';
import type { EVMRPCConnectionPool } from '../utils/evm-rpc-connection-pool';

// TokenNetworkRegistry ABI - only methods we need
const REGISTRY_ABI = [
  'function createTokenNetwork(address token) external returns (address)',
  'function getTokenNetwork(address token) external view returns (address)',
  'event TokenNetworkCreated(address indexed token, address indexed tokenNetwork)',
];

// TokenNetwork ABI - only methods/events we need
const TOKEN_NETWORK_ABI = [
  'function openChannel(address participant2, uint256 settlementTimeout) external returns (bytes32)',
  'function setTotalDeposit(bytes32 channelId, address participant, uint256 totalDeposit) external',
  'function closeChannel(bytes32 channelId, tuple(bytes32 channelId, uint256 nonce, uint256 transferredAmount, uint256 lockedAmount, bytes32 locksRoot) balanceProof, bytes signature) external',
  'function cooperativeSettle(bytes32 channelId, tuple(bytes32 channelId, uint256 nonce, uint256 transferredAmount, uint256 lockedAmount, bytes32 locksRoot) proof1, bytes sig1, tuple(bytes32 channelId, uint256 nonce, uint256 transferredAmount, uint256 lockedAmount, bytes32 locksRoot) proof2, bytes sig2) external',
  'function settleChannel(bytes32 channelId) external',
  'function channels(bytes32) external view returns (uint256 settlementTimeout, uint8 state, uint256 closedAt, uint256 openedAt, address participant1, address participant2)',
  'function participants(bytes32, address) external view returns (uint256 deposit, uint256 withdrawnAmount, bool isCloser, uint256 nonce, uint256 transferredAmount)',
  'event ChannelOpened(bytes32 indexed channelId, address indexed participant1, address indexed participant2, uint256 settlementTimeout)',
  'event ChannelClosed(bytes32 indexed channelId, address indexed closingParticipant, uint256 nonce, bytes32 balanceHash)',
  'event ChannelSettled(bytes32 indexed channelId, uint256 participant1Amount, uint256 participant2Amount)',
  'event ChannelCooperativeSettled(bytes32 indexed channelId, uint256 participant1Amount, uint256 participant2Amount)',
];

// Standard ERC20 ABI for approvals
const ERC20_ABI = ['function approve(address spender, uint256 amount) external returns (bool)'];

/**
 * Custom error for challenge period not expired
 */
export class ChallengeNotExpiredError extends Error {
  constructor(
    message: string,
    public readonly channelId: string,
    public readonly closedAt: number,
    public readonly settlementTimeout: number
  ) {
    super(message);
    this.name = 'ChallengeNotExpiredError';
  }
}

/**
 * Payment Channel SDK Class
 * Manages off-chain payment channel operations with on-chain TokenNetwork contracts
 */
export class PaymentChannelSDK {
  private provider: ethers.Provider;
  private signer: ethers.Signer;
  private keyManager: KeyManager;
  private evmKeyId: string;
  private registryContract: ethers.Contract;
  private tokenNetworkCache: Map<string, ethers.Contract>; // token address → TokenNetwork contract
  private channelStateCache: Map<string, ChannelState>; // channelId → channel state
  private logger: Logger;
  private eventListeners: Map<string, Array<ethers.Listener>>; // Track event listeners for cleanup

  /**
   * Create a new PaymentChannelSDK instance
   *
   * @param provider - Ethers.js provider for blockchain queries
   * @param keyManager - KeyManager for secure key operations (EIP-712 signing and transaction signing)
   * @param evmKeyId - EVM key identifier for KeyManager (backend-specific format)
   * @param registryAddress - TokenNetworkRegistry contract address
   * @param logger - Pino logger instance
   */
  constructor(
    provider: ethers.Provider,
    keyManager: KeyManager,
    evmKeyId: string,
    registryAddress: string,
    logger: Logger
  ) {
    this.provider = provider;
    this.keyManager = keyManager;
    this.evmKeyId = evmKeyId;

    // Create KeyManager-backed signer for transaction signing
    this.signer = new KeyManagerSigner(keyManager, evmKeyId, provider);

    this.registryContract = new ethers.Contract(registryAddress, REGISTRY_ABI, this.signer);
    this.tokenNetworkCache = new Map();
    this.channelStateCache = new Map();
    this.logger = logger;
    this.eventListeners = new Map();
  }

  /**
   * Create a PaymentChannelSDK instance from a connection pool
   *
   * Uses the connection pool for failover and load balancing across multiple RPC endpoints.
   * For high-throughput scenarios, consider creating multiple SDK instances from the pool.
   *
   * @param pool - EVM RPC connection pool
   * @param keyManager - KeyManager for secure key operations
   * @param evmKeyId - EVM key identifier for KeyManager
   * @param registryAddress - TokenNetworkRegistry contract address
   * @param logger - Pino logger instance
   * @returns PaymentChannelSDK instance
   * @throws Error if no healthy connection available in pool
   *
   * [Source: Epic 12 Story 12.5 Task 6.4 - Connection pool integration]
   */
  static fromConnectionPool(
    pool: EVMRPCConnectionPool,
    keyManager: KeyManager,
    evmKeyId: string,
    registryAddress: string,
    logger: Logger
  ): PaymentChannelSDK {
    const provider = pool.getProvider();
    if (!provider) {
      throw new Error('No healthy EVM RPC connection available in pool');
    }

    logger.info('Creating PaymentChannelSDK from connection pool');
    return new PaymentChannelSDK(provider, keyManager, evmKeyId, registryAddress, logger);
  }

  /**
   * Get TokenNetwork contract for a given token address
   * Uses cache to avoid repeated registry lookups
   *
   * @param tokenAddress - ERC20 token address
   * @returns TokenNetwork contract instance
   */
  private async getTokenNetworkContract(tokenAddress: string): Promise<ethers.Contract> {
    // Check cache first
    if (this.tokenNetworkCache.has(tokenAddress)) {
      return this.tokenNetworkCache.get(tokenAddress)!;
    }

    // Query registry for TokenNetwork address
    const networkAddress = await this.registryContract.getTokenNetwork!(tokenAddress);
    if (networkAddress === ethers.ZeroAddress) {
      throw new Error(`No TokenNetwork found for token ${tokenAddress}`);
    }

    // Create contract instance and cache it
    const tokenNetwork = new ethers.Contract(networkAddress, TOKEN_NETWORK_ABI, this.signer);
    this.tokenNetworkCache.set(tokenAddress, tokenNetwork);

    this.logger.debug('TokenNetwork contract cached', { tokenAddress, networkAddress });

    return tokenNetwork;
  }

  /**
   * Get TokenNetwork address for a given token
   * Public method for external access to TokenNetwork addresses
   *
   * @param tokenAddress - ERC20 token address
   * @returns TokenNetwork contract address
   */
  async getTokenNetworkAddress(tokenAddress: string): Promise<string> {
    const contract = await this.getTokenNetworkContract(tokenAddress);
    return await contract.getAddress();
  }

  /**
   * Open a new payment channel with another participant
   *
   * @param participant2 - Counterparty address
   * @param tokenAddress - ERC20 token address for this channel
   * @param settlementTimeout - Challenge period duration in seconds
   * @param initialDeposit - Initial deposit amount (0 for no deposit)
   * @returns Channel ID (bytes32)
   */
  async openChannel(
    participant2: string,
    tokenAddress: string,
    settlementTimeout: number,
    initialDeposit: bigint
  ): Promise<string> {
    const tokenNetwork = await this.getTokenNetworkContract(tokenAddress);

    // Call openChannel on TokenNetwork contract
    this.logger.info('Opening payment channel', {
      participant2,
      tokenAddress,
      settlementTimeout,
      initialDeposit: initialDeposit.toString(),
    });

    const tx = await tokenNetwork.openChannel!(participant2, settlementTimeout);
    const receipt = await tx.wait();

    // Parse ChannelOpened event to extract channelId
    const channelOpenedEvent = receipt.logs
      .map((log: ethers.Log) => {
        try {
          return tokenNetwork.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
        } catch {
          return null;
        }
      })
      .find((parsed: ethers.LogDescription | null) => parsed?.name === 'ChannelOpened');

    if (!channelOpenedEvent) {
      throw new Error('ChannelOpened event not found in transaction receipt');
    }

    const channelId = channelOpenedEvent.args[0] as string;
    const [participant1, participant2Addr] = [
      channelOpenedEvent.args[1] as string,
      channelOpenedEvent.args[2] as string,
    ];

    // Initialize channel state cache
    const participants: [string, string] = [participant1, participant2Addr];
    this.channelStateCache.set(channelId, {
      channelId,
      participants,
      myDeposit: 0n,
      theirDeposit: 0n,
      myNonce: 0,
      theirNonce: 0,
      myTransferred: 0n,
      theirTransferred: 0n,
      status: 'opened',
      settlementTimeout,
      openedAt: Date.now() / 1000, // Approximate timestamp
    });

    this.logger.info('Channel opened successfully', {
      channelId,
      participant1,
      participant2: participant2Addr,
      txHash: receipt.hash,
    });

    // Handle initial deposit if specified
    if (initialDeposit > 0n) {
      await this.deposit(channelId, tokenAddress, initialDeposit);
    }

    return channelId;
  }

  /**
   * Deposit additional tokens to an open channel
   *
   * @param channelId - Channel identifier
   * @param tokenAddress - ERC20 token address
   * @param amount - Amount to deposit
   */
  async deposit(channelId: string, tokenAddress: string, amount: bigint): Promise<void> {
    const tokenNetwork = await this.getTokenNetworkContract(tokenAddress);
    const myAddress = await this.signer.getAddress();

    // Get current channel state
    const state = await this.getChannelState(channelId, tokenAddress);
    const newTotalDeposit = state.myDeposit + amount;

    this.logger.info('Depositing to channel', {
      channelId,
      amount: amount.toString(),
      newTotalDeposit: newTotalDeposit.toString(),
    });

    // Approve tokens for TokenNetwork contract
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.signer);
    const tokenNetworkAddress = await tokenNetwork.getAddress();
    const approveTx = await token.approve!(tokenNetworkAddress, amount);
    await approveTx.wait();

    // Call setTotalDeposit
    const tx = await tokenNetwork.setTotalDeposit!(channelId, myAddress, newTotalDeposit);
    await tx.wait();

    // Update cached state
    if (this.channelStateCache.has(channelId)) {
      const cached = this.channelStateCache.get(channelId)!;
      cached.myDeposit = newTotalDeposit;
      this.channelStateCache.set(channelId, cached);
    }

    this.logger.info('Deposit completed', {
      channelId,
      newTotalDeposit: newTotalDeposit.toString(),
    });
  }

  /**
   * Sign a balance proof using EIP-712
   *
   * @param channelId - Channel identifier
   * @param nonce - Monotonically increasing nonce
   * @param transferredAmount - Cumulative amount transferred to counterparty
   * @param lockedAmount - Amount in pending HTLCs (0 for now)
   * @param locksRoot - Merkle root of locked transfers (bytes32(0) for now)
   * @returns EIP-712 signature
   */
  async signBalanceProof(
    channelId: string,
    nonce: number,
    transferredAmount: bigint,
    lockedAmount: bigint = 0n,
    locksRoot: string = ethers.ZeroHash
  ): Promise<string> {
    // Determine which TokenNetwork this channel belongs to by querying all cached networks
    let tokenNetworkAddress: string | undefined;
    for (const [, contract] of this.tokenNetworkCache) {
      try {
        const channelData = await contract.channels!(channelId);
        if (channelData.state !== 0) {
          // NonExistent = 0
          tokenNetworkAddress = await contract.getAddress();
          break;
        }
      } catch {
        // Channel doesn't exist in this network, continue
        continue;
      }
    }

    if (!tokenNetworkAddress) {
      throw new Error(`Cannot determine TokenNetwork for channel ${channelId}`);
    }

    // Get chain ID
    const network = await this.provider.getNetwork();
    const chainId = network.chainId;

    // Build EIP-712 domain and types
    const domain = getDomainSeparator(chainId, tokenNetworkAddress);
    const types = getBalanceProofTypes();

    // Build balance proof object
    const balanceProof: BalanceProof = {
      channelId,
      nonce,
      transferredAmount,
      lockedAmount,
      locksRoot,
    };

    // Create EIP-712 hash
    const hash = ethers.TypedDataEncoder.hash(domain, types, balanceProof);

    // Sign the hash with KeyManager
    const signatureBuffer = await this.keyManager.sign(
      Buffer.from(hash.slice(2), 'hex'),
      this.evmKeyId
    );

    // Convert signature Buffer to hex string for blockchain submission
    const signature = '0x' + signatureBuffer.toString('hex');

    this.logger.debug('Balance proof signed', {
      channelId,
      nonce,
      transferredAmount: transferredAmount.toString(),
    });

    return signature;
  }

  /**
   * Verify a balance proof signature
   *
   * @param balanceProof - Balance proof to verify
   * @param signature - EIP-712 signature
   * @param expectedSigner - Expected signer address
   * @returns True if signature is valid
   */
  async verifyBalanceProof(
    balanceProof: BalanceProof,
    signature: string,
    expectedSigner: string
  ): Promise<boolean> {
    try {
      // Determine TokenNetwork address for this channel
      let tokenNetworkAddress: string | undefined;
      for (const [, contract] of this.tokenNetworkCache) {
        try {
          const channelData = await contract.channels!(balanceProof.channelId);
          if (channelData.state !== 0) {
            tokenNetworkAddress = await contract.getAddress();
            break;
          }
        } catch {
          continue;
        }
      }

      if (!tokenNetworkAddress) {
        this.logger.warn('Cannot determine TokenNetwork for balance proof verification', {
          channelId: balanceProof.channelId,
        });
        return false;
      }

      // Get chain ID
      const network = await this.provider.getNetwork();
      const chainId = network.chainId;

      // Build EIP-712 domain and types
      const domain = getDomainSeparator(chainId, tokenNetworkAddress);
      const types = getBalanceProofTypes();

      // Recover signer from signature
      const recoveredSigner = ethers.verifyTypedData(domain, types, balanceProof, signature);

      // Compare addresses (case-insensitive)
      const isValid = recoveredSigner.toLowerCase() === expectedSigner.toLowerCase();

      if (!isValid) {
        this.logger.warn('Balance proof verification failed', {
          balanceProof,
          expectedSigner,
          recoveredSigner,
        });
      }

      return isValid;
    } catch (error) {
      this.logger.error('Balance proof verification error', { balanceProof, error });
      return false;
    }
  }

  /**
   * Close a payment channel with a balance proof from counterparty
   *
   * @param channelId - Channel identifier
   * @param tokenAddress - ERC20 token address
   * @param balanceProof - Balance proof from counterparty
   * @param signature - EIP-712 signature of balance proof
   */
  async closeChannel(
    channelId: string,
    tokenAddress: string,
    balanceProof: BalanceProof,
    signature: string
  ): Promise<void> {
    const tokenNetwork = await this.getTokenNetworkContract(tokenAddress);
    const state = await this.getChannelState(channelId, tokenAddress);

    // Validate channel is opened
    if (state.status !== 'opened') {
      throw new Error(`Cannot close channel in status: ${state.status}`);
    }

    this.logger.info('Closing channel', { channelId, balanceProof });

    // Call closeChannel on contract
    const tx = await tokenNetwork.closeChannel!(channelId, balanceProof, signature);
    const receipt = await tx.wait();

    // Update cached state
    if (this.channelStateCache.has(channelId)) {
      const cached = this.channelStateCache.get(channelId)!;
      cached.status = 'closed';
      cached.closedAt = Date.now() / 1000;
      this.channelStateCache.set(channelId, cached);
    }

    this.logger.info('Channel closed', { channelId, txHash: receipt.hash });
  }

  /**
   * Cooperatively settle a channel with mutual consent (bypasses challenge period)
   *
   * @param channelId - Channel identifier
   * @param tokenAddress - ERC20 token address
   * @param myBalanceProof - My balance proof
   * @param mySignature - My signature on my balance proof
   * @param theirBalanceProof - Their balance proof
   * @param theirSignature - Their signature on their balance proof
   */
  async cooperativeSettle(
    channelId: string,
    tokenAddress: string,
    myBalanceProof: BalanceProof,
    mySignature: string,
    theirBalanceProof: BalanceProof,
    theirSignature: string
  ): Promise<void> {
    const tokenNetwork = await this.getTokenNetworkContract(tokenAddress);
    const state = await this.getChannelState(channelId, tokenAddress);

    // Validate channel is opened
    if (state.status !== 'opened') {
      throw new Error(`Cannot cooperatively settle channel in status: ${state.status}`);
    }

    this.logger.info('Cooperatively settling channel', { channelId });

    // Call cooperativeSettle on contract
    const tx = await tokenNetwork.cooperativeSettle!(
      channelId,
      myBalanceProof,
      mySignature,
      theirBalanceProof,
      theirSignature
    );
    const receipt = await tx.wait();

    // Update cached state
    if (this.channelStateCache.has(channelId)) {
      const cached = this.channelStateCache.get(channelId)!;
      cached.status = 'settled';
      this.channelStateCache.set(channelId, cached);
    }

    this.logger.info('Cooperative settlement completed', { channelId, txHash: receipt.hash });
  }

  /**
   * Settle a closed channel after challenge period expires
   *
   * @param channelId - Channel identifier
   * @param tokenAddress - ERC20 token address
   */
  async settleChannel(channelId: string, tokenAddress: string): Promise<void> {
    const tokenNetwork = await this.getTokenNetworkContract(tokenAddress);
    const state = await this.getChannelState(channelId, tokenAddress);

    // Validate channel is closed
    if (state.status !== 'closed') {
      throw new Error(`Cannot settle channel in status: ${state.status}`);
    }

    // Validate challenge period has expired
    if (!state.closedAt) {
      throw new Error('Channel closedAt timestamp is missing');
    }

    const now = Date.now() / 1000;
    const expiresAt = state.closedAt + state.settlementTimeout;

    if (now < expiresAt) {
      throw new ChallengeNotExpiredError(
        `Challenge period not expired. Expires at ${new Date(expiresAt * 1000).toISOString()}`,
        channelId,
        state.closedAt,
        state.settlementTimeout
      );
    }

    this.logger.info('Settling channel', { channelId });

    // Call settleChannel on contract
    const tx = await tokenNetwork.settleChannel!(channelId);
    const receipt = await tx.wait();

    // Update cached state
    if (this.channelStateCache.has(channelId)) {
      const cached = this.channelStateCache.get(channelId)!;
      cached.status = 'settled';
      this.channelStateCache.set(channelId, cached);
    }

    this.logger.info('Channel settled', { channelId, txHash: receipt.hash });
  }

  /**
   * Get channel state from blockchain or cache
   *
   * @param channelId - Channel identifier
   * @param tokenAddress - ERC20 token address (needed to determine which TokenNetwork)
   * @returns Channel state
   */
  async getChannelState(channelId: string, tokenAddress: string): Promise<ChannelState> {
    // Check cache first
    if (this.channelStateCache.has(channelId)) {
      return this.channelStateCache.get(channelId)!;
    }

    // Query on-chain state
    const tokenNetwork = await this.getTokenNetworkContract(tokenAddress);
    const myAddress = await this.signer.getAddress();

    // Query channel info
    const channelData = await tokenNetwork.channels!(channelId);
    const [settlementTimeout, stateEnum, closedAt, openedAt, participant1, participant2] = [
      channelData.settlementTimeout as bigint,
      channelData.state as number,
      channelData.closedAt as bigint,
      channelData.openedAt as bigint,
      channelData.participant1 as string,
      channelData.participant2 as string,
    ];

    // Map state enum to status string
    const stateMap: Record<number, 'opened' | 'closed' | 'settled'> = {
      0: 'settled', // NonExistent - treat as settled
      1: 'opened', // Opened
      2: 'closed', // Closed
      3: 'settled', // Settled
    };
    const status = stateMap[stateEnum] || 'settled';

    // Query participant states
    const myParticipantData = await tokenNetwork.participants!(channelId, myAddress);
    const counterparty =
      participant1.toLowerCase() === myAddress.toLowerCase() ? participant2 : participant1;
    const theirParticipantData = await tokenNetwork.participants!(channelId, counterparty);

    // Build channel state
    const state: ChannelState = {
      channelId,
      participants: [participant1, participant2],
      myDeposit: myParticipantData.deposit as bigint,
      theirDeposit: theirParticipantData.deposit as bigint,
      myNonce: Number(myParticipantData.nonce),
      theirNonce: Number(theirParticipantData.nonce),
      myTransferred: myParticipantData.transferredAmount as bigint,
      theirTransferred: theirParticipantData.transferredAmount as bigint,
      status,
      settlementTimeout: Number(settlementTimeout),
      closedAt: closedAt > 0 ? Number(closedAt) : undefined,
      openedAt: Number(openedAt),
    };

    // Cache state
    this.channelStateCache.set(channelId, state);

    return state;
  }

  /**
   * Get all channel IDs for the current signer and token
   *
   * @param tokenAddress - ERC20 token address
   * @returns Array of channel IDs
   */
  async getMyChannels(tokenAddress: string): Promise<string[]> {
    const tokenNetwork = await this.getTokenNetworkContract(tokenAddress);
    const myAddress = await this.signer.getAddress();

    // Query all ChannelOpened events
    const filter = tokenNetwork.filters.ChannelOpened!();
    const events = await tokenNetwork.queryFilter(filter);

    // Filter events where I am a participant
    const myChannels = events
      .filter((event) => {
        const eventLog = event as ethers.EventLog;
        const participant1 = eventLog.args[1] as string;
        const participant2 = eventLog.args[2] as string;
        return (
          participant1.toLowerCase() === myAddress.toLowerCase() ||
          participant2.toLowerCase() === myAddress.toLowerCase()
        );
      })
      .map((event) => {
        const eventLog = event as ethers.EventLog;
        return eventLog.args[0] as string;
      });

    return myChannels;
  }

  /**
   * Register callback for ChannelOpened events
   *
   * @param tokenAddress - ERC20 token address to listen for
   * @param callback - Callback function to invoke on event
   */
  async onChannelOpened(
    tokenAddress: string,
    callback: (event: ChannelOpenedEvent) => void
  ): Promise<void> {
    const tokenNetwork = await this.getTokenNetworkContract(tokenAddress);

    const listener = (
      channelId: string,
      participant1: string,
      participant2: string,
      settlementTimeout: bigint
    ): void => {
      const event: ChannelOpenedEvent = {
        type: 'ChannelOpened',
        channelId,
        participant1,
        participant2,
        settlementTimeout: Number(settlementTimeout),
      };

      // Update cache
      this.channelStateCache.set(channelId, {
        channelId,
        participants: [participant1, participant2],
        myDeposit: 0n,
        theirDeposit: 0n,
        myNonce: 0,
        theirNonce: 0,
        myTransferred: 0n,
        theirTransferred: 0n,
        status: 'opened',
        settlementTimeout: Number(settlementTimeout),
        openedAt: Date.now() / 1000,
      });

      callback(event);
    };

    tokenNetwork.on('ChannelOpened', listener);

    // Track listener for cleanup
    const key = `${tokenAddress}:ChannelOpened`;
    if (!this.eventListeners.has(key)) {
      this.eventListeners.set(key, []);
    }
    this.eventListeners.get(key)!.push(listener);
  }

  /**
   * Register callback for ChannelClosed events
   *
   * @param tokenAddress - ERC20 token address to listen for
   * @param callback - Callback function to invoke on event
   */
  async onChannelClosed(
    tokenAddress: string,
    callback: (event: ChannelClosedEvent) => void
  ): Promise<void> {
    const tokenNetwork = await this.getTokenNetworkContract(tokenAddress);

    const listener = (
      channelId: string,
      closingParticipant: string,
      nonce: bigint,
      balanceHash: string
    ): void => {
      const event: ChannelClosedEvent = {
        type: 'ChannelClosed',
        channelId,
        closingParticipant,
        nonce: Number(nonce),
        balanceHash,
      };

      // Update cache
      if (this.channelStateCache.has(channelId)) {
        const cached = this.channelStateCache.get(channelId)!;
        cached.status = 'closed';
        cached.closedAt = Date.now() / 1000;
        this.channelStateCache.set(channelId, cached);
      }

      callback(event);
    };

    tokenNetwork.on('ChannelClosed', listener);

    // Track listener for cleanup
    const key = `${tokenAddress}:ChannelClosed`;
    if (!this.eventListeners.has(key)) {
      this.eventListeners.set(key, []);
    }
    this.eventListeners.get(key)!.push(listener);
  }

  /**
   * Register callback for ChannelSettled events
   *
   * @param tokenAddress - ERC20 token address to listen for
   * @param callback - Callback function to invoke on event
   */
  async onChannelSettled(
    tokenAddress: string,
    callback: (event: ChannelSettledEvent) => void
  ): Promise<void> {
    const tokenNetwork = await this.getTokenNetworkContract(tokenAddress);

    const listener = (
      channelId: string,
      participant1Amount: bigint,
      participant2Amount: bigint
    ): void => {
      const event: ChannelSettledEvent = {
        type: 'ChannelSettled',
        channelId,
        participant1Amount,
        participant2Amount,
      };

      // Update cache
      if (this.channelStateCache.has(channelId)) {
        const cached = this.channelStateCache.get(channelId)!;
        cached.status = 'settled';
        this.channelStateCache.set(channelId, cached);
      }

      callback(event);
    };

    tokenNetwork.on('ChannelSettled', listener);

    // Track listener for cleanup
    const key = `${tokenAddress}:ChannelSettled`;
    if (!this.eventListeners.has(key)) {
      this.eventListeners.set(key, []);
    }
    this.eventListeners.get(key)!.push(listener);
  }

  /**
   * Register callback for ChannelCooperativeSettled events
   *
   * @param tokenAddress - ERC20 token address to listen for
   * @param callback - Callback function to invoke on event
   */
  async onChannelCooperativeSettled(
    tokenAddress: string,
    callback: (event: ChannelCooperativeSettledEvent) => void
  ): Promise<void> {
    const tokenNetwork = await this.getTokenNetworkContract(tokenAddress);

    const listener = (
      channelId: string,
      participant1Amount: bigint,
      participant2Amount: bigint
    ): void => {
      const event: ChannelCooperativeSettledEvent = {
        type: 'ChannelCooperativeSettled',
        channelId,
        participant1Amount,
        participant2Amount,
      };

      // Update cache
      if (this.channelStateCache.has(channelId)) {
        const cached = this.channelStateCache.get(channelId)!;
        cached.status = 'settled';
        this.channelStateCache.set(channelId, cached);
      }

      callback(event);
    };

    tokenNetwork.on('ChannelCooperativeSettled', listener);

    // Track listener for cleanup
    const key = `${tokenAddress}:ChannelCooperativeSettled`;
    if (!this.eventListeners.has(key)) {
      this.eventListeners.set(key, []);
    }
    this.eventListeners.get(key)!.push(listener);
  }

  /**
   * Remove all event listeners
   * Should be called when SDK is no longer needed to prevent memory leaks
   */
  removeAllListeners(): void {
    for (const [, contract] of this.tokenNetworkCache) {
      contract.removeAllListeners();
    }
    this.eventListeners.clear();
    this.logger.debug('All event listeners removed');
  }
}
