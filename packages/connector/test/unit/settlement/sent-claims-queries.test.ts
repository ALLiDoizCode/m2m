import { SentClaimsQueries } from '../../../src/settlement/sent-claims-queries';
import type { Database } from 'better-sqlite3';

const mockLogger = {
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  child: jest.fn().mockReturnThis(),
};

describe('SentClaimsQueries', () => {
  let mockDb: jest.Mocked<Database>;
  let queries: SentClaimsQueries;

  beforeEach(() => {
    mockDb = {
      prepare: jest.fn(),
    } as unknown as jest.Mocked<Database>;
    queries = new SentClaimsQueries(mockDb, mockLogger as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getCumulativeOutboundByAsset', () => {
    it('should return empty map when no rows found', async () => {
      const mockStmt = { all: jest.fn().mockReturnValue([]) };
      mockDb.prepare.mockReturnValue(mockStmt as any);

      const result = await queries.getCumulativeOutboundByAsset('peer1');
      expect(result.size).toBe(0);
    });

    it('should aggregate EVM claims by asset', async () => {
      const mockStmt = {
        all: jest.fn().mockReturnValue([
          {
            blockchain: 'evm',
            claim_data: JSON.stringify({
              channelId: 'ch1',
              tokenAddress: '0xToken',
              transferredAmount: '1000',
              nonce: 5,
              blockchain: 'evm',
            }),
            sent_at: 1000,
          },
          {
            blockchain: 'evm',
            claim_data: JSON.stringify({
              channelId: 'ch2',
              tokenAddress: '0xToken',
              transferredAmount: '2000',
              nonce: 3,
              blockchain: 'evm',
            }),
            sent_at: 2000,
          },
        ]),
      };
      mockDb.prepare.mockReturnValue(mockStmt as any);

      const result = await queries.getCumulativeOutboundByAsset('peer1');
      expect(result.size).toBe(1);
      const bucket = result.get('evm:0xToken');
      expect(bucket).toBeDefined();
      expect(bucket!.total).toBe(BigInt(3000));
      expect(bucket!.lastAt).toBe(2000);
    });

    it('should take highest nonce per channel', async () => {
      const mockStmt = {
        all: jest.fn().mockReturnValue([
          {
            blockchain: 'evm',
            claim_data: JSON.stringify({
              channelId: 'ch1',
              tokenAddress: '0xToken',
              transferredAmount: '1000',
              nonce: 1,
              blockchain: 'evm',
            }),
            sent_at: 1000,
          },
          {
            blockchain: 'evm',
            claim_data: JSON.stringify({
              channelId: 'ch1',
              tokenAddress: '0xToken',
              transferredAmount: '5000',
              nonce: 5,
              blockchain: 'evm',
            }),
            sent_at: 2000,
          },
        ]),
      };
      mockDb.prepare.mockReturnValue(mockStmt as any);

      const result = await queries.getCumulativeOutboundByAsset('peer1');
      const bucket = result.get('evm:0xToken');
      expect(bucket!.total).toBe(BigInt(5000));
    });

    it('should handle Solana claims', async () => {
      const mockStmt = {
        all: jest.fn().mockReturnValue([
          {
            blockchain: 'solana',
            claim_data: JSON.stringify({
              channelAccount: 'solCh1',
              programId: 'prog1',
              transferredAmount: '1500',
              nonce: 2,
              blockchain: 'solana',
            }),
            sent_at: 1500,
          },
        ]),
      };
      mockDb.prepare.mockReturnValue(mockStmt as any);

      const result = await queries.getCumulativeOutboundByAsset('peer1');
      const bucket = result.get('solana:prog1');
      expect(bucket).toBeDefined();
      expect(bucket!.total).toBe(BigInt(1500));
    });

    it('should handle Mina claims with zero amount', async () => {
      const mockStmt = {
        all: jest.fn().mockReturnValue([
          {
            blockchain: 'mina',
            claim_data: JSON.stringify({
              zkAppAddress: 'minaCh1',
              tokenId: 'minaToken',
              nonce: 1,
              blockchain: 'mina',
            }),
            sent_at: 3000,
          },
        ]),
      };
      mockDb.prepare.mockReturnValue(mockStmt as any);

      const result = await queries.getCumulativeOutboundByAsset('peer1');
      const bucket = result.get('mina:minaToken');
      expect(bucket).toBeDefined();
      expect(bucket!.total).toBe(BigInt(0));
    });

    it('should skip invalid JSON claim_data', async () => {
      const mockStmt = {
        all: jest.fn().mockReturnValue([
          {
            blockchain: 'evm',
            claim_data: 'not-json',
            sent_at: 1000,
          },
        ]),
      };
      mockDb.prepare.mockReturnValue(mockStmt as any);

      const result = await queries.getCumulativeOutboundByAsset('peer1');
      expect(result.size).toBe(0);
    });

    it('should skip claims with missing tokenAddress or channelId', async () => {
      const mockStmt = {
        all: jest.fn().mockReturnValue([
          {
            blockchain: 'evm',
            claim_data: JSON.stringify({
              channelId: '',
              tokenAddress: '0xToken',
              transferredAmount: '1000',
              nonce: 1,
              blockchain: 'evm',
            }),
            sent_at: 1000,
          },
          {
            blockchain: 'evm',
            claim_data: JSON.stringify({
              channelId: 'ch1',
              tokenAddress: '',
              transferredAmount: '1000',
              nonce: 1,
              blockchain: 'evm',
            }),
            sent_at: 1000,
          },
        ]),
      };
      mockDb.prepare.mockReturnValue(mockStmt as any);

      const result = await queries.getCumulativeOutboundByAsset('peer1');
      expect(result.size).toBe(0);
    });

    it('should handle BigInt parse error gracefully', async () => {
      const mockStmt = {
        all: jest.fn().mockReturnValue([
          {
            blockchain: 'evm',
            claim_data: JSON.stringify({
              channelId: 'ch1',
              tokenAddress: '0xToken',
              transferredAmount: 'not-a-number',
              nonce: 1,
              blockchain: 'evm',
            }),
            sent_at: 1000,
          },
        ]),
      };
      mockDb.prepare.mockReturnValue(mockStmt as any);

      const result = await queries.getCumulativeOutboundByAsset('peer1');
      // BigInt error should set amount to 0n, but tokenAddress is valid so it should still create entry
      expect(result.size).toBe(1);
      const bucket = result.get('evm:0xToken');
      expect(bucket!.total).toBe(BigInt(0));
    });

    it('should handle unknown claim type by skipping', async () => {
      const mockStmt = {
        all: jest.fn().mockReturnValue([
          {
            blockchain: 'evm',
            claim_data: JSON.stringify({
              someUnknownField: 'value',
              blockchain: 'evm',
            }),
            sent_at: 1000,
          },
        ]),
      };
      mockDb.prepare.mockReturnValue(mockStmt as any);

      const result = await queries.getCumulativeOutboundByAsset('peer1');
      expect(result.size).toBe(0);
    });

    it('should handle database errors gracefully', async () => {
      mockDb.prepare.mockImplementation(() => {
        throw new Error('DB error');
      });

      const result = await queries.getCumulativeOutboundByAsset('peer1');
      expect(result.size).toBe(0);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should use default values when optional fields missing', async () => {
      const mockStmt = {
        all: jest.fn().mockReturnValue([
          {
            blockchain: 'evm',
            claim_data: JSON.stringify({
              channelId: 'ch1',
              tokenAddress: '0xToken',
              // transferredAmount missing
              // nonce missing
              blockchain: 'evm',
            }),
            sent_at: 1000,
          },
        ]),
      };
      mockDb.prepare.mockReturnValue(mockStmt as any);

      const result = await queries.getCumulativeOutboundByAsset('peer1');
      const bucket = result.get('evm:0xToken');
      expect(bucket).toBeDefined();
      expect(bucket!.total).toBe(BigInt(0));
    });
  });

  describe('getRecentSentClaims', () => {
    it('should return empty array when no claims', async () => {
      const mockStmt = { all: jest.fn().mockReturnValue([]) };
      mockDb.prepare.mockReturnValue(mockStmt as any);

      const result = await queries.getRecentSentClaims(10);
      expect(result).toEqual([]);
    });

    it('should return mapped claims for all types', async () => {
      const mockStmt = {
        all: jest.fn().mockReturnValue([
          {
            message_id: 'msg1',
            peer_id: 'peer1',
            blockchain: 'evm',
            claim_data: JSON.stringify({ channelId: 'ch1', blockchain: 'evm' }),
            sent_at: 1000,
          },
          {
            message_id: 'msg2',
            peer_id: 'peer2',
            blockchain: 'solana',
            claim_data: JSON.stringify({ channelAccount: 'sol1', blockchain: 'solana' }),
            sent_at: 2000,
          },
          {
            message_id: 'msg3',
            peer_id: 'peer3',
            blockchain: 'mina',
            claim_data: JSON.stringify({ zkAppAddress: 'mina1', blockchain: 'mina' }),
            sent_at: 3000,
          },
        ]),
      };
      mockDb.prepare.mockReturnValue(mockStmt as any);

      const result = await queries.getRecentSentClaims(50);
      expect(result).toHaveLength(3);
      expect(result[0]!.channelId).toBe('ch1');
      expect(result[1]!.channelId).toBe('sol1');
      expect(result[2]!.channelId).toBe('mina1');
    });

    it('should use default limit of 50', async () => {
      const mockStmt = { all: jest.fn().mockReturnValue([]) };
      mockDb.prepare.mockReturnValue(mockStmt as any);

      await queries.getRecentSentClaims();
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('LIMIT ?'));
      expect(mockStmt.all).toHaveBeenCalledWith(50);
    });

    it('should handle database error gracefully', async () => {
      mockDb.prepare.mockImplementation(() => {
        throw new Error('DB error');
      });

      const result = await queries.getRecentSentClaims(10);
      expect(result).toEqual([]);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});
