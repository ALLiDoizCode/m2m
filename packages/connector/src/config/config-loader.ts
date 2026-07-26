/**
 * Configuration Loader Module
 *
 * Provides functionality to load and validate ILP connector configuration
 * from YAML files. Includes comprehensive validation of all configuration
 * fields including peer definitions, route definitions, and port ranges.
 *
 * @packageDocumentation
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import {
  ConnectorConfig,
  PeerConfig,
  RouteConfig,
  BlockchainConfig,
  EVMChainConfig,
  Environment,
  SettlementConfig,
  SecurityConfig,
  AdminApiConfig,
  LocalDeliveryConfig,
  ChainProviderConfigEntry,
  TransportConfig,
  SelfAnnounceConfig,
  RouteLearningConfig,
  ChildConfig,
  BootstrapConfig,
  BootstrapSeedEntry,
  PeeringPolicyConfig,
} from './types';
import { validateRouteTermination } from './types';
import { validateEnvironment } from './environment-validator';
import { isValidILPAddress } from '@toon-protocol/shared';
import { isValidNonNegativeIntegerString } from '../settlement/types';
import { normalizeCapabilityName } from '../discovery/ilp-peer-info-event';
import { ChildConfigError, expandChildren } from './child-expander';
import { deriveLocalPrefixes, validateRelationRoute } from '../routing/relation-route-validator';

/**
 * Custom Error Class for Configuration Errors
 *
 * Thrown when configuration validation fails during loading.
 * Provides descriptive error messages indicating the specific
 * validation failure to help operators fix configuration issues.
 *
 * @example
 * ```typescript
 * throw new ConfigurationError('Missing required field: nodeId');
 * ```
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ConfigurationError);
    }
  }
}

/**
 * Error thrown when sendPacket() is called before the connector has been started.
 */
export class ConnectorNotStartedError extends Error {
  constructor(message: string = 'Connector is not started. Call start() before sendPacket().') {
    super(message);
    this.name = 'ConnectorNotStartedError';
  }
}

/**
 * Error thrown when `SendPacketParams.executionCondition` is malformed:
 * not valid base64, not exactly 32 bytes after decode, or all-zero
 * (all-zero is the wire encoding for "no condition" — omit the field instead).
 * Thrown synchronously by `ConnectorNode.sendPacket()` before any packet is sent.
 */
export class InvalidExecutionConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidExecutionConditionError';
  }
}

/**
 * Configuration Loader Class
 *
 * Static class providing methods to load and validate connector
 * configuration from YAML files. Performs comprehensive validation
 * including field presence, type checking, URL format validation,
 * peer reference validation, and port range validation.
 *
 * @example
 * ```typescript
 * try {
 *   const config = ConfigLoader.loadConfig('./config.yaml');
 *   console.log(`Loaded config for node: ${config.nodeId}`);
 * } catch (error) {
 *   if (error instanceof ConfigurationError) {
 *     console.error(`Configuration error: ${error.message}`);
 *     process.exit(1);
 *   }
 * }
 * ```
 */
export class ConfigLoader {
  /**
   * Load and Validate Configuration from YAML File
   *
   * Reads a YAML configuration file from disk, parses it, and validates
   * all fields according to the connector configuration schema.
   * Throws ConfigurationError if validation fails.
   *
   * @param filePath - Absolute or relative path to YAML configuration file
   * @returns Validated ConnectorConfig object
   * @throws ConfigurationError if file not found, YAML invalid, or validation fails
   *
   * @example
   * ```typescript
   * const config = ConfigLoader.loadConfig('./examples/linear-3-nodes-a.yaml');
   * ```
   */
  static loadConfig(filePath: string): ConnectorConfig {
    // Step 1: Read file from disk
    let fileContent: string;
    try {
      fileContent = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ConfigurationError(`Configuration file not found: ${filePath}`);
      }
      throw new ConfigurationError(
        `Failed to read configuration file: ${(error as Error).message}`
      );
    }

    // Step 2: Parse YAML
    let config: unknown;
    try {
      config = yaml.load(fileContent);
    } catch (error) {
      throw new ConfigurationError(`Invalid YAML syntax: ${(error as Error).message}`);
    }

    // Ensure we have an object
    if (!config || typeof config !== 'object') {
      throw new ConfigurationError('Configuration must be a YAML object');
    }

