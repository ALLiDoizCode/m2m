/**
 * ILP Packet Handler - Core forwarding logic for ILPv4 packets
 * @packageDocumentation
 * @see {@link https://github.com/interledger/rfcs/blob/master/0027-interledger-protocol-4/0027-interledger-protocol-4.md|RFC-0027: Interledger Protocol v4}
 */

import {
  ILPPreparePacket,
  ILPFulfillPacket,
  ILPRejectPacket,
  ILPErrorCode,
  PacketType,
  isValidILPAddress,
} from '@toon-protocol/shared';
import { RoutingTable } from '../routing/routing-table';
import { Logger, generateCorrelationId } from '../utils/logger';
import { BTPClientManager } from '../btp/btp-client-manager';
import { BTPServer } from '../btp/btp-server';
import { BTPConnectionError, BTPAuthenticationError } from '../btp/btp-client';
import type { PeerEgress } from '../transport/http-peer-transport';
import { HttpPeerConnectionError, HttpPeerTimeoutError } from '../transport/http-peer-transport';
import { AccountManager } from '../settlement/account-manager';
import {
  SettlementConfig,
  LocalDeliveryConfig,
  LocalDeliveryHandler,
  LocalDeliveryRequest,
  LocalDeliveryResponse,
  PeerRelation,
} from '../config/types';
import { AccountLedgerCodes } from '../settlement/types';
import * as crypto from 'crypto';
import { LocalDeliveryClient } from './local-delivery-client';
import { sha256 } from '@noble/hashes/sha2';
import type { PerPacketClaimService } from '../settlement/per-packet-claim-service';
import type { NIP59ClaimWrapper } from '../settlement/privacy/nip59-claim-wrapper';
import { deserializeWrappedClaim } from '../settlement/privacy/nip59-claim-wrapper';
import type { IlpMetricsRegistry } from '../observability/metrics-registry';

/**
 * Packet validation result
 */
interface ValidationResult {
  /** Whether packet passed validation */
  isValid: boolean;
  /** Error code if validation failed */
  errorCode?: ILPErrorCode;
  /** Human-readable error message if validation failed */
  errorMessage?: string;
}

/**
 * Expiry safety margin in milliseconds
 * @remarks
 * Per RFC-0027, connectors must decrement packet expiry to prevent timeout during forwarding.
 * Default safety margin of 1000ms (1 second) provides buffer for network latency.
 */
const EXPIRY_SAFETY_MARGIN_MS = 1000;

/**
 * PacketHandler - Implements ILPv4 packet forwarding logic
 * @remarks
 * Handles ILP Prepare packets by:
 * 1. Validating packet structure and expiration time per RFC-0027
 * 2. Looking up next-hop peer using routing table
 * 3. Decrementing packet expiry by safety margin
 * 4. Forwarding to next-hop peer (integration point for Epic 2)
 * 5. Generating ILP Reject packets for errors
 *
 * @see {@link https://github.com/interledger/rfcs/blob/master/0027-interledger-protocol-4/0027-interledger-protocol-4.md|RFC-0027: Interledger Protocol v4}
 */
export class PacketHandler {
  /**
   * Routing table for next-hop lookups
   */
  private readonly routingTable: RoutingTable;

  /**
   * BTP client manager for packet forwarding to outbound peers
   */
  private readonly btpClientManager: BTPClientManager;

  /**
   * BTP server for packet forwarding to incoming authenticated peers
   */
  private btpServer: BTPServer | null;

  /**
   * Logger instance for structured logging
   * @remarks
   * Pino logger for structured JSON logging with correlation IDs
   */
  private readonly logger: Logger;

  /**
   * Connector node ID for triggeredBy field in reject packets
   */
  private readonly nodeId: string;

  /**
   * Per-packet claim service for attaching mandatory signed claims to outgoing peer packets.
   * Null until initialized via setPerPacketClaimService(). Packets forwarded to peers
   * will be rejected with T00_INTERNAL_ERROR if this is null at forwarding time.
   */
  private perPacketClaimService: PerPacketClaimService | null = null;

  /**
   * Default token ID for settlement recording (resolved from on-chain ERC-20 symbol)
   */
  private defaultTokenId: string = 'M2M';

  /**
   * ILP peering relationship per next-hop peer id (issue #76).
   *
   * Consulted by {@link requiresSettlementClaim} to decide whether a
   * value-bearing forward to a peer must carry a mandatory per-packet claim.
   * A peer absent from this map (or explicitly `'peer'`/`'parent'`) requires a
   * claim — preserving the pre-issue-76 behavior; only `'child'` skips it.
   *
   * Populated by ConnectorNode from startup config and from runtime peer
   * registration (`registerPeer` / `POST /admin/peers`) via
   * {@link setPeerRelation}.
   */
  private readonly peerRelations: Map<string, PeerRelation> = new Map();

  /**
   * Per-next-hop packet protocol (Epic 38, Story 38.1). Consulted by
   * {@link forwardToNextHop} to dispatch BTP vs ILP-over-HTTP egress. A peer
   * absent from this map (or `'btp'`) forwards via BTP — preserving the
   * pre-Epic-38 behavior byte-for-byte. Populated by ConnectorNode from startup
   * config and runtime peer registration via {@link setPeerProtocol}.
   */
  private readonly peerProtocols: Map<string, 'btp' | 'ilp-http'> = new Map();

  /**
   * ILP-over-HTTP egress manager (Epic 38, Story 38.1). Null until wired via
   * {@link setHttpEgress}. Used only for peers whose `peerProtocol` is
   * `'ilp-http'`; BTP peers never touch it.
   */
  private httpEgress: PeerEgress | null = null;

  /**
   * Account manager for settlement recording (optional)
   * @remarks
   * When provided, enables settlement recording for packet forwarding.
   * Null if settlement is disabled (backward compatibility).
   * Not readonly to support late initialization via setSettlement().
   */
  private accountManager: AccountManager | null;

  /**
   * Settlement configuration (optional)
   * @remarks
   * Contains connector fee percentage and TigerBeetle connection settings.
   * Null if settlement is disabled.
   * Not readonly to support late initialization via setSettlement().
   */
  private settlementConfig: SettlementConfig | null;

  /**
   * Local delivery client for forwarding to app handler via HTTP (optional)
   * @remarks
   * When enabled, packets destined for local addresses are forwarded
   * via HTTP to an external app instead of auto-fulfilling.
   */
  private localDeliveryClient: LocalDeliveryClient | null = null;

  /**
   * Function handler for in-process local delivery (optional)
   * @remarks
   * When set, takes priority over HTTP LocalDeliveryClient. Allows
   * direct in-process packet delivery without HTTP round-trip.
   */
  private localDeliveryHandler: LocalDeliveryHandler | null = null;

  /**
   * NIP-59 claim wrapper for receiver-side preimage derivation (optional)
   */
  private _nip59Wrapper: NIP59ClaimWrapper | null = null;

  /**
   * Node secp256k1 private key for receiver-side ECDH preimage derivation (optional)
   */
  private _nodePrivateKey: Uint8Array | null = null;

