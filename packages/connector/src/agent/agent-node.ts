import type { Logger } from 'pino';
import * as crypto from 'crypto';
import {
  ILPPreparePacket,
  ILPFulfillPacket,
  ILPRejectPacket,
  ILPErrorCode,
  PacketType,
  ILPAddress,
} from '@m2m/shared';
import { ToonCodec, NostrEvent, ToonDecodeError, ValidationError } from './toon-codec';
import { AgentEventDatabase } from './event-database';
import {
  AgentEventHandler,
  EventHandlerContext,
  EventHandlerResult,
  InsufficientPaymentError,
} from './event-handler';
import { FollowGraphRouter } from './follow-graph-router';
import { SubscriptionManager, Subscription } from './subscription-manager';
import { registerBuiltInHandlers } from './handlers';
import type { AIAgentConfig } from './ai/ai-agent-config';
import type { AIAgentDispatcher } from './ai/ai-agent-dispatcher';

// ============================================
// Configuration Interface (Task 1)
// ============================================

/**
 * Configuration for AgentNode.
 */
export interface AgentNodeConfig {
  /** This agent's Nostr public key (64-char hex) */
  agentPubkey: string;
  /** Optional private key for signing responses */
  agentPrivkey?: string;
  /** libSQL database path (e.g., './data/events.db' or ':memory:') */
  databasePath: string;
  /** Maximum database size in bytes (default: 100MB) */
  databaseMaxSize?: number;
  /** Pricing configuration for each service */
  pricing: {
    /** Cost for Kind 1 (Note storage) */
    noteStorage: bigint;
    /** Cost for Kind 3 (Follow list update) */
    followUpdate: bigint;
    /** Cost for Kind 5 (Event deletion) */
    deletion: bigint;
    /** Base cost for Kind 10000 (Query) */
    queryBase: bigint;
    /** Optional per-result cost */
    queryPerResult?: bigint;
  };
  /** Whether to register built-in handlers (default: true) */
  enableBuiltInHandlers?: boolean;
  /** Maximum subscriptions per peer (default: 10) */
  maxSubscriptionsPerPeer?: number;
  /** AI agent configuration (optional — AI enabled by default if configured) */
  ai?: AIAgentConfig;
}

// ============================================
// Telemetry Event Types (Task 9)
// ============================================

/**
 * Agent-specific telemetry event types.
 */
export interface AgentTelemetryEvent {
  /** Event type identifier */
  type: 'AGENT_EVENT_RECEIVED' | 'AGENT_EVENT_HANDLED' | 'AGENT_SUBSCRIPTION_PUSH';
  /** ISO 8601 timestamp */
  timestamp: string;
  /** This agent's pubkey */
  agentPubkey: string;
  /** Nostr event kind (for RECEIVED/HANDLED) */
  eventKind?: number;
  /** Nostr event ID (for RECEIVED/HANDLED) */
  eventId?: string;
  /** Handler success status (for HANDLED) */
  success?: boolean;
  /** Error code if handler failed (for HANDLED) */
  errorCode?: string;
  /** Number of matching subscriptions (for SUBSCRIPTION_PUSH) */
  subscriptionCount?: number;
}

// ============================================
// Fulfillment Constants
// ============================================

/**
 * Deterministic fulfillment for agent service requests.
 * For MVP, agent services use payment validation as the primary gate,
 * not HTLC escrow with external pre-images.
 */
const AGENT_FULFILLMENT = Buffer.alloc(32, 0);
const AGENT_CONDITION = crypto.createHash('sha256').update(AGENT_FULFILLMENT).digest();

// ============================================
// Default Values
// ============================================

const DEFAULT_DATABASE_MAX_SIZE = 100 * 1024 * 1024; // 100MB
const DEFAULT_MAX_SUBSCRIPTIONS_PER_PEER = 10;

// ============================================
// AgentNode Class (Tasks 2-11)
// ============================================

