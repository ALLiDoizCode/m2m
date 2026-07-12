/**
 * Consumer Types Compilation Test
 *
 * Verifies that all exported types from lib.ts are importable and usable
 * with full type safety — no `any` casts needed.
 *
 * This is primarily a TypeScript compilation test: if it compiles, the
 * types are correctly exported. Runtime assertions are minimal.
 */

import * as lib from './lib';

import {
  // Value exports (14 total: LocalDeliveryClient removed - now internal only)
  ConnectorNode,
  ConfigLoader,
  ConfigurationError,
  ConnectorNotStartedError,
  RoutingTable,
  PacketHandler,
  BTPServer,
  BTPClient,
  BTPClientManager,
  // LocalDeliveryClient - REMOVED: internal only, use ConnectorNode.setLocalDeliveryHandler()
  AdminServer,
  AccountManager,
  SettlementMonitor,
  UnifiedSettlementExecutor,
  createLogger,
} from './lib';

import type {
  // Type exports (18 total: 14 existing + 3 new config + 1 new ILP)
  ConnectorConfig,
  PeerConfig,
  RouteConfig,
  SettlementConfig,
  LocalDeliveryConfig,
  LocalDeliveryHandler,
  LocalDeliveryRequest,
  LocalDeliveryResponse,
  SendPacketParams,
  PeerRegistrationRequest,
  PeerInfo,
  PeerAccountBalance,
  RouteInfo,
  RemovePeerResult,
  AdminSettlementConfig,
  ILPPreparePacket,
  ILPFulfillPacket,
  ILPRejectPacket,
} from './lib';

