/**
 * Received-claim watermark — real-database round trip (Issue #353).
 *
 * Drives a REAL in-memory SQLite (libsql) `received_claims` store through the
 * REAL ClaimReceiver ingest path and the REAL InboundClaimValidator gate wired
 * to the same store — the exact pairing connector-node wires in production —
 * and proves the end-to-end invariants of the #353 fix:
 *
 *  1. The watermark advances ONLY on verified claims: a failed verification
 *     (stale nonce) persists as verified=0 and leaves the watermark untouched.
 *  2. The gate F06-rejects any claim that does not strictly advance the
 *     watermark (stale AND equal nonce), and admits a strictly advancing one.
 *  3. The watermark never regresses after redemption: marking the high-water
 *     claim redeemed must not reopen the gate to older claims (this is why
 *     the watermark query, unlike getLatestVerifiedClaim, includes redeemed
 *     rows).
 *
 * Provider crypto is mocked to always-verify, isolating the freshness/
 * persistence logic; the DB, receiver, and validator are all real.
 */

// Runtime DB is libsql (better-sqlite3-compatible); type stays on better-sqlite3.
import BetterSqlite3 from 'libsql';
import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';
import { ClaimReceiver } from './claim-receiver';
import { initializeClaimReceiverSchema } from './claim-receiver-db-schema';
import { InboundClaimValidator } from '../btp/inbound-claim-validator';
import type { EVMClaimMessage } from '../btp/btp-claim-types';
import { BTP_CLAIM_PROTOCOL } from '../btp/btp-claim-types';
import type { BTPProtocolData } from '../btp/btp-types';
import { ChainProviderRegistry } from './provider/chain-provider-registry';
import type { PaymentChannelProvider } from './provider/payment-channel-provider';
import type { ChannelManager } from './channel-manager';
import type { PaymentChannelSDK } from './payment-channel-sdk';
import { PacketType, ILPErrorCode } from '@toon-protocol/shared';
import type { ILPPreparePacket, ILPRejectPacket } from '@toon-protocol/shared';

const CHANNEL_ID = '0x' + 'a'.repeat(64);
const PEER_ID = 'peer-alice';

const mockLogger = (): Logger =>
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

