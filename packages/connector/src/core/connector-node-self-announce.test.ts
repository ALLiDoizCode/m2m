/**
 * Unit tests for the ConnectorNode self-announce wiring (relay#37 / store#22).
 *
 * Exercises the branchy private seams the feature adds to ConnectorNode:
 *  - `_resolveNostrSecretKey` — EVM keyId (hex) hit, mnemonic-derive fallback,
 *    and the no-identity / invalid-mnemonic null paths.
 *  - `_startSelfAnnounce` — disabled / no-identity / enabled branches.
 *  - `_publishAnnouncement` — `routeTerminationRegistry.match` hit (local, free,
 *    amount 0) vs miss (remote, paid, amount = announcePrice), FULFILL vs REJECT.
 *
 * These construct a REAL ConnectorNode from a config object (no mocks, no
 * network — construction does not open sockets) so the real RouteTerminationRegistry
 * is built from the routes, and stub only `sendPacket` to capture the PREPARE.
 *
 * @module core/connector-node-self-announce.test
 */

import { ConnectorNode } from './connector-node';
import { EVMPaymentChannelProvider } from '../settlement/provider/evm-payment-channel-provider';
import { createLogger } from '../utils/logger';
import type { ConnectorConfig, SelfAnnounceConfig } from '../config/types';
import { PacketType, type ILPFulfillPacket, type ILPRejectPacket } from '@toon-protocol/shared';
import { buildIlpPeerInfoEvent } from '../discovery/ilp-peer-info-event';
import { generateSecretKey } from 'nostr-tools';

const logger = createLogger('connector-self-announce-test', 'silent');

// anvil account-0 deterministic private key (valid 0x-hex 32-byte key).
const HEX_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// Devnet apex demo seed (NIP-06).
const DEMO_MNEMONIC = 'giant goat guide develop boy wolf target embody leave sunny paddle neutral';

/** A signed kind:10032 used as the publish input. */
const SIGNED_EVENT = buildIlpPeerInfoEvent(
  { ilpAddress: 'g.proxy.store', btpEndpoint: '', assetCode: 'USDC', assetScale: 6 },
  generateSecretKey()
);

interface BuildOpts {
  selfAnnounce?: SelfAnnounceConfig;
  keyId?: string;
  /** When 'store', the node terminates g.proxy.store (so g.proxy.relay is REMOTE). */
  topology?: 'apex' | 'store';
  /** Omit chainProviders entirely (no EVM provider to read a keyId from). */
  noChainProviders?: boolean;
}

function makeConfig(opts: BuildOpts = {}): ConnectorConfig {
  const evmProvider = {
    chainType: 'evm',
    chainId: 'evm:31337',
    rpcUrl: 'http://localhost:8545',
    registryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    ...(opts.keyId !== undefined ? { keyId: opts.keyId } : {}),
  } as ConnectorConfig['chainProviders'] extends (infer T)[] ? T : never;

  const routes =
    opts.topology === 'store'
      ? [
          {
            prefix: 'g.proxy.store',
            nextHop: 'connector',
            upstream: 'http://store:3300',
            price: '1000',
            chains: ['evm' as const],
            ilpAddress: 'g.proxy.store',
            settlementAddresses: { evm: '0x1f4E12A9357a3c46477F95F6f9813eeBF49f106e' },
          },
        ]
      : [
          {
            prefix: 'g.proxy.relay',
            nextHop: 'connector',
            upstream: 'http://relay:3100',
            price: '1000',
            chains: ['evm' as const],
            ilpAddress: 'g.proxy.relay',
            settlementAddresses: { evm: '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab' },
          },
        ];

  return {
    nodeId: 'connector',
    btpServerPort: 3000,
    healthCheckPort: 8080,
    environment: 'development',
    peers: [
      {
        id: 'store-box',
        url: 'wss://store.example:443',
        authToken: '',
        chain: 'evm:31337',
        settlementAddress: '0x1f4E12A9357a3c46477F95F6f9813eeBF49f106e',
      },
    ],
    routes,
    ...(opts.noChainProviders ? {} : { chainProviders: [evmProvider] }),
    ...(opts.selfAnnounce ? { selfAnnounce: opts.selfAnnounce } : {}),
  };
}

