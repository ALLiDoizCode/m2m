/**
 * Payment Channel SDK for Base L2 payment channel operations (Story 8.7)
 *
 * This SDK provides TypeScript interfaces for interacting with Epic 8's
 * EVM-based payment channel smart contracts deployed to Base L2.
 *
 * Key capabilities:
 * - Open payment channels with ERC20 token deposits
 * - Sign off-chain balance proofs using EIP-712
 * - Submit on-chain settlement transactions (close, settle)
 * - Query channel state from blockchain
 * - Listen for real-time channel events
 *
 * Source: Epic 8 Story 8.7, docs/architecture/tech-stack.md ethers.js
 */

import { ethers } from 'ethers';
import type {
  PaymentChannelSDKConfig,
  ChannelState,
  BalanceProof,
  ChannelEventListener,
  ChannelOpenedEvent,
  ChannelClosedEvent,
  ChannelSettledEvent,
  ChannelDepositEvent,
} from './payment-channel-types';

/**
 * Minimal ABI fragments for TokenNetworkRegistry contract
 *
 * Source: Story 8.2 TokenNetworkRegistry implementation
 * These fragments cover only the functions and events required by the SDK.
 */
const TOKEN_NETWORK_REGISTRY_ABI = [
  // createTokenNetwork(address _tokenAddress) external returns (address)
  'function createTokenNetwork(address _tokenAddress) external returns (address)',

  // getTokenNetwork(address _tokenAddress) external view returns (address)
  'function getTokenNetwork(address _tokenAddress) external view returns (address)',

  // event TokenNetworkCreated(address indexed tokenAddress, address indexed tokenNetworkAddress)
  'event TokenNetworkCreated(address indexed tokenAddress, address indexed tokenNetworkAddress)',
];

/**
 * Minimal ABI fragments for TokenNetwork contract
 *
 * Source: Story 8.3 TokenNetwork core implementation, Story 8.4 settlement operations
 * These fragments cover functions and events for channel management.
 */
const TOKEN_NETWORK_ABI = [
  // openChannel(address _participant2, uint256 _settlementTimeout) external returns (bytes32)
  'function openChannel(address _participant2, uint256 _settlementTimeout) external returns (bytes32)',

  // setTotalDeposit(bytes32 _channelId, address _participant, uint256 _totalDeposit) external
  'function setTotalDeposit(bytes32 _channelId, address _participant, uint256 _totalDeposit) external',

  // closeChannel(bytes32 _channelId, tuple(bytes32 channelId, uint256 nonce, uint256 transferredAmount, uint256 lockedAmount, bytes32 locksRoot) _balanceProof, bytes _signature) external
  'function closeChannel(bytes32 _channelId, tuple(bytes32 channelId, uint256 nonce, uint256 transferredAmount, uint256 lockedAmount, bytes32 locksRoot) _balanceProof, bytes _signature) external',

  // settleChannel(bytes32 _channelId) external
  'function settleChannel(bytes32 _channelId) external',

  // updateNonClosingBalanceProof(bytes32 _channelId, tuple(bytes32 channelId, uint256 nonce, uint256 transferredAmount, uint256 lockedAmount, bytes32 locksRoot) _balanceProof, bytes _signature) external
  'function updateNonClosingBalanceProof(bytes32 _channelId, tuple(bytes32 channelId, uint256 nonce, uint256 transferredAmount, uint256 lockedAmount, bytes32 locksRoot) _balanceProof, bytes _signature) external',

  // getChannel(bytes32 _channelId) external view returns (tuple)
  'function getChannel(bytes32 _channelId) external view returns (tuple(address participant1, address participant2, uint8 state, uint256 settlementTimeout, tuple(uint256 deposit, uint256 withdrawn, uint256 nonce, uint256 transferredAmount, bytes32 locksRoot) participant1State, tuple(uint256 deposit, uint256 withdrawn, uint256 nonce, uint256 transferredAmount, bytes32 locksRoot) participant2State))',

  // event ChannelOpened(bytes32 indexed channelId, address indexed participant1, address indexed participant2, uint256 settlementTimeout)
  'event ChannelOpened(bytes32 indexed channelId, address indexed participant1, address indexed participant2, uint256 settlementTimeout)',

  // event ChannelClosed(bytes32 indexed channelId, address indexed closingParticipant, uint256 nonce)
  'event ChannelClosed(bytes32 indexed channelId, address indexed closingParticipant, uint256 nonce)',

  // event ChannelSettled(bytes32 indexed channelId, uint256 participant1Balance, uint256 participant2Balance)
  'event ChannelSettled(bytes32 indexed channelId, uint256 participant1Balance, uint256 participant2Balance)',

  // event ChannelDeposit(bytes32 indexed channelId, address indexed participant, uint256 totalDeposit)
  'event ChannelDeposit(bytes32 indexed channelId, address indexed participant, uint256 totalDeposit)',
];

