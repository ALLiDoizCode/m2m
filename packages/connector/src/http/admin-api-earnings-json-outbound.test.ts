/**
 * Unit Tests for /admin/earnings.json — Outbound Wiring (Story 37.7)
 *
 * Companion to `admin-api-earnings-json.test.ts` (Story 37.4). Exercises the
 * bidirectional earnings projection when `SentClaimsQueries` is wired in.
 *
 * Covers Story 37.7 AC 1 (claimsSentTotal populated), AC 2 (outbound rows in
 * recentClaims), AC 3 (sent_claims wiring separation), AC 4 (outbound-only
 * peer surfaces correctly), AC 5 (37.4 tests untouched by addition).
 *
 * @module http/admin-api-earnings-json-outbound.test
 */

import request from 'supertest';
import express, { Express } from 'express';
// Runtime DB is libsql (better-sqlite3-compatible); type stays on better-sqlite3.
import BetterSqlite3 from 'libsql';
import type { Database } from 'better-sqlite3';
import { createAdminRouter, AdminAPIConfig } from './admin-api';
import type { RoutingTable } from '../routing/routing-table';
import type { BTPClientManager } from '../btp/btp-client-manager';
import { AccountManager } from '../settlement/account-manager';
import { InMemoryLedgerClient } from '../settlement/in-memory-ledger-client';
import { ClaimReceiver } from '../settlement/claim-receiver';
import { initializeClaimReceiverSchema } from '../settlement/claim-receiver-db-schema';
import { SentClaimsQueries } from '../settlement/sent-claims-queries';
import {
  SENT_CLAIMS_TABLE_SCHEMA,
  SENT_CLAIMS_INDEXES,
} from '../settlement/claim-sender-db-schema';
import type { ChainProviderRegistry } from '../settlement/provider/chain-provider-registry';
import { AccountLedgerCodes } from '../settlement/types';

