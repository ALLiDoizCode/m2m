/**
 * Unit Tests for PaymentChannelSDK
 * Source: Epic 8 Story 8.7 Task 11
 */

import { ethers } from 'ethers';
import { PaymentChannelSDK, ChallengeNotExpiredError } from './payment-channel-sdk';
import type { BalanceProof } from '@m2m/shared';
import type { Logger } from '../utils/logger';

// Mock ethers
jest.mock('ethers');

describe('PaymentChannelSDK', () => {
  let sdk: PaymentChannelSDK;
  let mockProvider: jest.Mocked<ethers.Provider>;
  let mockSigner: jest.Mocked<ethers.Signer>;
  let mockRegistryContract: jest.Mocked<ethers.Contract>;
  let mockTokenNetworkContract: jest.Mocked<ethers.Contract>;
  let mockLogger: jest.Mocked<Logger>;

  const mockRegistryAddress = '0x1234567890123456789012345678901234567890';
  const mockTokenAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const mockTokenNetworkAddress = '0x9999999999999999999999999999999999999999';
  const mockMyAddress = '0x1111111111111111111111111111111111111111';
  const mockPeerAddress = '0x2222222222222222222222222222222222222222';
  const mockChannelId = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Mock provider
    mockProvider = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 8453n }), // Base mainnet
    } as unknown as jest.Mocked<ethers.Provider>;

    // Mock signer
    mockSigner = {
      getAddress: jest.fn().mockResolvedValue(mockMyAddress),
      signTypedData: jest
        .fn()
        .mockResolvedValue(
          '0xabcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234ab'
        ),
    } as unknown as jest.Mocked<ethers.Signer>;

    // Mock registry contract
    mockRegistryContract = {
      getTokenNetwork: jest.fn().mockResolvedValue(mockTokenNetworkAddress),
    } as unknown as jest.Mocked<ethers.Contract>;

    // Mock TokenNetwork contract
    mockTokenNetworkContract = {
      getAddress: jest.fn().mockResolvedValue(mockTokenNetworkAddress),
      openChannel: jest.fn().mockResolvedValue({
        wait: jest.fn().mockResolvedValue({
          hash: '0xtxhash',
          logs: [
            {
              topics: [
                '0x' + 'a'.repeat(64), // ChannelOpened topic
                mockChannelId,
                '0x' + mockMyAddress.slice(2).padStart(64, '0'),
                '0x' + mockPeerAddress.slice(2).padStart(64, '0'),
              ],
              data: '0x0000000000000000000000000000000000000000000000000000000000000e10', // 3600 in hex
            },
          ],
        }),
      }),
      setTotalDeposit: jest.fn().mockResolvedValue({
        wait: jest.fn().mockResolvedValue({ hash: '0xtxhash' }),
      }),
      closeChannel: jest.fn().mockResolvedValue({
        wait: jest.fn().mockResolvedValue({ hash: '0xtxhash' }),
      }),
      cooperativeSettle: jest.fn().mockResolvedValue({
        wait: jest.fn().mockResolvedValue({ hash: '0xtxhash' }),
      }),
      settleChannel: jest.fn().mockResolvedValue({
        wait: jest.fn().mockResolvedValue({ hash: '0xtxhash' }),
      }),
      channels: jest.fn().mockResolvedValue({
        settlementTimeout: 3600n,
        state: 1, // Opened
        closedAt: 0n,
        openedAt: BigInt(Math.floor(Date.now() / 1000)),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      }),
      participants: jest.fn().mockResolvedValue({
        deposit: 1000000n,
        withdrawnAmount: 0n,
        isCloser: false,
        nonce: 0n,
        transferredAmount: 0n,
      }),
      queryFilter: jest.fn().mockResolvedValue([]),
      filters: {
        ChannelOpened: jest.fn(),
      },
      on: jest.fn(),
      removeAllListeners: jest.fn(),
      interface: {
        parseLog: jest.fn().mockReturnValue({
          name: 'ChannelOpened',
          args: [mockChannelId, mockMyAddress, mockPeerAddress, 3600n],
        }),
      },
    } as unknown as jest.Mocked<ethers.Contract>;

    // Mock ERC20 contract
    const mockERC20Contract = {
      approve: jest.fn().mockResolvedValue({
        wait: jest.fn().mockResolvedValue({ hash: '0xtxhash' }),
      }),
    } as unknown as jest.Mocked<ethers.Contract>;

    // Mock logger
    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    } as unknown as jest.Mocked<Logger>;

    // Mock ethers.Contract constructor
    (ethers.Contract as unknown as jest.Mock).mockImplementation((address) => {
      if (address === mockRegistryAddress) {
        return mockRegistryContract;
      } else if (address === mockTokenNetworkAddress) {
        return mockTokenNetworkContract;
      } else if (address === mockTokenAddress) {
        return mockERC20Contract;
      }
      return mockTokenNetworkContract; // Default
    });

    // Mock ethers.verifyTypedData
    (ethers.verifyTypedData as jest.Mock) = jest.fn().mockReturnValue(mockPeerAddress);

    // Mock ethers.ZeroAddress and ZeroHash
    (ethers.ZeroAddress as string) = '0x0000000000000000000000000000000000000000';
    (ethers.ZeroHash as string) =
      '0x0000000000000000000000000000000000000000000000000000000000000000';

    // Create SDK instance
    sdk = new PaymentChannelSDK(mockProvider, mockSigner, mockRegistryAddress, mockLogger);
  });

  describe('constructor', () => {
    it('should initialize SDK with provider, signer, registry, and logger', () => {
      expect(sdk).toBeDefined();
      expect(mockLogger.debug).not.toHaveBeenCalled(); // Constructor doesn't log
    });
  });

  describe('getTokenNetworkAddress', () => {
    it('should return TokenNetwork address for a token', async () => {
      const address = await sdk.getTokenNetworkAddress(mockTokenAddress);
      expect(address).toBe(mockTokenNetworkAddress);
      expect(mockRegistryContract.getTokenNetwork).toHaveBeenCalledWith(mockTokenAddress);
    });

    it('should throw error if no TokenNetwork exists for token', async () => {
      mockRegistryContract.getTokenNetwork?.mockResolvedValueOnce(ethers.ZeroAddress);
      await expect(sdk.getTokenNetworkAddress(mockTokenAddress)).rejects.toThrow(
        `No TokenNetwork found for token ${mockTokenAddress}`
      );
    });

    it('should cache TokenNetwork contract after first lookup', async () => {
      await sdk.getTokenNetworkAddress(mockTokenAddress);
      await sdk.getTokenNetworkAddress(mockTokenAddress);
      // Registry should only be called once
      expect(mockRegistryContract.getTokenNetwork).toHaveBeenCalledTimes(1);
    });
  });

  describe('openChannel', () => {
    it('should open a channel and return channelId', async () => {
      const channelId = await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n);

      expect(channelId).toBe(mockChannelId);
      expect(mockTokenNetworkContract.openChannel).toHaveBeenCalledWith(mockPeerAddress, 3600);
      expect(mockLogger.info).toHaveBeenCalledWith('Opening payment channel', expect.any(Object));
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Channel opened successfully',
        expect.any(Object)
      );
    });

    it('should deposit initial amount if specified', async () => {
      const initialDeposit = 1000000n;
      const channelId = await sdk.openChannel(
        mockPeerAddress,
        mockTokenAddress,
        3600,
        initialDeposit
      );

      expect(channelId).toBe(mockChannelId);
      // Should call setTotalDeposit for initial deposit
      expect(mockTokenNetworkContract.setTotalDeposit).toHaveBeenCalled();
    });

    it('should cache channel state after opening', async () => {
      const channelId = await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n);

      // Verify channel state was cached
      const state = await sdk.getChannelState(channelId, mockTokenAddress);
      expect(state.channelId).toBe(channelId);
      expect(state.status).toBe('opened');
    });
  });

  describe('deposit', () => {
    it('should deposit tokens to channel', async () => {
      const depositAmount = 500000n;

      // First open channel to populate cache
      const channelId = await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n);

      // Mock getChannelState to return existing state
      mockTokenNetworkContract.participants?.mockResolvedValueOnce({
        deposit: 0n,
        withdrawnAmount: 0n,
        isCloser: false,
        nonce: 0n,
        transferredAmount: 0n,
      });

      await sdk.deposit(channelId, mockTokenAddress, depositAmount);

      // Should call setTotalDeposit with cumulative amount
      expect(mockTokenNetworkContract.setTotalDeposit).toHaveBeenCalledWith(
        channelId,
        mockMyAddress,
        depositAmount
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Depositing to channel', expect.any(Object));
    });
  });

  describe('signBalanceProof', () => {
    beforeEach(async () => {
      // Open channel first to cache TokenNetwork
      await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n);
    });

    it('should sign balance proof with EIP-712', async () => {
      const nonce = 1;
      const transferredAmount = 100000n;

      const signature = await sdk.signBalanceProof(
        mockChannelId,
        nonce,
        transferredAmount,
        0n,
        ethers.ZeroHash
      );

      expect(signature).toBeDefined();
      expect(mockSigner.signTypedData).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'TokenNetwork',
          version: '1',
          chainId: 8453n,
          verifyingContract: mockTokenNetworkAddress,
        }),
        expect.objectContaining({
          BalanceProof: expect.any(Array),
        }),
        expect.objectContaining({
          channelId: mockChannelId,
          nonce,
          transferredAmount,
          lockedAmount: 0n,
          locksRoot: ethers.ZeroHash,
        })
      );
      expect(mockLogger.debug).toHaveBeenCalledWith('Balance proof signed', expect.any(Object));
    });

    it('should throw error if TokenNetwork cannot be determined', async () => {
      const unknownChannelId = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      mockTokenNetworkContract.channels?.mockResolvedValueOnce({
        state: 0, // NonExistent
      });

      await expect(sdk.signBalanceProof(unknownChannelId, 1, 100n)).rejects.toThrow(
        `Cannot determine TokenNetwork for channel ${unknownChannelId}`
      );
    });
  });

  describe('verifyBalanceProof', () => {
    beforeEach(async () => {
      // Open channel first to cache TokenNetwork
      await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n);
    });

    it('should verify valid balance proof signature', async () => {
      const balanceProof: BalanceProof = {
        channelId: mockChannelId,
        nonce: 1,
        transferredAmount: 100000n,
        lockedAmount: 0n,
        locksRoot: ethers.ZeroHash,
      };
      const signature = '0xabcd1234';

      const isValid = await sdk.verifyBalanceProof(balanceProof, signature, mockPeerAddress);

      expect(isValid).toBe(true);
      expect(ethers.verifyTypedData).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        balanceProof,
        signature
      );
    });

    it('should return false for invalid signature', async () => {
      (ethers.verifyTypedData as jest.Mock).mockReturnValueOnce('0xWrongAddress');

      const balanceProof: BalanceProof = {
        channelId: mockChannelId,
        nonce: 1,
        transferredAmount: 100000n,
        lockedAmount: 0n,
        locksRoot: ethers.ZeroHash,
      };

      const isValid = await sdk.verifyBalanceProof(balanceProof, '0xbadsig', mockPeerAddress);

      expect(isValid).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Balance proof verification failed',
        expect.any(Object)
      );
    });

    it('should return false on verification error', async () => {
      (ethers.verifyTypedData as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Invalid signature format');
      });

      const balanceProof: BalanceProof = {
        channelId: mockChannelId,
        nonce: 1,
        transferredAmount: 100000n,
        lockedAmount: 0n,
        locksRoot: ethers.ZeroHash,
      };

      const isValid = await sdk.verifyBalanceProof(balanceProof, '0xbadsig', mockPeerAddress);

      expect(isValid).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Balance proof verification error',
        expect.any(Object)
      );
    });
  });

  describe('closeChannel', () => {
    beforeEach(async () => {
      // Open channel first
      await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n);
    });

    it('should close channel with balance proof', async () => {
      const balanceProof: BalanceProof = {
        channelId: mockChannelId,
        nonce: 1,
        transferredAmount: 100000n,
        lockedAmount: 0n,
        locksRoot: ethers.ZeroHash,
      };
      const signature = '0xabcd1234';

      await sdk.closeChannel(mockChannelId, mockTokenAddress, balanceProof, signature);

      expect(mockTokenNetworkContract.closeChannel).toHaveBeenCalledWith(
        mockChannelId,
        balanceProof,
        signature
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Closing channel', expect.any(Object));
      expect(mockLogger.info).toHaveBeenCalledWith('Channel closed', expect.any(Object));
    });

    it('should throw error if channel is not opened', async () => {
      // Create a fresh SDK instance without cached state
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockSigner,
        mockRegistryAddress,
        mockLogger
      );

      // Mock channel as already closed
      mockTokenNetworkContract.channels?.mockResolvedValueOnce({
        settlementTimeout: 3600n,
        state: 2, // Closed
        closedAt: BigInt(Math.floor(Date.now() / 1000)),
        openedAt: BigInt(Math.floor(Date.now() / 1000 - 3600)),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });

      const balanceProof: BalanceProof = {
        channelId: mockChannelId,
        nonce: 1,
        transferredAmount: 100000n,
        lockedAmount: 0n,
        locksRoot: ethers.ZeroHash,
      };

      await expect(
        freshSDK.closeChannel(mockChannelId, mockTokenAddress, balanceProof, '0xsig')
      ).rejects.toThrow('Cannot close channel in status: closed');
    });
  });

  describe('cooperativeSettle', () => {
    beforeEach(async () => {
      // Open channel first
      await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n);
    });

    it('should cooperatively settle channel', async () => {
      const myProof: BalanceProof = {
        channelId: mockChannelId,
        nonce: 5,
        transferredAmount: 100000n,
        lockedAmount: 0n,
        locksRoot: ethers.ZeroHash,
      };
      const theirProof: BalanceProof = {
        channelId: mockChannelId,
        nonce: 5,
        transferredAmount: 50000n,
        lockedAmount: 0n,
        locksRoot: ethers.ZeroHash,
      };

      await sdk.cooperativeSettle(
        mockChannelId,
        mockTokenAddress,
        myProof,
        '0xmysig',
        theirProof,
        '0xtheirsig'
      );

      expect(mockTokenNetworkContract.cooperativeSettle).toHaveBeenCalledWith(
        mockChannelId,
        myProof,
        '0xmysig',
        theirProof,
        '0xtheirsig'
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cooperatively settling channel',
        expect.any(Object)
      );
    });
  });

  describe('settleChannel', () => {
    it('should settle channel after challenge period expires', async () => {
      // Create a fresh SDK instance without cached state
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockSigner,
        mockRegistryAddress,
        mockLogger
      );

      // Mock channel as closed with expired challenge period
      const closedAt = Math.floor(Date.now() / 1000) - 7200; // Closed 2 hours ago
      mockTokenNetworkContract.channels?.mockResolvedValue({
        settlementTimeout: 3600n, // 1 hour timeout
        state: 2, // Closed
        closedAt: BigInt(closedAt),
        openedAt: BigInt(closedAt - 3600),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });

      await freshSDK.settleChannel(mockChannelId, mockTokenAddress);

      expect(mockTokenNetworkContract.settleChannel).toHaveBeenCalledWith(mockChannelId);
      expect(mockLogger.info).toHaveBeenCalledWith('Settling channel', expect.any(Object));
    });

    it('should throw ChallengeNotExpiredError if challenge period not expired', async () => {
      // Create a fresh SDK instance without cached state
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockSigner,
        mockRegistryAddress,
        mockLogger
      );

      // Mock channel closed recently
      const closedAt = Math.floor(Date.now() / 1000) - 1800; // Closed 30 min ago
      mockTokenNetworkContract.channels?.mockResolvedValue({
        settlementTimeout: 3600n, // 1 hour timeout (still 30 min remaining)
        state: 2, // Closed
        closedAt: BigInt(closedAt),
        openedAt: BigInt(closedAt - 3600),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });

      await expect(freshSDK.settleChannel(mockChannelId, mockTokenAddress)).rejects.toThrow(
        ChallengeNotExpiredError
      );
    });

    it('should throw error if channel is not closed', async () => {
      // Create a fresh SDK instance without cached state
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockSigner,
        mockRegistryAddress,
        mockLogger
      );

      mockTokenNetworkContract.channels?.mockResolvedValue({
        settlementTimeout: 3600n,
        state: 1, // Opened
        closedAt: 0n,
        openedAt: BigInt(Math.floor(Date.now() / 1000)),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });

      await expect(freshSDK.settleChannel(mockChannelId, mockTokenAddress)).rejects.toThrow(
        'Cannot settle channel in status: opened'
      );
    });
  });

  describe('getChannelState', () => {
    it('should query channel state from blockchain', async () => {
      const state = await sdk.getChannelState(mockChannelId, mockTokenAddress);

      expect(state.channelId).toBe(mockChannelId);
      expect(state.status).toBe('opened');
      expect(state.participants).toEqual([mockMyAddress, mockPeerAddress]);
      expect(mockTokenNetworkContract.channels).toHaveBeenCalledWith(mockChannelId);
      expect(mockTokenNetworkContract.participants).toHaveBeenCalledTimes(2);
    });

    it('should use cached state if available', async () => {
      // First call - should query blockchain
      await sdk.getChannelState(mockChannelId, mockTokenAddress);

      // Second call - should use cache
      await sdk.getChannelState(mockChannelId, mockTokenAddress);

      // channels() should only be called once (first time)
      expect(mockTokenNetworkContract.channels).toHaveBeenCalledTimes(1);
    });
  });

  describe('getMyChannels', () => {
    it('should return list of channel IDs where I am a participant', async () => {
      const mockEvent1 = {
        args: [mockChannelId, mockMyAddress, mockPeerAddress],
      } as unknown as ethers.EventLog;
      const mockEvent2 = {
        args: [
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          mockPeerAddress,
          '0x3333333333333333333333333333333333333333',
        ],
      } as unknown as ethers.EventLog;

      mockTokenNetworkContract.queryFilter?.mockResolvedValueOnce([mockEvent1, mockEvent2]);

      const channels = await sdk.getMyChannels(mockTokenAddress);

      expect(channels).toHaveLength(1);
      expect(channels[0]).toBe(mockChannelId);
    });
  });

  describe('event listeners', () => {
    beforeEach(async () => {
      // Get TokenNetwork contract cached
      await sdk.getTokenNetworkAddress(mockTokenAddress);
    });

    it('should register ChannelOpened event listener', async () => {
      const callback = jest.fn();

      await sdk.onChannelOpened(mockTokenAddress, callback);

      expect(mockTokenNetworkContract.on).toHaveBeenCalledWith(
        'ChannelOpened',
        expect.any(Function)
      );
    });

    it('should register ChannelClosed event listener', async () => {
      const callback = jest.fn();

      await sdk.onChannelClosed(mockTokenAddress, callback);

      expect(mockTokenNetworkContract.on).toHaveBeenCalledWith(
        'ChannelClosed',
        expect.any(Function)
      );
    });

    it('should register ChannelSettled event listener', async () => {
      const callback = jest.fn();

      await sdk.onChannelSettled(mockTokenAddress, callback);

      expect(mockTokenNetworkContract.on).toHaveBeenCalledWith(
        'ChannelSettled',
        expect.any(Function)
      );
    });

    it('should remove all event listeners', () => {
      sdk.removeAllListeners();

      expect(mockTokenNetworkContract.removeAllListeners).toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith('All event listeners removed');
    });
  });
});
