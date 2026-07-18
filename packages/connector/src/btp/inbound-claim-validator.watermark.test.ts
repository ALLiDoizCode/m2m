/**
 * Inbound Claim Validator — received-claim watermark freshness gate (Issue #353)
 *
 * The bug: the per-packet gate checked claim presence/structure/crypto only,
 * while the nonce-monotonicity (replay) verdict lived in ClaimReceiver, whose
 * result was recorded fire-and-forget and never fed the packet decision. A
 * replayed stale-nonce claim — validly signed, so it passed the crypto gate —
 * got every job executed and FULFILLed for free, forever.
 *
 * The fix under test: `InboundClaimValidator` consults the same received-claim
 * watermark ClaimReceiver maintains (a LOCAL DB read — no chain RPC) and
 * F06-rejects any claim whose nonce does not STRICTLY advance it, BEFORE any
 * cryptographic verification and before the packet can reach the local
 * delivery handler / backend. Covered uniformly for all three chain claim
 * types (EVM / Solana / Mina) — the watermark store is chain-agnostic.
 *
 * Crypto is mocked to always-verify here, isolating the freshness decision:
 * every claim below would pass the pre-#353 gate, so any REJECT observed is
 * attributable to the watermark check alone. Real-crypto gate coverage lives
 * in inbound-claim-validator.nonevm.test.ts and the coverage suites.
 */

import { InboundClaimValidator } from './inbound-claim-validator';
import type { ReceivedClaimWatermarkLookup, RoutePriceResolver } from './inbound-claim-validator';
import type {
  BTPClaimMessage,
  EVMClaimMessage,
  SolanaClaimMessage,
  MinaClaimMessage,
} from './btp-claim-types';
import { BTP_CLAIM_PROTOCOL } from './btp-claim-types';
import { ChainProviderRegistry } from '../settlement/provider/chain-provider-registry';
import type { PaymentChannelProvider } from '../settlement/provider/payment-channel-provider';
import type { PaymentChannelSDK } from '../settlement/payment-channel-sdk';
import type { Logger } from '../utils/logger';
import { PacketType, ILPErrorCode } from '@toon-protocol/shared';
import type { ILPPreparePacket, ILPRejectPacket } from '@toon-protocol/shared';
import type { BTPProtocolData } from './btp-types';

const createMockLogger = (): Logger =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    trace: jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    child: jest.fn(function (this: any) {
      return this;
    }),
  }) as unknown as Logger;

const createPrepare = (amount: bigint = 1000n): ILPPreparePacket => ({
  type: PacketType.PREPARE,
  amount,
  destination: 'g.alice.wallet',
  expiresAt: new Date(Date.now() + 10_000),
  data: Buffer.alloc(0),
});

const asProtocolData = (claim: BTPClaimMessage): BTPProtocolData[] => [
  {
    protocolName: BTP_CLAIM_PROTOCOL.NAME,
    contentType: BTP_CLAIM_PROTOCOL.CONTENT_TYPE,
    data: Buffer.from(JSON.stringify(claim), 'utf8'),
  },
];

// ─── Chain fixtures (structure-valid; crypto is mocked to pass) ───

const EVM_CHANNEL_ID = '0x' + 'a'.repeat(64);

const evmClaim = (nonce: number): EVMClaimMessage => ({
  version: '1.0',
  blockchain: 'evm',
  messageId: `evm-${nonce}-${Math.random().toString(36).slice(2)}`,
  timestamp: '2026-07-17T12:00:00.000Z',
  senderId: 'peer-a',
  channelId: EVM_CHANNEL_ID,
  nonce,
  transferredAmount: String(1000 * nonce),
  lockedAmount: '0',
  locksRoot: '0x' + '0'.repeat(64),
  signature: '0x' + 'b'.repeat(130),
  signerAddress: '0x' + 'c'.repeat(40),
  chainId: 31337,
  tokenNetworkAddress: '0x' + 'd'.repeat(40),
  tokenAddress: '0x' + 'e'.repeat(40),
});

