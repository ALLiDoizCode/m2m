/**
 * Tests for the SelfAnnounceService (relay#37 / store#22).
 *
 * Covers:
 * - refresh/expiration timing: TTL = 2× refresh; default cadence.
 * - build: a signed, verifiable kind:10032 carrying the route hints.
 * - the injected publish path: the boot publish + interval republish call the
 *   PublishFn; stop() clears the timer; disabled / missing-announceTo guards.
 * - resilience: a rejected outcome or a throwing PublishFn never throws.
 *
 * Per the repo's mock-free policy, the publish target is a real hand-written
 * `PublishFn` recorder (not a network/library mock) and events are built +
 * signed with the real `nostr-tools` primitives.
 *
 * @module discovery/self-announce-service.test
 */

import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { createLogger } from '../utils/logger';
import type { ConnectorConfig, SelfAnnounceConfig } from '../config/types';
import {
  SelfAnnounceService,
  DEFAULT_REFRESH_INTERVAL_SECS,
  type PublishFn,
  type PublishOutcome,
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
  announceTo: 'g.proxy.relay',
  refreshIntervalSecs: 300,
  btpEndpoint: 'wss://proxy.devnet.toonprotocol.dev:443',
};

/** A real PublishFn recorder: captures each published event, returns a fixed outcome. */
function recorder(outcome: PublishOutcome = { mode: 'local-free', ok: true }): {
  events: { id: string; kind: number }[];
  publish: PublishFn;
} {
  const events: { id: string; kind: number }[] = [];
  const publish: PublishFn = async (event) => {
    events.push({ id: event.id, kind: event.kind });
    return outcome;
  };
  return { events, publish };
}

function makeService(
  overrides: Partial<SelfAnnounceConfig> = {},
  publish?: PublishFn
): { service: SelfAnnounceService; events: ReturnType<typeof recorder>['events'] } {
  const rec = recorder();
  const service = new SelfAnnounceService({
    config: config(),
    selfAnnounce: { ...selfAnnounce, ...overrides },
    secretKey: sk,
    publish: publish ?? rec.publish,
    logger,
  });
  return { service, events: rec.events };
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
  it('passes the signed event to the injected PublishFn', async () => {
    const { service, events } = makeService();
    await service.publish();
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe(10032);
  });

  it('does not throw when the publish outcome is a rejection', async () => {
    const rec = recorder({ mode: 'remote-paid', ok: false, detail: 'F99: Insufficient Payment' });
    const service = new SelfAnnounceService({
      config: config(),
      selfAnnounce,
      secretKey: sk,
      publish: rec.publish,
      logger,
    });
    await expect(service.publish()).resolves.toBeUndefined();
    expect(rec.events).toHaveLength(1);
  });

  it('does not throw when the PublishFn itself rejects', async () => {
    const throwingPublish: PublishFn = async () => {
      throw new Error('no payment channel available for peer');
    };
    const { service } = makeService({}, throwingPublish);
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
    const { service, events } = makeService({ refreshIntervalSecs: 300 });
    service.start();
    expect(service.running).toBe(true);
    // Boot publish is fire-and-forget; flush microtasks.
    await Promise.resolve();
    expect(events).toHaveLength(1);

    // Advance one full interval → one more publish.
    jest.advanceTimersByTime(300_000);
    await Promise.resolve();
    expect(events).toHaveLength(2);

    jest.advanceTimersByTime(300_000);
    await Promise.resolve();
    expect(events).toHaveLength(3);

    service.stop();
  });

  it('stop() clears the timer so no further publishes occur', async () => {
    const { service, events } = makeService({ refreshIntervalSecs: 300 });
    service.start();
    await Promise.resolve();
    expect(events).toHaveLength(1);

    service.stop();
    expect(service.running).toBe(false);

    jest.advanceTimersByTime(900_000);
    await Promise.resolve();
    expect(events).toHaveLength(1); // unchanged after stop
  });

  it('does not publish when disabled', async () => {
    const { service, events } = makeService({ enabled: false });
    service.start();
    await Promise.resolve();
    expect(service.running).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('does not publish when announceTo is missing', async () => {
    const { service, events } = makeService({ announceTo: '' });
    service.start();
    await Promise.resolve();
    expect(service.running).toBe(false);
    expect(events).toHaveLength(0);
  });
});