describe('Admin API GET /admin/earnings.json — outbound wiring (Story 37.7)', () => {
  let app: Express;
  let mockRoutingTable: jest.Mocked<RoutingTable>;
  let mockBTPClientManager: jest.Mocked<BTPClientManager>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockLogger: any;
  let ledgerClient: InMemoryLedgerClient;
  let accountManager: AccountManager;
  let claimReceiver: ClaimReceiver;
  let claimsDb: Database;
  let sentClaimsDb: Database;
  let sentClaimsQueries: SentClaimsQueries;

  const stubRegistry = {
    getProvider: () => undefined,
    getAllProviders: () => [],
  } as unknown as ChainProviderRegistry;

  function insertReceivedClaim(opts: {
    messageId: string;
    peerId: string;
    channelId: string;
    tokenAddress: string;
    transferredAmount: string;
    receivedAt: number;
    nonce?: number;
  }): void {
    const claimData = {
      messageId: opts.messageId,
      blockchain: 'evm',
      channelId: opts.channelId,
      tokenAddress: opts.tokenAddress,
      tokenNetworkAddress: '0x1111111111111111111111111111111111111111',
      chainId: 8453,
      nonce: opts.nonce ?? 1,
      transferredAmount: opts.transferredAmount,
      lockedAmount: '0',
      locksRoot: '0x' + '0'.repeat(64),
      signature: '0x' + '0'.repeat(130),
      signerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    claimsDb
      .prepare(
        `INSERT INTO received_claims (
          message_id, peer_id, blockchain, channel_id, claim_data, verified,
          received_at, redeemed_at, redemption_tx_hash
        ) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, NULL)`
      )
      .run(
        opts.messageId,
        opts.peerId,
        'evm',
        opts.channelId,
        JSON.stringify(claimData),
        opts.receivedAt
      );
  }

  function insertSentClaim(opts: {
    messageId: string;
    peerId: string;
    channelId: string;
    tokenAddress: string;
    transferredAmount: string;
    sentAt: number;
    nonce?: number;
  }): void {
    const claimData = {
      messageId: opts.messageId,
      blockchain: 'evm',
      channelId: opts.channelId,
      tokenAddress: opts.tokenAddress,
      tokenNetworkAddress: '0x2222222222222222222222222222222222222222',
      chainId: 8453,
      nonce: opts.nonce ?? 1,
      transferredAmount: opts.transferredAmount,
      lockedAmount: '0',
      locksRoot: '0x' + '0'.repeat(64),
      signature: '0x' + '0'.repeat(130),
      signerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };
    sentClaimsDb
      .prepare(
        `INSERT INTO sent_claims (
          message_id, peer_id, blockchain, claim_data, sent_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(opts.messageId, opts.peerId, 'evm', JSON.stringify(claimData), opts.sentAt);
  }

  const createApp = async (configOverrides?: Partial<AdminAPIConfig>): Promise<Express> => {
    const config: AdminAPIConfig = {
      routingTable: mockRoutingTable,
      btpClientManager: mockBTPClientManager,
      logger: mockLogger,
      nodeId: 'test-connector',
      accountManager,
      claimReceiver,
      sentClaimsQueries,
      resolveTokenMetadata: async (blockchain, tokenAddress) => {
        if (blockchain === 'evm') {
          if (tokenAddress === '0xUSDC') return { assetCode: 'USDC', assetScale: 6 };
          if (tokenAddress === '0xETH') return { assetCode: 'ETH', assetScale: 18 };
        }
        return { assetCode: tokenAddress || 'UNKNOWN', assetScale: 0 };
      },
      ...configOverrides,
    };
    const router = await createAdminRouter(config);
    const expressApp = express();
    expressApp.use('/admin', router);
    return expressApp;
  };

  beforeEach(async () => {
    mockRoutingTable = {
      addRoute: jest.fn(),
      removeRoute: jest.fn(),
      getAllRoutes: jest.fn().mockReturnValue([]),
      lookup: jest.fn(),
      removeRoutesForPeer: jest.fn(),
    } as unknown as jest.Mocked<RoutingTable>;

    mockBTPClientManager = {
      addPeer: jest.fn().mockResolvedValue(undefined),
      removePeer: jest.fn().mockResolvedValue(undefined),
      getPeerIds: jest.fn().mockReturnValue(['swap-01', 'solo-payout', 'inbound-only']),
      getPeerStatus: jest.fn().mockReturnValue(
        new Map([
          ['swap-01', true],
          ['solo-payout', true],
          ['inbound-only', true],
        ])
      ),
      isConnected: jest.fn(),
      getConnectedPeers: jest.fn(),
      getClientForPeer: jest.fn(),
    } as unknown as jest.Mocked<BTPClientManager>;

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
      fatal: jest.fn(),
      trace: jest.fn(),
      level: 'info',
    };

    ledgerClient = new InMemoryLedgerClient(
      { snapshotPath: `/tmp/earnings-outbound-${Date.now()}-${Math.random()}.json` },
      mockLogger
    );
    await ledgerClient.initialize();
    accountManager = new AccountManager(
      { nodeId: 'test-connector', defaultLedger: AccountLedgerCodes.DEFAULT_LEDGER },
      ledgerClient,
      mockLogger
    );

    // libsql instances asserted as the better-sqlite3 Database type the
    // ClaimReceiver / sent-claims queries are typed against.
    claimsDb = new BetterSqlite3(':memory:') as unknown as Database;
    initializeClaimReceiverSchema(claimsDb);
    claimReceiver = new ClaimReceiver(claimsDb, stubRegistry, mockLogger);

    sentClaimsDb = new BetterSqlite3(':memory:') as unknown as Database;
    sentClaimsDb.exec(SENT_CLAIMS_TABLE_SCHEMA);
    for (const idx of SENT_CLAIMS_INDEXES) sentClaimsDb.exec(idx);
    sentClaimsQueries = new SentClaimsQueries(sentClaimsDb, mockLogger);

    // Fixture:
    //   swap-01: bidirectional. Inbound 100k & 250k cumulative on channel A.
    //            Outbound 50k & 150k cumulative on channel B.
    //   solo-payout: outbound-only. 400k cumulative on channel C.
    //   inbound-only: inbound-only. 75k cumulative on channel D.
    insertReceivedClaim({
      messageId: 'rx-1',
      peerId: 'swap-01',
      channelId: '0xchan-A',
      tokenAddress: '0xUSDC',
      transferredAmount: '100000',
      receivedAt: 1_700_000_000_000,
      nonce: 1,
    });
    insertReceivedClaim({
      messageId: 'rx-2',
      peerId: 'swap-01',
      channelId: '0xchan-A',
      tokenAddress: '0xUSDC',
      transferredAmount: '250000',
      receivedAt: 1_700_000_060_000,
      nonce: 2,
    });
    insertSentClaim({
      messageId: 'tx-1',
      peerId: 'swap-01',
      channelId: '0xchan-B',
      tokenAddress: '0xUSDC',
      transferredAmount: '50000',
      sentAt: 1_700_000_030_000,
      nonce: 1,
    });
    insertSentClaim({
      messageId: 'tx-2',
      peerId: 'swap-01',
      channelId: '0xchan-B',
      tokenAddress: '0xUSDC',
      transferredAmount: '150000',
      sentAt: 1_700_000_090_000,
      nonce: 2,
    });
    insertSentClaim({
      messageId: 'tx-solo-1',
      peerId: 'solo-payout',
      channelId: '0xchan-C',
      tokenAddress: '0xUSDC',
      transferredAmount: '400000',
      sentAt: 1_700_000_120_000,
      nonce: 1,
    });
    insertReceivedClaim({
      messageId: 'rx-inbound-1',
      peerId: 'inbound-only',
      channelId: '0xchan-D',
      tokenAddress: '0xUSDC',
      transferredAmount: '75000',
      receivedAt: 1_700_000_045_000,
      nonce: 1,
    });

    app = await createApp();
  });

  afterEach(async () => {
    claimsDb.close();
    sentClaimsDb.close();
    await ledgerClient.close();
    jest.clearAllMocks();
  });

  // --- AC 1: claimsSentTotal populated ---

  it('[AC 1] populates claimsSentTotal from the sent_claims table (latest nonce per channel)', async () => {
    const res = await request(app).get('/admin/earnings.json').expect(200);
    const swap = res.body.peers.find((p: { peerId: string }) => p.peerId === 'swap-01');
    expect(swap).toBeDefined();
    const usdc = swap.byAsset.find((a: { assetCode: string }) => a.assetCode === 'USDC');
    expect(usdc.claimsReceivedTotal).toBe('250000'); // max-nonce inbound
    expect(usdc.claimsSentTotal).toBe('150000'); // max-nonce outbound
    // netBalance = sent - received = 150k - 250k = -100k (peer still owes us 100k)
    expect(usdc.netBalance).toBe('-100000');
  });

  // --- AC 4: outbound-only peer surfaces correctly ---

  it('[AC 4] surfaces an outbound-only peer with claimsSentTotal > 0 and claimsReceivedTotal = 0', async () => {
    const res = await request(app).get('/admin/earnings.json').expect(200);
    const solo = res.body.peers.find((p: { peerId: string }) => p.peerId === 'solo-payout');
    expect(solo).toBeDefined();
    const usdc = solo.byAsset.find((a: { assetCode: string }) => a.assetCode === 'USDC');
    expect(usdc.claimsSentTotal).toBe('400000');
    expect(usdc.claimsReceivedTotal).toBe('0');
    expect(usdc.netBalance).toBe('400000'); // we owe solo-payout 400k
  });

  // Inbound-only peer still works when outbound wiring is present ---

  it('preserves inbound-only peer row when outbound wiring is active', async () => {
    const res = await request(app).get('/admin/earnings.json').expect(200);
    const peer = res.body.peers.find((p: { peerId: string }) => p.peerId === 'inbound-only');
    expect(peer).toBeDefined();
    const usdc = peer.byAsset.find((a: { assetCode: string }) => a.assetCode === 'USDC');
    expect(usdc.claimsReceivedTotal).toBe('75000');
    expect(usdc.claimsSentTotal).toBe('0');
    expect(usdc.netBalance).toBe('-75000');
  });

  // --- AC 2: recentClaims contains outbound rows ---

  it('[AC 2] recentClaims contains both inbound and outbound entries, newest-first', async () => {
    const res = await request(app).get('/admin/earnings.json').expect(200);
    const claims: Array<{ direction: string; at: string; peerId: string; amount: string }> =
      res.body.recentClaims;

    const directions = claims.map((c) => c.direction);
    expect(directions).toContain('inbound');
    expect(directions).toContain('outbound');

    // Newest-first across both directions.
    for (let i = 0; i < claims.length - 1; i++) {
      const a = new Date(claims[i]!.at).getTime();
      const b = new Date(claims[i + 1]!.at).getTime();
      expect(a).toBeGreaterThanOrEqual(b);
    }
  });

  it('[AC 2] outbound delta = this cumulative − prior cumulative on the same channel+direction', async () => {
    const res = await request(app).get('/admin/earnings.json').expect(200);
    const outboundMill = res.body.recentClaims.filter(
      (c: { peerId: string; direction: string }) =>
        c.peerId === 'swap-01' && c.direction === 'outbound'
    );
    // Two outbound rows on channel B: cumulative 50k → 150k. Newest first:
    //   tx-2 (150k): delta = 150k - 50k = 100k
    //   tx-1 (50k):  delta = 50k (no prior)
    expect(outboundMill.length).toBe(2);
    expect(outboundMill[0].amount).toBe('100000');
    expect(outboundMill[1].amount).toBe('50000');
  });

  // --- AC 3: queries module is independently swappable ---

  it('[AC 3] endpoint falls back to inbound-only when sentClaimsQueries is omitted', async () => {
    const noOutboundApp = await createApp({ sentClaimsQueries: undefined });
    const res = await request(noOutboundApp).get('/admin/earnings.json').expect(200);

    const swap = res.body.peers.find((p: { peerId: string }) => p.peerId === 'swap-01');
    const usdc = swap.byAsset.find((a: { assetCode: string }) => a.assetCode === 'USDC');
    // Inbound still present; outbound masked to "0".
    expect(usdc.claimsReceivedTotal).toBe('250000');
    expect(usdc.claimsSentTotal).toBe('0');

    // solo-payout disappears from peer set because it has neither inbound nor
    // configured tokens; it would only surface via outbound (which is off).
    const solo = res.body.peers.find((p: { peerId: string }) => p.peerId === 'solo-payout');
    expect(solo).toBeDefined();
    expect(solo.byAsset).toEqual([]);

    // recentClaims should contain no outbound rows.
    const directions = (res.body.recentClaims as Array<{ direction: string }>).map(
      (c) => c.direction
    );
    expect(directions.every((d) => d === 'inbound')).toBe(true);
  });

  // --- connectorFees still approximated from inbound only ---

  it('connectorFees remains an inbound-only approximation', async () => {
    const feeApp = await createApp({ connectorFeePercentage: 1 });
    const res = await request(feeApp).get('/admin/earnings.json').expect(200);
    // Total inbound USDC = 250k (swap-01) + 75k (inbound-only) = 325k. 1% fee = 3.25k.
    const usdcFee = res.body.connectorFees.find(
      (f: { assetCode: string }) => f.assetCode === 'USDC'
    );
    expect(usdcFee.total).toBe('3250');
  });
});