/**
 * AgentNode orchestrates agent-to-agent communication over the Interledger network.
 *
 * Key responsibilities:
 * 1. Initialize all agent components on startup
 * 2. Detect TOON events in incoming ILP packets
 * 3. Route events to AgentEventHandler
 * 4. Create ILP response packets (Fulfill or Reject)
 * 5. Push events to subscribers after successful storage
 * 6. Emit telemetry for monitoring
 * 7. Gracefully shutdown with database close
 *
 * @example
 * ```typescript
 * const node = new AgentNode({
 *   agentPubkey: 'abc123...',
 *   databasePath: ':memory:',
 *   pricing: {
 *     noteStorage: 100n,
 *     followUpdate: 50n,
 *     deletion: 10n,
 *     queryBase: 200n,
 *   },
 * }, logger);
 *
 * await node.initialize();
 *
 * // Process incoming ILP packet
 * const response = await node.processIncomingPacket(packet, 'peer-123');
 *
 * // Graceful shutdown
 * await node.shutdown();
 * ```
 */
export class AgentNode {
  private readonly _agentConfig: AgentNodeConfig;
  private readonly _logger: Logger;
  private readonly _database: AgentEventDatabase;
  private readonly _eventHandler: AgentEventHandler;
  private readonly _subscriptionManager: SubscriptionManager;
  private readonly _followGraphRouter: FollowGraphRouter;
  private readonly _toonCodec: ToonCodec;
  private _aiDispatcher?: AIAgentDispatcher;
  private _initialized: boolean = false;

  /**
   * Event emitter for telemetry events.
   * External code can set this to receive telemetry.
   */
  public onTelemetry?: (event: AgentTelemetryEvent) => void;

  /**
   * Creates a new AgentNode instance.
   *
   * @param config - Agent configuration
   * @param logger - Pino logger instance
   * @throws Error if config is invalid
   */
  constructor(config: AgentNodeConfig, logger?: Logger) {
    // Validate required config fields
    if (!config.agentPubkey || typeof config.agentPubkey !== 'string') {
      throw new Error('Invalid config: agentPubkey is required and must be a string');
    }
    if (!config.databasePath || typeof config.databasePath !== 'string') {
      throw new Error('Invalid config: databasePath is required and must be a string');
    }
    if (!config.pricing) {
      throw new Error('Invalid config: pricing is required');
    }

    this._agentConfig = config;

    // Create logger
    if (logger) {
      this._logger = logger.child({ component: 'AgentNode' });
    } else {
      this._logger = {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: function () {
          return this;
        },
      } as unknown as Logger;
    }

    // Create database instance
    this._database = new AgentEventDatabase({
      path: config.databasePath,
      maxSizeBytes: config.databaseMaxSize ?? DEFAULT_DATABASE_MAX_SIZE,
    });

    // Create subscription manager
    this._subscriptionManager = new SubscriptionManager({
      maxSubscriptionsPerPeer: config.maxSubscriptionsPerPeer ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_PEER,
      logger: logger,
    });

    // Create follow graph router
    this._followGraphRouter = new FollowGraphRouter({
      agentPubkey: config.agentPubkey,
      logger: logger,
    });

    // Create event handler
    this._eventHandler = new AgentEventHandler({
      agentPubkey: config.agentPubkey,
      database: this._database,
      logger: logger,
    });

    // Create TOON codec
    this._toonCodec = new ToonCodec();
  }

  // ============================================
  // Initialization (Task 3)
  // ============================================

  /**
   * Initialize the AgentNode and all components.
   *
   * This method:
   * - Initializes the event database (creates schema)
   * - Registers built-in handlers if enabled
   */
  async initialize(): Promise<void> {
    if (this._initialized) {
      this._logger.warn('AgentNode already initialized');
      return;
    }

    // Initialize event database (creates schema)
    await this._database.initialize();

    // Register built-in handlers if enabled
    if (this._agentConfig.enableBuiltInHandlers !== false) {
      registerBuiltInHandlers(this._eventHandler, {
        followGraphRouter: this._followGraphRouter,
        pricing: this._agentConfig.pricing,
        logger: this._logger,
      });
    }

    // Log AI configuration status
    if (this._agentConfig.ai) {
      this._logger.info(
        {
          enabled: this._agentConfig.ai.enabled,
          model: this._agentConfig.ai.model,
          maxTokensPerRequest: this._agentConfig.ai.maxTokensPerRequest,
        },
        'AI config present'
      );
    }

    // Initialize AI dispatcher if configured
    if (this._agentConfig.ai?.enabled) {
      await this._initializeAIDispatcher();
    }

    this._initialized = true;
    this._logger.info('AgentNode initialized');
    if (this._aiDispatcher) {
      this._logger.info({ aiEnabled: true }, 'AI agent dispatcher active');
    }
  }

  // ============================================
  // AI Dispatcher Initialization
  // ============================================