function makeNode(opts: BuildOpts & { mnemonic?: string } = {}): ConnectorNode {
  return new ConnectorNode(
    makeConfig(opts),
    logger,
    opts.mnemonic ? { mnemonic: opts.mnemonic } : undefined
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('ConnectorNode._resolveNostrSecretKey', () => {
  const ORIGINAL_MNEMONIC = process.env.TOON_MNEMONIC;
  afterEach(() => {
    if (ORIGINAL_MNEMONIC === undefined) delete process.env.TOON_MNEMONIC;
    else process.env.TOON_MNEMONIC = ORIGINAL_MNEMONIC;
  });

  it('derives the key from a 0x-hex EVM keyId', () => {
    delete process.env.TOON_MNEMONIC;
    const node = makeNode({ keyId: HEX_KEY });
    const key = (node as any)._resolveNostrSecretKey() as Uint8Array | null;
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key!.length).toBe(32);
  });

  it('accepts a bare (no 0x prefix) 64-hex EVM keyId', () => {
    delete process.env.TOON_MNEMONIC;
    const node = makeNode({ keyId: HEX_KEY.slice(2) }); // 64 hex, no 0x
    const key = (node as any)._resolveNostrSecretKey() as Uint8Array | null;
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key!.length).toBe(32);
  });

  it('falls back to mnemonic derivation when keyId is not raw hex', () => {
    delete process.env.TOON_MNEMONIC;
    const node = makeNode({ keyId: 'evm-settlement', mnemonic: DEMO_MNEMONIC });
    const key = (node as any)._resolveNostrSecretKey() as Uint8Array | null;
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key!.length).toBe(32);
  });

  it('returns null when there is no hex keyId and no mnemonic', () => {
    delete process.env.TOON_MNEMONIC;
    const node = makeNode({ keyId: 'evm-settlement' });
    expect((node as any)._resolveNostrSecretKey()).toBeNull();
  });

  it('returns null when there is no EVM chain provider and no mnemonic', () => {
    // No chainProviders at all → the `chainProviders?.find(...)` / `?.keyId`
    // optional-chaining branches resolve undefined → mnemonic branch → null.
    delete process.env.TOON_MNEMONIC;
    const node = makeNode({ noChainProviders: true });
    expect((node as any)._resolveNostrSecretKey()).toBeNull();
  });

  it('returns null when the mnemonic is invalid (derive throws, caught)', () => {
    delete process.env.TOON_MNEMONIC;
    const node = makeNode({
      keyId: 'evm-settlement',
      mnemonic: 'not a valid bip39 mnemonic phrase',
    });
    expect((node as any)._resolveNostrSecretKey()).toBeNull();
  });
});

describe('ConnectorNode._startSelfAnnounce', () => {
  it('does nothing when selfAnnounce is absent', () => {
    const node = makeNode({ keyId: HEX_KEY });
    (node as any)._startSelfAnnounce();
    expect((node as any)._selfAnnounceService).toBeNull();
  });

  it('does nothing when selfAnnounce.enabled is false', () => {
    const node = makeNode({
      keyId: HEX_KEY,
      selfAnnounce: { enabled: false, announceTo: 'g.proxy.relay' },
    });
    (node as any)._startSelfAnnounce();
    expect((node as any)._selfAnnounceService).toBeNull();
  });

  it('skips (no service) when enabled but no signing identity is available', () => {
    delete process.env.TOON_MNEMONIC;
    const node = makeNode({
      keyId: 'evm-settlement', // not hex, no mnemonic → no identity
      selfAnnounce: { enabled: true, announceTo: 'g.proxy.relay' },
    });
    (node as any)._startSelfAnnounce();
    expect((node as any)._selfAnnounceService).toBeNull();
  });

  it('starts the service when enabled with a hex keyId identity', () => {
    const node = makeNode({
      keyId: HEX_KEY,
      selfAnnounce: { enabled: true, announceTo: 'g.proxy.relay', refreshIntervalSecs: 300 },
    });
    // Stub sendPacket so the service's boot publish does not hit the network.
    (node as any).sendPacket = jest
      .fn()
      .mockResolvedValue({ type: PacketType.FULFILL } as ILPFulfillPacket);
    (node as any)._startSelfAnnounce();
    const svc = (node as any)._selfAnnounceService;
    expect(svc).not.toBeNull();
    expect(svc.running).toBe(true);
    svc.stop();
  });
});

describe('ConnectorNode._resolveAnnounceTokenNetworks', () => {
  const TOKEN_NETWORK = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
  const TOKEN = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

  /**
   * A REAL EVMPaymentChannelProvider over a hand-written in-memory SDK stub —
   * only the three signing-context reads are implemented (no network).
   */
  function realEvmProvider(
    chainId: string,
    tokenNetworkAddress: string
  ): EVMPaymentChannelProvider {
    const sdk = {
      getChainId: async () => 31337,
      getTokenNetworkAddress: async () => tokenNetworkAddress,
      getSignerAddress: async () => '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab',
    };
    return new EVMPaymentChannelProvider(sdk as any, chainId, TOKEN, logger as any);
  }

  it('returns an empty map when settlement is not bootstrapped (no chain registry)', async () => {
    const node = makeNode({ keyId: HEX_KEY });
    await expect((node as any)._resolveAnnounceTokenNetworks()).resolves.toEqual({});
  });

  it('maps each EVM provider chainId to its on-chain TokenNetwork address', async () => {
    const node = makeNode({ keyId: HEX_KEY });
    (node as any)._chainRegistry = {
      getAllProviders: () => [realEvmProvider('evm:31337', TOKEN_NETWORK)],
    };
    await expect((node as any)._resolveAnnounceTokenNetworks()).resolves.toEqual({
      'evm:31337': TOKEN_NETWORK,
    });
  });

  it('skips non-EVM providers (Solana/Mina announce params are config-derived)', async () => {
    const node = makeNode({ keyId: HEX_KEY });
    (node as any)._chainRegistry = {
      getAllProviders: () => [
        { chainType: 'solana', chainId: 'solana:devnet' },
        realEvmProvider('evm:31337', TOKEN_NETWORK),
      ],
    };
    await expect((node as any)._resolveAnnounceTokenNetworks()).resolves.toEqual({
      'evm:31337': TOKEN_NETWORK,
    });
  });

  it('omits a provider whose lookup fails without dropping the others', async () => {
    const node = makeNode({ keyId: HEX_KEY });
    const failing = realEvmProvider('evm:84532', TOKEN_NETWORK);
    failing.getSigningContext = async () => {
      throw new Error('registry RPC down');
    };
    (node as any)._chainRegistry = {
      getAllProviders: () => [failing, realEvmProvider('evm:31337', TOKEN_NETWORK)],
    };
    await expect((node as any)._resolveAnnounceTokenNetworks()).resolves.toEqual({
      'evm:31337': TOKEN_NETWORK,
    });
  });

  it('omits an empty tokenNetworkAddress (never announces empty strings)', async () => {
    const node = makeNode({ keyId: HEX_KEY });
    (node as any)._chainRegistry = {
      getAllProviders: () => [realEvmProvider('evm:31337', '')],
    };
    await expect((node as any)._resolveAnnounceTokenNetworks()).resolves.toEqual({});
  });
});

