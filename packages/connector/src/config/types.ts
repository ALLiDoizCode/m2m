/**
 * Configuration Types for ILP Connector
 *
 * Defines TypeScript interfaces for YAML configuration schema.
 * These types support defining network topology, peer connections,
 * and routing tables in a declarative configuration file.
 *
 * Example YAML Configuration:
 *
 * ```yaml
 * # Connector Configuration (Linear Topology - Middle Node)
 * nodeId: connector-b
 * btpServerPort: 3001
 * healthCheckPort: 8080
 * logLevel: info
 *
 * # Peer connector definitions
 * peers:
 *   - id: connector-a
 *     url: ws://connector-a:3000
 *     authToken: secret-a-to-b
 *
 *   - id: connector-c
 *     url: ws://connector-c:3002
 *     authToken: secret-b-to-c
 *
 * # Routing table entries
 * routes:
 *   - prefix: g.connectora
 *     nextHop: connector-a
 *     priority: 0
 *
 *   - prefix: g.connectorc
 *     nextHop: connector-c
 *     priority: 0
 * ```
 *
 * @packageDocumentation
 */

/**
 * Peer Configuration Interface
 *
 * Defines connection parameters for a peer connector in the network.
 * Peers are other ILP connectors that this node will establish
 * BTP (Bilateral Transfer Protocol) connections with.
 *
 * @property id - Unique peer identifier used in route definitions
 * @property url - WebSocket URL for peer connection (ws:// or wss://)
 * @property authToken - Shared secret for BTP authentication
 *
 * @example
 * ```typescript
 * const peer: PeerConfig = {
 *   id: 'connector-a',
 *   url: 'ws://connector-a:3000',
 *   authToken: 'shared-secret-123'
 * };
 * ```
 */
export interface PeerConfig {
  /**
   * Unique identifier for this peer
   * Used as reference in route nextHop fields
   * Must be unique across all peers in the configuration
   */
  id: string;

  /**
   * WebSocket URL for connecting to peer's BTP server
   * Format: ws://hostname:port or wss://hostname:port
   * Examples:
   * - ws://connector-a:3000
   * - wss://secure-connector.example.com:3001
   */
  url: string;

  /**
   * Shared secret for BTP authentication
   * Used to authenticate this connector to the peer
   * Should be a strong, randomly generated token
   */
  authToken: string;
}

/**
 * Route Configuration Interface
 *
 * Defines a routing table entry mapping ILP address prefixes
 * to peer connectors. Routes determine packet forwarding decisions.
 *
 * @property prefix - ILP address prefix pattern (RFC-0015 format)
 * @property nextHop - Peer ID to forward packets to
 * @property priority - Optional priority for tie-breaking (default: 0)
 *
 * @example
 * ```typescript
 * const route: RouteConfig = {
 *   prefix: 'g.alice',
 *   nextHop: 'connector-b',
 *   priority: 10
 * };
 * ```
 */
export interface RouteConfig {
  /**
   * ILP address prefix for route matching
   * Format: RFC-0015 compliant address prefix
   * Pattern: lowercase alphanumeric characters, dots, underscores, tildes, hyphens
   * Examples:
   * - g.alice
   * - g.bob.usd
   * - g.exchange.crypto
   */
  prefix: string;

  /**
   * Peer ID to forward matching packets to
   * Must reference an existing peer ID from the peers list
   * Used to determine which BTP connection to use
   */
  nextHop: string;

  /**
   * Route priority for tie-breaking when multiple routes match
   * Higher priority routes are preferred
   * Optional - defaults to 0 if not specified
   */
  priority?: number;
}

/**
 * Connector Configuration Interface
 *
 * Top-level configuration for an ILP connector node.
 * Defines node identity, network settings, peers, and routing.
 *
 * @property nodeId - Unique identifier for this connector instance
 * @property btpServerPort - Port for incoming BTP connections
 * @property healthCheckPort - Optional HTTP health endpoint port (default: 8080)
 * @property logLevel - Optional logging verbosity (default: 'info')
 * @property peers - List of peer connectors to connect to
 * @property routes - Initial routing table entries
 * @property dashboardTelemetryUrl - Optional WebSocket URL for telemetry
 *
 * @example
 * ```typescript
 * const config: ConnectorConfig = {
 *   nodeId: 'connector-b',
 *   btpServerPort: 3001,
 *   healthCheckPort: 8080,
 *   logLevel: 'info',
 *   peers: [
 *     { id: 'connector-a', url: 'ws://connector-a:3000', authToken: 'secret-a' }
 *   ],
 *   routes: [
 *     { prefix: 'g.connectora', nextHop: 'connector-a', priority: 0 }
 *   ]
 * };
 * ```
 */
export interface ConnectorConfig {
  /**
   * Unique identifier for this connector instance
   * Used in logging, telemetry, and network identification
   * Should be descriptive and unique across the network
   *
   * Examples: 'connector-a', 'hub-node', 'spoke-1'
   */
  nodeId: string;

  /**
   * Port number for BTP server to listen on
   * Accepts incoming BTP connections from peer connectors
   * Valid range: 1-65535
   *
   * Common ports: 3000, 3001, 3002, etc.
   */
  btpServerPort: number;

  /**
   * Port number for HTTP health check endpoint
   * Optional - defaults to 8080 if not specified
   * Valid range: 1-65535
   *
   * Used by orchestration systems (Docker, Kubernetes) for health monitoring
   */
  healthCheckPort?: number;

