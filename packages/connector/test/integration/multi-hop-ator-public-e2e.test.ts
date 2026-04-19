/**
 * Multi-Hop Anyone Public Proxy E2E Integration Test
 *
 * Routes ILP PREPARE/FULFILL packets across a 3-peer ConnectorNode chain
 * where every BTP WebSocket connection tunnels through a public Anyone
 * Protocol SOCKS5 proxy — real onion routing on the live network, zero
 * local setup beyond Anvil.
 *
 * Public proxies maintained by the Anyone team:
 *   - 5.78.181.0:9052   (Oregon, USA)
 *   - 157.90.113.23:9052 (Nürnberg, Germany)
 *   - 57.128.249.250:9052 (Warsaw, Poland)
 *
 * Prerequisites:
 *   make anvil-up
 *   ATOR_PUBLIC=1 EVM_INTEGRATION=true npm run test:integration \
 *     -- --testPathPattern multi-hop-ator-public
 *
 * @module test/integration/multi-hop-ator-public-e2e
 */

import {
  createMultiHopTestNetwork,
  waitForAnvilReady,
  type MultiHopTestNetwork,
} from './multi-hop-helpers';
import { PacketType } from '@toon-protocol/shared';

const ATOR_PUBLIC = process.env.ATOR_PUBLIC === '1';
const EVM_INTEGRATION = process.env.EVM_INTEGRATION === 'true';

const RUN_TEST = ATOR_PUBLIC && EVM_INTEGRATION;
const describePublic = RUN_TEST ? describe : describe.skip;

const ANYONE_PUBLIC_PROXIES = [
  { host: '5.78.181.0', port: 9052, label: 'Oregon' },
  { host: '157.90.113.23', port: 9052, label: 'Nürnberg' },
  { host: '57.128.249.250', port: 9052, label: 'Warsaw' },
];

jest.setTimeout(300_000);

describePublic('Multi-Hop Anyone Public Proxy E2E (3-Peer, Live Network)', () => {
  let network: MultiHopTestNetwork;
  let selectedProxy: (typeof ANYONE_PUBLIC_PROXIES)[0];

  beforeAll(async () => {
    await waitForAnvilReady(30_000);

    // Pick the first reachable proxy
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { SocksClient } = require('socks') as typeof import('socks');
    for (const proxy of ANYONE_PUBLIC_PROXIES) {
      try {
        const { socket } = await SocksClient.createConnection({
          proxy: { host: proxy.host, port: proxy.port, type: 5 },
          command: 'connect',
          destination: { host: 'api.ipify.org', port: 80 },
          timeout: 10_000,
        });
        socket.destroy();
        selectedProxy = proxy;
        break;
      } catch {
        continue;
      }
    }
    if (!selectedProxy) {
      throw new Error(
        'No public Anyone proxy reachable — check https://docs.anyone.io/connect/public-proxies'
      );
    }

    network = createMultiHopTestNetwork(3, {
      settlementThreshold: 5000n,
      connectorFeePercentage: 0.1,
      pollingInterval: 100,
      logLevel: 'warn',
      transport: {
        type: 'socks5',
        socksProxy: `socks5h://${selectedProxy.host}:${selectedProxy.port}`,
        externalUrl: 'ws://placeholder',
        managed: false,
      },
      startupDelayMs: 3_000,
      connectionWaitMs: 90_000,
    });

    await network.start();
  });

  afterAll(async () => {
    if (network) await network.stop();
  });

  it('T-ATOR-PUB-001: connected to public Anyone proxy', () => {
    expect(selectedProxy).toBeDefined();
    expect(selectedProxy.host).toBeTruthy();
  });

  it('T-ATOR-PUB-002: SocksTransportProvider starts with public proxy', async () => {
    // The transport provider successfully probed the public proxy during
    // network.start() — if it threw, beforeAll would have failed.
    expect(network.peers.length).toBe(3);
  });

  it('T-ATOR-PUB-003: reject propagation through public proxy', async () => {
    const result = await network.sendPacket(0, 'test.nonexistent.receiver', 10000n);
    expect(result.type).toBe(PacketType.REJECT);
  });

  it('T-ATOR-PUB-004: public proxy routes SOCKS traffic to external hosts', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { SocksClient } = require('socks') as typeof import('socks');
    const { socket } = await SocksClient.createConnection({
      proxy: { host: selectedProxy.host, port: selectedProxy.port, type: 5 },
      command: 'connect',
      destination: { host: 'api.ipify.org', port: 80 },
      timeout: 15_000,
    });
    socket.write('GET /?format=json HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n');
    const data = await new Promise<string>((resolve) => {
      let buf = '';
      socket.on('data', (d: Buffer) => {
        buf += d.toString();
      });
      socket.on('end', () => resolve(buf));
    });
    socket.destroy();
    const body = data.split('\r\n\r\n')[1] ?? '';
    const parsed = JSON.parse(body);
    expect(parsed.ip).toBeTruthy();
    expect(parsed.ip).not.toBe('127.0.0.1');
  });
});
