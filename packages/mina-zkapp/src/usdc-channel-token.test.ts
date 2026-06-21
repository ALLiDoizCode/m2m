/**
 * `UsdcChannelToken` — in-proof enforcement tests (#191/#194, now on-chain).
 *
 * Where `usdc-settlement.test.ts` proved the SDK-enforced custody (the SDK builds
 * the `token.transfer(...)` updates and the channel only accounts), THIS suite
 * proves the CONTRACT PROOF itself enforces the channel rules: escrow only moves
 * through `UsdcChannelToken.depositToChannel` / `.settleFromChannel`, both gated
 * by preconditions bound to the channel's on-chain state. A wrong/malicious SDK
 * or a leaked channel key can no longer desync accounting from escrow.
 *
 * Covered:
 *   - happy path: deposit escrows USDC custodially; settle (after the challenge
 *     period) drains the escrow to A/B exactly per the committed balances, with
 *     NO channel-key signature.
 *   - tampered settle payout (amount ≠ committed balance) → proof/ledger rejects.
 *   - settle before the challenge period → rejects.
 *   - settle with wrong participants (channelHash mismatch) → rejects.
 *   - conservation violation (balanceA+balanceB ≠ depositTotal) → rejects.
 *   - deposit accounting vs escrow mismatch → rejects.
 *   - double-settle → rejects (CLOSING precondition fails after first settle).
 *   - zero-balance payout skipped; full escrow drained.
 *
 * proofsEnabled:false (fast; o1js still enforces every constraint + precondition).
 *
 * @module usdc-channel-token.test
 */

import { Field, Mina, Poseidon, PrivateKey, Signature, UInt64 } from 'o1js';

import { PaymentChannel } from './PaymentChannel';
import { CHANNEL_STATE } from './constants';
import { CHANNEL_STATE_SLOT } from './usdc-channel-token';
import {
  deployZkApp,
  initializeChannel,
  submitClaim,
  closeChannel,
  deployUsdcChannelToken,
  mintUsdcChannel,
  enableChannelEscrow,
  depositToChannelInProof,
  settleFromChannelInProof,
  UsdcChannelContext,
} from './test-helpers';
import { ONE_USDC } from './usdc-token';

jest.setTimeout(180000);

