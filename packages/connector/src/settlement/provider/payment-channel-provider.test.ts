/**
 * Tests for Payment Channel Provider Interface and Chain-Agnostic Types
 *
 * Covers:
 * - Type-level compile checks for PaymentChannelProvider interface (AC 1)
 * - ProviderChannelState chain-agnostic fields (AC 2)
 * - Extended BlockchainType and claim types (AC 3)
 * - ProviderConfig discriminated union (AC 4)
 * - Backward compatibility of existing claim types (AC 5)
 *
 * Epic 32 Story 32.1
 *
 * @module payment-channel-provider.test
 */

import type {
  PaymentChannelProvider,
  ProviderChannelState,
  ProviderEventSubscription,
  ProviderEventType,
  ProviderEvent,
  ProviderEventCallback,
  OpenChannelResult,
  TxResult,
  BalanceProofParams,
  VerifyBalanceProofParams,
  ProviderConfig,
  EVMProviderConfig,
  SolanaProviderConfig,
  MinaProviderConfig,
} from './payment-channel-provider';

import type {
  BlockchainType,
  EVMClaimMessage,
  SolanaClaimMessage,
  MinaClaimMessage,
  BTPClaimMessage,
} from '../../btp/btp-claim-types';

import {
  isEVMClaim,
  isSolanaClaim,
  isMinaClaim,
  validateClaimMessage,
} from '../../btp/btp-claim-types';

// ---------------------------------------------------------------------------
// T-32.1-01: PaymentChannelProvider interface requires all 9 methods + properties
// ---------------------------------------------------------------------------

describe('PaymentChannelProvider interface (T-32.1-01)', () => {
  it('should require all 9 methods plus chainType and chainId', () => {
    // Compile-time assertion: if any method is missing, this will fail to compile
    const mockProvider: PaymentChannelProvider = {
      chainType: 'evm',
      chainId: 'evm:8453',
      openChannel: async (_participant: string, _timeout: number): Promise<OpenChannelResult> => ({
        channelId: '0x1234',
        txHash: '0xabcd',
      }),
      deposit: async (_channelId: string, _amount: string): Promise<TxResult> => ({
        txHash: '0xabcd',
      }),
      claimFromChannel: async (
        _channelId: string,
        _balanceProof: BalanceProofParams,
        _signature: string
      ): Promise<TxResult> => ({
        txHash: '0xabcd',
      }),
      closeChannel: async (_channelId: string): Promise<TxResult> => ({
        txHash: '0xabcd',
      }),
      settleChannel: async (_channelId: string): Promise<TxResult> => ({
        txHash: '0xabcd',
      }),
      signBalanceProof: async (_params: BalanceProofParams): Promise<string> => '0xsignature',
      verifyBalanceProof: async (_params: VerifyBalanceProofParams): Promise<boolean> => true,
      getChannelState: async (_channelId: string): Promise<ProviderChannelState> => ({
        channelId: '0x1234',
        status: 'opened',
        participants: ['0xAlice', '0xBob'],
        deposit: 1000n,
      }),
      subscribeToEvents: (
        _channelId: string,
        _callback: ProviderEventCallback
      ): ProviderEventSubscription => ({
        unsubscribe: () => {},
      }),
    };

    // Runtime assertions on the mock to prove it satisfies the interface
    expect(mockProvider.chainType).toBe('evm');
    expect(mockProvider.chainId).toBe('evm:8453');
    expect(typeof mockProvider.openChannel).toBe('function');
    expect(typeof mockProvider.deposit).toBe('function');
    expect(typeof mockProvider.claimFromChannel).toBe('function');
    expect(typeof mockProvider.closeChannel).toBe('function');
    expect(typeof mockProvider.settleChannel).toBe('function');
    expect(typeof mockProvider.signBalanceProof).toBe('function');
    expect(typeof mockProvider.verifyBalanceProof).toBe('function');
    expect(typeof mockProvider.getChannelState).toBe('function');
    expect(typeof mockProvider.subscribeToEvents).toBe('function');
  });

  it('should return correct types from provider methods', async () => {
    const mockProvider: PaymentChannelProvider = {
      chainType: 'evm',
      chainId: 'evm:8453',
      openChannel: async () => ({ channelId: 'ch-1', txHash: '0x111' }),
      deposit: async () => ({ txHash: '0x222' }),
      claimFromChannel: async () => ({ txHash: '0x333' }),
      closeChannel: async () => ({ txHash: '0x444' }),
      settleChannel: async () => ({ txHash: '0x555' }),
      signBalanceProof: async () => '0xsig',
      verifyBalanceProof: async () => true,
      getChannelState: async () => ({
        channelId: 'ch-1',
        status: 'opened',
        participants: ['0xA', '0xB'],
        deposit: 500n,
      }),
      subscribeToEvents: () => ({ unsubscribe: () => {} }),
    };

    const openResult = await mockProvider.openChannel('0xBob', 100);
    expect(openResult.channelId).toBe('ch-1');
    expect(openResult.txHash).toBe('0x111');

    const depositResult = await mockProvider.deposit('ch-1', '1000');
    expect(depositResult.txHash).toBe('0x222');

    const sig = await mockProvider.signBalanceProof({
      channelId: 'ch-1',
      nonce: 1,
      transferredAmount: '100',
      lockedAmount: '0',
      locksRoot: '0x0',
    });
    expect(typeof sig).toBe('string');

    const valid = await mockProvider.verifyBalanceProof({
      channelId: 'ch-1',
      nonce: 1,
      transferredAmount: '100',
      lockedAmount: '0',
      locksRoot: '0x0',
      signature: '0xsig',
      signerAddress: '0xAlice',
    });
    expect(valid).toBe(true);

    const state = await mockProvider.getChannelState('ch-1');
    expect(state.status).toBe('opened');
    expect(state.deposit).toBe(500n);
  });
});

