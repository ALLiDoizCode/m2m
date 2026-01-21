/**
 * XRP Channel SDK Unit Tests
 *
 * Tests XRPChannelSDK using mocked dependencies (XRPLClient, PaymentChannelManager, ClaimSigner).
 * Covers all public methods and error handling scenarios.
 *
 * @module settlement/xrp-channel-sdk.test
 */

import type { Logger } from 'pino';
import { XRPChannelSDK } from './xrp-channel-sdk';
import type { PaymentChannelManager } from './xrp-channel-manager';
import type { XRPClaim } from './types';
import type { IXRPLClient } from './xrpl-client';

describe('XRPChannelSDK', () => {
  let sdk: XRPChannelSDK;
  let mockXRPLClient: jest.Mocked<Pick<IXRPLClient, 'address' | 'request' | 'submitAndWait'>>;
  let mockChannelManager: jest.Mocked<PaymentChannelManager>;
  let mockClaimSigner: {
    signClaim: jest.Mock;
    getPublicKey: jest.Mock;
    verifyClaim: jest.Mock;
  };
  let mockLogger: jest.Mocked<Pick<Logger, 'info' | 'error' | 'warn' | 'debug' | 'child'>>;

  beforeEach(() => {
    // Create fresh mock instances (Anti-Pattern 3 solution)
    mockXRPLClient = {
      address: 'rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW',
      request: jest.fn(),
      submitAndWait: jest.fn(),
    };

    mockChannelManager = {
      createChannel: jest.fn().mockResolvedValue('A'.repeat(64)),
      fundChannel: jest.fn().mockResolvedValue(undefined),
      submitClaim: jest.fn().mockResolvedValue({}),
      closeChannel: jest.fn().mockResolvedValue({}),
      getChannelState: jest.fn(),
      getChannelsForPeer: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<PaymentChannelManager>;

    mockClaimSigner = {
      signClaim: jest.fn().mockResolvedValue('B'.repeat(128)),
      getPublicKey: jest.fn().mockReturnValue('ED' + 'C'.repeat(64)),
      verifyClaim: jest.fn().mockResolvedValue(true),
    };

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
    };

    sdk = new XRPChannelSDK(mockXRPLClient, mockChannelManager, mockClaimSigner, mockLogger);
  });

  afterEach(() => {
    // Ensure cleanup (Anti-Pattern 5 solution)
    sdk.stopAutoRefresh();
  });

  describe('openChannel', () => {
    it('should create channel and cache state', async () => {
      const destination = 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN';
      const amount = '1000000000'; // 1000 XRP
      const settleDelay = 86400; // 24 hours
      const channelId = 'A'.repeat(64);

      // Mock ledger entry response
      mockXRPLClient.request.mockResolvedValue({
        result: {
          node: {
            ChannelID: channelId,
            Account: mockXRPLClient.address,
            Destination: destination,
            Amount: amount,
            Balance: '0',
            SettleDelay: settleDelay,
            PublicKey: mockClaimSigner.getPublicKey(),
          },
        },
      });

      const result = await sdk.openChannel(destination, amount, settleDelay);

      expect(result).toBe(channelId);
      expect(mockChannelManager.createChannel).toHaveBeenCalledWith(
        destination,
        amount,
        settleDelay
      );
      expect(mockXRPLClient.request).toHaveBeenCalledWith({
        command: 'ledger_entry',
        payment_channel: channelId,
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        { destination, amount, settleDelay },
        'Opening XRP payment channel...'
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        { channelId },
        'XRP payment channel opened successfully'
      );
    }, 50);

    it('should propagate errors from channel manager', async () => {
      const destination = 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN';
      const amount = '1000000000';
      const settleDelay = 86400;

      mockChannelManager.createChannel.mockRejectedValue(new Error('Insufficient funds'));

      await expect(sdk.openChannel(destination, amount, settleDelay)).rejects.toThrow(
        'Insufficient funds'
      );
    }, 50);
  });

  describe('fundChannel', () => {
    it('should submit PaymentChannelFund transaction', async () => {
      const channelId = 'A'.repeat(64);
      const additionalAmount = '5000000000'; // 5000 XRP

      mockXRPLClient.submitAndWait.mockResolvedValue({});
      mockXRPLClient.request.mockResolvedValue({
        result: {
          node: {
            ChannelID: channelId,
            Account: mockXRPLClient.address,
            Destination: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
            Amount: '15000000000', // Increased
            Balance: '0',
            SettleDelay: 86400,
            PublicKey: mockClaimSigner.getPublicKey(),
          },
        },
      });

      await sdk.fundChannel(channelId, additionalAmount);

      expect(mockXRPLClient.submitAndWait).toHaveBeenCalledWith({
        TransactionType: 'PaymentChannelFund',
        Account: mockXRPLClient.address,
        Channel: channelId,
        Amount: additionalAmount,
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        { channelId, additionalAmount },
        'Funding XRP payment channel...'
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        { channelId, additionalAmount },
        'XRP payment channel funded successfully'
      );
    }, 50);

    it('should refresh channel state after funding', async () => {
      const channelId = 'A'.repeat(64);
      const additionalAmount = '5000000000';

      mockXRPLClient.submitAndWait.mockResolvedValue({});
      mockXRPLClient.request.mockResolvedValue({
        result: {
          node: {
            ChannelID: channelId,
            Account: mockXRPLClient.address,
            Destination: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
            Amount: '15000000000',
            Balance: '0',
            SettleDelay: 86400,
            PublicKey: mockClaimSigner.getPublicKey(),
          },
        },
      });

      await sdk.fundChannel(channelId, additionalAmount);

      expect(mockXRPLClient.request).toHaveBeenCalledWith({
        command: 'ledger_entry',
        payment_channel: channelId,
      });
    }, 50);
  });

  describe('signClaim', () => {
    it('should sign claim and return XRPClaim object', async () => {
      const channelId = 'A'.repeat(64);
      const amount = '5000000000'; // 5000 XRP

      const claim = await sdk.signClaim(channelId, amount);

      expect(claim).toEqual({
        channelId,
        amount,
        signature: 'B'.repeat(128),
        publicKey: 'ED' + 'C'.repeat(64),
      });
      expect(mockClaimSigner.signClaim).toHaveBeenCalledWith(channelId, amount);
      expect(mockClaimSigner.getPublicKey).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        { channelId, amount },
        'Signing XRP payment channel claim...'
      );
    }, 50);
  });

  describe('verifyClaim', () => {
    it('should verify valid claim', async () => {
      const claim: XRPClaim = {
        channelId: 'A'.repeat(64),
        amount: '5000000000',
        signature: 'B'.repeat(128),
        publicKey: 'ED' + 'C'.repeat(64),
      };

      const result = await sdk.verifyClaim(claim);

      expect(result).toBe(true);
      expect(mockClaimSigner.verifyClaim).toHaveBeenCalledWith(
        claim.channelId,
        claim.amount,
        claim.signature,
        claim.publicKey
      );
    }, 50);

    it('should verify invalid claim', async () => {
      const claim: XRPClaim = {
        channelId: 'A'.repeat(64),
        amount: '5000000000',
        signature: 'INVALID',
        publicKey: 'ED' + 'C'.repeat(64),
      };

      mockClaimSigner.verifyClaim.mockResolvedValue(false);

      const result = await sdk.verifyClaim(claim);

      expect(result).toBe(false);
    }, 50);
  });

  describe('submitClaim', () => {
    it('should submit claim to ledger and refresh state', async () => {
      const claim: XRPClaim = {
        channelId: 'A'.repeat(64),
        amount: '5000000000',
        signature: 'B'.repeat(128),
        publicKey: 'ED' + 'C'.repeat(64),
      };

      // Mock ledger entry response for refresh
      mockXRPLClient.request.mockResolvedValue({
        result: {
          node: {
            ChannelID: claim.channelId,
            Account: mockXRPLClient.address,
            Destination: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
            Amount: '10000000000',
            Balance: claim.amount, // Balance updated
            SettleDelay: 86400,
            PublicKey: claim.publicKey,
          },
        },
      });

      await sdk.submitClaim(claim);

      expect(mockClaimSigner.verifyClaim).toHaveBeenCalledWith(
        claim.channelId,
        claim.amount,
        claim.signature,
        claim.publicKey
      );
      expect(mockChannelManager.submitClaim).toHaveBeenCalledWith(
        claim.channelId,
        claim.amount,
        claim.signature,
        claim.publicKey
      );
      expect(mockXRPLClient.request).toHaveBeenCalledWith({
        command: 'ledger_entry',
        payment_channel: claim.channelId,
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        { claim },
        'Submitting XRP payment channel claim...'
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        { channelId: claim.channelId },
        'XRP claim submitted successfully'
      );
    }, 50);

    it('should throw error for invalid claim signature', async () => {
      const claim: XRPClaim = {
        channelId: 'A'.repeat(64),
        amount: '5000000000',
        signature: 'INVALID',
        publicKey: 'ED' + 'C'.repeat(64),
      };

      mockClaimSigner.verifyClaim.mockResolvedValue(false);

      await expect(sdk.submitClaim(claim)).rejects.toThrow(
        `Invalid claim signature for channel ${claim.channelId}`
      );
      expect(mockChannelManager.submitClaim).not.toHaveBeenCalled();
    }, 50);
  });

  describe('closeChannel', () => {
    it('should close channel and refresh state', async () => {
      const channelId = 'A'.repeat(64);

      // Mock ledger entry response (channel closing)
      mockXRPLClient.request.mockResolvedValue({
        result: {
          node: {
            ChannelID: channelId,
            Account: mockXRPLClient.address,
            Destination: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
            Amount: '10000000000',
            Balance: '5000000000',
            SettleDelay: 86400,
            PublicKey: mockClaimSigner.getPublicKey(),
            Expiration: Math.floor(Date.now() / 1000) + 86400, // Closing
          },
        },
      });

      await sdk.closeChannel(channelId);

      expect(mockChannelManager.closeChannel).toHaveBeenCalledWith(channelId);
      expect(mockXRPLClient.request).toHaveBeenCalledWith({
        command: 'ledger_entry',
        payment_channel: channelId,
      });
      expect(mockLogger.info).toHaveBeenCalledWith({ channelId }, 'Closing XRP payment channel...');
      expect(mockLogger.info).toHaveBeenCalledWith(
        { channelId },
        'XRP channel close initiated (settling after delay)'
      );
    }, 50);
  });

  describe('getChannelState', () => {
    it('should query ledger and return channel state', async () => {
      const channelId = 'A'.repeat(64);

      mockXRPLClient.request.mockResolvedValue({
        result: {
          node: {
            ChannelID: channelId,
            Account: mockXRPLClient.address,
            Destination: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
            Amount: '10000000000',
            Balance: '2000000000',
            SettleDelay: 86400,
            PublicKey: 'ED' + 'C'.repeat(64),
          },
        },
      });

      const state = await sdk.getChannelState(channelId);

      expect(state).toEqual({
        channelId,
        account: mockXRPLClient.address,
        destination: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
        amount: '10000000000',
        balance: '2000000000',
        settleDelay: 86400,
        publicKey: 'ED' + 'C'.repeat(64),
        cancelAfter: undefined,
        expiration: undefined,
        status: 'open',
      });
      expect(mockXRPLClient.request).toHaveBeenCalledWith({
        command: 'ledger_entry',
        payment_channel: channelId,
      });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { channelId },
        'Querying XRP channel state from ledger...'
      );
    }, 50);

    it('should parse closing channel status', async () => {
      const channelId = 'A'.repeat(64);
      const expiration = Math.floor(Date.now() / 1000) + 86400;

      mockXRPLClient.request.mockResolvedValue({
        result: {
          node: {
            ChannelID: channelId,
            Account: mockXRPLClient.address,
            Destination: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
            Amount: '10000000000',
            Balance: '2000000000',
            SettleDelay: 86400,
            PublicKey: 'ED' + 'C'.repeat(64),
            Expiration: expiration,
          },
        },
      });

      const state = await sdk.getChannelState(channelId);

      expect(state.status).toBe('closing');
      expect(state.expiration).toBe(expiration);
    }, 50);

    it('should handle balance field as undefined (default to 0)', async () => {
      const channelId = 'A'.repeat(64);

      mockXRPLClient.request.mockResolvedValue({
        result: {
          node: {
            ChannelID: channelId,
            Account: mockXRPLClient.address,
            Destination: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
            Amount: '10000000000',
            // Balance field missing
            SettleDelay: 86400,
            PublicKey: 'ED' + 'C'.repeat(64),
          },
        },
      });

      const state = await sdk.getChannelState(channelId);

      expect(state.balance).toBe('0');
    }, 50);
  });

  describe('getMyChannels', () => {
    it('should query all channels for account', async () => {
      const channelIds = ['A'.repeat(64), 'B'.repeat(64)];

      mockXRPLClient.request.mockResolvedValue({
        result: {
          channels: [{ channel_id: channelIds[0] }, { channel_id: channelIds[1] }],
        },
      });

      const result = await sdk.getMyChannels();

      expect(result).toEqual(channelIds);
      expect(mockXRPLClient.request).toHaveBeenCalledWith({
        command: 'account_channels',
        account: mockXRPLClient.address,
      });
      expect(mockLogger.debug).toHaveBeenCalledWith('Querying all XRP channels for account...');
    }, 50);

    it('should return empty array when no channels exist', async () => {
      mockXRPLClient.request.mockResolvedValue({
        result: {
          channels: [],
        },
      });

      const result = await sdk.getMyChannels();

      expect(result).toEqual([]);
    }, 50);
  });

  describe('Auto-refresh', () => {
    it('should start auto-refresh with 30s interval', () => {
      jest.useFakeTimers();

      sdk.startAutoRefresh();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Starting XRP channel auto-refresh (30s interval)'
      );

      jest.clearAllTimers();
      jest.useRealTimers();
    }, 50);

    it('should stop auto-refresh and clear interval', () => {
      jest.useFakeTimers();

      sdk.startAutoRefresh();
      sdk.stopAutoRefresh();

      expect(mockLogger.info).toHaveBeenCalledWith('XRP channel auto-refresh stopped');

      jest.clearAllTimers();
      jest.useRealTimers();
    }, 50);

    it('should not start multiple auto-refresh intervals', () => {
      jest.useFakeTimers();

      sdk.startAutoRefresh();
      sdk.startAutoRefresh(); // Second call

      expect(mockLogger.warn).toHaveBeenCalledWith('Auto-refresh already started');

      jest.clearAllTimers();
      jest.useRealTimers();
    }, 50);

    it('should refresh all cached channels on interval', async () => {
      jest.useFakeTimers();

      const channelId = 'A'.repeat(64);

      // Open channel to add to cache
      mockChannelManager.createChannel.mockResolvedValue(channelId);
      mockXRPLClient.request.mockResolvedValue({
        result: {
          node: {
            ChannelID: channelId,
            Account: mockXRPLClient.address,
            Destination: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
            Amount: '10000000000',
            Balance: '0',
            SettleDelay: 86400,
            PublicKey: mockClaimSigner.getPublicKey(),
          },
        },
      });

      await sdk.openChannel('rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN', '10000000000', 86400);

      // Start auto-refresh
      sdk.startAutoRefresh();

      // Clear previous request mock calls
      mockXRPLClient.request.mockClear();

      // Fast-forward 30 seconds
      jest.advanceTimersByTime(30000);

      // Wait for async operations to complete
      await Promise.resolve();

      expect(mockLogger.debug).toHaveBeenCalledWith({ count: 1 }, 'Refreshing all XRP channels...');

      jest.clearAllTimers();
      jest.useRealTimers();
    }, 100);
  });

  describe('Edge cases', () => {
    it('should handle stopAutoRefresh when not started', () => {
      sdk.stopAutoRefresh();

      expect(mockLogger.info).not.toHaveBeenCalled();
    }, 50);
  });
});
