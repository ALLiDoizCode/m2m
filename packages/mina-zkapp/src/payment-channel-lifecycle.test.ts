/**
 * Integration Tests for Story 34.3: Mina Payment Channel zkApp -- Full Lifecycle
 *
 * Tests cover the complete channel lifecycle (open -> deposit -> claim -> close -> settle)
 * and balance conservation invariant verification at every state transition.
 *
 * All tests run with proofsEnabled: false on a local blockchain for fast execution.
 * o1js enforces circuit constraints even with proofsEnabled: false.
 *
 * Test IDs: T-34.3-02, T-34.3-03
 * Test Level: Integration (o1js LocalBlockchain, proofsEnabled: false)
 * Epic: 34 -- Mina Protocol Payment Channel Provider (ZK-Private Settlement)
 *
 * @module payment-channel-lifecycle.test
 */

import { Mina, PrivateKey, Field, Poseidon, Signature } from 'o1js';

import { PaymentChannel } from './PaymentChannel';
import { CHANNEL_STATE } from './constants';
import {
  deployZkApp,
  initializeChannel,
  depositToChannel,
  submitClaim,
  closeChannel,
  settleChannel,
} from './test-helpers';

jest.setTimeout(60000); // 60 seconds — lifecycle test runs full open->deposit->claim->close->settle

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('PaymentChannel zkApp -- Full Lifecycle Integration (Story 34.3)', () => {
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

  // T-34.3-02: Full lifecycle -- open -> deposit -> claim (x2) -> close -> settle
  // AC: 2
  it('[P0] T-34.3-02: complete lifecycle executes successfully with correct final state', async () => {
    // Step 1: Initialize channel
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
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.OPEN.toString());

    // Step 2: Deposit
    await depositToChannel(participantA, zkApp, depositAmount, participantA, [participantA.key]);
    expect(zkApp.depositTotal.get().toString()).toBe(depositAmount.toString());

    const channelHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);

    // Step 3: First claim -- split 700M / 300M
    const balA1 = Field(700_000_000);
    const balB1 = Field(300_000_000);
    const salt1 = Field(11111);
    await submitClaim(
      deployer,
      zkApp,
      balA1,
      balB1,
      salt1,
      participantA.key,
      participantB.key,
      channelNonce,
      Field(1),
      channelHash,
      [deployer.key]
    );

    const expectedCommitment1 = Poseidon.hash([balA1, balB1, salt1]);
    expect(zkApp.balanceCommitment.get().toString()).toBe(expectedCommitment1.toString());
    expect(zkApp.nonceField.get().toString()).toBe(Field(1).toString());
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.OPEN.toString());

    // Step 4: Second claim -- split 400M / 600M
    const balA2 = Field(400_000_000);
    const balB2 = Field(600_000_000);
    const salt2 = Field(22222);
    await submitClaim(
      deployer,
      zkApp,
      balA2,
      balB2,
      salt2,
      participantA.key,
      participantB.key,
      channelNonce,
      Field(2),
      channelHash,
      [deployer.key]
    );

    const expectedCommitment2 = Poseidon.hash([balA2, balB2, salt2]);
    expect(zkApp.balanceCommitment.get().toString()).toBe(expectedCommitment2.toString());
    expect(zkApp.nonceField.get().toString()).toBe(Field(2).toString());
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.OPEN.toString());

    // Step 5: Initiate close with latest balances
    const closeSalt = salt2;
    const closeMsg = [balA2, balB2, closeSalt, Field(3)];
    const sigA = Signature.create(participantA.key, closeMsg);
    const sigB = Signature.create(participantB.key, closeMsg);

    Local.setGlobalSlot(100);
    await closeChannel(deployer, zkApp, balA2, balB2, closeSalt, Field(3), sigA, sigB, [
      deployer.key,
    ]);

    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.CLOSING.toString());
    expect(zkApp.closedAtSlot.get().toBigInt()).toBeGreaterThanOrEqual(100n);

    // Step 6: Settle after challenge period
    Local.setGlobalSlot(200);
    await settleChannel(
      deployer,
      zkApp,
      balA2,
      balB2,
      closeSalt,
      participantA,
      participantB,
      channelNonce,
      [deployer.key]
    );

    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());
  });

  // T-34.3-03: Balance conservation holds at every state transition
  // AC: 3
  it('[P0] T-34.3-03: balance conservation invariant holds at every state transition', async () => {
    // Initialize
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

    // Conservation check after init: depositTotal == 0, commitment covers (0, 0)
    const initDeposit = zkApp.depositTotal.get();
    expect(initDeposit.toString()).toBe(Field(0).toString());

    // Deposit 1B nanomina
    await depositToChannel(participantA, zkApp, depositAmount, participantA, [participantA.key]);
    const afterDepositTotal = zkApp.depositTotal.get();
    expect(afterDepositTotal.toString()).toBe(depositAmount.toString());

    const channelHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);

    // Claim 1: 600M / 400M -- conservation: 600M + 400M == 1B
    const balA1 = Field(600_000_000);
    const balB1 = Field(400_000_000);
    const salt1 = Field(33333);
    await submitClaim(
      deployer,
      zkApp,
      balA1,
      balB1,
      salt1,
      participantA.key,
      participantB.key,
      channelNonce,
      Field(1),
      channelHash,
      [deployer.key]
    );

    // Verify: depositTotal unchanged, balanceA + balanceB == depositTotal
    expect(zkApp.depositTotal.get().toString()).toBe(depositAmount.toString());
    // The contract enforced balA1 + balB1 == depositTotal in the circuit

    // Claim 2: 200M / 800M -- conservation: 200M + 800M == 1B
    const balA2 = Field(200_000_000);
    const balB2 = Field(800_000_000);
    const salt2 = Field(44444);
    await submitClaim(
      deployer,
      zkApp,
      balA2,
      balB2,
      salt2,
      participantA.key,
      participantB.key,
      channelNonce,
      Field(2),
      channelHash,
      [deployer.key]
    );
    expect(zkApp.depositTotal.get().toString()).toBe(depositAmount.toString());

    // Close with latest balances -- conservation checked by initiateClose
    const closeMsg = [balA2, balB2, salt2, Field(3)];
    const sigA = Signature.create(participantA.key, closeMsg);
    const sigB = Signature.create(participantB.key, closeMsg);

    Local.setGlobalSlot(100);
    await closeChannel(deployer, zkApp, balA2, balB2, salt2, Field(3), sigA, sigB, [deployer.key]);

    // depositTotal unchanged after close
    expect(zkApp.depositTotal.get().toString()).toBe(depositAmount.toString());

    // Settle -- commitment must match, conservation verified
    Local.setGlobalSlot(200);
    await settleChannel(
      deployer,
      zkApp,
      balA2,
      balB2,
      salt2,
      participantA,
      participantB,
      channelNonce,
      [deployer.key]
    );

    // Final state: SETTLED, depositTotal still 1B
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());
    expect(zkApp.depositTotal.get().toString()).toBe(depositAmount.toString());
  });

  // T-34.4-01: FUND CUSTODY + DISTRIBUTION — the heart of Story 34.4.
  // Proves that deposit() actually escrows native MINA on the zkApp account and
  // that settle() debits that escrow, crediting the recipient (participantB, the
  // apex analog) balanceB and refunding the depositor (participantA) balanceA.
  // This is the Mina mirror of the Solana SETTLE_CHANNEL vault→recipient ATA
  // transfer — the recipient is TOKEN-CREDITED at close.
  it('[P0] T-34.4-01: deposit escrows MINA on the zkApp and settle credits the recipient', async () => {
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

    const zkAppAddr = zkAppKey.toPublicKey();
    const zkAppBalBeforeDeposit = Mina.getBalance(zkAppAddr).toBigInt();
    const depositorBeforeDeposit = Mina.getBalance(participantA).toBigInt();

    // Deposit escrows depositAmount nanomina on the zkApp account.
    await depositToChannel(participantA, zkApp, depositAmount, participantA, [participantA.key]);

    const zkAppBalAfterDeposit = Mina.getBalance(zkAppAddr).toBigInt();
    const depositorAfterDeposit = Mina.getBalance(participantA).toBigInt();
    const depositBig = depositAmount.toBigInt();

    // zkApp account GAINED exactly depositAmount; depositor LOST at least it
    // (plus the tx fee). This is real on-chain custody, not a bare Field record.
    expect(zkAppBalAfterDeposit - zkAppBalBeforeDeposit).toBe(depositBig);
    expect(depositorBeforeDeposit - depositorAfterDeposit).toBeGreaterThanOrEqual(depositBig);

    // Single claim: recipient (B) is owed 600M, depositor (A) keeps 400M.
    const channelHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);
    const balA = Field(400_000_000);
    const balB = Field(600_000_000);
    const salt = Field(99999);
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

    // Close with the latest balances.
    const closeMsg = [balA, balB, salt, Field(2)];
    const sigA = Signature.create(participantA.key, closeMsg);
    const sigB = Signature.create(participantB.key, closeMsg);
    Local.setGlobalSlot(100);
    await closeChannel(deployer, zkApp, balA, balB, salt, Field(2), sigA, sigB, [deployer.key]);

    // ── Capture recipient + depositor balances immediately BEFORE settle ──
    const recipientBeforeSettle = Mina.getBalance(participantB).toBigInt();
    const depositorBeforeSettle = Mina.getBalance(participantA).toBigInt();
    const zkAppBeforeSettle = Mina.getBalance(zkAppAddr).toBigInt();

    Local.setGlobalSlot(200);
    await settleChannel(
      deployer,
      zkApp,
      balA,
      balB,
      salt,
      participantA,
      participantB,
      channelNonce,
      [deployer.key]
    );

    const recipientAfterSettle = Mina.getBalance(participantB).toBigInt();
    const depositorAfterSettle = Mina.getBalance(participantA).toBigInt();
    const zkAppAfterSettle = Mina.getBalance(zkAppAddr).toBigInt();

    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());

    // RECIPIENT (participantB / apex) is CREDITED balanceB at settle.
    expect(recipientAfterSettle - recipientBeforeSettle).toBe(balB.toBigInt());
    // DEPOSITOR (participantA) is REFUNDED balanceA (deployer pays the settle fee,
    // not participantA, so participantA's delta is exactly the refund).
    expect(depositorAfterSettle - depositorBeforeSettle).toBe(balA.toBigInt());
    // The zkApp escrow is drained by exactly depositTotal (balA + balB).
    expect(zkAppBeforeSettle - zkAppAfterSettle).toBe(depositBig);
  });
});