// ---------------------------------------------------------------------------
// T-32.1-02: ProviderChannelState is chain-agnostic
// ---------------------------------------------------------------------------

describe('ProviderChannelState (T-32.1-02)', () => {
  it('should have channelId, status, participants, and deposit fields', () => {
    const state: ProviderChannelState = {
      channelId: 'channel-abc',
      status: 'opened',
      participants: ['addr1', 'addr2'],
      deposit: 1000000n,
    };

    expect(state.channelId).toBe('channel-abc');
    expect(state.status).toBe('opened');
    expect(state.participants).toEqual(['addr1', 'addr2']);
    expect(state.deposit).toBe(1000000n);
  });

  it('should support all status values', () => {
    const states: ProviderChannelState['status'][] = ['opened', 'closed', 'settled'];
    expect(states).toHaveLength(3);

    const openState: ProviderChannelState = {
      channelId: 'ch-1',
      status: 'opened',
      participants: [],
      deposit: 0n,
    };
    const closedState: ProviderChannelState = {
      channelId: 'ch-2',
      status: 'closed',
      participants: [],
      deposit: 0n,
    };
    const settledState: ProviderChannelState = {
      channelId: 'ch-3',
      status: 'settled',
      participants: [],
      deposit: 0n,
    };

    expect(openState.status).toBe('opened');
    expect(closedState.status).toBe('closed');
    expect(settledState.status).toBe('settled');
  });
});

// ---------------------------------------------------------------------------
// T-32.1-03: EVMClaimMessage backward compatibility — isEVMClaim() narrows
// ---------------------------------------------------------------------------

