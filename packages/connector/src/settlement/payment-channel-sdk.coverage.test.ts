/**
 * Comprehensive Branch-Coverage Tests for PaymentChannelSDK
 *
 * Covers all branches in payment-channel-sdk.ts including:
 * - Constructor and static factory
 * - Lazy initialization (_ensureInitialized)
 * - TokenNetwork contract caching and lookup
 * - openChannel (with/without initial deposit, event parsing failures)
 * - deposit (allowance checks, approve retry logic, deposit retry logic)
 * - signBalanceProof and verifyBalanceProof
 * - closeChannel, claimFromChannel, settleChannel (state validations)
 * - getChannelState (cache hit/miss, state mapping)
 * - getChannelStateByNetwork
 * - verifyBalanceProofWithDomain
 * - getMyChannels
 * - Event listeners (onChannelOpened, onChannelClosed, onChannelSettled, onChannelCooperativeSettled)
 * - removeAllListeners
 */

import { ethers } from 'ethers';
import { PaymentChannelSDK, ChallengeNotExpiredError } from './payment-channel-sdk';
import type { BalanceProof } from '@toon-protocol/shared';
import type { Logger } from '../utils/logger';
import type { KeyManager } from '../security/key-manager';
import type { EVMRPCConnectionPool } from '../utils/evm-rpc-connection-pool';

jest.mock('ethers');
jest.mock('../security/key-manager-signer');