  /**
   * Logging verbosity level
   * Optional - defaults to 'info' if not specified
   *
   * Levels:
   * - 'debug': Detailed debugging information
   * - 'info': General informational messages
   * - 'warn': Warning messages
   * - 'error': Error messages only
   */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';

  /**
   * List of peer connectors to establish BTP connections with
   * Each peer represents another connector in the network
   * Can be an empty array if this node only accepts incoming connections
   *
   * Peer IDs must be unique within this list
   */
  peers: PeerConfig[];

  /**
   * Initial routing table entries
   * Defines how to forward packets based on destination address
   * Can be an empty array for nodes with no predefined routes
   *
   * Route nextHop values must reference peer IDs from the peers list
   */
  routes: RouteConfig[];

  /**
   * Optional WebSocket URL for sending telemetry to dashboard
   * Used for real-time monitoring and visualization
   * Format: ws://hostname:port or wss://hostname:port
   *
   * Example: 'ws://dashboard.example.com:8080'
   */
  dashboardTelemetryUrl?: string;

  /**
   * Optional settlement configuration for TigerBeetle integration
   * When provided, enables settlement recording for packet forwarding
   * Defaults to settlement disabled if not specified
   */
  settlement?: SettlementConfig;

  /**
   * Deployment environment for the connector
   * Determines which blockchain configuration defaults are applied
   * and which validation rules are enforced
   *
   * Defaults to 'development' if not specified
   *
   * Environment types:
   * - development: Local Anvil and rippled standalone
   * - staging: Public testnets (Base Sepolia, XRPL Testnet)
   * - production: Public mainnets (Base mainnet, XRPL Mainnet)
   */
  environment: Environment;

  /**
   * Optional blockchain configuration for Base L2 and XRP Ledger integration
   * When provided, enables blockchain-specific features (payment channels, smart contracts)
   * Defaults to blockchain integration disabled if not specified
   *
   * Epic 8 (EVM Payment Channels) uses config.blockchain.base
   * Epic 9 (XRP Payment Channels) uses config.blockchain.xrpl
   */
  blockchain?: BlockchainConfig;

  /**
   * Optional security configuration for key management
   * When provided, enables enterprise-grade key management with HSM/KMS backends
   * Defaults to environment variable backend if not specified
   *
   * Epic 12 Story 12.2 (HSM/KMS Key Management) uses config.security.keyManagement
   * Supports backends: env (development), AWS KMS, GCP KMS, Azure Key Vault, HSM (PKCS#11)
   */
  security?: SecurityConfig;

  /**
   * Optional performance configuration for high-throughput optimization
   * When provided, enables batching, buffering, and connection pooling for 10K+ TPS
   * Defaults to performance optimizations disabled if not specified
   *
   * Epic 12 Story 12.5 (Performance Optimization for 10K+ TPS)
   * Enables:
   * - Packet processing parallelization with worker threads
   * - TigerBeetle transfer batching
   * - Telemetry event buffering
   * - Connection pooling for blockchain RPC endpoints
   */
  performance?: PerformanceConfig;
}

/**
 * Credit Limit Configuration Interface
 *
 * Configures credit limits for managing counterparty risk.
 * Credit limits define the maximum amount peers can owe the connector
 * (accounts receivable ceiling) before packets are rejected.
 *
 * **Credit Limit Semantics:**
 * - Credit limit applies to peer's debt to the connector (creditBalance)
 * - Limit on accounts receivable (how much peers can owe us)
 * - Undefined limits = unlimited exposure (backward compatible)
 * - Limits enforced BEFORE settlement recording (fail-safe design)
 *
 * **Limit Hierarchy (highest priority first):**
 * 1. Token-specific limit: perTokenLimits[peerId][tokenId]
 * 2. Per-peer limit: perPeerLimits[peerId]
 * 3. Default limit: defaultLimit
 * 4. Unlimited: undefined (no limit configured)
 *
 * Global ceiling applies to ALL limits as security override.
 *
 * @property defaultLimit - Default credit limit for all peers (undefined = unlimited)
 * @property perPeerLimits - Per-peer credit limit overrides
 * @property perTokenLimits - Token-specific limits per peer
 * @property globalCeiling - Maximum credit limit allowed (security safety valve)
 *
 * @example
 * ```typescript
 * const creditLimits: CreditLimitConfig = {
 *   defaultLimit: 1000000n,           // 1M units default
 *   perPeerLimits: new Map([
 *     ['trusted-peer', 10000000n],    // 10M units for trusted peer
 *     ['new-peer', 100000n]           // 100K units for new peer
 *   ]),
 *   perTokenLimits: new Map([
 *     ['high-value-peer', new Map([
 *       ['BTC', 100n],                // 100 satoshis max for BTC
 *       ['ETH', 1000n]                // 1000 wei max for ETH
 *     ])]
 *   ]),
 *   globalCeiling: 50000000n          // 50M units absolute max
 * };
 * ```
 */
export interface CreditLimitConfig {
  /**
   * Default credit limit for all peers
   * Applied when no per-peer or token-specific limit is configured
   * Format: bigint (matches ILP packet amount type)
   * undefined = unlimited (backward compatible)
   */
  defaultLimit?: bigint;

  /**
   * Per-peer credit limit overrides
   * Key: peerId (from peer configuration)
   * Value: credit limit as bigint
   * Overrides defaultLimit for specified peers
   */
  perPeerLimits?: Map<string, bigint>;

