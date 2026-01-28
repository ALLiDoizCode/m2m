/**
 * Agent Configuration Loader Module
 *
 * Provides functionality to load and validate Agent Society Protocol
 * configuration from YAML files. Supports agent identity, database settings,
 * pricing configuration, static follow lists, and handler enable/disable.
 *
 * @packageDocumentation
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as yaml from 'js-yaml';
import { getPublicKey, nip19 } from 'nostr-tools';
import { isValidILPAddress } from '@m2m/shared';
import type { AgentNodeConfig } from '../agent/agent-node';
import type { FollowGraphRouter } from '../agent/follow-graph-router';
import type { Logger } from 'pino';
import { parseAIConfig, type AIYamlConfig } from '../agent/ai/ai-agent-config';

// ============================================
// Constants
// ============================================

/** Default maximum database size (100MB) */
const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024;

/** Default maximum subscriptions per peer */
const DEFAULT_MAX_SUBSCRIPTIONS_PER_PEER = 10;

/** PBKDF2 iteration count for key derivation */
const PBKDF2_ITERATIONS = 100000;

/** AES-256-GCM IV length */
const IV_LENGTH = 16;

/** AES-256-GCM auth tag length */
const AUTH_TAG_LENGTH = 16;

// ============================================
// Error Classes (Task 8)
// ============================================

/**
 * Custom Error Class for Agent Configuration Errors
 *
 * Thrown when agent configuration validation fails during loading.
 * Provides descriptive error messages with optional field name
 * to help operators fix configuration issues.
 *
 * @example
 * ```typescript
 * throw new AgentConfigurationError('Invalid private key format', 'agent.privateKey');
 * ```
 */
export class AgentConfigurationError extends Error {
  /** The configuration field that caused the error */
  public readonly field?: string;

  constructor(message: string, field?: string) {
    super(field ? `${message} (field: ${field})` : message);
    this.name = 'AgentConfigurationError';
    this.field = field;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AgentConfigurationError);
    }
  }
}

// ============================================
// Type Definitions (Task 1)
// ============================================

/**
 * YAML configuration structure for agent identity.
 */
export interface AgentIdentityConfig {
  /** Nostr private key (hex) - for development only */
  privateKey?: string;
  /** Path to key file - for production use */
  keyFilePath?: string;
  /** Nostr public key (derived or explicit) */
  publicKey?: string;
}

/**
 * YAML configuration structure for database settings.
 */
export interface AgentDatabaseConfig {
  /** libSQL path (file:./data/events.db or :memory:) */
  path: string;
  /** Max size in bytes (default: 100MB) */
  maxSizeBytes?: number;
}

/**
 * YAML configuration structure for pricing.
 * All values are strings to support bigint parsing from YAML.
 */
export interface AgentPricingConfig {
  /** Kind 1 note storage cost */
  noteStorage: string;
  /** Kind 3 follow update cost */
  followUpdate: string;
  /** Kind 5 deletion cost */
  deletion: string;
  /** Kind 10000 query base cost */
  queryBase: string;
  /** Per-result cost (optional) */
  queryPerResult?: string;
}

/**
 * YAML configuration structure for a static follow entry.
 */
export interface AgentFollowConfig {
  /** Followed agent's Nostr pubkey (hex) */
  pubkey: string;
  /** ILP address for this agent */
  ilpAddress: string;
  /** Optional petname/alias */
  petname?: string;
}

/**
 * YAML configuration structure for handler enable/disable.
 */
export interface AgentHandlersConfig {
  /** Enable Kind 1 note handler (default: true) */
  enableNoteHandler?: boolean;
  /** Enable Kind 3 follow handler (default: true) */
  enableFollowHandler?: boolean;
  /** Enable Kind 5 delete handler (default: true) */
  enableDeleteHandler?: boolean;
  /** Enable Kind 10000 query handler (default: true) */
  enableQueryHandler?: boolean;
}

/**
 * YAML configuration structure for subscription settings.
 */
export interface AgentSubscriptionsConfig {
  /** Max subscriptions per peer (default: 10) */
  maxPerPeer?: number;
}

/**
 * Complete YAML configuration structure for an agent.
 * Represents the raw YAML structure - uses strings for bigint values.
 */
export interface AgentYamlConfig {
  /** Agent identity configuration */
  agent: AgentIdentityConfig;
  /** Database configuration */
  database: AgentDatabaseConfig;
  /** Pricing configuration per service */
  pricing: AgentPricingConfig;
  /** Static follow list (optional) */
  follows?: AgentFollowConfig[];
  /** Handler enable/disable configuration (optional) */
  handlers?: AgentHandlersConfig;
  /** Subscription settings (optional) */
  subscriptions?: AgentSubscriptionsConfig;
  /** AI agent configuration (optional) */
  ai?: AIYamlConfig;
}

