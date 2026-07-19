/**
 * Unit tests for computeRoutes (toon-meta#153).
 *
 * Covers multi-hop Dijkstra over the adjacency union, per-prefix cost, the
 * deterministic tie-breaks (first-hop peer id, then announcer pubkey),
 * unreachable announcers, self-exclusion, and best-route-per-prefix
 * selection. Pure data — no network, no mocks.
 *
 * @module routing/path-computation.test
 */

import { computeRoutes, type DirectNeighbor } from './path-computation';
import type { LinkStateEntry } from './link-state-db';

const PK_SELF = '0'.repeat(64);
const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const PK_C = 'c'.repeat(64);
const PK_D = 'd'.repeat(64);

function entry(
  pubkey: string,
  prefixes: Array<{ prefix: string; cost?: number }>,
  adjacency: string[]
): LinkStateEntry {
  return {
    pubkey,
    routing: { prefixes, adjacency },
    info: { ilpAddress: 'g.x', btpEndpoint: '', assetCode: 'USDC', assetScale: 6 },
    createdAt: 1_700_000_000,
    expiresAt: null,
  };
}

describe('computeRoutes', () => {
  it('routes to a direct neighbor prefix at cost 1', () => {
    const entries = [entry(PK_A, [{ prefix: 'g.a', cost: 0 }], [])];
    const neighbors: DirectNeighbor[] = [{ pubkey: PK_A, peerId: 'peer-a' }];

    const routes = computeRoutes(entries, neighbors);
    expect(routes).toEqual([{ prefix: 'g.a', nextHop: 'peer-a', cost: 1, sourcePubkey: PK_A }]);
  });

  it('computes multi-hop routes through the adjacency graph', () => {
    // self — A — B — C, only A is directly connected.
    const entries = [
      entry(PK_A, [{ prefix: 'g.a' }], [PK_B]),
      entry(PK_B, [{ prefix: 'g.b' }], [PK_A, PK_C]),
      entry(PK_C, [{ prefix: 'g.c' }], [PK_B]),
    ];
    const neighbors: DirectNeighbor[] = [{ pubkey: PK_A, peerId: 'peer-a' }];

    const routes = computeRoutes(entries, neighbors);
    expect(routes).toEqual([
      { prefix: 'g.a', nextHop: 'peer-a', cost: 1, sourcePubkey: PK_A },
      { prefix: 'g.b', nextHop: 'peer-a', cost: 2, sourcePubkey: PK_B },
      { prefix: 'g.c', nextHop: 'peer-a', cost: 3, sourcePubkey: PK_C },
    ]);
  });

  it('uses the adjacency UNION: a single side declaring the edge connects it', () => {
    // B declares A as a neighbor; A declares nothing. Edge still exists.
    const entries = [entry(PK_A, [], []), entry(PK_B, [{ prefix: 'g.b' }], [PK_A])];
    const neighbors: DirectNeighbor[] = [{ pubkey: PK_A, peerId: 'peer-a' }];

    const routes = computeRoutes(entries, neighbors);
    expect(routes).toEqual([{ prefix: 'g.b', nextHop: 'peer-a', cost: 2, sourcePubkey: PK_B }]);
  });

  it('returns no route for unreachable announcers', () => {
    // D announces a prefix but no edge connects it to any direct neighbor.
    const entries = [entry(PK_A, [{ prefix: 'g.a' }], []), entry(PK_D, [{ prefix: 'g.d' }], [])];
    const neighbors: DirectNeighbor[] = [{ pubkey: PK_A, peerId: 'peer-a' }];

    const routes = computeRoutes(entries, neighbors);
    expect(routes.map((r) => r.prefix)).toEqual(['g.a']);
  });

  it('returns nothing when there are no direct neighbors', () => {
    const entries = [entry(PK_A, [{ prefix: 'g.a' }], [])];
    expect(computeRoutes(entries, [])).toEqual([]);
  });

  it('prefers the lower-cost path', () => {
    // C reachable via A (self→A→D→C, cost 3) or via B (self→B→C, cost 2).
    const entries = [
      entry(PK_A, [], [PK_D]),
      entry(PK_D, [], [PK_C]),
      entry(PK_B, [], [PK_C]),
      entry(PK_C, [{ prefix: 'g.c' }], []),
    ];
    const neighbors: DirectNeighbor[] = [
      { pubkey: PK_A, peerId: 'peer-a' },
      { pubkey: PK_B, peerId: 'peer-b' },
    ];

    const routes = computeRoutes(entries, neighbors);
    expect(routes).toEqual([{ prefix: 'g.c', nextHop: 'peer-b', cost: 2, sourcePubkey: PK_C }]);
  });

  it('adds the announced per-prefix cost to the path cost', () => {
    // Same announcer distance, but the prefix carries cost 5 from A and 0 from B.
    const entries = [
      entry(PK_A, [{ prefix: 'g.x', cost: 5 }], []),
      entry(PK_B, [{ prefix: 'g.x', cost: 0 }], []),
    ];
    const neighbors: DirectNeighbor[] = [
      { pubkey: PK_A, peerId: 'peer-a' },
      { pubkey: PK_B, peerId: 'peer-b' },
    ];

    const routes = computeRoutes(entries, neighbors);
    expect(routes).toEqual([{ prefix: 'g.x', nextHop: 'peer-b', cost: 1, sourcePubkey: PK_B }]);
  });

  it('breaks equal-cost ties deterministically on the smaller first-hop peer id', () => {
    // C is 2 hops away via both A and B.
    const entries = [
      entry(PK_A, [], [PK_C]),
      entry(PK_B, [], [PK_C]),
      entry(PK_C, [{ prefix: 'g.c' }], []),
    ];
    const neighbors: DirectNeighbor[] = [
      { pubkey: PK_B, peerId: 'peer-b' },
      { pubkey: PK_A, peerId: 'peer-a' },
    ];

    const routes = computeRoutes(entries, neighbors);
    expect(routes).toEqual([{ prefix: 'g.c', nextHop: 'peer-a', cost: 2, sourcePubkey: PK_C }]);
    // Stable across neighbor input order.
    expect(computeRoutes(entries, [...neighbors].reverse())).toEqual(routes);
  });

  it('breaks remaining ties on the smaller announcer pubkey', () => {
    // Two announcers advertise the same prefix at the same cost via one peer.
    const entries = [entry(PK_B, [{ prefix: 'g.x' }], []), entry(PK_A, [{ prefix: 'g.x' }], [])];
    const neighbors: DirectNeighbor[] = [
      { pubkey: PK_A, peerId: 'peer-z' },
      { pubkey: PK_B, peerId: 'peer-z' },
    ];

    const routes = computeRoutes(entries, neighbors);
    expect(routes).toEqual([{ prefix: 'g.x', nextHop: 'peer-z', cost: 1, sourcePubkey: PK_A }]);
  });

  it("excludes this node's own announcement and its edges", () => {
    const entries = [
      entry(PK_SELF, [{ prefix: 'g.self' }], [PK_A]),
      entry(PK_A, [{ prefix: 'g.a' }], [PK_SELF]),
    ];
    const neighbors: DirectNeighbor[] = [{ pubkey: PK_A, peerId: 'peer-a' }];

    const routes = computeRoutes(entries, neighbors, PK_SELF);
    expect(routes).toEqual([{ prefix: 'g.a', nextHop: 'peer-a', cost: 1, sourcePubkey: PK_A }]);
  });

  it('returns routes sorted by prefix for deterministic install order', () => {
    const entries = [entry(PK_A, [{ prefix: 'g.z' }, { prefix: 'g.b' }, { prefix: 'g.m' }], [])];
    const neighbors: DirectNeighbor[] = [{ pubkey: PK_A, peerId: 'peer-a' }];

    const routes = computeRoutes(entries, neighbors);
    expect(routes.map((r) => r.prefix)).toEqual(['g.b', 'g.m', 'g.z']);
  });
});