describe('ConnectorNode._publishAnnouncement', () => {
  function fulfillStub(): jest.Mock {
    return jest.fn().mockResolvedValue({ type: PacketType.FULFILL } as ILPFulfillPacket);
  }

  it('LOCAL: a terminated announceTo publishes free (amount 0, mode local-free)', async () => {
    const node = makeNode({
      keyId: HEX_KEY,
      topology: 'apex', // terminates g.proxy.relay
      selfAnnounce: { enabled: true, announceTo: 'g.proxy.relay' },
    });
    const sendPacket = fulfillStub();
    (node as any).sendPacket = sendPacket;

    const outcome = await (node as any)._publishAnnouncement(SIGNED_EVENT);
    expect(outcome).toEqual({ mode: 'local-free', ok: true });
    expect(sendPacket).toHaveBeenCalledTimes(1);
    expect(sendPacket.mock.calls[0][0].destination).toBe('g.proxy.relay');
    expect(sendPacket.mock.calls[0][0].amount).toBe(0n); // free → no claim
  });

  it('REMOTE: a non-terminated announceTo pays (amount = announcePrice, mode remote-paid)', async () => {
    const node = makeNode({
      keyId: HEX_KEY,
      topology: 'store', // terminates g.proxy.store, so g.proxy.relay is REMOTE
      selfAnnounce: { enabled: true, announceTo: 'g.proxy.relay', announcePrice: '2500' },
    });
    const sendPacket = fulfillStub();
    (node as any).sendPacket = sendPacket;

    const outcome = await (node as any)._publishAnnouncement(SIGNED_EVENT);
    expect(outcome).toEqual({ mode: 'remote-paid', ok: true });
    expect(sendPacket.mock.calls[0][0].amount).toBe(2500n); // paid from own channel
  });

  it('REMOTE defaults the price when announcePrice is omitted', async () => {
    const node = makeNode({
      keyId: HEX_KEY,
      topology: 'store',
      selfAnnounce: { enabled: true, announceTo: 'g.proxy.relay' },
    });
    const sendPacket = fulfillStub();
    (node as any).sendPacket = sendPacket;

    await (node as any)._publishAnnouncement(SIGNED_EVENT);
    expect(sendPacket.mock.calls[0][0].amount).toBe(1000n); // DEFAULT_ANNOUNCE_PRICE
  });

  it('surfaces a REJECT as ok:false with the reject code in detail', async () => {
    const node = makeNode({
      keyId: HEX_KEY,
      topology: 'apex',
      selfAnnounce: { enabled: true, announceTo: 'g.proxy.relay' },
    });
    (node as any).sendPacket = jest.fn().mockResolvedValue({
      type: PacketType.REJECT,
      code: 'F02',
      message: 'No upstream route for destination',
    } as ILPRejectPacket);

    const outcome = await (node as any)._publishAnnouncement(SIGNED_EVENT);
    expect(outcome.ok).toBe(false);
    expect(outcome.mode).toBe('local-free');
    expect(outcome.detail).toContain('F02');
  });

  it('handles a REJECT with no message (detail is just the code)', async () => {
    const node = makeNode({
      keyId: HEX_KEY,
      topology: 'apex',
      selfAnnounce: { enabled: true, announceTo: 'g.proxy.relay' },
    });
    // REJECT without a `message` → exercises the `?? ''` fallback in the detail.
    (node as any).sendPacket = jest
      .fn()
      .mockResolvedValue({ type: PacketType.REJECT, code: 'T00' } as ILPRejectPacket);

    const outcome = await (node as any)._publishAnnouncement(SIGNED_EVENT);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toBe('T00:');
  });
});
