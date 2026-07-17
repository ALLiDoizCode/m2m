/**
 * Tests for toon-meta#153 — general child-prefix registration.
 *
 * Covers:
 * - `expandChildren`: internal (`upstream`) and external (`peerId`) children,
 *   exactly-one-of enforcement, duplicate names, bad labels, missing/mis-related
 *   peers, price validation, termination-metadata inheritance, idempotency,
 *   and prefix conflicts.
 * - `deriveApex`: explicit apex precedence and derivation from self routes.
 * - `ConfigLoader.validateConfig` integration: children expand into routes
 *   before the routing table is built, and relation ↔ route consistency is
 *   enforced at config load (child ⇒ under self subtree; parent ⇒ not under).
 *
 * @module config/child-expander.test
 */

import { ChildConfigError, deriveApex, expandChildren } from './child-expander';
import { ConfigLoader, ConfigurationError } from './config-loader';
import type { ChildConfig, PeerConfig, RouteConfig } from './types';

const NODE_ID = 'apex-node';
const APEX = 'g.proxy';

/** A terminated apex route the upstream children inherit metadata from. */
const apexRoute = (): RouteConfig => ({
  prefix: APEX,
  nextHop: NODE_ID,
  upstream: 'http://apex-app:8080',
  price: '500',
  chains: ['evm', 'solana'],
  ilpAddress: APEX,
  settlementAddresses: { evm: '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab' },
});

const childPeer = (id: string, relation?: PeerConfig['relation']): PeerConfig => ({
  id,
  url: `ws://${id}:3000`,
  authToken: 'secret',
  ...(relation !== undefined ? { relation } : {}),
});

describe('deriveApex (toon-meta#153)', () => {
  it('prefers the explicit apex field over derivation', () => {
    expect(deriveApex({ apex: 'g.explicit', routes: [apexRoute()], nodeId: NODE_ID })).toBe(
      'g.explicit'
    );
  });

  it('derives the apex from the first self route (nextHop === nodeId)', () => {
    expect(deriveApex({ routes: [apexRoute()], nodeId: NODE_ID })).toBe(APEX);
  });

  it("derives the apex from a route with nextHop 'local', preferring ilpAddress over prefix", () => {
    const routes: RouteConfig[] = [
      { prefix: 'g.remote', nextHop: 'other-peer' },
      { prefix: 'g.self.prefix', nextHop: 'local', ilpAddress: 'g.self.address' },
    ];
    expect(deriveApex({ routes, nodeId: NODE_ID })).toBe('g.self.address');
  });

  it('returns undefined when no apex is derivable (pure relay node)', () => {
    const routes: RouteConfig[] = [{ prefix: 'g.remote', nextHop: 'other-peer' }];
    expect(deriveApex({ routes, nodeId: NODE_ID })).toBeUndefined();
  });
});