/**
 * Minimal ERC20 ABI fragments for token operations
 *
 * Source: ERC20 standard, required for token approvals and balance checks
 */
const ERC20_ABI = [
  // approve(address spender, uint256 amount) external returns (bool)
  'function approve(address spender, uint256 amount) external returns (bool)',

  // balanceOf(address account) external view returns (uint256)
  'function balanceOf(address account) external view returns (uint256)',

  // symbol() external view returns (string)
  'function symbol() external view returns (string)',
];

/**
 * EIP-712 type definitions for BalanceProof signing
 *
 * Source: Epic 8 Story 8.7 EIP-712 Signing lines 475-483, Story 8.4 Balance Proof Verification
 */
const BALANCE_PROOF_TYPES = {
  BalanceProof: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'transferredAmount', type: 'uint256' },
    { name: 'lockedAmount', type: 'uint256' },
    { name: 'locksRoot', type: 'bytes32' },
  ],
};

/**
 * Main Payment Channel SDK class
 *
 * Provides methods for interacting with payment channel smart contracts on Base L2.
 * Wraps ethers.js for blockchain interactions and implements EIP-712 signing.
 *
 * Source: Epic 8 Story 8.7 SDK Interface lines 424-461
 */
export class PaymentChannelSDK {
  private readonly config: PaymentChannelSDKConfig;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly signer: ethers.Wallet;
  private readonly registry: ethers.Contract;
  private readonly channelCache: Map<string, ChannelState>;
  private readonly tokenNetworkCache: Map<string, string>; // token address → TokenNetwork address
  private readonly listeners: ChannelEventListener[];
  private pollingInterval?: NodeJS.Timeout;
  private lastProcessedBlock: number;

  /**
   * Creates a new PaymentChannelSDK instance
   *
   * @param config - SDK configuration including RPC URL, private key, registry address
   * @throws Error if configuration is invalid or RPC connection fails
   */
  constructor(config: PaymentChannelSDKConfig) {
    this.config = {
      ...config,
      confirmations: config.confirmations ?? (config.chainId === 31337 ? 1 : 3),
    };

    // Initialize ethers.js provider and signer
    this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
    this.signer = new ethers.Wallet(this.config.privateKey, this.provider);

    // Initialize TokenNetworkRegistry contract
    this.registry = new ethers.Contract(
      this.config.registryAddress,
      TOKEN_NETWORK_REGISTRY_ABI,
      this.signer
    );

    // Initialize caches
    this.channelCache = new Map();
    this.tokenNetworkCache = new Map();
    this.listeners = [];
    this.lastProcessedBlock = 0;
  }

