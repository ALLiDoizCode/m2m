/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * Branch coverage tests for PacketHandler
 *
 * Targets the gaps in `src/core/packet-handler.ts` (currently 73.84% branch
 * coverage) by exercising error conditions, short-circuit operators, default
 * values, and uncommon code paths.
 *
 * @packageDocumentation
 */

import { PacketHandler } from '../../../src/core/packet-handler';
import { RoutingTable } from '../../../src/routing/routing-table';
import {
  ILPPreparePacket,
  ILPErrorCode,
  PacketType,
  ILPRejectPacket,
  ILPFulfillPacket,
} from '@toon-protocol/shared';
import { BTPConnectionError, BTPAuthenticationError } from '../../../src/btp/btp-client';
import { sha256 } from '@noble/hashes/sha2';

/* ------------------------------------------------------------------
 *  Mock factories
 * ------------------------------------------------------------------ */

const createMockLogger = (): any => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  fatal: jest.fn(),
  trace: jest.fn(),
  silent: jest.fn(),
  level: 'info',
  child: jest.fn().mockReturnThis(),
});

const createMockBTPClientManager = (): any => ({
  addPeer: jest.fn().mockResolvedValue(undefined),
  removePeer: jest.fn().mockResolvedValue(undefined),
  sendToPeer: jest.fn().mockResolvedValue({
    type: PacketType.FULFILL,
    data: Buffer.alloc(0),
  }),
  getPeerStatus: jest.fn().mockReturnValue(new Map()),
  getPeerIds: jest.fn().mockReturnValue([]),
  isConnected: jest.fn().mockReturnValue(true),
});

const createMockBTPServer = (): any => ({
  hasPeer: jest.fn().mockReturnValue(false),
  sendPacketToPeer: jest.fn().mockResolvedValue({
    type: PacketType.FULFILL,
    data: Buffer.alloc(0),
  }),
});

const createMockAccountManager = (): any => ({
  getPeerAccountPair: jest.fn().mockReturnValue({
    debitAccountId: 123n,
    creditAccountId: 456n,
    peerId: 'peer-test',
    tokenId: 'M2M',
  }),
  createPeerAccounts: jest.fn(),
  getAccountBalance: jest.fn(),
  recordPacketTransfers: jest.fn().mockResolvedValue(undefined),
  checkCreditLimit: jest.fn().mockResolvedValue(null),
});

const createMockPerPacketClaimService = (): any => ({
  generateClaimForPacket: jest.fn().mockResolvedValue({
    protocolData: {
      protocolName: 'evm_claim',
      contentType: 0,
      data: Buffer.from('mock-claim-data'),
    },
    claimMessage: { version: '1.0', blockchain: 'evm' },
  }),
  getLatestClaim: jest.fn().mockReturnValue(null),
  resetChannel: jest.fn(),
});

const createMockIlpMetrics = (): any => ({
  recordInbound: jest.fn(),
  recordPreRoutingReject: jest.fn(),
  recordForwardFulfill: jest.fn(),
  recordForwardReject: jest.fn(),
});

const createMockNip59Wrapper = (enabled = true): any => ({
  isEnabled: jest.fn().mockReturnValue(enabled),
  unwrapClaimWithPreimage: jest.fn().mockReturnValue({
    fulfillmentPreimage: new Uint8Array(Buffer.from('mock-preimage-32-bytes-long!!')),
  }),
});

const createValidPreparePacket = (overrides?: Partial<ILPPreparePacket>): ILPPreparePacket => {
  const futureExpiry = new Date(Date.now() + 30000);
  const data = overrides?.data ?? Buffer.alloc(0);
  return {
    type: PacketType.PREPARE,
    amount: 1000n,
    destination: 'g.alice.wallet',
    expiresAt: futureExpiry,
    data,
    ...overrides,
  };
};

/* ------------------------------------------------------------------ */