  /**
   * Token-specific credit limits per peer
   * Key: peerId (from peer configuration)
   * Value: Map of tokenId to credit limit
   * Highest priority in limit hierarchy
   *
   * Use case: Different limits for different currencies/tokens
   * Example: Lower limit for volatile assets (BTC, ETH) vs stablecoins (USDC)
   */
  perTokenLimits?: Map<string, Map<string, bigint>>;

  /**
   * Global credit limit ceiling (security safety valve)
   * Maximum allowed credit limit per peer regardless of configuration
   * Prevents misconfiguration from creating unbounded exposure
   * Format: bigint, undefined = no global ceiling
   * Typically set via environment variable: SETTLEMENT_GLOBAL_CREDIT_CEILING
   *
   * Applied AFTER determining configured limit:
   * effectiveLimit = min(configuredLimit, globalCeiling)
   */
  globalCeiling?: bigint;
}

/**
 * Credit Limit Violation Interface
 *
 * Describes a credit limit violation for logging and error reporting.
 * Returned by checkCreditLimit() when a proposed transfer would exceed
 * the configured credit limit for a peer.
 *
 * @property peerId - Peer that would exceed limit
 * @property tokenId - Token type being transferred
 * @property currentBalance - Current account balance (peer's debt to us)
 * @property requestedAmount - Amount being requested
 * @property creditLimit - Configured credit limit
 * @property wouldExceedBy - Amount over limit
 *
 * @example
 * ```typescript
 * const violation: CreditLimitViolation = {
 *   peerId: 'connector-a',
 *   tokenId: 'ILP',
 *   currentBalance: 4500n,
 *   requestedAmount: 600n,
 *   creditLimit: 5000n,
 *   wouldExceedBy: 100n  // (4500 + 600) - 5000 = 100
 * };
 * ```
 */
export interface CreditLimitViolation {
  /**
   * Peer ID that would exceed credit limit
   * References peer.id from configuration
   */
  peerId: string;

  /**
   * Token type being transferred
   * Examples: 'ILP' (default), 'USDC', 'BTC', 'ETH'
   * Used for token-specific limit lookup
   */
  tokenId: string;

  /**
   * Current account balance (peer's debt to us)
   * Format: bigint (creditBalance from TigerBeetle account)
   * Represents accounts receivable from this peer
   */
  currentBalance: bigint;

  /**
   * Amount being requested for this packet/transfer
   * Format: bigint (from ILP packet amount)
   */
  requestedAmount: bigint;

  /**
   * Configured credit limit for this peer/token
   * Format: bigint (effective limit after hierarchy and ceiling applied)
   */
  creditLimit: bigint;

  /**
   * Amount over limit
   * Calculation: (currentBalance + requestedAmount) - creditLimit
   * Format: bigint
   * Used for logging/debugging to show extent of violation
   */
  wouldExceedBy: bigint;
}

/**
 * Settlement Configuration Interface
 *
 * Configures TigerBeetle settlement integration for recording
 * double-entry transfers during packet forwarding.
 *
 * @property connectorFeePercentage - Connector fee as percentage (e.g., 0.1 = 0.1%)
 * @property enableSettlement - Feature flag to enable/disable settlement recording
 * @property tigerBeetleClusterId - TigerBeetle cluster ID for transfers
 * @property tigerBeetleReplicas - TigerBeetle replica addresses
 *
 * @example
 * ```typescript
 * const settlement: SettlementConfig = {
 *   connectorFeePercentage: 0.1,
 *   enableSettlement: true,
 *   tigerBeetleClusterId: 0,
 *   tigerBeetleReplicas: ['localhost:3000']
 * };
 * ```
 */
export interface SettlementConfig {
  /**
   * Connector fee as percentage of packet amount
   * Format: Decimal percentage (0.1 = 0.1%, 1.0 = 1.0%)
   * Default: 0.1 (0.1% fee)
   *
   * Fee is deducted from forwarded packet amount:
   * - Original packet: 1000 units
   * - Fee (0.1%): 1 unit
   * - Forwarded amount: 999 units
   *
   * Fee calculation uses integer arithmetic to avoid floating-point precision issues.
   * See calculateConnectorFee() implementation for basis point conversion details.
   */
  connectorFeePercentage: number;

  /**
   * Feature flag to enable/disable settlement recording
   * Default: true
   *
   * When enabled:
   * - All packet forwards record double-entry transfers in TigerBeetle
   * - Failed settlement recording rejects packets with T00_INTERNAL_ERROR
   *
   * When disabled:
   * - Packets forward normally without settlement recording
   * - Backward compatible with pre-settlement connector behavior
   */
  enableSettlement: boolean;

  /**
   * TigerBeetle cluster ID for all transfers
   * Format: 32-bit unsigned integer
   * Must match cluster ID used during TigerBeetle initialization
   *
   * See Story 6.1/6.2 for TigerBeetle deployment configuration
   */
  tigerBeetleClusterId: number;

  /**
   * TigerBeetle replica addresses
   * Format: Array of "hostname:port" strings
   * Examples:
   * - ['localhost:3000'] (single replica for local development)
   * - ['tb-1:3000', 'tb-2:3000', 'tb-3:3000'] (3-replica cluster for production)
   *
   * TigerBeetle client will connect to all replicas for high availability
   */
  tigerBeetleReplicas: string[];