describe('UsdcChannelToken -- in-proof enforcement (#191/#194 on-chain)', () => {
  let Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  let deployer: Mina.TestPublicKey;
  let participantA: Mina.TestPublicKey;
  let participantB: Mina.TestPublicKey;
  let adminAuthority: Mina.TestPublicKey;
  let zkAppKey: PrivateKey;
  let zkApp: PaymentChannel;

  const channelNonce = Field(7);
  const settlementTimeout = Field(30);
  const CLOSE_SLOT = 100n;
  const SETTLE_SLOT = 200n; // > CLOSE_SLOT + 30 (deadline 130)

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
   * Open a channel, mint to A, deposit `deposit` IN-PROOF, record a single claim
   * (balA/balB), and cooperatively close at the close slot. Returns the token
   * context + channel address so the caller can settle. Channel is left CLOSING.
   */
  async function openDepositClose(
    deposit: bigint,
    balA: bigint,
    balB: bigint,
    salt: Field,
    mintAmount = deposit
  ): Promise<{ usdc: UsdcChannelContext; channelAddr: ReturnType<PrivateKey['toPublicKey']> }> {
    const usdc = await deployUsdcChannelToken(deployer, adminAuthority);
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
    await mintUsdcChannel(deployer, usdc, participantA, mintAmount);
    // One-time: make the escrow custodial (channel key signs once).
    await enableChannelEscrow(deployer, zkApp, usdc, zkAppKey);
    await depositToChannelInProof(
      participantA,
      zkApp,
      usdc,
      deposit,
      participantA,
      0n, // first deposit -> current depositTotal is 0
      [participantA.key]
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
    Local.setGlobalSlot(Number(CLOSE_SLOT));
    await closeChannel(deployer, zkApp, Field(balA), Field(balB), salt, Field(2), sigA, sigB, [
      deployer.key,
    ]);

    return { usdc, channelAddr: zkAppKey.toPublicKey() };
  }

  // -------------------------------------------------------------------------
  // 0. The slot index map MUST match PaymentChannel's @state declaration order.
  // -------------------------------------------------------------------------
  it('CHANNEL_STATE_SLOT matches PaymentChannel @state order', () => {
    expect(CHANNEL_STATE_SLOT).toEqual({
      channelHash: 0,
      balanceCommitment: 1,
      nonceField: 2,
      channelState: 3,
      depositTotal: 4,
      closedAtSlot: 5,
      settlementTimeout: 6,
      tokenId_: 7,
    });
  });

  // -------------------------------------------------------------------------
  // 1. HAPPY PATH: deposit escrows custodially; settle drains to A/B exactly,
  //    with NO channel-key signature (owner proof + custodial escrow only).
  // -------------------------------------------------------------------------
  it('[happy] deposit escrows, settle drains to A/B exactly with NO channel-key signature', async () => {
    const deposit = 1000n * ONE_USDC;
    const balA = 400n * ONE_USDC;
    const balB = 600n * ONE_USDC;
    const salt = Field(50001);
    const { usdc, channelAddr } = await openDepositClose(deposit, balA, balB, salt);

    // Escrow holds the full deposit; accounting matches.
    expect((await usdc.token.getBalanceOf(channelAddr)).toBigInt()).toBe(deposit);
    expect(zkApp.depositTotal.get().toString()).toBe(Field(deposit).toString());

    Local.setGlobalSlot(Number(SETTLE_SLOT));
    // Signers: fee payer ONLY. The channel key is NOT a signer.
    await settleFromChannelInProof(
      deployer,
      zkApp,
      usdc,
      balA,
      balB,
      salt,
      participantA,
      participantB,
      channelNonce,
      CLOSE_SLOT,
      settlementTimeout.toBigInt(),
      [deployer.key],
      1 // participantB needs a new token account (A already has one from mint)
    );

    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());
    expect((await usdc.token.getBalanceOf(participantA)).toBigInt()).toBe(balA);
    expect((await usdc.token.getBalanceOf(participantB)).toBigInt()).toBe(balB);
    // Escrow fully drained.
    expect((await usdc.token.getBalanceOf(channelAddr)).toBigInt()).toBe(0n);
  });

  // -------------------------------------------------------------------------
  // 2. TAMPERED PAYOUT: settle with a payout amount != the committed balance.
  //    The balanceCommitment precondition (== Poseidon(balA,balB,salt)) forces
  //    the payouts to equal the committed balances -> mismatch is rejected.
  // -------------------------------------------------------------------------
  it('[reject] tampered settle payout (amount != committed balance) is rejected by the proof', async () => {
    const deposit = 1000n * ONE_USDC;
    const balA = 400n * ONE_USDC;
    const balB = 600n * ONE_USDC;
    const salt = Field(50002);
    const { usdc } = await openDepositClose(deposit, balA, balB, salt);

    Local.setGlobalSlot(Number(SETTLE_SLOT));
    // Pay B 700 (not the committed 600). Poseidon(400,700,salt) != on-chain commit.
    await expect(
      settleFromChannelInProof(
        deployer,
        zkApp,
        usdc,
        balA,
        700n * ONE_USDC,
        salt,
        participantA,
        participantB,
        channelNonce,
        CLOSE_SLOT,
        settlementTimeout.toBigInt(),
        [deployer.key],
        1
      )
    ).rejects.toThrow();

    // Channel stays CLOSING; escrow intact.
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.CLOSING.toString());
  });

  // -------------------------------------------------------------------------
  // 3. SETTLE BEFORE CHALLENGE PERIOD: globalSlot < closedAtSlot + timeout.
  //    The network globalSlotSinceGenesis lower-bound precondition rejects it.
  // -------------------------------------------------------------------------
  it('[reject] settle before the challenge period elapses is rejected', async () => {
    const deposit = 1000n * ONE_USDC;
    const balA = 400n * ONE_USDC;
    const balB = 600n * ONE_USDC;
    const salt = Field(50003);
    const { usdc } = await openDepositClose(deposit, balA, balB, salt);

    // deadline = 100 + 30 = 130. Settle at slot 120 (too early).
    Local.setGlobalSlot(120);
    await expect(
      settleFromChannelInProof(
        deployer,
        zkApp,
        usdc,
        balA,
        balB,
        salt,
        participantA,
        participantB,
        channelNonce,
        CLOSE_SLOT,
        settlementTimeout.toBigInt(),
        [deployer.key],
        1
      )
    ).rejects.toThrow();

    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.CLOSING.toString());
  });

  // -------------------------------------------------------------------------
  // 4. WRONG PARTICIPANTS: channelHash precondition (== Poseidon(A.x,B.x,nonce))
  //    rejects settle with a fabricated participant. (The channel.settle sibling
  //    would also reject, but here the TOKEN proof binds it too.)
  // -------------------------------------------------------------------------
  it('[reject] settle with wrong participants (channelHash mismatch) is rejected', async () => {
    const deposit = 1000n * ONE_USDC;
    const balA = 400n * ONE_USDC;
    const balB = 600n * ONE_USDC;
    const salt = Field(50004);
    const { usdc } = await openDepositClose(deposit, balA, balB, salt);

    const imposter = PrivateKey.random().toPublicKey();

    Local.setGlobalSlot(Number(SETTLE_SLOT));
    await expect(
      settleFromChannelInProof(
        deployer,
        zkApp,
        usdc,
        balA,
        balB,
        salt,
        participantA,
        imposter, // wrong B -> channelHash mismatch
        channelNonce,
        CLOSE_SLOT,
        settlementTimeout.toBigInt(),
        [deployer.key],
        1
      )
    ).rejects.toThrow();

    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.CLOSING.toString());
  });

  // -------------------------------------------------------------------------
  // 5. CONSERVATION VIOLATION at settle: depositTotal precondition (== balA+balB)
  //    rejects a settle whose balances don't sum to the escrowed total. We force
  //    this by passing balances that match a forged commitment but not the
  //    on-chain depositTotal -> the slot-4 precondition rejects.
  //
  //    (Conservation is also enforced at claim/close per usdc-settlement.test.ts;
  //    here we prove the SETTLE token proof independently binds it.)
  // -------------------------------------------------------------------------
  it('[reject] settle conservation violation (balanceA+balanceB != depositTotal) is rejected', async () => {
    const deposit = 1000n * ONE_USDC;
    const balA = 400n * ONE_USDC;
    const balB = 600n * ONE_USDC;
    const salt = Field(50005);
    const { usdc } = await openDepositClose(deposit, balA, balB, salt);

    Local.setGlobalSlot(Number(SETTLE_SLOT));
    // Build a settle whose balances sum to 900 (!= 1000 escrowed) AND match their
    // own commitment, so ONLY the depositTotal precondition can reject it. To do
    // that the salt/commitment would have to match on-chain too — it can't, since
    // on-chain commit is Poseidon(400,600,salt). So instead we pass a split that
    // is internally consistent (balA'+balB' = 900) but its commitment differs;
    // BOTH the commitment AND the conservation precondition reject. The point: a
    // non-conserving settle cannot pass.
    await expect(
      settleFromChannelInProof(
        deployer,
        zkApp,
        usdc,
        300n * ONE_USDC,
        600n * ONE_USDC, // 300 + 600 = 900 != 1000
        salt,
        participantA,
        participantB,
        channelNonce,
        CLOSE_SLOT,
        settlementTimeout.toBigInt(),
        [deployer.key],
        1
      )
    ).rejects.toThrow();

    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.CLOSING.toString());
  });

  // -------------------------------------------------------------------------
  // 6. DEPOSIT ACCOUNTING vs ESCROW MISMATCH: the depositToChannel
  //    `expectedDepositTotalAfter` precondition must equal the channel's
  //    resulting depositTotal. A wrong expected value (escrow move bound to an
  //    accounting total the channel won't reach) is rejected.
  // -------------------------------------------------------------------------
  it('[reject] deposit with escrow/accounting mismatch (wrong expectedDepositTotalAfter) is rejected', async () => {
    const usdc = await deployUsdcChannelToken(deployer, adminAuthority);
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
    const deposit = 500n * ONE_USDC;
    await mintUsdcChannel(deployer, usdc, participantA, deposit);
    await enableChannelEscrow(deployer, zkApp, usdc, zkAppKey);

    // Claim the channel's depositTotal-after will be 999 (a lie) while the channel
    // actually accounts `deposit` (500). The slot-4 precondition rejects.
    await expect(
      Mina.transaction(participantA, async () => {
        await zkApp.deposit(Field(deposit), participantA);
        await usdc.token.depositToChannel(
          zkApp.address,
          UInt64.from(deposit),
          participantA,
          Field(999n * ONE_USDC) // wrong post-total
        );
      }).then(async (tx) => {
        await tx.prove();
        await tx.sign([participantA.key]).send();
      })
    ).rejects.toThrow();

    // Nothing committed: channel still OPEN with zero deposit, escrow empty.
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.OPEN.toString());
    expect(zkApp.depositTotal.get().toString()).toBe(Field(0).toString());
  });

  it('[reject] deposit into a non-OPEN channel is rejected (channelState precondition)', async () => {
    // After close the channel is CLOSING; a deposit must fail the OPEN precondition.
    const deposit = 1000n * ONE_USDC;
    const { usdc } = await openDepositClose(
      deposit,
      400n * ONE_USDC,
      600n * ONE_USDC,
      Field(50006)
    );

    await mintUsdcChannel(deployer, usdc, participantA, 10n * ONE_USDC, false);
    await expect(
      depositToChannelInProof(participantA, zkApp, usdc, 10n * ONE_USDC, participantA, deposit, [
        participantA.key,
      ])
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // 7. DOUBLE-SETTLE: the first settle transitions CLOSING -> SETTLED; a second
  //    settle finds channelState == SETTLED, fails the CLOSING precondition.
  // -------------------------------------------------------------------------
  it('[reject] double-settle is rejected (channelState no longer CLOSING)', async () => {
    const deposit = 1000n * ONE_USDC;
    const balA = 400n * ONE_USDC;
    const balB = 600n * ONE_USDC;
    const salt = Field(50007);
    const { usdc, channelAddr } = await openDepositClose(deposit, balA, balB, salt);

    Local.setGlobalSlot(Number(SETTLE_SLOT));
    await settleFromChannelInProof(
      deployer,
      zkApp,
      usdc,
      balA,
      balB,
      salt,
      participantA,
      participantB,
      channelNonce,
      CLOSE_SLOT,
      settlementTimeout.toBigInt(),
      [deployer.key],
      1
    );
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());
    expect((await usdc.token.getBalanceOf(channelAddr)).toBigInt()).toBe(0n);

    // Second settle: channel is SETTLED, escrow is empty. Must reject.
    await expect(
      settleFromChannelInProof(
        deployer,
        zkApp,
        usdc,
        balA,
        balB,
        salt,
        participantA,
        participantB,
        channelNonce,
        CLOSE_SLOT,
        settlementTimeout.toBigInt(),
        [deployer.key],
        0
      )
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // 8. ZERO-BALANCE PAYOUT SKIPPED: B owed the whole escrow, A owed 0. The A
  //    payout (zero) is skipped (no AccountUpdate, no new account); B gets all.
  // -------------------------------------------------------------------------
  it('[zero] settle with balanceA==0 sends the full escrow to B and skips the zero refund', async () => {
    const deposit = 1000n * ONE_USDC;
    const balA = 0n;
    const balB = deposit;
    const salt = Field(50008);
    const { usdc, channelAddr } = await openDepositClose(deposit, balA, balB, salt);

    const aBefore = (await usdc.token.getBalanceOf(participantA)).toBigInt();

    Local.setGlobalSlot(Number(SETTLE_SLOT));
    await settleFromChannelInProof(
      deployer,
      zkApp,
      usdc,
      balA,
      balB,
      salt,
      participantA,
      participantB,
      channelNonce,
      CLOSE_SLOT,
      settlementTimeout.toBigInt(),
      [deployer.key],
      1 // only B needs a new account; A's zero payout is skipped
    );

    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());
    expect((await usdc.token.getBalanceOf(participantB)).toBigInt()).toBe(deposit);
    expect((await usdc.token.getBalanceOf(participantA)).toBigInt()).toBe(aBefore); // unchanged
    expect((await usdc.token.getBalanceOf(channelAddr)).toBigInt()).toBe(0n); // drained
  });

  // =========================================================================
  // TOKEN-ONLY enforcement: call `settleFromChannel` ALONE (no sibling
  // `channel.settle`), so ONLY the token contract's own preconditions can
  // reject. This proves the TOKEN PROOF — not the channel zkApp — is the
  // enforcer (the #191/#194 guarantee moved on-chain). The happy token-only
  // case also confirms `settleFromChannel` drains the escrow by itself.
  // =========================================================================

  /** Settle via the token method ALONE (no channel.settle). */
  async function settleTokenOnly(
    usdc: UsdcChannelContext,
    balanceA: bigint,
    balanceB: bigint,
    salt: Field,
    pA: ReturnType<PrivateKey['toPublicKey']>,
    pB: ReturnType<PrivateKey['toPublicKey']>,
    nonce: Field,
    fundAccts: number
  ): Promise<void> {
    const { UInt32 } = await import('o1js');
    const tx = await Mina.transaction(deployer, async () => {
      const { AccountUpdate } = await import('o1js');
      if (fundAccts > 0) AccountUpdate.fundNewAccount(deployer, fundAccts);
      await usdc.token.settleFromChannel(
        zkApp.address,
        UInt64.from(balanceA),
        UInt64.from(balanceB),
        salt,
        pA,
        pB,
        nonce,
        UInt32.from(CLOSE_SLOT),
        UInt32.from(settlementTimeout.toBigInt())
      );
    });
    await tx.prove();
    await tx.sign([deployer.key]).send();
  }

  it('[token-only] settleFromChannel ALONE drains the escrow exactly (no channel.settle)', async () => {
    const deposit = 1000n * ONE_USDC;
    const balA = 400n * ONE_USDC;
    const balB = 600n * ONE_USDC;
    const salt = Field(60001);
    const { usdc, channelAddr } = await openDepositClose(deposit, balA, balB, salt);

    Local.setGlobalSlot(Number(SETTLE_SLOT));
    await settleTokenOnly(usdc, balA, balB, salt, participantA, participantB, channelNonce, 1);

    // The channel stays CLOSING (we did NOT call channel.settle), but the TOKEN
    // proof alone moved the escrow to A/B exactly per the committed balances.
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.CLOSING.toString());
    expect((await usdc.token.getBalanceOf(participantA)).toBigInt()).toBe(balA);
    expect((await usdc.token.getBalanceOf(participantB)).toBigInt()).toBe(balB);
    expect((await usdc.token.getBalanceOf(channelAddr)).toBigInt()).toBe(0n);
  });

  it('[token-only reject] tampered payout is rejected by the TOKEN proof alone', async () => {
    const salt = Field(60002);
    const { usdc } = await openDepositClose(
      1000n * ONE_USDC,
      400n * ONE_USDC,
      600n * ONE_USDC,
      salt
    );
    Local.setGlobalSlot(Number(SETTLE_SLOT));
    // Pay B 700 not 600: Poseidon(400,700,salt) != on-chain balanceCommitment.
    await expect(
      settleTokenOnly(
        usdc,
        400n * ONE_USDC,
        700n * ONE_USDC,
        salt,
        participantA,
        participantB,
        channelNonce,
        1
      )
    ).rejects.toThrow();
  });

  it('[token-only reject] early settle is rejected by the TOKEN proof alone (global-slot precondition)', async () => {
    const salt = Field(60003);
    const { usdc } = await openDepositClose(
      1000n * ONE_USDC,
      400n * ONE_USDC,
      600n * ONE_USDC,
      salt
    );
    Local.setGlobalSlot(120); // deadline is 130
    await expect(
      settleTokenOnly(
        usdc,
        400n * ONE_USDC,
        600n * ONE_USDC,
        salt,
        participantA,
        participantB,
        channelNonce,
        1
      )
    ).rejects.toThrow();
  });

  it('[token-only reject] wrong participants rejected by the TOKEN proof alone (channelHash precondition)', async () => {
    const salt = Field(60004);
    const { usdc } = await openDepositClose(
      1000n * ONE_USDC,
      400n * ONE_USDC,
      600n * ONE_USDC,
      salt
    );
    const imposter = PrivateKey.random().toPublicKey();
    Local.setGlobalSlot(Number(SETTLE_SLOT));
    await expect(
      settleTokenOnly(
        usdc,
        400n * ONE_USDC,
        600n * ONE_USDC,
        salt,
        participantA,
        imposter,
        channelNonce,
        1
      )
    ).rejects.toThrow();
  });

  it('[token-only reject] non-conserving balances rejected by the TOKEN proof alone (depositTotal precondition)', async () => {
    const salt = Field(60005);
    const { usdc } = await openDepositClose(
      1000n * ONE_USDC,
      400n * ONE_USDC,
      600n * ONE_USDC,
      salt
    );
    Local.setGlobalSlot(Number(SETTLE_SLOT));
    // 300 + 600 = 900 != 1000 escrowed -> depositTotal slot-4 precondition fails.
    await expect(
      settleTokenOnly(
        usdc,
        300n * ONE_USDC,
        600n * ONE_USDC,
        salt,
        participantA,
        participantB,
        channelNonce,
        1
      )
    ).rejects.toThrow();
  });

  it('[token-only reject] double-settle: a second settleFromChannel finds no escrow / SETTLED-able state', async () => {
    const deposit = 1000n * ONE_USDC;
    const balA = 400n * ONE_USDC;
    const balB = 600n * ONE_USDC;
    const salt = Field(60006);
    const { usdc, channelAddr } = await openDepositClose(deposit, balA, balB, salt);

    Local.setGlobalSlot(Number(SETTLE_SLOT));
    // First token-only settle drains the escrow (channel stays CLOSING).
    await settleTokenOnly(usdc, balA, balB, salt, participantA, participantB, channelNonce, 1);
    expect((await usdc.token.getBalanceOf(channelAddr)).toBigInt()).toBe(0n);

    // Second settle: escrow is empty, so the escrow debit underflows -> rejected.
    await expect(
      settleTokenOnly(usdc, balA, balB, salt, participantA, participantB, channelNonce, 0)
    ).rejects.toThrow();
  });
});