describe('expandChildren (toon-meta#153)', () => {
  it('expands an upstream child into a locally-terminated route under the apex', () => {
    const children: ChildConfig[] = [{ name: 'relay', upstream: 'http://relay:3100' }];
    const routes = expandChildren(children, undefined, [apexRoute()], [], NODE_ID);

    expect(routes).toEqual([
      {
        prefix: 'g.proxy.relay',
        nextHop: NODE_ID,
        upstream: 'http://relay:3100',
        price: '0',
        chains: ['evm', 'solana'],
        ilpAddress: 'g.proxy.relay',
        settlementAddresses: { evm: '0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab' },
      },
    ]);
  });

  it('honors an explicit child price', () => {
    const children: ChildConfig[] = [
      { name: 'relay', upstream: 'http://relay:3100', price: '1000' },
    ];
    const routes = expandChildren(children, undefined, [apexRoute()], [], NODE_ID);
    expect(routes[0]?.price).toBe('1000');
  });

  it('defaults chains/settlementAddresses when no terminated route exists to inherit from', () => {
    const children: ChildConfig[] = [{ name: 'relay', upstream: 'http://relay:3100' }];
    const routes = expandChildren(children, APEX, [], [], NODE_ID);
    expect(routes[0]?.chains).toEqual(['evm']);
    expect(routes[0]?.settlementAddresses).toEqual({});
  });

  it('expands a peerId child into a forwarding route to the child peer', () => {
    const children: ChildConfig[] = [{ name: 'store', peerId: 'store-box' }];
    const routes = expandChildren(children, APEX, [], [childPeer('store-box', 'child')], NODE_ID);
    expect(routes).toEqual([{ prefix: 'g.proxy.store', nextHop: 'store-box' }]);
  });

  it('uses the explicit apex over the derived one', () => {
    const children: ChildConfig[] = [{ name: 'relay', upstream: 'http://relay:3100' }];
    const routes = expandChildren(children, 'g.other', [apexRoute()], [], NODE_ID);
    expect(routes[0]?.prefix).toBe('g.other.relay');
  });

  it('throws when neither upstream nor peerId is set', () => {
    expect(() => expandChildren([{ name: 'x' }], APEX, [], [], NODE_ID)).toThrow(
      /exactly one of 'upstream' or 'peerId'/
    );
  });

  it('throws when both upstream and peerId are set', () => {
    const children: ChildConfig[] = [{ name: 'x', upstream: 'http://x:1', peerId: 'p' }];
    expect(() => expandChildren(children, APEX, [], [childPeer('p', 'child')], NODE_ID)).toThrow(
      /exactly one of 'upstream' or 'peerId'.*both/
    );
  });

  it('throws on duplicate child names', () => {
    const children: ChildConfig[] = [
      { name: 'relay', upstream: 'http://a:1' },
      { name: 'relay', upstream: 'http://b:2' },
    ];
    expect(() => expandChildren(children, APEX, [], [], NODE_ID)).toThrow(
      /Duplicate child name: 'relay'/
    );
  });

  it.each(['Relay', 'has.dot', '-leading', 'spa ce', ''])(
    "throws on an invalid child label ('%s')",
    (name) => {
      const children: ChildConfig[] = [{ name, upstream: 'http://a:1' }];
      expect(() => expandChildren(children, APEX, [], [], NODE_ID)).toThrow(ChildConfigError);
    }
  );

  it('throws when a peerId child references a missing peer', () => {
    const children: ChildConfig[] = [{ name: 'store', peerId: 'ghost' }];
    expect(() => expandChildren(children, APEX, [], [], NODE_ID)).toThrow(
      /peerId 'ghost' does not reference a configured peer/
    );
  });

  it("throws when a peerId child's peer is not relation 'child'", () => {
    const children: ChildConfig[] = [{ name: 'store', peerId: 'store-box' }];
    expect(() =>
      expandChildren(children, APEX, [], [childPeer('store-box', 'peer')], NODE_ID)
    ).toThrow(/must have relation 'child'/);
    expect(() => expandChildren(children, APEX, [], [childPeer('store-box')], NODE_ID)).toThrow(
      /must have relation 'child'/
    );
  });

  it('throws on an invalid price', () => {
    const children: ChildConfig[] = [{ name: 'relay', upstream: 'http://a:1', price: '-5' }];
    expect(() => expandChildren(children, APEX, [], [], NODE_ID)).toThrow(
      /price must be a non-negative integer string/
    );
  });

  it('throws when children are configured but no apex is derivable', () => {
    const children: ChildConfig[] = [{ name: 'relay', upstream: 'http://a:1' }];
    expect(() => expandChildren(children, undefined, [], [], NODE_ID)).toThrow(
      /children require an apex/
    );
  });

  it('is idempotent: skips a child whose expanded route is already present with the same binding', () => {
    const children: ChildConfig[] = [{ name: 'relay', upstream: 'http://relay:3100' }];
    const alreadyExpanded = expandChildren(children, APEX, [apexRoute()], [], NODE_ID);
    const routes = [apexRoute(), ...alreadyExpanded];
    expect(expandChildren(children, APEX, routes, [], NODE_ID)).toEqual([]);
  });

  it('throws when the expanded prefix conflicts with an existing route bound elsewhere', () => {
    const children: ChildConfig[] = [{ name: 'relay', upstream: 'http://relay:3100' }];
    const conflicting: RouteConfig = { prefix: 'g.proxy.relay', nextHop: 'someone-else' };
    expect(() => expandChildren(children, APEX, [conflicting], [], NODE_ID)).toThrow(
      /conflicts with an existing route/
    );
  });
});