/**
 * Parsed pricing configuration with bigint values.
 */
export interface ParsedPricing {
  noteStorage: bigint;
  followUpdate: bigint;
  deletion: bigint;
  queryBase: bigint;
  queryPerResult?: bigint;
}

// ============================================
// Agent Configuration Loader Class (Tasks 2-7)
// ============================================

/**
 * Agent Configuration Loader Class
 *
 * Static class providing methods to load and validate agent
 * configuration from YAML files. Performs comprehensive validation
 * including identity, database, pricing, follows, and handlers.
 *
 * @example
 * ```typescript
 * try {
 *   const yamlConfig = AgentConfigLoader.loadConfig('./agent-config.yaml');
 *   const nodeConfig = AgentConfigLoader.toAgentNodeConfig(yamlConfig);
 *   const node = new AgentNode(nodeConfig, logger);
 * } catch (error) {
 *   if (error instanceof AgentConfigurationError) {
 *     console.error(`Configuration error: ${error.message}`);
 *     process.exit(1);
 *   }
 * }
 * ```
 */
export class AgentConfigLoader {
  /**
   * Load and Validate Configuration from YAML File (Task 2)
   *
   * Reads a YAML configuration file from disk, parses it, and validates
   * all fields according to the agent configuration schema.
   *
   * @param filePath - Absolute or relative path to YAML configuration file
   * @returns Validated AgentYamlConfig object
   * @throws AgentConfigurationError if file not found, YAML invalid, or validation fails
   */
  static loadConfig(filePath: string): AgentYamlConfig {
    // Step 1: Read file from disk
    let fileContent: string;
    try {
      fileContent = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AgentConfigurationError(`Configuration file not found: ${filePath}`);
      }
      throw new AgentConfigurationError(
        `Failed to read configuration file: ${(error as Error).message}`
      );
    }

    // Step 2: Parse YAML
    let config: unknown;
    try {
      config = yaml.load(fileContent);
    } catch (error) {
      throw new AgentConfigurationError(`Invalid YAML syntax: ${(error as Error).message}`);
    }

    // Ensure we have an object
    if (!config || typeof config !== 'object') {
      throw new AgentConfigurationError('Configuration must be a YAML object');
    }

    // Step 3: Validate configuration
    this.validateConfig(config);