  /**
   * Optional credit limit configuration for managing counterparty risk
   * When provided, enforces limits on how much peers can owe the connector
   * Defaults to unlimited credit (no enforcement) if not specified
   */
  creditLimits?: CreditLimitConfig;

  /**
   * Optional settlement threshold configuration for proactive settlement triggers
   * When provided, enables monitoring of account balances to trigger settlements
   * BEFORE credit limits are reached (prevents packet rejections)
   * Defaults to threshold monitoring disabled if not specified
   */
  thresholds?: SettlementThresholdConfig;
}

/**
 * Environment Type
 *
 * Defines the deployment environment for the connector.
 * Used to apply environment-specific configuration defaults and validations.
 *
 * Environment types:
 * - development: Local development with Anvil and rippled standalone
 * - staging: Public testnets (Base Sepolia, XRPL Testnet)
 * - production: Public mainnets (Base mainnet, XRPL Mainnet)
 */
export type Environment = 'development' | 'staging' | 'production';

/**
 * Settlement Transfer Metadata Interface
 *
 * Metadata attached to TigerBeetle transfers for packet forwarding events.
 * Enables correlation between ILP packets and settlement records.
 *
 * @property packetId - Execution condition hash as hex string (unique packet ID)
 * @property timestamp - Transfer recording timestamp
 * @property incomingPeerId - Peer who sent us the packet
 * @property outgoingPeerId - Peer we're forwarding to
 * @property originalAmount - Original packet amount (before fee)
 * @property forwardedAmount - Amount forwarded after fee deduction
 * @property connectorFee - Connector fee amount collected
 *
 * @example
 * ```typescript
 * const metadata: SettlementTransferMetadata = {
 *   packetId: 'a3c5f9...',
 *   timestamp: new Date(),
 *   incomingPeerId: 'connector-a',
 *   outgoingPeerId: 'connector-c',
 *   originalAmount: 1000n,
 *   forwardedAmount: 999n,
 *   connectorFee: 1n
 * };
 * ```
 */
export interface SettlementTransferMetadata {
  /**
   * Packet ID derived from execution condition
   * Format: Hex-encoded SHA-256 hash (64 characters)
   * Uniquely identifies the ILP packet across the network
   *
   * Used to correlate settlement transfers with packet flow logs
   */
  packetId: string;

  /**
   * Timestamp when transfer was recorded
   * Used for settlement event chronology and audit trails
   */
  timestamp: Date;

  /**
   * Peer ID who sent us the packet
   * References peer.id from configuration
   * Identifies source of incoming value transfer
   */
  incomingPeerId: string;

  /**
   * Peer ID we're forwarding packet to
   * References peer.id from configuration
   * Identifies destination of outgoing value transfer
   */
  outgoingPeerId: string;

  /**
   * Original packet amount before fee deduction
   * Format: bigint (64-bit unsigned integer from ILP packet)
   * Represents value received from incoming peer
   */
  originalAmount: bigint;

  /**
   * Amount forwarded to next-hop peer after fee deduction
   * Format: bigint
   * Calculation: originalAmount - connectorFee
   */
  forwardedAmount: bigint;

  /**
   * Connector fee collected for this packet forward
   * Format: bigint
   * Calculation: (originalAmount * connectorFeePercentage) using integer arithmetic
   *
   * Fee stays in connector's pocket (not recorded as separate TigerBeetle account in MVP)
   */
  connectorFee: bigint;
}

/**
 * Settlement Threshold Configuration Interface
 *
 * Configures settlement threshold monitoring for proactive settlement triggers.
 * Settlement thresholds trigger settlements BEFORE credit limits are reached,
 * preventing packet rejections due to credit limit violations.
 *
 * **Settlement Threshold Semantics:**
 * - Threshold applies to creditBalance (how much peer owes us)
 * - Threshold is LOWER than credit limit (soft trigger vs hard ceiling)
 * - Threshold crossing emits event but does NOT reject packets
 * - Recommended: Threshold = 80% of credit limit (e.g., threshold 800, limit 1000)
 *
 * **Threshold Hierarchy (highest priority first):**
 * 1. Token-specific threshold: perTokenThresholds[peerId][tokenId]
 * 2. Per-peer threshold: perPeerThresholds[peerId]
 * 3. Default threshold: defaultThreshold
 * 4. No threshold: undefined (monitoring disabled for this peer)
 *
 * **Polling Interval Trade-offs:**
 * - Shorter intervals (5-10s): Faster detection, higher CPU usage
 * - Longer intervals (30-60s): Slower detection, lower overhead
 * - Default: 30 seconds (good balance for MVP)
 *
 * @property defaultThreshold - Default settlement threshold for all peers (undefined = no monitoring)
 * @property perPeerThresholds - Per-peer threshold overrides
 * @property perTokenThresholds - Token-specific thresholds per peer
 * @property pollingInterval - Balance polling interval in milliseconds (default: 30000)
 *
 * @example
 * ```typescript
 * const thresholds: SettlementThresholdConfig = {
 *   defaultThreshold: 500000n,           // 500K units default
 *   pollingInterval: 30000,              // 30 seconds
 *   perPeerThresholds: new Map([
 *     ['trusted-peer', 5000000n],        // 5M units for trusted peer
 *     ['new-peer', 50000n]               // 50K units for new peer
 *   ]),
 *   perTokenThresholds: new Map([
 *     ['high-value-peer', new Map([
 *       ['BTC', 50n],                    // 50 satoshis threshold for BTC
 *       ['ETH', 500n]                    // 500 wei threshold for ETH
 *     ])]
 *   ])
 * };
 * ```
 */