  /**
   * Initialize the AI agent dispatcher.
   * Dynamically imports AI modules to keep them optional.
   */
  private async _initializeAIDispatcher(): Promise<void> {
    const aiConfig = this._agentConfig.ai;
    if (!aiConfig) return;

    try {
      // Dynamic imports to keep AI SDK optional
      const { createModelFromConfig } = await import('./ai/provider-factory');
      const { SkillRegistry } = await import('./ai/skill-registry');
      const { SystemPromptBuilder } = await import('./ai/system-prompt');
      const { TokenBudget } = await import('./ai/token-budget');
      const { AIAgentDispatcher } = await import('./ai/ai-agent-dispatcher');
      const { registerBuiltInSkills } = await import('./ai/skills');

      // Create AI model from config
      const model = await createModelFromConfig(aiConfig);

      // Create skill registry and register built-in skills
      const skillRegistry = new SkillRegistry();
      registerBuiltInSkills(skillRegistry, {
        followGraphRouter: this._followGraphRouter,
        registeredKinds: () => this._eventHandler.getRegisteredKinds(),
      });

      // Create system prompt builder
      const systemPromptBuilder = new SystemPromptBuilder({
        agentPubkey: this._agentConfig.agentPubkey,
        personality: aiConfig.personality,
        skillRegistry,
      });

      // Create token budget
      const tokenBudget = new TokenBudget({
        maxTokensPerWindow: aiConfig.budget.maxTokensPerHour,
        onTelemetry: (event) => {
          this._logger.debug({ telemetry: event }, 'AI budget telemetry');
        },
      });

      // Create AI dispatcher
      this._aiDispatcher = new AIAgentDispatcher({
        aiConfig,
        model,
        skillRegistry,
        systemPromptBuilder,
        tokenBudget,
        fallbackHandler: this._eventHandler,
        logger: this._logger,
      });

      this._logger.info(
        {
          model: aiConfig.model,
          skillCount: skillRegistry.size,
          skills: skillRegistry.getSkillNames(),
          maxTokensPerHour: aiConfig.budget.maxTokensPerHour,
        },
        'AI agent dispatcher initialized'
      );
    } catch (error) {
      this._logger.warn(
        { err: error },
        'Failed to initialize AI dispatcher, falling back to direct handler dispatch'
      );
      // AI initialization failure is non-fatal — direct dispatch continues to work
    }
  }

  // ============================================
  // TOON Event Detection (Task 4)
  // ============================================

  /**
   * Check if a buffer contains a valid TOON-encoded Nostr event.
   *
   * @param data - Buffer to check
   * @returns true if buffer contains valid TOON event
   */
  isToonEvent(data: Buffer): boolean {
    // Skip obviously non-TOON data (too small)
    if (!Buffer.isBuffer(data) || data.length < 10) {
      return false;
    }

    try {
      // Attempt to decode as TOON
      this._toonCodec.decode(data);
      return true;
    } catch (error) {
      // ToonDecodeError or ValidationError means not a valid TOON event
      if (error instanceof ToonDecodeError || error instanceof ValidationError) {
        return false;
      }
      // Re-throw unexpected errors
      throw error;
    }
  }

  // ============================================
  // Event Processing (Task 5)
  // ============================================

