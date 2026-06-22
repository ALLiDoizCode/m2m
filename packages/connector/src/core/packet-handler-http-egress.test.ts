/**
 * Forward-seam dispatch tests (Epic 38, Story 38.1).
 *
 * Verifies {@link PacketHandler.forwardToNextHop} branches on a peer's packet
 * protocol BEFORE the BTP connectivity checks:
 * - an 'ilp-http' peer forwards through the real HTTP egress + a real receiver,
 * - a 'btp' peer (default) takes the unchanged BTP path (AC5: byte-for-byte).
 *
 * Mock-free: real RoutingTable, real BTPClientManager (no peers → its existing
 * "no active BTP connection → T01" path), real HttpPeerClientManager, and a real
 * `node:http` receiver fixture.
 */

import {
  PacketType,
  ILPErrorCode,
  type ILPPreparePacket,
  type ILPRejectPacket,
} from '@toon-protocol/shared';
import { createLogger } from '../utils/logger';
import { PacketHandler } from './packet-handler';
import { RoutingTable } from '../routing/routing-table';
import { BTPClientManager } from '../btp/btp-client-manager';
import { HttpPeerClientManager } from '../transport/http-peer-transport';
import { DirectTransportProvider } from '../transport/direct-transport-provider';
import { HttpPeerTestServer } from '../../test/fixtures/http-peer-test-server';
import type { ILPAddress } from '@toon-protocol/shared';

const logger = createLogger('forward-seam-test', 'silent');
const transport = new DirectTransportProvider('ws://localhost:9999');

const buildPrepare = (destination: string): ILPPreparePacket => ({
  type: PacketType.PREPARE,
  amount: 100n,
  destination,
  expiresAt: new Date(Date.now() + 30_000),
  data: Buffer.alloc(0),
});

describe('PacketHandler forward-seam dispatch (BTP vs ILP-HTTP)', () => {
  let server: HttpPeerTestServer;
  let routingTable: RoutingTable;
  let btp: BTPClientManager;
  let httpEgress: HttpPeerClientManager;
  let handler: PacketHandler;

  beforeEach(async () => {
    server = new HttpPeerTestServer();
    await server.start();

    routingTable = new RoutingTable();
    btp = new BTPClientManager('test.this-node', logger);
    httpEgress = new HttpPeerClientManager('test.this-node', logger, transport);
    handler = new PacketHandler(routingTable, btp, 'test.this-node', logger);
    handler.setHttpEgress(httpEgress);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('routes an ilp-http peer through the HTTP egress (fulfill)', async () => {
    routingTable.addRoute('test.httppeer' as ILPAddress, 'httppeer', 0);
    await httpEgress.addPeer({ id: 'httppeer', httpUrl: server.url, authToken: 'tok' });
    handler.setPeerProtocol('httppeer', 'ilp-http');
    // 'child' next hop skips the mandatory per-packet claim, so a value-bearing
    // PREPARE reaches the forward seam without a PerPacketClaimService wired.
    handler.setPeerRelation('httppeer', 'child');
    server.setBehavior({ kind: 'fulfill', fulfillment: Buffer.alloc(32, 3) });

    const res = await handler.handlePreparePacket(buildPrepare('test.httppeer.dest'), 'src');

    expect(res.type).toBe(PacketType.FULFILL);
    expect(server.requests).toHaveLength(1);
    expect(server.lastRequest!.headers['ilp-peer-id']).toBe('test.this-node');
  });

  it('maps HTTP-peer connection failure to T01', async () => {
    await server.stop();
    routingTable.addRoute('test.dead' as ILPAddress, 'dead', 0);
    await httpEgress.addPeer({ id: 'dead', httpUrl: server.url, authToken: 'tok' });
    handler.setPeerProtocol('dead', 'ilp-http');
    handler.setPeerRelation('dead', 'child');

    const res = await handler.handlePreparePacket(buildPrepare('test.dead.x'), 'src');

    expect(res.type).toBe(PacketType.REJECT);
    expect((res as ILPRejectPacket).code).toBe(ILPErrorCode.T01_PEER_UNREACHABLE);

    server = new HttpPeerTestServer();
    await server.start();
  });

  it('AC5 regression: a BTP peer (default protocol) takes the unchanged BTP path', async () => {
    // No protocol set → defaults to BTP. No BTP connection exists, so the BTP
    // path's "no active BTP connection" → T01 fires. The HTTP receiver must
    // NEVER be touched (proves dispatch did not leak BTP traffic to HTTP).
    routingTable.addRoute('test.btppeer' as ILPAddress, 'btppeer', 0);
    handler.setPeerRelation('btppeer', 'child');

    const res = await handler.handlePreparePacket(buildPrepare('test.btppeer.dest'), 'src');

    expect(res.type).toBe(PacketType.REJECT);
    expect((res as ILPRejectPacket).code).toBe(ILPErrorCode.T01_PEER_UNREACHABLE);
    expect(server.requests).toHaveLength(0); // BTP path never hit the HTTP receiver
  });

  it('AC5 regression: explicit btp protocol is identical to the default BTP path', async () => {
    routingTable.addRoute('test.btp2' as ILPAddress, 'btp2', 0);
    handler.setPeerProtocol('btp2', 'btp');
    handler.setPeerRelation('btp2', 'child');

    const res = await handler.handlePreparePacket(buildPrepare('test.btp2.dest'), 'src');

    expect(res.type).toBe(PacketType.REJECT);
    expect((res as ILPRejectPacket).code).toBe(ILPErrorCode.T01_PEER_UNREACHABLE);
    expect(server.requests).toHaveLength(0);
  });

  it('ilp-http peer with no egress wired rejects with T00', async () => {
    const bareHandler = new PacketHandler(routingTable, btp, 'test.this-node', logger);
    routingTable.addRoute('test.noegress' as ILPAddress, 'noegress', 0);
    bareHandler.setPeerProtocol('noegress', 'ilp-http');
    bareHandler.setPeerRelation('noegress', 'child');

    const res = await bareHandler.handlePreparePacket(buildPrepare('test.noegress.x'), 'src');

    expect(res.type).toBe(PacketType.REJECT);
    expect((res as ILPRejectPacket).code).toBe(ILPErrorCode.T00_INTERNAL_ERROR);
  });
});
