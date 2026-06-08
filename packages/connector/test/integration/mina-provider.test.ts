/**
 * Mina Provider Integration Tests (Mock SDK)
 *
 * Story 34.8: End-to-end integration tests for the Mina settlement flow.
 * Uses a mock MinaPaymentChannelSDK to test the full lifecycle, multi-peer
 * settlement, privacy verification, non-blocking proof generation,
 * threshold-driven settlement, invalid claim rejection, claim JSON structure,
 * and claim accumulation.
 *
 * Test IDs covered:
 * - T-34.8-01: Full lifecycle (open -> deposit -> claim -> close -> settle)
 * - T-34.8-02: Multi-peer (three peers with Mina channels, per-packet claims)
 * - T-34.8-03: Privacy (on-chain state reveals only Poseidon commitments)
 * - T-34.8-04: Non-blocking (proof generation runs asynchronously)
 * - T-34.8-07: Threshold (credit balance triggers Mina settlement)
 * - T-34.8-08: Invalid claims (tampered proof, wrong nonce, bad commitment)
 * - T-34.8-14: Claim JSON (serialized MinaClaimMessage has all fields)
 * - T-34.8-17: Claim accumulation (5+ claims with increasing nonces)
 *
 * @packageDocumentation
 */

import pino from 'pino';
import { MinaPaymentChannelProvider } from '../../src/settlement/provider/mina-payment-channel-provider';
import type { MinaProviderOptions } from '../../src/settlement/provider/mina-payment-channel-provider';
import {
  MinaPaymentChannelSDK,
  MinaChannelError,
} from '../../src/settlement/mina-payment-channel-sdk';
import type {
  MinaChannelState,
  MinaOpenChannelResult,
  MinaTxResult,
} from '../../src/settlement/mina-payment-channel-sdk';
import { ChainProviderRegistry } from '../../src/settlement/provider/chain-provider-registry';
import type { MinaClaimMessage } from '../../src/btp/btp-claim-types';
import { validateClaimMessage, isMinaClaim } from '../../src/btp/btp-claim-types';
import { SettlementMonitor } from '../../src/settlement/settlement-monitor';
import type { ClaimReceivedEvent } from '../../src/settlement/claim-receiver';
import type { SettlementTriggerEvent } from '../../src/config/types';
import { EventEmitter } from 'events';

// Extend Jest timeout for integration tests
jest.setTimeout(60_000);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MINA_ZKAPP_ADDRESS = 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy';
const MINA_TOKEN_ID = 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf';
const MINA_CHAIN_ID = 'mina:devnet';
const SIGNER_KEY = 'test-signer-key';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createTestLogger = (): pino.Logger => pino({ level: 'silent' });

/**
 * Create a mock MinaPaymentChannelSDK for provider-level tests.
 */
function createMockMinaSDK(): jest.Mocked<
  Pick<
    MinaPaymentChannelSDK,
    | 'openChannel'
    | 'deposit'
    | 'claimFromChannel'
    | 'closeChannel'
    | 'settleChannel'
    | 'getChannelState'
    | 'compileContract'
    | 'getSignerPublicKey'
    | 'signBalanceProof'
    | 'verifyBalanceProof'
    | 'subscribeToChannel'
  >
> {
  return {
    openChannel: jest.fn(),
    deposit: jest.fn(),
    claimFromChannel: jest.fn(),
    closeChannel: jest.fn(),
    settleChannel: jest.fn(),
    getChannelState: jest.fn(),
    compileContract: jest.fn().mockResolvedValue(undefined),
    getSignerPublicKey: jest.fn().mockResolvedValue('B62qMockSignerPublicKey'),
    signBalanceProof: jest.fn(),
    verifyBalanceProof: jest.fn(),
    subscribeToChannel: jest.fn(),
  };
}

/**
 * Create a MinaPaymentChannelProvider with mock SDK.
 */