  /**
   * Opens a new payment channel with a peer
   *
   * @param participant2 - Counterparty Ethereum address
   * @param tokenAddress - ERC20 token contract address
   * @param settlementTimeout - Challenge period in seconds (e.g., 3600 for 1 hour)
   * @param initialDeposit - Initial token deposit amount (wei)
   * @returns Channel ID (bytes32 as hex string)
   *
   * Source: Epic 8 Story 8.7 SDK Interface lines 428-434, Story 8.3 TokenNetwork.openChannel
   */
  async openChannel(
    participant2: string,
    tokenAddress: string,
    settlementTimeout: number,
    initialDeposit: bigint
  ): Promise<string> {
    // Validate inputs
    if (!ethers.isAddress(participant2)) {
      throw new Error(`Invalid participant address: ${participant2}`);
    }
    if (!ethers.isAddress(tokenAddress)) {
      throw new Error(`Invalid token address: ${tokenAddress}`);
    }

    // Step 1: Get or create TokenNetwork for the token
    const tokenNetworkAddress = await this._getOrCreateTokenNetwork(tokenAddress);

    // Step 2: Load TokenNetwork contract instance
    const tokenNetwork = new ethers.Contract(tokenNetworkAddress, TOKEN_NETWORK_ABI, this.signer);

    // Step 3: Open channel on TokenNetwork
    const tx = await tokenNetwork.openChannel(participant2, settlementTimeout);
    const receipt = await tx.wait(this.config.confirmations);

    // Extract ChannelOpened event from transaction receipt
    const channelOpenedEvent = receipt?.logs
      .map((log: ethers.Log) => {
        try {
          return tokenNetwork.interface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
        } catch {
          return null;
        }
      })
      .find((parsedLog: ethers.LogDescription | null) => parsedLog?.name === 'ChannelOpened');

    if (!channelOpenedEvent) {
      throw new Error('ChannelOpened event not found in transaction receipt');
    }

    const channelId = channelOpenedEvent.args.channelId as string;

    // Step 4: Deposit initial funds (if initialDeposit > 0)
    if (initialDeposit > 0n) {
      await this._approveToken(tokenAddress, tokenNetworkAddress, initialDeposit);
      await this._setTotalDeposit(tokenNetwork, channelId, this.signer.address, initialDeposit);
    }

    // Step 5: Cache channel state locally
    this._updateCache(channelId, {
      channelId,
      participants: [this.signer.address, participant2],
      myDeposit: initialDeposit,
      theirDeposit: 0n,
      myNonce: 0,
      theirNonce: 0,
      myTransferred: 0n,
      theirTransferred: 0n,
      status: 'opened',
      tokenAddress,
      tokenNetworkAddress,
      settlementTimeout,
    });

    return channelId;
  }

  /**
   * Deposits additional tokens into an existing channel
   *
   * @param channelId - Channel identifier (bytes32 hex string)
   * @param amount - Additional deposit amount (wei)
   *
   * Source: Epic 8 Story 8.7 SDK Interface line 436, Story 8.3 TokenNetwork.setTotalDeposit
   */
  async deposit(channelId: string, amount: bigint): Promise<void> {
    // Validate inputs
    if (amount <= 0n) {
      throw new Error('Deposit amount must be greater than zero');
    }

    // Step 1: Get channel state to determine TokenNetwork address and token
    const channelState = await this.getChannelState(channelId);

    // Step 2: Calculate new total deposit
    const newTotalDeposit = channelState.myDeposit + amount;

    // Step 3: Approve ERC20 token spending
    await this._approveToken(channelState.tokenAddress, channelState.tokenNetworkAddress, amount);

    // Step 4: Load TokenNetwork contract and submit deposit transaction
    const tokenNetwork = new ethers.Contract(
      channelState.tokenNetworkAddress,
      TOKEN_NETWORK_ABI,
      this.signer
    );

    await this._setTotalDeposit(tokenNetwork, channelId, this.signer.address, newTotalDeposit);

    // Step 5: Update local cache with new deposit amount
    this._updateCache(channelId, {
      myDeposit: newTotalDeposit,
    });
  }

  /**
   * Signs a balance proof using EIP-712 typed structured data signing
   *
   * @param channelId - Channel identifier (bytes32 hex string)
   * @param nonce - Monotonically increasing nonce
   * @param transferredAmount - Cumulative amount sent to counterparty (wei)
   * @returns Signature as hex string (65 bytes, 0x + 130 chars)
   *
   * Source: Epic 8 Story 8.7 SDK Interface lines 438-439, EIP-712 Signing lines 485-487
   */
  async signBalanceProof(
    channelId: string,
    nonce: number,
    transferredAmount: bigint
  ): Promise<string> {
    // Step 1: Get channel state to determine TokenNetwork address
    const channelState = await this.getChannelState(channelId);

    // Step 2: Construct BalanceProof object
    const balanceProof: BalanceProof = {
      channelId,
      nonce,
      transferredAmount,
      lockedAmount: 0n, // MVP: no hash-locked transfers
      locksRoot: '0x' + '0'.repeat(64), // MVP: no locks
    };

    // Step 3: Get EIP-712 domain separator
    const domain = this._getDomainSeparator(channelState.tokenNetworkAddress);

    // Step 4: Sign typed data using ethers.js
    const signature = await this.signer.signTypedData(domain, BALANCE_PROOF_TYPES, balanceProof);

    // Step 5: Validate signature format
    if (signature.length !== 132 || !signature.startsWith('0x')) {
      throw new Error(`Invalid signature format: ${signature}`);
    }

    return signature;
  }

