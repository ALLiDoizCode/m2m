/**
 * Unit tests for PaymentChannelManager
 *
 * File: packages/connector/src/settlement/xrp-channel-manager.test.ts
 */
import { PaymentChannelManager } from './xrp-channel-manager';
import { XRPLClient } from './xrpl-client';
import { ClaimSigner } from './xrp-claim-signer';
import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';

// Mock dependencies
jest.mock('./xrpl-client');
jest.mock('./xrp-claim-signer');

describe('PaymentChannelManager', () => {
  let manager: PaymentChannelManager;
  let mockXRPLClient: jest.Mocked<XRPLClient>;
  let mockDatabase: jest.Mocked<Database>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create fresh mock instances
    mockXRPLClient = {
      submitAndWait: jest.fn(),
      getLedgerEntry: jest.fn(),
      wallet: {
        address: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
      },
    } as unknown as jest.Mocked<XRPLClient>;

    mockDatabase = {
      prepare: jest.fn().mockReturnValue({
        run: jest.fn(),
        all: jest.fn().mockReturnValue([]),
      }),
    } as unknown as jest.Mocked<Database>;

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    } as unknown as jest.Mocked<Logger>;

    // Mock ClaimSigner constructor
    (ClaimSigner as jest.MockedClass<typeof ClaimSigner>).mockImplementation(
      () =>
        ({
          getPublicKey: jest
            .fn()
            .mockReturnValue('ED1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB'),
          signClaim: jest.fn(),
          verifyClaim: jest.fn(),
        }) as unknown as ClaimSigner
    );

    manager = new PaymentChannelManager(mockXRPLClient, mockDatabase, mockLogger);
  });

  describe('createChannel()', () => {
    it('should create payment channel successfully', async () => {
      const destination = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
      const amount = '1000000000'; // 1,000 XRP
      const settleDelay = 86400; // 24 hours

      mockXRPLClient.submitAndWait.mockResolvedValueOnce({
        hash: '0xABC123',
        ledgerIndex: 12345,
        result: {},
      });

      mockXRPLClient.getLedgerEntry.mockResolvedValueOnce({
        Account: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
        Destination: destination,
        Amount: amount,
        Balance: '0',
        SettleDelay: settleDelay,
        PublicKey: 'ED1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const channelId = await manager.createChannel(destination, amount, settleDelay);

      expect(channelId).toBe('0xABC123');
      expect(mockXRPLClient.submitAndWait).toHaveBeenCalledWith(
        expect.objectContaining({
          TransactionType: 'PaymentChannelCreate',
          Destination: destination,
          Amount: amount,
          SettleDelay: settleDelay,
        })
      );
    });

    it('should throw error for invalid destination address', async () => {
      await expect(manager.createChannel('invalid', '1000000000', 86400)).rejects.toThrow(
        'Invalid destination address format'
      );
    });

    it('should throw error for zero amount', async () => {
      await expect(
        manager.createChannel('rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY', '0', 86400)
      ).rejects.toThrow('Amount must be positive');
    });

    it('should throw error for negative amount', async () => {
      await expect(
        manager.createChannel('rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY', '-1000000', 86400)
      ).rejects.toThrow('Amount must be positive');
    });

    it('should warn for settle delay below 1 hour', async () => {
      const destination = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';

      mockXRPLClient.submitAndWait.mockResolvedValueOnce({
        hash: '0xABC123',
        ledgerIndex: 12345,
        result: {},
      });

      mockXRPLClient.getLedgerEntry.mockResolvedValueOnce({
        Account: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
        Destination: destination,
        Amount: '1000000000',
        Balance: '0',
        SettleDelay: 1800,
        PublicKey: 'ED1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await manager.createChannel(destination, '1000000000', 1800); // 30 minutes

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ settleDelay: 1800 }),
        expect.stringContaining('not recommended for production')
      );
    });

    it('should store channel metadata in database', async () => {
      const destination = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
      const amount = '1000000000';
      const settleDelay = 86400;

      const mockPrepare = jest.fn().mockReturnValue({
        run: jest.fn(),
      });
      mockDatabase.prepare = mockPrepare;

      mockXRPLClient.submitAndWait.mockResolvedValueOnce({
        hash: '0xABC123',
        ledgerIndex: 12345,
        result: {},
      });

      mockXRPLClient.getLedgerEntry.mockResolvedValueOnce({
        Account: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
        Destination: destination,
        Amount: amount,
        Balance: '0',
        SettleDelay: settleDelay,
        PublicKey: 'ED1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await manager.createChannel(destination, amount, settleDelay);

      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO xrp_channels'));
    });
  });

  describe('fundChannel()', () => {
    it('should fund existing channel successfully', async () => {
      const channelId = '0xABC123';
      const additionalAmount = '500000000'; // 500 XRP

      mockXRPLClient.getLedgerEntry.mockResolvedValueOnce({
        Account: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
        Destination: 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY',
        Amount: '1000000000',
        Balance: '0',
        SettleDelay: 86400,
        PublicKey: 'ED1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      mockXRPLClient.submitAndWait.mockResolvedValueOnce({
        hash: '0xDEF456',
        ledgerIndex: 12346,
        result: {},
      });

      await manager.fundChannel(channelId, additionalAmount);

      expect(mockXRPLClient.submitAndWait).toHaveBeenCalledWith(
        expect.objectContaining({
          TransactionType: 'PaymentChannelFund',
          Channel: channelId,
          Amount: additionalAmount,
        })
      );
    });

    it('should throw error when funding closed channel', async () => {
      const channelId = '0xABC123';

      mockXRPLClient.getLedgerEntry.mockResolvedValueOnce({
        Account: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
        Destination: 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY',
        Amount: '1000000000',
        Balance: '1000000000',
        SettleDelay: 86400,
        PublicKey: 'ED1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB',
        Expiration: Math.floor(Date.now() / 1000) - 90000, // Expired
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await expect(manager.fundChannel(channelId, '500000000')).rejects.toThrow(
        'Cannot fund channel in status:'
      );
    });

    it('should update database with new amount', async () => {
      const channelId = '0xABC123';
      const additionalAmount = '500000000';

      const mockPrepare = jest.fn().mockReturnValue({
        run: jest.fn(),
      });
      mockDatabase.prepare = mockPrepare;

      mockXRPLClient.getLedgerEntry.mockResolvedValueOnce({
        Account: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
        Destination: 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY',
        Amount: '1000000000',
        Balance: '0',
        SettleDelay: 86400,
        PublicKey: 'ED1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      mockXRPLClient.submitAndWait.mockResolvedValueOnce({
        hash: '0xDEF456',
        ledgerIndex: 12346,
        result: {},
      });

      await manager.fundChannel(channelId, additionalAmount);

      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE xrp_channels SET amount')
      );
    });
  });

  describe('getChannelState()', () => {
    it('should return channel state from ledger', async () => {
      const channelId = '0xABC123';

      mockXRPLClient.getLedgerEntry.mockResolvedValueOnce({
        Account: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
        Destination: 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY',
        Amount: '1000000000',
        Balance: '250000000',
        SettleDelay: 86400,
        PublicKey: 'ED1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const state = await manager.getChannelState(channelId);

      expect(state).toMatchObject({
        channelId: '0xABC123',
        account: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
        destination: 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY',
        amount: '1000000000',
        balance: '250000000',
        settleDelay: 86400,
        status: 'open',
      });
    });

    it('should handle missing Balance field', async () => {
      const channelId = '0xABC123';

      mockXRPLClient.getLedgerEntry.mockResolvedValueOnce({
        Account: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
        Destination: 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY',
        Amount: '1000000000',
        SettleDelay: 86400,
        PublicKey: 'ED1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const state = await manager.getChannelState(channelId);

      expect(state.balance).toBe('0');
    });

    it('should handle error when channel does not exist', async () => {
      const error = new Error('Channel not found on ledger');

      // Mock getLedgerEntry to reject with error
      mockXRPLClient.getLedgerEntry.mockRejectedValue(error);

      await expect(manager.getChannelState('0xINVALID')).rejects.toThrow();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should determine status as closing when expiration is set but not expired', async () => {
      const channelId = '0xABC123';
      const rippleEpoch = 946684800;
      const futureExpiration = Math.floor(Date.now() / 1000) - rippleEpoch + 3600; // 1 hour from now

      mockXRPLClient.getLedgerEntry.mockResolvedValueOnce({
        Account: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
        Destination: 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY',
        Amount: '1000000000',
        Balance: '0',
        SettleDelay: 3600,
        PublicKey: 'ED1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB',
        Expiration: futureExpiration,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const state = await manager.getChannelState(channelId);

      expect(state.status).toBe('closing');
    });

    it('should determine status as closed when expiration has passed', async () => {
      const channelId = '0xABC123';
      const rippleEpoch = 946684800;
      const pastExpiration = Math.floor(Date.now() / 1000) - rippleEpoch - 86400; // 1 day ago

      mockXRPLClient.getLedgerEntry.mockResolvedValueOnce({
        Account: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
        Destination: 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY',
        Amount: '1000000000',
        Balance: '1000000000',
        SettleDelay: 3600,
        PublicKey: 'ED1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB',
        Expiration: pastExpiration,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const state = await manager.getChannelState(channelId);

      expect(state.status).toBe('closed');
    });
  });

  describe('getChannelsForPeer()', () => {
    it('should return all channels for peer address', async () => {
      const peerAddress = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';

      mockDatabase.prepare = jest.fn().mockReturnValue({
        all: jest.fn().mockReturnValue([{ channel_id: '0xABC123' }, { channel_id: '0xDEF456' }]),
      });

      const channels = await manager.getChannelsForPeer(peerAddress);

      expect(channels).toEqual(['0xABC123', '0xDEF456']);
    });

    it('should return empty array when no channels exist for peer', async () => {
      mockDatabase.prepare = jest.fn().mockReturnValue({
        all: jest.fn().mockReturnValue([]),
      });

      const channels = await manager.getChannelsForPeer('rUNKNOWN7kfTD9w2To4CQk6UCfuHM9c6GDY');

      expect(channels).toEqual([]);
    });
  });
});