  /**
   * ILP observability metrics registry (Story 37.2 — Epic 37).
   *
   * Null until `setIlpMetrics()` is called by ConnectorNode during wiring. When null,
   * all instrumentation calls are no-ops — keeps this optional so existing test
   * harnesses that construct PacketHandler without metrics continue to work.
   */
  private ilpMetrics: IlpMetricsRegistry | null = null;

  /**
   * Creates a new PacketHandler instance
   * @param routingTable - Routing table for next-hop lookups
   * @param btpClientManager - BTP client manager for forwarding packets to outbound peers
   * @param nodeId - Connector node ID for reject packet triggeredBy field
   * @param logger - Pino logger instance for structured logging
   * @param btpServer - Optional BTP server for forwarding to incoming authenticated peers
   * @param accountManager - Optional account manager for settlement recording (Story 6.4)
   * @param settlementConfig - Optional settlement configuration for fee calculation and TigerBeetle
   */
  constructor(
    routingTable: RoutingTable,
    btpClientManager: BTPClientManager,
    nodeId: string,
    logger: Logger,
    btpServer: BTPServer | null = null,
    accountManager: AccountManager | null = null,
    settlementConfig: SettlementConfig | null = null
  ) {
    this.routingTable = routingTable;
    this.btpClientManager = btpClientManager;
    this.btpServer = btpServer;
    this.nodeId = nodeId;
    this.logger = logger;
    this.accountManager = accountManager;
    this.settlementConfig = settlementConfig;

    // Log settlement enabled/disabled state
    if (this.isSettlementEnabled()) {
      this.logger.info(
        {
          connectorFeePercentage: settlementConfig?.connectorFeePercentage,
          tigerBeetleClusterId: settlementConfig?.tigerBeetleClusterId,
        },
        'Settlement recording enabled'
      );
    } else {
      this.logger.info('Settlement recording disabled');
    }
  }

  /**
   * Set BTPServer reference (to resolve circular dependency during initialization)
   * @param btpServer - BTP server instance for incoming peer forwarding
   */
  setBTPServer(btpServer: BTPServer): void {
    this.btpServer = btpServer;
  }

  /**
   * Set AccountManager and SettlementConfig for late initialization
   * @param accountManager - AccountManager instance for settlement recording
   * @param settlementConfig - Settlement configuration with fee and TigerBeetle settings
   * @remarks
   * Called after TigerBeetle initialization completes. Allows PacketHandler
   * to be created in constructor while settlement is initialized asynchronously.
   */
  setSettlement(
    accountManager: AccountManager,
    settlementConfig: SettlementConfig,
    defaultTokenId?: string
  ): void {
    this.accountManager = accountManager;
    this.settlementConfig = settlementConfig;
    if (defaultTokenId) {
      this.defaultTokenId = defaultTokenId;
    }

    if (this.isSettlementEnabled()) {
      this.logger.info(
        {
          event: 'settlement_enabled',
          connectorFeePercentage: settlementConfig.connectorFeePercentage,
          tigerBeetleClusterId: settlementConfig.tigerBeetleClusterId,
        },
        'Settlement recording enabled via late initialization'
      );
    }
  }

  /**
   * Set PerPacketClaimService for attaching mandatory signed claims to outgoing peer packets.
   * Must be called before forwarding any non-zero-amount packets to peers.
   * @param service - PerPacketClaimService instance
   */
  setPerPacketClaimService(service: PerPacketClaimService): void {
    this.perPacketClaimService = service;
    this.logger.info('Per-packet claim service enabled');
  }

  /**
   * Record (or update) the ILP peering relationship for a next-hop peer (issue #76).
   *
   * Called by ConnectorNode for each configured peer at startup and on every
   * runtime registration. `'child'` next hops are forwarded value WITHOUT a
   * mandatory per-packet claim; `'parent'`/`'peer'` continue to require one.
   *
   * @param peerId - Next-hop peer id (matches the route `nextHop`)
   * @param relation - ILP peering relationship
   */
  setPeerRelation(peerId: string, relation: PeerRelation): void {
    this.peerRelations.set(peerId, relation);
    this.logger.info(
      { event: 'peer_relation_set', peerId, relation },
      `Peer relation set: ${peerId} -> ${relation}`
    );
  }

  /**
   * Current ILP peering relationship for `peerId`, or `undefined` if the peer
   * has not been registered.
   *
   * Exposes the forwarding path's single source of truth for peer relations so
   * the inbound claim validator can mirror {@link requiresSettlementClaim}'s
   * relation-aware logic on the receiving side (issue #78): a child node skips
   * the inline-claim requirement for PREPAREs arriving from its `'parent'`,
   * since the parent forwards value to a child WITHOUT a per-packet claim.
   *
   * @param peerId - Peer id (matches the authenticated inbound peer / route nextHop)
   */
  getPeerRelation(peerId: string): PeerRelation | undefined {
    return this.peerRelations.get(peerId);
  }

  /**
   * Whether a value-bearing forward to `peerId` must carry a mandatory
   * per-packet settlement claim (issue #76).
   *
   * Returns `false` only for a `'child'` next hop — a parent never issues
   * claims down to a child; the child accrues a balance owed up and settles it
   * via its own up-claims. Every other relation (including peers absent from
   * the map, which default to `'peer'`) requires a claim, preserving the
   * pre-issue-76 behavior.
   */
  private requiresSettlementClaim(peerId: string): boolean {
    return this.peerRelations.get(peerId) !== 'child';
  }

  /**
   * Wire the ILP-over-HTTP egress manager (Epic 38, Story 38.1). Called once by
   * ConnectorNode during init. Required before any `'ilp-http'` peer can be
   * forwarded to; an `ilp-http` peer with no egress wired rejects with T00.
   */
  setHttpEgress(httpEgress: PeerEgress): void {
    this.httpEgress = httpEgress;
  }

  /**
   * Record the packet protocol for a next-hop peer (Epic 38, Story 38.1).
   * `'ilp-http'` routes forwards through {@link httpEgress}; `'btp'` (default)
   * keeps the legacy BTP path. Called by ConnectorNode for each configured peer
   * at startup and on every runtime registration.
   */
  setPeerProtocol(peerId: string, protocol: 'btp' | 'ilp-http'): void {
    this.peerProtocols.set(peerId, protocol);
    this.logger.info(
      { event: 'peer_protocol_set', peerId, protocol },
      `Peer protocol set: ${peerId} -> ${protocol}`
    );
  }

  /**
   * Current packet protocol for `peerId`, or `undefined` (treated as `'btp'`)
   * when the peer was registered without an explicit protocol.
   */
  getPeerProtocol(peerId: string): 'btp' | 'ilp-http' | undefined {
    return this.peerProtocols.get(peerId);
  }