  /**
   * Verifies a balance proof signature
   *
   * @param channelId - Channel identifier (bytes32 hex string)
   * @param nonce - Nonce from balance proof
   * @param transferredAmount - Transferred amount from balance proof (wei)
   * @param signature - Signature to verify (hex string)
   * @param signer - Expected signer Ethereum address
   * @returns True if signature is valid and matches signer
   *
   * Source: Epic 8 Story 8.7 SDK Interface lines 441-446, Story 8.4 signature verification
   */
  async verifyBalanceProof(
    channelId: string,
    nonce: number,
    transferredAmount: bigint,
    signature: string,
    signer: string
  ): Promise<boolean> {
    try {
      // Step 1: Get TokenNetwork address from channel state
      const channelState = await this.getChannelState(channelId);

      // Step 2: Reconstruct BalanceProof object (same as signBalanceProof)
      const balanceProof: BalanceProof = {
        channelId,
        nonce,
        transferredAmount,
        lockedAmount: 0n, // MVP: no hash-locked transfers
        locksRoot: '0x' + '0'.repeat(64), // MVP: no locks
      };

      // Step 3: Get EIP-712 domain separator
      const domain = this._getDomainSeparator(channelState.tokenNetworkAddress);

      // Step 4: Recover signer from signature
      const recoveredAddress = ethers.verifyTypedData(
        domain,
        BALANCE_PROOF_TYPES,
        balanceProof,
        signature
      );

      // Step 5: Compare recovered address with expected signer (case-insensitive)
      return recoveredAddress.toLowerCase() === signer.toLowerCase();
    } catch (error) {
      // Signature verification failed (invalid signature format, etc.)
      return false;
    }
  }

  /**
   * Closes a payment channel on-chain
   *
   * @param channelId - Channel identifier (bytes32 hex string)
   * @param balanceProof - Final balance proof from counterparty
   * @param signature - Counterparty's signature on balance proof
   *
   * Source: Epic 8 Story 8.7 SDK Interface lines 448-454, Story 8.4 closeChannel
   */
  async closeChannel(
    channelId: string,
    balanceProof: BalanceProof,
    signature: string
  ): Promise<void> {
    // Step 1: Get TokenNetwork contract from channel state
    const channelState = await this.getChannelState(channelId);

    const tokenNetwork = new ethers.Contract(
      channelState.tokenNetworkAddress,
      TOKEN_NETWORK_ABI,
      this.signer
    );

    // Step 2: Encode balance proof for contract call (ethers.js handles tuple encoding)
    const balanceProofTuple = [
      balanceProof.channelId,
      balanceProof.nonce,
      balanceProof.transferredAmount,
      balanceProof.lockedAmount,
      balanceProof.locksRoot,
    ];

    // Step 3: Submit close transaction
    const tx = await tokenNetwork.closeChannel(channelId, balanceProofTuple, signature);
    const receipt = await tx.wait(this.config.confirmations);

    // Extract ChannelClosed event from receipt
    const channelClosedEvent = receipt?.logs
      .map((log: ethers.Log) => {
        try {
          return tokenNetwork.interface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
        } catch {
          return null;
        }
      })
      .find((parsedLog: ethers.LogDescription | null) => parsedLog?.name === 'ChannelClosed');

    if (!channelClosedEvent) {
      throw new Error('ChannelClosed event not found in transaction receipt');
    }

    // Step 4: Update local cache with close timestamp
    this._updateCache(channelId, {
      status: 'closed',
      closedAt: Date.now(),
    });
  }

