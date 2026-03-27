/**
 * Security Tests for Story 34.3: Mina Payment Channel zkApp -- Security & Edge Cases
 *
 * Tests cover nonce replay attacks, challenge period timing enforcement,
 * zero-balance edge cases, and MAX_SAFE_AMOUNT boundary conditions.
 *
 * All tests run with proofsEnabled: false on a local blockchain for fast execution.
 * o1js enforces circuit constraints even with proofsEnabled: false.
 *
 * Test IDs: T-34.3-04, T-34.3-06, T-34.3-07, T-34.3-08
 * Test Level: Security (o1js LocalBlockchain, proofsEnabled: false)
 * Epic: 34 -- Mina Protocol Payment Channel Provider (ZK-Private Settlement)
 *
 * @module payment-channel-security.test
 */

import { Mina, PrivateKey, Field, Poseidon, Signature } from 'o1js';

import { PaymentChannel } from './PaymentChannel';
import { CHANNEL_STATE, ASSERT_MESSAGES, MAX_SAFE_AMOUNT } from './constants';
import {
  deployZkApp,
  initializeChannel,
  depositToChannel,
  submitClaim,
  closeChannel,
  settleChannel,
} from './test-helpers';

jest.setTimeout(60000); // 60 seconds — security tests run multiple transaction sequences

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('PaymentChannel zkApp -- Security & Edge Cases (Story 34.3)', () => {
  let Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  let deployer: Mina.TestPublicKey;
  let participantA: Mina.TestPublicKey;
  let participantB: Mina.TestPublicKey;
  let zkAppKey: PrivateKey;
  let zkApp: PaymentChannel;

  const channelNonce = Field(42);
  const settlementTimeout = Field(30);
  const tokenId = Field(1);
  const depositAmount = Field(1_000_000_000);

  beforeAll(async () => {
    Local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(Local);
  });

  beforeEach(async () => {
    Local.setGlobalSlot(0);
    [deployer, participantA, participantB] = Local.testAccounts;

    zkAppKey = PrivateKey.random();
    zkApp = new PaymentChannel(zkAppKey.toPublicKey());

    await deployZkApp(deployer, zkAppKey, zkApp);
  });

  // =========================================================================
  // T-34.3-04: Nonce Replay Attack
  // AC: 4
  // =========================================================================

  it('[P0] T-34.3-04: nonce replay across multiple claims is rejected', async () => {
    // Setup: open channel with deposit
    await initializeChannel(
      deployer,
      zkApp,
      participantA,
      participantB,
      channelNonce,
      settlementTimeout,
      tokenId,
      [deployer.key, participantA.key, participantB.key]
    );
    await depositToChannel(participantA, zkApp, depositAmount, participantA, [participantA.key]);

    const channelHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);

    // Claim 1 with nonce 1 -- succeeds
    await submitClaim(
      deployer,
      zkApp,
      Field(700_000_000),
      Field(300_000_000),
      Field(11111),
      participantA.key,
      participantB.key,
      channelNonce,
      Field(1),
      channelHash,
      [deployer.key]
    );

    // Claim 2 with nonce 2 -- succeeds
    await submitClaim(
      deployer,
      zkApp,
      Field(500_000_000),
      Field(500_000_000),
      Field(22222),
      participantA.key,
      participantB.key,
      channelNonce,
      Field(2),
      channelHash,
      [deployer.key]
    );

    // Claim 3 reusing nonce 1 -- must be rejected
    await expect(
      submitClaim(
        deployer,
        zkApp,
        Field(600_000_000),
        Field(400_000_000),
        Field(33333),
        participantA.key,
        participantB.key,
        channelNonce,
        Field(1),
        channelHash,
        [deployer.key]
      )
    ).rejects.toThrow(ASSERT_MESSAGES.NONCE_MUST_INCREASE);

    // Claim 4 reusing nonce 2 -- must also be rejected
    await expect(
      submitClaim(
        deployer,
        zkApp,
        Field(600_000_000),
        Field(400_000_000),
        Field(44444),
        participantA.key,
        participantB.key,
        channelNonce,
        Field(2),
        channelHash,
        [deployer.key]
      )
    ).rejects.toThrow(ASSERT_MESSAGES.NONCE_MUST_INCREASE);
  });

  // =========================================================================
  // T-34.3-06: Challenge Period Timing Enforcement
  // AC: 6
  // =========================================================================

  it('[P0] T-34.3-06: settle before timeout rejected, settle after timeout succeeds', async () => {
    // Setup: open, deposit, close
    await initializeChannel(
      deployer,
      zkApp,
      participantA,
      participantB,
      channelNonce,
      settlementTimeout,
      tokenId,
      [deployer.key, participantA.key, participantB.key]
    );
    await depositToChannel(participantA, zkApp, depositAmount, participantA, [participantA.key]);

    const balanceA = depositAmount;
    const balanceB = Field(0);
    const salt = Field(55555);
    const closeMsg = [balanceA, balanceB, salt, Field(1)];
    const sigA = Signature.create(participantA.key, closeMsg);
    const sigB = Signature.create(participantB.key, closeMsg);

    // Set slot to 100, then close
    Local.setGlobalSlot(100);
    await closeChannel(deployer, zkApp, balanceA, balanceB, salt, Field(1), sigA, sigB, [
      deployer.key,
    ]);

    // Read closedAtSlot and timeout from on-chain state
    const closedAtSlotField = zkApp.closedAtSlot.get();
    const timeoutField = zkApp.settlementTimeout.get();
    const closedAt = Number(closedAtSlotField.toBigInt());
    const timeout = Number(timeoutField.toBigInt());

    // Try settle before timeout -- should fail
    Local.setGlobalSlot(closedAt + timeout - 1);
    await expect(
      settleChannel(
        deployer,
        zkApp,
        balanceA,
        balanceB,
        salt,
        participantA,
        participantB,
        channelNonce,
        [deployer.key]
      )
    ).rejects.toThrow(ASSERT_MESSAGES.CHALLENGE_PERIOD_NOT_ELAPSED);

    // Advance past timeout -- should succeed
    Local.setGlobalSlot(closedAt + timeout);
    await settleChannel(
      deployer,
      zkApp,
      balanceA,
      balanceB,
      salt,
      participantA,
      participantB,
      channelNonce,
      [deployer.key]
    );

    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());
  });

  // =========================================================================
  // T-34.3-07: Zero Balance Edge Case
  // AC: 7
  // =========================================================================

  it('[P1] T-34.3-07: claim with balanceA=depositTotal, balanceB=0 succeeds', async () => {
    await initializeChannel(
      deployer,
      zkApp,
      participantA,
      participantB,
      channelNonce,
      settlementTimeout,
      tokenId,
      [deployer.key, participantA.key, participantB.key]
    );
    await depositToChannel(participantA, zkApp, depositAmount, participantA, [participantA.key]);

    const channelHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);

    // Claim with all funds to participant A
    const balA = depositAmount;
    const balB = Field(0);
    const salt = Field(66666);
    await submitClaim(
      deployer,
      zkApp,
      balA,
      balB,
      salt,
      participantA.key,
      participantB.key,
      channelNonce,
      Field(1),
      channelHash,
      [deployer.key]
    );

    const expectedCommitment = Poseidon.hash([balA, balB, salt]);
    expect(zkApp.balanceCommitment.get().toString()).toBe(expectedCommitment.toString());
  });

  it('[P1] T-34.3-07b: claim with balanceA=0, balanceB=depositTotal succeeds', async () => {
    await initializeChannel(
      deployer,
      zkApp,
      participantA,
      participantB,
      channelNonce,
      settlementTimeout,
      tokenId,
      [deployer.key, participantA.key, participantB.key]
    );
    await depositToChannel(participantA, zkApp, depositAmount, participantA, [participantA.key]);

    const channelHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);

    // Claim with all funds to participant B
    const balA = Field(0);
    const balB = depositAmount;
    const salt = Field(77777);
    await submitClaim(
      deployer,
      zkApp,
      balA,
      balB,
      salt,
      participantA.key,
      participantB.key,
      channelNonce,
      Field(1),
      channelHash,
      [deployer.key]
    );

    const expectedCommitment = Poseidon.hash([balA, balB, salt]);
    expect(zkApp.balanceCommitment.get().toString()).toBe(expectedCommitment.toString());
  });

  // =========================================================================
  // T-34.3-08: Maximum Field Value Boundary
  // AC: MAX_SAFE_AMOUNT boundary edge case
  // =========================================================================

  it('[P1] T-34.3-08: claim near MAX_SAFE_AMOUNT does not overflow', async () => {
    // Use a large deposit near MAX_SAFE_AMOUNT
    const largeDeposit = Field(BigInt('18446744073709551614')); // MAX_SAFE_AMOUNT - 1

    await initializeChannel(
      deployer,
      zkApp,
      participantA,
      participantB,
      channelNonce,
      settlementTimeout,
      tokenId,
      [deployer.key, participantA.key, participantB.key]
    );
    await depositToChannel(participantA, zkApp, largeDeposit, participantA, [participantA.key]);

    const channelHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);

    // Claim splitting the large deposit -- both values within safe range
    const balA = Field(BigInt('9223372036854775807')); // ~half of large deposit
    const balB = Field(BigInt('9223372036854775807'));
    // balA + balB = 18446744073709551614 == largeDeposit
    const salt = Field(88888);

    await submitClaim(
      deployer,
      zkApp,
      balA,
      balB,
      salt,
      participantA.key,
      participantB.key,
      channelNonce,
      Field(1),
      channelHash,
      [deployer.key]
    );

    const expectedCommitment = Poseidon.hash([balA, balB, salt]);
    expect(zkApp.balanceCommitment.get().toString()).toBe(expectedCommitment.toString());
  });

  it('[P1] T-34.3-08b: deposit exceeding MAX_SAFE_AMOUNT is rejected', async () => {
    await initializeChannel(
      deployer,
      zkApp,
      participantA,
      participantB,
      channelNonce,
      settlementTimeout,
      tokenId,
      [deployer.key, participantA.key, participantB.key]
    );

    const unsafeAmount = MAX_SAFE_AMOUNT.add(Field(1));
    await expect(
      depositToChannel(participantA, zkApp, unsafeAmount, participantA, [participantA.key])
    ).rejects.toThrow(ASSERT_MESSAGES.AMOUNT_EXCEEDS_SAFE_RANGE);
  });
});