  /**
   * Set LocalDeliveryClient for forwarding local packets to app handler
   * @param config - Local delivery configuration
   * @remarks
   * When enabled, packets destined for local addresses (nextHop === nodeId || 'local')
   * are forwarded via HTTP to an external app instead of auto-fulfilling.
   * This allows the app to handle payments.
   */
  setLocalDelivery(config: LocalDeliveryConfig): void {
    if (config.enabled) {
      this.localDeliveryClient = new LocalDeliveryClient(config, this.logger);
      this.logger.info(
        {
          event: 'local_delivery_enabled',
          handlerUrl: config.handlerUrl,
          timeout: config.timeout,
        },
        'Local delivery forwarding enabled'
      );
    } else {
      this.localDeliveryClient = null;
      this.logger.info('Local delivery forwarding disabled (using auto-fulfill stub)');
    }
  }

  /**
   * Set or clear the in-process local delivery function handler.
   * When set, takes priority over HTTP LocalDeliveryClient.
   * @param handler - Function handler or null to clear
   */
  setLocalDeliveryHandler(handler: LocalDeliveryHandler | null): void {
    this.localDeliveryHandler = handler;
    this.logger.info(
      { event: 'local_delivery_handler_set', hasHandler: handler !== null },
      'Local delivery function handler updated'
    );
  }

  /**
   * Set the NIP-59 wrapper and node private key for receiver-side preimage derivation.
   * @param wrapper - NIP-59 claim wrapper instance
   * @param nodePrivateKey - 32-byte secp256k1 private key for ECDH
   */
  setNip59Wrapper(wrapper: NIP59ClaimWrapper, nodePrivateKey: Uint8Array): void {
    this._nip59Wrapper = wrapper;
    this._nodePrivateKey = nodePrivateKey;
  }

  /**
   * Set the ILP observability metrics registry (Story 37.2 — Epic 37).
   *
   * Called by ConnectorNode after the HealthServer / metrics middleware are wired.
   * After this call, `handlePreparePacket` emits per-peer packet / byte counters
   * and lastPacketAt gauge updates consumed by:
   *   - GET /metrics (Prometheus scrape)
   *   - GET /admin/metrics.json (Story 37.3 dashboard endpoint)
   */
  setIlpMetrics(metrics: IlpMetricsRegistry): void {
    this.ilpMetrics = metrics;
    this.logger.info({ event: 'ilp_metrics_enabled' }, 'ILP observability metrics enabled');
  }

