/**
 * Multi-Hop Real ATOR E2E Integration Test
 *
 * Routes ILP PREPARE/FULFILL packets across a 3-peer ConnectorNode chain
 * where every BTP WebSocket connection tunnels through the REAL Docker
 * ATOR testnet (3-hop onion circuits, real consensus, real cell fragmentation).
 *
 *   Peer1 --[ator 3-hop circuit]--> Peer2 --[ator 3-hop circuit]--> Peer3
 *
 * This is the definitive test: real ILP packets through real onion routing.
 *
 * Prerequisites:
 *   make anvil-up      # EVM settlement backend
 *   make ator-up       # ATOR testnet (wait for Bootstrapped 100%)
 *   make ator-test     # Sets ATOR_NIGHTLY=1 + ATOR_SOCKS_PORT
 *
 * Or run directly:
 *   ATOR_NIGHTLY=1 EVM_INTEGRATION=true ATOR_SOCKS_PORT=9150 \
 *     npx jest test/integration/multi-hop-ator-real-e2e
 *
 * @module test/integration/multi-hop-ator-real-e2e
 */

import {
  createMultiHopTestNetwork,
  waitForAnvilReady,
  type MultiHopTestNetwork,
} from './multi-hop-helpers';
import { PacketType } from '@toon-protocol/shared';

const ATOR_NIGHTLY = process.env.ATOR_NIGHTLY === '1';
const EVM_INTEGRATION = process.env.EVM_INTEGRATION === 'true';
const ATOR_SOCKS_PORT = process.env.ATOR_SOCKS_PORT;

const RUN_TEST = ATOR_NIGHTLY && EVM_INTEGRATION && !!ATOR_SOCKS_PORT;
const describeReal = RUN_TEST ? describe : describe.skip;

jest.setTimeout(300_000);

describeReal('Multi-Hop Real ATOR E2E (3-Peer, Real Onion Circuits)', () => {
  let network: MultiHopTestNetwork;

  beforeAll(async () => {
    await waitForAnvilReady(30_000);

    network = createMultiHopTestNetwork(3, {
      settlementThreshold: 5000n,
      connectorFeePercentage: 0.1,
      pollingInterval: 100,
      logLevel: 'warn',
      transport: {
        type: 'socks5',
        socksProxy: `socks5h://127.0.0.1:${ATOR_SOCKS_PORT}`,
        externalUrl: 'ws://placeholder',
        managed: false,
      },
      peerHost: 'host.docker.internal',
      startupDelayMs: 3_000,
      connectionWaitMs: 90_000,
    });

    await network.start();
  });

  afterAll(async () => {
    if (network) await network.stop();
  });

  it('T-ATOR-REAL-001: ILP FULFILL delivered across 3 hops through real onion circuit', async () => {
    const result = await network.sendPacket(0, 'test.peer3.receiver', 10000n);
    expect(result.type).toBe(PacketType.FULFILL);
  });

  it('T-ATOR-REAL-002: settlement balance recorded after real-circuit fulfill', async () => {
    const result = await network.sendPacket(0, 'test.peer3.receiver', 10000n);
    expect(result.type).toBe(PacketType.FULFILL);

    const balance = await network.getBalance(0, 'peer2');
    expect(balance.balances.length).toBeGreaterThan(0);
  });

  it('T-ATOR-REAL-003: reject propagation through real onion circuit', async () => {
    const result = await network.sendPacket(0, 'test.nonexistent.receiver', 10000n);
    expect(result.type).toBe(PacketType.REJECT);
  });

  it('T-ATOR-REAL-004: bi-directional ILP flow through real circuits', async () => {
    const fwd = await network.sendPacket(0, 'test.peer3.receiver', 5000n);
    expect(fwd.type).toBe(PacketType.FULFILL);

    const rev = await network.sendPacket(2, 'test.peer1.receiver', 5000n);
    expect(rev.type).toBe(PacketType.FULFILL);
  });

  it('T-ATOR-REAL-005: 5 sequential packets through real circuit', async () => {
    let fulfilled = 0;
    for (let i = 0; i < 5; i++) {
      const result = await network.sendPacket(0, 'test.peer3.receiver', 1000n);
      if (result.type === PacketType.FULFILL) fulfilled++;
    }
    expect(fulfilled).toBe(5);
  });
});