    // Step 3: Validate and assemble configuration
    return this.validateConfig(config);
  }

  /**
   * Validate and Normalize Configuration Object
   *
   * Validates an untrusted configuration object and returns a normalized
   * `ConnectorConfig`. This method performs all field validation, applies
   * defaults, and loads environment-derived fields (environment, blockchain)
   * from process environment variables.
   *
   * **Environment field handling:** The `environment` and `blockchain`
   * fields are always derived from process environment variables
   * (`ENVIRONMENT`, `BASE_ENABLED`), regardless
   * of whether the input object includes them. Any values provided for these
   * fields in the input are silently overridden.
   *
   * @param raw - Untrusted configuration input to validate
   * @returns Validated and normalized ConnectorConfig object
   * @throws ConfigurationError if validation fails
   *
   * @example
   * ```typescript
   * const config = ConfigLoader.validateConfig({
   *   nodeId: 'my-connector',
   *   btpServerPort: 3000,
   *   peers: [{ id: 'peer1', url: 'ws://peer1:3001', authToken: 'secret' }],
   *   routes: [{ prefix: 'g.peer1', nextHop: 'peer1' }],
   * });
   * ```
   */
  static validateConfig(raw: unknown): ConnectorConfig {
    // Ensure we have an object
    if (!raw || typeof raw !== 'object') {
      throw new ConfigurationError('Configuration must be a YAML object');
    }

    const rawConfig = raw as Record<string, unknown>;

    // Migration guard: reject removed settlementInfra config
    if ('settlementInfra' in rawConfig) {
      throw new ConfigurationError(
        '"settlementInfra" has been removed. Use "chainProviders" with an EVM entry instead. ' +
          'Configure chainProviders with chainType "evm", rpcUrl, registryAddress, keyId, and tokenAddress.'
      );
    }

    // Load environment from environment variable (default: 'development')
    const environment = this.loadEnvironment();

    // Validate required fields and structure.
    this.validateRequiredFields(rawConfig);
    const transport = this.validateTransport(rawConfig.transport);
    const bootstrap = this.validateBootstrap(rawConfig.bootstrap);
    this.validatePeers(rawConfig.peers as PeerConfig[]);
    this.validateRoutes(rawConfig.routes as RouteConfig[], rawConfig.peers as PeerConfig[]);
    this.validatePorts(rawConfig);

    // Expand `children` bindings into routes under the apex (toon-meta#153).
    // Runs BEFORE the ConnectorNode builds its RoutingTable and
    // RouteTerminationRegistry from `routes`, so the packet path is identical
    // for internal (`upstream`) and external (`peerId`) children.
    const apex = this.validateApex(rawConfig.apex);
    const children = this.validateChildrenShape(rawConfig.children);
    const nodeId = rawConfig.nodeId as string;
    const peers = rawConfig.peers as PeerConfig[];
    let routes = rawConfig.routes as RouteConfig[];
    if (children && children.length > 0) {
      let expandedRoutes: RouteConfig[];
      try {
        expandedRoutes = expandChildren(children, apex, routes, peers, nodeId);
      } catch (error) {
        if (error instanceof ChildConfigError) {
          throw new ConfigurationError(`Invalid children config: ${error.message}`);
        }
        throw error;
      }
      // Expanded routes go through the same route validation as hand-written
      // ones (prefix format + termination shape).
      this.validateRoutes(expandedRoutes, peers);
      routes = [...routes, ...expandedRoutes];
    }

    // Relation ↔ route enforcement at config load (toon-meta#153): every route
    // whose nextHop is a peer with a declared relation must be consistent with
    // that relation's topology (child ⇒ strict descendant of a self-prefix or
    // the apex; parent ⇒ not under the self subtree).
    this.enforceRelationRoutes(routes, peers, nodeId, apex);

    // Load blockchain configuration from environment variables
    const blockchain = this.loadBlockchainConfig(environment);

    const btpServerPort = rawConfig.btpServerPort as number;
    const healthCheckPort = (rawConfig.healthCheckPort as number | undefined) ?? 8080;

    // Apply default values for optional fields and pass through all optional config
    const connectorConfig: ConnectorConfig = {
      nodeId,
      btpServerPort,
      healthCheckPort,
      logLevel: (rawConfig.logLevel as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info',
      peers,
      routes,
      ...(apex !== undefined ? { apex } : {}),
      ...(children !== undefined ? { children } : {}),
      environment,
      blockchain,
      // Pass through optional fields from input object
      settlement: rawConfig.settlement as SettlementConfig | undefined,
      security: rawConfig.security as SecurityConfig | undefined,
      adminApi: rawConfig.adminApi as AdminApiConfig | undefined,
      localDelivery: rawConfig.localDelivery as LocalDeliveryConfig | undefined,
      mode: rawConfig.mode as 'connector' | 'gateway' | undefined,
      firstHopUrl: rawConfig.firstHopUrl as string | undefined,
      btpAuthToken: rawConfig.btpAuthToken as string | undefined,
      chainProviders: rawConfig.chainProviders as ChainProviderConfigEntry[] | undefined,
      deploymentMode: rawConfig.deploymentMode as 'embedded' | 'standalone' | undefined,
      nip59: rawConfig.nip59 as { enabled: boolean } | undefined,
      // relay#37 / store#22: opt-in kind:10032 self-announce. Passed through
      // unchanged apart from the explicit `capabilities` list, which is
      // validated here (toon-meta#153); the SelfAnnounceService validates the
      // remaining required fields at start.
      selfAnnounce: this.validateSelfAnnounce(rawConfig.selfAnnounce),
      // toon-meta#153: opt-in multi-hop route learning (validated shape).
      routeLearning: this.validateRouteLearning(rawConfig.routeLearning),
      // toon-meta#153: opt-in cold-start bootstrap. Validated above (URL
      // schemes, hex pubkeys, positive integers); absent → disabled.
      bootstrap,
      // toon-meta#153 (discovered-vs-peered): bounded funded-peering policy.
      peeringPolicy: this.validatePeeringPolicy(rawConfig.peeringPolicy),
      transport,
    };

    // Validate environment configuration
    validateEnvironment(connectorConfig);

    return connectorConfig;
  }

  /**
   * Validate the optional `selfAnnounce` block's explicit `capabilities`
   * directory entries (toon-meta#153). The rest of the block is passed
   * through unchanged — the SelfAnnounceService validates its required
   * fields at start (relay#37 / store#22 behavior, unchanged).
   *
   * Each entry must be an object with:
   * - `capability`: a string satisfying the capability name grammar
   *   (alphanumeric start, then alphanumerics / `.` / `_` / `-`);
   * - `address`: a valid ILP address;
   * - `price` (optional): a non-negative decimal string (atomic units);
   * - `schema` (optional): a non-empty string.
   *
   * @param raw - The untrusted `selfAnnounce` value from the config input.
   * @returns The block (capabilities validated), or `undefined` when absent.
   * @throws ConfigurationError on any malformed capabilities entry.
   * @private
   */
  private static validateSelfAnnounce(raw: unknown): SelfAnnounceConfig | undefined {
    if (raw === undefined || raw === null) {
      return undefined;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ConfigurationError('selfAnnounce must be an object');
    }
    const block = raw as Record<string, unknown>;

    if (block.capabilities !== undefined) {
      if (!Array.isArray(block.capabilities)) {
        throw new ConfigurationError('selfAnnounce.capabilities must be an array');
      }
      for (const entry of block.capabilities) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new ConfigurationError('selfAnnounce.capabilities entries must be objects');
        }
        const { capability, address, price, schema } = entry as Record<string, unknown>;
        if (typeof capability !== 'string' || normalizeCapabilityName(capability) === null) {
          throw new ConfigurationError(
            `selfAnnounce.capabilities: capability must be a name like 'os.put' ` +
              `(alphanumeric start, then alphanumerics/'.'/'_'/'-'), got ${String(capability)}`
          );
        }
        if (typeof address !== 'string' || !isValidILPAddress(address)) {
          throw new ConfigurationError(
            `selfAnnounce.capabilities['${capability}']: address must be a valid ILP address, ` +
              `got ${String(address)}`
          );
        }
        if (
          price !== undefined &&
          (typeof price !== 'string' || !isValidNonNegativeIntegerString(price))
        ) {
          throw new ConfigurationError(
            `selfAnnounce.capabilities['${capability}']: price must be a non-negative decimal ` +
              `string (atomic units), got ${String(price)}`
          );
        }
        if (schema !== undefined && (typeof schema !== 'string' || schema.length === 0)) {
          throw new ConfigurationError(
            `selfAnnounce.capabilities['${capability}']: schema must be a non-empty string, ` +
              `got ${String(schema)}`
          );
        }
      }
    }

    return raw as SelfAnnounceConfig;
  }

  /**
   * Validate the optional `peeringPolicy` block (toon-meta#153,
   * discovered-vs-peered split).
   *
   * `maxFundedChannels` must be a positive integer when present.
   * `autoRegister` must be a boolean, and `true` is REJECTED for v0: funding
   * a settlement channel stays a deliberate operator action; auto-funding
   * policy is future work.
   *
   * @param raw - The untrusted `peeringPolicy` value from the config input.
   * @returns The validated block, or `undefined` when absent.
   * @throws ConfigurationError on any malformed field or `autoRegister: true`.
   * @private
   */
  private static validatePeeringPolicy(raw: unknown): PeeringPolicyConfig | undefined {
    if (raw === undefined || raw === null) {
      return undefined;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ConfigurationError('peeringPolicy must be an object');
    }
    const block = raw as Record<string, unknown>;

    if (block.maxFundedChannels !== undefined) {
      if (
        typeof block.maxFundedChannels !== 'number' ||
        !Number.isInteger(block.maxFundedChannels) ||
        block.maxFundedChannels <= 0
      ) {
        throw new ConfigurationError('peeringPolicy.maxFundedChannels must be a positive integer');
      }
    }

    if (block.autoRegister !== undefined) {
      if (typeof block.autoRegister !== 'boolean') {
        throw new ConfigurationError('peeringPolicy.autoRegister must be a boolean');
      }
      if (block.autoRegister === true) {
        throw new ConfigurationError(
          'peeringPolicy.autoRegister: true is not yet supported — funding a settlement ' +
            'channel is a deliberate operator action (review GET /admin/discovered-nodes ' +
            'and promote via POST /admin/peers)'
        );
      }
    }

    return {
      ...(block.maxFundedChannels !== undefined
        ? { maxFundedChannels: block.maxFundedChannels as number }
        : {}),
      ...(block.autoRegister !== undefined ? { autoRegister: block.autoRegister as boolean } : {}),
    };
  }

  /**
   * Validate the optional `routeLearning` block (toon-meta#153).
   *
   * @param raw - The untrusted `routeLearning` value from the config input.
   * @returns The validated block, or `undefined` when absent.
   * @throws ConfigurationError on any malformed field.
   * @private
   */
  private static validateRouteLearning(raw: unknown): RouteLearningConfig | undefined {
    if (raw === undefined || raw === null) {
      return undefined;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ConfigurationError('routeLearning must be an object');
    }
    const block = raw as Record<string, unknown>;

    if (typeof block.enabled !== 'boolean') {
      throw new ConfigurationError('routeLearning.enabled must be a boolean');
    }

    if (block.relayUrls !== undefined) {
      if (!Array.isArray(block.relayUrls)) {
        throw new ConfigurationError(
          'routeLearning.relayUrls must be an array of ws:// or wss:// URLs'
        );
      }
      for (const url of block.relayUrls) {
        if (typeof url !== 'string' || !/^wss?:\/\/.+/.test(url)) {
          throw new ConfigurationError(
            `routeLearning.relayUrls entries must be ws:// or wss:// URLs, got: ${String(url)}`
          );
        }
      }
    }

    if (block.refreshIntervalSecs !== undefined) {
      if (
        typeof block.refreshIntervalSecs !== 'number' ||
        !Number.isFinite(block.refreshIntervalSecs) ||
        block.refreshIntervalSecs <= 0
      ) {
        throw new ConfigurationError('routeLearning.refreshIntervalSecs must be a positive number');
      }
    }

    if (block.maxRoutes !== undefined) {
      if (
        typeof block.maxRoutes !== 'number' ||
        !Number.isInteger(block.maxRoutes) ||
        block.maxRoutes <= 0
      ) {
        throw new ConfigurationError('routeLearning.maxRoutes must be a positive integer');
      }
    }

    return {
      enabled: block.enabled,
      ...(block.relayUrls !== undefined ? { relayUrls: block.relayUrls as string[] } : {}),
      ...(block.refreshIntervalSecs !== undefined
        ? { refreshIntervalSecs: block.refreshIntervalSecs as number }
        : {}),
      ...(block.maxRoutes !== undefined ? { maxRoutes: block.maxRoutes as number } : {}),
    };
  }

  /**
   * Load Environment from Environment Variable
   *
   * Reads ENVIRONMENT variable from process.env and validates it.
   * Defaults to 'development' if not specified.
   *
   * @returns Environment type ('development' | 'staging' | 'production')
   * @throws ConfigurationError if ENVIRONMENT value is invalid
   * @private
   */
  private static loadEnvironment(): Environment {
    const env = process.env.ENVIRONMENT || 'development';
    const validEnvironments: Environment[] = ['development', 'staging', 'production'];

    if (!validEnvironments.includes(env as Environment)) {
      throw new ConfigurationError(
        `Invalid ENVIRONMENT: must be one of ${validEnvironments.join(', ')}, got ${env}`
      );
    }

    return env as Environment;
  }

  /**
   * Load Blockchain Configuration from Environment Variables
   *
   * Loads EVM chain configurations (Base, Arbitrum) from environment variables
   * with environment-specific defaults. Returns undefined if no chains are enabled.
   *
   * @param environment - Deployment environment (development/staging/production)
   * @returns BlockchainConfig with enabled chain configurations (or undefined if none enabled)
   * @private
   */
  private static loadBlockchainConfig(environment: Environment): BlockchainConfig | undefined {
    const baseEnabled = process.env.BASE_ENABLED === 'true';
    const arbitrumEnabled = process.env.ARBITRUM_ENABLED === 'true';

    // If no chains are enabled, return undefined
    if (!baseEnabled && !arbitrumEnabled) {
      return undefined;
    }

    const blockchain: BlockchainConfig = {};

    // Load Base L2 configuration if enabled
    if (baseEnabled) {
      blockchain.base = this.loadBaseBlockchainConfig(environment);
    }

    // Load Arbitrum configuration if enabled
    if (arbitrumEnabled) {
      blockchain.arbitrum = this.loadArbitrumBlockchainConfig(environment);
    }

    return blockchain;
  }

  /**
   * Load Base L2 Blockchain Configuration
   *
   * Loads Base L2 configuration from environment variables with environment-specific defaults.
   *
   * Environment variables:
   * - BASE_ENABLED (required): 'true' to enable Base blockchain
   * - BASE_RPC_URL (optional): RPC endpoint URL (defaults by environment)
   * - BASE_CHAIN_ID (optional): Expected chain ID (defaults by environment)
   * - BASE_PRIVATE_KEY (optional): Private key for contract interactions
   * - BASE_REGISTRY_ADDRESS (optional): Payment channel registry contract address
   * - BASE_TOKEN_ADDRESS (optional): ERC-20 token contract address for Base
   *
   * Environment-specific defaults:
   * - development: rpcUrl=http://anvil:8545, chainId=84532
   * - staging: rpcUrl=https://sepolia.base.org, chainId=84532
   * - production: rpcUrl=https://mainnet.base.org, chainId=8453
   *
   * @param environment - Deployment environment
   * @returns EVMChainConfig with environment-specific defaults applied
   * @private
   */
  private static loadBaseBlockchainConfig(environment: Environment): EVMChainConfig {
    // Environment-specific defaults
    const defaults = {
      development: {
        rpcUrl: 'http://anvil:8545',
        chainId: 84532, // Base Sepolia (forked by Anvil)
      },
      staging: {
        rpcUrl: 'https://sepolia.base.org',
        chainId: 84532, // Base Sepolia testnet
      },
      production: {
        rpcUrl: 'https://mainnet.base.org',
        chainId: 8453, // Base mainnet
      },
    };

    const envDefaults = defaults[environment];

    return {
      enabled: true,
      rpcUrl: process.env.BASE_RPC_URL || envDefaults.rpcUrl,
      chainId: process.env.BASE_CHAIN_ID
        ? parseInt(process.env.BASE_CHAIN_ID, 10)
        : envDefaults.chainId,
      privateKey: process.env.BASE_PRIVATE_KEY,
      registryAddress: process.env.BASE_REGISTRY_ADDRESS,
      tokenAddress: process.env.BASE_TOKEN_ADDRESS,
    };
  }

  /**
   * Load Arbitrum Blockchain Configuration
   *
   * Loads Arbitrum configuration from environment variables with environment-specific defaults.
   *
   * Environment variables:
   * - ARBITRUM_ENABLED (required): 'true' to enable Arbitrum blockchain
   * - ARBITRUM_RPC_URL (optional): RPC endpoint URL (defaults by environment)
   * - ARBITRUM_CHAIN_ID (optional): Expected chain ID (defaults by environment)
   * - ARBITRUM_PRIVATE_KEY (optional): Private key for contract interactions
   * - ARBITRUM_REGISTRY_ADDRESS (optional): Payment channel registry contract address
   * - ARBITRUM_TOKEN_ADDRESS (optional): ERC-20 token contract address for Arbitrum
   *
   * Environment-specific defaults:
   * - development: rpcUrl=http://anvil-arbitrum:8546, chainId=421614
   * - staging: rpcUrl=https://sepolia-rollup.arbitrum.io/rpc, chainId=421614
   * - production: rpcUrl=https://arb1.arbitrum.io/rpc, chainId=42161
   *
   * @param environment - Deployment environment
   * @returns EVMChainConfig with environment-specific defaults applied
   * @private
   */
  private static loadArbitrumBlockchainConfig(environment: Environment): EVMChainConfig {
    // Environment-specific defaults
    const defaults = {
      development: {
        rpcUrl: 'http://anvil-arbitrum:8546',
        chainId: 421614, // Arbitrum Sepolia (forked by Anvil)
      },
      staging: {
        rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
        chainId: 421614, // Arbitrum Sepolia testnet
      },
      production: {
        rpcUrl: 'https://arb1.arbitrum.io/rpc',
        chainId: 42161, // Arbitrum One mainnet
      },
    };

    const envDefaults = defaults[environment];

    return {
      enabled: true,
      rpcUrl: process.env.ARBITRUM_RPC_URL || envDefaults.rpcUrl,
      chainId: process.env.ARBITRUM_CHAIN_ID
        ? parseInt(process.env.ARBITRUM_CHAIN_ID, 10)
        : envDefaults.chainId,
      privateKey: process.env.ARBITRUM_PRIVATE_KEY,
      registryAddress: process.env.ARBITRUM_REGISTRY_ADDRESS,
      tokenAddress: process.env.ARBITRUM_TOKEN_ADDRESS,
    };
  }

  /**
   * Load Explorer Configuration from Environment Variables
   *
  /**
   * Validate Required Fields
   *
   * Checks that all required top-level fields are present and have
   * correct types. Required fields: nodeId, btpServerPort, peers, routes.
   *
   * @param config - Raw configuration object from YAML
   * @throws ConfigurationError if required field missing or wrong type
   * @private
   */
  private static validateRequiredFields(config: Record<string, unknown>): void {
    // Validate nodeId
    if (!('nodeId' in config)) {
      throw new ConfigurationError('Missing required field: nodeId');
    }
    if (typeof config.nodeId !== 'string') {
      throw new ConfigurationError(
        `Invalid type for nodeId: expected string, got ${typeof config.nodeId}`
      );
    }
    if (config.nodeId.trim() === '') {
      throw new ConfigurationError('nodeId cannot be empty');
    }

    // Validate btpServerPort
    if (!('btpServerPort' in config)) {
      throw new ConfigurationError('Missing required field: btpServerPort');
    }
    if (typeof config.btpServerPort !== 'number') {
      throw new ConfigurationError(
        `Invalid type for btpServerPort: expected number, got ${typeof config.btpServerPort}`
      );
    }

    // Validate peers
    if (!('peers' in config)) {
      throw new ConfigurationError('Missing required field: peers');
    }
    if (!Array.isArray(config.peers)) {
      throw new ConfigurationError(
        `Invalid type for peers: expected array, got ${typeof config.peers}`
      );
    }

    // Validate routes
    if (!('routes' in config)) {
      throw new ConfigurationError('Missing required field: routes');
    }
    if (!Array.isArray(config.routes)) {
      throw new ConfigurationError(
        `Invalid type for routes: expected array, got ${typeof config.routes}`
      );
    }

    // Validate optional logLevel if present
    if ('logLevel' in config) {
      const validLogLevels = ['debug', 'info', 'warn', 'error'];
      if (!validLogLevels.includes(config.logLevel as string)) {
        throw new ConfigurationError(
          `Invalid logLevel: must be one of ${validLogLevels.join(', ')}, got ${config.logLevel}`
        );
      }
    }
  }

  /**
   * Validate Peer Definitions
   *
   * Validates each peer has required fields (id, url, authToken),
   * validates WebSocket URL format, and ensures peer IDs are unique.
   *
   * @param peers - Array of peer configurations
   * @throws ConfigurationError if peer validation fails
   * @private
   */
  private static validatePeers(peers: PeerConfig[]): void {
    const peerIds = new Set<string>();

    for (const peer of peers) {
      // Validate peer has required fields
      if (!peer.id) {
        throw new ConfigurationError('Peer missing required field: id');
      }
      if (typeof peer.id !== 'string') {
        throw new ConfigurationError(
          `Invalid type for peer.id: expected string, got ${typeof peer.id}`
        );
      }

      // `url` is the BTP WebSocket endpoint and is required for BTP peers. An
      // `ilp-http` peer egresses via `httpUrl` instead, so `url` may be omitted
      // for it (validated below once peerProtocol is known).
      if (peer.peerProtocol !== 'ilp-http') {
        if (!peer.url) {
          throw new ConfigurationError(`Peer ${peer.id} missing required field: url`);
        }
        if (typeof peer.url !== 'string') {
          throw new ConfigurationError(
            `Invalid type for peer.url: expected string, got ${typeof peer.url}`
          );
        }
      } else if (peer.url !== undefined && typeof peer.url !== 'string') {
        throw new ConfigurationError(
          `Invalid type for peer.url: expected string, got ${typeof peer.url}`
        );
      }

      if (peer.authToken == null) {
        throw new ConfigurationError(`Peer ${peer.id} missing required field: authToken`);
      }
      if (typeof peer.authToken !== 'string') {
        throw new ConfigurationError(
          `Invalid type for peer.authToken: expected string, got ${typeof peer.authToken}`
        );
      }

      // Per-peer packet protocol (Epic 38, Story 38.1). `'btp'` (default) dials
      // the BTP WebSocket at `url`; `'ilp-http'` POSTs OER PREPAREs to `httpUrl`.
      if (
        peer.peerProtocol !== undefined &&
        peer.peerProtocol !== 'btp' &&
        peer.peerProtocol !== 'ilp-http'
      ) {
        throw new ConfigurationError(
          `peer '${peer.id}': invalid peerProtocol value '${peer.peerProtocol}' (must be 'btp' or 'ilp-http')`
        );
      }

      if (peer.peerProtocol === 'ilp-http') {
        // ILP-over-HTTP egress requires an http(s) endpoint; `url` (the BTP
        // WebSocket) is unused for this peer, so the ws:// check is skipped.
        if (!peer.httpUrl || typeof peer.httpUrl !== 'string') {
          throw new ConfigurationError(
            `peer '${peer.id}': peerProtocol 'ilp-http' requires httpUrl (http(s) endpoint)`
          );
        }
        const httpUrlPattern = /^https?:\/\/.+/;
        if (!httpUrlPattern.test(peer.httpUrl)) {
          throw new ConfigurationError(
            `Invalid httpUrl for peer ${peer.id}: ${peer.httpUrl}. Must start with http:// or https://.`
          );
        }
      } else {
        // Validate WebSocket URL format (BTP peers only).
        const wsUrlPattern = /^wss?:\/\/.+:\d+$/;
        if (!wsUrlPattern.test(peer.url)) {
          throw new ConfigurationError(
            `Invalid WebSocket URL for peer ${peer.id}: ${peer.url}. Must start with ws:// or wss:// and include port.`
          );
        }
      }

      // Per-peer transport override. Only direct TCP is supported.
      if (peer.transport !== undefined && peer.transport !== 'direct') {
        throw new ConfigurationError(
          `peer '${peer.id}': invalid transport value '${String(peer.transport)}' (must be 'direct')`
        );
      }

      // Per-peer ILP relationship (issue #76). Governs whether value-bearing
      // forwards to this peer require a per-packet settlement claim. Defaults
      // to 'peer' downstream when omitted.
      if (
        peer.relation !== undefined &&
        peer.relation !== 'parent' &&
        peer.relation !== 'peer' &&
        peer.relation !== 'child'
      ) {
        throw new ConfigurationError(
          `peer '${peer.id}': invalid relation value '${peer.relation}' (must be 'parent', 'peer', or 'child')`
        );
      }

      // Check for duplicate peer IDs
      if (peerIds.has(peer.id)) {
        throw new ConfigurationError(`Duplicate peer ID: ${peer.id}`);
      }
      peerIds.add(peer.id);
    }
  }

  /**
   * Validate Route Definitions
   *
   * Validates each route has required fields (prefix, nextHop),
   * validates ILP address prefix format (RFC-0015), and ensures
   * nextHop references an existing peer ID.
   *
   * @param routes - Array of route configurations
   * @param peers - Array of peer configurations for validation
   * @throws ConfigurationError if route validation fails
   * @private
   */
  private static validateRoutes(routes: RouteConfig[], _peers: PeerConfig[]): void {
    // Note: We don't validate that route nextHops exist in the peers list because
    // routes can reference peers that will connect inbound (dynamic peers)
    // Those dynamic peers must have BTP_PEER_* environment variables configured

    for (const route of routes) {
      // Validate route has required fields
      if (!route.prefix) {
        throw new ConfigurationError('Route missing required field: prefix');
      }
      if (typeof route.prefix !== 'string') {
        throw new ConfigurationError(
          `Invalid type for route.prefix: expected string, got ${typeof route.prefix}`
        );
      }

      if (!route.nextHop) {
        throw new ConfigurationError('Route missing required field: nextHop');
      }
      if (typeof route.nextHop !== 'string') {
        throw new ConfigurationError(
          `Invalid type for route.nextHop: expected string, got ${typeof route.nextHop}`
        );
      }

      // Validate ILP address prefix format (RFC-0015)
      // Pattern: lowercase alphanumeric, dots, underscores, tildes, hyphens
      // Must start with alphanumeric character
      const ilpAddressPattern = /^[a-z0-9][a-z0-9._~-]*$/;
      if (!ilpAddressPattern.test(route.prefix)) {
        throw new ConfigurationError(
          `Invalid ILP address prefix in route: ${route.prefix}. ` +
            `Must contain only lowercase letters, numbers, dots, underscores, tildes, and hyphens.`
        );
      }

      // Note: Routes can reference peers that will connect inbound (not in static peers list)
      // Those peers must have BTP_PEER_* environment variables configured for authentication
      // No validation needed here - if peer never connects, routing will fail at runtime

      // Validate optional priority field if present
      if (route.priority !== undefined && typeof route.priority !== 'number') {
        throw new ConfigurationError(
          `Invalid type for route.priority: expected number, got ${typeof route.priority}`
        );
      }

      // Validate optional local-termination fields (issue #218). Shared with the
      // runtime admin desired-state path so boot and runtime are identical. A
      // route without `upstream` is an ordinary forwarding route → no-op.
      const termination = validateRouteTermination(route, isValidNonNegativeIntegerString);
      if (!termination.ok) {
        throw new ConfigurationError(`Invalid route termination config: ${termination.error}`);
      }
    }
  }

  /**
   * Validate Port Ranges
   *
   * Validates that port numbers are within the valid range (0-65535).
   * `0` is a legal value on both fields — it asks the OS to assign an
   * ephemeral port, read back afterwards via `ConnectorNode.getBtpServerPort()`
   * / `getHealthCheckPort()`, which removes any check-then-bind window.
   * Checks btpServerPort (required) and healthCheckPort (optional).
   *
   * @param config - Configuration object with port fields
   * @throws ConfigurationError if port number out of range
   * @private
   */
  private static validatePorts(config: Record<string, unknown>): void {
    const MIN_PORT = 0;
    const MAX_PORT = 65535;
    const btpPort = config.btpServerPort as number;

    // Validate btpServerPort
    if (btpPort < MIN_PORT || btpPort > MAX_PORT) {
      throw new ConfigurationError(
        `BTP server port must be between ${MIN_PORT}-${MAX_PORT}, got: ${btpPort}`
      );
    }

    // Validate healthCheckPort if present
    if (config.healthCheckPort !== undefined) {
      if (typeof config.healthCheckPort !== 'number') {
        throw new ConfigurationError(
          `Invalid type for healthCheckPort: expected number, got ${typeof config.healthCheckPort}`
        );
      }
      const healthPort = config.healthCheckPort as number;
      if (healthPort < MIN_PORT || healthPort > MAX_PORT) {
        throw new ConfigurationError(
          `Health check port must be between ${MIN_PORT}-${MAX_PORT}, got: ${healthPort}`
        );
      }
    }
  }

  /**
   * Validate the optional top-level `apex` field (toon-meta#153).
   *
   * @param raw - Unvalidated `apex` value from the YAML input
   * @returns The apex string, or undefined when absent
   * @throws ConfigurationError when present but not a non-empty string
   * @private
   */
  private static validateApex(raw: unknown): string | undefined {
    if (raw === undefined) {
      return undefined;
    }
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new ConfigurationError(
        `Invalid type for apex: expected non-empty string, got ${typeof raw}`
      );
    }
    return raw;
  }

  /**
   * Shape-validate the optional `children` section (toon-meta#153): must be an
   * array of objects when present. Per-entry semantic validation (name label,
   * exactly-one-of upstream|peerId, peer admission, …) is performed by
   * `expandChildren`.
   *
   * @param raw - Unvalidated `children` value from the YAML input
   * @returns The children entries, or undefined when absent
   * @throws ConfigurationError when present but not an array of objects
   * @private
   */
  private static validateChildrenShape(raw: unknown): ChildConfig[] | undefined {
    if (raw === undefined) {
      return undefined;
    }
    if (!Array.isArray(raw)) {
      throw new ConfigurationError(`Invalid type for children: expected array, got ${typeof raw}`);
    }
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ConfigurationError('Invalid children entry: expected an object');
      }
    }
    return raw as ChildConfig[];
  }

  /**
   * Enforce relation ↔ route consistency at config load (toon-meta#153).
   *
   * For every route whose `nextHop` is a peer with a declared `relation`, the
   * route prefix must be consistent with that relation's topology:
   * - `child`  ⇒ a strict descendant of one of the node's self-prefixes (a
   *   route with nextHop === nodeId or 'local') or the apex;
   * - `parent` ⇒ NOT under the node's own subtree.
   *
   * Mirrors the runtime admission checks in `ConnectorNode.registerPeer` /
   * the admin API, turning the latent F06/T00 mis-tagged-child trap into an
   * immediate boot-time `ConfigurationError` naming the offending route.
   *
   * @param routes - All routes (including expanded children)
   * @param peers - Configured peers (relation source)
   * @param nodeId - This node's id (self-prefix derivation)
   * @param apex - Optional explicit apex, counted as a self-prefix
   * @throws ConfigurationError listing the offending route on violation
   * @private
   */
  private static enforceRelationRoutes(
    routes: RouteConfig[],
    peers: PeerConfig[],
    nodeId: string,
    apex?: string
  ): void {
    const peersWithRelation = peers.filter((p) => p.relation !== undefined);
    if (peersWithRelation.length === 0) {
      return;
    }

    const localPrefixes = deriveLocalPrefixes(routes, nodeId);
    if (apex !== undefined && !localPrefixes.includes(apex)) {
      localPrefixes.push(apex);
    }

    for (const peer of peersWithRelation) {
      const routePrefixes = routes.filter((r) => r.nextHop === peer.id).map((r) => r.prefix);
      if (routePrefixes.length === 0) {
        continue;
      }
      const result = validateRelationRoute(peer.relation, localPrefixes, routePrefixes);
      if (!result.ok) {
        throw new ConfigurationError(
          `Relation/route mismatch for peer '${peer.id}' (relation '${peer.relation}'): ${result.error}`
        );
      }
    }
  }

  /**
   * Validate and Normalize the `transport` Block.
   *
   * Only direct TCP transport is supported; any other `transport.type` is
   * rejected. Returns `{ type: 'direct' }`.
   *
   * @param raw - Unvalidated `transport` field value from the YAML input
   * @returns Normalized `TransportConfig`
   * @throws ConfigurationError on any schema violation
   * @private
   */
  private static validateTransport(raw: unknown): TransportConfig {
    // Absent or explicit undefined -> default to direct
    if (raw === undefined) {
      return { type: 'direct' };
    }

    // Reject non-objects (string, array, null, number, boolean)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      const actualType = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
      throw new ConfigurationError(
        `Invalid type for transport: expected object, got ${actualType}`
      );
    }

    const rawTransport = raw as Record<string, unknown>;
    const typeRaw = rawTransport.type;

    // Default type to 'direct' when absent (supports `transport: {}`); only
    // direct TCP is supported (SOCKS5 / ATOR overlay transport was removed).
    const type = typeRaw === undefined ? 'direct' : typeRaw;
    if (type !== 'direct') {
      const rendered = typeof typeRaw === 'string' ? `"${typeRaw}"` : `<${typeof typeRaw}>`;
      throw new ConfigurationError(
        `Invalid transport.type: only 'direct' is supported, got ${rendered}`
      );
    }

    // direct discards any extra fields unconditionally.
    return { type: 'direct' };
  }

  /**
   * Validate and Normalize the `bootstrap` Block (toon-meta#153).
   *
   * Opt-in: absent (or explicit undefined) returns undefined and no bootstrap
   * runs. When present: `enabled` is a required boolean; `registryUrl` must be
   * https:// (the curated registry is signed AND transported over TLS);
   * `curatorPubkey` and per-seed `pubkey` are 64-char lowercase hex (BIP-340
   * x-only / Nostr keys); seed `relayUrl`s are ws:// or wss:// WebSocket URLs
   * (ws:// permitted for local dev, mirroring peer URL validation);
   * `sampleSize` and `refreshIntervalSecs` are positive integers.
   *
   * @param raw - Unvalidated `bootstrap` field value from the YAML input
   * @returns Normalized `BootstrapConfig`, or undefined when absent
   * @throws ConfigurationError on any schema violation
   * @private
   */
  private static validateBootstrap(raw: unknown): BootstrapConfig | undefined {
    if (raw === undefined) {
      return undefined;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      const actualType = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
      throw new ConfigurationError(
        `Invalid type for bootstrap: expected object, got ${actualType}`
      );
    }

    const rawBootstrap = raw as Record<string, unknown>;
    const hex64 = /^[0-9a-f]{64}$/;
    const wsUrl = /^wss?:\/\/.+/;

    if (typeof rawBootstrap.enabled !== 'boolean') {
      throw new ConfigurationError(
        `Invalid type for bootstrap.enabled: expected boolean, got ${typeof rawBootstrap.enabled}`
      );
    }

    if (rawBootstrap.registryUrl !== undefined) {
      if (
        typeof rawBootstrap.registryUrl !== 'string' ||
        !/^https:\/\/.+/.test(rawBootstrap.registryUrl)
      ) {
        throw new ConfigurationError(
          `Invalid bootstrap.registryUrl: must be an https:// URL, got ${String(
            rawBootstrap.registryUrl
          )}`
        );
      }
    }

    if (rawBootstrap.curatorPubkey !== undefined) {
      if (
        typeof rawBootstrap.curatorPubkey !== 'string' ||
        !hex64.test(rawBootstrap.curatorPubkey)
      ) {
        throw new ConfigurationError(
          'Invalid bootstrap.curatorPubkey: must be 64-char lowercase hex (BIP-340 x-only pubkey)'
        );
      }
    }

    let seeds: BootstrapSeedEntry[] | undefined;
    if (rawBootstrap.seeds !== undefined) {
      if (!Array.isArray(rawBootstrap.seeds)) {
        throw new ConfigurationError(
          `Invalid type for bootstrap.seeds: expected array, got ${typeof rawBootstrap.seeds}`
        );
      }
      seeds = [];
      for (const [index, rawSeed] of rawBootstrap.seeds.entries()) {
        if (rawSeed === null || typeof rawSeed !== 'object' || Array.isArray(rawSeed)) {
          throw new ConfigurationError(`Invalid bootstrap.seeds[${index}]: expected object`);
        }
        const seed = rawSeed as Record<string, unknown>;
        if (typeof seed.relayUrl !== 'string' || !wsUrl.test(seed.relayUrl)) {
          throw new ConfigurationError(
            `Invalid bootstrap.seeds[${index}].relayUrl: must be a ws:// or wss:// URL, got ${String(
              seed.relayUrl
            )}`
          );
        }
        if (
          seed.pubkey !== undefined &&
          (typeof seed.pubkey !== 'string' || !hex64.test(seed.pubkey))
        ) {
          throw new ConfigurationError(
            `Invalid bootstrap.seeds[${index}].pubkey: must be 64-char lowercase hex`
          );
        }
        seeds.push(
          seed.pubkey !== undefined
            ? { relayUrl: seed.relayUrl, pubkey: seed.pubkey as string }
            : { relayUrl: seed.relayUrl }
        );
      }
    }

    if (rawBootstrap.cachePath !== undefined) {
      if (typeof rawBootstrap.cachePath !== 'string' || rawBootstrap.cachePath.trim() === '') {
        throw new ConfigurationError(
          'Invalid bootstrap.cachePath: must be a non-empty file path string'
        );
      }
    }

    if (rawBootstrap.sampleSize !== undefined) {
      if (
        typeof rawBootstrap.sampleSize !== 'number' ||
        !Number.isInteger(rawBootstrap.sampleSize) ||
        rawBootstrap.sampleSize < 1
      ) {
        throw new ConfigurationError(
          `Invalid bootstrap.sampleSize: must be a positive integer, got ${String(
            rawBootstrap.sampleSize
          )}`
        );
      }
    }

    if (rawBootstrap.refreshIntervalSecs !== undefined) {
      if (
        typeof rawBootstrap.refreshIntervalSecs !== 'number' ||
        !Number.isInteger(rawBootstrap.refreshIntervalSecs) ||
        rawBootstrap.refreshIntervalSecs < 1
      ) {
        throw new ConfigurationError(
          `Invalid bootstrap.refreshIntervalSecs: must be a positive integer, got ${String(
            rawBootstrap.refreshIntervalSecs
          )}`
        );
      }
    }

    const bootstrap: BootstrapConfig = { enabled: rawBootstrap.enabled };
    if (rawBootstrap.registryUrl !== undefined) {
      bootstrap.registryUrl = rawBootstrap.registryUrl as string;
    }
    if (rawBootstrap.curatorPubkey !== undefined) {
      bootstrap.curatorPubkey = rawBootstrap.curatorPubkey as string;
    }
    if (seeds !== undefined) {
      bootstrap.seeds = seeds;
    }
    if (rawBootstrap.cachePath !== undefined) {
      bootstrap.cachePath = rawBootstrap.cachePath as string;
    }
    if (rawBootstrap.sampleSize !== undefined) {
      bootstrap.sampleSize = rawBootstrap.sampleSize as number;
    }
    if (rawBootstrap.refreshIntervalSecs !== undefined) {
      bootstrap.refreshIntervalSecs = rawBootstrap.refreshIntervalSecs as number;
    }
    return bootstrap;
  }
}