  /**
   * Derive fulfillment preimage from NIP-59 wrapped claim in BTP protocolData.
   *
   * Finds the 'claim-wrapped' protocol entry, deserializes to WrappedClaim,
   * and calls unwrapClaimWithPreimage() to derive the ECDH-based preimage.
   *
   * @param protocolData - BTP protocolData array from incoming message
   * @returns 32-byte fulfillment preimage, or undefined if no wrapped claim found
   */
  private _derivePreimageFromProtocolData(
    protocolData?: Array<{ protocolName: string; contentType: number; data: Buffer }>
  ): Uint8Array | undefined {
    if (!this._nip59Wrapper?.isEnabled() || !this._nodePrivateKey || !protocolData) {
      return undefined;
    }

    const wrappedEntry = protocolData.find((p) => p.protocolName === 'claim-wrapped');
    if (!wrappedEntry) {
      return undefined;
    }

    try {
      const wrappedClaim = deserializeWrappedClaim(wrappedEntry.data);
      const result = this._nip59Wrapper.unwrapClaimWithPreimage(wrappedClaim, this._nodePrivateKey);
      return result.fulfillmentPreimage;
    } catch (err) {
      this.logger.warn(
        {
          event: 'preimage_derivation_failed',
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to derive preimage from wrapped claim'
      );
      return undefined;
    }
  }

  /**
   * Check if local delivery forwarding is enabled
   * @returns True if local delivery client is configured and enabled
   */
  private isLocalDeliveryEnabled(): boolean {
    return this.localDeliveryClient !== null && this.localDeliveryClient.isEnabled();
  }

  /**
   * Check if settlement recording is enabled
   * @returns True if settlement recording is enabled, false otherwise
   * @remarks
   * Settlement is enabled when BOTH conditions are met:
   * 1. AccountManager is provided (not null)
   * 2. SettlementConfig.enableSettlement is true
   *
   * This method is used throughout packet handling to determine if
   * settlement transfers should be recorded in TigerBeetle.
   */
  private isSettlementEnabled(): boolean {
    return this.accountManager !== null && this.settlementConfig?.enableSettlement === true;
  }

  /**
   * Generate deterministic transfer ID from packet data and direction
   *
   * TigerBeetle requires unique 128-bit transfer IDs. We derive them from a
   * SHA-256 hash of the packet data combined with a direction indicator to ensure:
   * 1. Uniqueness: SHA-256 of packet data is cryptographically unique
   * 2. Determinism: same packet+direction always generates same transfer ID
   * 3. Idempotency: safe to retry transfer creation
   *
   * @param packetData - Packet's application data payload
   * @param direction - 'incoming' or 'outgoing' to differentiate the two transfers
   * @returns 128-bit transfer ID as bigint
   * @private
   */
  private generateTransferId(packetData: Buffer, direction: 'incoming' | 'outgoing'): bigint {
    // Hash packet data to get a 32-byte digest for transfer ID derivation
    const dataHash = crypto.createHash('sha256').update(packetData).digest();

    // Generate unique transfer IDs per connector by incorporating nodeId
    // This ensures each connector in a multi-hop chain has unique transfer IDs
    const directionByte = direction === 'incoming' ? 0x01 : 0x02;

    // Hash nodeId to get a consistent numeric value
    const nodeIdHash = Buffer.alloc(8);
    let hash = 0;
    for (let i = 0; i < this.nodeId.length; i++) {
      hash = ((hash << 5) - hash + this.nodeId.charCodeAt(i)) | 0;
    }
    nodeIdHash.writeBigUInt64BE((BigInt(hash >>> 0) << 32n) | BigInt(hash >>> 0), 0);

    // Read first 16 bytes of data hash as two 64-bit values
    const high = dataHash.readBigUInt64BE(0);
    const low = dataHash.readBigUInt64BE(8);

    // XOR with nodeId hash to make unique per connector
    const nodeIdValue = nodeIdHash.readBigUInt64BE(0);

    // Combine into 128-bit value with nodeId and direction differentiation
    const transferId = ((high ^ nodeIdValue) << 64n) | low;
    return transferId ^ BigInt(directionByte);
  }

  /**
   * Calculate connector fee for a packet amount
   * @param amount - Packet amount in smallest currency units (bigint)
   * @param feePercentage - Fee percentage (e.g., 0.1 = 0.1%)
   * @returns Fee amount in smallest currency units (bigint)
   * @remarks
   * Uses integer arithmetic to avoid floating-point precision issues.
   *
   * Fee calculation uses basis points conversion:
   * - 0.1% = 10 basis points = 10/10000
   * - Formula: fee = (amount × (feePercentage × 100)) / 10000
   *
   * Examples:
   * - amount=1000n, feePercentage=0.1 → fee=1n (0.1% of 1000)
   * - amount=100000n, feePercentage=0.1 → fee=100n (0.1% of 100000)
   * - amount=999n, feePercentage=0.1 → fee=0n (rounds down)
   *
   * Integer division rounds DOWN (floor division), which is acceptable:
   * connectors don't charge fees on very small packets (benefits micropayments).
   *
   * @throws {Error} if amount is negative or feePercentage is negative
   */
  private calculateConnectorFee(amount: bigint, feePercentage: number): bigint {
    // Input validation
    if (amount < 0n) {
      throw new Error(`Invalid amount: ${amount} (must be >= 0)`);
    }
    if (feePercentage < 0) {
      throw new Error(`Invalid fee percentage: ${feePercentage} (must be >= 0)`);
    }

    // Convert percentage to basis points (0.1% = 10 basis points)
    const basisPoints = Math.floor(feePercentage * 100);

    // Calculate fee using integer arithmetic: fee = (amount × basisPoints) / 10000
    const fee = (amount * BigInt(basisPoints)) / 10000n;

    return fee;
  }

  /**
   * Record packet transfers atomically in TigerBeetle (dual-leg double-entry)
   * @param packet - ILP Prepare packet being forwarded
   * @param fromPeerId - Peer ID who sent us the packet
   * @param toPeerId - Peer ID we're forwarding to
   * @param forwardedAmount - Amount forwarded after fee deduction
   * @param connectorFee - Connector fee collected
   * @param correlationId - Correlation ID for log tracing
   * @throws {Error} if settlement recording fails
   * @remarks
   * Records TWO transfers atomically in TigerBeetle:
   * 1. Incoming transfer: Debit peer's CREDIT account (peer owes us)
   * 2. Outgoing transfer: Credit peer's DEBIT account (we owe peer)
   *
   * Both transfers succeed or both fail (ACID guarantee via TigerBeetle batch API).
   * If settlement fails, packet forwarding is rejected with T00_INTERNAL_ERROR.
   *
   * Transfer IDs are deterministically generated from execution condition to enable
   * idempotent retries.
   */
  private async recordPacketTransfers(
    packet: ILPPreparePacket,
    fromPeerId: string,
    toPeerId: string,
    forwardedAmount: bigint,
    connectorFee: bigint,
    correlationId: string
  ): Promise<void> {
    if (!this.isSettlementEnabled()) {
      return;
    }

    const packetId = crypto.createHash('sha256').update(packet.data).digest('hex').slice(0, 16);

    this.logger.debug(
      {
        correlationId,
        packetId,
        fromPeerId,
        toPeerId,
        originalAmount: packet.amount.toString(),
        forwardedAmount: forwardedAmount.toString(),
        connectorFee: connectorFee.toString(),
      },
      'Processing settlement for packet'
    );

    try {
      // Generate deterministic transfer IDs for incoming and outgoing transfers
      const incomingTransferId = this.generateTransferId(packet.data, 'incoming');
      const outgoingTransferId = this.generateTransferId(packet.data, 'outgoing');

      // Record both transfers atomically via AccountManager
      // This posts two TigerBeetle transfers in a single batch:
      // 1. Incoming: Debit fromPeer's DEBIT account (increase "peer owes us")
      // 2. Outgoing: Credit toPeer's CREDIT account (increase "we owe peer")
      await this.accountManager!.recordPacketTransfers(
        fromPeerId,
        toPeerId,
        this.defaultTokenId,
        packet.amount, // incoming amount
        forwardedAmount, // outgoing amount (after fee)
        incomingTransferId,
        outgoingTransferId,
        AccountLedgerCodes.DEFAULT_LEDGER,
        1 // transfer code (future: differentiate packet types)
      );

      // Log settlement success
      this.logger.info(
        {
          correlationId,
          packetId,
          fromPeerId,
          toPeerId,
          originalAmount: packet.amount.toString(),
          forwardedAmount: forwardedAmount.toString(),
          connectorFee: connectorFee.toString(),
        },
        'Settlement transfers recorded: incoming={originalAmount} from {fromPeerId}, outgoing={forwardedAmount} to {toPeerId}, fee={connectorFee}'
      );
    } catch (error) {
      this.logger.error(
        {
          correlationId,
          error: error instanceof Error ? error.message : String(error),
          packetId,
          fromPeerId,
          toPeerId,
        },
        'Settlement recording failed: {error}, rejecting packet with T00_INTERNAL_ERROR'
      );
      throw error;
    }
  }

  /**
   * Validate ILP Prepare packet structure and expiration
   * @param packet - ILP Prepare packet to validate
   * @returns Validation result with isValid flag and optional error details
   * @remarks
   * Validates per RFC-0027:
   * - All required fields present (amount, destination, expiresAt, data)
   * - Destination is valid ILP address format per RFC-0015
   * - Packet has not expired (current time < expiresAt)
   */
  validatePacket(packet: ILPPreparePacket): ValidationResult {
    // Check all required fields present
    if (packet.amount === undefined || !packet.destination || !packet.expiresAt || !packet.data) {
      this.logger.error(
        {
          packetType: packet.type,
          hasAmount: packet.amount !== undefined,
          hasDestination: !!packet.destination,
          hasExpiresAt: !!packet.expiresAt,
          hasData: !!packet.data,
          errorCode: ILPErrorCode.F01_INVALID_PACKET,
        },
        'Packet validation failed: missing required fields'
      );
      return {
        isValid: false,
        errorCode: ILPErrorCode.F01_INVALID_PACKET,
        errorMessage: 'Missing required packet fields',
      };
    }

    // Validate destination ILP address format
    if (!isValidILPAddress(packet.destination)) {
      this.logger.error(
        {
          destination: packet.destination,
          errorCode: ILPErrorCode.F01_INVALID_PACKET,
        },
        'Packet validation failed: invalid ILP address format'
      );
      return {
        isValid: false,
        errorCode: ILPErrorCode.F01_INVALID_PACKET,
        errorMessage: `Invalid ILP address format: ${packet.destination}`,
      };
    }

    // Check if packet has expired
    const currentTime = new Date();
    if (packet.expiresAt <= currentTime) {
      this.logger.error(
        {
          expiresAt: packet.expiresAt.toISOString(),
          currentTime: currentTime.toISOString(),
          errorCode: ILPErrorCode.R00_TRANSFER_TIMED_OUT,
        },
        'Packet validation failed: packet has expired'
      );
      return {
        isValid: false,
        errorCode: ILPErrorCode.R00_TRANSFER_TIMED_OUT,
        errorMessage: 'Packet has expired',
      };
    }

    return { isValid: true };
  }

  /**
   * Decrement packet expiry by safety margin
   * @param expiresAt - Original expiration timestamp
   * @param safetyMargin - Safety margin in milliseconds to subtract
   * @returns New expiration timestamp with safety margin applied
   * @remarks
   * Per RFC-0027, connectors must decrement expiry to prevent timeout during forwarding.
   * Returns null if decremented expiry would be in the past.
   */
  decrementExpiry(expiresAt: Date, safetyMargin: number): Date | null {
    const newExpiry = new Date(expiresAt.getTime() - safetyMargin);
    const currentTime = new Date();

    if (newExpiry <= currentTime) {
      this.logger.debug(
        {
          originalExpiry: expiresAt.toISOString(),
          decrementedExpiry: newExpiry.toISOString(),
          currentTime: currentTime.toISOString(),
          safetyMargin,
        },
        'Expiry decrement would create past timestamp'
      );
      return null;
    }

    this.logger.debug(
      {
        originalExpiry: expiresAt.toISOString(),
        newExpiry: newExpiry.toISOString(),
        safetyMargin,
      },
      'Decremented packet expiry'
    );

    return newExpiry;
  }

  /**
   * Generate ILP Reject packet
   * @param code - ILP error code per RFC-0027
   * @param message - Human-readable error description
   * @param triggeredBy - Address of connector that generated error
   * @returns ILP Reject packet
   * @remarks
   * Generates reject packet per RFC-0027 Section 3.3 with standard error codes:
   * - R00: Transfer Timed Out (packet expired)
   * - F02: Unreachable (no route to destination)
   * - F01: Invalid Packet (malformed packet)
   */
  generateReject(code: ILPErrorCode, message: string, triggeredBy: string): ILPRejectPacket {
    this.logger.info(
      {
        errorCode: code,
        message,
        triggeredBy,
      },
      'Generated reject packet'
    );

    return {
      type: PacketType.REJECT,
      code,
      triggeredBy,
      message,
      data: Buffer.alloc(0),
    };
  }

  /**
   * Convert LocalDeliveryResponse to ILP packet.
   * Handles fulfill, reject, and invalid (neither) cases.
   */
  private convertLocalDeliveryResponse(
    result: LocalDeliveryResponse
  ): ILPFulfillPacket | ILPRejectPacket {
    if (result.fulfill) {
      return {
        type: PacketType.FULFILL,
        data: result.fulfill.data ? Buffer.from(result.fulfill.data, 'base64') : Buffer.alloc(0),
      };
    } else if (result.reject) {
      return {
        type: PacketType.REJECT,
        code: (result.reject.code as ILPErrorCode) || ILPErrorCode.F99_APPLICATION_ERROR,
        triggeredBy: this.nodeId,
        message: result.reject.message || 'Rejected by agent',
        data: result.reject.data ? Buffer.from(result.reject.data, 'base64') : Buffer.alloc(0),
      };
    } else {
      return this.generateReject(
        ILPErrorCode.T00_INTERNAL_ERROR,
        'Invalid response from local delivery handler',
        this.nodeId
      );
    }
  }

  /**
   * Forward packet to next-hop peer via BTP
   * @param packet - ILP Prepare packet to forward
   * @param nextHop - Peer identifier to forward to
   * @param correlationId - Correlation ID for tracking packet across logs
   * @returns ILP response packet (Fulfill or Reject) from next-hop peer
   * @throws BTPConnectionError if BTP connection fails
   * @throws BTPAuthenticationError if BTP authentication fails
   * @remarks
   * Forwards packet to next-hop peer using BTPClientManager.
   * Maps BTP errors to ILP error codes:
   * - BTPConnectionError → T01 (Ledger Unreachable)
   * - BTPAuthenticationError → T01 (Ledger Unreachable)
   * - BTP timeout → T00 (Transfer Timed Out)
   */
  private async forwardToNextHop(
    packet: ILPPreparePacket,
    nextHop: string,
    correlationId: string,
    protocolData?: Array<{ protocolName: string; contentType: number; data: Buffer }>
  ): Promise<ILPFulfillPacket | ILPRejectPacket> {
    // Epic 38, Story 38.1: dispatch on the peer's packet protocol BEFORE any BTP
    // connectivity checks. An 'ilp-http' peer forwards via the HTTP egress and
    // never touches the BTP client/server seam below. A 'btp' peer (the default
    // when unset) takes the unchanged legacy path — AC5: byte-for-byte identical.
    if (this.peerProtocols.get(nextHop) === 'ilp-http') {
      return this.forwardViaHttp(packet, nextHop, correlationId, protocolData);
    }

    this.logger.info(
      {
        correlationId,
        event: 'btp_forward',
        destination: packet.destination,
        amount: packet.amount.toString(),
        peerId: nextHop,
      },
      'Forwarding packet to peer via BTP'
    );

    try {
      // Select transport connection upfront: prefer outbound client, fall back to server.
      // We check connectivity BEFORE sending to avoid catch-and-retry, which risks
      // duplicate packets if the first send times out but the packet was already received.
      let response: ILPFulfillPacket | ILPRejectPacket;

      const hasOutbound = this.btpClientManager.isConnected(nextHop);
      const hasInbound = this.btpServer?.hasPeer(nextHop) ?? false;

      if (hasOutbound) {
        response = await this.btpClientManager.sendToPeer(nextHop, packet, protocolData);
        this.logger.debug(
          { correlationId, peerId: nextHop },
          'Forwarded via outbound peer connection'
        );
      } else if (hasInbound) {
        this.logger.debug(
          { correlationId, peerId: nextHop },
          'No outbound connection, using incoming peer connection'
        );
        response = await this.btpServer!.sendPacketToPeer(nextHop, packet, protocolData);
        this.logger.debug(
          { correlationId, peerId: nextHop },
          'Forwarded via incoming peer connection'
        );
      } else {
        throw new BTPConnectionError(`No active BTP connection to peer ${nextHop}`);
      }

      this.logger.info(
        {
          correlationId,
          event: 'btp_forward_success',
          peerId: nextHop,
          responseType: response.type,
        },
        'Received response from peer via BTP'
      );

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Map BTP errors to ILP error codes
      if (error instanceof BTPConnectionError) {
        this.logger.error(
          {
            correlationId,
            event: 'btp_connection_error',
            peerId: nextHop,
            error: errorMessage,
          },
          'BTP connection failed'
        );
        return this.generateReject(
          ILPErrorCode.T01_PEER_UNREACHABLE,
          `BTP connection to ${nextHop} failed: ${errorMessage}`,
          this.nodeId
        );
      }

      if (error instanceof BTPAuthenticationError) {
        this.logger.error(
          {
            correlationId,
            event: 'btp_auth_error',
            peerId: nextHop,
            error: errorMessage,
          },
          'BTP authentication failed'
        );
        return this.generateReject(
          ILPErrorCode.T01_PEER_UNREACHABLE,
          `BTP authentication to ${nextHop} failed: ${errorMessage}`,
          this.nodeId
        );
      }

      // Check if timeout error
      if (errorMessage.includes('timeout')) {
        this.logger.error(
          {
            correlationId,
            event: 'btp_timeout',
            peerId: nextHop,
            error: errorMessage,
          },
          'BTP packet send timeout'
        );
        return this.generateReject(
          ILPErrorCode.R00_TRANSFER_TIMED_OUT,
          `BTP timeout to ${nextHop}: ${errorMessage}`,
          this.nodeId
        );
      }

      // Unknown error - log and rethrow
      this.logger.error(
        {
          correlationId,
          event: 'btp_forward_error',
          peerId: nextHop,
          error: errorMessage,
        },
        'Unexpected error forwarding packet via BTP'
      );
      throw error;
    }
  }

  /**
   * Forward a PREPARE to an ILP-over-HTTP peer (Epic 38, Story 38.1).
   *
   * Symmetric counterpart of {@link forwardToNextHop}'s BTP path: emits the
   * `POST /ilp` the peer's {@link IlpHttpAdapter} ingress accepts and maps
   * transport failures to ILP rejects identically to the BTP map:
   * - connection error → T01 ({@link HttpPeerConnectionError}),
   * - timeout → R00 ({@link HttpPeerTimeoutError}),
   * - missing egress wiring → T00 (misconfiguration).
   *
   * @returns The peer's FULFILL/REJECT (HTTP-non-2xx already synthesized to a
   *   reject inside the egress manager).
   */
  private async forwardViaHttp(
    packet: ILPPreparePacket,
    nextHop: string,
    correlationId: string,
    protocolData?: Array<{ protocolName: string; contentType: number; data: Buffer }>
  ): Promise<ILPFulfillPacket | ILPRejectPacket> {
    this.logger.info(
      {
        correlationId,
        event: 'http_forward',
        destination: packet.destination,
        amount: packet.amount.toString(),
        peerId: nextHop,
      },
      'Forwarding packet to peer via ILP-over-HTTP'
    );

    if (!this.httpEgress) {
      this.logger.error(
        { correlationId, event: 'http_egress_unwired', peerId: nextHop },
        'ILP-over-HTTP egress not configured but peer requires it'
      );
      return this.generateReject(
        ILPErrorCode.T00_INTERNAL_ERROR,
        `ILP-over-HTTP egress not configured for peer ${nextHop}`,
        this.nodeId
      );
    }

    try {
      const response = await this.httpEgress.sendToPeer(nextHop, packet, protocolData);
      this.logger.info(
        {
          correlationId,
          event: 'http_forward_success',
          peerId: nextHop,
          responseType: response.type,
        },
        'Received response from peer via ILP-over-HTTP'
      );
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (error instanceof HttpPeerTimeoutError) {
        this.logger.error(
          { correlationId, event: 'http_timeout', peerId: nextHop, error: errorMessage },
          'ILP-over-HTTP packet send timeout'
        );
        return this.generateReject(
          ILPErrorCode.R00_TRANSFER_TIMED_OUT,
          `HTTP timeout to ${nextHop}: ${errorMessage}`,
          this.nodeId
        );
      }

      if (error instanceof HttpPeerConnectionError) {
        this.logger.error(
          { correlationId, event: 'http_connection_error', peerId: nextHop, error: errorMessage },
          'ILP-over-HTTP connection failed'
        );
        return this.generateReject(
          ILPErrorCode.T01_PEER_UNREACHABLE,
          `HTTP connection to ${nextHop} failed: ${errorMessage}`,
          this.nodeId
        );
      }

      this.logger.error(
        { correlationId, event: 'http_forward_error', peerId: nextHop, error: errorMessage },
        'Unexpected error forwarding packet via ILP-over-HTTP'
      );
      throw error;
    }
  }

  /**
   * Handle ILP Prepare packet - main packet processing method
   * @param packet - ILP Prepare packet to process
   * @returns Promise resolving to ILP Fulfill or Reject packet
   * @remarks
   * Complete packet handling flow per RFC-0027:
   * 1. Validate packet structure and expiration
   * 2. Look up next-hop peer using routing table
   * 3. Decrement packet expiry by safety margin
   * 4. Forward to next-hop peer (stub for Epic 1)
   * 5. Return fulfill/reject based on processing result
   *
   * Generates correlation ID for packet tracking across logs.
   */
  async handlePreparePacket(
    packet: ILPPreparePacket,
    fromPeerId?: string,
    incomingProtocolData?: Array<{ protocolName: string; contentType: number; data: Buffer }>
  ): Promise<ILPFulfillPacket | ILPRejectPacket> {
    const correlationId = generateCorrelationId();
    const sourcePeerId = fromPeerId || 'unknown';

    this.logger.info(
      {
        correlationId,
        packetType: 'PREPARE',
        destination: packet.destination,
        amount: packet.amount.toString(),
        fromPeerId: sourcePeerId,
        timestamp: Date.now(),
      },
      'Packet received'
    );

    // Story 37.2: record inbound attribution (no-op when sourcePeerId is 'unknown').
    this.ilpMetrics?.recordInbound(sourcePeerId, packet.data.byteLength);

    // Validate packet
    const validation = this.validatePacket(packet);
    if (!validation.isValid) {
      this.logger.error(
        {
          correlationId,
          packetType: 'REJECT',
          destination: packet.destination,
          errorCode: validation.errorCode,
          reason: validation.errorMessage,
          timestamp: Date.now(),
        },
        'Packet rejected'
      );
      this.ilpMetrics?.recordPreRoutingReject('validation_failed');
      return this.generateReject(validation.errorCode!, validation.errorMessage!, this.nodeId);
    }

    // Look up next-hop peer
    const nextHop = this.routingTable.getNextHop(packet.destination);
    if (nextHop === null) {
      this.logger.info(
        {
          correlationId,
          destination: packet.destination,
          selectedPeer: null,
          reason: 'no route found',
        },
        'Routing decision'
      );

      this.logger.error(
        {
          correlationId,
          packetType: 'REJECT',
          destination: packet.destination,
          errorCode: ILPErrorCode.F02_UNREACHABLE,
          reason: 'no route found',
          timestamp: Date.now(),
        },
        'Packet rejected'
      );
      this.ilpMetrics?.recordPreRoutingReject('no_route');
      return this.generateReject(
        ILPErrorCode.F02_UNREACHABLE,
        `No route to destination: ${packet.destination}`,
        this.nodeId
      );
    }

    this.logger.info(
      {
        correlationId,
        destination: packet.destination,
        selectedPeer: nextHop,
        reason: 'longest-prefix match',
      },
      'Routing decision'
    );

    // Check for local delivery (destination handled by this connector)
    if (nextHop === this.nodeId || nextHop === 'local') {
      this.logger.info(
        {
          correlationId,
          destination: packet.destination,
          reason: 'local delivery',
        },
        'Delivering packet locally'
      );

      // Derive preimage from incoming NIP-59 wrapped claim (if present)
      const preimage = this._derivePreimageFromProtocolData(incomingProtocolData);

      // Check for function handler first (in-process delivery, no HTTP)
      if (this.localDeliveryHandler) {
        const request: LocalDeliveryRequest = {
          destination: packet.destination,
          amount: packet.amount.toString(),

          expiresAt: packet.expiresAt.toISOString(),
          data: packet.data.toString('base64'),
          sourcePeer: sourcePeerId,
        };
        let localResponse: ILPFulfillPacket | ILPRejectPacket;
        try {
          const result = await this.localDeliveryHandler(request, sourcePeerId);
          localResponse = this.convertLocalDeliveryResponse(result);
          if (localResponse.type === PacketType.FULFILL && preimage) {
            (localResponse as ILPFulfillPacket).fulfillment = preimage;
          }
        } catch (error) {
          localResponse = this.generateReject(
            ILPErrorCode.T00_INTERNAL_ERROR,
            `Local delivery handler error: ${error instanceof Error ? error.message : String(error)}`,
            this.nodeId
          );
        }
        if (localResponse.type === PacketType.FULFILL) {
          this.ilpMetrics?.recordLocalDeliver(sourcePeerId);
        }
        return localResponse;
      }

      // If local delivery client is enabled, forward to app handler via HTTP
      if (this.isLocalDeliveryEnabled() && this.localDeliveryClient) {
        this.logger.debug(
          { correlationId, destination: packet.destination },
          'Forwarding to app handler for local delivery'
        );

        const response = await this.localDeliveryClient.deliver(packet, sourcePeerId);

        // Inject preimage into FULFILL (app handler doesn't have NIP-59 keys)
        if (response.type === PacketType.FULFILL && preimage) {
          (response as ILPFulfillPacket).fulfillment = preimage;
        }

        this.logger.info(
          {
            correlationId,
            event: 'packet_response',
            packetType: response.type,
            destination: packet.destination,
            timestamp: Date.now(),
          },
          response.type === PacketType.FULFILL
            ? 'Packet fulfilled by app handler'
            : 'Packet rejected by app handler'
        );

        if (response.type === PacketType.FULFILL) {
          this.ilpMetrics?.recordLocalDeliver(sourcePeerId);
        }
        return response;
      }

      // Fallback: auto-fulfill local packets (educational/testing purposes)
      const fulfillPacket: ILPFulfillPacket = {
        type: PacketType.FULFILL,
        fulfillment: preimage,
        data: Buffer.from('Local delivery - auto-fulfill stub'),
      };

      this.logger.info(
        {
          correlationId,
          event: 'packet_response',
          packetType: PacketType.FULFILL,
          destination: packet.destination,
          timestamp: Date.now(),
        },
        'Returning local fulfillment (auto-fulfill stub)'
      );

      this.ilpMetrics?.recordLocalDeliver(sourcePeerId);
      return fulfillPacket;
    }

    // Decrement expiry
    const newExpiry = this.decrementExpiry(packet.expiresAt, EXPIRY_SAFETY_MARGIN_MS);
    if (newExpiry === null) {
      this.logger.error(
        {
          correlationId,
          packetType: 'REJECT',
          destination: packet.destination,
          errorCode: ILPErrorCode.R00_TRANSFER_TIMED_OUT,
          expiresAt: packet.expiresAt.toISOString(),
          reason: 'Insufficient time remaining for forwarding',
          timestamp: Date.now(),
        },
        'Packet rejected'
      );
      this.ilpMetrics?.recordPreRoutingReject('expiry_too_short');
      return this.generateReject(
        ILPErrorCode.R00_TRANSFER_TIMED_OUT,
        'Insufficient time remaining for forwarding',
        this.nodeId
      );
    }

    // SETTLEMENT RECORDING (Story 6.4) - Calculate connector fee and record transfers
    let forwardingPacket: ILPPreparePacket;

    // Skip settlement and fees for local delivery
    const isLocalDelivery = nextHop === 'local';

    if (this.isSettlementEnabled() && !isLocalDelivery) {
      // Calculate connector fee
      const connectorFee = this.calculateConnectorFee(
        packet.amount,
        this.settlementConfig?.connectorFeePercentage ?? 0.1
      );
      const forwardedAmount = packet.amount - connectorFee;

      this.logger.debug(
        {
          correlationId,
          originalAmount: packet.amount.toString(),
          connectorFee: connectorFee.toString(),
          forwardedAmount: forwardedAmount.toString(),
          feePercentage: this.settlementConfig?.connectorFeePercentage,
        },
        'Calculated connector fee'
      );

      // CREDIT LIMIT CHECK (Story 6.5) - Check if incoming transfer would exceed credit limit
      // Check BEFORE settlement recording (fail-safe design)
      const fromPeerId = 'unknown'; // TODO: Pass actual incoming peer ID in future enhancement
      const tokenId = this.defaultTokenId;

      const creditLimitViolation = await this.accountManager!.checkCreditLimit(
        fromPeerId,
        tokenId,
        packet.amount
      );

      if (creditLimitViolation) {
        // Credit limit would be exceeded - reject packet with T04_INSUFFICIENT_LIQUIDITY
        this.logger.warn(
          {
            correlationId,
            packetType: 'REJECT',
            destination: packet.destination,
            errorCode: ILPErrorCode.T04_INSUFFICIENT_LIQUIDITY,
            fromPeerId: creditLimitViolation.peerId,
            currentBalance: creditLimitViolation.currentBalance.toString(),
            requestedAmount: creditLimitViolation.requestedAmount.toString(),
            creditLimit: creditLimitViolation.creditLimit.toString(),
            wouldExceedBy: creditLimitViolation.wouldExceedBy.toString(),
            reason: 'Credit limit exceeded',
            timestamp: Date.now(),
          },
          'Packet rejected: credit limit exceeded'
        );

        this.ilpMetrics?.recordPreRoutingReject('credit_limit_exceeded');
        return this.generateReject(
          ILPErrorCode.T04_INSUFFICIENT_LIQUIDITY,
          `Credit limit exceeded: peer ${fromPeerId} would owe ${creditLimitViolation.wouldExceedBy} units over limit of ${creditLimitViolation.creditLimit}`,
          this.nodeId
        );
      }

      // Record settlement transfers atomically BEFORE forwarding packet
      // Skip settlement for unknown/unregistered peers or zero-amount packets
      if (sourcePeerId !== 'unknown' && packet.amount > 0n && forwardedAmount > 0n) {
        try {
          await this.recordPacketTransfers(
            packet,
            sourcePeerId,
            nextHop,
            forwardedAmount,
            connectorFee,
            correlationId
          );
        } catch (error) {
          // Settlement recording failed - reject packet with T00_INTERNAL_ERROR
          this.logger.error(
            {
              correlationId,
              packetType: 'REJECT',
              destination: packet.destination,
              errorCode: ILPErrorCode.T00_INTERNAL_ERROR,
              error: error instanceof Error ? error.message : String(error),
              reason: 'Settlement recording failed',
              timestamp: Date.now(),
            },
            'Packet rejected due to settlement failure'
          );
          this.ilpMetrics?.recordPreRoutingReject('settlement_recording_failed');
          return this.generateReject(
            ILPErrorCode.T00_INTERNAL_ERROR,
            'Settlement recording failed',
            this.nodeId
          );
        }
      } else {
        this.logger.debug(
          {
            correlationId,
            sourcePeerId,
            reason: 'Skipping settlement for unknown peer',
          },
          'Settlement skipped for unregistered peer'
        );
      }

      // Create forwarding packet with decremented expiry AND reduced amount (after fee)
      forwardingPacket = {
        ...packet,
        expiresAt: newExpiry,
        amount: forwardedAmount,
      };
    } else {
      // Settlement disabled - forward original amount
      forwardingPacket = {
        ...packet,
        expiresAt: newExpiry,
      };
    }

    // Fire-and-forget app notification for transit packets (per-hop notification)
    const perHopEnabled = this.localDeliveryClient?.isPerHopNotificationEnabled() ?? false;
    if (perHopEnabled) {
      if (this.localDeliveryHandler) {
        // In-process handler path (takes priority over HTTP)
        const transitRequest: LocalDeliveryRequest = {
          destination: packet.destination,
          amount: packet.amount.toString(),

          expiresAt: packet.expiresAt.toISOString(),
          data: packet.data.toString('base64'),
          sourcePeer: sourcePeerId,
          isTransit: true,
        };
        this.localDeliveryHandler(transitRequest, sourcePeerId).catch((err: unknown) => {
          this.logger.debug(
            {
              error: err instanceof Error ? err.message : String(err),
              destination: packet.destination,
            },
            'Per-hop notification failed (fire-and-forget, in-process)'
          );
        });
      } else if (this.isLocalDeliveryEnabled() && this.localDeliveryClient) {
        // HTTP client path
        this.localDeliveryClient
          .deliver(packet, sourcePeerId, { isTransit: true })
          .catch((err: unknown) => {
            this.logger.debug(
              {
                error: err instanceof Error ? err.message : String(err),
                destination: packet.destination,
              },
              'Per-hop notification failed (fire-and-forget, HTTP)'
            );
          });
      }
    }

    // Generate mandatory per-packet claim before forwarding to peer.
    //
    // The claim is relationship-aware (issue #76): it is required for every
    // value-bearing forward to a non-`local`, non-`child` next hop. A `'child'`
    // next hop is skipped — a parent settles DOWN to a child by letting the
    // child accrue a balance owed up (the child settles via its own up-claims),
    // so issuing a pay-the-child claim here is incorrect ILP semantics and
    // would reject the packet with T00 whenever no pay-the-child channel exists.
    let claimProtocolData:
      | Array<{ protocolName: string; contentType: number; data: Buffer }>
      | undefined;
    const claimRequired =
      !isLocalDelivery && forwardingPacket.amount > 0n && this.requiresSettlementClaim(nextHop);
    if (!isLocalDelivery && forwardingPacket.amount > 0n && !claimRequired) {
      this.logger.debug(
        {
          correlationId,
          peerId: nextHop,
          relation: this.peerRelations.get(nextHop),
        },
        'Skipping per-packet claim for child next hop (child settles up to parent)'
      );
    }
    if (claimRequired) {
      if (!this.perPacketClaimService) {
        this.logger.error(
          {
            correlationId,
            peerId: nextHop,
            errorCode: ILPErrorCode.T00_INTERNAL_ERROR,
          },
          'Per-packet claim service not configured'
        );
        this.ilpMetrics?.recordPreRoutingReject('claim_generation_failed');
        return this.generateReject(
          ILPErrorCode.T00_INTERNAL_ERROR,
          'Per-packet claim service not configured',
          this.nodeId
        );
      }

      try {
        const result = await this.perPacketClaimService.generateClaimForPacket(
          nextHop,
          this.defaultTokenId,
          forwardingPacket.amount
        );
        if (!result) {
          this.logger.error(
            {
              correlationId,
              peerId: nextHop,
              errorCode: ILPErrorCode.T00_INTERNAL_ERROR,
            },
            'No payment channel available for peer'
          );
          this.ilpMetrics?.recordPreRoutingReject('claim_generation_failed');
          return this.generateReject(
            ILPErrorCode.T00_INTERNAL_ERROR,
            'No payment channel available for peer',
            this.nodeId
          );
        }
        claimProtocolData = [result.protocolData];
        // Set execution condition on forwarding packet if condition derivation is active
        // Only if the packet doesn't already carry a condition from upstream (intermediary case)
        if (
          result.executionCondition &&
          (!forwardingPacket.executionCondition ||
            Buffer.from(forwardingPacket.executionCondition).every((b) => b === 0))
        ) {
          forwardingPacket = { ...forwardingPacket, executionCondition: result.executionCondition };
        }
      } catch (error) {
        this.logger.error(
          {
            correlationId,
            peerId: nextHop,
            error: error instanceof Error ? error.message : String(error),
            errorCode: ILPErrorCode.T00_INTERNAL_ERROR,
          },
          'Claim generation failed'
        );
        this.ilpMetrics?.recordPreRoutingReject('claim_generation_failed');
        return this.generateReject(
          ILPErrorCode.T00_INTERNAL_ERROR,
          'Claim generation failed',
          this.nodeId
        );
      }
    }

    // Forward to next hop via BTP and return response.
    // Story 37.2: `response` is mutable so that fulfillment-verification failures below
    // transform the outcome in-place, and the single end-of-method instrumentation block
    // sees the final (possibly transformed) response. Previously this block had two
    // early `return this.generateReject(...)` paths; those have been rewritten to
    // reassign `response` and fall through, so metrics attribution happens in exactly
    // one place for every non-pre-routing outcome.
    let response: ILPFulfillPacket | ILPRejectPacket = await this.forwardToNextHop(
      forwardingPacket,
      nextHop,
      correlationId,
      claimProtocolData
    );

    // Verify fulfillment against execution condition (sender + intermediary role)
    if (
      response.type === PacketType.FULFILL &&
      forwardingPacket.executionCondition &&
      !Buffer.from(forwardingPacket.executionCondition).every((b) => b === 0)
    ) {
      const fulfillmentBytes = (response as ILPFulfillPacket).fulfillment;
      if (!fulfillmentBytes || Buffer.from(fulfillmentBytes).every((b) => b === 0)) {
        this.logger.error(
          {
            correlationId,
            event: 'fulfillment_missing',
            peerId: nextHop,
          },
          'FULFILL missing fulfillment but execution condition is present'
        );
        response = this.generateReject(
          ILPErrorCode.F99_APPLICATION_ERROR,
          'Fulfillment does not match execution condition',
          this.nodeId
        );
      } else {
        const expectedCondition = sha256(new Uint8Array(fulfillmentBytes));
        if (
          !Buffer.from(expectedCondition).equals(Buffer.from(forwardingPacket.executionCondition))
        ) {
          this.logger.error(
            {
              correlationId,
              event: 'fulfillment_verification_failed',
              peerId: nextHop,
            },
            'Fulfillment does not match execution condition'
          );
          response = this.generateReject(
            ILPErrorCode.F99_APPLICATION_ERROR,
            'Fulfillment does not match execution condition',
            this.nodeId
          );
        }
      }
    }

    // Story 37.2: per-peer forward-outcome attribution. `bytesSent` uses the forwarding
    // packet's data byteLength as a proxy for wire bytes — BTP/ILP framing adds a small
    // constant overhead we intentionally ignore here for simplicity and stability.
    const outBytes = forwardingPacket.data.byteLength;
    if (response.type === PacketType.FULFILL) {
      this.ilpMetrics?.recordForwardFulfill(nextHop, outBytes);
    } else {
      this.ilpMetrics?.recordForwardReject(nextHop, outBytes);
    }

    this.logger.info(
      {
        correlationId,
        event: 'packet_response',
        packetType: response.type,
        destination: packet.destination,
        code: response.type === PacketType.REJECT ? response.code : undefined,
        timestamp: Date.now(),
      },
      'Returning packet response'
    );

    return response;
  }
}
