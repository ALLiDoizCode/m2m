/**
 * Unit tests for relation ↔ route consistency validation.
 */

import {
  deriveLocalPrefixes,
  validateRelationRoute,
  deriveDefaultChildRoute,
} from './relation-route-validator';

describe('deriveLocalPrefixes', () => {
  it('returns prefixes whose nextHop is the nodeId or local', () => {
    const routes = [
      { prefix: 'g.connector', nextHop: 'g.connector' },
      { prefix: 'g.local', nextHop: 'local' },
      { prefix: 'g.connector.town', nextHop: 'town' },
    ];
    expect(deriveLocalPrefixes(routes, 'g.connector')).toEqual(['g.connector', 'g.local']);
  });

  it('returns empty when nothing terminates locally', () => {
    const routes = [{ prefix: 'g.connector.town', nextHop: 'town' }];
    expect(deriveLocalPrefixes(routes, 'g.connector')).toEqual([]);
  });
});

describe('validateRelationRoute', () => {
  const self = ['g.connector'];

  it('accepts a child route under the connector address', () => {
    expect(validateRelationRoute('child', self, ['g.connector.town'])).toEqual({ ok: true });
  });

  it('rejects a child route not under the connector address', () => {
    const result = validateRelationRoute('child', self, ['g.other.town']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(
        "prefix 'g.other.town' must be under the connector's own address"
      );
    }
  });

  it('rejects a child route equal to the connector address (not a strict descendant)', () => {
    expect(validateRelationRoute('child', self, ['g.connector']).ok).toBe(false);
  });

  it('rejects a parent route that sits under the connector subtree (child-shaped)', () => {
    const result = validateRelationRoute('parent', self, ['g.connector.upstream']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('must not be under the connector');
    }
  });

  it('accepts a parent route that is broader than the connector', () => {
    expect(validateRelationRoute('parent', self, ['g'])).toEqual({ ok: true });
  });

  it('accepts any peer (lateral) route without subtree constraint', () => {
    expect(validateRelationRoute('peer', self, ['g.someone.else'])).toEqual({ ok: true });
    expect(validateRelationRoute(undefined, self, ['g.connector.x'])).toEqual({ ok: true });
  });

  it('skips checks (ok) when no local self-prefix is known', () => {
    expect(validateRelationRoute('child', [], ['g.anything'])).toEqual({ ok: true });
  });

  it('validates every route prefix, not just the first', () => {
    const result = validateRelationRoute('child', self, ['g.connector.town', 'g.other.swap']);
    expect(result.ok).toBe(false);
  });
});

describe('deriveDefaultChildRoute', () => {
  it('derives <self>.<peerId> for a child with no explicit route', () => {
    expect(deriveDefaultChildRoute('child', ['g.connector'], 'town')).toEqual({
      prefix: 'g.connector.town',
      priority: 0,
    });
  });

  it('returns null for non-child relations', () => {
    expect(deriveDefaultChildRoute('peer', ['g.connector'], 'town')).toBeNull();
    expect(deriveDefaultChildRoute('parent', ['g.connector'], 'town')).toBeNull();
  });

  it('returns null when no self-prefix is known', () => {
    expect(deriveDefaultChildRoute('child', [], 'town')).toBeNull();
  });
});