const SOLANA_CHANNEL_ACCOUNT = 'ChanAcct1111111111111111111111111111111111';

const solanaClaim = (nonce: number): SolanaClaimMessage => ({
  version: '1.0',
  blockchain: 'solana',
  messageId: `sol-${nonce}-${Math.random().toString(36).slice(2)}`,
  timestamp: '2026-07-17T12:00:00.000Z',
  senderId: 'peer-a',
  programId: '11111111111111111111111111111111',
  channelAccount: SOLANA_CHANNEL_ACCOUNT,
  nonce,
  transferredAmount: String(1000 * nonce),
  signature: 'c2lnbmF0dXJl',
  signerPublicKey: 'SiGnEr111111111111111111111111111111111111',
  cluster: 'devnet',
});

const MINA_ZKAPP_ADDRESS = 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy';

const minaClaim = (nonce: number): MinaClaimMessage => ({
  version: '1.0',
  blockchain: 'mina',
  messageId: `mina-${nonce}-${Math.random().toString(36).slice(2)}`,
  timestamp: '2026-07-17T12:00:00.000Z',
  senderId: 'peer-a',
  zkAppAddress: MINA_ZKAPP_ADDRESS,
  tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
  balanceCommitment: '12345678901234567890',
  nonce,
  proof: 'emtQcm9vZg==',
  salt: 'test-salt',
  network: 'devnet',
});

// ─── Harness ───

interface Harness {
  validator: InboundClaimValidator;
  /** Always-verifying provider crypto (Solana + Mina paths). */
  verifyBalanceProof: jest.Mock;
  /** Always-verifying EVM SDK crypto. */
  verifyBalanceProofWithDomain: jest.Mock;
  watermarkLookup: jest.Mock;
  /** Route-price resolver (#359); undefined when the binding is not wired. */
  routePriceLookup?: jest.Mock;
}

const makeHarness = (
  watermarkByChannel: Record<string, BTPClaimMessage | null>,
  opts: { wired?: boolean; routePrice?: (destination: string) => string | null } = {}
): Harness => {
  const verifyBalanceProof = jest.fn(async () => true);
  const registry = new ChainProviderRegistry();
  registry.register({
    chainType: 'solana',
    chainId: 'solana:devnet',
    verifyBalanceProof,
  } as unknown as PaymentChannelProvider);
  registry.register({
    chainType: 'mina',
    chainId: 'mina:devnet',
    verifyBalanceProof,
  } as unknown as PaymentChannelProvider);

  const verifyBalanceProofWithDomain = jest.fn(async () => true);
  const evmSdk = {
    verifyBalanceProofWithDomain,
    verifyBalanceProof: jest.fn(async () => true),
  } as unknown as PaymentChannelSDK;

  const watermarkLookup = jest.fn(
    async (_peerId: string, _blockchain: string, channelId: string) =>
      watermarkByChannel[channelId] ?? null
  );

  const routePriceLookup = opts.routePrice
    ? jest.fn((destination: string) => opts.routePrice!(destination))
    : undefined;

  const validator = new InboundClaimValidator(
    evmSdk,
    'test-node',
    createMockLogger(),
    undefined,
    undefined,
    undefined,
    undefined,
    registry,
    opts.wired === false ? undefined : (watermarkLookup as ReceivedClaimWatermarkLookup),
    routePriceLookup as RoutePriceResolver | undefined
  );

  return {
    validator,
    verifyBalanceProof,
    verifyBalanceProofWithDomain,
    watermarkLookup,
    routePriceLookup,
  };
};

const expectF06 = (result: ILPRejectPacket | null): ILPRejectPacket => {
  expect(result).not.toBeNull();
  expect(result!.type).toBe(PacketType.REJECT);
  expect(result!.code).toBe(ILPErrorCode.F06_UNEXPECTED_PAYMENT);
  return result!;
};

// ─── Tests ───