describe('PaymentChannelSDK - Comprehensive Branch Coverage', () => {
  let sdk: PaymentChannelSDK;
  let mockProvider: jest.Mocked<ethers.Provider>;
  let mockSigner: jest.Mocked<ethers.Signer>;
  let mockKeyManager: jest.Mocked<KeyManager>;
  let mockRegistryContract: jest.Mocked<ethers.Contract>;
  let mockTokenNetworkContract: jest.Mocked<ethers.Contract>;
  let mockERC20Contract: jest.Mocked<ethers.Contract>;
  let mockLogger: jest.Mocked<Logger>;

  const mockRegistryAddress = '0x1234567890123456789012345678901234567890';
  const mockTokenAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const mockTokenNetworkAddress = '0x9999999999999999999999999999999999999999';
  const mockMyAddress = '0x1111111111111111111111111111111111111111';
  const mockPeerAddress = '0x2222222222222222222222222222222222222222';
  const mockChannelId = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const mockEvmKeyId = 'test-evm-key';

  beforeEach(() => {
    jest.clearAllMocks();

    mockProvider = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 8453n }),
      getTransactionCount: jest.fn().mockResolvedValue(0),
      getFeeData: jest.fn().mockResolvedValue({
        gasPrice: 1000000000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 1000000000n,
      }),
      getBlock: jest.fn().mockResolvedValue({
        timestamp: Math.floor(Date.now() / 1000),
      }),
    } as unknown as jest.Mocked<ethers.Provider>;

    mockKeyManager = {
      sign: jest
        .fn()
        .mockResolvedValue(
          Buffer.from(
            'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234ab',
            'hex'
          )
        ),
      getPublicKey: jest.fn().mockResolvedValue(Buffer.from('04' + 'a'.repeat(128), 'hex')),
      rotateKey: jest.fn().mockResolvedValue('new-key-id'),
    } as unknown as jest.Mocked<KeyManager>;

    mockSigner = {
      getAddress: jest.fn().mockResolvedValue(mockMyAddress),
      signTypedData: jest
        .fn()
        .mockResolvedValue(
          '0xabcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234ab'
        ),
    } as unknown as jest.Mocked<ethers.Signer>;

    const { createKeyManagerSigner } = require('../security/key-manager-signer');
    createKeyManagerSigner.mockResolvedValue(mockSigner);

    mockRegistryContract = {
      getTokenNetwork: jest.fn().mockResolvedValue(mockTokenNetworkAddress),
    } as unknown as jest.Mocked<ethers.Contract>;

    mockTokenNetworkContract = {
      getAddress: jest.fn().mockResolvedValue(mockTokenNetworkAddress),
      openChannel: jest.fn().mockResolvedValue({
        wait: jest.fn().mockResolvedValue({
          hash: '0xopenchash',
          logs: [
            {
              topics: [
                '0x' + 'a'.repeat(64),
                mockChannelId,
                '0x' + mockMyAddress.slice(2).padStart(64, '0'),
                '0x' + mockPeerAddress.slice(2).padStart(64, '0'),
              ],
              data: '0x0000000000000000000000000000000000000000000000000000000000000e10',
            },
          ],
        }),
      }),
      setTotalDeposit: jest.fn().mockResolvedValue({
        wait: jest.fn().mockResolvedValue({ hash: '0xdeposithash' }),
      }),
      closeChannel: jest.fn().mockResolvedValue({
        wait: jest.fn().mockResolvedValue({ hash: '0xclosehash', blockNumber: 123 }),
      }),
      settleChannel: jest.fn().mockResolvedValue({
        wait: jest.fn().mockResolvedValue({ hash: '0xsettlehash' }),
      }),
      claimFromChannel: jest.fn().mockResolvedValue({
        wait: jest.fn().mockResolvedValue({ hash: '0xclaimhash' }),
      }),
      channels: jest.fn().mockResolvedValue({
        settlementTimeout: 3600n,
        state: 1,
        closedAt: 0n,
        openedAt: BigInt(Math.floor(Date.now() / 1000)),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      }),
      participants: jest.fn().mockResolvedValue({
        deposit: 1000000n,
        nonce: 0n,
        transferredAmount: 0n,
      }),
      claimedAmounts: jest.fn().mockResolvedValue(5000n),
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

    mockERC20Contract = {
      approve: jest.fn().mockResolvedValue({
        wait: jest.fn().mockResolvedValue({ hash: '0xapprovehhash' }),
      }),
      allowance: jest.fn().mockResolvedValue(0n),
      symbol: jest.fn().mockResolvedValue('M2M'),
    } as unknown as jest.Mocked<ethers.Contract>;

    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    } as unknown as jest.Mocked<Logger>;

    (ethers.Contract as unknown as jest.Mock).mockImplementation((address: string) => {
      if (address === mockRegistryAddress) return mockRegistryContract;
      if (address === mockTokenNetworkAddress) return mockTokenNetworkContract;
      if (address === mockTokenAddress) return mockERC20Contract;
      return mockTokenNetworkContract;
    });

    (ethers.verifyTypedData as jest.Mock) = jest.fn().mockReturnValue(mockPeerAddress);
    (ethers.TypedDataEncoder.hash as jest.Mock) = jest
      .fn()
      .mockReturnValue('0x1234567890123456789012345678901234567890123456789012345678901234');
    (ethers.ZeroAddress as string) = '0x0000000000000000000000000000000000000000';
    (ethers.ZeroHash as string) =
      '0x0000000000000000000000000000000000000000000000000000000000000000';
    (ethers.MaxUint256 as bigint) = 2n ** 256n - 1n;

    sdk = new PaymentChannelSDK(
      mockProvider,
      mockKeyManager,
      mockEvmKeyId,
      mockRegistryAddress,
      mockLogger
    );
  });

  // ==========================================================================
  // 1. Constructor & Static Factory
  // ==========================================================================

  describe('constructor', () => {
    it('should assign all dependencies correctly', () => {
      expect(sdk).toBeDefined();
      expect(mockLogger.debug).not.toHaveBeenCalled();
    });
  });

  describe('fromConnectionPool', () => {
    it('should create SDK when pool returns a provider', () => {
      const mockPool = {
        getProvider: jest.fn().mockReturnValue(mockProvider),
      } as unknown as EVMRPCConnectionPool;

      const result = PaymentChannelSDK.fromConnectionPool(
        mockPool,
        mockKeyManager,
        mockEvmKeyId,
        mockRegistryAddress,
        mockLogger
      );

      expect(result).toBeInstanceOf(PaymentChannelSDK);
      expect(mockPool.getProvider).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Creating PaymentChannelSDK from connection pool'
      );
    });

    it('should throw when pool returns no provider', () => {
      const mockPool = {
        getProvider: jest.fn().mockReturnValue(null),
      } as unknown as EVMRPCConnectionPool;

      expect(() =>
        PaymentChannelSDK.fromConnectionPool(
          mockPool,
          mockKeyManager,
          mockEvmKeyId,
          mockRegistryAddress,
          mockLogger
        )
      ).toThrow('No healthy EVM RPC connection available in pool');
    });
  });

  // ==========================================================================
  // 2. _ensureInitialized
  // ==========================================================================

  describe('_ensureInitialized', () => {
    it('should initialize on first call', async () => {
      await (sdk as any)._ensureInitialized();
      const { createKeyManagerSigner } = require('../security/key-manager-signer');
      expect(createKeyManagerSigner).toHaveBeenCalledWith(
        mockKeyManager,
        mockEvmKeyId,
        mockProvider
      );
    });

    it('should return cached values on subsequent calls without re-initializing', async () => {
      // First call initializes
      await (sdk as any)._ensureInitialized();
      const { createKeyManagerSigner } = require('../security/key-manager-signer');
      expect(createKeyManagerSigner).toHaveBeenCalledTimes(1);

      // Second call should use cached signer/contract
      await (sdk as any)._ensureInitialized();
      expect(createKeyManagerSigner).toHaveBeenCalledTimes(1); // Not called again
    });
  });

  // ==========================================================================
  // 3. getTokenNetworkContract
  // ==========================================================================

  describe('getTokenNetworkContract', () => {
    it('should query registry on cache miss', async () => {
      const contract = await (sdk as any).getTokenNetworkContract(mockTokenAddress);
      expect(contract).toBeDefined();
      expect(mockRegistryContract.getTokenNetwork).toHaveBeenCalledWith(mockTokenAddress);
    });

    it('should return cached contract on cache hit', async () => {
      // First call populates cache
      await (sdk as any).getTokenNetworkContract(mockTokenAddress);
      expect(mockRegistryContract.getTokenNetwork).toHaveBeenCalledTimes(1);

      // Second call should use cache
      await (sdk as any).getTokenNetworkContract(mockTokenAddress);
      expect(mockRegistryContract.getTokenNetwork).toHaveBeenCalledTimes(1);
    });

    it('should throw if TokenNetwork address is ZeroAddress', async () => {
      mockRegistryContract.getTokenNetwork?.mockResolvedValueOnce(ethers.ZeroAddress);
      await expect((sdk as any).getTokenNetworkContract(mockTokenAddress)).rejects.toThrow(
        `No TokenNetwork found for token ${mockTokenAddress}`
      );
    });
  });

  describe('getTokenNetworkAddress', () => {
    it('should return TokenNetwork address', async () => {
      const address = await sdk.getTokenNetworkAddress(mockTokenAddress);
      expect(address).toBe(mockTokenNetworkAddress);
    });
  });

  describe('getChainId', () => {
    it('should return numeric chain ID', async () => {
      const chainId = await sdk.getChainId();
      expect(chainId).toBe(8453);
    });
  });

  describe('getTokenSymbol', () => {
    it('should query ERC-20 symbol()', async () => {
      const symbol = await sdk.getTokenSymbol(mockTokenAddress);
      expect(symbol).toBe('M2M');
    });
  });

  describe('getSignerAddress', () => {
    it('should return signer address', async () => {
      const addr = await sdk.getSignerAddress();
      expect(addr).toBe(mockMyAddress);
    });
  });

  // ==========================================================================
  // 4. openChannel
  // ==========================================================================

  describe('openChannel', () => {
    it('should open channel without initial deposit', async () => {
      const result = await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n);
      expect(result.channelId).toBe(mockChannelId);
      expect(result.txHash).toBe('0xopenchash');
      expect(mockTokenNetworkContract.openChannel).toHaveBeenCalledWith(mockPeerAddress, 3600);
      expect(mockTokenNetworkContract.setTotalDeposit).not.toHaveBeenCalled();
    });

    it('should open channel with initial deposit', async () => {
      // Need to mock participants for getChannelState inside deposit
      mockTokenNetworkContract.participants?.mockResolvedValueOnce({
        deposit: 0n,
        nonce: 0n,
        transferredAmount: 0n,
      });

      const result = await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 1000n);
      expect(result.channelId).toBe(mockChannelId);
      expect(mockTokenNetworkContract.setTotalDeposit).toHaveBeenCalled();
    });

    it('should cache channel state after opening', async () => {
      const { channelId } = await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n);
      const state = await sdk.getChannelState(channelId, mockTokenAddress);
      expect(state.status).toBe('opened');
      expect(state.channelId).toBe(channelId);
    });

    it('should throw if ChannelOpened event is not found', async () => {
      mockTokenNetworkContract.openChannel?.mockResolvedValueOnce({
        wait: jest.fn().mockResolvedValue({
          hash: '0xbadhash',
          logs: [],
        }),
      });

      await expect(sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n)).rejects.toThrow(
        'ChannelOpened event not found in transaction receipt'
      );
    });

    it('should handle parseLog throwing during event search', async () => {
      mockTokenNetworkContract.openChannel?.mockResolvedValueOnce({
        wait: jest.fn().mockResolvedValue({
          hash: '0xbadhash',
          logs: [
            {
              topics: ['0x' + 'b'.repeat(64)],
              data: '0x00',
            },
          ],
        }),
      });

      // parseLog throws for the single bad log
      (mockTokenNetworkContract.interface.parseLog as jest.Mock).mockImplementationOnce(() => {
        throw new Error('parse error');
      });

      await expect(sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n)).rejects.toThrow(
        'ChannelOpened event not found in transaction receipt'
      );
    });
  });

  // ==========================================================================
  // 5. deposit
  // ==========================================================================

  describe('deposit', () => {
    beforeEach(async () => {
      // Open channel to populate cache
      await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n);
      // Reset mocks that were called during openChannel
      jest.clearAllMocks();
    });

    it('should deposit when allowance is already sufficient', async () => {
      // Allowance already covers deposit
      mockERC20Contract.allowance?.mockResolvedValueOnce(2000000n);

      mockTokenNetworkContract.participants?.mockResolvedValueOnce({
        deposit: 0n,
        nonce: 0n,
        transferredAmount: 0n,
      });

      await sdk.deposit(mockChannelId, mockTokenAddress, 500000n);

      // Should skip approval
      expect(mockERC20Contract.approve).not.toHaveBeenCalled();
      expect(mockTokenNetworkContract.setTotalDeposit).toHaveBeenCalledWith(
        mockChannelId,
        mockMyAddress,
        500000n,
        expect.any(Object)
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Sufficient token allowance already exists',
        expect.any(Object)
      );
    });

    it('should deposit with approval when allowance is insufficient', async () => {
      mockERC20Contract.allowance?.mockResolvedValueOnce(0n);

      mockTokenNetworkContract.participants?.mockResolvedValueOnce({
        deposit: 0n,
        nonce: 0n,
        transferredAmount: 0n,
      });

      await sdk.deposit(mockChannelId, mockTokenAddress, 500000n);

      expect(mockERC20Contract.approve).toHaveBeenCalled();
      expect(mockTokenNetworkContract.setTotalDeposit).toHaveBeenCalled();
    });

    it('should retry approve on NONCE_EXPIRED and succeed', async () => {
      mockERC20Contract.allowance?.mockResolvedValueOnce(0n);

      const nonceError = new Error('nonce expired') as Error & { code: string };
      nonceError.code = 'NONCE_EXPIRED';

      mockERC20Contract.approve?.mockRejectedValueOnce(nonceError).mockResolvedValueOnce({
        wait: jest.fn().mockResolvedValue({ hash: '0xapprovehhash2' }),
      });

      mockTokenNetworkContract.participants?.mockResolvedValueOnce({
        deposit: 0n,
        nonce: 0n,
        transferredAmount: 0n,
      });

      await sdk.deposit(mockChannelId, mockTokenAddress, 500000n);

      expect(mockERC20Contract.approve).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Nonce error on approve, retrying with fresh nonce',
        expect.any(Object)
      );
    });

    it('should throw if approve fails with NONCE_EXPIRED on final retry', async () => {
      mockERC20Contract.allowance?.mockResolvedValueOnce(0n);

      const nonceError = new Error('nonce expired') as Error & { code: string };
      nonceError.code = 'NONCE_EXPIRED';
      mockERC20Contract.approve?.mockRejectedValue(nonceError);

      await expect(sdk.deposit(mockChannelId, mockTokenAddress, 500000n)).rejects.toThrow(
        'nonce expired'
      );
      expect(mockERC20Contract.approve).toHaveBeenCalledTimes(3);
    });

    it('should throw immediately on non-nonce approve error', async () => {
      mockERC20Contract.allowance?.mockResolvedValueOnce(0n);
      mockERC20Contract.approve?.mockRejectedValueOnce(new Error('insufficient funds'));

      await expect(sdk.deposit(mockChannelId, mockTokenAddress, 500000n)).rejects.toThrow(
        'insufficient funds'
      );
      expect(mockERC20Contract.approve).toHaveBeenCalledTimes(1);
    });

    it('should throw if approveTx is undefined after all retries', async () => {
      mockERC20Contract.allowance?.mockResolvedValueOnce(0n);
      // Mock approve to return undefined (edge case)
      mockERC20Contract.approve?.mockResolvedValue(undefined);

      await expect(sdk.deposit(mockChannelId, mockTokenAddress, 500000n)).rejects.toThrow(
        'Failed to send approve transaction after retries'
      );
    });

    it('should retry setTotalDeposit on NONCE_EXPIRED and succeed', async () => {
      mockERC20Contract.allowance?.mockResolvedValueOnce(2000000n);

      mockTokenNetworkContract.participants?.mockResolvedValueOnce({
        deposit: 0n,
        nonce: 0n,
        transferredAmount: 0n,
      });

      const nonceError = new Error('nonce expired') as Error & { code: string };
      nonceError.code = 'NONCE_EXPIRED';
      mockTokenNetworkContract.setTotalDeposit
        ?.mockRejectedValueOnce(nonceError)
        .mockResolvedValueOnce({
          wait: jest.fn().mockResolvedValue({ hash: '0xdeposithash2' }),
        });

      await sdk.deposit(mockChannelId, mockTokenAddress, 500000n);

      expect(mockTokenNetworkContract.setTotalDeposit).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Nonce error on setTotalDeposit, retrying',
        expect.any(Object)
      );
    });

    it('should throw if setTotalDeposit fails with NONCE_EXPIRED on final retry', async () => {
      mockERC20Contract.allowance?.mockResolvedValueOnce(0n);
      mockERC20Contract.approve?.mockResolvedValueOnce({
        wait: jest.fn().mockResolvedValue({ hash: '0xapprovehhash' }),
      });

      mockTokenNetworkContract.participants?.mockResolvedValueOnce({
        deposit: 0n,
        nonce: 0n,
        transferredAmount: 0n,
      });

      const nonceError = new Error('nonce expired') as Error & { code: string };
      nonceError.code = 'NONCE_EXPIRED';
      mockTokenNetworkContract.setTotalDeposit?.mockRejectedValue(nonceError);

      await expect(sdk.deposit(mockChannelId, mockTokenAddress, 500000n)).rejects.toThrow(
        'nonce expired'
      );
      expect(mockTokenNetworkContract.setTotalDeposit).toHaveBeenCalledTimes(3);
    });

    it('should throw immediately on non-nonce setTotalDeposit error', async () => {
      mockERC20Contract.allowance?.mockResolvedValueOnce(2000000n);

      mockTokenNetworkContract.participants?.mockResolvedValueOnce({
        deposit: 0n,
        nonce: 0n,
        transferredAmount: 0n,
      });

      mockTokenNetworkContract.setTotalDeposit?.mockRejectedValueOnce(new Error('reverted'));

      await expect(sdk.deposit(mockChannelId, mockTokenAddress, 500000n)).rejects.toThrow(
        'reverted'
      );
      expect(mockTokenNetworkContract.setTotalDeposit).toHaveBeenCalledTimes(1);
    });

    it('should throw if depositTx is undefined after all retries', async () => {
      mockERC20Contract.allowance?.mockResolvedValueOnce(2000000n);

      mockTokenNetworkContract.participants?.mockResolvedValueOnce({
        deposit: 0n,
        nonce: 0n,
        transferredAmount: 0n,
      });

      // setTotalDeposit returns undefined
      mockTokenNetworkContract.setTotalDeposit?.mockResolvedValue(undefined);

      await expect(sdk.deposit(mockChannelId, mockTokenAddress, 500000n)).rejects.toThrow(
        'Failed to send setTotalDeposit transaction after retries'
      );
    });

    it('should update cached state after deposit', async () => {
      // Clear cache so getChannelState queries the chain for current deposit
      (sdk as any).channelStateCache.delete(mockChannelId);

      mockERC20Contract.allowance?.mockResolvedValueOnce(2000000n);

      mockTokenNetworkContract.participants?.mockResolvedValueOnce({
        deposit: 1000000n,
        nonce: 0n,
        transferredAmount: 0n,
      });
      mockTokenNetworkContract.participants?.mockResolvedValueOnce({
        deposit: 0n,
        nonce: 0n,
        transferredAmount: 0n,
      });

      await sdk.deposit(mockChannelId, mockTokenAddress, 500000n);

      const state = await sdk.getChannelState(mockChannelId, mockTokenAddress);
      expect(state.myDeposit).toBe(1500000n);
    });
  });

  // ==========================================================================
  // 6. signBalanceProof
  // ==========================================================================

  describe('signBalanceProof', () => {
    beforeEach(async () => {
      await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n);
      jest.clearAllMocks();
    });

    it('should sign with default locksRoot (ZeroHash)', async () => {
      const sig = await sdk.signBalanceProof(mockChannelId, 1, 100n, 0n);
      expect(sig).toMatch(/^0x[a-f0-9]+$/);
    });

    it('should sign with custom locksRoot', async () => {
      const customLocksRoot = '0x' + 'c'.repeat(64);
      const sig = await sdk.signBalanceProof(mockChannelId, 1, 100n, 0n, customLocksRoot);
      expect(sig).toMatch(/^0x[a-f0-9]+$/);
    });

    it('should find TokenNetwork from cache where state !== 0', async () => {
      // Already cached from openChannel
      const sig = await sdk.signBalanceProof(mockChannelId, 1, 100n);
      expect(sig).toBeDefined();
    });

    it('should skip TokenNetwork from cache where state === 0', async () => {
      // Create a second token network in cache with state 0
      const otherTokenAddress = '0x' + 'd'.repeat(40);
      const otherTokenNetworkAddress = '0x' + 'e'.repeat(40);

      // Mock registry to return other address for other token
      mockRegistryContract.getTokenNetwork?.mockResolvedValueOnce(otherTokenNetworkAddress);

      // Create a separate mock contract for the other network
      const otherContract = {
        getAddress: jest.fn().mockResolvedValue(otherTokenNetworkAddress),
        channels: jest.fn().mockResolvedValue({ state: 0 }), // NonExistent
      } as unknown as ethers.Contract;

      (ethers.Contract as unknown as jest.Mock).mockImplementation((address: string) => {
        if (address === mockRegistryAddress) return mockRegistryContract;
        if (address === otherTokenNetworkAddress) return otherContract;
        if (address === mockTokenNetworkAddress) return mockTokenNetworkContract;
        if (address === mockTokenAddress) return mockERC20Contract;
        return mockTokenNetworkContract;
      });

      // Populate cache with other contract by querying it
      await (sdk as any).getTokenNetworkContract(otherTokenAddress);

      // Now signBalanceProof should iterate both, skip the state===0 one, and use the state!==0 one
      const sig = await sdk.signBalanceProof(mockChannelId, 1, 100n);
      expect(sig).toBeDefined();
    });

    it('should throw if no TokenNetwork found for channel', async () => {
      // Empty the tokenNetworkCache so iteration finds nothing
      (sdk as any).tokenNetworkCache.clear();

      await expect(sdk.signBalanceProof(mockChannelId, 1, 100n)).rejects.toThrow(
        `Cannot determine TokenNetwork for channel ${mockChannelId}`
      );
    });

    it('should continue iteration if channels() throws for a cached contract', async () => {
      const throwingContract = {
        getAddress: jest.fn().mockResolvedValue('0xthrow'),
        channels: jest.fn().mockRejectedValue(new Error('network error')),
      } as unknown as ethers.Contract;

      // Clear cache and set throwing contract first, then working contract
      (sdk as any).tokenNetworkCache.clear();
      (sdk as any).tokenNetworkCache.set('throwing', throwingContract);
      (sdk as any).tokenNetworkCache.set('working', mockTokenNetworkContract);

      // signBalanceProof should catch the error, continue (line 540), then find the working contract
      const sig = await sdk.signBalanceProof(mockChannelId, 1, 100n);
      expect(sig).toBeDefined();
    });
  });

  // ==========================================================================
  // 7. verifyBalanceProof
  // ==========================================================================

  describe('verifyBalanceProof', () => {
    beforeEach(async () => {
      await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n);
      jest.clearAllMocks();
    });

    it('should return true for valid signature', async () => {
      const bp: BalanceProof = {
        channelId: mockChannelId,
        nonce: 1,
        transferredAmount: 100n,
        lockedAmount: 0n,
        locksRoot: ethers.ZeroHash,
      };
      const isValid = await sdk.verifyBalanceProof(bp, '0xgoodsig', mockPeerAddress);
      expect(isValid).toBe(true);
    });

    it('should return false for invalid signature (wrong signer)', async () => {
      (ethers.verifyTypedData as jest.Mock).mockReturnValueOnce('0xbadaddress');
      const bp: BalanceProof = {
        channelId: mockChannelId,
        nonce: 1,
        transferredAmount: 100n,
        lockedAmount: 0n,
        locksRoot: ethers.ZeroHash,
      };
      const isValid = await sdk.verifyBalanceProof(bp, '0xbadsig', mockPeerAddress);
      expect(isValid).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Balance proof verification failed',
        expect.any(Object)
      );
    });

    it('should return false when TokenNetwork cannot be determined', async () => {
      (sdk as any).tokenNetworkCache.clear();
      const bp: BalanceProof = {
        channelId: mockChannelId,
        nonce: 1,
        transferredAmount: 100n,
        lockedAmount: 0n,
        locksRoot: ethers.ZeroHash,
      };
      const isValid = await sdk.verifyBalanceProof(bp, '0xgoodsig', mockPeerAddress);
      expect(isValid).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Cannot determine TokenNetwork for balance proof verification',
        expect.any(Object)
      );
    });

    it('should return false on verification error', async () => {
      (ethers.verifyTypedData as jest.Mock).mockImplementationOnce(() => {
        throw new Error('bad sig');
      });
      const bp: BalanceProof = {
        channelId: mockChannelId,
        nonce: 1,
        transferredAmount: 100n,
        lockedAmount: 0n,
        locksRoot: ethers.ZeroHash,
      };
      const isValid = await sdk.verifyBalanceProof(bp, '0xbad', mockPeerAddress);
      expect(isValid).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Balance proof verification error',
        expect.any(Object)
      );
    });

    it('should continue iteration if channels() throws for a cached contract', async () => {
      const throwingContract = {
        getAddress: jest.fn().mockResolvedValue('0xthrow'),
        channels: jest.fn().mockRejectedValue(new Error('network error')),
      } as unknown as ethers.Contract;

      // Clear cache and set throwing contract first, then working contract
      (sdk as any).tokenNetworkCache.clear();
      (sdk as any).tokenNetworkCache.set('throwing', throwingContract);
      (sdk as any).tokenNetworkCache.set('working', mockTokenNetworkContract);

      const bp: BalanceProof = {
        channelId: mockChannelId,
        nonce: 1,
        transferredAmount: 100n,
        lockedAmount: 0n,
        locksRoot: ethers.ZeroHash,
      };

      // Should catch error, continue (line 612), then verify with working contract
      const isValid = await sdk.verifyBalanceProof(bp, '0xgoodsig', mockPeerAddress);
      expect(isValid).toBe(true);
    });
  });

  // ==========================================================================
  // 8. closeChannel
  // ==========================================================================

  describe('closeChannel', () => {
    beforeEach(async () => {
      await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n);
      jest.clearAllMocks();
    });

    it('should close an opened channel', async () => {
      (mockProvider.getBlock as jest.Mock).mockResolvedValueOnce({
        timestamp: Math.floor(Date.now() / 1000),
      });

      await sdk.closeChannel(mockChannelId, mockTokenAddress);
      expect(mockTokenNetworkContract.closeChannel).toHaveBeenCalledWith(mockChannelId);
    });

    it('should throw if channel is not opened', async () => {
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockKeyManager,
        mockEvmKeyId,
        mockRegistryAddress,
        mockLogger
      );

      mockTokenNetworkContract.channels?.mockResolvedValueOnce({
        settlementTimeout: 3600n,
        state: 2,
        closedAt: BigInt(Math.floor(Date.now() / 1000)),
        openedAt: BigInt(Math.floor(Date.now() / 1000) - 3600),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });

      await expect(freshSDK.closeChannel(mockChannelId, mockTokenAddress)).rejects.toThrow(
        'Cannot close channel in status: closed'
      );
    });

    it('should update cache when cache exists', async () => {
      (mockProvider.getBlock as jest.Mock).mockResolvedValueOnce({
        timestamp: Math.floor(Date.now() / 1000),
      });

      await sdk.closeChannel(mockChannelId, mockTokenAddress);
      const state = await sdk.getChannelState(mockChannelId, mockTokenAddress);
      expect(state.status).toBe('closed');
    });
  });

  // ==========================================================================
  // 9. claimFromChannel
  // ==========================================================================

  describe('claimFromChannel', () => {
    beforeEach(async () => {
      await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n);
      jest.clearAllMocks();
    });

    it('should claim from opened channel', async () => {
      const bp: BalanceProof = {
        channelId: mockChannelId,
        nonce: 1,
        transferredAmount: 100n,
        lockedAmount: 0n,
        locksRoot: ethers.ZeroHash,
      };

      await sdk.claimFromChannel(mockChannelId, mockTokenAddress, bp, '0xsig');
      expect(mockTokenNetworkContract.claimFromChannel).toHaveBeenCalledWith(
        mockChannelId,
        bp,
        '0xsig'
      );
      // Cache should be deleted
      expect((sdk as any).channelStateCache.has(mockChannelId)).toBe(false);
    });

    it('should claim from closed channel', async () => {
      // Close the channel first
      (mockProvider.getBlock as jest.Mock).mockResolvedValueOnce({
        timestamp: Math.floor(Date.now() / 1000),
      });
      await sdk.closeChannel(mockChannelId, mockTokenAddress);
      jest.clearAllMocks();

      const bp: BalanceProof = {
        channelId: mockChannelId,
        nonce: 1,
        transferredAmount: 100n,
        lockedAmount: 0n,
        locksRoot: ethers.ZeroHash,
      };

      // Mock channels for getChannelState to return closed
      mockTokenNetworkContract.channels?.mockResolvedValueOnce({
        settlementTimeout: 3600n,
        state: 2,
        closedAt: BigInt(Math.floor(Date.now() / 1000)),
        openedAt: BigInt(Math.floor(Date.now() / 1000) - 3600),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });
      mockTokenNetworkContract.participants?.mockResolvedValueOnce({
        deposit: 1000000n,
        nonce: 0n,
        transferredAmount: 0n,
      });
      mockTokenNetworkContract.participants?.mockResolvedValueOnce({
        deposit: 1000000n,
        nonce: 0n,
        transferredAmount: 0n,
      });

      await sdk.claimFromChannel(mockChannelId, mockTokenAddress, bp, '0xsig');
      expect(mockTokenNetworkContract.claimFromChannel).toHaveBeenCalled();
    });

    it('should throw if channel is settled', async () => {
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockKeyManager,
        mockEvmKeyId,
        mockRegistryAddress,
        mockLogger
      );

      mockTokenNetworkContract.channels?.mockResolvedValueOnce({
        settlementTimeout: 3600n,
        state: 3,
        closedAt: 0n,
        openedAt: BigInt(Math.floor(Date.now() / 1000) - 7200),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });

      const bp: BalanceProof = {
        channelId: mockChannelId,
        nonce: 1,
        transferredAmount: 100n,
        lockedAmount: 0n,
        locksRoot: ethers.ZeroHash,
      };

      await expect(
        freshSDK.claimFromChannel(mockChannelId, mockTokenAddress, bp, '0xsig')
      ).rejects.toThrow('Cannot claim from channel in status: settled');
    });
  });

  // ==========================================================================
  // 10. getClaimedAmount
  // ==========================================================================

  describe('getClaimedAmount', () => {
    it('should return claimed amount', async () => {
      const amount = await sdk.getClaimedAmount(mockChannelId, mockTokenAddress, mockMyAddress);
      expect(amount).toBe(5000n);
      expect(mockTokenNetworkContract.claimedAmounts).toHaveBeenCalledWith(
        mockChannelId,
        mockMyAddress
      );
    });
  });

  // ==========================================================================
  // 11. settleChannel
  // ==========================================================================

  describe('settleChannel', () => {
    it('should settle channel after challenge period expires', async () => {
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockKeyManager,
        mockEvmKeyId,
        mockRegistryAddress,
        mockLogger
      );

      const closedAt = Math.floor(Date.now() / 1000) - 7200;
      mockTokenNetworkContract.channels?.mockResolvedValue({
        settlementTimeout: 3600n,
        state: 2,
        closedAt: BigInt(closedAt),
        openedAt: BigInt(closedAt - 3600),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });

      (mockProvider.getBlock as jest.Mock).mockResolvedValue({
        timestamp: Math.floor(Date.now() / 1000),
      });

      await freshSDK.settleChannel(mockChannelId, mockTokenAddress);
      expect(mockTokenNetworkContract.settleChannel).toHaveBeenCalledWith(mockChannelId);
    });

    it('should throw ChallengeNotExpiredError if challenge not expired', async () => {
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockKeyManager,
        mockEvmKeyId,
        mockRegistryAddress,
        mockLogger
      );

      const closedAt = Math.floor(Date.now() / 1000) - 1800;
      mockTokenNetworkContract.channels?.mockResolvedValue({
        settlementTimeout: 3600n,
        state: 2,
        closedAt: BigInt(closedAt),
        openedAt: BigInt(closedAt - 3600),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });

      (mockProvider.getBlock as jest.Mock).mockResolvedValue({
        timestamp: Math.floor(Date.now() / 1000),
      });

      await expect(freshSDK.settleChannel(mockChannelId, mockTokenAddress)).rejects.toThrow(
        ChallengeNotExpiredError
      );
    });

    it('should throw if channel is not closed', async () => {
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockKeyManager,
        mockEvmKeyId,
        mockRegistryAddress,
        mockLogger
      );

      mockTokenNetworkContract.channels?.mockResolvedValue({
        settlementTimeout: 3600n,
        state: 1,
        closedAt: 0n,
        openedAt: BigInt(Math.floor(Date.now() / 1000)),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });

      await expect(freshSDK.settleChannel(mockChannelId, mockTokenAddress)).rejects.toThrow(
        'Cannot settle channel in status: opened'
      );
    });

    it('should throw if closedAt is missing', async () => {
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockKeyManager,
        mockEvmKeyId,
        mockRegistryAddress,
        mockLogger
      );

      mockTokenNetworkContract.channels?.mockResolvedValue({
        settlementTimeout: 3600n,
        state: 2,
        closedAt: 0n,
        openedAt: BigInt(Math.floor(Date.now() / 1000) - 3600),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });

      await expect(freshSDK.settleChannel(mockChannelId, mockTokenAddress)).rejects.toThrow(
        'Channel closedAt timestamp is missing'
      );
    });

    it('should update cache if exists', async () => {
      // Open then close to populate cache
      await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n);
      jest.clearAllMocks();

      (mockProvider.getBlock as jest.Mock).mockResolvedValueOnce({
        timestamp: Math.floor(Date.now() / 1000),
      });
      await sdk.closeChannel(mockChannelId, mockTokenAddress);
      jest.clearAllMocks();

      // Clear cache so settleChannel queries fresh state with old closedAt
      (sdk as any).channelStateCache.delete(mockChannelId);

      // Now settle - need enough time passed
      const closedAt = Math.floor(Date.now() / 1000) - 7200;
      mockTokenNetworkContract.channels?.mockResolvedValue({
        settlementTimeout: 3600n,
        state: 2,
        closedAt: BigInt(closedAt),
        openedAt: BigInt(closedAt - 3600),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });
      mockTokenNetworkContract.participants?.mockResolvedValue({
        deposit: 0n,
        nonce: 0n,
        transferredAmount: 0n,
      });

      (mockProvider.getBlock as jest.Mock).mockResolvedValue({
        timestamp: Math.floor(Date.now() / 1000),
      });

      await sdk.settleChannel(mockChannelId, mockTokenAddress);
      const state = await sdk.getChannelState(mockChannelId, mockTokenAddress);
      // After settle, cache should be updated to settled
      expect(state.status).toBe('settled');
    });
  });

  // ==========================================================================
  // 12. getChannelState
  // ==========================================================================

  describe('getChannelState', () => {
    it('should return cached state if available', async () => {
      await sdk.openChannel(mockPeerAddress, mockTokenAddress, 3600, 0n);
      jest.clearAllMocks();

      // Second call should use cache
      const state = await sdk.getChannelState(mockChannelId, mockTokenAddress);
      expect(state.status).toBe('opened');
      expect(mockTokenNetworkContract.channels).not.toHaveBeenCalled();
    });

    it('should query blockchain when cache miss (state 0)', async () => {
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockKeyManager,
        mockEvmKeyId,
        mockRegistryAddress,
        mockLogger
      );

      mockTokenNetworkContract.channels?.mockResolvedValueOnce({
        settlementTimeout: 3600n,
        state: 0,
        closedAt: 0n,
        openedAt: 0n,
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });
      mockTokenNetworkContract.participants?.mockResolvedValue({
        deposit: 0n,
        nonce: 0n,
        transferredAmount: 0n,
      });

      const state = await freshSDK.getChannelState(mockChannelId, mockTokenAddress);
      expect(state.status).toBe('settled');
    });

    it('should query blockchain when cache miss (state 1 opened)', async () => {
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockKeyManager,
        mockEvmKeyId,
        mockRegistryAddress,
        mockLogger
      );

      mockTokenNetworkContract.channels?.mockResolvedValueOnce({
        settlementTimeout: 3600n,
        state: 1,
        closedAt: 0n,
        openedAt: BigInt(Math.floor(Date.now() / 1000)),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });
      mockTokenNetworkContract.participants?.mockResolvedValue({
        deposit: 100n,
        nonce: 1n,
        transferredAmount: 50n,
      });

      const state = await freshSDK.getChannelState(mockChannelId, mockTokenAddress);
      expect(state.status).toBe('opened');
    });

    it('should query blockchain when cache miss (state 2 closed)', async () => {
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockKeyManager,
        mockEvmKeyId,
        mockRegistryAddress,
        mockLogger
      );

      mockTokenNetworkContract.channels?.mockResolvedValueOnce({
        settlementTimeout: 3600n,
        state: 2,
        closedAt: BigInt(Math.floor(Date.now() / 1000) - 1800),
        openedAt: BigInt(Math.floor(Date.now() / 1000) - 5400),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });
      mockTokenNetworkContract.participants?.mockResolvedValue({
        deposit: 100n,
        nonce: 1n,
        transferredAmount: 50n,
      });

      const state = await freshSDK.getChannelState(mockChannelId, mockTokenAddress);
      expect(state.status).toBe('closed');
      expect(state.closedAt).toBeDefined();
    });

    it('should query blockchain when cache miss (state 3 settled)', async () => {
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockKeyManager,
        mockEvmKeyId,
        mockRegistryAddress,
        mockLogger
      );

      mockTokenNetworkContract.channels?.mockResolvedValueOnce({
        settlementTimeout: 3600n,
        state: 3,
        closedAt: BigInt(Math.floor(Date.now() / 1000) - 1800),
        openedAt: BigInt(Math.floor(Date.now() / 1000) - 5400),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });
      mockTokenNetworkContract.participants?.mockResolvedValue({
        deposit: 100n,
        nonce: 1n,
        transferredAmount: 50n,
      });

      const state = await freshSDK.getChannelState(mockChannelId, mockTokenAddress);
      expect(state.status).toBe('settled');
    });

    it('should map unknown state to settled', async () => {
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockKeyManager,
        mockEvmKeyId,
        mockRegistryAddress,
        mockLogger
      );

      mockTokenNetworkContract.channels?.mockResolvedValueOnce({
        settlementTimeout: 3600n,
        state: 99, // Unknown state
        closedAt: 0n,
        openedAt: BigInt(Math.floor(Date.now() / 1000)),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });
      mockTokenNetworkContract.participants?.mockResolvedValue({
        deposit: 0n,
        nonce: 0n,
        transferredAmount: 0n,
      });

      const state = await freshSDK.getChannelState(mockChannelId, mockTokenAddress);
      expect(state.status).toBe('settled');
    });

    it('should identify participant1 as self', async () => {
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockKeyManager,
        mockEvmKeyId,
        mockRegistryAddress,
        mockLogger
      );

      mockTokenNetworkContract.channels?.mockResolvedValueOnce({
        settlementTimeout: 3600n,
        state: 1,
        closedAt: 0n,
        openedAt: BigInt(Math.floor(Date.now() / 1000)),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });
      mockTokenNetworkContract.participants?.mockResolvedValue({
        deposit: 100n,
        nonce: 1n,
        transferredAmount: 50n,
      });

      const state = await freshSDK.getChannelState(mockChannelId, mockTokenAddress);
      expect(state.participants).toEqual([mockMyAddress, mockPeerAddress]);
    });

    it('should identify participant2 as self', async () => {
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockKeyManager,
        mockEvmKeyId,
        mockRegistryAddress,
        mockLogger
      );

      mockTokenNetworkContract.channels?.mockResolvedValueOnce({
        settlementTimeout: 3600n,
        state: 1,
        closedAt: 0n,
        openedAt: BigInt(Math.floor(Date.now() / 1000)),
        participant1: mockPeerAddress,
        participant2: mockMyAddress,
      });
      mockTokenNetworkContract.participants?.mockResolvedValue({
        deposit: 100n,
        nonce: 1n,
        transferredAmount: 50n,
      });

      const state = await freshSDK.getChannelState(mockChannelId, mockTokenAddress);
      expect(state.participants).toEqual([mockPeerAddress, mockMyAddress]);
    });

    it('should handle closedAt = 0', async () => {
      const freshSDK = new PaymentChannelSDK(
        mockProvider,
        mockKeyManager,
        mockEvmKeyId,
        mockRegistryAddress,
        mockLogger
      );

      mockTokenNetworkContract.channels?.mockResolvedValueOnce({
        settlementTimeout: 3600n,
        state: 1,
        closedAt: 0n,
        openedAt: BigInt(Math.floor(Date.now() / 1000)),
        participant1: mockMyAddress,
        participant2: mockPeerAddress,
      });
      mockTokenNetworkContract.participants?.mockResolvedValue({
        deposit: 100n,
        nonce: 1n,
        transferredAmount: 50n,
      });

      const state = await freshSDK.getChannelState(mockChannelId, mockTokenAddress);
      expect(state.closedAt).toBeUndefined();
    });
  });

  // ==========================================================================
  // 13. getChannelStateByNetwork
  // ==========================================================================

  describe('getChannelStateByNetwork', () => {
    it('should return exists:true for valid channel', async () => {
      const result = await sdk.getChannelStateByNetwork(mockChannelId, mockTokenNetworkAddress);
      expect(result.exists).toBe(true);
      expect(result.state).toBe(1);
    });

    it('should return exists:false for non-existent channel', async () => {
      mockTokenNetworkContract.channels?.mockResolvedValueOnce({
        settlementTimeout: 0n,
        state: 0,
        closedAt: 0n,
        openedAt: 0n,
        participant1: ethers.ZeroAddress,
        participant2: ethers.ZeroAddress,
      });

      const result = await sdk.getChannelStateByNetwork(
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        mockTokenNetworkAddress
      );
      expect(result.exists).toBe(false);
      expect(result.state).toBe(0);
    });

    it('should throw and log error on network failure', async () => {
      mockTokenNetworkContract.channels?.mockRejectedValueOnce(new Error('rpc timeout'));

      await expect(
        sdk.getChannelStateByNetwork(mockChannelId, mockTokenNetworkAddress)
      ).rejects.toThrow('rpc timeout');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to query channel state by network',
        expect.objectContaining({ channelId: mockChannelId })
      );
    });
  });

  // ==========================================================================
  // 14. verifyBalanceProofWithDomain
  // ==========================================================================

  describe('verifyBalanceProofWithDomain', () => {
    const bp: BalanceProof = {
      channelId: mockChannelId,
      nonce: 1,
      transferredAmount: 100n,
      lockedAmount: 0n,
      locksRoot: ethers.ZeroHash,
    };

    it('should return true for valid domain and signature', async () => {
      const result = await sdk.verifyBalanceProofWithDomain(
        bp,
        '0xgoodsig',
        mockPeerAddress,
        8453,
        mockTokenNetworkAddress
      );
      expect(result).toBe(true);
    });

    it('should return false for invalid signer', async () => {
      (ethers.verifyTypedData as jest.Mock).mockReturnValueOnce('0xbadaddr');
      const result = await sdk.verifyBalanceProofWithDomain(
        bp,
        '0xbadsig',
        mockPeerAddress,
        8453,
        mockTokenNetworkAddress
      );
      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Balance proof verification with explicit domain failed',
        expect.any(Object)
      );
    });

    it('should return false on verification error', async () => {
      (ethers.verifyTypedData as jest.Mock).mockImplementationOnce(() => {
        throw new Error('bad format');
      });
      const result = await sdk.verifyBalanceProofWithDomain(
        bp,
        '0xbad',
        mockPeerAddress,
        8453,
        mockTokenNetworkAddress
      );
      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Balance proof verification with explicit domain error',
        expect.any(Object)
      );
    });
  });

  // ==========================================================================
  // 15. getMyChannels
  // ==========================================================================

  describe('getMyChannels', () => {
    it('should return channels where I am participant1', async () => {
      const event1 = {
        args: [mockChannelId, mockMyAddress, mockPeerAddress],
      } as unknown as ethers.EventLog;

      mockTokenNetworkContract.queryFilter?.mockResolvedValueOnce([event1]);

      const channels = await sdk.getMyChannels(mockTokenAddress);
      expect(channels).toContain(mockChannelId);
    });

    it('should return channels where I am participant2', async () => {
      const event1 = {
        args: [mockChannelId, mockPeerAddress, mockMyAddress],
      } as unknown as ethers.EventLog;

      mockTokenNetworkContract.queryFilter?.mockResolvedValueOnce([event1]);

      const channels = await sdk.getMyChannels(mockTokenAddress);
      expect(channels).toContain(mockChannelId);
    });

    it('should exclude channels where I am not a participant', async () => {
      const event1 = {
        args: [mockChannelId, mockPeerAddress, '0x3333333333333333333333333333333333333333'],
      } as unknown as ethers.EventLog;

      mockTokenNetworkContract.queryFilter?.mockResolvedValueOnce([event1]);

      const channels = await sdk.getMyChannels(mockTokenAddress);
      expect(channels).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 16. Event Listeners
  // ==========================================================================

  describe('event listeners', () => {
    beforeEach(async () => {
      await sdk.getTokenNetworkAddress(mockTokenAddress);
      jest.clearAllMocks();
    });

    it('should register ChannelOpened listener and callback fires with cache update', async () => {
      const callback = jest.fn();
      await sdk.onChannelOpened(mockTokenAddress, callback);

      expect(mockTokenNetworkContract.on).toHaveBeenCalledWith(
        'ChannelOpened',
        expect.any(Function)
      );

      // Extract and invoke the listener
      const listener = (mockTokenNetworkContract.on as jest.Mock).mock.calls[0][1];
      listener(mockChannelId, mockMyAddress, mockPeerAddress, 3600n);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ChannelOpened',
          channelId: mockChannelId,
        })
      );
      expect((sdk as any).channelStateCache.has(mockChannelId)).toBe(true);
    });

    it('should add multiple listeners for same event key', async () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      await sdk.onChannelOpened(mockTokenAddress, callback1);
      await sdk.onChannelOpened(mockTokenAddress, callback2);

      const listeners = (sdk as any).eventListeners.get(`${mockTokenAddress}:ChannelOpened`);
      expect(listeners).toHaveLength(2);
    });

    it('should register ChannelClosed listener and update cache if exists', async () => {
      // Pre-populate cache
      (sdk as any).channelStateCache.set(mockChannelId, {
        channelId: mockChannelId,
        status: 'opened',
      });

      const callback = jest.fn();
      await sdk.onChannelClosed(mockTokenAddress, callback);

      const listener = (mockTokenNetworkContract.on as jest.Mock).mock.calls[0][1];
      listener(mockChannelId, mockMyAddress, 1n, '0xhash');

      expect(callback).toHaveBeenCalled();
      const cached = (sdk as any).channelStateCache.get(mockChannelId);
      expect(cached.status).toBe('closed');
    });

    it('should register ChannelClosed listener and skip cache update if missing', async () => {
      const callback = jest.fn();
      await sdk.onChannelClosed(mockTokenAddress, callback);

      const listener = (mockTokenNetworkContract.on as jest.Mock).mock.calls[0][1];
      // No cache entry for this channel
      listener('0xunknown', mockMyAddress, 1n, '0xhash');

      expect(callback).toHaveBeenCalled();
      // Should not throw
    });

    it('should register ChannelSettled listener and update cache if exists', async () => {
      (sdk as any).channelStateCache.set(mockChannelId, {
        channelId: mockChannelId,
        status: 'closed',
      });

      const callback = jest.fn();
      await sdk.onChannelSettled(mockTokenAddress, callback);

      const listener = (mockTokenNetworkContract.on as jest.Mock).mock.calls[0][1];
      listener(mockChannelId, 500n, 500n);

      expect(callback).toHaveBeenCalled();
      const cached = (sdk as any).channelStateCache.get(mockChannelId);
      expect(cached.status).toBe('settled');
    });

    it('should register ChannelSettled listener and skip cache update if missing', async () => {
      const callback = jest.fn();
      await sdk.onChannelSettled(mockTokenAddress, callback);

      const listener = (mockTokenNetworkContract.on as jest.Mock).mock.calls[0][1];
      listener('0xunknown', 500n, 500n);

      expect(callback).toHaveBeenCalled();
    });

    it('should register ChannelCooperativeSettled listener and update cache if exists', async () => {
      (sdk as any).channelStateCache.set(mockChannelId, {
        channelId: mockChannelId,
        status: 'closed',
      });

      const callback = jest.fn();
      await sdk.onChannelCooperativeSettled(mockTokenAddress, callback);

      const listener = (mockTokenNetworkContract.on as jest.Mock).mock.calls[0][1];
      listener(mockChannelId, 500n, 500n);

      expect(callback).toHaveBeenCalled();
      const cached = (sdk as any).channelStateCache.get(mockChannelId);
      expect(cached.status).toBe('settled');
    });

    it('should register ChannelCooperativeSettled listener and skip cache update if missing', async () => {
      const callback = jest.fn();
      await sdk.onChannelCooperativeSettled(mockTokenAddress, callback);

      const listener = (mockTokenNetworkContract.on as jest.Mock).mock.calls[0][1];
      listener('0xunknown', 500n, 500n);

      expect(callback).toHaveBeenCalled();
    });

    it('should remove all listeners', () => {
      sdk.removeAllListeners();
      expect(mockTokenNetworkContract.removeAllListeners).toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith('All event listeners removed');
    });
  });

  // ==========================================================================
  // 17. ChallengeNotExpiredError
  // ==========================================================================

  describe('ChallengeNotExpiredError', () => {
    it('should contain channelId, closedAt, and settlementTimeout', () => {
      const err = new ChallengeNotExpiredError('Not expired', mockChannelId, 1000, 3600);
      expect(err.channelId).toBe(mockChannelId);
      expect(err.closedAt).toBe(1000);
      expect(err.settlementTimeout).toBe(3600);
      expect(err.name).toBe('ChallengeNotExpiredError');
    });
  });
});