  /**
   * Settles a closed channel after settlement timeout expires
   *
   * @param channelId - Channel identifier (bytes32 hex string)
   *
   * Source: Epic 8 Story 8.7 SDK Interface line 456, Story 8.4 settleChannel
   */
  async settleChannel(channelId: string): Promise<void> {
    // Step 1: Get channel state and verify status
    const channelState = await this.getChannelState(channelId);

    if (channelState.status !== 'closed') {
      throw new Error(
        `Channel ${channelId} is not closed (current status: ${channelState.status})`
      );
    }

    if (!channelState.closedAt) {
      throw new Error(`Channel ${channelId} has no closedAt timestamp`);
    }

    // Step 2: Verify settlement timeout has expired
    const settlementDeadline = channelState.closedAt + channelState.settlementTimeout * 1000;
    if (Date.now() < settlementDeadline) {
      const remainingMs = settlementDeadline - Date.now();
      throw new Error(
        `Settlement period not elapsed for channel ${channelId}. ${Math.ceil(remainingMs / 1000)} seconds remaining.`
      );
    }

    // Step 3: Load TokenNetwork contract
    const tokenNetwork = new ethers.Contract(
      channelState.tokenNetworkAddress,
      TOKEN_NETWORK_ABI,
      this.signer
    );

    // Step 4: Submit settlement transaction
    const tx = await tokenNetwork.settleChannel(channelId);
    const receipt = await tx.wait(this.config.confirmations);

    // Extract ChannelSettled event from receipt
    const channelSettledEvent = receipt?.logs
      .map((log: ethers.Log) => {
        try {
          return tokenNetwork.interface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
        } catch {
          return null;
        }
      })
      .find((parsedLog: ethers.LogDescription | null) => parsedLog?.name === 'ChannelSettled');

    if (!channelSettledEvent) {
      throw new Error('ChannelSettled event not found in transaction receipt');
    }

    // Step 5: Update local cache and remove from active channels
    this._updateCache(channelId, {
      status: 'settled',
    });

    // Channel lifecycle complete, can remove from cache if desired
    // (Keeping it for now for final balance queries)
  }

  /**
   * Retrieves current channel state from blockchain
   *
   * @param channelId - Channel identifier (bytes32 hex string)
   * @returns Current channel state
   *
   * Source: Epic 8 Story 8.7 SDK Interface line 458, Story 8.3 Channel State Structure
   */
  async getChannelState(channelId: string): Promise<ChannelState> {
    // Step 1: Check cache first (optimization for opened channels)
    const cached = this._getCachedState(channelId);
    if (cached && cached.status === 'opened') {
      // Opened channels unlikely to change externally, use cache
      return cached;
    }

    // Step 2: Query on-chain state
    // For now, we need the TokenNetwork address. If we have it in cache, use it.
    // Otherwise, we'll need to iterate through known TokenNetworks or maintain a channelId mapping.
    // For MVP, we'll require cache to have tokenNetworkAddress.
    if (!cached || !cached.tokenNetworkAddress) {
      throw new Error(
        `Channel ${channelId} not found in cache. Cannot determine TokenNetwork address.`
      );
    }

    const tokenNetwork = new ethers.Contract(
      cached.tokenNetworkAddress,
      TOKEN_NETWORK_ABI,
      this.signer
    );

    // Step 3: Call getChannel view function
    const channelData = await tokenNetwork.getChannel(channelId);

    // Step 4: Parse on-chain channel data
    const [
      participant1,
      participant2,
      state,
      settlementTimeout,
      participant1State,
      participant2State,
    ] = channelData;

    // Determine which participant is "me"
    const iAmParticipant1 = this.signer.address.toLowerCase() === participant1.toLowerCase();

    const myState = iAmParticipant1 ? participant1State : participant2State;
    const theirState = iAmParticipant1 ? participant2State : participant1State;

    // Map Solidity state enum to TypeScript status
    let status: 'opened' | 'closed' | 'settled';
    if (state === 0) {
      status = 'opened';
    } else if (state === 1) {
      status = 'closed';
    } else {
      status = 'settled';
    }

    // Step 5: Construct ChannelState object
    const freshState: ChannelState = {
      channelId,
      participants: [participant1, participant2],
      myDeposit: BigInt(myState.deposit),
      theirDeposit: BigInt(theirState.deposit),
      myNonce: Number(myState.nonce),
      theirNonce: Number(theirState.nonce),
      myTransferred: BigInt(myState.transferredAmount),
      theirTransferred: BigInt(theirState.transferredAmount),
      status,
      tokenAddress: cached.tokenAddress, // From cache
      tokenNetworkAddress: cached.tokenNetworkAddress, // From cache
      settlementTimeout: Number(settlementTimeout),
      closedAt: cached.closedAt, // Keep cached closedAt timestamp
    };

    // Step 6: Update cache with fresh state
    this._updateCache(channelId, freshState);

    return freshState;
  }

  /**
   * Returns all channel IDs where connector is a participant
   *
   * @returns Array of channel IDs (bytes32 hex strings)
   *
   * Source: Epic 8 Story 8.7 SDK Interface line 459
   */
  async getMyChannels(): Promise<string[]> {
    // Return all channel IDs from cache
    // Alternative: Query TokenNetwork events (ChannelOpened) filtered by participant address
    // For MVP, we use the cache which is populated as channels are opened
    return Array.from(this.channelCache.keys());
  }

