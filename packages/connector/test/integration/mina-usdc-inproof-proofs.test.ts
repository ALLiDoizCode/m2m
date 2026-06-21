/**
 * USDC in-proof settlement — proofs-enabled LOCAL reproduction (PR #202).
 *
 * The real-lightnet test (`mina-usdc-inproof-lightnet.test.ts`) surfaced a
 * `Cannot prove execution of initialize(), no prover found. Try calling await
 * FungibleToken.compile() first` at deploy time, even though the suite calls
 * `UsdcChannelToken.compile()`. This test reproduces that failure WITHOUT a
 * lightnet, under `Mina.LocalBlockchain({ proofsEnabled: true })` — which does
 * REAL proving locally (slow, ~30-90s/proof, no 8GB node) — and is the
 * fast(er) regression guard that the prover wiring is correct.
 *
 * It imports the EXACT module paths the lightnet test uses (the compiled
 * `dist`), so it exercises the same class identities / `mina-fungible-token`
 * instance resolution that produced the "no prover found" error.
 *
 * One full cycle is driven with real proofs: deploy+initialize the token,
 * enableChannelEscrow → depositToChannel → settleFromChannel, asserting token
 * balances move and a tampered settle is rejected.
 *
 * Gating: real proving is slow. Runs only when MINA_PROOFS=true (the lightnet
 * test remains the primary on-chain validator). Locally:
 *   MINA_PROOFS=true npx jest --config jest.config.js \
 *     test/integration/mina-usdc-inproof-proofs.test.ts --runInBand
 *
 * @packageDocumentation
 */

import {
  AccountUpdate,
  Bool,
  Field,
  Mina,
  Poseidon,
  PrivateKey,
  Signature,
  UInt32,
  UInt64,
} from 'o1js';

// SAME import paths as the lightnet test — this is load-bearing for the repro:
// the dist re-exports the contracts, and we must hit the same compiled classes
// / single `mina-fungible-token` instance the lightnet test does.
import { PaymentChannel, UsdcChannelToken, CHANNEL_STATE } from '@toon-protocol/mina-zkapp/dist';
import {
  FungibleTokenAdmin,
  usdcDeployProps,
  USDC_DECIMALS_U8,
  ONE_USDC,
} from '@toon-protocol/mina-zkapp/dist/usdc-token';

const RUN_PROOFS = process.env.MINA_PROOFS === 'true';
const describeProofs = RUN_PROOFS ? describe : describe.skip;

// Compile (3 contracts) + several real local proofs is slow.
jest.setTimeout(30 * 60_000);