export interface SettlementThresholdConfig {
  /**
   * Default settlement threshold for all peers
   * Applied when no per-peer or token-specific threshold is configured
   * Format: bigint (matches ILP packet amount type)
   * undefined = no threshold monitoring (disabled)
   *
   * Recommended: 80% of defaultLimit (if credit limits configured)
   * Example: defaultLimit = 1000000n → defaultThreshold = 800000n
   */
  defaultThreshold?: bigint;

  /**
   * Per-peer settlement threshold overrides
   * Key: peerId (from peer configuration)
   * Value: settlement threshold as bigint
   * Overrides defaultThreshold for specified peers
   *
   * Use case: Different thresholds based on peer trust level
   * Example: Higher thresholds for established, trusted peers
   */
  perPeerThresholds?: Map<string, bigint>;

  /**
   * Token-specific settlement thresholds per peer
   * Key: peerId (from peer configuration)
   * Value: Map of tokenId to settlement threshold
   * Highest priority in threshold hierarchy
   *
   * Use case: Different thresholds for different currencies/tokens
   * Example: Lower thresholds for volatile assets (BTC, ETH) vs stablecoins (USDC)
   */
  perTokenThresholds?: Map<string, Map<string, bigint>>;

  /**
   * Balance polling interval in milliseconds
   * Controls how frequently settlement monitor checks account balances
   * Default: 30000 (30 seconds)
   *
   * Trade-offs:
   * - Shorter intervals: Faster threshold detection, higher CPU usage, more TigerBeetle queries
   * - Longer intervals: Slower detection, lower overhead
   *
   * Polling overhead calculation example (10 peers, 1 token, 30s interval):
   * - 10 balance queries / 30 seconds = 0.33 queries/second
   * - Each query: ~1-5ms TigerBeetle latency
   * - Total overhead: <1% CPU usage
   */
  pollingInterval?: number;
}

/**
 * Settlement State Enum
 *
 * Tracks the settlement state for each peer-token pair.
 * State machine prevents duplicate settlement triggers and coordinates
 * with settlement API execution (Story 6.7).
 *
 * **State Transitions:**
 * - IDLE → SETTLEMENT_PENDING: Balance exceeds threshold (first crossing)
 * - SETTLEMENT_PENDING → SETTLEMENT_IN_PROGRESS: Settlement API starts execution
 * - SETTLEMENT_IN_PROGRESS → IDLE: Settlement completes and balance reduced
 * - SETTLEMENT_PENDING → IDLE: Balance drops below threshold naturally
 *
 * **Invalid Transitions (logged as warnings):**
 * - IDLE → SETTLEMENT_IN_PROGRESS: Must go through PENDING first
 * - SETTLEMENT_IN_PROGRESS → SETTLEMENT_PENDING: Cannot restart while in progress
 *
 * @example
 * ```typescript
 * const stateMap = new Map<string, SettlementState>();
 * const stateKey = `${peerId}:${tokenId}`;
 *
 * // Threshold crossed
 * stateMap.set(stateKey, SettlementState.SETTLEMENT_PENDING);
 *
 * // Settlement API starts execution
 * stateMap.set(stateKey, SettlementState.SETTLEMENT_IN_PROGRESS);
 *
 * // Settlement completes
 * stateMap.set(stateKey, SettlementState.IDLE);
 * ```
 */
export enum SettlementState {
  /**
   * IDLE: No settlement needed, balance below threshold
   * Default state for all peer-token pairs
   * Threshold detection active, ready to trigger if balance exceeds threshold
   */
  IDLE = 'IDLE',

  /**
   * SETTLEMENT_PENDING: Threshold crossed, settlement should be triggered soon
   * SETTLEMENT_REQUIRED event emitted, waiting for settlement API to start
   * Prevents duplicate threshold crossing events during polling cycles
   */
  SETTLEMENT_PENDING = 'SETTLEMENT_PENDING',

  /**
   * SETTLEMENT_IN_PROGRESS: Settlement API call in progress
   * Story 6.7 integration point: Settlement API marks state when executing
   * Prevents new settlement triggers while settlement is executing
   * Transitions to IDLE when settlement completes and balance reduced
   */
  SETTLEMENT_IN_PROGRESS = 'SETTLEMENT_IN_PROGRESS',
}

/**
 * Settlement Trigger Event Interface
 *
 * Event data emitted when a peer's balance exceeds settlement threshold.
 * Emitted by SettlementMonitor, consumed by SettlementAPI (Story 6.7)
 * and telemetry dashboard (Story 6.8).
 *
 * @property peerId - Peer requiring settlement
 * @property tokenId - Token type
 * @property currentBalance - Current account balance (peer's debt to us)
 * @property threshold - Configured threshold that was exceeded
 * @property exceedsBy - Amount over threshold
 * @property timestamp - When threshold was detected
 *
 * @example
 * ```typescript
 * const event: SettlementTriggerEvent = {
 *   peerId: 'connector-a',
 *   tokenId: 'ILP',
 *   currentBalance: 1200n,
 *   threshold: 1000n,
 *   exceedsBy: 200n,
 *   timestamp: new Date()
 * };
 *
 * // Story 6.7 SettlementAPI will listen:
 * settlementMonitor.on('SETTLEMENT_REQUIRED', async (event: SettlementTriggerEvent) => {
 *   await settlementAPI.executeMockSettlement(event.peerId, event.tokenId);
 * });
 * ```
 */
