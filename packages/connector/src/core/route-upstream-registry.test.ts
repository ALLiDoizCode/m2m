/**
 * Tests for issue #218 — RouteTerminationRegistry (the seam #216's
 * HttpProxyHandler consumes via `resolveUpstream`).
 *
 * Real implementation, no mocks: exercises lookup, longest-prefix match, the
 * bound `resolveUpstream` upstreamResolver, and mutation.
 *
 * @module core/route-upstream-registry.test
 */

import { RouteTerminationRegistry } from './route-upstream-registry';
import type { RouteTermination } from '../config/types';
import type { LocalDeliveryRequest } from '../config/types';

const term = (upstream: string, ilpAddress: string): RouteTermination => ({
  upstream,
  price: '1000',
  chains: ['evm', 'solana', 'mina'],
  ilpAddress,
  settlementAddresses: { evm: '0xabc' },
});

const req = (destination: string): LocalDeliveryRequest => ({
  destination,
  amount: '1000',
  expiresAt: new Date(Date.now() + 30_000).toISOString(),
  data: '',
  sourcePeer: 'payer',
});

describe('RouteTerminationRegistry', () => {
  it('constructs from entries, ignoring non-terminated routes', () => {
    const reg = new RouteTerminationRegistry([
      { prefix: 'g.greet', termination: term('http://a:1', 'g.greet') },
      { prefix: 'g.plain' }, // no termination → ignored
    ]);
    expect(reg.size).toBe(1);
    expect(reg.prefixes()).toEqual(['g.greet']);
    expect(reg.lookup('g.greet')?.upstream).toBe('http://a:1');
    expect(reg.lookup('g.plain')).toBeUndefined();
  });

  it('longest-prefix match resolves the most specific terminated route', () => {
    const reg = new RouteTerminationRegistry([
      { prefix: 'g.connector', termination: term('http://broad:1', 'g.connector') },
      { prefix: 'g.connector.greet', termination: term('http://narrow:2', 'g.connector.greet') },
    ]);
    expect(reg.match('g.connector.greet.v1')?.upstream).toBe('http://narrow:2');
    expect(reg.match('g.connector.other')?.upstream).toBe('http://broad:1');
    expect(reg.match('g.elsewhere')).toBeUndefined();
  });

  it('match requires a full-label boundary (no partial-segment match)', () => {
    const reg = new RouteTerminationRegistry([
      { prefix: 'g.greet', termination: term('http://a:1', 'g.greet') },
    ]);
    expect(reg.match('g.greeting')).toBeUndefined(); // not g.greet or g.greet.*
    expect(reg.match('g.greet')).toBeDefined();
    expect(reg.match('g.greet.sub')).toBeDefined();
  });

  it('resolveUpstream is the #216 upstreamResolver seam', () => {
    const reg = new RouteTerminationRegistry([
      { prefix: 'g.greet', termination: term('http://upstream:8080', 'g.greet') },
    ]);
    // Bound arrow property — can be passed by reference without losing `this`.
    const resolver = reg.resolveUpstream;
    expect(resolver(req('g.greet.v1'))).toBe('http://upstream:8080');
    expect(resolver(req('g.unrouted'))).toBeUndefined();
  });

  it('supports set / delete / clear mutation', () => {
    const reg = new RouteTerminationRegistry();
    expect(reg.size).toBe(0);
    reg.set('g.a', term('http://a:1', 'g.a'));
    reg.set('g.b', term('http://b:1', 'g.b'));
    expect(reg.size).toBe(2);
    expect(reg.delete('g.a')).toBe(true);
    expect(reg.delete('g.a')).toBe(false); // idempotent
    expect(reg.lookup('g.a')).toBeUndefined();
    reg.clear();
    expect(reg.size).toBe(0);
  });
});