    return config as AgentYamlConfig;
  }

  /**
   * Load Configuration from Environment Variables (Task 2)
   *
   * Loads agent configuration from environment variables as fallback
   * when no YAML file is provided.
   *
   * Environment variables:
   * - AGENT_PRIVATE_KEY: Nostr private key (hex)
   * - AGENT_KEY_FILE_PATH: Path to key file
   * - AGENT_PUBLIC_KEY: Nostr public key (optional)
   * - AGENT_DATABASE_PATH: libSQL database path
   * - AGENT_DATABASE_MAX_SIZE: Max database size in bytes
   * - AGENT_PRICING_NOTE_STORAGE: Note storage cost
   * - AGENT_PRICING_FOLLOW_UPDATE: Follow update cost
   * - AGENT_PRICING_DELETION: Deletion cost
   * - AGENT_PRICING_QUERY_BASE: Query base cost
   * - AGENT_PRICING_QUERY_PER_RESULT: Per-result cost
   * - AGENT_MAX_SUBSCRIPTIONS_PER_PEER: Max subscriptions per peer
   *
   * @returns Validated AgentYamlConfig object
   * @throws AgentConfigurationError if required environment variables missing
   */
  static loadConfigFromEnv(): AgentYamlConfig {
    const config: AgentYamlConfig = {
      agent: {},
      database: {
        path: process.env.AGENT_DATABASE_PATH || '',
      },
      pricing: {
        noteStorage: process.env.AGENT_PRICING_NOTE_STORAGE || '',
        followUpdate: process.env.AGENT_PRICING_FOLLOW_UPDATE || '',
        deletion: process.env.AGENT_PRICING_DELETION || '',
        queryBase: process.env.AGENT_PRICING_QUERY_BASE || '',
      },
    };

    // Agent identity
    if (process.env.AGENT_PRIVATE_KEY) {
      config.agent.privateKey = process.env.AGENT_PRIVATE_KEY;
    }
    if (process.env.AGENT_KEY_FILE_PATH) {
      config.agent.keyFilePath = process.env.AGENT_KEY_FILE_PATH;
    }
    if (process.env.AGENT_PUBLIC_KEY) {
      config.agent.publicKey = process.env.AGENT_PUBLIC_KEY;
    }

    // Database
    if (process.env.AGENT_DATABASE_MAX_SIZE) {
      config.database.maxSizeBytes = parseInt(process.env.AGENT_DATABASE_MAX_SIZE, 10);
    }

    // Optional pricing
    if (process.env.AGENT_PRICING_QUERY_PER_RESULT) {
      config.pricing.queryPerResult = process.env.AGENT_PRICING_QUERY_PER_RESULT;
    }

    // Subscriptions
    if (process.env.AGENT_MAX_SUBSCRIPTIONS_PER_PEER) {
      config.subscriptions = {
        maxPerPeer: parseInt(process.env.AGENT_MAX_SUBSCRIPTIONS_PER_PEER, 10),
      };
    }

    // Validate the constructed config
    this.validateConfig(config);

    return config;
  }

  /**
   * Validate Configuration (Task 3)
   *
   * Validates all fields in the agent configuration object.
   *
   * @param config - Raw configuration object from YAML or env vars
   * @throws AgentConfigurationError if validation fails
   */
  static validateConfig(config: unknown): void {
    if (!config || typeof config !== 'object') {
      throw new AgentConfigurationError('Configuration must be an object');
    }

    const rawConfig = config as Record<string, unknown>;

    // Validate agent identity (AC: 1)
    this.validateAgentIdentity(rawConfig.agent);

    // Validate database config (AC: 2)
    this.validateDatabaseConfig(rawConfig.database);

    // Validate pricing config (AC: 3)
    this.validatePricingConfig(rawConfig.pricing);

    // Validate follows array (AC: 4)
    if (rawConfig.follows !== undefined) {
      this.validateFollowsConfig(rawConfig.follows);
    }

    // Validate handlers config (AC: 5)
    if (rawConfig.handlers !== undefined) {
      this.validateHandlersConfig(rawConfig.handlers);
    }

    // Validate subscriptions config
    if (rawConfig.subscriptions !== undefined) {
      this.validateSubscriptionsConfig(rawConfig.subscriptions);
    }

    // Validate AI config (optional section)
    if (rawConfig.ai !== undefined) {
      this.validateAIConfig(rawConfig.ai);
    }
  }

  /**
   * Validate Agent Identity Configuration (AC: 1)
   */
  private static validateAgentIdentity(agent: unknown): void {
    if (!agent || typeof agent !== 'object') {
      throw new AgentConfigurationError('Missing required section: agent', 'agent');
    }

    const agentConfig = agent as Record<string, unknown>;
    const hasPrivateKey = 'privateKey' in agentConfig && agentConfig.privateKey;
    const hasKeyFilePath = 'keyFilePath' in agentConfig && agentConfig.keyFilePath;

    // Either privateKey OR keyFilePath must be provided
    if (!hasPrivateKey && !hasKeyFilePath) {
      throw new AgentConfigurationError(
        'Either privateKey or keyFilePath must be provided',
        'agent'
      );
    }

    // Validate privateKey format if provided
    if (hasPrivateKey) {
      const privateKey = agentConfig.privateKey as string;
      if (typeof privateKey !== 'string') {
        throw new AgentConfigurationError('privateKey must be a string', 'agent.privateKey');
      }
      // Check for 64-char hex format
      if (!/^[0-9a-fA-F]{64}$/.test(privateKey)) {
        throw new AgentConfigurationError(
          'privateKey must be a 64-character hex string',
          'agent.privateKey'
        );
      }

      // Warn if both are provided
      if (hasKeyFilePath) {
        // In a real scenario, we'd log this warning
        // For now, privateKey takes precedence
      }
    }

    // Validate keyFilePath if provided (and no privateKey)
    if (hasKeyFilePath && !hasPrivateKey) {
      const keyFilePath = agentConfig.keyFilePath as string;
      if (typeof keyFilePath !== 'string') {
        throw new AgentConfigurationError('keyFilePath must be a string', 'agent.keyFilePath');
      }
      // File existence check is deferred to loadPrivateKeyFromFile
    }

    // Validate publicKey if provided
    if ('publicKey' in agentConfig && agentConfig.publicKey) {
      const publicKey = agentConfig.publicKey as string;
      if (typeof publicKey !== 'string') {
        throw new AgentConfigurationError('publicKey must be a string', 'agent.publicKey');
      }
      if (!/^[0-9a-fA-F]{64}$/.test(publicKey)) {
        throw new AgentConfigurationError(
          'publicKey must be a 64-character hex string',
          'agent.publicKey'
        );
      }
    }
  }

  /**
   * Validate Database Configuration (AC: 2)
   */
  private static validateDatabaseConfig(database: unknown): void {
    if (!database || typeof database !== 'object') {
      throw new AgentConfigurationError('Missing required section: database', 'database');
    }

    const dbConfig = database as Record<string, unknown>;

    // path is required
    if (!('path' in dbConfig) || !dbConfig.path) {
      throw new AgentConfigurationError('database.path is required', 'database.path');
    }

    if (typeof dbConfig.path !== 'string') {
      throw new AgentConfigurationError('database.path must be a string', 'database.path');
    }

    // Validate path format (file: or :memory:)
    const path = dbConfig.path as string;
    if (path !== ':memory:' && !path.startsWith('file:')) {
      throw new AgentConfigurationError(
        'database.path must start with "file:" or be ":memory:"',
        'database.path'
      );
    }

    // Validate maxSizeBytes if provided
    if ('maxSizeBytes' in dbConfig && dbConfig.maxSizeBytes !== undefined) {
      const maxSize = dbConfig.maxSizeBytes;
      if (typeof maxSize !== 'number') {
        throw new AgentConfigurationError(
          'database.maxSizeBytes must be a number',
          'database.maxSizeBytes'
        );
      }
      if (maxSize < 0) {
        throw new AgentConfigurationError(
          'database.maxSizeBytes must be non-negative',
          'database.maxSizeBytes'
        );
      }
      // Warn if zero (might be intentional for testing)
      // Logging would happen in a real implementation
    }
  }

  /**
   * Validate Pricing Configuration (AC: 3)
   */
  private static validatePricingConfig(pricing: unknown): void {
    if (!pricing || typeof pricing !== 'object') {
      throw new AgentConfigurationError('Missing required section: pricing', 'pricing');
    }

    const pricingConfig = pricing as Record<string, unknown>;

    // Required pricing fields
    const requiredFields = ['noteStorage', 'followUpdate', 'deletion', 'queryBase'];
    for (const field of requiredFields) {
      if (!(field in pricingConfig) || pricingConfig[field] === undefined) {
        throw new AgentConfigurationError(
          `Missing required pricing field: ${field}`,
          `pricing.${field}`
        );
      }

      const value = pricingConfig[field];
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new AgentConfigurationError(
          `pricing.${field} must be a string or number`,
          `pricing.${field}`
        );
      }

      // Try to parse as bigint
      try {
        const parsed = this.parseBigintValue(String(value));
        if (parsed < 0n) {
          throw new AgentConfigurationError(
            `pricing.${field} must be non-negative`,
            `pricing.${field}`
          );
        }
      } catch (error) {
        if (error instanceof AgentConfigurationError) {
          throw error;
        }
        throw new AgentConfigurationError(
          `Invalid pricing value for ${field}: ${value}`,
          `pricing.${field}`
        );
      }
    }

    // Validate optional queryPerResult
    if ('queryPerResult' in pricingConfig && pricingConfig.queryPerResult !== undefined) {
      const value = pricingConfig.queryPerResult;
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new AgentConfigurationError(
          'pricing.queryPerResult must be a string or number',
          'pricing.queryPerResult'
        );
      }

      try {
        const parsed = this.parseBigintValue(String(value));
        if (parsed < 0n) {
          throw new AgentConfigurationError(
            'pricing.queryPerResult must be non-negative',
            'pricing.queryPerResult'
          );
        }
      } catch (error) {
        if (error instanceof AgentConfigurationError) {
          throw error;
        }
        throw new AgentConfigurationError(
          `Invalid pricing value for queryPerResult: ${value}`,
          'pricing.queryPerResult'
        );
      }
    }
  }

  /**
   * Validate Follows Configuration (AC: 4)
   */
  private static validateFollowsConfig(follows: unknown): void {
    if (!Array.isArray(follows)) {
      throw new AgentConfigurationError('follows must be an array', 'follows');
    }

    for (let i = 0; i < follows.length; i++) {
      const follow = follows[i];
      if (!follow || typeof follow !== 'object') {
        throw new AgentConfigurationError(`follows[${i}] must be an object`, `follows[${i}]`);
      }

      const followConfig = follow as Record<string, unknown>;

      // Validate pubkey
      if (!('pubkey' in followConfig) || !followConfig.pubkey) {
        throw new AgentConfigurationError(
          `follows[${i}].pubkey is required`,
          `follows[${i}].pubkey`
        );
      }
      if (typeof followConfig.pubkey !== 'string') {
        throw new AgentConfigurationError(
          `follows[${i}].pubkey must be a string`,
          `follows[${i}].pubkey`
        );
      }
      if (!/^[0-9a-fA-F]{64}$/.test(followConfig.pubkey as string)) {
        throw new AgentConfigurationError(
          `follows[${i}].pubkey must be a 64-character hex string`,
          `follows[${i}].pubkey`
        );
      }

      // Validate ilpAddress
      if (!('ilpAddress' in followConfig) || !followConfig.ilpAddress) {
        throw new AgentConfigurationError(
          `follows[${i}].ilpAddress is required`,
          `follows[${i}].ilpAddress`
        );
      }
      if (typeof followConfig.ilpAddress !== 'string') {
        throw new AgentConfigurationError(
          `follows[${i}].ilpAddress must be a string`,
          `follows[${i}].ilpAddress`
        );
      }
      // Use RFC-0015 validation
      if (!isValidILPAddress(followConfig.ilpAddress as string)) {
        throw new AgentConfigurationError(
          `follows[${i}].ilpAddress is not a valid ILP address: ${followConfig.ilpAddress}`,
          `follows[${i}].ilpAddress`
        );
      }

      // Validate optional petname
      if ('petname' in followConfig && followConfig.petname !== undefined) {
        if (typeof followConfig.petname !== 'string') {
          throw new AgentConfigurationError(
            `follows[${i}].petname must be a string`,
            `follows[${i}].petname`
          );
        }
      }
    }
  }

  /**
   * Validate Handlers Configuration (AC: 5)
   */
  private static validateHandlersConfig(handlers: unknown): void {
    if (typeof handlers !== 'object' || handlers === null) {
      throw new AgentConfigurationError('handlers must be an object', 'handlers');
    }

    const handlersConfig = handlers as Record<string, unknown>;
    const validKeys = [
      'enableNoteHandler',
      'enableFollowHandler',
      'enableDeleteHandler',
      'enableQueryHandler',
    ];

    for (const key of Object.keys(handlersConfig)) {
      if (!validKeys.includes(key)) {
        // Warn but ignore unknown keys (forward compatibility)
        continue;
      }

      const value = handlersConfig[key];
      if (value !== undefined && typeof value !== 'boolean') {
        throw new AgentConfigurationError(`handlers.${key} must be a boolean`, `handlers.${key}`);
      }
    }
  }

  /**
   * Validate Subscriptions Configuration
   */
  private static validateSubscriptionsConfig(subscriptions: unknown): void {
    if (typeof subscriptions !== 'object' || subscriptions === null) {
      throw new AgentConfigurationError('subscriptions must be an object', 'subscriptions');
    }

    const subsConfig = subscriptions as Record<string, unknown>;

    if ('maxPerPeer' in subsConfig && subsConfig.maxPerPeer !== undefined) {
      if (typeof subsConfig.maxPerPeer !== 'number') {
        throw new AgentConfigurationError(
          'subscriptions.maxPerPeer must be a number',
          'subscriptions.maxPerPeer'
        );
      }
      if (subsConfig.maxPerPeer < 0) {
        throw new AgentConfigurationError(
          'subscriptions.maxPerPeer must be non-negative',
          'subscriptions.maxPerPeer'
        );
      }
    }
  }

  /**
   * Validate AI Configuration
   */
  private static validateAIConfig(ai: unknown): void {
    if (typeof ai !== 'object' || ai === null) {
      throw new AgentConfigurationError('ai must be an object', 'ai');
    }

    const aiConfig = ai as Record<string, unknown>;

    // Validate enabled (boolean)
    if ('enabled' in aiConfig && aiConfig.enabled !== undefined) {
      if (typeof aiConfig.enabled !== 'boolean') {
        throw new AgentConfigurationError('ai.enabled must be a boolean', 'ai.enabled');
      }
    }

    // Validate model (string, provider:model format)
    if ('model' in aiConfig && aiConfig.model !== undefined) {
      if (typeof aiConfig.model !== 'string') {
        throw new AgentConfigurationError('ai.model must be a string', 'ai.model');
      }
      const parts = (aiConfig.model as string).split(':');
      if (parts.length < 2 || (parts[0]?.length ?? 0) === 0 || (parts[1]?.length ?? 0) === 0) {
        throw new AgentConfigurationError(
          'ai.model must be in "provider:model" format (e.g., "anthropic:claude-haiku-4-5")',
          'ai.model'
        );
      }
    }

    // Validate apiKey (string)
    if ('apiKey' in aiConfig && aiConfig.apiKey !== undefined) {
      if (typeof aiConfig.apiKey !== 'string') {
        throw new AgentConfigurationError('ai.apiKey must be a string', 'ai.apiKey');
      }
    }

    // Validate maxTokensPerRequest (positive number)
    if ('maxTokensPerRequest' in aiConfig && aiConfig.maxTokensPerRequest !== undefined) {
      if (typeof aiConfig.maxTokensPerRequest !== 'number' || aiConfig.maxTokensPerRequest <= 0) {
        throw new AgentConfigurationError(
          'ai.maxTokensPerRequest must be a positive number',
          'ai.maxTokensPerRequest'
        );
      }
    }

    // Validate budget sub-object
    if ('budget' in aiConfig && aiConfig.budget !== undefined) {
      if (typeof aiConfig.budget !== 'object' || aiConfig.budget === null) {
        throw new AgentConfigurationError('ai.budget must be an object', 'ai.budget');
      }
      const budget = aiConfig.budget as Record<string, unknown>;

      if ('maxTokensPerHour' in budget && budget.maxTokensPerHour !== undefined) {
        if (typeof budget.maxTokensPerHour !== 'number' || budget.maxTokensPerHour <= 0) {
          throw new AgentConfigurationError(
            'ai.budget.maxTokensPerHour must be a positive number',
            'ai.budget.maxTokensPerHour'
          );
        }
      }

      if ('fallbackOnExhaustion' in budget && budget.fallbackOnExhaustion !== undefined) {
        if (typeof budget.fallbackOnExhaustion !== 'boolean') {
          throw new AgentConfigurationError(
            'ai.budget.fallbackOnExhaustion must be a boolean',
            'ai.budget.fallbackOnExhaustion'
          );
        }
      }
    }

    // Validate personality sub-object
    if ('personality' in aiConfig && aiConfig.personality !== undefined) {
      if (typeof aiConfig.personality !== 'object' || aiConfig.personality === null) {
        throw new AgentConfigurationError('ai.personality must be an object', 'ai.personality');
      }
      const personality = aiConfig.personality as Record<string, unknown>;
      for (const key of ['name', 'role', 'instructions']) {
        if (key in personality && personality[key] !== undefined) {
          if (typeof personality[key] !== 'string') {
            throw new AgentConfigurationError(
              `ai.personality.${key} must be a string`,
              `ai.personality.${key}`
            );
          }
        }
      }
    }
  }

  /**
   * Load Private Key from File (Task 4)
   *
   * Reads a key file from disk and extracts the private key.
   * Supports multiple formats:
   * - Raw hex (64 characters)
   * - nsec (Nostr secret key bech32 format)
   * - Encrypted file (AES-256-GCM)
   *
   * @param filePath - Path to key file
   * @param password - Optional password for encrypted files
   * @returns Private key as 64-character hex string
   * @throws AgentConfigurationError if file not found or invalid format
   */
  static loadPrivateKeyFromFile(filePath: string, password?: string): string {
    // Read file content
    let fileContent: string;
    try {
      fileContent = fs.readFileSync(filePath, 'utf8').trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AgentConfigurationError(`Key file not found: ${filePath}`, 'agent.keyFilePath');
      }
      if ((error as NodeJS.ErrnoException).code === 'EACCES') {
        throw new AgentConfigurationError(
          `Permission denied reading key file: ${filePath}. Check file permissions.`,
          'agent.keyFilePath'
        );
      }
      throw new AgentConfigurationError(
        `Failed to read key file: ${(error as Error).message}`,
        'agent.keyFilePath'
      );
    }

    // Check file permissions (warn if world-readable)
    try {
      const stats = fs.statSync(filePath);
      const mode = stats.mode;
      // Check if world-readable (others have read permission)
      if ((mode & 0o004) !== 0) {
        // In production, this would be a logger.warn
        // For now, we continue but this is a security concern
      }
    } catch {
      // Ignore permission check errors
    }

    // Detect format and parse
    if (/^[0-9a-fA-F]{64}$/.test(fileContent)) {
      // Raw hex format
      return fileContent.toLowerCase();
    }

    if (fileContent.startsWith('nsec1')) {
      // nsec bech32 format
      try {
        const decoded = nip19.decode(fileContent);
        if (decoded.type !== 'nsec') {
          throw new AgentConfigurationError('Invalid nsec format in key file', 'agent.keyFilePath');
        }
        // Convert Uint8Array to hex string
        return Buffer.from(decoded.data as Uint8Array).toString('hex');
      } catch (error) {
        if (error instanceof AgentConfigurationError) {
          throw error;
        }
        throw new AgentConfigurationError(
          `Failed to decode nsec key: ${(error as Error).message}`,
          'agent.keyFilePath'
        );
      }
    }

    // Try encrypted format (base64 encoded AES-256-GCM)
    if (this.isBase64(fileContent)) {
      if (!password) {
        throw new AgentConfigurationError(
          'Key file appears to be encrypted but no password provided. Set AGENT_KEY_PASSWORD environment variable.',
          'agent.keyFilePath'
        );
      }

      return this.decryptKeyFile(fileContent, password);
    }

    throw new AgentConfigurationError(
      'Invalid key file format. Expected 64-char hex, nsec, or encrypted format.',
      'agent.keyFilePath'
    );
  }

  /**
   * Check if a string is valid base64
   */
  private static isBase64(str: string): boolean {
    if (str.length < 32) return false; // Too short for encrypted format
    try {
      const decoded = Buffer.from(str, 'base64');
      return decoded.toString('base64') === str;
    } catch {
      return false;
    }
  }

  /**
   * Decrypt an encrypted key file
   *
   * Format: IV (16 bytes) + AuthTag (16 bytes) + Encrypted Key
   */
  private static decryptKeyFile(encryptedBase64: string, password: string): string {
    try {
      const encryptedData = Buffer.from(encryptedBase64, 'base64');

      // Minimum size: IV + AuthTag + at least 64 bytes encrypted
      if (encryptedData.length < IV_LENGTH + AUTH_TAG_LENGTH + 32) {
        throw new AgentConfigurationError('Encrypted key file is too small', 'agent.keyFilePath');
      }

      // Extract IV, AuthTag, and encrypted content
      const iv = encryptedData.subarray(0, IV_LENGTH);
      const authTag = encryptedData.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
      const encrypted = encryptedData.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

      // Derive key from password using PBKDF2
      // Use first 16 bytes of encrypted data as salt (stored with file)
      const salt = encrypted.subarray(0, 16);
      const actualEncrypted = encrypted.subarray(16);
      const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');

      // Create decipher
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);

      // Decrypt
      let decrypted: Buffer;
      try {
        decrypted = decipher.update(actualEncrypted);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
      } catch {
        throw new AgentConfigurationError(
          'Failed to decrypt key file: invalid password or corrupted data',
          'agent.keyFilePath'
        );
      }

      const privateKey = decrypted.toString('utf8').trim();

      // Validate decrypted key format
      if (!/^[0-9a-fA-F]{64}$/.test(privateKey)) {
        throw new AgentConfigurationError(
          'Decrypted key is not a valid 64-character hex string',
          'agent.keyFilePath'
        );
      }

      return privateKey.toLowerCase();
    } catch (error) {
      if (error instanceof AgentConfigurationError) {
        throw error;
      }
      throw new AgentConfigurationError(
        `Failed to decrypt key file: ${(error as Error).message}`,
        'agent.keyFilePath'
      );
    }
  }

  /**
   * Parse Pricing Configuration to Bigint (Task 5)
   *
   * Converts string pricing values to bigint.
   *
   * @param pricing - Pricing configuration with string values
   * @returns Parsed pricing with bigint values
   * @throws AgentConfigurationError if parsing fails
   */
  static parsePricing(pricing: AgentPricingConfig): ParsedPricing {
    try {
      const result: ParsedPricing = {
        noteStorage: this.parseBigintValue(pricing.noteStorage),
        followUpdate: this.parseBigintValue(pricing.followUpdate),
        deletion: this.parseBigintValue(pricing.deletion),
        queryBase: this.parseBigintValue(pricing.queryBase),
      };

      if (pricing.queryPerResult !== undefined) {
        result.queryPerResult = this.parseBigintValue(pricing.queryPerResult);
      }

      return result;
    } catch (error) {
      if (error instanceof AgentConfigurationError) {
        throw error;
      }
      throw new AgentConfigurationError(
        `Failed to parse pricing: ${(error as Error).message}`,
        'pricing'
      );
    }
  }

  /**
   * Parse a string value to bigint, supporting scientific notation.
   */
  private static parseBigintValue(value: string): bigint {
    const trimmed = value.trim();

    // Handle scientific notation (e.g., "1e6")
    if (/^[\d.]+e\d+$/i.test(trimmed)) {
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num < 0) {
        throw new AgentConfigurationError(`Invalid numeric value: ${value}`);
      }
      return BigInt(Math.floor(num));
    }

    // Handle regular numeric strings
    if (/^-?\d+$/.test(trimmed)) {
      return BigInt(trimmed);
    }

    throw new AgentConfigurationError(`Cannot parse as bigint: ${value}`);
  }

  /**
   * Convert YAML Config to AgentNodeConfig (Task 6)
   *
   * Maps the YAML configuration to the AgentNodeConfig interface
   * expected by AgentNode constructor.
   *
   * @param yamlConfig - Validated YAML configuration
   * @param password - Optional password for encrypted key files
   * @returns AgentNodeConfig ready for AgentNode constructor
   * @throws AgentConfigurationError if conversion fails
   */
  static toAgentNodeConfig(yamlConfig: AgentYamlConfig, password?: string): AgentNodeConfig {
    // Get private key
    let privateKey: string;
    if (yamlConfig.agent.privateKey) {
      privateKey = yamlConfig.agent.privateKey.toLowerCase();
    } else if (yamlConfig.agent.keyFilePath) {
      // Check for password from environment
      const keyPassword = password || process.env.AGENT_KEY_PASSWORD;
      privateKey = this.loadPrivateKeyFromFile(yamlConfig.agent.keyFilePath, keyPassword);
    } else {
      throw new AgentConfigurationError('No private key available', 'agent');
    }

    // Derive public key if not provided
    let publicKey: string;
    if (yamlConfig.agent.publicKey) {
      publicKey = yamlConfig.agent.publicKey.toLowerCase();
    } else {
      try {
        // nostr-tools getPublicKey expects Uint8Array
        const privKeyBytes = Buffer.from(privateKey, 'hex');
        publicKey = getPublicKey(privKeyBytes);
      } catch (error) {
        throw new AgentConfigurationError(
          `Failed to derive public key: ${(error as Error).message}`,
          'agent.privateKey'
        );
      }
    }

    // Parse pricing
    const pricing = this.parsePricing(yamlConfig.pricing);

    // Determine enableBuiltInHandlers
    // enableBuiltInHandlers = true if ANY handler is enabled (default)
    // enableBuiltInHandlers = false only if ALL handlers explicitly set to false
    let enableBuiltInHandlers = true;
    if (yamlConfig.handlers) {
      const h = yamlConfig.handlers;
      const allDisabled =
        h.enableNoteHandler === false &&
        h.enableFollowHandler === false &&
        h.enableDeleteHandler === false &&
        h.enableQueryHandler === false;
      enableBuiltInHandlers = !allDisabled;
    }

    return {
      agentPubkey: publicKey,
      agentPrivkey: privateKey,
      databasePath: yamlConfig.database.path,
      databaseMaxSize: yamlConfig.database.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES,
      pricing: {
        noteStorage: pricing.noteStorage,
        followUpdate: pricing.followUpdate,
        deletion: pricing.deletion,
        queryBase: pricing.queryBase,
        queryPerResult: pricing.queryPerResult,
      },
      enableBuiltInHandlers,
      maxSubscriptionsPerPeer:
        yamlConfig.subscriptions?.maxPerPeer ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_PEER,
      ai: parseAIConfig(yamlConfig.ai),
    };
  }

  /**
   * Load Static Follows into FollowGraphRouter (Task 7)
   *
   * Loads follows from YAML configuration into the FollowGraphRouter.
   *
   * @param follows - Array of follow configurations from YAML
   * @param router - FollowGraphRouter instance
   * @param logger - Optional logger for debug output
   */
  static loadFollowsToRouter(
    follows: AgentFollowConfig[] | undefined,
    router: FollowGraphRouter,
    logger?: Logger
  ): void {
    if (!follows || follows.length === 0) {
      return;
    }

    for (const follow of follows) {
      try {
        router.addFollow({
          pubkey: follow.pubkey,
          ilpAddress: follow.ilpAddress,
          petname: follow.petname,
        });
        logger?.info(
          { pubkey: follow.pubkey, ilpAddress: follow.ilpAddress },
          'Loaded static follow from config'
        );
      } catch (error) {
        logger?.warn(
          { pubkey: follow.pubkey, error: (error as Error).message },
          'Failed to add static follow'
        );
      }
    }
  }

  /**
   * Get granular handler configuration from YAML config.
   *
   * @param yamlConfig - Validated YAML configuration
   * @returns Handler enable/disable flags
   */
  static getHandlerConfig(yamlConfig: AgentYamlConfig): AgentHandlersConfig {
    return {
      enableNoteHandler: yamlConfig.handlers?.enableNoteHandler ?? true,
      enableFollowHandler: yamlConfig.handlers?.enableFollowHandler ?? true,
      enableDeleteHandler: yamlConfig.handlers?.enableDeleteHandler ?? true,
      enableQueryHandler: yamlConfig.handlers?.enableQueryHandler ?? true,
    };
  }
}