const evmClaim = (nonce: number): EVMClaimMessage => ({
  version: '1.0',
  blockchain: 'evm',
  messageId: `evm-db-${nonce}-${Math.random().toString(36).slice(2)}`,
  timestamp: '2026-07-17T12:00:00.000Z',
  senderId: PEER_ID,
  channelId: CHANNEL_ID,
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

const asProtocolData = (claim: EVMClaimMessage): BTPProtocolData[] => [
  {
    protocolName: BTP_CLAIM_PROTOCOL.NAME,
    contentType: BTP_CLAIM_PROTOCOL.CONTENT_TYPE,
    data: Buffer.from(JSON.stringify(claim), 'utf8'),
  },
];

const prepare = (): ILPPreparePacket => ({
  type: PacketType.PREPARE,
  amount: 1000n,
  destination: 'g.store.write',
  expiresAt: new Date(Date.now() + 10_000),
  data: Buffer.alloc(0),
});

describe('Received-claim watermark round trip on a real DB (#353)', () => {
  let db: Database;
  let receiver: ClaimReceiver;
  let validator: InboundClaimValidator;

  beforeEach(() => {
    db = new BetterSqlite3(':memory:') as unknown as Database;
    initializeClaimReceiverSchema(db);

    // Always-verifying provider crypto; the channel is pre-known so the
    // receiver takes the known-channel path (no on-chain state lookup).
    const provider = {
      chainType: 'evm',
      chainId: 'evm:31337',
      verifyBalanceProof: jest.fn(async () => true),
      getChannelState: jest.fn(),
    } as unknown as PaymentChannelProvider;
    const registry = new ChainProviderRegistry();
    registry.register(provider);
    const channelManager = {
      getChannelById: jest.fn(() => ({ channelId: CHANNEL_ID, chain: 'evm:31337' })),
      registerExternalChannel: jest.fn(),
    } as unknown as ChannelManager;

    receiver = new ClaimReceiver(db, registry, mockLogger(), channelManager);

    // Real validator wired to the SAME store, exactly as connector-node does.
    const evmSdk = {
      verifyBalanceProofWithDomain: jest.fn(async () => true),
      verifyBalanceProof: jest.fn(async () => true),
    } as unknown as PaymentChannelSDK;
    validator = new InboundClaimValidator(
      evmSdk,
      'g.connector',
      mockLogger() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      registry,
      (peerId, blockchain, channelId) =>
        receiver.getReceivedClaimWatermark(peerId, blockchain, channelId)
    );
  });

  const gate = (nonce: number): Promise<ILPRejectPacket | null> =>
    validator.validate(asProtocolData(evmClaim(nonce)), prepare(), PEER_ID);

  const watermarkNonce = async (): Promise<number | null> => {
    const wm = await receiver.getReceivedClaimWatermark(PEER_ID, 'evm', CHANNEL_ID);
    return wm ? wm.nonce : null;
  };

  it('advances the watermark only on VERIFIED claims; the gate tracks it exactly', async () => {
    // First claim: no watermark yet → gate passes on crypto alone.
    expect(await watermarkNonce()).toBeNull();
    expect(await gate(5)).toBeNull();

    // Ingest (the recording seam) verifies and stores → watermark = 5.
    await receiver.ingestProtocolData(PEER_ID, asProtocolData(evmClaim(5)));
    expect(await watermarkNonce()).toBe(5);

    // Stale replay (nonce 4): gate F06-rejects on the local watermark read.
    const stale = await gate(4);
    expect(stale).not.toBeNull();
    expect(stale!.code).toBe(ILPErrorCode.F06_UNEXPECTED_PAYMENT);
    expect(stale!.message).toContain('Stale payment claim');

    // Equal-nonce replay (nonce 5): also F06 — clients sign fresh per write.
    const equal = await gate(5);
    expect(equal).not.toBeNull();
    expect(equal!.code).toBe(ILPErrorCode.F06_UNEXPECTED_PAYMENT);

    // Even if a replay somehow reached ingest (as it does on BTP, where the
    // onMessage recording fires after the gate replies), it is persisted
    // verified=0 and the watermark does NOT move.
    await receiver.ingestProtocolData(PEER_ID, asProtocolData(evmClaim(4)));
    expect(await watermarkNonce()).toBe(5);
    const rows = db
      .prepare(
        'SELECT verified, COUNT(*) AS n FROM received_claims GROUP BY verified ORDER BY verified'
      )
      .all() as Array<{ verified: number; n: number }>;
    expect(rows).toEqual([
      { verified: 0, n: 1 }, // the replay, recorded for forensics only
      { verified: 1, n: 1 }, // the genuine nonce-5 claim
    ]);

    // Advancing claim (nonce 6): gate passes, ingest verifies, watermark = 6.
    expect(await gate(6)).toBeNull();
    await receiver.ingestProtocolData(PEER_ID, asProtocolData(evmClaim(6)));
    expect(await watermarkNonce()).toBe(6);
  });

  it('never regresses across redemption: a redeemed high-water claim still blocks older nonces', async () => {
    await receiver.ingestProtocolData(PEER_ID, asProtocolData(evmClaim(5)));
    await receiver.ingestProtocolData(PEER_ID, asProtocolData(evmClaim(6)));
    expect(await watermarkNonce()).toBe(6);

    // Settle: the executor marks the redeemed claim.
    db.prepare('UPDATE received_claims SET redeemed_at = ? WHERE verified = 1').run(Date.now());

    // getLatestVerifiedClaim (the redemption path) now sees nothing more to
    // redeem — but the freshness watermark still stands at 6...
    expect(await receiver.getLatestVerifiedClaim(PEER_ID, 'evm', CHANNEL_ID)).toBeNull();
    expect(await watermarkNonce()).toBe(6);

    // ...so a post-redemption replay of the old nonce-5 claim is still F06'd
    // at the gate AND refused by the receiver's own monotonicity check.
    const replay = await gate(5);
    expect(replay).not.toBeNull();
    expect(replay!.code).toBe(ILPErrorCode.F06_UNEXPECTED_PAYMENT);

    await receiver.ingestProtocolData(PEER_ID, asProtocolData(evmClaim(5)));
    expect(await watermarkNonce()).toBe(6); // unchanged — not re-verified

    // The channel's nonce sequence continues past the redemption.
    expect(await gate(7)).toBeNull();
    await receiver.ingestProtocolData(PEER_ID, asProtocolData(evmClaim(7)));
    expect(await watermarkNonce()).toBe(7);
  });
});