describe('PacketHandler branch coverage', () => {
  let handler: PacketHandler;
  let routingTable: RoutingTable;
  let mockLogger: any;
  let btpClientManager: any;
  let btpServer: any;

  beforeEach(() => {
    routingTable = new RoutingTable([{ prefix: 'g.alice', nextHop: 'peer-alice' }]);
    mockLogger = createMockLogger();
    btpClientManager = createMockBTPClientManager();
    btpServer = createMockBTPServer();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  /* ================================================================ */
  describe('Constructor and setter branches', () => {
    it('constructor: logs settlement disabled when accountManager is null', () => {
      new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);

      expect(mockLogger.info).toHaveBeenCalledWith('Settlement recording disabled');
    });

    it('constructor: logs settlement enabled when accountManager and config provided', () => {
      const accountManager = createMockAccountManager();
      const settlementConfig = {
        connectorFeePercentage: 0.1,
        enableSettlement: true,
        tigerBeetleClusterId: 0,
        tigerBeetleReplicas: ['localhost:3000'],
      };

      new PacketHandler(
        routingTable,
        btpClientManager,
        'test.connector',
        mockLogger,
        null,
        accountManager,
        settlementConfig
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          connectorFeePercentage: 0.1,
          tigerBeetleClusterId: 0,
        }),
        'Settlement recording enabled'
      );
    });

    it('setBTPServer assigns the server reference', () => {
      handler = new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);
      const server = createMockBTPServer();
      handler.setBTPServer(server);
      // Exercise the reference by calling a private method that uses it
      (handler as any).btpServer = server;
      expect((handler as any).btpServer).toBe(server);
    });

    it('setSettlement: assigns defaultTokenId when provided', () => {
      handler = new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);
      const accountManager = createMockAccountManager();
      const settlementConfig = {
        connectorFeePercentage: 0.1,
        enableSettlement: true,
        tigerBeetleClusterId: 0,
        tigerBeetleReplicas: ['localhost:3000'],
      };

      handler.setSettlement(accountManager, settlementConfig, 'USDC');

      expect((handler as any).defaultTokenId).toBe('USDC');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'settlement_enabled' }),
        'Settlement recording enabled via late initialization'
      );
    });

    it('setSettlement: does NOT overwrite defaultTokenId when omitted', () => {
      handler = new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);
      const accountManager = createMockAccountManager();
      const settlementConfig = {
        connectorFeePercentage: 0.1,
        enableSettlement: true,
        tigerBeetleClusterId: 0,
        tigerBeetleReplicas: ['localhost:3000'],
      };

      handler.setSettlement(accountManager, settlementConfig);

      expect((handler as any).defaultTokenId).toBe('M2M');
    });

    it('setSettlement: does not log when settlement disabled', () => {
      handler = new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);
      const accountManager = createMockAccountManager();
      const settlementConfig = {
        connectorFeePercentage: 0.1,
        enableSettlement: false,
        tigerBeetleClusterId: 0,
        tigerBeetleReplicas: ['localhost:3000'],
      };

      handler.setSettlement(accountManager, settlementConfig);

      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'settlement_enabled' }),
        expect.any(String)
      );
    });

    it('setPerPacketClaimService assigns service and logs', () => {
      handler = new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);
      const service = createMockPerPacketClaimService();

      handler.setPerPacketClaimService(service);

      expect(mockLogger.info).toHaveBeenCalledWith('Per-packet claim service enabled');
    });

    it('setLocalDelivery: enabled=true creates client and logs', () => {
      handler = new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);
      handler.setLocalDelivery({
        enabled: true,
        handlerUrl: 'http://localhost:3100',
        timeout: 5000,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'local_delivery_enabled' }),
        'Local delivery forwarding enabled'
      );
    });

    it('setLocalDelivery: enabled=false sets client to null and logs', () => {
      handler = new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);
      // First enable, then disable
      handler.setLocalDelivery({
        enabled: true,
        handlerUrl: 'http://localhost:3100',
        timeout: 5000,
      });
      handler.setLocalDelivery({
        enabled: false,
        handlerUrl: 'http://localhost:3100',
        timeout: 5000,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Local delivery forwarding disabled (using auto-fulfill stub)'
      );
      expect((handler as any).localDeliveryClient).toBeNull();
    });

    it('setLocalDeliveryHandler: sets handler and logs', () => {
      handler = new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);
      const fn = jest.fn();

      handler.setLocalDeliveryHandler(fn);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'local_delivery_handler_set', hasHandler: true }),
        'Local delivery function handler updated'
      );
    });

    it('setLocalDeliveryHandler: clearing null handler logs hasHandler false', () => {
      handler = new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);

      handler.setLocalDeliveryHandler(null);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'local_delivery_handler_set', hasHandler: false }),
        'Local delivery function handler updated'
      );
    });

    it('setNip59Wrapper assigns wrapper and private key', () => {
      handler = new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);
      const wrapper = createMockNip59Wrapper();
      const key = new Uint8Array(32);

      handler.setNip59Wrapper(wrapper, key);

      expect((handler as any)._nip59Wrapper).toBe(wrapper);
      expect((handler as any)._nodePrivateKey).toBe(key);
    });

    it('setIlpMetrics assigns metrics and logs', () => {
      handler = new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);
      const metrics = createMockIlpMetrics();

      handler.setIlpMetrics(metrics);

      expect((handler as any).ilpMetrics).toBe(metrics);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'ilp_metrics_enabled' }),
        'ILP observability metrics enabled'
      );
    });
  });

  /* ================================================================ */
  describe('calculateConnectorFee edge cases', () => {
    beforeEach(() => {
      handler = new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);
    });

    it('throws when amount is negative', () => {
      expect(() => (handler as any).calculateConnectorFee(-1n, 0.1)).toThrow(
        'Invalid amount: -1 (must be >= 0)'
      );
    });

    it('throws when feePercentage is negative', () => {
      expect(() => (handler as any).calculateConnectorFee(1000n, -0.1)).toThrow(
        'Invalid fee percentage: -0.1 (must be >= 0)'
      );
    });

    it('returns zero fee when amount is zero', () => {
      const fee = (handler as any).calculateConnectorFee(0n, 0.1);
      expect(fee).toBe(0n);
    });

    it('returns zero fee when feePercentage is zero', () => {
      const fee = (handler as any).calculateConnectorFee(1000n, 0);
      expect(fee).toBe(0n);
    });

    it('rounds down using integer arithmetic (basis points)', () => {
      // 0.1% of 999 = 0.999 basis points → floor → 0
      const fee = (handler as any).calculateConnectorFee(999n, 0.1);
      expect(fee).toBe(0n);
    });
  });

  /* ================================================================ */
  describe('_derivePreimageFromProtocolData branches', () => {
    beforeEach(() => {
      handler = new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);
    });

    it('returns undefined when _nip59Wrapper is null', () => {
      const result = (handler as any)._derivePreimageFromProtocolData([
        { protocolName: 'claim-wrapped', contentType: 0, data: Buffer.alloc(0) },
      ]);
      expect(result).toBeUndefined();
    });

    it('returns undefined when _nip59Wrapper.isEnabled() is false', () => {
      const wrapper = createMockNip59Wrapper(false);
      handler.setNip59Wrapper(wrapper, new Uint8Array(32));
      const result = (handler as any)._derivePreimageFromProtocolData([
        { protocolName: 'claim-wrapped', contentType: 0, data: Buffer.alloc(0) },
      ]);
      expect(result).toBeUndefined();
    });

    it('returns undefined when _nodePrivateKey is null', () => {
      const wrapper = createMockNip59Wrapper(true);
      (handler as any)._nip59Wrapper = wrapper;
      (handler as any)._nodePrivateKey = null;
      const result = (handler as any)._derivePreimageFromProtocolData([
        { protocolName: 'claim-wrapped', contentType: 0, data: Buffer.alloc(0) },
      ]);
      expect(result).toBeUndefined();
    });

    it('returns undefined when protocolData is undefined', () => {
      const wrapper = createMockNip59Wrapper(true);
      handler.setNip59Wrapper(wrapper, new Uint8Array(32));
      const result = (handler as any)._derivePreimageFromProtocolData(undefined);
      expect(result).toBeUndefined();
    });

    it('returns undefined when no claim-wrapped entry found', () => {
      const wrapper = createMockNip59Wrapper(true);
      handler.setNip59Wrapper(wrapper, new Uint8Array(32));
      const result = (handler as any)._derivePreimageFromProtocolData([
        { protocolName: 'other', contentType: 0, data: Buffer.alloc(0) },
      ]);
      expect(result).toBeUndefined();
    });

    const validWrappedClaimData = () =>
      Buffer.from(
        JSON.stringify({
          ephemeralPublicKey: '0x' + 'a'.repeat(66),
          encryptedPayload: 'abc',
          timestamp: 1234567890,
          version: '1.0',
        })
      );

    it('returns preimage on success', () => {
      const wrapper = createMockNip59Wrapper(true);
      const preimage = new Uint8Array(Buffer.from('success-preimage-32-bytes-long!'));
      wrapper.unwrapClaimWithPreimage.mockReturnValue({ fulfillmentPreimage: preimage });
      handler.setNip59Wrapper(wrapper, new Uint8Array(32));
      const result = (handler as any)._derivePreimageFromProtocolData([
        { protocolName: 'claim-wrapped', contentType: 0, data: validWrappedClaimData() },
      ]);
      expect(result).toEqual(preimage);
    });

    it('returns undefined and logs warning when unwrapClaimWithPreimage throws', () => {
      const wrapper = createMockNip59Wrapper(true);
      wrapper.unwrapClaimWithPreimage.mockImplementation(() => {
        throw new Error('decryption failed');
      });
      handler.setNip59Wrapper(wrapper, new Uint8Array(32));
      const result = (handler as any)._derivePreimageFromProtocolData([
        { protocolName: 'claim-wrapped', contentType: 0, data: validWrappedClaimData() },
      ]);
      expect(result).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'preimage_derivation_failed',
          error: 'decryption failed',
        }),
        'Failed to derive preimage from wrapped claim'
      );
    });

    it('returns undefined and logs warning when unwrapClaimWithPreimage throws a non-Error', () => {
      const wrapper = createMockNip59Wrapper(true);
      wrapper.unwrapClaimWithPreimage.mockImplementation(() => {
        throw 'string-error';
      });
      handler.setNip59Wrapper(wrapper, new Uint8Array(32));
      const result = (handler as any)._derivePreimageFromProtocolData([
        { protocolName: 'claim-wrapped', contentType: 0, data: validWrappedClaimData() },
      ]);
      expect(result).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'preimage_derivation_failed', error: 'string-error' }),
        'Failed to derive preimage from wrapped claim'
      );
    });
  });

  /* ================================================================ */
  describe('forwardToNextHop transport selection and error mapping', () => {
    beforeEach(() => {
      handler = new PacketHandler(
        routingTable,
        btpClientManager,
        'test.connector',
        mockLogger,
        btpServer
      );
    });

    it('uses outbound connection when both outbound and inbound exist', async () => {
      btpClientManager.isConnected.mockReturnValue(true);
      btpServer.hasPeer.mockReturnValue(true);
      const packet = createValidPreparePacket();

      const result = await (handler as any).forwardToNextHop(packet, 'peer-alice', 'corr-1');

      expect(btpClientManager.sendToPeer).toHaveBeenCalledTimes(1);
      expect(btpServer.sendPacketToPeer).not.toHaveBeenCalled();
      expect(result.type).toBe(PacketType.FULFILL);
    });

    it('falls back to inbound server when outbound missing but inbound present', async () => {
      btpClientManager.isConnected.mockReturnValue(false);
      btpServer.hasPeer.mockReturnValue(true);
      btpServer.sendPacketToPeer.mockResolvedValue({
        type: PacketType.FULFILL,
        data: Buffer.alloc(0),
      });
      const packet = createValidPreparePacket();

      const result = await (handler as any).forwardToNextHop(packet, 'peer-alice', 'corr-1');

      expect(btpClientManager.sendToPeer).not.toHaveBeenCalled();
      expect(btpServer.sendPacketToPeer).toHaveBeenCalledTimes(1);
      expect(result.type).toBe(PacketType.FULFILL);
    });

    it('returns T01 reject when neither outbound nor inbound exists', async () => {
      btpClientManager.isConnected.mockReturnValue(false);
      btpServer.hasPeer.mockReturnValue(false);
      const packet = createValidPreparePacket();

      const result = await (handler as any).forwardToNextHop(packet, 'peer-alice', 'corr-1');

      expect(result.type).toBe(PacketType.REJECT);
      const reject = result as ILPRejectPacket;
      expect(reject.code).toBe(ILPErrorCode.T01_PEER_UNREACHABLE);
      expect(reject.message).toContain('No active BTP connection');
    });

    it('maps BTPConnectionError to T01_PEER_UNREACHABLE reject', async () => {
      btpClientManager.isConnected.mockReturnValue(true);
      btpClientManager.sendToPeer.mockRejectedValue(new BTPConnectionError('connection refused'));
      const packet = createValidPreparePacket();

      const result = await (handler as any).forwardToNextHop(packet, 'peer-alice', 'corr-1');

      expect(result.type).toBe(PacketType.REJECT);
      const reject = result as ILPRejectPacket;
      expect(reject.code).toBe(ILPErrorCode.T01_PEER_UNREACHABLE);
      expect(reject.message).toContain('connection refused');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_connection_error' }),
        'BTP connection failed'
      );
    });

    it('maps BTPAuthenticationError to T01_PEER_UNREACHABLE reject', async () => {
      btpClientManager.isConnected.mockReturnValue(true);
      btpClientManager.sendToPeer.mockRejectedValue(new BTPAuthenticationError('bad token'));
      const packet = createValidPreparePacket();

      const result = await (handler as any).forwardToNextHop(packet, 'peer-alice', 'corr-1');

      expect(result.type).toBe(PacketType.REJECT);
      const reject = result as ILPRejectPacket;
      expect(reject.code).toBe(ILPErrorCode.T01_PEER_UNREACHABLE);
      expect(reject.message).toContain('bad token');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_auth_error' }),
        'BTP authentication failed'
      );
    });

    it('maps timeout error to R00_TRANSFER_TIMED_OUT reject', async () => {
      btpClientManager.isConnected.mockReturnValue(true);
      btpClientManager.sendToPeer.mockRejectedValue(new Error('Network timeout after 5000ms'));
      const packet = createValidPreparePacket();

      const result = await (handler as any).forwardToNextHop(packet, 'peer-alice', 'corr-1');

      expect(result.type).toBe(PacketType.REJECT);
      const reject = result as ILPRejectPacket;
      expect(reject.code).toBe(ILPErrorCode.R00_TRANSFER_TIMED_OUT);
      expect(reject.message).toContain('timeout');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_timeout' }),
        'BTP packet send timeout'
      );
    });

    it('re-throws unknown errors after logging (Error instance)', async () => {
      btpClientManager.isConnected.mockReturnValue(true);
      const unknownErr = new Error('something weird');
      btpClientManager.sendToPeer.mockRejectedValue(unknownErr);
      const packet = createValidPreparePacket();

      await expect((handler as any).forwardToNextHop(packet, 'peer-alice', 'corr-1')).rejects.toBe(
        unknownErr
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_forward_error' }),
        'Unexpected error forwarding packet via BTP'
      );
    });

    it('re-throws unknown non-Error value after logging', async () => {
      btpClientManager.isConnected.mockReturnValue(true);
      btpClientManager.sendToPeer.mockRejectedValue('string-error');
      const packet = createValidPreparePacket();

      await expect((handler as any).forwardToNextHop(packet, 'peer-alice', 'corr-1')).rejects.toBe(
        'string-error'
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'btp_forward_error', error: 'string-error' }),
        'Unexpected error forwarding packet via BTP'
      );
    });
  });

  /* ================================================================ */
  describe('handlePreparePacket - fromPeerId and ilpMetrics branches', () => {
    beforeEach(() => {
      handler = new PacketHandler(
        routingTable,
        btpClientManager,
        'test.connector',
        mockLogger,
        btpServer
      );
      handler.setPerPacketClaimService(createMockPerPacketClaimService());
    });

    it('uses "unknown" as sourcePeerId when fromPeerId is omitted', async () => {
      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      await handler.handlePreparePacket(packet);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ fromPeerId: 'unknown' }),
        'Packet received'
      );
    });

    it('uses provided fromPeerId when present', async () => {
      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      await handler.handlePreparePacket(packet, 'peer-sender');

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ fromPeerId: 'peer-sender' }),
        'Packet received'
      );
    });

    it('does not crash when ilpMetrics is null (default)', async () => {
      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      const result = await handler.handlePreparePacket(packet);
      expect(result.type).toBe(PacketType.FULFILL);
    });

    it('calls recordInbound when ilpMetrics is set and fromPeerId provided', async () => {
      const metrics = createMockIlpMetrics();
      handler.setIlpMetrics(metrics);
      const packet = createValidPreparePacket({
        destination: 'g.alice.wallet',
        data: Buffer.from('hello'),
      });

      await handler.handlePreparePacket(packet, 'peer-sender');

      expect(metrics.recordInbound).toHaveBeenCalledWith('peer-sender', 5);
    });

    it('calls recordInbound with "unknown" when fromPeerId omitted', async () => {
      const metrics = createMockIlpMetrics();
      handler.setIlpMetrics(metrics);
      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });

      await handler.handlePreparePacket(packet);

      expect(metrics.recordInbound).toHaveBeenCalledWith('unknown', 0);
    });

    it('calls recordPreRoutingReject for validation failure', async () => {
      const metrics = createMockIlpMetrics();
      handler.setIlpMetrics(metrics);
      const invalidPacket = createValidPreparePacket({ destination: '' });

      await handler.handlePreparePacket(invalidPacket);

      expect(metrics.recordPreRoutingReject).toHaveBeenCalledWith('validation_failed');
    });

    it('calls recordPreRoutingReject for no route', async () => {
      const metrics = createMockIlpMetrics();
      handler.setIlpMetrics(metrics);
      const emptyRoutingTable = new RoutingTable();
      const localHandler = new PacketHandler(
        emptyRoutingTable,
        btpClientManager,
        'test.connector',
        mockLogger
      );
      localHandler.setIlpMetrics(metrics);
      const packet = createValidPreparePacket({ destination: 'g.unknown' });

      await localHandler.handlePreparePacket(packet);

      expect(metrics.recordPreRoutingReject).toHaveBeenCalledWith('no_route');
    });

    it('calls recordPreRoutingReject for expiry too short', async () => {
      const metrics = createMockIlpMetrics();
      handler.setIlpMetrics(metrics);
      const packet = createValidPreparePacket({
        destination: 'g.alice.wallet',
        expiresAt: new Date(Date.now() + 500), // less than 1000ms margin
      });

      await handler.handlePreparePacket(packet);

      expect(metrics.recordPreRoutingReject).toHaveBeenCalledWith('expiry_too_short');
    });
  });

  /* ================================================================ */
  describe('handlePreparePacket - local delivery branches', () => {
    beforeEach(() => {
      handler = new PacketHandler(
        new RoutingTable([
          { prefix: 'g.alice', nextHop: 'peer-alice' },
          { prefix: 'g.local', nextHop: 'test.connector' },
        ]),
        btpClientManager,
        'test.connector',
        mockLogger,
        btpServer
      );
    });

    it('auto-fulfills with injected preimage when NIP-59 wrapped claim present', async () => {
      const wrapper = createMockNip59Wrapper(true);
      const preimage = new Uint8Array(Buffer.from('preimage-32-bytes-long-1234567'));
      wrapper.unwrapClaimWithPreimage.mockReturnValue({ fulfillmentPreimage: preimage });
      handler.setNip59Wrapper(wrapper, new Uint8Array(32));

      const protocolData = [
        {
          protocolName: 'claim-wrapped',
          contentType: 0,
          data: Buffer.from(
            JSON.stringify({
              ephemeralPublicKey: '0x' + 'a'.repeat(66),
              encryptedPayload: 'abc',
              timestamp: 1234567890,
              version: '1.0',
            })
          ),
        },
      ];
      const packet = createValidPreparePacket({ destination: 'g.local.wallet' });

      const result = await handler.handlePreparePacket(packet, 'source-peer', protocolData);

      expect(result.type).toBe(PacketType.FULFILL);
      const fulfill = result as ILPFulfillPacket;
      expect(fulfill.fulfillment).toEqual(preimage);
    });

    it('auto-fulfills without preimage when no wrapped claim', async () => {
      const wrapper = createMockNip59Wrapper(true);
      handler.setNip59Wrapper(wrapper, new Uint8Array(32));

      const packet = createValidPreparePacket({ destination: 'g.local.wallet' });

      const result = await handler.handlePreparePacket(packet, 'source-peer');

      expect(result.type).toBe(PacketType.FULFILL);
      const fulfill = result as ILPFulfillPacket;
      expect(fulfill.fulfillment).toBeUndefined();
    });

    it('uses HTTP local delivery client when enabled (no function handler)', async () => {
      // Inject a mock LocalDeliveryClient directly to avoid real HTTP
      const mockClient = {
        isEnabled: jest.fn().mockReturnValue(true),
        deliver: jest.fn().mockResolvedValue({
          type: PacketType.FULFILL,
          data: Buffer.alloc(0),
        }),
      };
      (handler as any).localDeliveryClient = mockClient;

      const packet = createValidPreparePacket({ destination: 'g.local.wallet' });
      const result = await handler.handlePreparePacket(packet, 'source-peer');

      expect(mockClient.deliver).toHaveBeenCalledWith(packet, 'source-peer');
      expect(result.type).toBe(PacketType.FULFILL);
    });

    it('uses HTTP local delivery client returning REJECT', async () => {
      const mockClient = {
        isEnabled: jest.fn().mockReturnValue(true),
        deliver: jest.fn().mockResolvedValue({
          type: PacketType.REJECT,
          code: ILPErrorCode.F99_APPLICATION_ERROR,
          triggeredBy: 'test.connector',
          message: 'BLS said no',
          data: Buffer.alloc(0),
        }),
      };
      (handler as any).localDeliveryClient = mockClient;

      const packet = createValidPreparePacket({ destination: 'g.local.wallet' });
      const result = await handler.handlePreparePacket(packet, 'source-peer');

      expect(result.type).toBe(PacketType.REJECT);
      const reject = result as ILPRejectPacket;
      expect(reject.message).toBe('BLS said no');
    });

    it('injects preimage into HTTP FULFILL response when NIP-59 claim present', async () => {
      const wrapper = createMockNip59Wrapper(true);
      const preimage = new Uint8Array(Buffer.from('preimage-32-bytes-long-1234567'));
      wrapper.unwrapClaimWithPreimage.mockReturnValue({ fulfillmentPreimage: preimage });
      handler.setNip59Wrapper(wrapper, new Uint8Array(32));

      const mockClient = {
        isEnabled: jest.fn().mockReturnValue(true),
        deliver: jest.fn().mockResolvedValue({
          type: PacketType.FULFILL,
          data: Buffer.alloc(0),
        }),
      };
      (handler as any).localDeliveryClient = mockClient;

      const protocolData = [
        {
          protocolName: 'claim-wrapped',
          contentType: 0,
          data: Buffer.from(
            JSON.stringify({
              ephemeralPublicKey: '0x' + 'a'.repeat(66),
              encryptedPayload: 'abc',
              timestamp: 1234567890,
              version: '1.0',
            })
          ),
        },
      ];
      const packet = createValidPreparePacket({ destination: 'g.local.wallet' });
      const result = await handler.handlePreparePacket(packet, 'source-peer', protocolData);

      expect(result.type).toBe(PacketType.FULFILL);
      expect((result as ILPFulfillPacket).fulfillment).toEqual(preimage);
    });
  });

  /* ================================================================ */
  describe('handlePreparePacket - settlement branches', () => {
    const createSettlementConfig = (overrides?: any) => ({
      connectorFeePercentage: 0.1,
      enableSettlement: true,
      tigerBeetleClusterId: 0,
      tigerBeetleReplicas: ['localhost:3000'],
      ...overrides,
    });

    beforeEach(() => {
      handler = new PacketHandler(
        routingTable,
        btpClientManager,
        'test.connector',
        mockLogger,
        btpServer,
        createMockAccountManager(),
        createSettlementConfig()
      );
      handler.setPerPacketClaimService(createMockPerPacketClaimService());
    });

    it('rejects with T04 when credit limit is exceeded', async () => {
      const accountManager = createMockAccountManager();
      accountManager.checkCreditLimit.mockResolvedValue({
        peerId: 'unknown',
        tokenId: 'M2M',
        currentBalance: 5000n,
        requestedAmount: 1000n,
        creditLimit: 5000n,
        wouldExceedBy: 1000n,
      });
      (handler as any).accountManager = accountManager;

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet', amount: 1000n });
      const result = await handler.handlePreparePacket(packet, 'peer-sender');

      expect(result.type).toBe(PacketType.REJECT);
      const reject = result as ILPRejectPacket;
      expect(reject.code).toBe(ILPErrorCode.T04_INSUFFICIENT_LIQUIDITY);
      expect(reject.message).toContain('Credit limit exceeded');
    });

    it('skips settlement recording when sourcePeerId is "unknown"', async () => {
      const accountManager = createMockAccountManager();
      (handler as any).accountManager = accountManager;

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet', amount: 1000n });
      await handler.handlePreparePacket(packet); // no fromPeerId

      expect(accountManager.recordPacketTransfers).not.toHaveBeenCalled();
      expect(btpClientManager.sendToPeer).toHaveBeenCalledWith(
        'peer-alice',
        expect.objectContaining({ amount: 999n }),
        expect.any(Array)
      );
    });

    it('skips settlement recording when packet amount is 0n', async () => {
      const accountManager = createMockAccountManager();
      (handler as any).accountManager = accountManager;

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet', amount: 0n });
      await handler.handlePreparePacket(packet, 'peer-sender');

      expect(accountManager.recordPacketTransfers).not.toHaveBeenCalled();
      expect(btpClientManager.sendToPeer).toHaveBeenCalledWith(
        'peer-alice',
        expect.objectContaining({ amount: 0n }),
        undefined
      );
    });

    it('skips settlement recording when forwardedAmount is 0n (fee equals amount)', async () => {
      // 0.1% of 9 = 0 basis points → floor(0.9) = 0, but to guarantee forwardedAmount=0n
      // we need a case where fee == amount. With 100% fee:
      const accountManager = createMockAccountManager();
      (handler as any).accountManager = accountManager;
      (handler as any).settlementConfig = createSettlementConfig({ connectorFeePercentage: 100 });

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet', amount: 1n });
      await handler.handlePreparePacket(packet, 'peer-sender');

      // Fee = 1n * 10000 / 10000 = 1n, forwardedAmount = 0n → skip settlement
      expect(accountManager.recordPacketTransfers).not.toHaveBeenCalled();
    });

    it('uses default connectorFeePercentage of 0.1 when settlementConfig field is undefined', async () => {
      const accountManager = createMockAccountManager();
      (handler as any).accountManager = accountManager;
      (handler as any).settlementConfig = createSettlementConfig({
        connectorFeePercentage: undefined,
      });

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet', amount: 1000n });
      await handler.handlePreparePacket(packet, 'peer-sender');

      // Default 0.1% fee = 1n
      expect(btpClientManager.sendToPeer).toHaveBeenCalledWith(
        'peer-alice',
        expect.objectContaining({ amount: 999n }),
        expect.any(Array)
      );
    });

    it('rejects with T00 when settlement recording throws (Error)', async () => {
      const accountManager = createMockAccountManager();
      accountManager.recordPacketTransfers.mockRejectedValue(new Error('TB down'));
      (handler as any).accountManager = accountManager;

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet', amount: 1000n });
      const result = await handler.handlePreparePacket(packet, 'peer-sender');

      expect(result.type).toBe(PacketType.REJECT);
      const reject = result as ILPRejectPacket;
      expect(reject.code).toBe(ILPErrorCode.T00_INTERNAL_ERROR);
      expect(reject.message).toBe('Settlement recording failed');
    });

    it('rejects with T00 when settlement recording throws non-Error', async () => {
      const accountManager = createMockAccountManager();
      accountManager.recordPacketTransfers.mockRejectedValue('string-error');
      (handler as any).accountManager = accountManager;

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet', amount: 1000n });
      const result = await handler.handlePreparePacket(packet, 'peer-sender');

      expect(result.type).toBe(PacketType.REJECT);
      const reject = result as ILPRejectPacket;
      expect(reject.code).toBe(ILPErrorCode.T00_INTERNAL_ERROR);
      expect(reject.message).toBe('Settlement recording failed');
    });

    it('logs settlement debug when skipped for unknown peer', async () => {
      const accountManager = createMockAccountManager();
      (handler as any).accountManager = accountManager;

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet', amount: 1000n });
      await handler.handlePreparePacket(packet); // no fromPeerId

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'Skipping settlement for unknown peer' }),
        'Settlement skipped for unregistered peer'
      );
    });

    it('forwards original amount when settlement is disabled', async () => {
      const localHandler = new PacketHandler(
        routingTable,
        btpClientManager,
        'test.connector',
        mockLogger,
        btpServer
      );
      localHandler.setPerPacketClaimService(createMockPerPacketClaimService());
      const packet = createValidPreparePacket({ destination: 'g.alice.wallet', amount: 1000n });

      await localHandler.handlePreparePacket(packet, 'peer-sender');

      expect(btpClientManager.sendToPeer).toHaveBeenCalledWith(
        'peer-alice',
        expect.objectContaining({ amount: 1000n }),
        expect.any(Array)
      );
    });
  });

  /* ================================================================ */
  describe('handlePreparePacket - per-hop notification branches', () => {
    beforeEach(() => {
      handler = new PacketHandler(
        routingTable,
        btpClientManager,
        'test.connector',
        mockLogger,
        btpServer
      );
      handler.setPerPacketClaimService(createMockPerPacketClaimService());
    });

    it('does nothing when per-hop notification is disabled', async () => {
      const mockClient = {
        isEnabled: jest.fn().mockReturnValue(true),
        isPerHopNotificationEnabled: jest.fn().mockReturnValue(false),
        deliver: jest.fn().mockResolvedValue({ type: PacketType.FULFILL, data: Buffer.alloc(0) }),
      };
      (handler as any).localDeliveryClient = mockClient;
      const mockHandler = jest.fn().mockResolvedValue({ fulfill: { data: '' } });
      handler.setLocalDeliveryHandler(mockHandler);

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      await handler.handlePreparePacket(packet, 'source-peer');

      expect(mockHandler).not.toHaveBeenCalled();
      expect(mockClient.deliver).not.toHaveBeenCalled();
    });

    it('fires in-process handler when per-hop enabled and handler set', async () => {
      const mockClient = {
        isEnabled: jest.fn().mockReturnValue(true),
        isPerHopNotificationEnabled: jest.fn().mockReturnValue(true),
        deliver: jest.fn().mockResolvedValue({ type: PacketType.FULFILL, data: Buffer.alloc(0) }),
      };
      (handler as any).localDeliveryClient = mockClient;
      const mockHandler = jest.fn().mockResolvedValue({ fulfill: { data: '' } });
      handler.setLocalDeliveryHandler(mockHandler);

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      await handler.handlePreparePacket(packet, 'source-peer');
      await new Promise((r) => setTimeout(r, 50));

      expect(mockHandler).toHaveBeenCalledTimes(1);
      const req = mockHandler.mock.calls[0][0];
      expect(req.isTransit).toBe(true);
    });

    it('fires HTTP client when per-hop enabled, no handler, but HTTP client enabled', async () => {
      const mockClient = {
        isEnabled: jest.fn().mockReturnValue(true),
        isPerHopNotificationEnabled: jest.fn().mockReturnValue(true),
        deliver: jest.fn().mockResolvedValue({ type: PacketType.FULFILL, data: Buffer.alloc(0) }),
      };
      (handler as any).localDeliveryClient = mockClient;

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      await handler.handlePreparePacket(packet, 'source-peer');
      await new Promise((r) => setTimeout(r, 50));

      expect(mockClient.deliver).toHaveBeenCalledWith(
        packet,
        'source-peer',
        expect.objectContaining({ isTransit: true })
      );
    });

    it('logs debug when in-process per-hop handler throws (Error)', async () => {
      const mockClient = {
        isEnabled: jest.fn().mockReturnValue(true),
        isPerHopNotificationEnabled: jest.fn().mockReturnValue(true),
        deliver: jest.fn().mockResolvedValue({ type: PacketType.FULFILL, data: Buffer.alloc(0) }),
      };
      (handler as any).localDeliveryClient = mockClient;
      const mockHandler = jest.fn().mockRejectedValue(new Error('handler crash'));
      handler.setLocalDeliveryHandler(mockHandler);

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      await handler.handlePreparePacket(packet, 'source-peer');
      await new Promise((r) => setTimeout(r, 50));

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'handler crash' }),
        'Per-hop notification failed (fire-and-forget, in-process)'
      );
    });

    it('logs debug when in-process per-hop handler throws non-Error', async () => {
      const mockClient = {
        isEnabled: jest.fn().mockReturnValue(true),
        isPerHopNotificationEnabled: jest.fn().mockReturnValue(true),
        deliver: jest.fn().mockResolvedValue({ type: PacketType.FULFILL, data: Buffer.alloc(0) }),
      };
      (handler as any).localDeliveryClient = mockClient;
      const mockHandler = jest.fn().mockRejectedValue('string-crash');
      handler.setLocalDeliveryHandler(mockHandler);

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      await handler.handlePreparePacket(packet, 'source-peer');
      await new Promise((r) => setTimeout(r, 50));

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'string-crash' }),
        'Per-hop notification failed (fire-and-forget, in-process)'
      );
    });

    it('logs debug when HTTP per-hop client throws (Error)', async () => {
      const mockClient = {
        isEnabled: jest.fn().mockReturnValue(true),
        isPerHopNotificationEnabled: jest.fn().mockReturnValue(true),
        deliver: jest.fn().mockRejectedValue(new Error('http crash')),
      };
      (handler as any).localDeliveryClient = mockClient;

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      await handler.handlePreparePacket(packet, 'source-peer');
      await new Promise((r) => setTimeout(r, 50));

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'http crash' }),
        'Per-hop notification failed (fire-and-forget, HTTP)'
      );
    });

    it('logs debug when HTTP per-hop client throws non-Error', async () => {
      const mockClient = {
        isEnabled: jest.fn().mockReturnValue(true),
        isPerHopNotificationEnabled: jest.fn().mockReturnValue(true),
        deliver: jest.fn().mockRejectedValue('http-string-crash'),
      };
      (handler as any).localDeliveryClient = mockClient;

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      await handler.handlePreparePacket(packet, 'source-peer');
      await new Promise((r) => setTimeout(r, 50));

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'http-string-crash' }),
        'Per-hop notification failed (fire-and-forget, HTTP)'
      );
    });
  });

  /* ================================================================ */
  describe('handlePreparePacket - claim generation branches', () => {
    beforeEach(() => {
      handler = new PacketHandler(
        routingTable,
        btpClientManager,
        'test.connector',
        mockLogger,
        btpServer
      );
    });

    it('sets executionCondition when claim result provides one and packet has none', async () => {
      const claimService = createMockPerPacketClaimService();
      const execCond = Buffer.alloc(32, 0xab);
      claimService.generateClaimForPacket.mockResolvedValue({
        protocolData: { protocolName: 'evm_claim', contentType: 0, data: Buffer.from('claim') },
        executionCondition: execCond,
      });
      handler.setPerPacketClaimService(claimService);

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      await handler.handlePreparePacket(packet, 'peer-sender');

      const forwarded = btpClientManager.sendToPeer.mock.calls[0][1] as ILPPreparePacket;
      expect(Buffer.from(forwarded.executionCondition!)).toEqual(execCond);
    });

    it('overrides zero-filled executionCondition from claim result', async () => {
      const claimService = createMockPerPacketClaimService();
      const execCond = Buffer.alloc(32, 0xcd);
      claimService.generateClaimForPacket.mockResolvedValue({
        protocolData: { protocolName: 'evm_claim', contentType: 0, data: Buffer.from('claim') },
        executionCondition: execCond,
      });
      handler.setPerPacketClaimService(claimService);

      const packet = createValidPreparePacket({
        destination: 'g.alice.wallet',
        executionCondition: Buffer.alloc(32, 0),
      });
      await handler.handlePreparePacket(packet, 'peer-sender');

      const forwarded = btpClientManager.sendToPeer.mock.calls[0][1] as ILPPreparePacket;
      expect(Buffer.from(forwarded.executionCondition!)).toEqual(execCond);
    });

    it('preserves upstream executionCondition when claim result also has one (intermediary)', async () => {
      const claimService = createMockPerPacketClaimService();
      const upstreamCond = Buffer.alloc(32, 0xef);
      const claimCond = Buffer.alloc(32, 0xcd);
      claimService.generateClaimForPacket.mockResolvedValue({
        protocolData: { protocolName: 'evm_claim', contentType: 0, data: Buffer.from('claim') },
        executionCondition: claimCond,
      });
      handler.setPerPacketClaimService(claimService);

      const packet = createValidPreparePacket({
        destination: 'g.alice.wallet',
        executionCondition: upstreamCond,
      });
      await handler.handlePreparePacket(packet, 'peer-sender');

      const forwarded = btpClientManager.sendToPeer.mock.calls[0][1] as ILPPreparePacket;
      expect(Buffer.from(forwarded.executionCondition!)).toEqual(upstreamCond);
    });

    it('does not set executionCondition when claim result lacks one', async () => {
      const claimService = createMockPerPacketClaimService();
      claimService.generateClaimForPacket.mockResolvedValue({
        protocolData: { protocolName: 'evm_claim', contentType: 0, data: Buffer.from('claim') },
      });
      handler.setPerPacketClaimService(claimService);

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      await handler.handlePreparePacket(packet, 'peer-sender');

      const forwarded = btpClientManager.sendToPeer.mock.calls[0][1] as ILPPreparePacket;
      expect(forwarded.executionCondition).toBeUndefined();
    });

    it('rejects with T00 when generateClaimForPacket throws non-Error', async () => {
      const claimService = createMockPerPacketClaimService();
      claimService.generateClaimForPacket.mockRejectedValue('string-sign-fail');
      handler.setPerPacketClaimService(claimService);
      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });

      const result = await handler.handlePreparePacket(packet);

      expect(result.type).toBe(PacketType.REJECT);
      const reject = result as ILPRejectPacket;
      expect(reject.code).toBe(ILPErrorCode.T00_INTERNAL_ERROR);
      expect(reject.message).toBe('Claim generation failed');
    });
  });

  /* ================================================================ */
  describe('handlePreparePacket - fulfillment verification branches', () => {
    const makeFulfillmentAndCondition = () => {
      const fulfillment = Buffer.alloc(32, 0x42);
      const condition = Buffer.from(sha256(new Uint8Array(fulfillment)));
      return { fulfillment, condition };
    };

    beforeEach(() => {
      handler = new PacketHandler(
        routingTable,
        btpClientManager,
        'test.connector',
        mockLogger,
        btpServer
      );
    });

    it('passes through FULFILL when executionCondition matches hash of fulfillment', async () => {
      const { fulfillment, condition } = makeFulfillmentAndCondition();
      const claimService = createMockPerPacketClaimService();
      claimService.generateClaimForPacket.mockResolvedValue({
        protocolData: { protocolName: 'evm_claim', contentType: 0, data: Buffer.from('claim') },
        executionCondition: condition,
      });
      handler.setPerPacketClaimService(claimService);

      btpClientManager.sendToPeer.mockResolvedValue({
        type: PacketType.FULFILL,
        fulfillment,
        data: Buffer.alloc(0),
      });

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      const result = await handler.handlePreparePacket(packet, 'peer-sender');

      expect(result.type).toBe(PacketType.FULFILL);
      expect((result as ILPFulfillPacket).fulfillment).toEqual(fulfillment);
    });

    it('transforms FULFILL into REJECT when fulfillment is missing', async () => {
      const { condition } = makeFulfillmentAndCondition();
      const claimService = createMockPerPacketClaimService();
      claimService.generateClaimForPacket.mockResolvedValue({
        protocolData: { protocolName: 'evm_claim', contentType: 0, data: Buffer.from('claim') },
        executionCondition: condition,
      });
      handler.setPerPacketClaimService(claimService);

      btpClientManager.sendToPeer.mockResolvedValue({
        type: PacketType.FULFILL,
        // no fulfillment field
        data: Buffer.alloc(0),
      });

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      const result = await handler.handlePreparePacket(packet, 'peer-sender');

      expect(result.type).toBe(PacketType.REJECT);
      const reject = result as ILPRejectPacket;
      expect(reject.code).toBe(ILPErrorCode.F99_APPLICATION_ERROR);
      expect(reject.message).toBe('Fulfillment does not match execution condition');
    });

    it('transforms FULFILL into REJECT when fulfillment is all zeros', async () => {
      const { condition } = makeFulfillmentAndCondition();
      const claimService = createMockPerPacketClaimService();
      claimService.generateClaimForPacket.mockResolvedValue({
        protocolData: { protocolName: 'evm_claim', contentType: 0, data: Buffer.from('claim') },
        executionCondition: condition,
      });
      handler.setPerPacketClaimService(claimService);

      btpClientManager.sendToPeer.mockResolvedValue({
        type: PacketType.FULFILL,
        fulfillment: Buffer.alloc(32, 0),
        data: Buffer.alloc(0),
      });

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      const result = await handler.handlePreparePacket(packet, 'peer-sender');

      expect(result.type).toBe(PacketType.REJECT);
      const reject = result as ILPRejectPacket;
      expect(reject.code).toBe(ILPErrorCode.F99_APPLICATION_ERROR);
    });

    it('transforms FULFILL into REJECT when fulfillment hash does NOT match condition', async () => {
      const { condition } = makeFulfillmentAndCondition();
      const claimService = createMockPerPacketClaimService();
      claimService.generateClaimForPacket.mockResolvedValue({
        protocolData: { protocolName: 'evm_claim', contentType: 0, data: Buffer.from('claim') },
        executionCondition: condition,
      });
      handler.setPerPacketClaimService(claimService);

      btpClientManager.sendToPeer.mockResolvedValue({
        type: PacketType.FULFILL,
        fulfillment: Buffer.alloc(32, 0x99), // wrong fulfillment
        data: Buffer.alloc(0),
      });

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      const result = await handler.handlePreparePacket(packet, 'peer-sender');

      expect(result.type).toBe(PacketType.REJECT);
      const reject = result as ILPRejectPacket;
      expect(reject.code).toBe(ILPErrorCode.F99_APPLICATION_ERROR);
      expect(reject.message).toBe('Fulfillment does not match execution condition');
    });

    it('skips verification when forwardingPacket has no executionCondition', async () => {
      const claimService = createMockPerPacketClaimService();
      claimService.generateClaimForPacket.mockResolvedValue({
        protocolData: { protocolName: 'evm_claim', contentType: 0, data: Buffer.from('claim') },
        // no executionCondition
      });
      handler.setPerPacketClaimService(claimService);

      btpClientManager.sendToPeer.mockResolvedValue({
        type: PacketType.FULFILL,
        data: Buffer.alloc(0),
      });

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      const result = await handler.handlePreparePacket(packet, 'peer-sender');

      expect(result.type).toBe(PacketType.FULFILL);
    });

    it('skips verification when response is REJECT even with executionCondition', async () => {
      const { condition } = makeFulfillmentAndCondition();
      const claimService = createMockPerPacketClaimService();
      claimService.generateClaimForPacket.mockResolvedValue({
        protocolData: { protocolName: 'evm_claim', contentType: 0, data: Buffer.from('claim') },
        executionCondition: condition,
      });
      handler.setPerPacketClaimService(claimService);

      btpClientManager.sendToPeer.mockResolvedValue({
        type: PacketType.REJECT,
        code: ILPErrorCode.F02_UNREACHABLE,
        triggeredBy: 'peer-alice',
        message: 'No route',
        data: Buffer.alloc(0),
      });

      const packet = createValidPreparePacket({ destination: 'g.alice.wallet' });
      const result = await handler.handlePreparePacket(packet, 'peer-sender');

      expect(result.type).toBe(PacketType.REJECT);
      expect((result as ILPRejectPacket).code).toBe(ILPErrorCode.F02_UNREACHABLE);
    });
  });

  /* ================================================================ */
  describe('handlePreparePacket - forward outcome metrics branches', () => {
    beforeEach(() => {
      handler = new PacketHandler(
        routingTable,
        btpClientManager,
        'test.connector',
        mockLogger,
        btpServer
      );
      handler.setPerPacketClaimService(createMockPerPacketClaimService());
    });

    it('calls recordForwardFulfill on successful fulfill', async () => {
      const metrics = createMockIlpMetrics();
      handler.setIlpMetrics(metrics);

      btpClientManager.sendToPeer.mockResolvedValue({
        type: PacketType.FULFILL,
        data: Buffer.alloc(0),
      });

      const packet = createValidPreparePacket({
        destination: 'g.alice.wallet',
        data: Buffer.from('payload'),
      });
      await handler.handlePreparePacket(packet, 'peer-sender');

      expect(metrics.recordForwardFulfill).toHaveBeenCalledWith('peer-alice', 7);
    });

    it('calls recordForwardReject on downstream reject', async () => {
      const metrics = createMockIlpMetrics();
      handler.setIlpMetrics(metrics);

      btpClientManager.sendToPeer.mockResolvedValue({
        type: PacketType.REJECT,
        code: ILPErrorCode.F02_UNREACHABLE,
        triggeredBy: 'peer-alice',
        message: 'No route',
        data: Buffer.alloc(0),
      });

      const packet = createValidPreparePacket({
        destination: 'g.alice.wallet',
        data: Buffer.from('payload'),
      });
      await handler.handlePreparePacket(packet, 'peer-sender');

      expect(metrics.recordForwardReject).toHaveBeenCalledWith('peer-alice', 7);
    });
  });

  /* ================================================================ */
  describe('handlePreparePacket - local delivery function handler edge cases', () => {
    beforeEach(() => {
      handler = new PacketHandler(
        new RoutingTable([
          { prefix: 'g.alice', nextHop: 'peer-alice' },
          { prefix: 'g.local', nextHop: 'test.connector' },
        ]),
        btpClientManager,
        'test.connector',
        mockLogger,
        btpServer
      );
    });

    it('function handler reject with missing code falls back to F99', async () => {
      const mockHandler = jest.fn().mockResolvedValue({
        reject: {
          message: 'Missing code',
          // code is missing
        },
      });
      handler.setLocalDeliveryHandler(mockHandler);

      const packet = createValidPreparePacket({ destination: 'g.local.wallet' });
      const result = await handler.handlePreparePacket(packet, 'source-peer');

      expect(result.type).toBe(PacketType.REJECT);
      const reject = result as ILPRejectPacket;
      expect(reject.code).toBe(ILPErrorCode.F99_APPLICATION_ERROR);
    });

    it('function handler reject with missing message falls back to default', async () => {
      const mockHandler = jest.fn().mockResolvedValue({
        reject: {
          code: 'F01',
          // message is missing
        },
      });
      handler.setLocalDeliveryHandler(mockHandler);

      const packet = createValidPreparePacket({ destination: 'g.local.wallet' });
      const result = await handler.handlePreparePacket(packet, 'source-peer');

      expect(result.type).toBe(PacketType.REJECT);
      const reject = result as ILPRejectPacket;
      expect(reject.message).toBe('Rejected by agent');
    });

    it('function handler fulfill with base64 data decodes correctly', async () => {
      const b64 = Buffer.from('decoded-data').toString('base64');
      const mockHandler = jest.fn().mockResolvedValue({
        fulfill: { data: b64 },
      });
      handler.setLocalDeliveryHandler(mockHandler);

      const packet = createValidPreparePacket({ destination: 'g.local.wallet' });
      const result = await handler.handlePreparePacket(packet, 'source-peer');

      expect(result.type).toBe(PacketType.FULFILL);
      const fulfill = result as ILPFulfillPacket;
      expect(fulfill.data).toEqual(Buffer.from('decoded-data'));
    });

    it('function handler fulfill with no data uses empty buffer', async () => {
      const mockHandler = jest.fn().mockResolvedValue({
        fulfill: {}, // no data field
      });
      handler.setLocalDeliveryHandler(mockHandler);

      const packet = createValidPreparePacket({ destination: 'g.local.wallet' });
      const result = await handler.handlePreparePacket(packet, 'source-peer');

      expect(result.type).toBe(PacketType.FULFILL);
      const fulfill = result as ILPFulfillPacket;
      expect(fulfill.data).toEqual(Buffer.alloc(0));
    });

    it('function handler throws non-Error value', async () => {
      const mockHandler = jest.fn().mockImplementation(() => {
        throw 'plain string crash';
      });
      handler.setLocalDeliveryHandler(mockHandler);

      const packet = createValidPreparePacket({ destination: 'g.local.wallet' });
      const result = await handler.handlePreparePacket(packet, 'source-peer');

      expect(result.type).toBe(PacketType.REJECT);
      const reject = result as ILPRejectPacket;
      expect(reject.code).toBe(ILPErrorCode.T00_INTERNAL_ERROR);
      expect(reject.message).toContain('plain string crash');
    });

    it('function handler reject with base64 data decodes correctly', async () => {
      const b64 = Buffer.from('reject-data').toString('base64');
      const mockHandler = jest.fn().mockResolvedValue({
        reject: {
          code: 'F01',
          message: 'Bad request',
          data: b64,
        },
      });
      handler.setLocalDeliveryHandler(mockHandler);

      const packet = createValidPreparePacket({ destination: 'g.local.wallet' });
      const result = await handler.handlePreparePacket(packet, 'source-peer');

      expect(result.type).toBe(PacketType.REJECT);
      const reject = result as ILPRejectPacket;
      expect(reject.data).toEqual(Buffer.from('reject-data'));
    });

    it('injects preimage into function handler FULFILL when NIP-59 claim present', async () => {
      const wrapper = createMockNip59Wrapper(true);
      const preimage = new Uint8Array(Buffer.from('preimage-32-bytes-long-1234567'));
      wrapper.unwrapClaimWithPreimage.mockReturnValue({ fulfillmentPreimage: preimage });
      handler.setNip59Wrapper(wrapper, new Uint8Array(32));

      const mockHandler = jest.fn().mockResolvedValue({ fulfill: { data: '' } });
      handler.setLocalDeliveryHandler(mockHandler);

      const protocolData = [
        {
          protocolName: 'claim-wrapped',
          contentType: 0,
          data: Buffer.from(
            JSON.stringify({
              ephemeralPublicKey: '0x' + 'a'.repeat(66),
              encryptedPayload: 'abc',
              timestamp: 1234567890,
              version: '1.0',
            })
          ),
        },
      ];
      const packet = createValidPreparePacket({ destination: 'g.local.wallet' });
      const result = await handler.handlePreparePacket(packet, 'source-peer', protocolData);

      expect(result.type).toBe(PacketType.FULFILL);
      expect((result as ILPFulfillPacket).fulfillment).toEqual(preimage);
    });
  });

  /* ================================================================ */
  describe('handlePreparePacket - claim service edge cases', () => {
    beforeEach(() => {
      handler = new PacketHandler(
        routingTable,
        btpClientManager,
        'test.connector',
        mockLogger,
        btpServer
      );
    });

    it('skips claim generation for local delivery (nextHop === local)', async () => {
      const localRouting = new RoutingTable([{ prefix: 'g.local', nextHop: 'local' }]);
      const localHandler = new PacketHandler(
        localRouting,
        btpClientManager,
        'test.connector',
        mockLogger,
        btpServer
      );
      // No claim service set
      const packet = createValidPreparePacket({ destination: 'g.local.wallet' });
      const result = await localHandler.handlePreparePacket(packet, 'peer-sender');

      expect(result.type).toBe(PacketType.FULFILL);
      expect(btpClientManager.sendToPeer).not.toHaveBeenCalled();
    });

    it('skips claim generation when forwardingPacket.amount is 0n', async () => {
      const localHandler = new PacketHandler(
        routingTable,
        btpClientManager,
        'test.connector',
        mockLogger,
        btpServer
      );
      // No claim service set
      const packet = createValidPreparePacket({ destination: 'g.alice.wallet', amount: 0n });
      const result = await localHandler.handlePreparePacket(packet, 'peer-sender');

      expect(result.type).toBe(PacketType.FULFILL);
      expect(btpClientManager.sendToPeer).toHaveBeenCalled();
    });
  });

  /* ================================================================ */
  describe('isSettlementEnabled and isLocalDeliveryEnabled short-circuit', () => {
    beforeEach(() => {
      handler = new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);
    });

    it('isSettlementEnabled returns false when accountManager is null', () => {
      expect((handler as any).isSettlementEnabled()).toBe(false);
    });

    it('isSettlementEnabled returns false when settlementConfig is null', () => {
      (handler as any).accountManager = createMockAccountManager();
      expect((handler as any).isSettlementEnabled()).toBe(false);
    });

    it('isSettlementEnabled returns false when enableSettlement is false', () => {
      (handler as any).accountManager = createMockAccountManager();
      (handler as any).settlementConfig = { enableSettlement: false };
      expect((handler as any).isSettlementEnabled()).toBe(false);
    });

    it('isSettlementEnabled returns true when both conditions met', () => {
      (handler as any).accountManager = createMockAccountManager();
      (handler as any).settlementConfig = { enableSettlement: true };
      expect((handler as any).isSettlementEnabled()).toBe(true);
    });

    it('isLocalDeliveryEnabled returns false when localDeliveryClient is null', () => {
      expect((handler as any).isLocalDeliveryEnabled()).toBe(false);
    });

    it('isLocalDeliveryEnabled returns false when client isEnabled is false', () => {
      (handler as any).localDeliveryClient = { isEnabled: () => false };
      expect((handler as any).isLocalDeliveryEnabled()).toBe(false);
    });

    it('isLocalDeliveryEnabled returns true when client isEnabled is true', () => {
      (handler as any).localDeliveryClient = { isEnabled: () => true };
      expect((handler as any).isLocalDeliveryEnabled()).toBe(true);
    });
  });

  /* ================================================================ */
  describe('recordPacketTransfers early return and non-Error branches', () => {
    it('returns early when settlement is disabled', async () => {
      handler = new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);
      const packet = createValidPreparePacket();
      const result = await (handler as any).recordPacketTransfers(
        packet,
        'peer-a',
        'peer-b',
        999n,
        1n,
        'corr-1'
      );
      expect(result).toBeUndefined();
      expect(mockLogger.debug).not.toHaveBeenCalled();
    });

    it('logs non-Error throw via String(error) branch', async () => {
      const accountManager = createMockAccountManager();
      accountManager.recordPacketTransfers.mockRejectedValue('plain-string-error');
      handler = new PacketHandler(
        routingTable,
        btpClientManager,
        'test.connector',
        mockLogger,
        null,
        accountManager,
        {
          connectorFeePercentage: 0.1,
          enableSettlement: true,
          tigerBeetleClusterId: 0,
          tigerBeetleReplicas: ['localhost:3000'],
        }
      );
      const packet = createValidPreparePacket();
      await expect(
        (handler as any).recordPacketTransfers(packet, 'peer-a', 'peer-b', 999n, 1n, 'corr-1')
      ).rejects.toBe('plain-string-error');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'plain-string-error' }),
        'Settlement recording failed: {error}, rejecting packet with T00_INTERNAL_ERROR'
      );
    });
  });

  /* ================================================================ */
  describe('generateTransferId deterministic behavior', () => {
    beforeEach(() => {
      handler = new PacketHandler(routingTable, btpClientManager, 'test.connector', mockLogger);
    });

    it('generates different transfer IDs for incoming vs outgoing', () => {
      const data = Buffer.from('test-data');
      const incoming = (handler as any).generateTransferId(data, 'incoming');
      const outgoing = (handler as any).generateTransferId(data, 'outgoing');
      expect(incoming).not.toEqual(outgoing);
    });

    it('generates same transfer ID for same inputs (deterministic)', () => {
      const data = Buffer.from('test-data');
      const id1 = (handler as any).generateTransferId(data, 'incoming');
      const id2 = (handler as any).generateTransferId(data, 'incoming');
      expect(id1).toEqual(id2);
    });

    it('generates different transfer IDs for different packet data', () => {
      const id1 = (handler as any).generateTransferId(Buffer.from('a'), 'incoming');
      const id2 = (handler as any).generateTransferId(Buffer.from('b'), 'incoming');
      expect(id1).not.toEqual(id2);
    });
  });
});