describe('InboundClaimValidator — received-claim watermark gate (#353)', () => {
  describe.each([
    ['EVM', EVM_CHANNEL_ID, evmClaim] as const,
    ['Solana', SOLANA_CHANNEL_ACCOUNT, solanaClaim] as const,
    ['Mina', MINA_ZKAPP_ADDRESS, minaClaim] as const,
  ])('%s claims', (_label, channelId, makeClaim) => {
    it('F06-rejects a stale-nonce replay before any crypto verification', async () => {
      const h = makeHarness({ [channelId]: makeClaim(6) });

      const result = await h.validator.validate(
        asProtocolData(makeClaim(4)),
        createPrepare(),
        'peer-a'
      );

      const reject = expectF06(result);
      expect(reject.message).toContain('Stale payment claim');
      expect(reject.message).toContain('nonce 4');
      // The replay is decided on the local watermark read alone: neither the
      // provider crypto nor the EVM SDK is ever invoked (and therefore no
      // provider-side chain RPC can occur on this path).
      expect(h.verifyBalanceProof).not.toHaveBeenCalled();
      expect(h.verifyBalanceProofWithDomain).not.toHaveBeenCalled();
    });

    it('F06-rejects an equal-nonce (byte-exact) replay — clients sign a fresh claim per write', async () => {
      const h = makeHarness({ [channelId]: makeClaim(6) });

      const result = await h.validator.validate(
        asProtocolData(makeClaim(6)),
        createPrepare(),
        'peer-a'
      );

      expectF06(result);
      expect(h.verifyBalanceProof).not.toHaveBeenCalled();
      expect(h.verifyBalanceProofWithDomain).not.toHaveBeenCalled();
    });

    it('admits a strictly advancing claim (crypto gate still runs and decides)', async () => {
      const h = makeHarness({ [channelId]: makeClaim(6) });

      const result = await h.validator.validate(
        asProtocolData(makeClaim(7)),
        createPrepare(),
        'peer-a'
      );

      expect(result).toBeNull();
      expect(h.watermarkLookup).toHaveBeenCalledWith('peer-a', makeClaim(7).blockchain, channelId);
      // Exactly one crypto verification ran (chain-appropriate seam).
      expect(
        h.verifyBalanceProof.mock.calls.length + h.verifyBalanceProofWithDomain.mock.calls.length
      ).toBe(1);
    });

    it('first claim on a channel with no watermark passes to the crypto gate', async () => {
      const h = makeHarness({});

      const result = await h.validator.validate(
        asProtocolData(makeClaim(1)),
        createPrepare(),
        'peer-a'
      );

      expect(result).toBeNull();
      expect(h.watermarkLookup).toHaveBeenCalledTimes(1);
      expect(
        h.verifyBalanceProof.mock.calls.length + h.verifyBalanceProofWithDomain.mock.calls.length
      ).toBe(1);
    });
  });

  it('preserves crypto-only gating when no watermark lookup is wired (pre-#353 behavior)', async () => {
    const h = makeHarness({ [SOLANA_CHANNEL_ACCOUNT]: solanaClaim(6) }, { wired: false });

    const result = await h.validator.validate(
      asProtocolData(solanaClaim(4)),
      createPrepare(),
      'peer-a'
    );

    // Without the lookup the stale claim still passes (crypto is valid) —
    // exactly the pre-fix behavior for deployments without a ClaimReceiver.
    expect(result).toBeNull();
    expect(h.watermarkLookup).not.toHaveBeenCalled();
    expect(h.verifyBalanceProof).toHaveBeenCalledTimes(1);
  });

  it('fails open to the crypto gate when the watermark read throws', async () => {
    const h = makeHarness({});
    h.watermarkLookup.mockRejectedValueOnce(new Error('db closed'));

    const result = await h.validator.validate(
      asProtocolData(solanaClaim(1)),
      createPrepare(),
      'peer-a'
    );

    expect(result).toBeNull();
    expect(h.verifyBalanceProof).toHaveBeenCalledTimes(1);
  });

  it('keeps the zero-amount skip: a stale claim on a zero-amount packet is not consulted', async () => {
    const h = makeHarness({ [SOLANA_CHANNEL_ACCOUNT]: solanaClaim(6) });

    const result = await h.validator.validate(
      asProtocolData(solanaClaim(4)),
      createPrepare(0n),
      'peer-a'
    );

    expect(result).toBeNull(); // zero-amount packets carry no value (issue #78 semantics)
    expect(h.watermarkLookup).not.toHaveBeenCalled();
  });

  it('watermark is scoped per channel: a stale nonce on channel A does not block channel B', async () => {
    // Watermark exists for the Solana channel only; the Mina claim reuses a
    // low nonce but on a different (fresh) channel — it must pass.
    const h = makeHarness({ [SOLANA_CHANNEL_ACCOUNT]: solanaClaim(6) });

    const result = await h.validator.validate(
      asProtocolData(minaClaim(1)),
      createPrepare(),
      'peer-a'
    );

    expect(result).toBeNull();
    expect(h.watermarkLookup).toHaveBeenCalledWith('peer-a', 'mina', MINA_ZKAPP_ADDRESS);
  });
});