export interface SettlementTriggerEvent {
  /**
   * Peer ID requiring settlement
   * References peer.id from configuration
   * Identifies which peer has exceeded their settlement threshold
   */
  peerId: string;

  /**
   * Token type being settled
   * Examples: 'ILP' (default), 'USDC', 'BTC', 'ETH'
   * Used for token-specific threshold lookup and settlement execution
   */
  tokenId: string;

  /**
   * Current account balance (peer's debt to us)
   * Format: bigint (creditBalance from TigerBeetle account)
   * Represents accounts receivable from this peer
   * This is the balance that exceeded the threshold
   */
  currentBalance: bigint;

  /**
   * Configured settlement threshold that was exceeded
   * Format: bigint (effective threshold after hierarchy applied)
   * Could be default, per-peer, or token-specific threshold
   */
  threshold: bigint;

  /**
   * Amount over threshold
   * Calculation: currentBalance - threshold
   * Format: bigint
   * Used for logging/debugging and settlement prioritization (future)
   *
   * Example: currentBalance=1200n, threshold=1000n → exceedsBy=200n
   */
  exceedsBy: bigint;

  /**
   * Timestamp when threshold was detected
   * Used for settlement event chronology and audit trails
   * Enables tracking time between threshold detection and settlement completion
   */
  timestamp: Date;
}

/**
 * Blockchain Configuration Interface
 *
 * Top-level blockchain configuration containing optional Base L2 and XRPL configurations.
 * Both are optional to support connectors that only integrate with one blockchain.
 *
 * @property base - Optional Base L2 / EVM configuration
 * @property xrpl - Optional XRP Ledger configuration
 *
 * @example
 * ```typescript
 * const blockchain: BlockchainConfig = {
 *   base: {
 *     enabled: true,
 *     rpcUrl: 'http://anvil:8545',
 *     chainId: 84532,
 *     privateKey: '0xac0974...',
 *     registryAddress: '0x1234...'
 *   },
 *   xrpl: {
 *     enabled: true,
 *     rpcUrl: 'http://rippled:5005',
 *     network: 'standalone'
 *   }
 * };
 * ```
 */
export interface BlockchainConfig {
  /**
   * Optional Base L2 / EVM blockchain configuration
   * Used for Epic 8 payment channel smart contracts
   * Enabled when connector needs to interact with Base L2
   */
  base?: BaseBlockchainConfig;

  /**
   * Optional XRP Ledger blockchain configuration
   * Used for Epic 9 XRP payment channels
   * Enabled when connector needs to interact with XRPL
   */
  xrpl?: XRPLBlockchainConfig;
}

/**
 * Base L2 Blockchain Configuration
 *
 * Configuration for Base L2 (OP Stack) blockchain integration.
 * Supports both local Anvil development and public Base mainnet/testnet.
 *
 * @property enabled - Whether Base blockchain integration is enabled
 * @property rpcUrl - RPC endpoint URL (local Anvil or public mainnet/testnet)
 * @property chainId - Expected chain ID (84532 = Base Sepolia, 8453 = Base mainnet)
 * @property privateKey - Optional private key for contract interactions (dev only)
 * @property registryAddress - Optional payment channel registry contract address
 *
 * @example
 * ```typescript
 * // Development configuration
 * const baseDev: BaseBlockchainConfig = {
 *   enabled: true,
 *   rpcUrl: 'http://anvil:8545',
 *   chainId: 84532,
 *   privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
 * };
 *
 * // Production configuration
 * const baseProd: BaseBlockchainConfig = {
 *   enabled: true,
 *   rpcUrl: 'https://mainnet.base.org',
 *   chainId: 8453,
 *   privateKey: process.env.BASE_PRIVATE_KEY,  // From secure KMS
 *   registryAddress: '0x1234567890123456789012345678901234567890'
 * };
 * ```
 */
export interface BaseBlockchainConfig {
  /**
   * Feature flag to enable/disable Base blockchain integration
   * When false, connector will not interact with Base L2
   * Default: false (backward compatible with pre-Epic 8 connectors)
   */
  enabled: boolean;

  /**
   * RPC endpoint URL for Base L2 blockchain
   *
   * Environment-specific defaults:
   * - Development: http://anvil:8545 (local Anvil fork)
   * - Staging: https://sepolia.base.org (Base Sepolia testnet)
   * - Production: https://mainnet.base.org (Base mainnet)
   *
   * Custom endpoints (Alchemy, Infura) recommended for production reliability
   */
  rpcUrl: string;

  /**
   * Expected chain ID for validation
   *
   * Standard chain IDs:
   * - 84532: Base Sepolia testnet
   * - 8453: Base mainnet
   *
   * Validated at runtime against RPC endpoint's actual chain ID
   */
  chainId: number;

  /**
   * Optional private key for contract interactions
   *
   * Development: Can use Anvil pre-funded account private key
   * Production: MUST use secure key from KMS/HSM (validation enforced)
   *
   * Known dev key (rejected in production):
   * 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
   */
  privateKey?: string;

