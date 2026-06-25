/**
 * Tests for the SelfAnnounceService (relay#37 / store#22).
 *
 * Covers:
 * - refresh/expiration timing: TTL = 2× refresh; default cadence.
 * - publish path: a boot publish POSTs `{ event }` to the configured writeUrl;
 *   the body is a signed, verifiable kind:10032 carrying the route hints.
 * - the refresh loop republishes on the interval and stop() clears the timer.
 * - opt-in/guards: disabled or missing writeUrl → no publish.
 * - resilience: a non-ok response or a fetch rejection never throws.
 *
 * Per the repo's mock-free policy, the relay write target is a real
 * hand-written `FetchLike` recorder (not a network/library mock) and the events
 * are built + signed with the real `nostr-tools` primitives.
 *
 * @module discovery/self-announce-service.test
 */

import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { createLogger } from '../utils/logger';
import type { ConnectorConfig, SelfAnnounceConfig } from '../config/types';
import {
  SelfAnnounceService,
  DEFAULT_REFRESH_INTERVAL_SECS,
  type FetchLike,
} from './self-announce-service';

const logger = createLogger('self-announce-test', 'silent');
const sk = generateSecretKey();

function config(): ConnectorConfig {
  return {
    nodeId: 'connector',
    btpServerPort: 3000,
    environment: 'development',
    peers: [],
    chainProviders: [
      {
        chainType: 'evm',
        chainId: 'evm:31337',
        rpcUrl: 'http://localhost:8545',
        registryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
        keyId: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      } as ConnectorConfig['chainProviders'] extends (infer T)[] ? T : never,
    ],
    routes: [
      {
        prefix: 'g.proxy.relay',
        nextHop: 'connector',
        upstream: 'http://relay:3100',
        price: '1000',
        chains: ['evm'],
        ilpAddress: 'g.proxy.relay',
        settlementAddresses: { evm: '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab' },
      },
      {
        prefix: 'g.proxy.store',
        nextHop: 'store-box',
        price: '1000',
        chains: ['evm'],
        ilpAddress: 'g.proxy.store',
        settlementAddresses: { evm: '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab' },
      },
    ],
  };
}

const selfAnnounce: SelfAnnounceConfig = {
  enabled: true,
  writeUrl: 'http://relay:3100/write',
  refreshIntervalSecs: 300,
  btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
};

/** A real FetchLike recorder: captures calls, returns a configurable result. */
function recorder(
  result: { ok: boolean; status: number; body?: string } = { ok: true, status: 200 }
): {
  calls: { url: string; body: string; headers: Record<string, string> }[];
  fetchImpl: FetchLike;
} {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    return {
      ok: result.ok,
      status: result.status,
      text: async () => result.body ?? '',
    };
  };
  return { calls, fetchImpl };
}

function makeService(
  overrides: Partial<SelfAnnounceConfig> = {},
  fetchImpl?: FetchLike
): { service: SelfAnnounceService; calls: ReturnType<typeof recorder>['calls'] } {
  const rec = recorder();
  const service = new SelfAnnounceService({
    config: config(),
    selfAnnounce: { ...selfAnnounce, ...overrides },
    secretKey: sk,
    logger,
    fetchImpl: fetchImpl ?? rec.fetchImpl,
  });
  return { service, calls: rec.calls };
}

describe('SelfAnnounceService — timing', () => {
  it('sets TTL to 2× the refresh interval', () => {
    const { service } = makeService({ refreshIntervalSecs: 120 });
    expect(service.ttlSeconds).toBe(240);
  });

  it('defaults the refresh interval (and thus TTL) when unset or non-positive', () => {
    expect(makeService({ refreshIntervalSecs: undefined }).service.ttlSeconds).toBe(
      DEFAULT_REFRESH_INTERVAL_SECS * 2
    );
    expect(makeService({ refreshIntervalSecs: 0 }).service.ttlSeconds).toBe(
      DEFAULT_REFRESH_INTERVAL_SECS * 2
    );
  });

  it('stamps the built event with the NIP-40 expiration = created_at + ttl', () => {
    const { service } = makeService({ refreshIntervalSecs: 300 });
    const event = service.buildEvent();
    const exp = event.tags.find((t) => t[0] === 'expiration');
    expect(exp).toBeDefined();
    expect(Number(exp![1])).toBe(event.created_at + 600);
  });
});

describe('SelfAnnounceService — build', () => {
  it('builds a signed kind:10032 with route hints in content', () => {
    const { service } = makeService();
    const event = service.buildEvent();
    expect(event.kind).toBe(10032);
    expect(event.pubkey).toBe(getPublicKey(sk));
    expect(verifyEvent(event)).toBe(true);
    const content = JSON.parse(event.content);
    expect(content.ilpAddress).toBe('g.proxy.relay');
    expect(content.routes).toEqual({ publish: 'g.proxy.relay', store: 'g.proxy.store' });
    expect(content.settlementAddresses).toEqual({
      evm: '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab',
    });
  });
});

describe('SelfAnnounceService — publish path', () => {
  it('POSTs { event } to the configured writeUrl', async () => {
    const { service, calls } = makeService();
    await service.publish();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://relay:3100/write');
    const parsed = JSON.parse(calls[0]!.body) as { event: { kind: number; sig: string } };
    expect(parsed.event.kind).toBe(10032);
    expect(parsed.event.sig).toBeDefined();
    // Self-write carries the connector's own pubkey as payer, amount 0.
    expect(calls[0]!.headers['X-TOON-Payer']).toBe(getPublicKey(sk));
    expect(calls[0]!.headers['X-TOON-Amount']).toBe('0');
  });

  it('does not throw when the relay rejects the write (non-ok)', async () => {
    const rec = recorder({ ok: false, status: 402, body: 'payment required' });
    const service = new SelfAnnounceService({
      config: config(),
      selfAnnounce,
      secretKey: sk,
      logger,
      fetchImpl: rec.fetchImpl,
    });
    await expect(service.publish()).resolves.toBeUndefined();
    expect(rec.calls).toHaveLength(1);
  });

  it('does not throw when the fetch itself rejects', async () => {
    const throwingFetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const { service } = makeService({}, throwingFetch);
    await expect(service.publish()).resolves.toBeUndefined();
  });
});

describe('SelfAnnounceService — lifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('publishes immediately on start and republishes on the interval', async () => {
    const { service, calls } = makeService({ refreshIntervalSecs: 300 });
    service.start();
    expect(service.running).toBe(true);
    // Boot publish is fire-and-forget; flush microtasks.
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    // Advance one full interval → one more publish.
    jest.advanceTimersByTime(300_000);
    await Promise.resolve();
    expect(calls).toHaveLength(2);

    jest.advanceTimersByTime(300_000);
    await Promise.resolve();
    expect(calls).toHaveLength(3);

    service.stop();
  });

  it('stop() clears the timer so no further publishes occur', async () => {
    const { service, calls } = makeService({ refreshIntervalSecs: 300 });
    service.start();
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    service.stop();
    expect(service.running).toBe(false);

    jest.advanceTimersByTime(900_000);
    await Promise.resolve();
    expect(calls).toHaveLength(1); // unchanged after stop
  });

  it('does not publish when disabled', async () => {
    const { service, calls } = makeService({ enabled: false });
    service.start();
    await Promise.resolve();
    expect(service.running).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('does not publish when writeUrl is missing', async () => {
    const { service, calls } = makeService({ writeUrl: '' });
    service.start();
    await Promise.resolve();
    expect(service.running).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
