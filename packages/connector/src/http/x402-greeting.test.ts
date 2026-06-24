/**
 * Unit tests for the x402 v2 greeting builder (issue #217).
 *
 * Pins the v2 wire shape and the evm/solana → CAIP-2 mapping in isolation from
 * the HTTP adapter. Wire shape authority:
 *   https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
 */

import { buildX402Greeting, chainToCaip2 } from './x402-greeting';
import type { RouteTermination } from '../config/types';

const termination: RouteTermination = {
  upstream: 'http://127.0.0.1:8080',
  price: '1000',
  chains: ['evm', 'solana', 'mina'],
  ilpAddress: 'g.connector.greet',
  settlementAddresses: {
    evm: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28',
    solana: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2',
    mina: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyVAyZTtbTbCXP',
  },
};

describe('chainToCaip2', () => {
  it('maps evm:<id> → eip155:<id>', () => {
    expect(chainToCaip2('evm', { evm: 'evm:8453' })).toBe('eip155:8453');
    expect(chainToCaip2('evm', { evm: 'evm:1' })).toBe('eip155:1');
  });

  it('accepts a bare numeric evm chainId and prefixes eip155', () => {
    expect(chainToCaip2('evm', { evm: '42161' })).toBe('eip155:42161');
  });

  it('passes a solana:<reference> chainId through verbatim (already CAIP-2)', () => {
    expect(chainToCaip2('solana', { solana: 'solana:devnet' })).toBe('solana:devnet');
  });

  it('returns null for mina (x402 has no Mina network id)', () => {
    expect(chainToCaip2('mina', { evm: 'evm:8453' })).toBeNull();
  });

  it('returns null when no chainId is supplied for the chain', () => {
    expect(chainToCaip2('evm', {})).toBeNull();
    expect(chainToCaip2('solana', {})).toBeNull();
  });
});

describe('buildX402Greeting', () => {
  const ctx = { chainIds: { evm: 'evm:8453', solana: 'solana:devnet' }, resourceUrl: 'g.x' };

  it('emits x402Version 2 and a resource object', () => {
    const body = buildX402Greeting(termination, ctx);
    expect(body.x402Version).toBe(2);
    expect(body.resource).toEqual({ url: 'g.x' });
  });

  it('emits one vanilla exact entry per x402-nameable chain with a payTo, plus one toon-channel', () => {
    const body = buildX402Greeting(termination, ctx);
    const schemes = body.accepts.map((a) => a.scheme).sort();
    expect(schemes).toEqual(['exact', 'exact', 'toon-channel']);
    const networks = body.accepts
      .filter((a) => a.scheme === 'exact')
      .map((a) => a.network)
      .sort();
    expect(networks).toEqual(['eip155:8453', 'solana:devnet']); // no mina
  });

  it('advertises price verbatim as `amount` (byte-identical for #220 TOON-Price compare)', () => {
    const body = buildX402Greeting(termination, ctx);
    for (const entry of body.accepts) {
      expect(entry.amount).toBe('1000');
    }
  });

  it('toon-channel extra carries the full multi-chain payload incl. mina', () => {
    const body = buildX402Greeting(termination, ctx);
    const toon = body.accepts.find((a) => a.scheme === 'toon-channel');
    expect(toon?.extra).toEqual({
      ilpAddress: termination.ilpAddress,
      endpoint: '/ilp',
      price: '1000',
      chains: ['evm', 'solana', 'mina'],
      settlementAddresses: termination.settlementAddresses,
    });
  });

  it('hoists httpEndpoint to top-level toon-channel entry when provided in context', () => {
    const body = buildX402Greeting(termination, {
      ...ctx,
      httpEndpoint: 'https://proxy.example.com/ilp',
    });
    const toon = body.accepts.find((a) => a.scheme === 'toon-channel') as unknown as Record<
      string,
      unknown
    >;
    expect(toon?.['httpEndpoint']).toBe('https://proxy.example.com/ilp');
    // extra is unchanged — endpoint stays relative inside extra
    expect(toon?.['extra']).toMatchObject({ endpoint: '/ilp' });
  });

  it('omits httpEndpoint from toon-channel entry when not provided', () => {
    const body = buildX402Greeting(termination, ctx);
    const toon = body.accepts.find((a) => a.scheme === 'toon-channel') as unknown as Record<
      string,
      unknown
    >;
    expect(toon?.['httpEndpoint']).toBeUndefined();
  });

  it('attaches per-chain asset override when present', () => {
    const withAsset: RouteTermination = {
      ...termination,
      asset: { evm: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
    };
    const body = buildX402Greeting(withAsset, ctx);
    const evm = body.accepts.find((a) => a.network === 'eip155:8453');
    expect(evm?.asset).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  });
});