  /**
   * Optional payment channel registry contract address
   *
   * Epic 8 will deploy PaymentChannelRegistry contract
   * Address varies by network (local Anvil vs testnet vs mainnet)
   *
   * Example: 0x1234567890123456789012345678901234567890
   */
  registryAddress?: string;
}

/**
 * XRP Ledger Blockchain Configuration
 *
 * Configuration for XRP Ledger (XRPL) integration.
 * Supports local rippled standalone, XRPL Testnet, and XRPL Mainnet.
 *
 * @property enabled - Whether XRPL integration is enabled
 * @property rpcUrl - XRPL RPC endpoint URL (local rippled or public mainnet/testnet)
 * @property network - XRPL network type ('standalone' | 'testnet' | 'mainnet')
 * @property privateKey - Optional private key for payment channel operations (dev only)
 *
 * @example
 * ```typescript
 * // Development configuration
 * const xrplDev: XRPLBlockchainConfig = {
 *   enabled: true,
 *   rpcUrl: 'http://rippled:5005',
 *   network: 'standalone',
 *   privateKey: 'snoPBrXtMeMyMHUVTgbuqAfg1SUTb'
 * };
 *
 * // Production configuration
 * const xrplProd: XRPLBlockchainConfig = {
 *   enabled: true,
 *   rpcUrl: 'https://xrplcluster.com',
 *   network: 'mainnet',
 *   privateKey: process.env.XRPL_PRIVATE_KEY  // From secure KMS
 * };
 * ```
 */
export interface XRPLBlockchainConfig {
  /**
   * Feature flag to enable/disable XRPL integration
   * When false, connector will not interact with XRP Ledger
   * Default: false (backward compatible with pre-Epic 9 connectors)
   */
  enabled: boolean;

  /**
   * RPC endpoint URL for XRP Ledger
   *
   * Environment-specific defaults:
   * - Development: http://rippled:5005 (local rippled standalone)
   * - Staging: https://s.altnet.rippletest.net:51234 (XRPL Testnet)
   * - Production: https://xrplcluster.com (XRPL Mainnet)
   *
   * WebSocket URLs (ws:// or wss://) also supported
   */
  rpcUrl: string;

  /**
   * XRPL network type
   *
   * Network types:
   * - standalone: Local rippled in standalone mode (no consensus)
   * - testnet: XRPL Testnet for public testing
   * - mainnet: XRPL Mainnet for production
   *
   * Validated to match ENVIRONMENT (production requires mainnet)
   */
  network: 'standalone' | 'testnet' | 'mainnet';

  /**
   * Optional private key for payment channel operations
   *
   * Development: Can generate from rippled standalone
   * Production: MUST use secure key from KMS/HSM
   *
   * Format: XRPL seed format (starts with 's')
   * Example: snoPBrXtMeMyMHUVTgbuqAfg1SUTb
   */
  privateKey?: string;
}

/**
 * Security Configuration Interface
 *
 * Configuration for security features including key management with HSM/KMS support.
 * Added in Epic 12 Story 12.2 to enable enterprise-grade key security.
 *
 * @property keyManagement - Key management configuration with multi-backend support
 *
 * @example
 * ```typescript
 * import { KeyManagerConfig } from '../security/key-manager';
 *
 * // Development configuration (environment variables)
 * const securityDev: SecurityConfig = {
 *   keyManagement: {
 *     backend: 'env',
 *     nodeId: 'connector-1'
 *   }
 * };
 *
 * // Production configuration (AWS KMS)
 * const securityProd: SecurityConfig = {
 *   keyManagement: {
 *     backend: 'aws-kms',
 *     nodeId: 'connector-1',
 *     aws: {
 *       region: 'us-east-1',
 *       evmKeyId: 'arn:aws:kms:us-east-1:123456789012:key/evm-key-id',
 *       xrpKeyId: 'arn:aws:kms:us-east-1:123456789012:key/xrp-key-id'
 *     }
 *   }
 * };
 * ```
 */
export interface SecurityConfig {
  /**
   * Key management configuration
   * Supports multiple backends: env, AWS KMS, GCP KMS, Azure Key Vault, HSM
   *
   * See KeyManagerConfig from ../security/key-manager for full configuration options
   */
  keyManagement: {
    backend: 'env' | 'aws-kms' | 'gcp-kms' | 'azure-kv' | 'hsm';
    nodeId: string;
    [key: string]: unknown; // Allow additional backend-specific fields
  };
}

/**
 * Performance Configuration Interface
 *
 * Configures performance optimization settings for high-throughput scenarios.
 * Enables batching, buffering, and connection pooling to achieve 10K+ TPS.
 *
 * Epic 12 Story 12.5 (Performance Optimization for 10K+ TPS)
 *
 * @property packetProcessing - Packet processing parallelization settings
 * @property tigerbeetle - TigerBeetle transfer batching settings
 * @property telemetry - Telemetry event buffering settings
 * @property connectionPools - Connection pool configurations for external services
 *
 * @example
 * ```typescript
 * const performance: PerformanceConfig = {
 *   packetProcessing: {
 *     workerThreads: 8,
 *     batchSize: 100
 *   },
 *   tigerbeetle: {
 *     batchSize: 100,
 *     flushIntervalMs: 10
 *   },
 *   telemetry: {
 *     bufferSize: 1000,
 *     flushIntervalMs: 100
 *   },
 *   connectionPools: {
 *     evm: {
 *       poolSize: 10,
 *       rpcUrls: ['https://mainnet.base.org', 'https://base.llamarpc.com']
 *     },
 *     xrp: {
 *       poolSize: 5,
 *       wssUrls: ['wss://xrplcluster.com', 'wss://s1.ripple.com']
 *     }
 *   }
 * };
 * ```
 */