describe('EVMClaimMessage backward compatibility (T-32.1-03)', () => {
  const evmClaim: EVMClaimMessage = {
    version: '1.0',
    blockchain: 'evm',
    messageId: 'claim-evm-001',
    timestamp: '2026-02-02T12:00:00.000Z',
    senderId: 'peer-bob',
    channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
    nonce: 5,
    transferredAmount: '1000000000000000000',
    lockedAmount: '0',
    locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
    signature: '0xabcdef1234567890',
    signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
  };

  it('should narrow EVMClaimMessage via isEVMClaim()', () => {
    const msg: BTPClaimMessage = evmClaim;
    expect(isEVMClaim(msg)).toBe(true);

    if (isEVMClaim(msg)) {
      // TypeScript narrowing — these field accesses prove the type guard works
      expect(msg.channelId).toBeDefined();
      expect(msg.nonce).toBe(5);
      expect(msg.signerAddress).toBe('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1');
    }
  });

  it('should return false for non-EVM claims from isEVMClaim()', () => {
    const solanaClaim: SolanaClaimMessage = {
      version: '1.0',
      blockchain: 'solana',
      messageId: 'claim-sol-001',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-charlie',
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      channelAccount: 'ChannelAcct1234567890123456789012',
      nonce: 1,
      transferredAmount: '1000000',
      signature: 'solana-sig-abc',
      signerPublicKey: '33333333333333333333333333333333',
    };

    expect(isEVMClaim(solanaClaim)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-32.1-04: BlockchainType extends to 'evm' | 'solana' | 'mina'
// ---------------------------------------------------------------------------

describe('BlockchainType discriminated union (T-32.1-04)', () => {
  it('should accept all three blockchain types', () => {
    const evm: BlockchainType = 'evm';
    const solana: BlockchainType = 'solana';
    const mina: BlockchainType = 'mina';

    expect(evm).toBe('evm');
    expect(solana).toBe('solana');
    expect(mina).toBe('mina');
  });
});

// ---------------------------------------------------------------------------
// T-32.1-05: SolanaClaimMessage and MinaClaimMessage stubs compile
// ---------------------------------------------------------------------------

describe('SolanaClaimMessage and MinaClaimMessage stubs (T-32.1-05)', () => {
  it('should create SolanaClaimMessage with required fields', () => {
    const solanaClaim: SolanaClaimMessage = {
      version: '1.0',
      blockchain: 'solana',
      messageId: 'claim-sol-001',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-alice',
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      channelAccount: 'ChannelAcct1234567890123456789012',
      nonce: 1,
      transferredAmount: '1000000',
      signature: 'ed25519-sig-xyz',
      signerPublicKey: '33333333333333333333333333333333',
    };

    expect(solanaClaim.blockchain).toBe('solana');
    expect(solanaClaim.programId).toBeDefined();
    expect(solanaClaim.channelAccount).toBeDefined();
    expect(solanaClaim.nonce).toBe(1);
    expect(solanaClaim.transferredAmount).toBe('1000000');
    expect(solanaClaim.signature).toBeDefined();
    expect(solanaClaim.signerPublicKey).toBeDefined();
  });

  it('should create MinaClaimMessage with required fields', () => {
    const minaClaim: MinaClaimMessage = {
      version: '1.0',
      blockchain: 'mina',
      messageId: 'claim-mina-001',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-dave',
      zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
      tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
      balanceCommitment: '12345678901234567890123456789012345678901234567890',
      nonce: 1,
      proof: 'eyJwcm9vZiI6InRlc3QifQ==',
      salt: 'abcdef1234567890',
      network: 'devnet',
    };

    expect(minaClaim.blockchain).toBe('mina');
    expect(minaClaim.zkAppAddress).toBeDefined();
    expect(minaClaim.tokenId).toBeDefined();
    expect(minaClaim.balanceCommitment).toBeDefined();
    expect(minaClaim.nonce).toBeDefined();
    expect(minaClaim.proof).toBeDefined();
    expect(minaClaim.salt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// T-32.1-06: ProviderConfig discriminated union
// ---------------------------------------------------------------------------

describe('ProviderConfig discriminated union (T-32.1-06)', () => {
  it('should create EVMProviderConfig', () => {
    const config: EVMProviderConfig = {
      chainType: 'evm',
      rpcUrl: 'https://mainnet.base.org',
      registryAddress: '0x1234567890123456789012345678901234567890',
      keyId: 'evm-key-1',
    };

    expect(config.chainType).toBe('evm');
    expect(config.rpcUrl).toBeDefined();
    expect(config.registryAddress).toBeDefined();
    expect(config.keyId).toBeDefined();
  });

  it('should create SolanaProviderConfig', () => {
    const config: SolanaProviderConfig = {
      chainType: 'solana',
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      keyId: 'solana-treasury-key',
    };

    expect(config.chainType).toBe('solana');
    expect(config.rpcUrl).toBeDefined();
    expect(config.programId).toBeDefined();
    expect(config.keyId).toBeDefined();
  });

  it('should create MinaProviderConfig stub', () => {
    const config: MinaProviderConfig = {
      chainType: 'mina',
      graphqlUrl: 'https://graphql.minaprotocol.com/graphql',
      zkAppAddress: 'B62qkR...minaAddress',
    };

    expect(config.chainType).toBe('mina');
    expect(config.graphqlUrl).toBeDefined();
    expect(config.zkAppAddress).toBeDefined();
  });

  it('should narrow ProviderConfig via chainType discriminator', () => {
    const configs: ProviderConfig[] = [
      { chainType: 'evm', rpcUrl: 'https://rpc.example.com', registryAddress: '0x123', keyId: 'k' },
      { chainType: 'solana', rpcUrl: 'https://sol.example.com', programId: 'prog1', keyId: 'k' },
      { chainType: 'mina', graphqlUrl: 'https://mina.example.com', zkAppAddress: 'zkApp1' },
    ];

    for (const config of configs) {
      switch (config.chainType) {
        case 'evm':
          expect(config.registryAddress).toBeDefined();
          break;
        case 'solana':
          expect(config.programId).toBeDefined();
          break;
        case 'mina':
          expect(config.zkAppAddress).toBeDefined();
          break;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T-32.1-07: BTPClaimMessage union accepts all three subtypes
// ---------------------------------------------------------------------------

describe('BTPClaimMessage union (T-32.1-07)', () => {
  it('should accept EVMClaimMessage', () => {
    const msg: BTPClaimMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'msg-1',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-1',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 1,
      transferredAmount: '100',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xsig',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };
    expect(msg.blockchain).toBe('evm');
  });

  it('should accept SolanaClaimMessage', () => {
    const msg: BTPClaimMessage = {
      version: '1.0',
      blockchain: 'solana',
      messageId: 'msg-2',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-2',
      programId: '11111111111111111111111111111111',
      channelAccount: '22222222222222222222222222222222',
      nonce: 1,
      transferredAmount: '100',
      signature: 'sig1',
      signerPublicKey: '33333333333333333333333333333333',
    };
    expect(msg.blockchain).toBe('solana');
  });

  it('should accept MinaClaimMessage', () => {
    const msg: BTPClaimMessage = {
      version: '1.0',
      blockchain: 'mina',
      messageId: 'msg-3',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-3',
      zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
      tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
      balanceCommitment: '12345678901234567890',
      nonce: 1,
      proof: 'eyJwcm9vZiI6InRlc3QifQ==',
      salt: 'abcdef1234567890',
    };
    expect(msg.blockchain).toBe('mina');
  });
});

// ---------------------------------------------------------------------------
// T-32.1-08: validateClaimMessage() accepts EVM claims unchanged
// ---------------------------------------------------------------------------

describe('validateClaimMessage() (T-32.1-08)', () => {
  it('should accept valid EVM claims (unchanged behavior)', () => {
    const validEVMClaim = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'claim-evm-001',
      timestamp: '2026-02-02T12:00:00.000Z',
      senderId: 'peer-bob',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 5,
      transferredAmount: '1000000000000000000',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };

    expect(() => validateClaimMessage(validEVMClaim)).not.toThrow();
  });

  it('should accept valid solana claims', () => {
    const solanaClaim = {
      version: '1.0',
      blockchain: 'solana',
      messageId: 'claim-sol-001',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-alice',
      programId: '11111111111111111111111111111111',
      channelAccount: '22222222222222222222222222222222',
      nonce: 1,
      transferredAmount: '1000000',
      signature: 'sig1',
      signerPublicKey: '33333333333333333333333333333333',
    };

    expect(() => validateClaimMessage(solanaClaim)).not.toThrow();
  });

  it('should accept valid Mina claims (Story 34.7)', () => {
    const minaClaim = {
      version: '1.0',
      blockchain: 'mina',
      messageId: 'claim-mina-001',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-dave',
      zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
      tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
      balanceCommitment: '12345678901234567890',
      nonce: 1,
      proof: 'eyJwcm9vZiI6InRlc3QifQ==',
      salt: 'abcdef1234567890',
      network: 'devnet',
    };

    expect(() => validateClaimMessage(minaClaim)).not.toThrow();
  });

  it('should still reject unknown blockchain types', () => {
    const unknownClaim = {
      version: '1.0',
      blockchain: 'bitcoin',
      messageId: 'claim-btc-001',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-eve',
    };

    expect(() => validateClaimMessage(unknownClaim)).toThrow(
      'Unsupported blockchain type: bitcoin'
    );
  });
});

// ---------------------------------------------------------------------------
// Type guards: isSolanaClaim() and isMinaClaim()
// ---------------------------------------------------------------------------

describe('isSolanaClaim() type guard', () => {
  it('should return true for Solana claims', () => {
    const msg: BTPClaimMessage = {
      version: '1.0',
      blockchain: 'solana',
      messageId: 'msg-sol-1',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-1',
      programId: '11111111111111111111111111111111',
      channelAccount: '22222222222222222222222222222222',
      nonce: 1,
      transferredAmount: '100',
      signature: 'sig1',
      signerPublicKey: '33333333333333333333333333333333',
    };
    expect(isSolanaClaim(msg)).toBe(true);
  });

  it('should return false for EVM claims', () => {
    const msg: BTPClaimMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'msg-evm-1',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-1',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 1,
      transferredAmount: '100',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xsig',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };
    expect(isSolanaClaim(msg)).toBe(false);
  });

  it('should return false for Mina claims', () => {
    const msg: BTPClaimMessage = {
      version: '1.0',
      blockchain: 'mina',
      messageId: 'msg-mina-cross-1',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-1',
      zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
      tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
      balanceCommitment: '12345678901234567890',
      nonce: 1,
      proof: 'eyJwcm9vZiI6InRlc3QifQ==',
      salt: 'abcdef1234567890',
    };
    expect(isSolanaClaim(msg)).toBe(false);
  });

  it('should narrow type to SolanaClaimMessage', () => {
    const msg: BTPClaimMessage = {
      version: '1.0',
      blockchain: 'solana',
      messageId: 'msg-sol-2',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-2',
      programId: '11111111111111111111111111111111',
      channelAccount: '22222222222222222222222222222222',
      nonce: 1,
      transferredAmount: '100',
      signature: 'sig1',
      signerPublicKey: '33333333333333333333333333333333',
    };

    if (isSolanaClaim(msg)) {
      expect(msg.programId).toBe('11111111111111111111111111111111');
      expect(msg.channelAccount).toBe('22222222222222222222222222222222');
    }
  });
});

describe('isMinaClaim() type guard', () => {
  it('should return true for Mina claims', () => {
    const msg: BTPClaimMessage = {
      version: '1.0',
      blockchain: 'mina',
      messageId: 'msg-mina-1',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-1',
      zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
      tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
      balanceCommitment: '12345678901234567890',
      nonce: 1,
      proof: 'eyJwcm9vZiI6InRlc3QifQ==',
      salt: 'abcdef1234567890',
    };
    expect(isMinaClaim(msg)).toBe(true);
  });

  it('should return false for EVM claims', () => {
    const msg: BTPClaimMessage = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'msg-evm-2',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-1',
      channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
      nonce: 1,
      transferredAmount: '100',
      lockedAmount: '0',
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      signature: '0xsig',
      signerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    };
    expect(isMinaClaim(msg)).toBe(false);
  });

  it('should return false for Solana claims', () => {
    const msg: BTPClaimMessage = {
      version: '1.0',
      blockchain: 'solana',
      messageId: 'msg-sol-cross-1',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-1',
      programId: '11111111111111111111111111111111',
      channelAccount: '22222222222222222222222222222222',
      nonce: 1,
      transferredAmount: '100',
      signature: 'sig1',
      signerPublicKey: '33333333333333333333333333333333',
    };
    expect(isMinaClaim(msg)).toBe(false);
  });

  it('should narrow type to MinaClaimMessage', () => {
    const msg: BTPClaimMessage = {
      version: '1.0',
      blockchain: 'mina',
      messageId: 'msg-mina-2',
      timestamp: '2026-03-24T12:00:00.000Z',
      senderId: 'peer-2',
      zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
      tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
      balanceCommitment: '12345678901234567890',
      nonce: 1,
      proof: 'eyJwcm9vZiI6InRlc3QifQ==',
      salt: 'abcdef1234567890',
    };

    if (isMinaClaim(msg)) {
      expect(msg.zkAppAddress).toBe('B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy');
      expect(msg.proof).toBe('eyJwcm9vZiI6InRlc3QifQ==');
      expect(msg.tokenId).toBe('wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf');
      expect(msg.salt).toBe('abcdef1234567890');
    }
  });
});

// ---------------------------------------------------------------------------
// Event types compile checks
// ---------------------------------------------------------------------------

describe('Provider event types', () => {
  it('should support all event types', () => {
    const eventTypes: ProviderEventType[] = [
      'channel_opened',
      'channel_closed',
      'channel_settled',
      'channel_deposited',
      'channel_claimed',
    ];
    expect(eventTypes).toHaveLength(5);
  });

  it('should create a valid ProviderEvent', () => {
    const event: ProviderEvent = {
      type: 'channel_opened',
      channelId: 'ch-1',
      txHash: '0xabc',
      data: { settlementTimeout: 100 },
    };
    expect(event.type).toBe('channel_opened');
    expect(event.channelId).toBe('ch-1');
  });

  it('should create ProviderEventSubscription with unsubscribe', () => {
    let called = false;
    const sub: ProviderEventSubscription = {
      unsubscribe: () => {
        called = true;
      },
    };
    sub.unsubscribe();
    expect(called).toBe(true);
  });

  it('should create ProviderEvent without optional fields', () => {
    const event: ProviderEvent = {
      type: 'channel_closed',
      channelId: 'ch-2',
    };
    expect(event.type).toBe('channel_closed');
    expect(event.txHash).toBeUndefined();
    expect(event.data).toBeUndefined();
  });

  it('should invoke callback via subscribeToEvents pattern', () => {
    // Simulate a provider that fires events through the callback
    const receivedEvents: ProviderEvent[] = [];
    const callback: ProviderEventCallback = (event) => {
      receivedEvents.push(event);
    };

    // Mock provider with a subscribeToEvents that immediately fires an event
    const mockProvider: PaymentChannelProvider = {
      chainType: 'evm',
      chainId: 'evm:8453',
      openChannel: async () => ({ channelId: 'ch-1', txHash: '0x1' }),
      deposit: async () => ({ txHash: '0x2' }),
      claimFromChannel: async () => ({ txHash: '0x3' }),
      closeChannel: async () => ({ txHash: '0x4' }),
      settleChannel: async () => ({ txHash: '0x5' }),
      signBalanceProof: async () => '0xsig',
      verifyBalanceProof: async () => true,
      getChannelState: async () => ({
        channelId: 'ch-1',
        status: 'opened',
        participants: ['0xA', '0xB'],
        deposit: 0n,
      }),
      subscribeToEvents: (_channelId: string, cb: ProviderEventCallback) => {
        // Simulate an event being fired
        cb({ type: 'channel_opened', channelId: _channelId, txHash: '0xopen' });
        cb({
          type: 'channel_deposited',
          channelId: _channelId,
          txHash: '0xdeposit',
          data: { amount: '1000' },
        });
        return { unsubscribe: () => {} };
      },
    };

    const sub = mockProvider.subscribeToEvents('ch-test', callback);

    expect(receivedEvents).toHaveLength(2);
    expect(receivedEvents.at(0)?.type).toBe('channel_opened');
    expect(receivedEvents.at(0)?.txHash).toBe('0xopen');
    expect(receivedEvents.at(1)?.type).toBe('channel_deposited');
    expect(receivedEvents.at(1)?.data).toEqual({ amount: '1000' });
    expect(typeof sub.unsubscribe).toBe('function');
  });
});