/**
 * Claim value ↔ route price binding (Issue #359)
 *
 * After #358 closed the freshness/replay hole, a *fresh* claim that advances the
 * channel's cumulative amount by a single base unit still FULFILLed a job of any
 * price — the operator was underpaid. This gate binds the two: on a
 * locally-terminated priced route the claim must advance the cumulative amount
 * by at least the route's flat `price`, else F06 BEFORE any crypto verification
 * (and therefore before the backend). The delta is
 *   claimDelta = cumulative(claim) − cumulative(watermark ?? 0).
 *
 * The fixtures set `transferredAmount = 1000 * nonce`, so consecutive claims
 * advance the cumulative by exactly 1000 base units. Crypto is mocked to always
 * pass (as above), so any REJECT is attributable to the value check alone, and
 * "crypto never called" is the unit-level proxy for "backend never reached".
 */
describe('InboundClaimValidator — claim-value ↔ price binding (#359)', () => {
  // Only EVM and Solana carry a plaintext cumulative `transferredAmount`; Mina's
  // opaque balanceCommitment is a documented deferred path, exercised separately.
  describe.each([
    ['EVM', EVM_CHANNEL_ID, evmClaim] as const,
    ['Solana', SOLANA_CHANNEL_ACCOUNT, solanaClaim] as const,
  ])('%s claims', (_label, channelId, makeClaim) => {
    it('F06-rejects an underpaying claim (delta < price) before any crypto/backend', async () => {
      // watermark nonce 6 (cumulative 6000) → claim nonce 7 (cumulative 7000):
      // delta 1000, route price 2000 → underpaid.
      const h = makeHarness({ [channelId]: makeClaim(6) }, { routePrice: () => '2000' });

      const result = await h.validator.validate(
        asProtocolData(makeClaim(7)),
        createPrepare(),
        'peer-a'
      );

      const reject = expectF06(result);
      expect(reject.message).toContain('Insufficient claim value');
      expect(reject.message).toContain('1000'); // delta
      expect(reject.message).toContain('2000'); // price
      // Underpayment is decided on local data only — no crypto verification runs,
      // so the packet never reaches the backend.
      expect(h.verifyBalanceProof).not.toHaveBeenCalled();
      expect(h.verifyBalanceProofWithDomain).not.toHaveBeenCalled();
      expect(h.routePriceLookup).toHaveBeenCalledWith('g.alice.wallet');
    });

    it('admits a claim whose delta EXACTLY equals the price (crypto gate runs)', async () => {
      const h = makeHarness(
        { [channelId]: makeClaim(6) },
        { routePrice: () => '1000' } // delta 1000 == price
      );

      const result = await h.validator.validate(
        asProtocolData(makeClaim(7)),
        createPrepare(),
        'peer-a'
      );

      expect(result).toBeNull();
      expect(
        h.verifyBalanceProof.mock.calls.length + h.verifyBalanceProofWithDomain.mock.calls.length
      ).toBe(1);
    });

    it('admits an overpaying claim (delta > price)', async () => {
      const h = makeHarness(
        { [channelId]: makeClaim(6) },
        { routePrice: () => '500' } // delta 1000 > price 500
      );

      const result = await h.validator.validate(
        asProtocolData(makeClaim(7)),
        createPrepare(),
        'peer-a'
      );

      expect(result).toBeNull();
      expect(
        h.verifyBalanceProof.mock.calls.length + h.verifyBalanceProofWithDomain.mock.calls.length
      ).toBe(1);
    });

    it('binds value on the FIRST claim too (no watermark → cumulative baseline 0)', async () => {
      // No watermark: claim nonce 1 has cumulative 1000; price 2000 → underpaid.
      const h = makeHarness({}, { routePrice: () => '2000' });

      const result = await h.validator.validate(
        asProtocolData(makeClaim(1)),
        createPrepare(),
        'peer-a'
      );

      const reject = expectF06(result);
      expect(reject.message).toContain('Insufficient claim value');
      expect(h.verifyBalanceProof).not.toHaveBeenCalled();
      expect(h.verifyBalanceProofWithDomain).not.toHaveBeenCalled();
    });

    it('does not enforce value on a forwarded / non-terminated destination (price resolver → null)', async () => {
      // resolveRoutePrice returns null: this connector is not the pricing
      // authority for the destination → freshness only, value skipped.
      const h = makeHarness({ [channelId]: makeClaim(6) }, { routePrice: () => null });

      const result = await h.validator.validate(
        asProtocolData(makeClaim(7)), // delta 1000, but no price to bind
        createPrepare(),
        'peer-a'
      );

      expect(result).toBeNull();
      expect(
        h.verifyBalanceProof.mock.calls.length + h.verifyBalanceProofWithDomain.mock.calls.length
      ).toBe(1);
    });

    it('does not enforce value on a free route (price 0)', async () => {
      const h = makeHarness({ [channelId]: makeClaim(6) }, { routePrice: () => '0' });

      const result = await h.validator.validate(
        asProtocolData(makeClaim(7)),
        createPrepare(),
        'peer-a'
      );

      expect(result).toBeNull();
    });

    it('preserves freshness precedence: a STALE underpaying claim is rejected as stale', async () => {
      const h = makeHarness({ [channelId]: makeClaim(6) }, { routePrice: () => '2000' });

      const result = await h.validator.validate(
        asProtocolData(makeClaim(4)), // stale nonce
        createPrepare(),
        'peer-a'
      );

      const reject = expectF06(result);
      // Freshness runs first, so the message is the stale one, not underpayment.
      expect(reject.message).toContain('Stale payment claim');
    });
  });

  it('does not enforce value when the binding is not wired (pre-#359 behavior)', async () => {
    // No routePrice option → resolveRoutePrice undefined; an underpaying claim
    // still passes the value dimension (freshness-only), matching deployments
    // built before #359.
    const h = makeHarness({ [EVM_CHANNEL_ID]: evmClaim(6) });

    const result = await h.validator.validate(
      asProtocolData(evmClaim(7)),
      createPrepare(),
      'peer-a'
    );

    expect(result).toBeNull();
    expect(h.routePriceLookup).toBeUndefined();
    expect(h.verifyBalanceProofWithDomain).toHaveBeenCalledTimes(1);
  });

  it('DEFERRED: a Mina claim on a priced route is not value-bound (opaque commitment) — freshness-only', async () => {
    // Mina carries only balanceCommitment (opaque), so claimDelta is not
    // computable at the gate. The claim must still pass the value dimension
    // (freshness applies), and this is the enumerated per-chain follow-up.
    const h = makeHarness(
      { [MINA_ZKAPP_ADDRESS]: minaClaim(6) },
      { routePrice: () => '999999999' } // would underpay IF it were enforceable
    );

    const result = await h.validator.validate(
      asProtocolData(minaClaim(7)), // fresh (nonce advances)
      createPrepare(),
      'peer-a'
    );

    expect(result).toBeNull(); // not rejected: value binding is deferred for Mina
    expect(h.verifyBalanceProof).toHaveBeenCalledTimes(1); // proceeded to crypto
  });
});