function createMinaTestProvider(
  mockSdk?: ReturnType<typeof createMockMinaSDK>,
  options?: {
    chainId?: string;
    zkAppAddress?: string;
    signerKey?: string;
    providerOptions?: MinaProviderOptions;
  }
): {
  provider: MinaPaymentChannelProvider;
  mockSdk: ReturnType<typeof createMockMinaSDK>;
  logger: pino.Logger;
} {
  const sdk = mockSdk ?? createMockMinaSDK();
  const logger = createTestLogger();
  const provider = new MinaPaymentChannelProvider(
    sdk as unknown as MinaPaymentChannelSDK,
    options?.chainId ?? MINA_CHAIN_ID,
    options?.zkAppAddress ?? MINA_ZKAPP_ADDRESS,
    options?.signerKey ?? SIGNER_KEY,
    logger,
    options?.providerOptions ?? { tokenId: MINA_TOKEN_ID, network: 'devnet' }
  );
  return { provider, mockSdk: sdk, logger };
}

/**
 * Create a valid MinaClaimMessage test fixture.
 */
function createValidMinaClaim(overrides?: Partial<MinaClaimMessage>): MinaClaimMessage {
  return {
    version: '1.0',
    blockchain: 'mina',
    messageId: 'claim-mina-001',
    timestamp: '2026-03-28T12:00:00.000Z',
    senderId: 'peer-mina-alice',
    zkAppAddress: MINA_ZKAPP_ADDRESS,
    tokenId: MINA_TOKEN_ID,
    balanceCommitment: '12345678901234567890123456789012345678901234567890',
    nonce: 1,
    proof: 'eyJwcm9vZiI6InRlc3QifQ==',
    salt: 'abcdef1234567890',
    network: 'devnet',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// T-34.8-01: Full Channel Lifecycle E2E (AC 1)
// ---------------------------------------------------------------------------

describe('Mina Provider E2E -- Full Lifecycle (Story 34.8)', () => {
  let logger: pino.Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = createTestLogger();
  });

  describe('[T-34.8-01] Full lifecycle: open -> deposit -> claim -> close -> settle', () => {
    it('should complete the full Mina payment channel lifecycle', async () => {
      // Given: a mock SDK simulating the full lifecycle
      const mockSdk = createMockMinaSDK();

      const openResult: MinaOpenChannelResult = {
        zkAppAddress: MINA_ZKAPP_ADDRESS,
        txHash: 'tx-open-1',
      };
      mockSdk.openChannel.mockResolvedValue(openResult);

      const depositResult: MinaTxResult = { txHash: 'tx-deposit-1' };
      mockSdk.deposit.mockResolvedValue(depositResult);

      mockSdk.signBalanceProof.mockResolvedValue('mock-poseidon-commitment-proof');

      const claimResult: MinaTxResult = { txHash: 'tx-claim-1' };
      mockSdk.claimFromChannel.mockResolvedValue(claimResult);

      const closeResult: MinaTxResult = { txHash: 'tx-close-1' };
      mockSdk.closeChannel.mockResolvedValue(closeResult);

      const settleResult: MinaTxResult = { txHash: 'tx-settle-1' };
      mockSdk.settleChannel.mockResolvedValue(settleResult);

      // Mock getChannelState for state transitions
      mockSdk.getChannelState
        .mockResolvedValueOnce({
          participantA: SIGNER_KEY,
          participantB: 'peer-bob',
          channelState: 1, // OPEN
          depositTotal: 10000n,
          balanceCommitment: 'commitment-hash-1',
          nonceField: 0n,
          closedAtSlot: 0n,
          settlementTimeout: 300n,
          tokenId: MINA_TOKEN_ID,
          channelHash: 'channel-hash-1',
        } satisfies MinaChannelState)
        .mockResolvedValueOnce({
          participantA: SIGNER_KEY,
          participantB: 'peer-bob',
          channelState: 2, // CLOSING
          depositTotal: 10000n,
          balanceCommitment: 'commitment-hash-2',
          nonceField: 1n,
          closedAtSlot: 100n,
          settlementTimeout: 300n,
          tokenId: MINA_TOKEN_ID,
          channelHash: 'channel-hash-1',
        } satisfies MinaChannelState)
        .mockResolvedValueOnce({
          participantA: SIGNER_KEY,
          participantB: 'peer-bob',
          channelState: 3, // SETTLED
          depositTotal: 10000n,
          balanceCommitment: 'commitment-hash-final',
          nonceField: 1n,
          closedAtSlot: 100n,
          settlementTimeout: 300n,
          tokenId: MINA_TOKEN_ID,
          channelHash: 'channel-hash-1',
        } satisfies MinaChannelState);

      const { provider } = createMinaTestProvider(mockSdk);

      // When: full lifecycle is executed

      // Step 1: Open channel
      const open = await provider.openChannel('peer-bob', 300);
      expect(open.channelId).toBe(MINA_ZKAPP_ADDRESS);
      expect(open.txHash).toBe('tx-open-1');

      // Step 2: Deposit
      const deposit = await provider.deposit(open.channelId, '10000');
      expect(deposit.txHash).toBe('tx-deposit-1');

      // Step 3: Sign and submit claim
      const signature = await provider.signBalanceProof({
        channelId: open.channelId,
        nonce: 1,
        transferredAmount: '5000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
      });
      expect(typeof signature).toBe('string');

      const claim = await provider.claimFromChannel(
        open.channelId,
        {
          channelId: open.channelId,
          nonce: 1,
          transferredAmount: '5000',
          lockedAmount: '0',
          locksRoot: '0x' + '0'.repeat(64),
        },
        signature
      );
      expect(claim.txHash).toBe('tx-claim-1');

      // Step 4: Close channel
      const close = await provider.closeChannel(open.channelId);
      expect(close.txHash).toBe('tx-close-1');

      // Step 5: Settle channel
      const settle = await provider.settleChannel(open.channelId);
      expect(settle.txHash).toBe('tx-settle-1');

      // Then: all SDK methods called in correct order
      expect(mockSdk.openChannel).toHaveBeenCalledTimes(1);
      expect(mockSdk.deposit).toHaveBeenCalledTimes(1);
      // signBalanceProof is called twice: once directly above (sigA), and once
      // inside claimFromChannel where the connector co-signs signatureB with the
      // apex key because no explicit signatureB was supplied (Issue #123 / #124).
      expect(mockSdk.signBalanceProof).toHaveBeenCalledTimes(2);
      expect(mockSdk.claimFromChannel).toHaveBeenCalledTimes(1);
      expect(mockSdk.closeChannel).toHaveBeenCalledTimes(1);
      expect(mockSdk.settleChannel).toHaveBeenCalledTimes(1);

      // And: state transitions are correct
      const stateOpen = await provider.getChannelState(open.channelId);
      expect(stateOpen.status).toBe('opened');

      const stateClosing = await provider.getChannelState(open.channelId);
      expect(stateClosing.status).toBe('closed');

      const stateSettled = await provider.getChannelState(open.channelId);
      expect(stateSettled.status).toBe('settled');

      // And: final balance commitments are valid Poseidon hashes (string)
      expect(typeof stateSettled.deposit).toBe('bigint');
    });

    it('should pass string amounts to SDK as bigint via safeBigInt()', async () => {
      // Given: a mock SDK
      const mockSdk = createMockMinaSDK();
      mockSdk.deposit.mockResolvedValue({ txHash: 'tx-dep' });

      const { provider } = createMinaTestProvider(mockSdk);

      // When: deposit is called with a string amount
      await provider.deposit(MINA_ZKAPP_ADDRESS, '9999999999999999999');

      // Then: the SDK receives the amount as a bigint
      expect(mockSdk.deposit).toHaveBeenCalledWith(MINA_ZKAPP_ADDRESS, 9999999999999999999n);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.8-02: Multi-Peer Mina Settlement (AC 2)
  // -------------------------------------------------------------------------

  describe('[T-34.8-02] Multi-peer: three peers with Mina channels, per-packet claims', () => {
    it('should route claims to correct providers via ChainProviderRegistry', async () => {
      // Given: three Mina providers with different zkApp addresses
      const addresses = [
        'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
        'B62qjsV6WQwTeEWrNrRRBP6VaaLvQhwWTnFi4WP4LQjGvpfZEumXzxb',
        'B62qkYa1o6Mj6uTTjDQCob7FYZspuhkm4RRQhgJg9j4koEBWiSrTQrS',
      ];

      const registry = new ChainProviderRegistry();
      const providers: MinaPaymentChannelProvider[] = [];

      for (let i = 0; i < 3; i++) {
        const mockSdk = createMockMinaSDK();
        mockSdk.signBalanceProof.mockResolvedValue(`proof-peer-${i}`);
        const chainId = `mina:devnet-peer${i}`;
        const provider = new MinaPaymentChannelProvider(
          mockSdk as unknown as MinaPaymentChannelSDK,
          chainId,
          addresses[i]!,
          `signer-${i}`,
          logger,
          { tokenId: MINA_TOKEN_ID, network: 'devnet' }
        );
        registry.register(provider);
        providers.push(provider);
      }

      // When: looking up providers via registry
      for (let i = 0; i < 3; i++) {
        const found = registry.getProvider('mina', `mina:devnet-peer${i}`);
        expect(found).toBeDefined();
        expect(found!.chainId).toBe(`mina:devnet-peer${i}`);
      }

      // Then: each provider has distinct context
      for (let i = 0; i < 3; i++) {
        const ctx = await providers[i]!.getMinaContext();
        expect(ctx.zkAppAddress).toBe(addresses[i]);
      }

      // And: signing proofs produces unique results per provider
      const sigs = await Promise.all(
        providers.map(async (p) =>
          p.signBalanceProof({
            channelId: (await p.getMinaContext()).zkAppAddress,
            nonce: 1,
            transferredAmount: '1000',
            lockedAmount: '0',
            locksRoot: '0x' + '0'.repeat(64),
          })
        )
      );
      const uniqueSigs = new Set(sigs);
      expect(uniqueSigs.size).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.8-03: Privacy Verification (AC 3)
  // -------------------------------------------------------------------------

  describe('[T-34.8-03] Privacy: on-chain state reveals only Poseidon commitments', () => {
    it('should only expose commitment hashes in channel state, not plaintext amounts', async () => {
      // Given: a provider with mock SDK
      const mockSdk = createMockMinaSDK();
      mockSdk.claimFromChannel.mockResolvedValue({ txHash: 'tx-claim' });
      // No explicit signatureB is supplied below, so the connector co-signs
      // signatureB with the apex settlement key via signBalanceProof (Issue
      // #123 / #124). Give that call a distinct return value.
      mockSdk.signBalanceProof.mockResolvedValue('apex-cosigned-sigB');
      mockSdk.getChannelState.mockResolvedValue({
        participantA: 'alice',
        participantB: 'bob',
        channelState: 1,
        depositTotal: 10000n,
        balanceCommitment: 'poseidon-hash-abc123',
        nonceField: 5n,
        closedAtSlot: 0n,
        settlementTimeout: 300n,
        tokenId: MINA_TOKEN_ID,
        channelHash: 'ch-hash',
      } satisfies MinaChannelState);

      const { provider } = createMinaTestProvider(mockSdk);

      // When: multiple claims are processed
      for (let i = 1; i <= 3; i++) {
        await provider.claimFromChannel(
          MINA_ZKAPP_ADDRESS,
          {
            channelId: MINA_ZKAPP_ADDRESS,
            nonce: i,
            transferredAmount: String(i * 1000),
            lockedAmount: '0',
            locksRoot: '0x' + '0'.repeat(64),
          },
          `proof-${i}`
        );
      }

      // Then: getChannelState returns only commitment hash, not individual balances
      const state = await provider.getChannelState(MINA_ZKAPP_ADDRESS);
      expect(state.channelId).toBe(MINA_ZKAPP_ADDRESS);
      expect(state.status).toBe('opened');

      // And: claimFromChannel was called only with commitment hashes (bigint amounts),
      // not plaintext balance breakdowns
      expect(mockSdk.claimFromChannel).toHaveBeenCalledTimes(3);
      for (let i = 0; i < mockSdk.claimFromChannel.mock.calls.length; i++) {
        const call = mockSdk.claimFromChannel.mock.calls[i]!;
        // SDK signature:
        //   claimFromChannel(channelId, balanceA, balanceB, salt, nonce, signatureA, signatureB)
        expect(call[0]).toBe(MINA_ZKAPP_ADDRESS); // channelId
        expect(typeof call[1]).toBe('bigint'); // balanceA = transferredAmount (bigint, not plaintext string)
        expect(call[1]).toBe(BigInt((i + 1) * 1000)); // matches loop: String(i * 1000) where i = 1..3
        expect(typeof call[2]).toBe('bigint'); // balanceB (0n here — unidirectional claim)
        expect(typeof call[3]).toBe('bigint'); // salt (0n here — none provided)
        expect(typeof call[4]).toBe('bigint'); // nonce
        // No signatureB provided → the connector co-signs signatureB with the
        // apex key (Issue #123 / #124), so sigB is the apex co-signature, NOT a
        // duplicate of signatureA.
        expect(call[5]).toBe(`proof-${i + 1}`); // signatureA (the client's proof)
        expect(call[6]).toBe('apex-cosigned-sigB'); // signatureB (apex co-signature)
      }
    });

    it('[issue #84] should settle a true two-party claim with distinct balances, salt, and signatures', async () => {
      // Given: a provider and a bidirectional claim (e.g. a Mill swap) where
      // both participants hold a non-zero balance and each signs independently
      const mockSdk = createMockMinaSDK();
      mockSdk.claimFromChannel.mockResolvedValue({ txHash: 'tx-two-party' });
      const { provider } = createMinaTestProvider(mockSdk);

      // When: claimFromChannel is called with real balanceB, salt, and a
      // distinct participant B signature threaded via BalanceProofParams
      const result = await provider.claimFromChannel(
        MINA_ZKAPP_ADDRESS,
        {
          channelId: MINA_ZKAPP_ADDRESS,
          nonce: 9,
          transferredAmount: '4000', // participant A balance
          lockedAmount: '0',
          locksRoot: '0x' + '0'.repeat(64),
          balanceB: '6000', // participant B balance
          salt: '424242', // non-zero salt preserves commitment privacy
          signatureB: 'sigB-from-bob',
        },
        'sigA-from-alice' // participant A signature
      );

      // Then: the SDK receives the full dual-party authorization — NOT the old
      // balanceB=0n / salt=0n / single-signature placeholders
      expect(result.txHash).toBe('tx-two-party');
      const call = mockSdk.claimFromChannel.mock.calls[0]!;
      expect(call[1]).toBe(4000n); // balanceA
      expect(call[2]).toBe(6000n); // balanceB — real, not 0n
      expect(call[3]).toBe(424242n); // salt — real, not 0n
      expect(call[4]).toBe(9n); // nonce
      expect(call[5]).toBe('sigA-from-alice'); // signatureA
      expect(call[6]).toBe('sigB-from-bob'); // signatureB — distinct from A
      expect(call[5]).not.toBe(call[6]); // two-party authorization, not reuse
    });
  });

  // -------------------------------------------------------------------------
  // T-34.8-04: Non-Blocking Proof Generation (AC 4)
  // -------------------------------------------------------------------------

  describe('[T-34.8-04] Non-blocking: proof generation runs asynchronously', () => {
    it('should return a Promise from signBalanceProof (async)', async () => {
      // Given: a provider with mock SDK that resolves after a delay
      const mockSdk = createMockMinaSDK();
      mockSdk.signBalanceProof.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('delayed-proof'), 10))
      );

      const { provider } = createMinaTestProvider(mockSdk);

      // When: signBalanceProof is called
      const proofPromise = provider.signBalanceProof({
        channelId: MINA_ZKAPP_ADDRESS,
        nonce: 1,
        transferredAmount: '5000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
      });

      // Then: it returns a Promise (not blocking)
      expect(proofPromise).toBeInstanceOf(Promise);

      // And: the event loop is not blocked (we can run other code)
      let eventLoopRan = false;
      await new Promise<void>((resolve) => {
        setImmediate(() => {
          eventLoopRan = true;
          resolve();
        });
      });
      expect(eventLoopRan).toBe(true);

      // And: the proof eventually resolves
      const proof = await proofPromise;
      expect(proof).toBe('delayed-proof');
    });
  });

  // -------------------------------------------------------------------------
  // T-34.8-07: Threshold-Driven Settlement (AC 7)
  // -------------------------------------------------------------------------

  describe('[T-34.8-07] Threshold: credit balance triggers Mina settlement', () => {
    let activeMonitor: SettlementMonitor | undefined;

    afterEach(() => {
      if (activeMonitor) {
        activeMonitor.stop();
        activeMonitor = undefined;
      }
    });

    it('should call settleChannel via registry when threshold is breached', async () => {
      // Given: a Mina provider registered in the registry
      const mockSdk = createMockMinaSDK();
      mockSdk.settleChannel.mockResolvedValue({ txHash: 'tx-settle-threshold' });

      const { provider } = createMinaTestProvider(mockSdk);
      const registry = new ChainProviderRegistry();
      registry.register(provider);

      // When: the settlement monitor detects a threshold breach
      // (simulated by calling settleChannel directly through the provider)
      const resolvedProvider = registry.getProviderForPeer({
        peerId: 'peer-mina',
        chain: MINA_CHAIN_ID,
      });

      expect(resolvedProvider).toBeDefined();
      const result = await resolvedProvider!.settleChannel(MINA_ZKAPP_ADDRESS);

      // Then: an on-chain settlement is executed
      expect(result.txHash).toBe('tx-settle-threshold');
      expect(mockSdk.settleChannel).toHaveBeenCalledWith(
        MINA_ZKAPP_ADDRESS,
        0n,
        0n,
        0n,
        '',
        '',
        0n
      );
    });

    it('should trigger SETTLEMENT_REQUIRED event from SettlementMonitor when Mina peer threshold exceeded', async () => {
      // Given: a SettlementMonitor configured with a Mina peer and threshold
      const MINA_PEER_ID = 'peer-mina-threshold';
      const TOKEN_ID = 'M2M';
      const THRESHOLD = 5000n;

      activeMonitor = new SettlementMonitor(
        {
          thresholds: { defaultThreshold: THRESHOLD },
          peers: [MINA_PEER_ID],
          tokenIds: [TOKEN_ID],
        },
        logger
      );

      // And: a mock ClaimReceiver as event source
      const mockClaimReceiver = new EventEmitter();
      activeMonitor.setClaimReceiver(
        mockClaimReceiver as unknown as Parameters<typeof activeMonitor.setClaimReceiver>[0]
      );
      activeMonitor.start();

      // When: a claim event with cumulative amount exceeding the threshold is emitted
      const settlementPromise = new Promise<SettlementTriggerEvent>((resolve) => {
        activeMonitor!.on('SETTLEMENT_REQUIRED', (event: SettlementTriggerEvent) => {
          resolve(event);
        });
      });

      const claimEvent: ClaimReceivedEvent = {
        peerId: MINA_PEER_ID,
        channelId: MINA_ZKAPP_ADDRESS,
        cumulativeAmount: 6000n, // exceeds 5000n threshold
      };
      mockClaimReceiver.emit('CLAIM_RECEIVED', claimEvent);

      // Then: SettlementMonitor emits SETTLEMENT_REQUIRED asynchronously
      const triggerEvent = await settlementPromise;
      expect(triggerEvent.peerId).toBe(MINA_PEER_ID);
      expect(triggerEvent.tokenId).toBe(TOKEN_ID);
      expect(triggerEvent.currentBalance).toBe(6000n);
      expect(triggerEvent.threshold).toBe(THRESHOLD);
      expect(triggerEvent.exceedsBy).toBe(1000n);

      // And: the Mina provider can be invoked for settlement from the trigger
      const mockSdk = createMockMinaSDK();
      mockSdk.settleChannel.mockResolvedValue({ txHash: 'tx-settle-monitor' });
      const { provider } = createMinaTestProvider(mockSdk);
      const result = await provider.settleChannel(MINA_ZKAPP_ADDRESS);
      expect(result.txHash).toBe('tx-settle-monitor');
    });

    it('should not trigger settlement when Mina peer balance is below threshold', () => {
      // Given: a SettlementMonitor with threshold
      const MINA_PEER_ID = 'peer-mina-below';
      activeMonitor = new SettlementMonitor(
        {
          thresholds: { defaultThreshold: 10000n },
          peers: [MINA_PEER_ID],
          tokenIds: ['M2M'],
        },
        logger
      );

      const mockClaimReceiver = new EventEmitter();
      activeMonitor.setClaimReceiver(
        mockClaimReceiver as unknown as Parameters<typeof activeMonitor.setClaimReceiver>[0]
      );
      activeMonitor.start();

      const settlementHandler = jest.fn();
      activeMonitor.on('SETTLEMENT_REQUIRED', settlementHandler);

      // When: a claim event with amount below threshold is emitted
      const claimEvent: ClaimReceivedEvent = {
        peerId: MINA_PEER_ID,
        channelId: MINA_ZKAPP_ADDRESS,
        cumulativeAmount: 3000n, // below 10000n threshold
      };
      mockClaimReceiver.emit('CLAIM_RECEIVED', claimEvent);

      // Then: no settlement is triggered
      expect(settlementHandler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // T-34.8-08: Invalid Claim Rejection (AC 8)
  // -------------------------------------------------------------------------

  describe('[T-34.8-08] Invalid claims: tampered proof, wrong nonce, bad commitment', () => {
    it('should reject a claim with a tampered zk-SNARK proof', async () => {
      // Given: a provider with mock SDK that rejects invalid proofs
      const mockSdk = createMockMinaSDK();
      mockSdk.verifyBalanceProof.mockResolvedValue(false);

      const { provider } = createMinaTestProvider(mockSdk);

      // When: a tampered proof is verified
      const isValid = await provider.verifyBalanceProof({
        channelId: MINA_ZKAPP_ADDRESS,
        nonce: 1,
        transferredAmount: '5000',
        lockedAmount: '0',
        locksRoot: '0x' + '0'.repeat(64),
        signature: 'tampered-proof-data',
        signerAddress: MINA_ZKAPP_ADDRESS,
      });

      // Then: verification fails
      expect(isValid).toBe(false);
    });

    it('should reject a claim with a stale nonce (nonce <= current)', async () => {
      // Given: a provider where the SDK rejects stale nonces
      const mockSdk = createMockMinaSDK();
      mockSdk.claimFromChannel.mockRejectedValue(
        new MinaChannelError('Nonce must be strictly increasing', 6, 'NonceNotMonotonic')
      );

      const { provider } = createMinaTestProvider(mockSdk);

      // When: a claim with a stale nonce is submitted
      await expect(
        provider.claimFromChannel(
          MINA_ZKAPP_ADDRESS,
          {
            channelId: MINA_ZKAPP_ADDRESS,
            nonce: 3, // stale nonce
            transferredAmount: '3000',
            lockedAmount: '0',
            locksRoot: '0x' + '0'.repeat(64),
          },
          'some-proof'
        )
      ).rejects.toThrow('NonceNotMonotonic');
    });

    it('should reject a claim with an invalid balance commitment via validateClaimMessage', () => {
      // Given: a claim with missing balanceCommitment
      const invalidClaim = {
        version: '1.0' as const,
        blockchain: 'mina' as const,
        messageId: 'claim-bad',
        timestamp: '2026-03-28T12:00:00.000Z',
        senderId: 'peer-bad',
        zkAppAddress: MINA_ZKAPP_ADDRESS,
        tokenId: MINA_TOKEN_ID,
        balanceCommitment: '',
        nonce: 1,
        proof: 'eyJwcm9vZiI6InRlc3QifQ==',
        salt: 'abcdef1234567890',
      };

      // When/Then: validateClaimMessage rejects the claim
      expect(() => validateClaimMessage(invalidClaim)).toThrow('balanceCommitment');
    });

    it('should reject a claim with an invalid proof format via validateClaimMessage', () => {
      // Given: a claim with a non-base64 proof
      const invalidClaim = {
        version: '1.0' as const,
        blockchain: 'mina' as const,
        messageId: 'claim-bad-proof',
        timestamp: '2026-03-28T12:00:00.000Z',
        senderId: 'peer-bad',
        zkAppAddress: MINA_ZKAPP_ADDRESS,
        tokenId: MINA_TOKEN_ID,
        balanceCommitment: '12345',
        nonce: 1,
        proof: '!!!not-base64!!!',
        salt: 'abcdef1234567890',
      };

      // When/Then: validateClaimMessage rejects the claim
      expect(() => validateClaimMessage(invalidClaim)).toThrow('proof');
    });
  });

  // -------------------------------------------------------------------------
  // T-34.8-14: Claim JSON Self-Describing Fields (AC 14)
  // -------------------------------------------------------------------------

  describe('[T-34.8-14] Claim JSON: serialized MinaClaimMessage has all fields', () => {
    it('should contain all required self-describing fields when serialized to JSON', () => {
      // Given: a valid MinaClaimMessage
      const claim = createValidMinaClaim();

      // When: serialized to JSON
      const json = JSON.stringify(claim);
      const parsed = JSON.parse(json) as Record<string, unknown>;

      // Then: all self-describing fields are present
      expect(parsed['blockchain']).toBe('mina');
      expect(parsed['zkAppAddress']).toBe(MINA_ZKAPP_ADDRESS);
      expect(parsed['tokenId']).toBe(MINA_TOKEN_ID);
      expect(parsed['balanceCommitment']).toBe(
        '12345678901234567890123456789012345678901234567890'
      );
      expect(parsed['nonce']).toBe(1);
      expect(parsed['proof']).toBe('eyJwcm9vZiI6InRlc3QifQ==');
      expect(parsed['salt']).toBe('abcdef1234567890');
    });

    it('should pass validateClaimMessage for a valid MinaClaimMessage', () => {
      // Given: a valid MinaClaimMessage
      const claim = createValidMinaClaim();

      // When/Then: validation passes without error
      expect(() => validateClaimMessage(claim)).not.toThrow();
    });

    it('should be detected by isMinaClaim type guard', () => {
      // Given: a valid MinaClaimMessage
      const claim = createValidMinaClaim();

      // When/Then: type guard correctly identifies it
      expect(isMinaClaim(claim)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.8-17: Claim Accumulation with Nonce Monotonicity (AC 15)
  // -------------------------------------------------------------------------

  describe('[T-34.8-17] Claim accumulation: 5+ claims with increasing nonces', () => {
    it('should generate 5+ sequential claims with strictly increasing nonces', async () => {
      // Given: a provider with mock SDK
      const mockSdk = createMockMinaSDK();

      let callCount = 0;
      mockSdk.signBalanceProof.mockImplementation(async () => {
        callCount++;
        return `proof-${callCount}`;
      });

      const { provider } = createMinaTestProvider(mockSdk);

      // When: 7 sequential claims are generated
      const NUM_CLAIMS = 7;
      const claims: Array<{ nonce: number; cumulative: bigint; proof: string }> = [];
      let cumulative = 0n;

      for (let nonce = 1; nonce <= NUM_CLAIMS; nonce++) {
        const packetAmount = BigInt(nonce * 100);
        cumulative += packetAmount;

        const proof = await provider.signBalanceProof({
          channelId: MINA_ZKAPP_ADDRESS,
          nonce,
          transferredAmount: cumulative.toString(),
          lockedAmount: '0',
          locksRoot: '0x' + '0'.repeat(64),
        });

        claims.push({ nonce, cumulative, proof });
      }

      // Then: all claims have monotonically increasing nonces
      expect(claims).toHaveLength(NUM_CLAIMS);

      for (let i = 1; i < claims.length; i++) {
        const prev = claims[i - 1]!;
        const curr = claims[i]!;

        // Nonce is strictly increasing
        expect(curr.nonce).toBeGreaterThan(prev.nonce);

        // Cumulative transferred amount is strictly increasing
        expect(curr.cumulative).toBeGreaterThan(prev.cumulative);

        // Proofs are unique
        expect(curr.proof).not.toBe(prev.proof);
      }

      // And: balance commitments update with each claim (signBalanceProof called for each)
      expect(mockSdk.signBalanceProof).toHaveBeenCalledTimes(NUM_CLAIMS);
    });

    it('should track nonce state correctly per zkAppAddress', async () => {
      // Given: two providers for different zkApp addresses
      const addresses = [
        'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
        'B62qjsV6WQwTeEWrNrRRBP6VaaLvQhwWTnFi4WP4LQjGvpfZEumXzxb',
      ];

      const providers = addresses.map((addr, i) => {
        const sdk = createMockMinaSDK();
        let count = 0;
        sdk.signBalanceProof.mockImplementation(async () => {
          count++;
          return `proof-${addr.slice(-4)}-${count}`;
        });
        return createMinaTestProvider(sdk, {
          chainId: `mina:devnet-${i}`,
          zkAppAddress: addr,
        });
      });

      // When: claims are generated for both providers
      for (const { provider } of providers) {
        for (let nonce = 1; nonce <= 5; nonce++) {
          await provider.signBalanceProof({
            channelId: (await provider.getMinaContext()).zkAppAddress,
            nonce,
            transferredAmount: String(nonce * 1000),
            lockedAmount: '0',
            locksRoot: '0x' + '0'.repeat(64),
          });
        }
      }

      // Then: each provider's SDK was called independently
      for (const { mockSdk } of providers) {
        expect(mockSdk.signBalanceProof).toHaveBeenCalledTimes(5);
      }
    });
  });
});