describe('ConfigLoader.validateConfig — children expansion + relation enforcement (toon-meta#153)', () => {
  const baseRawConfig = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    nodeId: NODE_ID,
    btpServerPort: 3000,
    healthCheckPort: 8080,
    peers: [],
    routes: [apexRoute()],
    ...overrides,
  });

  it('expands children into routes before the config is returned', () => {
    const config = ConfigLoader.validateConfig(
      baseRawConfig({
        apex: APEX,
        peers: [childPeer('store-box', 'child')],
        children: [
          { name: 'relay', upstream: 'http://relay:3100', price: '1000' },
          { name: 'store', peerId: 'store-box' },
        ],
      })
    );

    const relayRoute = config.routes.find((r) => r.prefix === 'g.proxy.relay');
    const storeRoute = config.routes.find((r) => r.prefix === 'g.proxy.store');
    expect(relayRoute).toMatchObject({
      nextHop: NODE_ID,
      upstream: 'http://relay:3100',
      price: '1000',
      ilpAddress: 'g.proxy.relay',
    });
    expect(storeRoute).toEqual({ prefix: 'g.proxy.store', nextHop: 'store-box' });
    // The children/apex surface is preserved on the loaded config.
    expect(config.apex).toBe(APEX);
    expect(config.children).toHaveLength(2);
  });

  it('is idempotent: re-validating an already-validated config does not duplicate routes', () => {
    const raw = baseRawConfig({
      apex: APEX,
      children: [{ name: 'relay', upstream: 'http://relay:3100' }],
    });
    const once = ConfigLoader.validateConfig(raw);
    const twice = ConfigLoader.validateConfig(once as unknown as Record<string, unknown>);
    expect(twice.routes.filter((r) => r.prefix === 'g.proxy.relay')).toHaveLength(1);
  });

  it('wraps child expansion failures in ConfigurationError', () => {
    expect(() =>
      ConfigLoader.validateConfig(
        baseRawConfig({ apex: APEX, children: [{ name: 'BAD.NAME', upstream: 'http://a:1' }] })
      )
    ).toThrow(ConfigurationError);
    expect(() =>
      ConfigLoader.validateConfig(
        baseRawConfig({ apex: APEX, children: [{ name: 'ghosted', peerId: 'ghost' }] })
      )
    ).toThrow(/Invalid children config/);
  });

  it('rejects a non-array children field and a non-string apex', () => {
    expect(() => ConfigLoader.validateConfig(baseRawConfig({ children: 'nope' }))).toThrow(
      /Invalid type for children/
    );
    expect(() => ConfigLoader.validateConfig(baseRawConfig({ apex: 42 }))).toThrow(
      /Invalid type for apex/
    );
  });

  it("rejects a child-relation peer whose route is NOT under the node's self subtree", () => {
    expect(() =>
      ConfigLoader.validateConfig(
        baseRawConfig({
          peers: [childPeer('rogue', 'child')],
          routes: [apexRoute(), { prefix: 'g.elsewhere', nextHop: 'rogue' }],
        })
      )
    ).toThrow(/Relation\/route mismatch for peer 'rogue'.*g\.elsewhere/);
  });

  it("rejects a parent-relation peer whose route IS under the node's self subtree", () => {
    expect(() =>
      ConfigLoader.validateConfig(
        baseRawConfig({
          peers: [childPeer('upstream-isp', 'parent')],
          routes: [apexRoute(), { prefix: 'g.proxy.sub', nextHop: 'upstream-isp' }],
        })
      )
    ).toThrow(/Relation\/route mismatch for peer 'upstream-isp'/);
  });

  it('accepts consistent relations: child under apex, parent above it', () => {
    const config = ConfigLoader.validateConfig(
      baseRawConfig({
        peers: [childPeer('kid', 'child'), childPeer('upstream-isp', 'parent')],
        routes: [
          apexRoute(),
          { prefix: 'g.proxy.kid', nextHop: 'kid' },
          { prefix: 'g', nextHop: 'upstream-isp' },
        ],
      })
    );
    expect(config.routes).toHaveLength(3);
  });

  it('counts the explicit apex as a self-prefix even without a local route at it', () => {
    const config = ConfigLoader.validateConfig(
      baseRawConfig({
        apex: APEX,
        peers: [childPeer('kid', 'child')],
        routes: [{ prefix: 'g.proxy.kid', nextHop: 'kid' }],
      })
    );
    expect(config.routes).toHaveLength(1);
  });

  it('leaves legacy configs (no relations, no children) untouched', () => {
    const config = ConfigLoader.validateConfig(
      baseRawConfig({
        peers: [childPeer('neighbor')],
        routes: [apexRoute(), { prefix: 'g.elsewhere', nextHop: 'neighbor' }],
      })
    );
    expect(config.routes).toHaveLength(2);
    expect(config.apex).toBeUndefined();
    expect(config.children).toBeUndefined();
  });
});
