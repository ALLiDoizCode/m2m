/**
 * Multi-Hop SOCKS5 (ATOR Transport) E2E Integration Test
 *
 * Routes ILP packets across a 3-peer linear chain where every outbound
 * BTP WebSocket connection tunnels through an in-process SOCKS5 proxy:
 *
 *   Peer1 --[socks5]--> Peer2 --[socks5]--> Peer3
 *
 * This proves that ILP PREPARE/FULFILL packets traverse the full connector
 * pipeline (routing, fee deduction, settlement claims) when the transport
 * layer is SOCKS5 — the same path used by real ATOR overlay connections.
 *
 * Uses:
 *   - In-process SOCKS5 proxy (socks5-contract-fixture) — no Docker, no ATOR binary
 *   - Real Anvil blockchain (same as multi-hop-e2e.test.ts)
 *   - InMemoryLedgerClient for double-entry accounting
 *
 * Prerequisites:
 *   make anvil-up
 *   EVM_INTEGRATION=true npx jest test/integration/multi-hop-ator-e2e.test.ts
 *
 * @module test/integration/multi-hop-ator-e2e
 */

import {
  createMultiHopTestNetwork,
  waitForAnvilReady,
  type MultiHopTestNetwork,
} from './multi-hop-helpers';
import { startSocks5Proxy, type RunningProxy } from '../helpers/socks5-contract-fixture';
import { PacketType } from '@toon-protocol/shared';

const RUN_EVM_TESTS = process.env.EVM_INTEGRATION === 'true';
const describeEvm = RUN_EVM_TESTS ? describe : describe.skip;

jest.setTimeout(180_000);

describeEvm('Multi-Hop SOCKS5 Transport E2E (3-Peer Linear Chain)', () => {
  let network: MultiHopTestNetwork;
  let proxy: RunningProxy;

  beforeAll(async () => {
    await waitForAnvilReady(30_000);

    proxy = await startSocks5Proxy();

    network = createMultiHopTestNetwork(3, {
      settlementThreshold: 5000n,
      connectorFeePercentage: 0.1,
      pollingInterval: 100,
      logLevel: 'warn',
      transport: {
        type: 'socks5',
        socksProxy: `socks5h://127.0.0.1:${proxy.port}`,
        externalUrl: 'ws://placeholder',
        managed: false,
      },
    });

    await network.start();
  });

  afterAll(async () => {
    if (network) await network.stop();
    if (proxy) await proxy.stop();
  });

  it('T-SOCKS5-001: ILP packet delivered across 3 hops through SOCKS5 proxy', async () => {
    const amount = 10000n;
    const result = await network.sendPacket(0, 'test.peer3.receiver', amount);
    expect(result.type).toBe(PacketType.FULFILL);
  });

  it('T-SOCKS5-002: balance recorded after SOCKS5-routed fulfill', async () => {
    const amount = 10000n;
    const result = await network.sendPacket(0, 'test.peer3.receiver', amount);
    expect(result.type).toBe(PacketType.FULFILL);

    const peer1Balance = await network.getBalance(0, 'peer2');
    expect(peer1Balance.balances.length).toBeGreaterThan(0);
  });

  it('T-SOCKS5-003: reject propagation works through SOCKS5', async () => {
    const result = await network.sendPacket(0, 'test.nonexistent.receiver', 10000n);
    expect(result.type).toBe(PacketType.REJECT);
  });

  it('T-SOCKS5-004: 10 sequential packets all fulfilled through proxy', async () => {
    let fulfilled = 0;
    for (let i = 0; i < 10; i++) {
      const result = await network.sendPacket(0, 'test.peer3.receiver', 1000n);
      if (result.type === PacketType.FULFILL) fulfilled++;
    }
    expect(fulfilled).toBe(10);
  });

  it('T-SOCKS5-005: bi-directional flow through SOCKS5', async () => {
    const fwd = await network.sendPacket(0, 'test.peer3.receiver', 5000n);
    expect(fwd.type).toBe(PacketType.FULFILL);

    const rev = await network.sendPacket(2, 'test.peer1.receiver', 5000n);
    expect(rev.type).toBe(PacketType.FULFILL);
  });

  it('T-SOCKS5-006: proxy observed BTP CONNECT tunnels', async () => {
    expect(proxy.connects.length).toBeGreaterThan(0);
    for (const c of proxy.connects) {
      expect(c.destHost).toMatch(/localhost|127\.0\.0\.1/);
    }
  });
});
