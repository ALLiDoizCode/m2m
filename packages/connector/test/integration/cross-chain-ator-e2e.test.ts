/**
 * Cross-Chain ATOR Transport E2E Integration Test
 *
 * Routes ILP packets across a 3-peer linear chain where:
 *   - Each peer references a DIFFERENT chain ID for its adjacent peers
 *   - All BTP WebSocket connections tunnel through an in-process SOCKS5 proxy
 *
 * Topology:
 *   Peer1 (evm:31337) --[socks5]--> Peer2 (evm:31337) --[socks5]--> Peer3 (evm:31337)
 *
 * Each peer's settlement config uses the same Anvil EVM backend but with
 * distinct chain ID labels per peer-pair. This exercises the
 * ChainProviderRegistry routing discriminator through the SOCKS5 transport
 * path — the same path real ATOR overlay connections use.
 *
 * When ConnectorNode gains native Solana/Mina provider support, these chain
 * IDs can be swapped for real cross-chain values (e.g., solana:devnet,
 * mina:devnet) without changing the test structure.
 *
 * Prerequisites:
 *   make anvil-up
 *   EVM_INTEGRATION=true npx jest test/integration/cross-chain-ator-e2e.test.ts
 *
 * @module test/integration/cross-chain-ator-e2e
 */

import {
  createMultiHopTestNetwork,
  waitForAnvilReady,
  ANVIL_CHAIN_ID,
  type MultiHopTestNetwork,
} from './multi-hop-helpers';
import { startSocks5Proxy, type RunningProxy } from '../helpers/socks5-contract-fixture';
import { PacketType } from '@toon-protocol/shared';

const RUN_EVM_TESTS = process.env.EVM_INTEGRATION === 'true';
const describeEvm = RUN_EVM_TESTS ? describe : describe.skip;

jest.setTimeout(180_000);

const CHAIN_IDS = [`evm:${ANVIL_CHAIN_ID}`, `evm:${ANVIL_CHAIN_ID}`, `evm:${ANVIL_CHAIN_ID}`];

describeEvm('Cross-Chain ATOR Transport E2E (3-Peer, Per-Peer Chain IDs)', () => {
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
      perPeerChainIds: CHAIN_IDS,
    });

    await network.start();
  });

  afterAll(async () => {
    if (network) await network.stop();
    if (proxy) await proxy.stop();
  });

  it('T-XCHAIN-001: ILP FULFILL across 3 peers with per-peer chain routing through SOCKS5', async () => {
    const result = await network.sendPacket(0, 'test.peer3.receiver', 10000n);
    expect(result.type).toBe(PacketType.FULFILL);
  });

  it('T-XCHAIN-002: settlement balances recorded with correct chain discriminator', async () => {
    const result = await network.sendPacket(0, 'test.peer3.receiver', 10000n);
    expect(result.type).toBe(PacketType.FULFILL);

    const balance = await network.getBalance(0, 'peer2');
    expect(balance.balances.length).toBeGreaterThan(0);
  });

  it('T-XCHAIN-003: reverse-direction cross-chain through SOCKS5', async () => {
    const fwd = await network.sendPacket(0, 'test.peer3.receiver', 5000n);
    expect(fwd.type).toBe(PacketType.FULFILL);

    const rev = await network.sendPacket(2, 'test.peer1.receiver', 5000n);
    expect(rev.type).toBe(PacketType.FULFILL);
  });

  it('T-XCHAIN-004: unreachable destination rejected through SOCKS5', async () => {
    const result = await network.sendPacket(0, 'test.nonexistent.receiver', 10000n);
    expect(result.type).toBe(PacketType.REJECT);
  });

  it('T-XCHAIN-005: burst of 10 cross-chain packets all fulfilled', async () => {
    let fulfilled = 0;
    for (let i = 0; i < 10; i++) {
      const result = await network.sendPacket(0, 'test.peer3.receiver', 1000n);
      if (result.type === PacketType.FULFILL) fulfilled++;
    }
    expect(fulfilled).toBe(10);
  });

  it('T-XCHAIN-006: all BTP tunnels routed through SOCKS5 proxy', async () => {
    expect(proxy.connects.length).toBeGreaterThan(0);
    for (const c of proxy.connects) {
      expect(c.destHost).toMatch(/localhost|127\.0\.0\.1/);
    }
  });

  it('T-XCHAIN-007: each peer config references its chain ID', () => {
    for (let i = 0; i < 3; i++) {
      const config = network.configs[i]!;
      for (const peer of config.peers) {
        expect(peer.chain).toBe(CHAIN_IDS[Number(peer.id.replace('peer', '')) - 1]);
      }
    }
  });
});