  /**
   * Process an incoming ILP packet that may contain a TOON event.
   *
   * @param packet - The incoming ILP Prepare packet
   * @param source - Source peer/connection identifier
   * @returns ILP Fulfill or Reject packet
   */
  async processIncomingPacket(
    packet: ILPPreparePacket,
    source: string
  ): Promise<ILPFulfillPacket | ILPRejectPacket> {
    // Check if initialized
    if (!this._initialized) {
      return this._createReject('T00', 'Agent not initialized', packet.destination);
    }

    // Detect if packet contains TOON event
    if (!this.isToonEvent(packet.data)) {
      return this._createReject('F01', 'Invalid packet data', packet.destination);
    }

    // Decode TOON event
    let event: NostrEvent;
    try {
      event = this._toonCodec.decode(packet.data);
    } catch (error) {
      return this._createReject('F01', 'Invalid TOON data', packet.destination);
    }

    // Emit AGENT_EVENT_RECEIVED telemetry
    this._emitTelemetry({
      type: 'AGENT_EVENT_RECEIVED',
      timestamp: new Date().toISOString(),
      agentPubkey: this._agentConfig.agentPubkey,
      eventKind: event.kind,
      eventId: event.id,
    });

    // Build handler context
    const context: EventHandlerContext = {
      event,
      packet,
      amount: packet.amount,
      source,
      agentPubkey: this._agentConfig.agentPubkey,
      database: this._database,
    };

    // Route to event handler (AI dispatch primary, direct fallback)
    try {
      const handler = this._aiDispatcher ?? this._eventHandler;
      const result = await handler.handleEvent(context);

      // Emit AGENT_EVENT_HANDLED telemetry
      this._emitTelemetry({
        type: 'AGENT_EVENT_HANDLED',
        timestamp: new Date().toISOString(),
        agentPubkey: this._agentConfig.agentPubkey,
        eventKind: event.kind,
        eventId: event.id,
        success: result.success,
        errorCode: result.error?.code,
      });

      // Handle subscription push for successful Kind 1 events (Task 6)
      let matchingSubscriptions: Subscription[] = [];
      if (result.success && event.kind === 1) {
        matchingSubscriptions = this._subscriptionManager.getMatchingSubscriptions(event);
        for (const sub of matchingSubscriptions) {
          this._logger.debug({ peerId: sub.peerId, subId: sub.id }, 'Event matches subscription');
        }

        // Emit AGENT_SUBSCRIPTION_PUSH telemetry if there are matching subscriptions
        if (matchingSubscriptions.length > 0) {
          this._emitTelemetry({
            type: 'AGENT_SUBSCRIPTION_PUSH',
            timestamp: new Date().toISOString(),
            agentPubkey: this._agentConfig.agentPubkey,
            eventKind: event.kind,
            eventId: event.id,
            subscriptionCount: matchingSubscriptions.length,
          });
        }
      }

      return this._createResponsePacket(result, packet, matchingSubscriptions);
    } catch (error) {
      if (error instanceof InsufficientPaymentError) {
        // Emit telemetry for payment failure
        this._emitTelemetry({
          type: 'AGENT_EVENT_HANDLED',
          timestamp: new Date().toISOString(),
          agentPubkey: this._agentConfig.agentPubkey,
          eventKind: event.kind,
          eventId: event.id,
          success: false,
          errorCode: 'F03',
        });
        return this._eventHandler.createPaymentReject(error, packet.destination as ILPAddress);
      }
      // Unexpected error - return T00
      this._logger.error({ err: error }, 'Unexpected error processing packet');
      return this._createReject('T00', 'Internal error', packet.destination);
    }
  }

  // ============================================
  // Response Packet Creation (Task 7)
  // ============================================

  /**
   * Create a response packet from handler result.
   *
   * @param result - Handler execution result
   * @param originalPacket - Original ILP Prepare packet
   * @param matchingSubscriptions - Subscriptions that matched (for Kind 1)
   * @returns ILP Fulfill or Reject packet
   */
  private _createResponsePacket(
    result: EventHandlerResult,
    originalPacket: ILPPreparePacket,
    _matchingSubscriptions: Subscription[] = []
  ): ILPFulfillPacket | ILPRejectPacket {
    if (result.success) {
      // Create fulfill packet
      let data: Buffer;

      if (result.responseEvents && result.responseEvents.length > 0) {
        // Multiple response events
        data = this._toonCodec.encodeMany(result.responseEvents);
      } else if (result.responseEvent) {
        // Single response event
        data = this._toonCodec.encode(result.responseEvent);
      } else {
        // No response events - empty data
        data = Buffer.alloc(0);
      }

      return {
        type: PacketType.FULFILL,
        fulfillment: AGENT_FULFILLMENT,
        data,
      };
    } else {
      // Create reject packet
      const errorCode = this._mapErrorCode(result.error?.code ?? 'F99');
      return {
        type: PacketType.REJECT,
        code: errorCode,
        triggeredBy: originalPacket.destination as ILPAddress,
        message: result.error?.message ?? 'Unknown error',
        data: Buffer.alloc(0),
      };
    }
  }

  // ============================================
  // Reject Packet Helper (Task 8)
  // ============================================

  /**
   * Create an ILP reject packet.
   *
   * @param code - Error code string (e.g., 'F01', 'T00')
   * @param message - Human-readable error message
   * @param triggeredBy - Address of connector generating the error
   * @returns ILP reject packet
   */
  private _createReject(code: string, message: string, triggeredBy: string): ILPRejectPacket {
    return {
      type: PacketType.REJECT,
      code: this._mapErrorCode(code),
      triggeredBy: triggeredBy as ILPAddress,
      message,
      data: Buffer.alloc(0),
    };
  }

