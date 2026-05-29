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
import * as path from 'path';
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
} from './types';
import { validateEnvironment } from './environment-validator';

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
    // Hoisted above the validators because validateTransport's SOCKS5
    // managed-options branch consults environment-specific defaults.
    const environment = this.loadEnvironment();

    // Validate required fields and structure. NOTE: validateTransport runs
    // BEFORE validatePeers so the per-peer transport validator can compare
    // each peer's optional `transport` override against the connector-level
    // type (Approach A from the per-peer-transport tech spec, F4).
    this.validateRequiredFields(rawConfig);
    const transport = this.validateTransport(rawConfig.transport, environment);
    this.validatePeers(rawConfig.peers as PeerConfig[], transport.type);
    this.validateRoutes(rawConfig.routes as RouteConfig[], rawConfig.peers as PeerConfig[]);
    this.validatePorts(rawConfig);

    // Load blockchain configuration from environment variables
    const blockchain = this.loadBlockchainConfig(environment);

    const btpServerPort = rawConfig.btpServerPort as number;
    const healthCheckPort = (rawConfig.healthCheckPort as number | undefined) ?? 8080;

    // Apply default values for optional fields and pass through all optional config
    const connectorConfig: ConnectorConfig = {
      nodeId: rawConfig.nodeId as string,
      btpServerPort,
      healthCheckPort,
      logLevel: (rawConfig.logLevel as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info',
      peers: rawConfig.peers as PeerConfig[],
      routes: rawConfig.routes as RouteConfig[],
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
      transport,
    };

    // Validate environment configuration
    validateEnvironment(connectorConfig);

    return connectorConfig;
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
  private static validatePeers(peers: PeerConfig[], transportType: 'direct' | 'socks5'): void {
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

      if (!peer.url) {
        throw new ConfigurationError(`Peer ${peer.id} missing required field: url`);
      }
      if (typeof peer.url !== 'string') {
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

      // Validate WebSocket URL format
      const wsUrlPattern = /^wss?:\/\/.+:\d+$/;
      if (!wsUrlPattern.test(peer.url)) {
        throw new ConfigurationError(
          `Invalid WebSocket URL for peer ${peer.id}: ${peer.url}. Must start with ws:// or wss:// and include port.`
        );
      }

      // Per-peer transport override (per-peer-transport tech spec, AC-12).
      // Validates enum membership and rejects `'socks5'` on a non-socks5 connector.
      if (peer.transport !== undefined) {
        if (peer.transport !== 'direct' && peer.transport !== 'socks5') {
          throw new ConfigurationError(
            `peer '${peer.id}': invalid transport value '${peer.transport}' (must be 'direct' or 'socks5')`
          );
        }
        if (peer.transport === 'socks5' && transportType !== 'socks5') {
          throw new ConfigurationError(
            `peer '${peer.id}': transport: 'socks5' requires connector-level transport.type 'socks5'`
          );
        }
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
    }
  }

  /**
   * Validate Port Ranges
   *
   * Validates that port numbers are within the valid range (1-65535).
   * Checks btpServerPort (required) and healthCheckPort (optional).
   *
   * @param config - Configuration object with port fields
   * @throws ConfigurationError if port number out of range
   * @private
   */
  private static validatePorts(config: Record<string, unknown>): void {
    const MIN_PORT = 1;
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
   * Validate and Normalize the `transport` Block (Epic 35 / Story 35.3)
   *
   * Validates the optional `transport` block selecting between `direct`
   * (default) and `socks5` outbound BTP transports. Returns a normalized
   * `TransportConfig` -- callers can rely on the discriminated union being
   * fully populated (including `managed: false` default for SOCKS5).
   *
   * @param raw - Unvalidated `transport` field value from the YAML input
   * @returns Normalized `TransportConfig`
   * @throws ConfigurationError on any schema violation
   * @private
   */
  private static validateTransport(raw: unknown, environment?: Environment): TransportConfig {
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

    // Default type to 'direct' when absent (supports `transport: {}`)
    const type = typeRaw === undefined ? 'direct' : typeRaw;

    // Reject any type not in the discriminator set.
    // Use String() rather than JSON.stringify so nested object/array structures
    // submitted as `type` cannot echo user-supplied content into the message.
    if (type !== 'direct' && type !== 'socks5') {
      const rendered = typeof typeRaw === 'string' ? `"${typeRaw}"` : `<${typeof typeRaw}>`;
      throw new ConfigurationError(
        `Invalid transport.type: must be one of direct, socks5, got ${rendered}`
      );
    }

    if (type === 'direct') {
      // AC #8: direct discards any extra SOCKS-only fields unconditionally.
      return { type: 'direct' };
    }

    return this.validateSocks5Transport(rawTransport, environment);
  }

  /**
   * Validate the SOCKS5 branch of the `transport` block.
   *
   * Enforces:
   * - `socksProxy` present, non-empty string, `socks5h://` scheme (case-sensitive).
   *   Any other scheme is rejected with a DNS-leak rationale in the error message.
   * - `externalUrl` present, non-empty string, starts with `ws://` or `wss://`.
   * - `managed` optional boolean; defaults to `false`.
   *
   * **Redaction:** when the rejected `socksProxy` value contains `.anon`
   * (paranoid case), the hidden-service host is replaced with `<redacted>`
   * in the error message to avoid leaking hidden service addresses if the
   * error is logged downstream (Story 35.2 Task 6.4 convention).
   *
   * @private
   */
  private static validateSocks5Transport(
    raw: Record<string, unknown>,
    environment?: Environment
  ): Extract<TransportConfig, { type: 'socks5' }> {
    // --- socksProxy ---
    const socksProxyRaw = raw.socksProxy;
    if (socksProxyRaw === undefined) {
      throw new ConfigurationError(
        'Missing required field: transport.socksProxy is required when transport.type is "socks5"'
      );
    }
    if (typeof socksProxyRaw !== 'string') {
      throw new ConfigurationError(
        `Invalid type for transport.socksProxy: expected string, got ${typeof socksProxyRaw}`
      );
    }
    const socksProxy = socksProxyRaw.trim();
    if (socksProxy === '') {
      throw new ConfigurationError(
        'Missing required field: transport.socksProxy is required when transport.type is "socks5" (got empty string)'
      );
    }
    // DNS leak prevention: socks5h:// forces DNS resolution through the proxy;
    // socks5:// resolves DNS locally and would expose .anon destinations.
    if (!socksProxy.startsWith('socks5h://')) {
      const safeValue = this.sanitizeProxyForError(socksProxy);
      throw new ConfigurationError(
        `transport.socksProxy must use the "socks5h://" scheme to prevent DNS leaks ` +
          `(socks5h:// forces DNS resolution through the proxy; socks5:// resolves DNS ` +
          `locally and would expose .anon destinations). Got: "${safeValue}"`
      );
    }

    // --- externalUrl ---
    const externalUrlRaw = raw.externalUrl;
    if (externalUrlRaw === undefined) {
      throw new ConfigurationError(
        'Missing required field: transport.externalUrl is required when transport.type is "socks5"'
      );
    }
    if (typeof externalUrlRaw !== 'string') {
      throw new ConfigurationError(
        `Invalid type for transport.externalUrl: expected string, got ${typeof externalUrlRaw}`
      );
    }
    const externalUrl = externalUrlRaw.trim();
    if (externalUrl === '') {
      throw new ConfigurationError(
        'Missing required field: transport.externalUrl is required when transport.type is "socks5" (got empty string)'
      );
    }
    // Story 35.5 AC #8: allow literal "auto" for managed hidden service
    // lookup. Requires `managed: true` AND `managedOptions.hiddenServiceDir`.
    const isAuto = externalUrl === 'auto';
    if (!isAuto && !externalUrl.startsWith('ws://') && !externalUrl.startsWith('wss://')) {
      // Redact `.anon` hidden-service hosts before echoing into the error.
      const safeExternal = this.sanitizeProxyForError(externalUrl);
      throw new ConfigurationError(
        `Invalid transport.externalUrl: must start with ws:// or wss:// (or be the literal "auto" for managed hidden services). Got: "${safeExternal}"`
      );
    }

    // Epic 35 retro action item #6: fail fast when the externalUrl is a
    // loopback placeholder in production. `ws://localhost`, `ws://127.0.0.1`,
    // `ws://[::1]`, and `wss://` variants are never a valid externally-
    // reachable BTP URL for a real deployment. Allowing them to pass in
    // production would ship a footgun operators must remember to override at
    // runtime. Validate at config load so the problem surfaces loudly.
    //
    // Only enforced when environment === 'production' so local dev and
    // integration tests can continue to use loopback addresses.
    if (!isAuto && environment === 'production') {
      const loopbackHostRe =
        /^wss?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|\[0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}1\])(?::\d+)?(?:\/|$)/i;
      if (loopbackHostRe.test(externalUrl)) {
        throw new ConfigurationError(
          `Invalid transport.externalUrl for production environment: ` +
            `loopback host (localhost / 127.0.0.1 / ::1) is never externally ` +
            `reachable. Set transport.externalUrl to this node's real public ` +
            `ws://|wss:// URL (or "auto" with managed hidden service). ` +
            `Got: "${externalUrl}"`
        );
      }
    }

    // --- managed ---
    const managedRaw = raw.managed;
    let managed: boolean;
    if (managedRaw === undefined) {
      managed = false;
    } else if (typeof managedRaw === 'boolean') {
      managed = managedRaw;
    } else {
      throw new ConfigurationError(
        `Invalid type for transport.managed: expected boolean, got ${typeof managedRaw}`
      );
    }

    // --- managedOptions (Story 35.5) ---
    const managedOptions = this.validateManagedOptions(raw.managedOptions, managed);

    if (isAuto) {
      if (!managed) {
        throw new ConfigurationError(
          'Invalid transport.externalUrl: "auto" requires transport.managed to be true'
        );
      }
      if (!managedOptions || !managedOptions.hiddenServiceDir) {
        throw new ConfigurationError(
          'Invalid transport.externalUrl: "auto" requires transport.managedOptions.hiddenServiceDir to be set'
        );
      }
    }

    const result: Extract<TransportConfig, { type: 'socks5' }> = {
      type: 'socks5',
      socksProxy,
      externalUrl,
      managed,
    };
    if (managedOptions) {
      result.managedOptions = managedOptions;
    }
    return result;
  }

  /**
   * Validate the optional `managedOptions` sibling of `managed` (Story 35.5).
   *
   * Rules:
   * - If `managedOptions` is absent or an empty object, returns undefined.
   * - Rejects if `managedOptions` is present while `managed !== true`.
   * - `hiddenServiceDir` must be a non-empty string and must not contain
   *   `..` path-traversal segments after normalisation.
   * - Numeric options (ports, timeouts) must be finite positive integers.
   *
   * @private
   */
  private static validateManagedOptions(
    raw: unknown,
    managed: boolean
  ): Extract<TransportConfig, { type: 'socks5' }>['managedOptions'] | undefined {
    if (raw === undefined) return undefined;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ConfigurationError(
        `Invalid type for transport.managedOptions: expected object, got ${
          raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw
        }`
      );
    }
    const rawObj = raw as Record<string, unknown>;
    const keys = Object.keys(rawObj);
    if (keys.length === 0) return undefined;

    if (!managed) {
      throw new ConfigurationError(
        'Invalid config: transport.managedOptions is only permitted when transport.managed is true'
      );
    }

    const out: NonNullable<Extract<TransportConfig, { type: 'socks5' }>['managedOptions']> = {};

    if ('hiddenServiceDir' in rawObj) {
      const v = rawObj.hiddenServiceDir;
      if (typeof v !== 'string' || v.trim() === '') {
        throw new ConfigurationError(
          `Invalid type for transport.managedOptions.hiddenServiceDir: expected non-empty string, got ${typeof v}`
        );
      }
      // Reject `..` path-traversal. Check the raw input as well as the
      // normalized form, because `path.normalize` collapses `..` segments
      // inside absolute paths (`/var/lib/../../etc` -> `/etc`) which would
      // silently permit traversal attacks.
      const rawSegments = v.split(/[\\/]/);
      const normalized = path.normalize(v);
      const normSegments = normalized.split(path.sep);
      if (rawSegments.includes('..') || normSegments.includes('..')) {
        throw new ConfigurationError(
          `Invalid transport.managedOptions.hiddenServiceDir: ".." path-traversal segments are not permitted`
        );
      }
      out.hiddenServiceDir = v;
    }

    const intFields: Array<
      keyof NonNullable<Extract<TransportConfig, { type: 'socks5' }>['managedOptions']>
    > = ['hiddenServicePort', 'startupTimeoutMs', 'stopTimeoutMs'];
    for (const field of intFields) {
      if (field in rawObj) {
        const v = rawObj[field as string];
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) {
          throw new ConfigurationError(
            `Invalid type for transport.managedOptions.${String(field)}: expected positive integer, got ${typeof v === 'number' ? String(v) : typeof v}`
          );
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (out as any)[field] = v;
      }
    }

    for (const strField of ['binaryPath', 'configFilePath'] as const) {
      if (strField in rawObj) {
        const v = rawObj[strField];
        if (typeof v !== 'string' || v.trim() === '') {
          throw new ConfigurationError(
            `Invalid type for transport.managedOptions.${strField}: expected non-empty string, got ${typeof v}`
          );
        }
        // Apply the same `..` traversal defense used for hiddenServiceDir. A
        // malicious config that points `binaryPath` at `../../../usr/bin/rm`
        // (or `configFilePath` at an attacker-controlled file outside the
        // deployment root) is a privilege-escalation vector once ManagedAnon
        // spawns it.
        const rawSegs = v.split(/[\\/]/);
        const normSegs = path.normalize(v).split(path.sep);
        if (rawSegs.includes('..') || normSegs.includes('..')) {
          throw new ConfigurationError(
            `Invalid transport.managedOptions.${strField}: ".." path-traversal segments are not permitted`
          );
        }
        out[strField] = v;
      }
    }

    return out;
  }

  /**
   * Redact sensitive substrings in a URL prior to echoing it in an error
   * message. Two redaction rules apply, composed in order:
   *
   * 1. **Userinfo redaction (always):** any `user:password@` authority
   *    component is replaced with `<redacted>@`, regardless of whether the
   *    URL contains `.anon`. Operators sometimes paste fully-formed URLs
   *    with embedded credentials into YAML; echoing those verbatim into a
   *    logged error is a credential-disclosure risk.
   *
   * 2. **`.anon` redaction (opt-in):** when any substring of the URL
   *    contains `.anon`, the value is treated as sensitive -- both the
   *    authority and any path/query/fragment are redacted wholesale. This
   *    covers:
   *      - URL form with scheme+authority (`socks5://host.anon:9050`)
   *      - URL with `.anon` in path (`http://safe/path/leak.anon/...`)
   *      - Bare `host.anon:port` (no scheme, no `//`)
   *    In all cases the result collapses to `<redacted>` (or `scheme://<redacted>`
   *    when a safe scheme prefix can be preserved for operator debuggability).
   *
   * Non-`.anon` values without userinfo are returned unchanged (most
   * misconfigurations are plain `host:port` combos that are safe to log).
   *
   * @private
   */
  private static sanitizeProxyForError(url: string): string {
    // Rule 1: redact embedded userinfo even without .anon (credentials leak).
    // Pattern targets scheme://userinfo@host form specifically to avoid
    // mangling non-URL content.
    const sanitized = url.replace(/(\/\/)[^/@\s]+@/, '$1<redacted>@');

    if (!sanitized.includes('.anon')) {
      return sanitized;
    }

    // Rule 2: .anon is present somewhere -- redact aggressively.
    if (sanitized.includes('//')) {
      // Preserve `scheme://` prefix for operator context, discard everything else.
      const schemePrefix = sanitized.slice(0, sanitized.indexOf('//') + 2);
      return `${schemePrefix}<redacted>`;
    }
    // Bare host:port form -- no safe substring to preserve; redact wholesale.
    return '<redacted>';
  }
}
