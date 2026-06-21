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
  deployUsdcToken,
  mintUsdc,
  UsdcContext,
} from './test-helpers';
import { ONE_USDC } from './usdc-token';

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

  // T-34.4-01 (#191 USDC): TOKEN CUSTODY + DISTRIBUTION — the heart of the
  // token-aware channel. Proves that deposit() escrows the USDC custom token on
  // the channel's TOKEN account and that settle() debits that escrow, crediting
  // the recipient (participantB, the apex analog) balanceB USDC and refunding the
  // depositor (participantA) balanceA USDC. Custody is asserted via the USDC
  // token balances (token.getBalanceOf), NOT native MINA. This is the Mina mirror
  // of the Solana SETTLE_CHANNEL vault→recipient ATA transfer.
  it('[P0] T-34.4-01: deposit escrows USDC on the channel and settle distributes it to participants', async () => {
    // adminAuthority must be a funded account (mint authority).
    const adminAuthority = Local.testAccounts[3];
    const usdc: UsdcContext = await deployUsdcToken(deployer, adminAuthority);

    // The channel's stored tokenId_ must equal the USDC tokenId (one channel per
    // (apex, client, token)). channelHash stays native — tokenId is a parameter.
    await initializeChannel(
      deployer,
      zkApp,
      participantA,
      participantB,
      channelNonce,
      settlementTimeout,
      usdc.tokenId,
      [deployer.key, participantA.key, participantB.key]
    );
    expect(zkApp.tokenId_.get().toString()).toBe(usdc.tokenId.toString());

    // Amounts are USDC base units (6 dp). Mint 2,000 USDC to the depositor.
    const depositUsdc = Field(1000n * ONE_USDC); // 1,000 USDC
    await mintUsdc(deployer, usdc, participantA, 2000n * ONE_USDC);

    const channelAddr = zkAppKey.toPublicKey();
    const depositorBeforeDeposit = (await usdc.token.getBalanceOf(participantA)).toBigInt();

    // Deposit escrows depositUsdc on the channel's USDC token account (funded on
    // first deposit). The depositor signs (authorizes the token outflow + binds).
    await depositToChannel(
      participantA,
      zkApp,
      depositUsdc,
      participantA,
      [participantA.key],
      usdc
    );

    const channelUsdcAfterDeposit = (await usdc.token.getBalanceOf(channelAddr)).toBigInt();
    const depositorUsdcAfterDeposit = (await usdc.token.getBalanceOf(participantA)).toBigInt();
    const depositBig = depositUsdc.toBigInt();

    // Channel's USDC token account GAINED exactly the deposit; depositor LOST it.
    expect(channelUsdcAfterDeposit).toBe(depositBig);
    expect(depositorBeforeDeposit - depositorUsdcAfterDeposit).toBe(depositBig);
    // depositTotal accounting matches the escrowed USDC.
    expect(zkApp.depositTotal.get().toString()).toBe(depositUsdc.toString());

    // Single claim: recipient (B) is owed 600 USDC, depositor (A) keeps 400 USDC.
    const channelHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);
    const balA = Field(400n * ONE_USDC);
    const balB = Field(600n * ONE_USDC);
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

    // ── Capture USDC balances immediately BEFORE settle ──
    // participantB has no USDC token account yet (will be created at settle);
    // participantA already has one (it was minted to). depositorBeforeSettle reads
    // the depositor's remaining USDC after the deposit.
    const depositorBeforeSettle = (await usdc.token.getBalanceOf(participantA)).toBigInt();
    const channelBeforeSettle = (await usdc.token.getBalanceOf(channelAddr)).toBigInt();

    Local.setGlobalSlot(200);
    // settle distributes USDC: channel → B (balB) and channel → A (balA). The
    // channel key (zkAppKey) MUST sign to authorize the channel token outflows.
    // participantB needs a new USDC token account (fund 1); participantA already
    // has one (fund 0 for it).
    await settleChannel(
      deployer,
      zkApp,
      balA,
      balB,
      salt,
      participantA,
      participantB,
      channelNonce,
      [deployer.key, zkAppKey],
      usdc,
      1 // fund participantB's new USDC token account
    );

    const recipientAfterSettle = (await usdc.token.getBalanceOf(participantB)).toBigInt();
    const depositorAfterSettle = (await usdc.token.getBalanceOf(participantA)).toBigInt();
    const channelAfterSettle = (await usdc.token.getBalanceOf(channelAddr)).toBigInt();

    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());

    // RECIPIENT (participantB / apex) is CREDITED balanceB USDC at settle.
    expect(recipientAfterSettle).toBe(balB.toBigInt());
    // DEPOSITOR (participantA) is REFUNDED balanceA USDC.
    expect(depositorAfterSettle - depositorBeforeSettle).toBe(balA.toBigInt());
    // The channel USDC escrow is drained by exactly depositTotal (balA + balB).
    expect(channelBeforeSettle - channelAfterSettle).toBe(depositBig);
  });
});
