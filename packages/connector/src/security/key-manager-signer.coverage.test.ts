/**
 * Branch Coverage Tests for key-manager-signer.ts
 *
 * Covers all branches of the createKeyManagerSigner factory and KeyManagerSignerImpl:
 * 1. getAddress() cached hit vs miss
 * 2. getAddress() public key with 0x04 prefix vs without
 * 3. signTransaction() full flow
 * 4. sendTransaction() no provider → throw
 * 5. sendTransaction() fee data missing maxFeePerGas/maxPriorityFeePerGas → throw
 * 6. sendTransaction() nonce provided vs fetched
 * 7. sendTransaction() gasLimit provided vs estimated
 * 8. sendTransaction() chainId provided vs from network
 * 9. signMessage() string vs Uint8Array
 * 10. signTypedData() full flow
 * 11. connect(provider) returns new instance
 *
 * @module key-manager-signer.coverage.test
 */

import type { KeyManager } from './key-manager';
import type { Provider, TransactionRequest, TransactionResponse } from 'ethers';

// ---------------------------------------------------------------------------
// Mock ethers via optional-require (doMock — not hoisted, so we require after mocking)
// ---------------------------------------------------------------------------

const mockSignature = {
  r: '0x' + 'aa'.repeat(32),
  s: '0x' + 'bb'.repeat(32),
  v: 27,
};

const mockTx = {
  unsignedHash: '0x' + 'cc'.repeat(32),
  signature: undefined as any,
  serialized: '0x' + 'dd'.repeat(64),
};

const mockEthers = {
  AbstractSigner: class AbstractSigner {
    provider?: Provider;
    constructor(provider?: Provider) {
      this.provider = provider;
    }
  },
  keccak256: jest.fn().mockReturnValue('0x' + 'ee'.repeat(32)),
  getAddress: jest.fn().mockImplementation((addr: string) => addr.toLowerCase()),
  resolveProperties: jest.fn().mockImplementation(async (obj: any) => obj),
  Transaction: {
    from: jest.fn().mockReturnValue(mockTx),
  },
  Signature: {
    from: jest.fn().mockReturnValue(mockSignature),
  },
  hashMessage: jest.fn().mockReturnValue('0x' + 'ff'.repeat(32)),
  TypedDataEncoder: {
    hash: jest.fn().mockReturnValue('0x' + '11'.repeat(32)),
  },
  toUtf8Bytes: jest.fn().mockImplementation((str: string) => Buffer.from(str, 'utf8')),
  id: jest.fn().mockReturnValue('0x' + '22'.repeat(32)),
  ZeroAddress: '0x' + '00'.repeat(20),
  toBeArray: jest
    .fn()
    .mockImplementation((val: any) => Buffer.from(val.toString(16).padStart(2, '0'), 'hex')),
  toBigInt: jest.fn().mockImplementation((val: any) => BigInt(val)),
  getBytes: jest.fn().mockImplementation((val: any) => {
    if (typeof val === 'string' && val.startsWith('0x')) {
      return Buffer.from(val.slice(2), 'hex');
    }
    return Buffer.from(val);
  }),
};

// We'll dynamically require the module under test after mocking
let createKeyManagerSigner: typeof import('./key-manager-signer').createKeyManagerSigner;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockKeyManager(): jest.Mocked<KeyManager> {
  return {
    sign: jest.fn().mockImplementation(async (_message: Buffer) => {
      return Buffer.from('33'.repeat(65), 'hex');
    }),
    getPublicKey: jest.fn().mockImplementation(async (_keyId: string) => {
      // Return uncompressed public key with 0x04 prefix (65 bytes)
      return Buffer.from('04' + '44'.repeat(64), 'hex');
    }),
  } as unknown as jest.Mocked<KeyManager>;
}

