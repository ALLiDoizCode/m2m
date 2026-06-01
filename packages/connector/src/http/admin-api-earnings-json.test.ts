/**
 * Unit Tests for Admin API /admin/earnings.json Endpoint (Story 37.4)
 *
 * Covers AC 1–8 of the Townhouse per-peer earnings projection.
 *
 * Testing strategy:
 * - Use a real in-memory SQLite for ClaimReceiver so the SQL paths execute.
 * - Use a real InMemoryLedgerClient + AccountManager so the TB-ledger raw
 *   volume counters are computed by actual code, not mocked.
 * - Mock BTPClientManager and ChainProviderRegistry only (these depend on
 *   network-y subsystems that aren't relevant to the projection logic).
 *
 * @module http/admin-api-earnings-json.test
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
import type { ChainProviderRegistry } from '../settlement/provider/chain-provider-registry';
import type { PeerConfig as SettlementPeerConfig } from '../settlement/types';
import { AccountLedgerCodes } from '../settlement/types';

describe('Admin API GET /admin/earnings.json (Story 37.4)', () => {
  let app: Express;
  let mockRoutingTable: jest.Mocked<RoutingTable>;
  let mockBTPClientManager: jest.Mocked<BTPClientManager>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockLogger: any;
  let ledgerClient: InMemoryLedgerClient;
  let accountManager: AccountManager;
  let claimReceiver: ClaimReceiver;
  let claimsDb: Database;
  let settlementPeers: Map<string, SettlementPeerConfig>;

  // Stub chain provider registry — ClaimReceiver only uses it when verifying
  // live BTP traffic. Tests call _persistReceivedClaim directly (via a helper)
  // so the registry is never touched. We still type it.
  const stubRegistry = {
    getProvider: () => undefined,
    getAllProviders: () => [],
  } as unknown as ChainProviderRegistry;

  /**
   * Helper — insert a verified EVM claim directly into the sqlite table.
   * Mirrors ClaimReceiver._persistReceivedClaim's row shape so the query
   * methods see realistic data without going through the BTP verification
   * pipeline.
   */
  function insertClaim(opts: {
    messageId: string;
    peerId: string;
    channelId: string;
    tokenAddress: string;
    transferredAmount: string;
    receivedAt: number;
    nonce?: number;
    blockchain?: 'evm' | 'solana' | 'mina';
  }): void {
    const blockchain = opts.blockchain ?? 'evm';
    let claimData: Record<string, unknown>;

    if (blockchain === 'solana') {
      claimData = {
        messageId: opts.messageId,
        blockchain: 'solana',
        programId: opts.tokenAddress,
        channelAccount: opts.channelId,
        nonce: opts.nonce ?? 1,
        transferredAmount: opts.transferredAmount,
        signature: 'base64signature==',
        signerPublicKey: '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM',
        cluster: 'devnet',
      };
    } else if (blockchain === 'mina') {
      claimData = {
        messageId: opts.messageId,
        blockchain: 'mina',
        zkAppAddress: opts.channelId,
        tokenId: opts.tokenAddress,
        nonce: opts.nonce ?? 1,
        transferredAmount: opts.transferredAmount,
        balanceCommitment: 'commitment123',
        proof: 'base64proof==',
        salt: 'salt123',
        network: 'devnet',
      };
    } else {
      claimData = {
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
    }

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
        blockchain,
        opts.channelId,
        JSON.stringify(claimData),
        opts.receivedAt
      );
  }

  const createApp = async (configOverrides?: Partial<AdminAPIConfig>): Promise<Express> => {
    const config: AdminAPIConfig = {
      routingTable: mockRoutingTable,
      btpClientManager: mockBTPClientManager,
      logger: mockLogger,
      nodeId: 'test-connector',
      accountManager,
      claimReceiver,
      settlementPeers,
      resolveTokenMetadata: async (blockchain, tokenAddress) => {
        // Deterministic test resolver — mimics an on-chain lookup but returns
        // fixed (symbol, decimals) pairs for known test fixtures so the
        // assertions are stable.
        if (blockchain === 'evm') {
          if (tokenAddress === '0xUSDC') return { assetCode: 'USDC', assetScale: 6 };
          if (tokenAddress === '0xETH') return { assetCode: 'ETH', assetScale: 18 };
        }
        if (blockchain === 'solana') {
          if (tokenAddress === 'So11111111111111111111111111111111111111112')
            return { assetCode: 'SOL', assetScale: 9 };
          // Simulate a generic SPL mint with 6 decimals (e.g., USDC on Solana)
          if (tokenAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
            return { assetCode: 'USDC-S', assetScale: 6 };
        }
        if (blockchain === 'mina') {
          return { assetCode: tokenAddress, assetScale: 9 };
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
      getPeerIds: jest.fn().mockReturnValue(['town-01', 'mill-01', 'dvm-01']),
      getPeerStatus: jest.fn().mockReturnValue(
        new Map([
          ['town-01', true],
          ['mill-01', true],
          ['dvm-01', false],
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

    // Fresh in-memory ledger + account manager per test
    // Use a unique per-test snapshot path inside /tmp; we never await the
    // persistence interval so no file is actually written during the test.
    ledgerClient = new InMemoryLedgerClient(
      { snapshotPath: `/tmp/earnings-test-${Date.now()}-${Math.random()}.json` },
      mockLogger
    );
    await ledgerClient.initialize();
    accountManager = new AccountManager(
      { nodeId: 'test-connector', defaultLedger: AccountLedgerCodes.DEFAULT_LEDGER },
      ledgerClient,
      mockLogger
    );

    // Fresh in-memory sqlite DB per test (libsql instance asserted as the
    // better-sqlite3 Database type the admin API is typed against).
    claimsDb = new BetterSqlite3(':memory:') as unknown as Database;
    initializeClaimReceiverSchema(claimsDb);
    claimReceiver = new ClaimReceiver(claimsDb, stubRegistry, mockLogger);

    // Settlement peer config: town-01 declares USDC+ETH, mill-01 declares USDC,
    // dvm-01 has no settlement config (idle).
    settlementPeers = new Map<string, SettlementPeerConfig>();
    settlementPeers.set('town-01', {
      peerId: 'town-01',
      address: 'g.town-01',
      settlementPreference: 'evm',
      settlementTokens: ['0xUSDC', '0xETH'],
      tokenAddress: '0xUSDC',
    });
    settlementPeers.set('mill-01', {
      peerId: 'mill-01',
      address: 'g.mill-01',
      settlementPreference: 'evm',
      settlementTokens: ['0xUSDC'],
      tokenAddress: '0xUSDC',
    });

    // Seed some packet-forward volume for town-01 and mill-01, leave dvm-01 idle.
    // town-01 received 1_000_000 from us (outgoing) in USDC and sent us 500_000
    // (incoming) in USDC. mill-01 received 2_000_000 from us in USDC.
    await accountManager.recordPacketTransfers(
      'town-01', // fromPeer (sent to us)
      'bob', // toPeer (downstream, unused in this test but needed by API)
      '0xUSDC',
      500_000n,
      500_000n,
      1n,
      2n,
      AccountLedgerCodes.DEFAULT_LEDGER,
      1
    );
    await accountManager.recordPacketTransfers(
      'alice',
      'town-01', // toPeer (we forward to town-01)
      '0xUSDC',
      1_000_000n,
      1_000_000n,
      3n,
      4n,
      AccountLedgerCodes.DEFAULT_LEDGER,
      1
    );
    await accountManager.recordPacketTransfers(
      'alice',
      'mill-01',
      '0xUSDC',
      2_000_000n,
      2_000_000n,
      5n,
      6n,
      AccountLedgerCodes.DEFAULT_LEDGER,
      1
    );

    // Seed a few verified claims for the lastClaimAt and recentClaims paths.
    // town-01 has sent 2 USDC claims on the same channel: 100_000 then 250_000
    // cumulative. mill-01 has one claim.
    insertClaim({
      messageId: 'msg-1',
      peerId: 'town-01',
      channelId: '0xchan-town-usdc',
      tokenAddress: '0xUSDC',
      transferredAmount: '100000',
      receivedAt: 1_700_000_000_000,
      nonce: 1,
    });
    insertClaim({
      messageId: 'msg-2',
      peerId: 'town-01',
      channelId: '0xchan-town-usdc',
      tokenAddress: '0xUSDC',
      transferredAmount: '250000',
      receivedAt: 1_700_000_060_000, // 60s later
      nonce: 2,
    });
    insertClaim({
      messageId: 'msg-3',
      peerId: 'mill-01',
      channelId: '0xchan-mill-usdc',
      tokenAddress: '0xUSDC',
      transferredAmount: '75000',
      receivedAt: 1_700_000_120_000, // 120s after msg-1
      nonce: 1,
    });

    app = await createApp();
  });

  afterEach(async () => {
    claimsDb.close();
    await ledgerClient.close();
    jest.clearAllMocks();
  });

  // ---------- AC 1: Response shape ----------

  describe('AC 1: Response shape matches the AdminEarningsJson contract', () => {
    it('returns 200 with every top-level field populated', async () => {
      const res = await request(app).get('/admin/earnings.json').expect(200);

      expect(res.body).toHaveProperty('uptimeSeconds');
      expect(res.body).toHaveProperty('peers');
      expect(res.body).toHaveProperty('connectorFees');
      expect(res.body).toHaveProperty('recentClaims');
      expect(res.body).toHaveProperty('timestamp');

      expect(typeof res.body.uptimeSeconds).toBe('number');
      expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(res.body.peers)).toBe(true);
      expect(Array.isArray(res.body.connectorFees)).toBe(true);
      expect(Array.isArray(res.body.recentClaims)).toBe(true);
      expect(typeof res.body.timestamp).toBe('string');
      expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('maps each peer to a byAsset entry with correct fields and decimal-string amounts', async () => {
      const res = await request(app).get('/admin/earnings.json').expect(200);

      const town = res.body.peers.find((p: { peerId: string }) => p.peerId === 'town-01');
      expect(town).toBeDefined();
      expect(Array.isArray(town.byAsset)).toBe(true);
      expect(town.byAsset.length).toBeGreaterThan(0);

      const usdc = town.byAsset.find((a: { assetCode: string }) => a.assetCode === 'USDC');
      expect(usdc).toBeDefined();
      expect(usdc.assetCode).toBe('USDC');
      expect(usdc.assetScale).toBe(6);
      // claimsReceivedTotal = latest-nonce cumulative per channel, summed.
      // town-01 has two claims on 0xchan-town-usdc (nonces 1, 2) with
      // cumulative 100_000 then 250_000 — max-nonce = 250_000.
      expect(usdc.claimsReceivedTotal).toBe('250000');
      // Outbound (sent_claims) path is not wired through in this release —
      // hard-coded to '0' pending the follow-up story.
      expect(usdc.claimsSentTotal).toBe('0');
      // netBalance = claimsSent - claimsReceived = -250_000 (peer owes us).
      expect(usdc.netBalance).toBe('-250000');
      expect(usdc.lastClaimAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('amount fields are all strings (not numbers) so ETH-scale values stay safe', async () => {
      const res = await request(app).get('/admin/earnings.json').expect(200);

      for (const peer of res.body.peers) {
        for (const a of peer.byAsset) {
          expect(typeof a.claimsReceivedTotal).toBe('string');
          expect(typeof a.claimsSentTotal).toBe('string');
          expect(typeof a.netBalance).toBe('string');
          expect(typeof a.assetScale).toBe('number');
        }
      }
    });
  });

  // ---------- AC 2: Auth enforced ----------

  describe('AC 2: /admin/earnings.json requires X-Api-Key when configured', () => {
    it('returns 401 without X-Api-Key', async () => {
      const authApp = await createApp({ apiKey: 'secret-key' });
      const res = await request(authApp).get('/admin/earnings.json').expect(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 200 with a valid X-Api-Key', async () => {
      const authApp = await createApp({ apiKey: 'secret-key' });
      await request(authApp).get('/admin/earnings.json').set('X-Api-Key', 'secret-key').expect(200);
    });

    it('returns 401 with a wrong X-Api-Key', async () => {
      const authApp = await createApp({ apiKey: 'secret-key' });
      await request(authApp)
        .get('/admin/earnings.json')
        .set('X-Api-Key', 'not-the-key')
        .expect(401);
    });
  });

  // ---------- AC 3: Idle peers appear ----------

  describe('AC 3: idle peers appear in the response', () => {
    it('includes dvm-01 with byAsset=[] (no claims, no config)', async () => {
      const res = await request(app).get('/admin/earnings.json').expect(200);

      const dvm = res.body.peers.find((p: { peerId: string }) => p.peerId === 'dvm-01');
      expect(dvm).toBeDefined();
      expect(dvm.byAsset).toEqual([]);
    });

    it('includes a peer with configured tokens but no claim history, surfacing the configured asset', async () => {
      // Add a config-only peer
      settlementPeers.set('idle-peer', {
        peerId: 'idle-peer',
        address: 'g.idle-peer',
        settlementPreference: 'evm',
        settlementTokens: ['0xUSDC'],
        tokenAddress: '0xUSDC',
      });
      mockBTPClientManager.getPeerIds.mockReturnValue([
        'town-01',
        'mill-01',
        'dvm-01',
        'idle-peer',
      ]);

      const freshApp = await createApp();
      const res = await request(freshApp).get('/admin/earnings.json').expect(200);

      const idle = res.body.peers.find((p: { peerId: string }) => p.peerId === 'idle-peer');
      expect(idle).toBeDefined();
      expect(idle.byAsset.length).toBe(1);
      expect(idle.byAsset[0].assetCode).toBe('USDC');
      // No ledger activity → both counters zero.
      expect(idle.byAsset[0].claimsReceivedTotal).toBe('0');
      expect(idle.byAsset[0].claimsSentTotal).toBe('0');
      expect(idle.byAsset[0].lastClaimAt).toBeNull();
    });
  });

  // ---------- AC 4 (revised): connector fee approximation ----------

  describe('AC 4 (revised): connectorFees derived from incoming volume × fee pct', () => {
    it('returns empty connectorFees when no fee percentage is configured', async () => {
      const res = await request(app).get('/admin/earnings.json').expect(200);
      expect(res.body.connectorFees).toEqual([]);
    });

    it('returns proportional fee totals when a fee percentage is configured', async () => {
      // Total cumulative-inbound USDC across peers:
      //   town-01: max-nonce on 0xchan-town-usdc = 250_000
      //   mill-01: max-nonce on 0xchan-mill-usdc =  75_000
      //   sum = 325_000. At 1% fee (basis points 100), expected = 3_250.
      const feeApp = await createApp({ connectorFeePercentage: 1 });
      const res = await request(feeApp).get('/admin/earnings.json').expect(200);

      const usdcFee = res.body.connectorFees.find(
        (f: { assetCode: string }) => f.assetCode === 'USDC'
      );
      expect(usdcFee).toBeDefined();
      expect(usdcFee.assetScale).toBe(6);
      expect(usdcFee.total).toBe('3250');
    });

    it('omits assets with zero incoming volume from connectorFees', async () => {
      const feeApp = await createApp({ connectorFeePercentage: 1 });
      const res = await request(feeApp).get('/admin/earnings.json').expect(200);

      const ethFee = res.body.connectorFees.find(
        (f: { assetCode: string }) => f.assetCode === 'ETH'
      );
      // ETH appears as a configured token on town-01 but has no incoming
      // volume — fee row must be omitted, not zero.
      expect(ethFee).toBeUndefined();
    });
  });

  // ---------- AC 5: recentClaims ring ----------

  describe('AC 5: recentClaims ring buffer', () => {
    it('returns claims ordered newest first', async () => {
      const res = await request(app).get('/admin/earnings.json').expect(200);

      expect(res.body.recentClaims.length).toBe(3);
      const ats = res.body.recentClaims.map((c: { at: string }) => new Date(c.at).getTime());
      for (let i = 0; i < ats.length - 1; i++) {
        expect(ats[i]).toBeGreaterThanOrEqual(ats[i + 1]);
      }
    });

    it('caps at 50 rows even when more exist', async () => {
      // Seed 60 additional claims across distinct channels so each has a
      // computable delta without cumulative-rollback complications.
      for (let i = 0; i < 60; i++) {
        insertClaim({
          messageId: `bulk-${i}`,
          peerId: 'town-01',
          channelId: `0xbulk-${i}`,
          tokenAddress: '0xUSDC',
          transferredAmount: '10000',
          receivedAt: 1_700_001_000_000 + i,
          nonce: 1,
        });
      }

      const res = await request(app).get('/admin/earnings.json').expect(200);
      expect(res.body.recentClaims.length).toBe(50);
    });

    it('amount field is the per-claim delta, not the cumulative value', async () => {
      const res = await request(app).get('/admin/earnings.json').expect(200);

      // town-01's two claims on channel 0xchan-town-usdc: cumulative 100_000,
      // then 250_000. Deltas: first (newest) should be 250_000 - 100_000 = 150_000;
      // second (oldest) should be 100_000 (no prior claim on that channel).
      const townClaims = res.body.recentClaims.filter(
        (c: { peerId: string; assetCode: string }) =>
          c.peerId === 'town-01' && c.assetCode === 'USDC'
      );
      // 2 rows for that channel
      expect(townClaims.length).toBe(2);
      expect(townClaims[0].amount).toBe('150000'); // newest first
      expect(townClaims[1].amount).toBe('100000');
    });

    it('each entry carries peerId, assetCode, assetScale, amount, direction, at', async () => {
      const res = await request(app).get('/admin/earnings.json').expect(200);
      for (const c of res.body.recentClaims) {
        expect(c).toEqual(
          expect.objectContaining({
            peerId: expect.any(String),
            assetCode: expect.any(String),
            assetScale: expect.any(Number),
            amount: expect.any(String),
            direction: expect.stringMatching(/^(inbound|outbound)$/),
            at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          })
        );
      }
    });
  });

  // ---------- AC 6: 503 when subsystems unavailable ----------

  describe('AC 6: graceful degradation', () => {
    it('returns 503 when accountManager is not wired', async () => {
      const app503 = await createApp({ accountManager: undefined });
      const res = await request(app503).get('/admin/earnings.json').expect(503);
      expect(res.body.error).toBe('Service Unavailable');
      expect(res.body.message).toMatch(/earnings subsystem not enabled/i);
    });

    it('returns 503 when claimReceiver is not wired', async () => {
      const app503 = await createApp({ claimReceiver: undefined });
      const res = await request(app503).get('/admin/earnings.json').expect(503);
      expect(res.body.error).toBe('Service Unavailable');
    });
  });

  // ---------- AC 7: latency budget ----------

  describe('AC 7: endpoint responds within the dashboard poll budget', () => {
    it('completes well under 200ms for the seeded fixture', async () => {
      const start = Date.now();
      await request(app).get('/admin/earnings.json').expect(200);
      const elapsed = Date.now() - start;
      // AC 7 target: p95 < 200ms on 10 peers × 4 assets × 10k claims. Our fixture
      // is much smaller but we still assert a generous headroom budget to catch
      // regressions that introduce synchronous RPC calls or N+1 queries.
      expect(elapsed).toBeLessThan(500);
    });
  });

  // ---------- AC 8: Cache-Control: no-store ----------

  describe('AC 8: Cache-Control: no-store', () => {
    it('includes Cache-Control: no-store on successful responses', async () => {
      const res = await request(app).get('/admin/earnings.json').expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  // ---------- Authoritative peer-set (mirrors 37.3 D1) ----------

  describe('peer set is authoritative via btpClientManager.getPeerIds()', () => {
    it('omits peers that exist only in settlementPeers config but not in getPeerIds()', async () => {
      // Add a config-only stale peer but DO NOT expose it from getPeerIds()
      settlementPeers.set('stale-peer', {
        peerId: 'stale-peer',
        address: 'g.stale-peer',
        settlementPreference: 'evm',
        settlementTokens: ['0xUSDC'],
        tokenAddress: '0xUSDC',
      });

      const res = await request(app).get('/admin/earnings.json').expect(200);
      const stale = res.body.peers.find((p: { peerId: string }) => p.peerId === 'stale-peer');
      expect(stale).toBeUndefined();
    });
  });

  // ---------- Story 37.8: Solana + Mina token metadata integration ----------

  describe('Story 37.8: Solana and Mina token metadata via earnings endpoint', () => {
    it('resolves Solana SPL mint decimals through the metadata resolver (T-37.8-16)', async () => {
      // Wire a Solana peer with a USDC-like SPL mint
      settlementPeers.set('sol-01', {
        peerId: 'sol-01',
        address: 'g.sol-01',
        settlementPreference: 'solana',
        settlementTokens: ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
        tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      });
      mockBTPClientManager.getPeerIds.mockReturnValue(['town-01', 'mill-01', 'dvm-01', 'sol-01']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(
        new Map([
          ['town-01', true],
          ['mill-01', true],
          ['dvm-01', false],
          ['sol-01', true],
        ])
      );

      insertClaim({
        messageId: 'msg-sol-1',
        peerId: 'sol-01',
        channelId: 'chan-sol-usdc',
        tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        transferredAmount: '500000',
        receivedAt: 1_700_000_180_000,
        nonce: 1,
        blockchain: 'solana',
      });

      const localApp = await createApp();
      const res = await request(localApp).get('/admin/earnings.json').expect(200);

      const solPeer = res.body.peers.find((p: { peerId: string }) => p.peerId === 'sol-01');
      expect(solPeer).toBeDefined();
      expect(solPeer.byAsset).toHaveLength(1);
      expect(solPeer.byAsset[0].assetCode).toBe('USDC-S');
      expect(solPeer.byAsset[0].assetScale).toBe(6);
      expect(solPeer.byAsset[0].claimsReceivedTotal).toBe('500000');
    });

    it('resolves Mina tokenId with native scale=9 fallback (T-37.8-17)', async () => {
      const tokenId = 'wUPsSR5SSUHHBQSEsB4Bxhb3G3iC1xrs1Csq3QL2S9qtJ1Yp7yYr';
      settlementPeers.set('mina-01', {
        peerId: 'mina-01',
        address: 'g.mina-01',
        settlementPreference: 'mina',
        settlementTokens: [tokenId],
        tokenAddress: tokenId,
      });
      mockBTPClientManager.getPeerIds.mockReturnValue(['town-01', 'mill-01', 'dvm-01', 'mina-01']);
      mockBTPClientManager.getPeerStatus.mockReturnValue(
        new Map([
          ['town-01', true],
          ['mill-01', true],
          ['dvm-01', false],
          ['mina-01', true],
        ])
      );

      insertClaim({
        messageId: 'msg-mina-1',
        peerId: 'mina-01',
        channelId: 'B62qoG5bKBYCxaVcBN3kPFmqJkLm9K6mZh5v8VBSu4kJqBx4VBfRvE',
        tokenAddress: tokenId,
        transferredAmount: '0',
        receivedAt: 1_700_000_240_000,
        nonce: 1,
        blockchain: 'mina',
      });

      const localApp = await createApp();
      const res = await request(localApp).get('/admin/earnings.json').expect(200);

      const minaPeer = res.body.peers.find((p: { peerId: string }) => p.peerId === 'mina-01');
      expect(minaPeer).toBeDefined();
      expect(minaPeer.byAsset).toHaveLength(1);
      expect(minaPeer.byAsset[0].assetCode).toBe(tokenId);
      expect(minaPeer.byAsset[0].assetScale).toBe(9);
      // Mina claims report 0n cumulative because amount is commitment-based
      expect(minaPeer.byAsset[0].claimsReceivedTotal).toBe('0');
    });

    it('mixed-chain peer list shows correct assetScale per blockchain family (T-37.8-18)', async () => {
      // All three chains present simultaneously
      settlementPeers.set('sol-01', {
        peerId: 'sol-01',
        address: 'g.sol-01',
        settlementPreference: 'solana',
        settlementTokens: ['So11111111111111111111111111111111111111112'],
        tokenAddress: 'So11111111111111111111111111111111111111112',
      });
      settlementPeers.set('mina-01', {
        peerId: 'mina-01',
        address: 'g.mina-01',
        settlementPreference: 'mina',
        settlementTokens: ['wUPsSR5SSUHHBQSEsB4Bxhb3G3iC1xrs1Csq3QL2S9qtJ1Yp7yYr'],
        tokenAddress: 'wUPsSR5SSUHHBQSEsB4Bxhb3G3iC1xrs1Csq3QL2S9qtJ1Yp7yYr',
      });
      mockBTPClientManager.getPeerIds.mockReturnValue([
        'town-01',
        'mill-01',
        'dvm-01',
        'sol-01',
        'mina-01',
      ]);
      mockBTPClientManager.getPeerStatus.mockReturnValue(
        new Map([
          ['town-01', true],
          ['mill-01', true],
          ['dvm-01', false],
          ['sol-01', true],
          ['mina-01', true],
        ])
      );

      insertClaim({
        messageId: 'msg-sol-1',
        peerId: 'sol-01',
        channelId: 'chan-sol',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        transferredAmount: '1000000000',
        receivedAt: 1_700_000_300_000,
        nonce: 1,
        blockchain: 'solana',
      });
      insertClaim({
        messageId: 'msg-mina-1',
        peerId: 'mina-01',
        channelId: 'B62qoG5bKBYCxaVcBN3kPFmqJkLm9K6mZh5v8VBSu4kJqBx4VBfRvE',
        tokenAddress: 'wUPsSR5SSUHHBQSEsB4Bxhb3G3iC1xrs1Csq3QL2S9qtJ1Yp7yYr',
        transferredAmount: '0',
        receivedAt: 1_700_000_300_000,
        nonce: 1,
        blockchain: 'mina',
      });

      const localApp = await createApp();
      const res = await request(localApp).get('/admin/earnings.json').expect(200);

      const solPeer = res.body.peers.find((p: { peerId: string }) => p.peerId === 'sol-01');
      const minaPeer = res.body.peers.find((p: { peerId: string }) => p.peerId === 'mina-01');
      const evmPeer = res.body.peers.find((p: { peerId: string }) => p.peerId === 'town-01');

      expect(solPeer.byAsset[0].assetScale).toBe(9);
      expect(solPeer.byAsset[0].assetCode).toBe('SOL');
      expect(minaPeer.byAsset[0].assetScale).toBe(9);
      expect(
        evmPeer.byAsset.find((a: { assetCode: string }) => a.assetCode === 'USDC').assetScale
      ).toBe(6);
    });
  });
});