describeProofs('USDC in-proof settlement — proofs-enabled LocalBlockchain (PR #202)', () => {
  let Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  let deployer: Mina.TestPublicKey;
  let participantA: Mina.TestPublicKey;
  let participantB: Mina.TestPublicKey;
  let adminAuthority: Mina.TestPublicKey;

  const channelKey = PrivateKey.random();
  const tokenKey = PrivateKey.random();
  const adminKey = PrivateKey.random();

  let channel: PaymentChannel;
  let token: UsdcChannelToken;
  let admin: FungibleTokenAdmin;

  const channelNonce = Field(7);
  const settlementTimeoutSlots = 30n;
  const CLOSE_SLOT = 100n;
  const SETTLE_SLOT = 200n; // > CLOSE_SLOT + 30 (deadline 130)

  const DEPOSIT = 1000n * ONE_USDC;
  const BAL_A = 400n * ONE_USDC;
  const BAL_B = 600n * ONE_USDC;
  const salt = Field(50_021);

  beforeAll(async () => {
    Local = await Mina.LocalBlockchain({ proofsEnabled: true });
    Mina.setActiveInstance(Local);
    [deployer, participantA, participantB, adminAuthority] = Local.testAccounts;

    channel = new PaymentChannel(channelKey.toPublicKey());
    token = new UsdcChannelToken(tokenKey.toPublicKey());
    admin = new FungibleTokenAdmin(adminKey.toPublicKey());

    await FungibleTokenAdmin.compile();
    await UsdcChannelToken.compile();
    await PaymentChannel.compile();
  });

  it('deposits to escrow, then settle drains escrow to A/B exactly (REAL proofs)', async () => {
    const channelAddr = channelKey.toPublicKey();

    // ── Deploy USDC (admin + token) + initialize.
    const deployTx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer, 3);
      await admin.deploy({ adminPublicKey: adminAuthority });
      await token.deploy(usdcDeployProps);
      await token.initialize(adminKey.toPublicKey(), USDC_DECIMALS_U8, Bool(false));
    });
    await deployTx.prove();
    await deployTx.sign([deployer.key, adminKey, tokenKey]).send();

    // ── Deploy the bare PaymentChannel zkApp.
    const channelDeployTx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer);
      await channel.deploy();
    });
    await channelDeployTx.prove();
    await channelDeployTx.sign([deployer.key, channelKey]).send();

    // ── Initialize the channel between A and B.
    const initTx = await Mina.transaction(deployer, async () => {
      await channel.initializeChannel(
        participantA,
        participantB,
        channelNonce,
        Field(settlementTimeoutSlots),
        token.deriveTokenId()
      );
    });
    await initTx.prove();
    await initTx.sign([deployer.key, participantA.key, participantB.key]).send();

    // ── Mint DEPOSIT USDC to A.
    const mintTx = await Mina.transaction(adminAuthority, async () => {
      AccountUpdate.fundNewAccount(adminAuthority, 1);
      await token.mint(participantA, UInt64.from(DEPOSIT));
    });
    await mintTx.prove();
    await mintTx.sign([adminAuthority.key]).send();
    expect((await token.getBalanceOf(participantA)).toBigInt()).toBe(DEPOSIT);

    // ── enableChannelEscrow (channel key signs once).
    const escrowTx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer, 1);
      await token.enableChannelEscrow(channelAddr);
    });
    await escrowTx.prove();
    await escrowTx.sign([deployer.key, channelKey]).send();

    // ── depositToChannel.
    const depositTx = await Mina.transaction(participantA, async () => {
      await channel.deposit(Field(DEPOSIT), participantA);
      await token.depositToChannel(channelAddr, UInt64.from(DEPOSIT), participantA, Field(DEPOSIT));
    });
    await depositTx.prove();
    await depositTx.sign([participantA.key]).send();

    expect((await token.getBalanceOf(channelAddr)).toBigInt()).toBe(DEPOSIT);
    expect((await token.getBalanceOf(participantA)).toBigInt()).toBe(0n);
    expect(channel.depositTotal.get().toString()).toBe(Field(DEPOSIT).toString());

    // ── Record a dual-signed claim.
    const channelHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);
    const newCommitment = Poseidon.hash([Field(BAL_A), Field(BAL_B), salt]);
    const claimNonce = Field(1);
    const claimMsg = [newCommitment, claimNonce, channelHash];
    const claimSigA = Signature.create(participantA.key, claimMsg);
    const claimSigB = Signature.create(participantB.key, claimMsg);
    const claimTx = await Mina.transaction(deployer, async () => {
      await channel.claimFromChannel(
        Field(BAL_A),
        Field(BAL_B),
        salt,
        claimSigA,
        claimSigB,
        participantA,
        participantB,
        channelNonce,
        newCommitment,
        claimNonce
      );
    });
    await claimTx.prove();
    await claimTx.sign([deployer.key]).send();

    // ── Cooperative close.
    Local.setGlobalSlot(Number(CLOSE_SLOT));
    const closeMsg = [Field(BAL_A), Field(BAL_B), salt, Field(2)];
    const closeSigA = Signature.create(participantA.key, closeMsg);
    const closeSigB = Signature.create(participantB.key, closeMsg);
    const closeTx = await Mina.transaction(deployer, async () => {
      await channel.initiateClose(Field(BAL_A), Field(BAL_B), salt, Field(2), closeSigA, closeSigB);
    });
    await closeTx.prove();
    await closeTx.sign([deployer.key]).send();

    expect(channel.channelState.get().toString()).toBe(CHANNEL_STATE.CLOSING.toString());
    const closedAtSlot = (channel.closedAtSlot.get() as Field).toBigInt();
    expect(closedAtSlot).toBeGreaterThan(0n);

    // ── Wait out the challenge window (set the slot forward locally).
    Local.setGlobalSlot(Number(SETTLE_SLOT));

    // ── TAMPER check: a settle whose payout != committed balance is rejected.
    await expect(
      (async () => {
        const tamperTx = await Mina.transaction(deployer, async () => {
          AccountUpdate.fundNewAccount(deployer, 1);
          await token.settleFromChannel(
            channelAddr,
            UInt64.from(BAL_A),
            UInt64.from(700n * ONE_USDC),
            salt,
            participantA,
            participantB,
            channelNonce,
            UInt32.from(closedAtSlot),
            UInt32.from(settlementTimeoutSlots)
          );
          await channel.settle(
            Field(BAL_A),
            Field(700n * ONE_USDC),
            salt,
            participantA,
            participantB,
            channelNonce
          );
        });
        await tamperTx.prove();
        await tamperTx.sign([deployer.key]).send();
      })()
    ).rejects.toThrow();

    expect(channel.channelState.get().toString()).toBe(CHANNEL_STATE.CLOSING.toString());
    expect((await token.getBalanceOf(channelAddr)).toBigInt()).toBe(DEPOSIT);

    // ── Honest settle (NO channel-key signature — deployer only).
    const settleTx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer, 1);
      await token.settleFromChannel(
        channelAddr,
        UInt64.from(BAL_A),
        UInt64.from(BAL_B),
        salt,
        participantA,
        participantB,
        channelNonce,
        UInt32.from(closedAtSlot),
        UInt32.from(settlementTimeoutSlots)
      );
      await channel.settle(
        Field(BAL_A),
        Field(BAL_B),
        salt,
        participantA,
        participantB,
        channelNonce
      );
    });
    await settleTx.prove();
    await settleTx.sign([deployer.key]).send();

    // ── On-chain assertions.
    expect(channel.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());
    expect((await token.getBalanceOf(participantA)).toBigInt()).toBe(BAL_A);
    expect((await token.getBalanceOf(participantB)).toBigInt()).toBe(BAL_B);
    expect((await token.getBalanceOf(channelAddr)).toBigInt()).toBe(0n);
  });
});
