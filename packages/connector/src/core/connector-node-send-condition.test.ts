/**
 * End-to-end round trip for sender-chosen execution conditions on the PUBLIC
 * egress API (`ConnectorNode.sendPacket`) — the egress-side symmetry of the
 * issue #309/PR #310 receiving path (toon-meta#145 §3 R4).
 *
 * These construct a REAL ConnectorNode from a config object (no module mocks;
 * construction does not open sockets — same pattern as
 * connector-node-self-announce.test.ts) so `sendPacket` flows through the real
 * PacketHandler: routing-table longest-prefix match → local delivery → the
 * #309 sender-condition enforcement (`sha256(fulfillment) === condition`) →
 * the FULFILL/REJECT returned to the caller with the app-supplied preimage.
 *
 * @module core/connector-node-send-condition.test
 */

import { sha256 } from '@noble/hashes/sha2';
import {
  PacketType,
  ILPErrorCode,
  type ILPFulfillPacket,
  type ILPRejectPacket,
} from '@toon-protocol/shared';
import { ConnectorNode } from './connector-node';
import { InvalidExecutionConditionError } from '../config/config-loader';
import { createLogger } from '../utils/logger';
import type { ConnectorConfig, LocalDeliveryRequest } from '../config/types';

// 'error' keeps the suite output quiet (the logger has no true silent level).
const logger = createLogger('connector-send-condition-test', 'error');

/** Sender-minted preimage/condition pair (spec R1: C = sha256(P)). */
const PREIMAGE = new Uint8Array(32).fill(0x42);
const CONDITION = new Uint8Array(sha256(PREIMAGE));

function makeConfig(): ConnectorConfig {
  return {
    nodeId: 'connector',
    btpServerPort: 3000,
    healthCheckPort: 8080,
    environment: 'development',
    peers: [],
    // nextHop === nodeId → local delivery (the #309 receiving path).
    routes: [{ prefix: 'g.local', nextHop: 'connector' }],
  };
}

/**
 * Build a real node whose local delivery handler is a function handler, and
 * mark the started flag so `sendPacket` is callable without opening sockets.
 */
function makeNode(
  handler: (packet: LocalDeliveryRequest) => Promise<{
    fulfill?: { data?: string; fulfillment?: string };
    reject?: { code: string; message: string };
  }>
): ConnectorNode {
  const node = new ConnectorNode(makeConfig(), logger);
  node.setLocalDeliveryHandler(async (packet) => handler(packet));
  // sendPacket only gates on the started flag; local delivery needs no sockets.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (node as any)._btpServerStarted = true;
  return node;
}

describe('ConnectorNode.sendPacket — sender-chosen executionCondition round trip', () => {
  const baseParams = {
    destination: 'g.local.wallet',
    amount: 0n,
    expiresAt: new Date(Date.now() + 30_000),
    data: Buffer.from('leg-b-fill'),
  };

  it('delivers the condition verbatim (base64) and returns the app preimage on the FULFILL', async () => {
    const seen: LocalDeliveryRequest[] = [];
    const node = makeNode(async (packet) => {
      seen.push(packet);
      return { fulfill: { fulfillment: Buffer.from(PREIMAGE).toString('base64') } };
    });

    const result = await node.sendPacket({ ...baseParams, executionCondition: CONDITION });

    // The terminating handler saw exactly the sender's condition.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.executionCondition).toBe(Buffer.from(CONDITION).toString('base64'));

    // The caller gets the FULFILL carrying the app-supplied preimage…
    expect(result.type).toBe(PacketType.FULFILL);
    const fulfillment = (result as ILPFulfillPacket).fulfillment!;
    expect(Buffer.from(fulfillment)).toEqual(Buffer.from(PREIMAGE));
    // …and can verify sha256(P) === C (the swap engine's R6 check).
    expect(Buffer.from(sha256(new Uint8Array(fulfillment)))).toEqual(Buffer.from(CONDITION));
  });

  it('accepts the condition as a base64 string with the identical round trip', async () => {
    const node = makeNode(async () => ({
      fulfill: { fulfillment: Buffer.from(PREIMAGE).toString('base64') },
    }));

    const result = await node.sendPacket({
      ...baseParams,
      executionCondition: Buffer.from(CONDITION).toString('base64'),
    });

    expect(result.type).toBe(PacketType.FULFILL);
    expect(Buffer.from((result as ILPFulfillPacket).fulfillment!)).toEqual(Buffer.from(PREIMAGE));
  });

  it('returns F99 when the terminating app supplies a preimage that does not match', async () => {
    const node = makeNode(async () => ({
      fulfill: { fulfillment: Buffer.from(new Uint8Array(32).fill(0x99)).toString('base64') },
    }));

    const result = await node.sendPacket({ ...baseParams, executionCondition: CONDITION });

    expect(result.type).toBe(PacketType.REJECT);
    expect((result as ILPRejectPacket).code).toBe(ILPErrorCode.F99_APPLICATION_ERROR);
  });

  it('leaves the zero-condition path unchanged when executionCondition is absent', async () => {
    const seen: LocalDeliveryRequest[] = [];
    const node = makeNode(async (packet) => {
      seen.push(packet);
      return { fulfill: {} };
    });

    const result = await node.sendPacket(baseParams);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.executionCondition).toBeUndefined();
    expect(result.type).toBe(PacketType.FULFILL);
  });

  it('rejects a malformed condition before any delivery is attempted', async () => {
    const handler = jest.fn().mockResolvedValue({ fulfill: {} });
    const node = makeNode(handler);

    await expect(
      node.sendPacket({ ...baseParams, executionCondition: new Uint8Array(31) })
    ).rejects.toThrow(InvalidExecutionConditionError);
    expect(handler).not.toHaveBeenCalled();
  });
});
