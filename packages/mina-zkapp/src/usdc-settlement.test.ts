/**
 * USDC token settlement — edge & adversarial custody tests (#194).
 *
 * The happy-path token custody (deposit escrows USDC on the channel token
 * account; a single asymmetric 400/600 settle distributes to both participants
 * and drains the escrow) is already proven by
 * `payment-channel-lifecycle.test.ts` `T-34.4-01`. This file fills the gaps that
 * test misses — the cases that would catch a desync between the channel's
 * `depositTotal` accounting and the actual USDC escrow, or a zero/over-withdraw
 * bug in the distribution:
 *
 *   1. ZERO-AMOUNT settles — one party is owed the WHOLE escrow and the other is
 *      owed 0. The zero-amount `token.transfer` must be skipped (no payout, no
 *      new account) and the credited party receives the FULL escrow.
 *   2. MULTIPLE deposits accumulate on the channel token account before settle,
 *      and `depositTotal` stays in lock-step with the escrowed USDC.
 *   3. CONSERVATION with tokens — `balanceA + balanceB != depositTotal` is
 *      rejected on-chain (claim and close), so a settle can never distribute
 *      more or less than the escrow.
 *   4. OVER-WITHDRAW — settling for more USDC than the channel's token account
 *      actually holds reverts (the token owner cannot move USDC the channel
 *      escrow does not have); accounting alone cannot authorize a phantom
 *      payout.
 *
 * All tests run on the o1js LocalBlockchain with proofsEnabled:false (fast;
 * constraints still enforced). Real on-chain validation is the nightly
 * lightnet job's responsibility.
 *
 * Epic: USDC settlement across all chains (connector#188), ticket #194.
 *
 * @module usdc-settlement.test
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

jest.setTimeout(120000);

describe('USDC settlement -- edge & adversarial custody (#194)', () => {
  let Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  let deployer: Mina.TestPublicKey;
  let participantA: Mina.TestPublicKey;
  let participantB: Mina.TestPublicKey;
  let adminAuthority: Mina.TestPublicKey;
  let zkAppKey: PrivateKey;
  let zkApp: PaymentChannel;

  const channelNonce = Field(7);
  const settlementTimeout = Field(30);

  beforeAll(async () => {
    Local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(Local);
  });

  beforeEach(async () => {
    Local.setGlobalSlot(0);
    [deployer, participantA, participantB, adminAuthority] = Local.testAccounts;

    zkAppKey = PrivateKey.random();
    zkApp = new PaymentChannel(zkAppKey.toPublicKey());
    await deployZkApp(deployer, zkAppKey, zkApp);
  });

  /**
   * Open a USDC channel, mint to the depositor, deposit `deposit` USDC, then
   * record a single claim (balA/balB) and cooperatively close at nonce 2.
   * Returns the deployed token context + the channel address so the caller can
   * settle and assert custody.
   */
  async function openDepositClose(
    deposit: bigint,
    balA: bigint,
    balB: bigint,
    salt: Field,
    mintAmount = deposit
  ): Promise<{ usdc: UsdcContext; channelAddr: ReturnType<PrivateKey['toPublicKey']> }> {
    const usdc = await deployUsdcToken(deployer, adminAuthority);
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
    await mintUsdc(deployer, usdc, participantA, mintAmount);
    await depositToChannel(
      participantA,
      zkApp,
      Field(deposit),
      participantA,
      [participantA.key],
      usdc
    );

    const channelHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);
    await submitClaim(
      deployer,
      zkApp,
      Field(balA),
      Field(balB),
      salt,
      participantA.key,
      participantB.key,
      channelNonce,
      Field(1),
      channelHash,
      [deployer.key]
    );

    const closeMsg = [Field(balA), Field(balB), salt, Field(2)];
    const sigA = Signature.create(participantA.key, closeMsg);
    const sigB = Signature.create(participantB.key, closeMsg);
    Local.setGlobalSlot(100);
    await closeChannel(deployer, zkApp, Field(balA), Field(balB), salt, Field(2), sigA, sigB, [
      deployer.key,
    ]);

    return { usdc, channelAddr: zkAppKey.toPublicKey() };
  }

  // ---------------------------------------------------------------------------
  // 1. Zero-amount settle: recipient (B) is owed the WHOLE escrow, depositor (A)
  //    is owed 0. The balanceA==0 transfer is skipped; B receives the full
  //    escrow; the escrow is fully drained.
  // ---------------------------------------------------------------------------
  it('[P0] settle with balanceA==0 sends the full escrow to participantB and skips the zero refund', async () => {
    const deposit = 1000n * ONE_USDC;
    const balA = 0n;
    const balB = deposit; // B owed everything (unidirectional spend)
    const salt = Field(50001);
    const { usdc, channelAddr } = await openDepositClose(deposit, balA, balB, salt);

    // participantA already has a USDC token account (minted to). participantB
    // does NOT yet — but it is the only payout, so fund 1 account.
    const channelBeforeSettle = (await usdc.token.getBalanceOf(channelAddr)).toBigInt();
    const depositorBeforeSettle = (await usdc.token.getBalanceOf(participantA)).toBigInt();
    expect(channelBeforeSettle).toBe(deposit);

    Local.setGlobalSlot(200);
    await settleChannel(
      deployer,
      zkApp,
      Field(balA),
      Field(balB),
      salt,
      participantA,
      participantB,
      channelNonce,
      [deployer.key, zkAppKey],
      usdc,
      1 // only participantB needs a new token account; A's zero transfer is skipped
    );

    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());

    // B got the ENTIRE escrow; A's balance is unchanged (zero refund skipped).
    expect((await usdc.token.getBalanceOf(participantB)).toBigInt()).toBe(deposit);
    expect((await usdc.token.getBalanceOf(participantA)).toBigInt()).toBe(depositorBeforeSettle);
    // Channel escrow fully drained.
    expect((await usdc.token.getBalanceOf(channelAddr)).toBigInt()).toBe(0n);
  });

  // ---------------------------------------------------------------------------
  // 1b. The mirror case: depositor (A) is owed the WHOLE escrow, recipient (B)
  //     is owed 0. The balanceB==0 transfer is skipped; A is refunded
  //     everything; B never gets a token account.
  // ---------------------------------------------------------------------------
  it('[P0] settle with balanceB==0 refunds the full escrow to participantA and skips the zero payout', async () => {
    const deposit = 750n * ONE_USDC;
    const balA = deposit; // A refunded everything (no value ever moved to B)
    const balB = 0n;
    const salt = Field(50002);
    const { usdc, channelAddr } = await openDepositClose(deposit, balA, balB, salt);

    const channelBeforeSettle = (await usdc.token.getBalanceOf(channelAddr)).toBigInt();
    const depositorBeforeSettle = (await usdc.token.getBalanceOf(participantA)).toBigInt();
    expect(channelBeforeSettle).toBe(deposit);

    Local.setGlobalSlot(200);
    // No new participant token accounts: A already has one, B's payout is skipped.
    await settleChannel(
      deployer,
      zkApp,
      Field(balA),
      Field(balB),
      salt,
      participantA,
      participantB,
      channelNonce,
      [deployer.key, zkAppKey],
      usdc,
      0
    );

    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());

    // A refunded the ENTIRE escrow; channel drained.
    expect((await usdc.token.getBalanceOf(participantA)).toBigInt() - depositorBeforeSettle).toBe(
      deposit
    );
    expect((await usdc.token.getBalanceOf(channelAddr)).toBigInt()).toBe(0n);
  });

  // ---------------------------------------------------------------------------
  // 2. Multiple deposits accumulate on the channel token account, and
  //    depositTotal stays in lock-step with the escrowed USDC. A later settle
  //    distributes the FULL accumulated escrow.
  // ---------------------------------------------------------------------------
  it('[P0] multiple deposits accumulate on the channel token account and depositTotal matches the escrow', async () => {
    const usdc = await deployUsdcToken(deployer, adminAuthority);
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

    const deposit1 = 400n * ONE_USDC;
    const deposit2 = 600n * ONE_USDC;
    const total = deposit1 + deposit2;
    await mintUsdc(deployer, usdc, participantA, total);

    const channelAddr = zkAppKey.toPublicKey();

    // First deposit funds the channel's USDC token account.
    await depositToChannel(
      participantA,
      zkApp,
      Field(deposit1),
      participantA,
      [participantA.key],
      usdc
    );
    expect((await usdc.token.getBalanceOf(channelAddr)).toBigInt()).toBe(deposit1);
    expect(zkApp.depositTotal.get().toString()).toBe(Field(deposit1).toString());

    // Second deposit must NOT re-fund the token account (it already exists).
    await depositToChannel(
      participantA,
      zkApp,
      Field(deposit2),
      participantA,
      [participantA.key],
      usdc,
      false // do not pay the new-account fee again
    );

    // Escrow == sum of deposits; accounting matches the actual escrowed USDC.
    expect((await usdc.token.getBalanceOf(channelAddr)).toBigInt()).toBe(total);
    expect(zkApp.depositTotal.get().toString()).toBe(Field(total).toString());

    // Settle distributing the FULL accumulated escrow drains it exactly.
    const balA = 350n * ONE_USDC;
    const balB = total - balA;
    const salt = Field(60001);
    const channelHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);
    await submitClaim(
      deployer,
      zkApp,
      Field(balA),
      Field(balB),
      salt,
      participantA.key,
      participantB.key,
      channelNonce,
      Field(1),
      channelHash,
      [deployer.key]
    );

    const closeMsg = [Field(balA), Field(balB), salt, Field(2)];
    const sigA = Signature.create(participantA.key, closeMsg);
    const sigB = Signature.create(participantB.key, closeMsg);
    Local.setGlobalSlot(100);
    await closeChannel(deployer, zkApp, Field(balA), Field(balB), salt, Field(2), sigA, sigB, [
      deployer.key,
    ]);

    Local.setGlobalSlot(200);
    await settleChannel(
      deployer,
      zkApp,
      Field(balA),
      Field(balB),
      salt,
      participantA,
      participantB,
      channelNonce,
      [deployer.key, zkAppKey],
      usdc,
      1 // participantB needs a new token account
    );

    expect((await usdc.token.getBalanceOf(participantB)).toBigInt()).toBe(balB);
    // The accumulated escrow is fully drained.
    expect((await usdc.token.getBalanceOf(channelAddr)).toBigInt()).toBe(0n);
  });

  // ---------------------------------------------------------------------------
  // 3. Conservation with tokens: balanceA + balanceB != depositTotal is rejected
  //    on-chain. A claim that under-allocates the escrow (so a later settle would
  //    leave USDC stranded or over-distribute) cannot be recorded.
  // ---------------------------------------------------------------------------
  it('[P0] claim is rejected when balanceA + balanceB != the escrowed depositTotal', async () => {
    const usdc = await deployUsdcToken(deployer, adminAuthority);
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

    const deposit = 1000n * ONE_USDC;
    await mintUsdc(deployer, usdc, participantA, deposit);
    await depositToChannel(
      participantA,
      zkApp,
      Field(deposit),
      participantA,
      [participantA.key],
      usdc
    );
    expect(zkApp.depositTotal.get().toString()).toBe(Field(deposit).toString());

    // balА + balB == 900 USDC != 1000 USDC escrowed → conservation violated.
    const balA = 500n * ONE_USDC;
    const balB = 400n * ONE_USDC;
    const salt = Field(70001);
    const channelHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);

    await expect(
      submitClaim(
        deployer,
        zkApp,
        Field(balA),
        Field(balB),
        salt,
        participantA.key,
        participantB.key,
        channelNonce,
        Field(1),
        channelHash,
        [deployer.key]
      )
    ).rejects.toThrow(/balance conservation invariant/);

    // The bad claim was NOT recorded — escrow + accounting are untouched.
    expect(zkApp.depositTotal.get().toString()).toBe(Field(deposit).toString());
    expect((await usdc.token.getBalanceOf(zkAppKey.toPublicKey())).toBigInt()).toBe(deposit);
  });

  it('[P0] cooperative close is rejected when revealed balances do not sum to the escrowed depositTotal', async () => {
    const usdc = await deployUsdcToken(deployer, adminAuthority);
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

    const deposit = 1000n * ONE_USDC;
    await mintUsdc(deployer, usdc, participantA, deposit);
    await depositToChannel(
      participantA,
      zkApp,
      Field(deposit),
      participantA,
      [participantA.key],
      usdc
    );

    // Try to close revealing 600 + 600 == 1200 != 1000 escrowed. Even with valid
    // dual signatures over the over-allocated split, initiateClose's conservation
    // check rejects it, so settle can never over-distribute the escrow.
    const balA = 600n * ONE_USDC;
    const balB = 600n * ONE_USDC;
    const salt = Field(70002);
    const closeMsg = [Field(balA), Field(balB), salt, Field(1)];
    const sigA = Signature.create(participantA.key, closeMsg);
    const sigB = Signature.create(participantB.key, closeMsg);

    Local.setGlobalSlot(100);
    await expect(
      closeChannel(deployer, zkApp, Field(balA), Field(balB), salt, Field(1), sigA, sigB, [
        deployer.key,
      ])
    ).rejects.toThrow(/balanceA \+ balanceB must equal depositTotal/);

    // Channel stays OPEN; escrow intact.
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.OPEN.toString());
    expect((await usdc.token.getBalanceOf(zkAppKey.toPublicKey())).toBigInt()).toBe(deposit);
  });

  // ---------------------------------------------------------------------------
  // 4. Over-withdraw: the channel token account holds only `deposit` USDC. If the
  //    settle tries to move MORE USDC than the channel actually escrows, the
  //    token transfer must fail — the channel's accounting cannot conjure USDC it
  //    never received. Here we simulate a settle whose USDC payouts exceed the
  //    escrow (the channel zkApp's conservation makes this unreachable through
  //    the happy path, but the token layer is the last line of defense).
  // ---------------------------------------------------------------------------
  it('[P0] settle cannot distribute more USDC than the channel token account holds (over-withdraw reverts)', async () => {
    const deposit = 1000n * ONE_USDC;
    const balA = 400n * ONE_USDC;
    const balB = 600n * ONE_USDC;
    const salt = Field(80001);
    // Channel escrow holds exactly `deposit`. Build the close at the legitimate
    // 400/600 split so on-chain accounting is consistent...
    const { usdc, channelAddr } = await openDepositClose(deposit, balA, balB, salt);
    expect((await usdc.token.getBalanceOf(channelAddr)).toBigInt()).toBe(deposit);

    // ...but attempt to DISTRIBUTE inflated USDC payouts (balB+extra) out of the
    // channel token account. Because the channel only escrows `deposit`, the
    // USDC token owner cannot move more out than is held: the token.transfer
    // underflows the channel's token balance and the tx reverts.
    Local.setGlobalSlot(200);
    const inflatedB = balB + 1n * ONE_USDC; // would overdraw the escrow by 1 USDC

    await expect(
      Mina.transaction(deployer, async () => {
        // Distribute MORE than the escrow holds (skip the channel `settle`
        // accounting call — we are probing the token layer directly).
        const { UInt64, AccountUpdate } = await import('o1js');
        AccountUpdate.fundNewAccount(deployer, 1);
        await usdc.token.transfer(
          channelAddr,
          participantB,
          UInt64.Unsafe.fromField(Field(inflatedB))
        );
        await usdc.token.transfer(channelAddr, participantA, UInt64.Unsafe.fromField(Field(balA)));
      }).then(async (tx) => {
        await tx.prove();
        await tx.sign([deployer.key, zkAppKey]).send();
      })
    ).rejects.toThrow();

    // Escrow untouched: the failed over-withdraw did not drain the channel.
    expect((await usdc.token.getBalanceOf(channelAddr)).toBigInt()).toBe(deposit);
  });
});