describe('consumer-types compilation test', () => {
  describe('value exports are constructors/functions', () => {
    it('should export all 14 value exports as functions', () => {
      expect(typeof ConnectorNode).toBe('function');
      expect(typeof ConfigLoader).toBe('function');
      expect(typeof ConfigurationError).toBe('function');
      expect(typeof ConnectorNotStartedError).toBe('function');
      expect(typeof RoutingTable).toBe('function');
      expect(typeof PacketHandler).toBe('function');
      expect(typeof BTPServer).toBe('function');
      expect(typeof BTPClient).toBe('function');
      expect(typeof BTPClientManager).toBe('function');
      // LocalDeliveryClient removed - internal only, use ConnectorNode.setLocalDeliveryHandler()
      expect(typeof AdminServer).toBe('function');
      expect(typeof AccountManager).toBe('function');
      expect(typeof SettlementMonitor).toBe('function');
      expect(typeof UnifiedSettlementExecutor).toBe('function');
      expect(typeof createLogger).toBe('function');
    });

    it('should NOT export main', () => {
      expect('main' in lib).toBe(false);
    });
  });

  describe('type exports compile with full type safety', () => {
    it('should construct ConnectorConfig with PeerConfig[] and RouteConfig[]', () => {
      const peers: PeerConfig[] = [
        { id: 'peer-a', url: 'ws://localhost:3000', authToken: 'secret' },
      ];

      const routes: RouteConfig[] = [{ prefix: 'g.test', nextHop: 'peer-a', priority: 10 }];

      const settlement: SettlementConfig = {
        connectorFeePercentage: 0.1,
        enableSettlement: true,
        tigerBeetleClusterId: 0,
        tigerBeetleReplicas: ['localhost:3000'],
      };

      const config: ConnectorConfig = {
        nodeId: 'test-node',
        btpServerPort: 3000,
        peers,
        routes,
        settlement,
        environment: 'development',
      };

      expect(config.nodeId).toBe('test-node');
      expect(config.peers).toHaveLength(1);
      expect(config.routes).toHaveLength(1);
    });

    it('should type-check LocalDeliveryHandler function signature', () => {
      const handler: LocalDeliveryHandler = async (
        _packet: LocalDeliveryRequest,
        _sourcePeerId: string
      ): Promise<LocalDeliveryResponse> => {
        return {
          fulfill: {
            data: Buffer.alloc(0).toString('base64'),
          },
        };
      };

      expect(typeof handler).toBe('function');
    });

    it('should type-check SendPacketParams without any casts', () => {
      const params: SendPacketParams = {
        destination: 'g.test.receiver',
        amount: 1000n,
        expiresAt: new Date(),
        data: Buffer.from('test'),
      };

      expect(params.destination).toBe('g.test.receiver');
      expect(params.amount).toBe(1000n);
    });

    it('should type-check SendPacketParams.executionCondition as Uint8Array or base64 string', () => {
      const withBytes: SendPacketParams = {
        destination: 'g.test.receiver',
        amount: 1000n,
        expiresAt: new Date(),
        executionCondition: new Uint8Array(32).fill(1),
      };
      const withBase64: SendPacketParams = {
        destination: 'g.test.receiver',
        amount: 1000n,
        expiresAt: new Date(),
        executionCondition: Buffer.alloc(32, 1).toString('base64'),
      };

      expect(withBytes.executionCondition).toBeInstanceOf(Uint8Array);
      expect(typeof withBase64.executionCondition).toBe('string');
    });

    it('should type-check LocalDeliveryConfig', () => {
      const localDelivery: LocalDeliveryConfig = {
        enabled: true,
        handlerUrl: 'http://localhost:8080',
        timeout: 30000,
      };

      expect(localDelivery.enabled).toBe(true);
    });

    it('should type-check ILP packet types', () => {
      // ILPPreparePacket - type uses PacketType.PREPARE enum (value 12)
      const prepare: ILPPreparePacket = {
        type: 12 as ILPPreparePacket['type'],
        destination: 'g.test',
        amount: 100n,
        expiresAt: new Date(),
        data: Buffer.alloc(0),
      };

      // ILPFulfillPacket - type uses PacketType.FULFILL enum (value 13)
      const fulfill: ILPFulfillPacket = {
        type: 13 as ILPFulfillPacket['type'],
        data: Buffer.alloc(0),
      };

      // ILPRejectPacket - type uses PacketType.REJECT enum (value 14)
      const reject: ILPRejectPacket = {
        type: 14 as ILPRejectPacket['type'],
        code: 'F00' as ILPRejectPacket['code'],
        triggeredBy: 'g.test',
        message: 'error',
        data: Buffer.alloc(0),
      };

      expect(prepare.type).toBe(12);
      expect(fulfill.type).toBe(13);
      expect(reject.type).toBe(14);
    });

    it('should type-check PeerInfo and PeerAccountBalance', () => {
      const peerInfo: PeerInfo = {
        id: 'peer-a',
        connected: true,
        ilpAddresses: ['g.peer-a'],
        routeCount: 1,
      };

      const balance: PeerAccountBalance = {
        peerId: 'peer-a',
        balances: [
          {
            tokenId: 'USD',
            debitBalance: '1000',
            creditBalance: '500',
            netBalance: '-500',
          },
        ],
      };

      expect(peerInfo.id).toBe('peer-a');
      expect(balance.peerId).toBe('peer-a');
    });

    it('should type-check RouteInfo and RemovePeerResult', () => {
      const routeInfo: RouteInfo = {
        prefix: 'g.test',
        nextHop: 'peer-a',
        priority: 10,
      };

      const removeResult: RemovePeerResult = {
        peerId: 'peer-a',
        removedRoutes: ['g.test'],
      };

      expect(routeInfo.prefix).toBe('g.test');
      expect(removeResult.peerId).toBe('peer-a');
    });

    it('should type-check PeerRegistrationRequest', () => {
      const request: PeerRegistrationRequest = {
        id: 'peer-b',
        url: 'ws://peer-b:3000',
        authToken: 'token',
      };

      expect(request.id).toBe('peer-b');
    });

    it('should type-check AdminSettlementConfig', () => {
      const adminConfig: AdminSettlementConfig = {
        preference: 'evm',
        evmAddress: '0x1234567890abcdef1234567890abcdef12345678',
      };

      expect(adminConfig.preference).toBe('evm');
    });
  });
});