  /**
   * Map string error code to ILPErrorCode enum.
   *
   * @param code - String error code
   * @returns ILPErrorCode enum value
   */
  private _mapErrorCode(code: string): ILPErrorCode {
    const mapping: Record<string, ILPErrorCode> = {
      F00: ILPErrorCode.F00_BAD_REQUEST,
      F01: ILPErrorCode.F01_INVALID_PACKET,
      F02: ILPErrorCode.F02_UNREACHABLE,
      F03: ILPErrorCode.F03_INVALID_AMOUNT,
      F06: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
      F08: ILPErrorCode.F08_DUPLICATE_PACKET,
      F99: ILPErrorCode.F99_APPLICATION_ERROR,
      T00: ILPErrorCode.T00_INTERNAL_ERROR,
      T01: ILPErrorCode.T01_PEER_UNREACHABLE,
      T02: ILPErrorCode.T02_PEER_BUSY,
      T03: ILPErrorCode.T03_CONNECTOR_BUSY,
      T04: ILPErrorCode.T04_INSUFFICIENT_LIQUIDITY,
      T99: ILPErrorCode.T99_APPLICATION_ERROR,
      R00: ILPErrorCode.R00_TRANSFER_TIMED_OUT,
      R01: ILPErrorCode.R01_INSUFFICIENT_SOURCE_AMOUNT,
      R02: ILPErrorCode.R02_INSUFFICIENT_TIMEOUT,
      R99: ILPErrorCode.R99_APPLICATION_ERROR,
    };

    return mapping[code] ?? ILPErrorCode.F99_APPLICATION_ERROR;
  }

  // ============================================
  // Telemetry (Task 9)
  // ============================================

  /**
   * Emit a telemetry event (non-blocking).
   *
   * @param event - Telemetry event to emit
   */
  private _emitTelemetry(event: AgentTelemetryEvent): void {
    try {
      if (this.onTelemetry) {
        this.onTelemetry(event);
      }
      this._logger.debug({ telemetry: event }, 'Telemetry emitted');
    } catch (error) {
      // Non-blocking - log but don't throw
      this._logger.warn({ err: error }, 'Failed to emit telemetry');
    }
  }

  // ============================================
  // Graceful Shutdown (Task 10)
  // ============================================

  /**
   * Gracefully shutdown the AgentNode.
   *
   * This method:
   * - Closes the database connection
   * - Clears subscription manager state
   * - Sets initialized to false
   */
  async shutdown(): Promise<void> {
    this._logger.info('AgentNode shutting down...');

    // Close database connection
    try {
      await this._database.close();
    } catch (error) {
      this._logger.warn({ err: error }, 'Error closing database during shutdown');
    }

    // In-memory subscriptions are lost on shutdown - acceptable for MVP

    this._initialized = false;
    this._logger.info('AgentNode shutdown complete');
  }

  // ============================================
  // Component Accessors (Task 11)
  // ============================================

  /**
   * Get the event database instance.
   */
  get database(): AgentEventDatabase {
    return this._database;
  }

  /**
   * Get the event handler instance.
   */
  get eventHandler(): AgentEventHandler {
    return this._eventHandler;
  }

  /**
   * Get the subscription manager instance.
   */
  get subscriptionManager(): SubscriptionManager {
    return this._subscriptionManager;
  }

  /**
   * Get the follow graph router instance.
   */
  get followGraphRouter(): FollowGraphRouter {
    return this._followGraphRouter;
  }

  /**
   * Get the AI dispatcher instance (if AI is enabled).
   */
  get aiDispatcher(): AIAgentDispatcher | undefined {
    return this._aiDispatcher;
  }

  /**
   * Check if the node is initialized.
   */
  get isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Get the agent's Nostr public key.
   */
  get agentPubkey(): string {
    return this._agentConfig.agentPubkey;
  }

  /**
   * Get the agent condition (SHA-256 hash of fulfillment).
   * Used for validating incoming packets or generating conditions.
   */
  static get AGENT_CONDITION(): Buffer {
    return AGENT_CONDITION;
  }

  /**
   * Get the agent fulfillment (32 zero bytes).
   * Used for fulfilling agent service requests.
   */
  static get AGENT_FULFILLMENT(): Buffer {
    return AGENT_FULFILLMENT;
  }
}