  /**
   * Registers an event listener for blockchain channel events
   *
   * @param listener - Event listener with callback methods
   *
   * Source: Observer pattern, multi-listener support for different subsystems
   */
  registerEventListener(listener: ChannelEventListener): void {
    this.listeners.push(listener);
  }

  /**
   * Starts polling for blockchain events
   *
   * @param intervalMs - Polling interval in milliseconds (default 5000)
   *
   * Source: Blockchain event polling best practices, Base L2 block times
   */
  startEventPolling(intervalMs: number = 5000): void {
    if (this.pollingInterval) {
      throw new Error('Event polling already started');
    }

    // Initialize lastProcessedBlock if not set
    if (this.lastProcessedBlock === 0) {
      // Start from current block on first poll
      this.provider.getBlockNumber().then((blockNumber) => {
        this.lastProcessedBlock = blockNumber;
      });
    }

    // Set up polling interval
    this.pollingInterval = setInterval(() => {
      this._pollEvents().catch((error) => {
        // Log error but don't stop polling
        console.error('Error polling events:', error);
      });
    }, intervalMs);
  }

  /**
   * Stops polling for blockchain events
   *
   * Source: Resource cleanup, proper lifecycle management
   */
  stopEventPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
  }

  // ========== Private Helper Methods ==========

  /**
   * Gets EIP-712 domain separator for a TokenNetwork
   *
   * @param tokenNetworkAddress - TokenNetwork contract address
   * @returns EIP-712 domain separator object
   *
   * Source: Epic 8 Story 8.7 EIP-712 Signing lines 466-472, EIP-712 specification
   */
  private _getDomainSeparator(tokenNetworkAddress: string): {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  } {
    return {
      name: 'PaymentChannel',
      version: '1',
      chainId: this.config.chainId,
      verifyingContract: tokenNetworkAddress,
    };
  }

  /**
   * Gets or creates a TokenNetwork for a given ERC20 token
   *
   * @param tokenAddress - ERC20 token contract address
   * @returns TokenNetwork contract address
   *
   * Source: DRY principle, repeated pattern in openChannel
   */
  private async _getOrCreateTokenNetwork(tokenAddress: string): Promise<string> {
    // Check cache first
    if (this.tokenNetworkCache.has(tokenAddress)) {
      return this.tokenNetworkCache.get(tokenAddress)!;
    }

    // Query registry for existing TokenNetwork
    const existingTokenNetwork = (await this.registry.getTokenNetwork(tokenAddress)) as string;

    if (existingTokenNetwork !== ethers.ZeroAddress) {
      // TokenNetwork exists, cache and return
      this.tokenNetworkCache.set(tokenAddress, existingTokenNetwork);
      return existingTokenNetwork;
    }

    // TokenNetwork doesn't exist, create it
    const tx = await this.registry.createTokenNetwork(tokenAddress);
    const receipt = await tx.wait(this.config.confirmations);

    // Extract TokenNetworkCreated event from receipt
    const tokenNetworkCreatedEvent = receipt?.logs
      .map((log: ethers.Log) => {
        try {
          return this.registry.interface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
        } catch {
          return null;
        }
      })
      .find((parsedLog: ethers.LogDescription | null) => parsedLog?.name === 'TokenNetworkCreated');

    if (!tokenNetworkCreatedEvent) {
      throw new Error('TokenNetworkCreated event not found in transaction receipt');
    }

    const newTokenNetwork = tokenNetworkCreatedEvent.args.tokenNetworkAddress as string;

    // Cache and return
    this.tokenNetworkCache.set(tokenAddress, newTokenNetwork);
    return newTokenNetwork;
  }

  /**
   * Approves ERC20 token spending for a spender contract
   *
   * @param tokenAddress - ERC20 token contract address
   * @param spender - Spender contract address (TokenNetwork)
   * @param amount - Amount to approve (wei)
   *
   * Source: ERC20 standard, repeated pattern in openChannel and deposit
   */
  private async _approveToken(
    tokenAddress: string,
    spender: string,
    amount: bigint
  ): Promise<void> {
    const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, this.signer);
    const tx = await erc20.approve(spender, amount);
    await tx.wait(this.config.confirmations);
  }

  /**
   * Sets the total deposit for a participant in a channel
   *
   * @param tokenNetwork - TokenNetwork contract instance
   * @param channelId - Channel identifier (bytes32 hex)
   * @param participant - Participant address
   * @param totalDeposit - New total deposit amount (wei)
   *
   * Source: Story 8.3 TokenNetwork.setTotalDeposit
   */
  private async _setTotalDeposit(
    tokenNetwork: ethers.Contract,
    channelId: string,
    participant: string,
    totalDeposit: bigint
  ): Promise<void> {
    const tx = await tokenNetwork.setTotalDeposit(channelId, participant, totalDeposit);
    await tx.wait(this.config.confirmations);
  }

  /**
   * Updates the local channel state cache
   *
   * @param channelId - Channel identifier (bytes32 hex)
   * @param updates - Partial channel state updates
   *
   * Source: Cache management best practices, memory efficiency
   */
  private _updateCache(channelId: string, updates: Partial<ChannelState>): void {
    const existing = this.channelCache.get(channelId);
    if (existing) {
      // Merge updates into existing cache entry
      this.channelCache.set(channelId, { ...existing, ...updates });
    } else {
      // Create new cache entry (updates must be complete ChannelState)
      this.channelCache.set(channelId, updates as ChannelState);
    }
  }

  /**
   * Gets cached channel state if available
   *
   * @param channelId - Channel identifier (bytes32 hex)
   * @returns Cached channel state or null
   *
   * Source: Cache management best practices
   */
  private _getCachedState(channelId: string): ChannelState | null {
    return this.channelCache.get(channelId) ?? null;
  }

  /**
   * Removes a channel from the cache
   *
   * @param channelId - Channel identifier (bytes32 hex)
   *
   * Source: Memory efficiency, called after settleChannel completes
   */
  private _removeCachedState(channelId: string): void {
    this.channelCache.delete(channelId);
  }

  /**
   * Polls for new blockchain events and notifies listeners
   *
   * Source: Blockchain event polling best practices
   */
  private async _pollEvents(): Promise<void> {
    const currentBlock = await this.provider.getBlockNumber();

    if (currentBlock <= this.lastProcessedBlock) {
      // No new blocks, nothing to do
      return;
    }

    const fromBlock = this.lastProcessedBlock + 1;
    const toBlock = currentBlock;

    // Poll events from all known TokenNetworks
    for (const tokenNetworkAddress of this.tokenNetworkCache.values()) {
      await this._pollTokenNetworkEvents(tokenNetworkAddress, fromBlock, toBlock);
    }

    // Update last processed block
    this.lastProcessedBlock = currentBlock;
  }

  /**
   * Polls events from a specific TokenNetwork contract
   *
   * @param tokenNetworkAddress - TokenNetwork contract address
   * @param fromBlock - Start block number (inclusive)
   * @param toBlock - End block number (inclusive)
   */
  private async _pollTokenNetworkEvents(
    tokenNetworkAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    const tokenNetwork = new ethers.Contract(tokenNetworkAddress, TOKEN_NETWORK_ABI, this.provider);

    // Query all event types in parallel
    await Promise.all([
      this._processChannelOpenedEvents(tokenNetwork, fromBlock, toBlock),
      this._processChannelClosedEvents(tokenNetwork, fromBlock, toBlock),
      this._processChannelSettledEvents(tokenNetwork, fromBlock, toBlock),
      this._processChannelDepositEvents(tokenNetwork, fromBlock, toBlock),
    ]);
  }

  /**
   * Processes ChannelOpened events
   */
  private async _processChannelOpenedEvents(
    tokenNetwork: ethers.Contract,
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    // Filter for events where connector is participant1 or participant2
    const filter1 = tokenNetwork.filters.ChannelOpened(this.signer.address, null);
    const filter2 = tokenNetwork.filters.ChannelOpened(null, this.signer.address);

    const events1 = await tokenNetwork.queryFilter(filter1, fromBlock, toBlock);
    const events2 = await tokenNetwork.queryFilter(filter2, fromBlock, toBlock);
    const events = [...events1, ...events2];

    for (const event of events) {
      const parsedEvent = tokenNetwork.interface.parseLog({
        topics: [...event.topics],
        data: event.data,
      });

      if (!parsedEvent || parsedEvent.name !== 'ChannelOpened') continue;

      const channelOpenedEvent: ChannelOpenedEvent = {
        channelId: parsedEvent.args.channelId,
        participant1: parsedEvent.args.participant1,
        participant2: parsedEvent.args.participant2,
        tokenAddress: '', // Need to get from registry/cache
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      };

      // Notify listeners
      this._notifyListeners('onChannelOpened', channelOpenedEvent);
    }
  }

  /**
   * Processes ChannelClosed events
   */
  private async _processChannelClosedEvents(
    tokenNetwork: ethers.Contract,
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    const filter = tokenNetwork.filters.ChannelClosed();
    const events = await tokenNetwork.queryFilter(filter, fromBlock, toBlock);

    for (const event of events) {
      const parsedEvent = tokenNetwork.interface.parseLog({
        topics: [...event.topics],
        data: event.data,
      });

      if (!parsedEvent || parsedEvent.name !== 'ChannelClosed') continue;

      const channelClosedEvent: ChannelClosedEvent = {
        channelId: parsedEvent.args.channelId,
        closingParticipant: parsedEvent.args.closingParticipant,
        nonce: Number(parsedEvent.args.nonce),
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      };

      // Update cache
      this._updateCache(parsedEvent.args.channelId, {
        status: 'closed',
        closedAt: Date.now(),
      });

      // Notify listeners
      this._notifyListeners('onChannelClosed', channelClosedEvent);
    }
  }

  /**
   * Processes ChannelSettled events
   */
  private async _processChannelSettledEvents(
    tokenNetwork: ethers.Contract,
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    const filter = tokenNetwork.filters.ChannelSettled();
    const events = await tokenNetwork.queryFilter(filter, fromBlock, toBlock);

    for (const event of events) {
      const parsedEvent = tokenNetwork.interface.parseLog({
        topics: [...event.topics],
        data: event.data,
      });

      if (!parsedEvent || parsedEvent.name !== 'ChannelSettled') continue;

      const channelSettledEvent: ChannelSettledEvent = {
        channelId: parsedEvent.args.channelId,
        participant1Balance: BigInt(parsedEvent.args.participant1Balance),
        participant2Balance: BigInt(parsedEvent.args.participant2Balance),
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      };

      // Update cache
      this._updateCache(parsedEvent.args.channelId, {
        status: 'settled',
      });

      // Notify listeners
      this._notifyListeners('onChannelSettled', channelSettledEvent);
    }
  }

  /**
   * Processes ChannelDeposit events
   */
  private async _processChannelDepositEvents(
    tokenNetwork: ethers.Contract,
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    const filter = tokenNetwork.filters.ChannelDeposit();
    const events = await tokenNetwork.queryFilter(filter, fromBlock, toBlock);

    for (const event of events) {
      const parsedEvent = tokenNetwork.interface.parseLog({
        topics: [...event.topics],
        data: event.data,
      });

      if (!parsedEvent || parsedEvent.name !== 'ChannelDeposit') continue;

      const channelDepositEvent: ChannelDepositEvent = {
        channelId: parsedEvent.args.channelId,
        participant: parsedEvent.args.participant,
        totalDeposit: BigInt(parsedEvent.args.totalDeposit),
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      };

      // Update cache based on which participant deposited
      const cached = this._getCachedState(parsedEvent.args.channelId);
      if (cached) {
        const isMyDeposit =
          parsedEvent.args.participant.toLowerCase() === this.signer.address.toLowerCase();
        if (isMyDeposit) {
          this._updateCache(parsedEvent.args.channelId, {
            myDeposit: BigInt(parsedEvent.args.totalDeposit),
          });
        } else {
          this._updateCache(parsedEvent.args.channelId, {
            theirDeposit: BigInt(parsedEvent.args.totalDeposit),
          });
        }
      }

      // Notify listeners
      this._notifyListeners('onChannelDeposit', channelDepositEvent);
    }
  }

  /**
   * Notifies all registered listeners of an event
   *
   * @param eventType - Event type name (onChannelOpened, onChannelClosed, etc.)
   * @param eventData - Event data to pass to listeners
   */
  private _notifyListeners(
    eventType: keyof ChannelEventListener,
    eventData: ChannelOpenedEvent | ChannelClosedEvent | ChannelSettledEvent | ChannelDepositEvent
  ): void {
    for (const listener of this.listeners) {
      const callback = listener[eventType];
      if (callback) {
        try {
          callback(eventData);
        } catch (error) {
          // Log error but don't stop processing other listeners
          console.error(`Error in event listener ${eventType}:`, error);
        }
      }
    }
  }
}
