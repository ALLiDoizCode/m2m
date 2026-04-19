/**
 * Multi-Hop ATOR SDK E2E Integration Test
 *
 * Routes ILP PREPARE/FULFILL packets across a 3-peer ConnectorNode chain
 * where BTP connections tunnel through a locally-spawned `anon` binary
 * managed by the @anyone-protocol/anyone-client SDK.
 *
 * Two modes:
 *   1. Local testnet (ATOR_NIGHTLY=1): SDK binary joins the Docker testnet
 *      via host-exposed DirAuth/relay ports — fast bootstrap (~30s)
 *   2. Public network (ATOR_PUBLIC=1): SDK binary bootstraps against the
 *      real Anyone Protocol network — slower (~60-90s)
 *
 * Prerequisites:
 *   make anvil-up                    # EVM settlement backend
 *   # For local testnet mode:
 *   make ator-up                     # Docker ATOR testnet
 *   ATOR_NIGHTLY=1 EVM_INTEGRATION=true npm run test:integration -- --testPathPattern multi-hop-ator-sdk
 *   # For public network mode:
 *   ATOR_PUBLIC=1 EVM_INTEGRATION=true npm run test:integration -- --testPathPattern multi-hop-ator-sdk
 *
 * @module test/integration/multi-hop-ator-sdk-e2e
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import {
  createMultiHopTestNetwork,
  waitForAnvilReady,
  type MultiHopTestNetwork,
} from './multi-hop-helpers';
import { ManagedAnonClient } from '../../src/transport/managed-anon-client';
import type { AnonFactoryOptions, AnonSdkHandle } from '../../src/transport/managed-anon-client';
import { PacketType } from '@toon-protocol/shared';
import pino from 'pino';

const execAsync = promisify(execCb);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const ATOR_NIGHTLY = process.env.ATOR_NIGHTLY === '1';
const ATOR_PUBLIC = process.env.ATOR_PUBLIC === '1';
const EVM_INTEGRATION = process.env.EVM_INTEGRATION === 'true';

const RUN_TEST = (ATOR_NIGHTLY || ATOR_PUBLIC) && EVM_INTEGRATION;
const describeSDK = RUN_TEST ? describe : describe.skip;

jest.setTimeout(300_000);

const SDK_SOCKS_PORT = 19050 + Math.floor(Math.random() * 1000);
const logger = pino({ level: 'warn' });

function realAnonFactory(opts: AnonFactoryOptions): AnonSdkHandle {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const AnonModule = require('@anyone-protocol/anyone-client');
  const AnonCtor =
    AnonModule.Process ??
    AnonModule.Anon ??
    AnonModule.default?.Process ??
    AnonModule.default?.Anon ??
    AnonModule.default;
  if (typeof AnonCtor !== 'function') {
    throw new Error('@anyone-protocol/anyone-client did not export Process or Anon constructor');
  }
  return new AnonCtor(opts) as AnonSdkHandle;
}

describeSDK('Multi-Hop ATOR SDK E2E (3-Peer, SDK-Managed Binary)', () => {
  let network: MultiHopTestNetwork;
  let managedClient: ManagedAnonClient;
  let tempDir: string;

  beforeAll(async () => {
    await waitForAnvilReady(30_000);

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ator-sdk-e2e-'));

    // Write anonrc with testnet DirAuthority lines if using local testnet
    if (ATOR_NIGHTLY) {
      try {
        const { stdout } = await execAsync(
          "docker compose exec -T dirauth1 grep '^DirAuthority' /etc/anon/torrc",
          { cwd: REPO_ROOT }
        );
        // Rewrite DirAuthority lines to use host-mapped ports
        // Docker internal: DirAuthority dirauth1 orport=9001 v3ident=... 192.168.x.y:9030 FP
        // Host-mapped: DirAuthority dirauth1 orport=19001 v3ident=... 127.0.0.1:19030 FP
        const hostLines = stdout
          .trim()
          .split('\n')
          .map((line, idx) => {
            const orportMap = [19001, 19002, 19003];
            const dirportMap = [19030, 19031, 19032];
            return line
              .replace(/orport=\d+/, `orport=${orportMap[idx]}`)
              .replace(/\d+\.\d+\.\d+\.\d+:\d+/, `127.0.0.1:${dirportMap[idx]}`);
          })
          .join('\n');

        fs.writeFileSync(
          path.join(tempDir, 'anonrc'),
          `AgreeToTerms 1\nTestingTorNetwork 1\nAssumeReachable 1\n${hostLines}\n`,
          { encoding: 'utf8' }
        );
      } catch (err) {
        throw new Error(
          `Failed to read DirAuthority lines from Docker testnet: ${(err as Error).message}. ` +
            'Is `make ator-up` running?'
        );
      }
    } else {
      // Public network mode — just agree to terms
      fs.writeFileSync(path.join(tempDir, 'anonrc'), 'AgreeToTerms 1\n', { encoding: 'utf8' });
    }

    // Create ManagedAnonClient using the SDK
    managedClient = new ManagedAnonClient({
      socksProxy: `socks5h://127.0.0.1:${SDK_SOCKS_PORT}`,
      hiddenServiceDir: tempDir,
      startupTimeoutMs: ATOR_PUBLIC ? 120_000 : 90_000,
      logger,
      anonFactory: realAnonFactory,
    });

    await managedClient.start();
    expect(managedClient.isRunning()).toBe(true);

    const actualPort = SDK_SOCKS_PORT;

    // Create 3-peer network routing through SDK-managed SOCKS proxy
    network = createMultiHopTestNetwork(3, {
      settlementThreshold: 5000n,
      connectorFeePercentage: 0.1,
      pollingInterval: 100,
      logLevel: 'warn',
      transport: {
        type: 'socks5',
        socksProxy: `socks5h://127.0.0.1:${actualPort}`,
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
    if (managedClient) {
      try {
        await managedClient.stop();
      } catch {
        // swallow
      }
    }
    // Kill any orphan anon processes
    try {
      await execAsync('pkill -x anon || true');
    } catch {
      // swallow
    }
    // Clean up temp dir
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // swallow
      }
    }
  });

  it('T-ATOR-SDK-001: SDK-managed anon binary is running', () => {
    expect(managedClient.isRunning()).toBe(true);
  });

  it('T-ATOR-SDK-002: ILP FULFILL across 3 hops through SDK-managed SOCKS proxy', async () => {
    const result = await network.sendPacket(0, 'test.peer3.receiver', 10000n);
    expect(result.type).toBe(PacketType.FULFILL);
  });

  it('T-ATOR-SDK-003: settlement balance recorded after SDK-routed fulfill', async () => {
    const result = await network.sendPacket(0, 'test.peer3.receiver', 10000n);
    expect(result.type).toBe(PacketType.FULFILL);

    const balance = await network.getBalance(0, 'peer2');
    expect(balance.balances.length).toBeGreaterThan(0);
  });

  it('T-ATOR-SDK-004: bi-directional ILP flow through SDK binary', async () => {
    const fwd = await network.sendPacket(0, 'test.peer3.receiver', 5000n);
    expect(fwd.type).toBe(PacketType.FULFILL);

    const rev = await network.sendPacket(2, 'test.peer1.receiver', 5000n);
    expect(rev.type).toBe(PacketType.FULFILL);
  });

  it('T-ATOR-SDK-005: 5 sequential packets through SDK-managed circuit', async () => {
    let fulfilled = 0;
    for (let i = 0; i < 5; i++) {
      const result = await network.sendPacket(0, 'test.peer3.receiver', 1000n);
      if (result.type === PacketType.FULFILL) fulfilled++;
    }
    expect(fulfilled).toBe(5);
  });
});