function createMockProvider(): jest.Mocked<Provider> {
  return {
    getNetwork: jest.fn().mockResolvedValue({ chainId: BigInt(1337) }),
    getFeeData: jest.fn().mockResolvedValue({
      maxFeePerGas: BigInt(1000000000),
      maxPriorityFeePerGas: BigInt(200000000),
    }),
    getTransactionCount: jest.fn().mockResolvedValue(42),
    estimateGas: jest.fn().mockResolvedValue(BigInt(21000)),
    broadcastTransaction: jest.fn().mockResolvedValue({
      hash: '0x' + '55'.repeat(32),
    } as unknown as TransactionResponse),
  } as unknown as jest.Mocked<Provider>;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  // Reset mutable mock state
  mockTx.signature = undefined;

  jest.doMock('../utils/optional-require', () => ({
    requireOptional: jest.fn().mockResolvedValue({ ethers: mockEthers }),
  }));

  const mod = require('./key-manager-signer');
  createKeyManagerSigner = mod.createKeyManagerSigner;
});

// ---------------------------------------------------------------------------
// Branch 1: getAddress() cached hit vs miss
// ---------------------------------------------------------------------------

describe('Branch coverage: getAddress() cached address hit vs miss', () => {
  test('getAddress returns cached address on second call (cache hit)', async () => {
    const keyManager = createMockKeyManager();
    const signer = await createKeyManagerSigner(keyManager, 'evm-key-1');

    const address1 = await signer.getAddress();
    expect(address1).toBeDefined();
    expect(keyManager.getPublicKey).toHaveBeenCalledTimes(1);

    const address2 = await signer.getAddress();
    expect(address2).toBe(address1);
    // Should not call getPublicKey again — cache hit
    expect(keyManager.getPublicKey).toHaveBeenCalledTimes(1);
  });

  test('getAddress derives address from public key on first call (cache miss)', async () => {
    const keyManager = createMockKeyManager();
    const signer = await createKeyManagerSigner(keyManager, 'evm-key-2');

    const address = await signer.getAddress();
    expect(address).toBeDefined();
    expect(keyManager.getPublicKey).toHaveBeenCalledWith('evm-key-2');
    expect(mockEthers.keccak256).toHaveBeenCalled();
    expect(mockEthers.getAddress).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Branch 2: getAddress() public key with 0x04 prefix vs without
// ---------------------------------------------------------------------------

describe('Branch coverage: getAddress() public key with 0x04 prefix vs without', () => {
  test('getAddress strips 0x04 prefix when present', async () => {
    const keyManager = createMockKeyManager();
    keyManager.getPublicKey.mockResolvedValueOnce(Buffer.from('04' + '66'.repeat(64), 'hex'));

    const signer = await createKeyManagerSigner(keyManager, 'evm-key-3');
    await signer.getAddress();

    expect(mockEthers.keccak256).toHaveBeenCalledWith('0x' + '66'.repeat(64));
  });

  test('getAddress keeps public key as-is when 0x04 prefix absent', async () => {
    const keyManager = createMockKeyManager();
    // Return 64 bytes without the 0x04 prefix
    keyManager.getPublicKey.mockResolvedValueOnce(Buffer.from('77'.repeat(64), 'hex'));

    const signer = await createKeyManagerSigner(keyManager, 'evm-key-4');
    await signer.getAddress();

    // The raw hex will be 0x + 77*64, and since it does NOT start with 0x04, it is passed through
    expect(mockEthers.keccak256).toHaveBeenCalledWith('0x' + '77'.repeat(64));
  });
});

// ---------------------------------------------------------------------------
// Branch 3: signTransaction() full flow
// ---------------------------------------------------------------------------

describe('Branch coverage: signTransaction() creates transaction, gets digest, signs, returns serialized', () => {
  test('signTransaction resolves properties, creates tx, signs, and returns serialized', async () => {
    const keyManager = createMockKeyManager();
    const signer = await createKeyManagerSigner(keyManager, 'evm-key-5');

    const txRequest: TransactionRequest = {
      to: '0x' + '88'.repeat(20),
      value: 1000,
      nonce: 5,
    };

    const serialized = await signer.signTransaction(txRequest);

    expect(mockEthers.resolveProperties).toHaveBeenCalledWith(txRequest);
    expect(mockEthers.Transaction.from).toHaveBeenCalled();
    expect(keyManager.sign).toHaveBeenCalledWith(
      Buffer.from(mockTx.unsignedHash.slice(2), 'hex'),
      'evm-key-5'
    );
    expect(mockEthers.Signature.from).toHaveBeenCalled();
    expect(serialized).toBe(mockTx.serialized);
  });
});

// ---------------------------------------------------------------------------
// Branch 4: sendTransaction() no provider → throw
// ---------------------------------------------------------------------------

describe('Branch coverage: sendTransaction() no provider → throw', () => {
  test('sendTransaction throws when provider is missing', async () => {
    const keyManager = createMockKeyManager();
    // Create signer without provider
    const signer = await createKeyManagerSigner(keyManager, 'evm-key-6');

    await expect(
      signer.sendTransaction({
        to: '0x' + '99'.repeat(20),
        value: 100,
      })
    ).rejects.toThrow('Provider required to send transaction');
  });
});

// ---------------------------------------------------------------------------
// Branch 5: sendTransaction() fee data missing maxFeePerGas/maxPriorityFeePerGas → throw
// ---------------------------------------------------------------------------

describe('Branch coverage: sendTransaction() fee data missing EIP-1559 fields → throw', () => {
  test('sendTransaction throws when maxFeePerGas is missing', async () => {
    const keyManager = createMockKeyManager();
    const provider = createMockProvider();
    provider.getFeeData.mockResolvedValueOnce({
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: BigInt(200000000),
    } as any);

    const signer = await createKeyManagerSigner(keyManager, 'evm-key-7', provider);

    await expect(
      signer.sendTransaction({
        to: '0x' + 'aa'.repeat(20),
        value: 100,
      })
    ).rejects.toThrow('Unable to retrieve EIP-1559 fee data from provider');
  });

  test('sendTransaction throws when maxPriorityFeePerGas is missing', async () => {
    const keyManager = createMockKeyManager();
    const provider = createMockProvider();
    provider.getFeeData.mockResolvedValueOnce({
      maxFeePerGas: BigInt(1000000000),
      maxPriorityFeePerGas: undefined,
    } as any);

    const signer = await createKeyManagerSigner(keyManager, 'evm-key-8', provider);

    await expect(
      signer.sendTransaction({
        to: '0x' + 'bb'.repeat(20),
        value: 100,
      })
    ).rejects.toThrow('Unable to retrieve EIP-1559 fee data from provider');
  });
});

// ---------------------------------------------------------------------------
// Branch 6: sendTransaction() nonce provided vs fetched from provider
// ---------------------------------------------------------------------------

describe('Branch coverage: sendTransaction() nonce provided vs fetched', () => {
  test('sendTransaction uses provided nonce when transaction.nonce is set', async () => {
    const keyManager = createMockKeyManager();
    const provider = createMockProvider();
    const signer = await createKeyManagerSigner(keyManager, 'evm-key-9', provider);

    await signer.sendTransaction({
      to: '0x' + 'cc'.repeat(20),
      value: 100,
      nonce: 99,
    });

    expect(provider.getTransactionCount).not.toHaveBeenCalled();
    const resolvedArgs = (mockEthers.resolveProperties as jest.Mock).mock.calls[0][0];
    expect(resolvedArgs.nonce).toBe(99);
  });

  test('sendTransaction fetches nonce from provider when not provided', async () => {
    const keyManager = createMockKeyManager();
    const provider = createMockProvider();
    const signer = await createKeyManagerSigner(keyManager, 'evm-key-10', provider);

    await signer.sendTransaction({
      to: '0x' + 'dd'.repeat(20),
      value: 100,
    });

    expect(provider.getTransactionCount).toHaveBeenCalledWith(await signer.getAddress(), 'pending');
    const resolvedArgs = (mockEthers.resolveProperties as jest.Mock).mock.calls[0][0];
    expect(resolvedArgs.nonce).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Branch 7: sendTransaction() gasLimit provided vs estimated
// ---------------------------------------------------------------------------

describe('Branch coverage: sendTransaction() gasLimit provided vs estimated', () => {
  test('sendTransaction uses provided gasLimit when set', async () => {
    const keyManager = createMockKeyManager();
    const provider = createMockProvider();
    const signer = await createKeyManagerSigner(keyManager, 'evm-key-11', provider);

    await signer.sendTransaction({
      to: '0x' + 'ee'.repeat(20),
      value: 100,
      gasLimit: 50000,
    });

    expect(provider.estimateGas).not.toHaveBeenCalled();
    const resolvedArgs = (mockEthers.resolveProperties as jest.Mock).mock.calls[0][0];
    expect(resolvedArgs.gasLimit).toBe(50000);
  });

  test('sendTransaction estimates gas when gasLimit not provided', async () => {
    const keyManager = createMockKeyManager();
    const provider = createMockProvider();
    const signer = await createKeyManagerSigner(keyManager, 'evm-key-12', provider);

    await signer.sendTransaction({
      to: '0x' + 'ff'.repeat(20),
      value: 100,
    });

    expect(provider.estimateGas).toHaveBeenCalled();
    const resolvedArgs = (mockEthers.resolveProperties as jest.Mock).mock.calls[0][0];
    expect(resolvedArgs.gasLimit).toBe(BigInt(21000));
  });
});

// ---------------------------------------------------------------------------
// Branch 8: sendTransaction() chainId provided vs from network
// ---------------------------------------------------------------------------

describe('Branch coverage: sendTransaction() chainId provided vs from network', () => {
  test('sendTransaction uses provided chainId when set', async () => {
    const keyManager = createMockKeyManager();
    const provider = createMockProvider();
    const signer = await createKeyManagerSigner(keyManager, 'evm-key-13', provider);

    await signer.sendTransaction({
      to: '0x' + '11'.repeat(20),
      value: 100,
      chainId: 31337,
    });

    expect(provider.getNetwork).toHaveBeenCalledTimes(1); // called once in sendTransaction
    const resolvedArgs = (mockEthers.resolveProperties as jest.Mock).mock.calls[0][0];
    expect(resolvedArgs.chainId).toBe(31337);
  });

  test('sendTransaction uses chainId from network when not provided', async () => {
    const keyManager = createMockKeyManager();
    const provider = createMockProvider();
    const signer = await createKeyManagerSigner(keyManager, 'evm-key-14', provider);

    await signer.sendTransaction({
      to: '0x' + '22'.repeat(20),
      value: 100,
    });

    expect(provider.getNetwork).toHaveBeenCalled();
    const resolvedArgs = (mockEthers.resolveProperties as jest.Mock).mock.calls[0][0];
    expect(resolvedArgs.chainId).toBe(1337);
  });
});

// ---------------------------------------------------------------------------
// Branch 9: signMessage() string message vs Uint8Array
// ---------------------------------------------------------------------------

describe('Branch coverage: signMessage() string message vs Uint8Array', () => {
  test('signMessage converts string to bytes with toUtf8Bytes', async () => {
    const keyManager = createMockKeyManager();
    const signer = await createKeyManagerSigner(keyManager, 'evm-key-15');

    const result = await signer.signMessage('hello world');

    expect(mockEthers.toUtf8Bytes).toHaveBeenCalledWith('hello world');
    expect(mockEthers.hashMessage).toHaveBeenCalled();
    const hashCallResult = mockEthers.hashMessage.mock.results[0];
    expect(keyManager.sign).toHaveBeenCalledWith(
      Buffer.from(
        (hashCallResult && hashCallResult.value ? hashCallResult.value : '0xdead').slice(2),
        'hex'
      ),
      'evm-key-15'
    );
    expect(result).toBe('0x' + '33'.repeat(65));
  });

  test('signMessage uses Uint8Array directly without toUtf8Bytes', async () => {
    const keyManager = createMockKeyManager();
    const signer = await createKeyManagerSigner(keyManager, 'evm-key-16');

    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const result = await signer.signMessage(bytes);

    expect(mockEthers.toUtf8Bytes).not.toHaveBeenCalled();
    expect(mockEthers.hashMessage).toHaveBeenCalledWith(bytes);
    expect(result).toBe('0x' + '33'.repeat(65));
  });
});

// ---------------------------------------------------------------------------
// Branch 10: signTypedData() creates typed data hash, signs with KeyManager
// ---------------------------------------------------------------------------

describe('Branch coverage: signTypedData() full flow', () => {
  test('signTypedData hashes with TypedDataEncoder and signs with KeyManager', async () => {
    const keyManager = createMockKeyManager();
    const signer = await createKeyManagerSigner(keyManager, 'evm-key-17');

    const domain = {
      name: 'TestDomain',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x' + '33'.repeat(20),
    };

    const types = {
      Message: [{ name: 'content', type: 'string' }],
    };

    const value = { content: 'test' };

    const result = await signer.signTypedData(domain, types, value);

    expect(mockEthers.TypedDataEncoder.hash).toHaveBeenCalledWith(domain, types, value);
    const typedHashResult = mockEthers.TypedDataEncoder.hash.mock.results[0];
    expect(keyManager.sign).toHaveBeenCalledWith(
      Buffer.from(
        (typedHashResult && typedHashResult.value ? typedHashResult.value : '0xdead').slice(2),
        'hex'
      ),
      'evm-key-17'
    );
    expect(result).toBe('0x' + '33'.repeat(65));
  });
});

// ---------------------------------------------------------------------------
// Branch 11: connect(provider) returns new instance
// ---------------------------------------------------------------------------

describe('Branch coverage: connect(provider) returns new instance', () => {
  test('connect returns a new KeyManagerSignerImpl with the new provider', async () => {
    const keyManager = createMockKeyManager();
    const providerA = createMockProvider();
    const providerB = createMockProvider();

    const signerA = await createKeyManagerSigner(keyManager, 'evm-key-18', providerA);
    const signerB = signerA.connect(providerB);

    expect(signerB).not.toBe(signerA);
    expect(signerB).toBeDefined();

    // signerB should be usable with the new provider
    await signerB.sendTransaction({ to: '0x' + '44'.repeat(20), value: 100 });
    expect(providerB.broadcastTransaction).toHaveBeenCalled();
    expect(providerA.broadcastTransaction).not.toHaveBeenCalled();
  });

  test('connect preserves keyManager and evmKeyId', async () => {
    const keyManager = createMockKeyManager();
    const providerA = createMockProvider();
    const providerB = createMockProvider();

    const signerA = await createKeyManagerSigner(keyManager, 'evm-key-19', providerA);
    const signerB = signerA.connect(providerB);

    // getAddress should still work without fetching public key again (cache not shared across instances,
    // but for this test we just verify the new instance works end-to-end)
    const addressB = await signerB.getAddress();
    expect(addressB).toBeDefined();
    expect(keyManager.getPublicKey).toHaveBeenCalledWith('evm-key-19');
  });
});

// ---------------------------------------------------------------------------
// Integration-style: sendTransaction full end-to-end
// ---------------------------------------------------------------------------

describe('Branch coverage: sendTransaction() end-to-end with all defaults', () => {
  test('sendTransaction populates all missing fields and broadcasts', async () => {
    const keyManager = createMockKeyManager();
    const provider = createMockProvider();
    const signer = await createKeyManagerSigner(keyManager, 'evm-key-20', provider);

    const txResponse = await signer.sendTransaction({
      to: '0x' + '55'.repeat(20),
      value: 1000,
    });

    expect(txResponse).toBeDefined();
    expect(txResponse.hash).toBe('0x' + '55'.repeat(32));
    expect(provider.broadcastTransaction).toHaveBeenCalledWith(mockTx.serialized);

    // Verify all default-populated fields
    const resolvedArgs = (mockEthers.resolveProperties as jest.Mock).mock.calls[0][0];
    expect(resolvedArgs.to).toBe('0x' + '55'.repeat(20));
    expect(resolvedArgs.data).toBe('0x');
    expect(resolvedArgs.value).toBe(1000);
    expect(resolvedArgs.type).toBe(2);
    expect(resolvedArgs.nonce).toBe(42);
    expect(resolvedArgs.gasLimit).toBe(BigInt(21000));
    expect(resolvedArgs.chainId).toBe(1337);
    expect(resolvedArgs.maxFeePerGas).toBe(BigInt(1000000000));
    expect(resolvedArgs.maxPriorityFeePerGas).toBe(BigInt(200000000));
  });
});
