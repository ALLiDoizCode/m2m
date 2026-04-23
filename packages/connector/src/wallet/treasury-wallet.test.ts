/**
 * Unit tests for TreasuryWallet
 */
import { TreasuryWallet } from './treasury-wallet';

// Mock the optional-require utility
jest.mock('../utils/optional-require', () => ({
  requireOptional: jest.fn().mockResolvedValue({
    ethers: {
      Wallet: jest.fn().mockImplementation((_privateKey: string, _provider: unknown) => ({
        address: '0xTreasuryAddress',
        sendTransaction: jest.fn().mockResolvedValue({
          hash: '0xtxhash',
          to: '0xrecipient',
        }),
      })),
      isAddress: jest.fn().mockReturnValue(true),
    },
  }),
}));

describe('TreasuryWallet', () => {
  const mockProvider = {
    getTransactionCount: jest.fn().mockResolvedValue(5),
    getFeeData: jest.fn().mockResolvedValue({
      maxFeePerGas: BigInt(1000000000),
      maxPriorityFeePerGas: BigInt(2000000000),
    }),
    getBalance: jest.fn().mockResolvedValue(BigInt(10000)),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should throw when private key is empty', () => {
    expect(() => new TreasuryWallet('', mockProvider as any)).toThrow(
      'Treasury private key is required'
    );
  });

  it('should store config without immediate wallet initialization', () => {
    const wallet = new TreasuryWallet('0x' + 'a'.repeat(64), mockProvider as any);
    expect(wallet.evmAddress).toBe('');
  });

  it('should initialize wallet lazily on first use', async () => {
    const wallet = new TreasuryWallet('0x' + 'a'.repeat(64), mockProvider as any);
    const { requireOptional } = await import('../utils/optional-require');

    // Access private method for testing
    const ensureInitialized = (wallet as any).ensureEvmInitialized.bind(wallet);
    const result = await ensureInitialized();

    expect(requireOptional).toHaveBeenCalledWith('ethers', 'EVM settlement');
    expect(result.address).toBe('0xTreasuryAddress');
  });

  it('should handle initialization error when ethers is missing', async () => {
    const { requireOptional } = await import('../utils/optional-require');
    (requireOptional as jest.Mock).mockRejectedValueOnce(
      new Error('ethers is required for EVM settlement')
    );

    const wallet = new TreasuryWallet('0x' + 'a'.repeat(64), mockProvider as any);
    const ensureInitialized = (wallet as any).ensureEvmInitialized.bind(wallet);

    await expect(ensureInitialized()).rejects.toThrow('ethers is required for EVM settlement');
  });

  it('should handle generic initialization error', async () => {
    const { requireOptional } = await import('../utils/optional-require');
    (requireOptional as jest.Mock).mockRejectedValueOnce(new Error('network error'));

    const wallet = new TreasuryWallet('0x' + 'a'.repeat(64), mockProvider as any);
    const ensureInitialized = (wallet as any).ensureEvmInitialized.bind(wallet);

    await expect(ensureInitialized()).rejects.toThrow('Failed to initialize treasury EVM wallet');
  });

  it('should get next nonce serially', async () => {
    const wallet = new TreasuryWallet('0x' + 'a'.repeat(64), mockProvider as any);

    const nonce1 = await (wallet as any).getNextNonce();
    expect(nonce1).toBe(5);
    expect(mockProvider.getTransactionCount).toHaveBeenCalledWith('', 'pending');

    const nonce2 = await (wallet as any).getNextNonce();
    expect(nonce2).toBe(6);
  });

  it('should reset nonce promise on ETH send error', async () => {
    const wallet = new TreasuryWallet('0x' + 'a'.repeat(64), mockProvider as any);
    mockProvider.getFeeData.mockRejectedValueOnce(new Error('network down'));

    await expect(wallet.sendETH('0xRecipient', BigInt(1000))).rejects.toThrow('network down');

    // After error, noncePromise should be reset
    expect((wallet as any).noncePromise).toBeNull();
  });

  it('should throw on invalid recipient address', async () => {
    const { requireOptional } = await import('../utils/optional-require');
    (requireOptional as jest.Mock).mockResolvedValueOnce({
      ethers: {
        Wallet: jest.fn().mockImplementation(() => ({
          address: '0xTreasuryAddress',
        })),
        isAddress: jest.fn().mockReturnValue(false),
      },
    });

    const wallet = new TreasuryWallet('0x' + 'a'.repeat(64), mockProvider as any);
    await expect(wallet.sendETH('invalid-address', BigInt(1000))).rejects.toThrow(
      'Invalid EVM address: invalid-address'
    );
  });

  it('should send ETH successfully', async () => {
    const mockTx = { hash: '0xtxhash', to: '0xrecipient' };
    const { requireOptional } = await import('../utils/optional-require');
    (requireOptional as jest.Mock).mockResolvedValueOnce({
      ethers: {
        Wallet: jest.fn().mockImplementation(() => ({
          address: '0xTreasuryAddress',
          sendTransaction: jest.fn().mockResolvedValue(mockTx),
        })),
        isAddress: jest.fn().mockReturnValue(true),
      },
    });

    const wallet = new TreasuryWallet('0x' + 'a'.repeat(64), mockProvider as any);
    const result = await wallet.sendETH('0xRecipient', BigInt(1000));
    expect(result.hash).toBe('0xtxhash');
    expect(result.to).toBe('0xrecipient');
  });

  it('should send ERC20 successfully', async () => {
    const mockTx = { hash: '0xerc20tx', to: '0xrecipient' };
    const { requireOptional } = await import('../utils/optional-require');
    (requireOptional as jest.Mock).mockResolvedValueOnce({
      ethers: {
        Wallet: jest.fn().mockImplementation(() => ({
          address: '0xTreasuryAddress',
        })),
        Contract: jest.fn().mockImplementation(() => ({
          transfer: jest.fn().mockResolvedValue(mockTx),
        })),
        isAddress: jest.fn().mockReturnValue(true),
      },
    });

    const wallet = new TreasuryWallet('0x' + 'a'.repeat(64), mockProvider as any);
    const result = await wallet.sendERC20('0xRecipient', '0xToken', BigInt(500));
    expect(result.hash).toBe('0xerc20tx');
  });

  it('should throw on invalid recipient for ERC20', async () => {
    const { requireOptional } = await import('../utils/optional-require');
    (requireOptional as jest.Mock).mockResolvedValueOnce({
      ethers: {
        Wallet: jest.fn().mockImplementation(() => ({
          address: '0xTreasuryAddress',
        })),
        isAddress: jest.fn().mockImplementation((addr: string) => addr === '0xToken'),
      },
    });

    const wallet = new TreasuryWallet('0x' + 'a'.repeat(64), mockProvider as any);
    await expect(wallet.sendERC20('bad-addr', '0xToken', BigInt(100))).rejects.toThrow(
      'Invalid recipient address: bad-addr'
    );
  });

  it('should throw on invalid token address for ERC20', async () => {
    const { requireOptional } = await import('../utils/optional-require');
    (requireOptional as jest.Mock).mockResolvedValueOnce({
      ethers: {
        Wallet: jest.fn().mockImplementation(() => ({
          address: '0xTreasuryAddress',
        })),
        isAddress: jest.fn().mockImplementation((addr: string) => addr === '0xRecipient'),
      },
    });

    const wallet = new TreasuryWallet('0x' + 'a'.repeat(64), mockProvider as any);
    await expect(wallet.sendERC20('0xRecipient', 'bad-token', BigInt(100))).rejects.toThrow(
      'Invalid token address: bad-token'
    );
  });

  it('should get ETH balance', async () => {
    const { requireOptional } = await import('../utils/optional-require');
    (requireOptional as jest.Mock).mockResolvedValueOnce({
      ethers: {
        Wallet: jest.fn().mockImplementation(() => ({
          address: '0xTreasuryAddress',
        })),
      },
    });

    const wallet = new TreasuryWallet('0x' + 'a'.repeat(64), mockProvider as any);
    // Initialize wallet first
    await (wallet as any).ensureEvmInitialized();
    const balance = await wallet.getBalance('ETH');
    expect(balance).toBe(BigInt(10000));
    expect(mockProvider.getBalance).toHaveBeenCalledWith('0xTreasuryAddress');
  });

  it('should get ERC20 balance', async () => {
    const { requireOptional } = await import('../utils/optional-require');
    (requireOptional as jest.Mock).mockResolvedValueOnce({
      ethers: {
        Wallet: jest.fn().mockImplementation(() => ({
          address: '0xTreasuryAddress',
        })),
        Contract: jest.fn().mockImplementation(() => ({
          balanceOf: jest.fn().mockResolvedValue(BigInt(999)),
        })),
        isAddress: jest.fn().mockReturnValue(true),
      },
    });

    const wallet = new TreasuryWallet('0x' + 'a'.repeat(64), mockProvider as any);
    const balance = await wallet.getBalance('0xTokenAddress');
    expect(balance).toBe(BigInt(999));
  });

  it('should throw on invalid token address for balance', async () => {
    const { requireOptional } = await import('../utils/optional-require');
    (requireOptional as jest.Mock).mockResolvedValueOnce({
      ethers: {
        Wallet: jest.fn().mockImplementation(() => ({
          address: '0xTreasuryAddress',
        })),
        isAddress: jest.fn().mockReturnValue(false),
      },
    });

    const wallet = new TreasuryWallet('0x' + 'a'.repeat(64), mockProvider as any);
    await expect(wallet.getBalance('not-an-address')).rejects.toThrow(
      'Invalid token address: not-an-address'
    );
  });
});