export interface PerformanceConfig {
  /**
   * Packet processing parallelization configuration
   * Uses worker threads to parallelize packet processing across CPU cores
   *
   * @property workerThreads - Number of worker threads (default: CPU cores)
   * @property batchSize - Packets per batch (default: 100)
   */
  packetProcessing?: {
    workerThreads?: number;
    batchSize?: number;
  };

  /**
   * TigerBeetle transfer batching configuration
   * Batches transfers to reduce TigerBeetle round-trips
   *
   * @property batchSize - Transfers per batch (default: 100)
   * @property flushIntervalMs - Periodic flush interval (default: 10ms)
   * @property maxPendingTransfers - Maximum queued transfers (default: 1000)
   */
  tigerbeetle?: {
    batchSize?: number;
    flushIntervalMs?: number;
    maxPendingTransfers?: number;
  };

  /**
   * Telemetry event buffering configuration
   * Batches telemetry events to reduce logging overhead
   *
   * @property bufferSize - Events per batch (default: 1000)
   * @property flushIntervalMs - Periodic flush interval (default: 100ms)
   */
  telemetry?: {
    bufferSize?: number;
    flushIntervalMs?: number;
  };

  /**
   * Connection pool configurations for external services
   * Pools connections to blockchain RPC endpoints and WebSocket servers
   *
   * @property evm - EVM RPC connection pool configuration
   * @property xrp - XRP WebSocket connection pool configuration
   */
  connectionPools?: {
    /**
     * EVM RPC connection pool (for Base L2, Ethereum, etc.)
     * @property poolSize - Number of RPC connections (default: 10)
     * @property rpcUrls - List of RPC endpoint URLs
     */
    evm?: {
      poolSize?: number;
      rpcUrls?: string[];
    };

    /**
     * XRP WebSocket connection pool (for XRPL integration)
     * @property poolSize - Number of WebSocket connections (default: 5)
     * @property wssUrls - List of WebSocket endpoint URLs
     */
    xrp?: {
      poolSize?: number;
      wssUrls?: string[];
    };
  };
}

/**
 * Observability Configuration Interface
 *
 * Configures production monitoring, metrics, tracing, and SLA settings.
 * Added in Epic 12 Story 12.6 (Production Monitoring and Alerting).
 *
 * @property prometheus - Prometheus metrics exporter configuration
 * @property opentelemetry - OpenTelemetry distributed tracing configuration
 * @property sla - SLA monitoring thresholds
 *
 * @example
 * ```typescript
 * const observability: ObservabilityConfig = {
 *   prometheus: {
 *     enabled: true,
 *     metricsPath: '/metrics',
 *     includeDefaultMetrics: true,
 *     labels: { environment: 'production', nodeId: 'connector-1' }
 *   },
 *   opentelemetry: {
 *     enabled: true,
 *     serviceName: 'ilp-connector',
 *     exporterEndpoint: 'http://jaeger:4318/v1/traces',
 *     samplingRatio: 1.0
 *   },
 *   sla: {
 *     packetSuccessRateThreshold: 0.999,
 *     settlementSuccessRateThreshold: 0.99,
 *     p99LatencyThresholdMs: 10
 *   }
 * };
 * ```
 */
export interface ObservabilityConfig {
  /**
   * Prometheus metrics exporter configuration
   * Enables Prometheus metrics collection and export via /metrics endpoint
   *
   * @property enabled - Whether Prometheus metrics are enabled (default: true)
   * @property metricsPath - Path for metrics endpoint (default: '/metrics')
   * @property includeDefaultMetrics - Include Node.js default metrics (default: true)
   * @property labels - Global labels for all metrics (e.g., environment, nodeId)
   */
  prometheus?: {
    enabled?: boolean;
    metricsPath?: string;
    includeDefaultMetrics?: boolean;
    labels?: Record<string, string>;
  };

  /**
   * OpenTelemetry distributed tracing configuration
   * Enables distributed tracing across connector hops via OTLP
   *
   * @property enabled - Whether tracing is enabled (default: false)
   * @property serviceName - Service name for traces (default: 'ilp-connector')
   * @property exporterEndpoint - OTLP exporter endpoint (default: http://localhost:4318)
   * @property samplingRatio - Trace sampling ratio 0.0-1.0 (default: 1.0)
   */
  opentelemetry?: {
    enabled?: boolean;
    serviceName?: string;
    exporterEndpoint?: string;
    samplingRatio?: number;
  };

  /**
   * SLA monitoring thresholds
   * Defines thresholds for packet success, settlement success, and latency
   * Health endpoint reports 'degraded' status when thresholds are breached
   *
   * @property packetSuccessRateThreshold - Min packet success rate (default: 0.999 = 99.9%)
   * @property settlementSuccessRateThreshold - Min settlement success rate (default: 0.99 = 99%)
   * @property p99LatencyThresholdMs - Max p99 latency in ms (default: 10)
   */
  sla?: {
    packetSuccessRateThreshold?: number;
    settlementSuccessRateThreshold?: number;
    p99LatencyThresholdMs?: number;
  };
}
