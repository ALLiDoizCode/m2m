/**
 * FEASIBILITY SPIKE TEST — in-proof-enforcing USDC token owner on Mina.
 *
 * Proves (or disproves) the mechanism behind `docs/usdc-mina-inproof-enforcement.md`
 * with a minimal o1js test (proofsEnabled:false; constraints still enforced).
 *
 * Setup mirrors usdc-token.test.ts: deploy a FungibleToken (here a SpikeToken
 * subclass) + admin, mint to an "escrow" account. Then:
 *   - make the escrow custodial (escrow token account `send: none`),
 *   - call enforcedPayout with the CORRECT amount → succeeds, balances move,
 *     authorized by the OWNER'S PROOF ALONE (escrow does NOT sign),     [Q1]
 *   - the amount is bound to a SECOND zkApp's on-chain @state via an account
 *     precondition,                                                     [Q2]
 *   - call it with a TAMPERED amount → THROWS (constraint/precondition).
 */

import { AccountUpdate, Bool, Field, Mina, PrivateKey, UInt64 } from 'o1js';

import {
  FungibleTokenAdmin,
  USDC_DECIMALS_U8,
  ONE_USDC,
  usdcDeployProps,
} from './usdc-token';
import { SpikeToken, SpikeChannelState } from './usdc-inproof-spike';

describe('SPIKE: in-proof-enforcing USDC token owner', () => {
  let Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  let deployer: Mina.TestPublicKey;
  let escrow: Mina.TestPublicKey; // holds USDC; the owner moves its funds
  let recipient: Mina.TestPublicKey; // payout target
  let adminAuthority: Mina.TestPublicKey; // mint authority (funded account)

  let adminContractKey: PrivateKey;
  let tokenKey: PrivateKey;
  let channelKey: PrivateKey; // the "PaymentChannel" stand-in zkApp
  let admin: FungibleTokenAdmin;
  let token: SpikeToken;
  let channel: SpikeChannelState;

  const PAYOUT = UInt64.from(300n * ONE_USDC); // the enforced payout amount
  const MINTED = 1000n * ONE_USDC;

  beforeAll(async () => {
    Local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(Local);
    [deployer, escrow, recipient, adminAuthority] = Local.testAccounts;

    adminContractKey = PrivateKey.random();
    tokenKey = PrivateKey.random();
    channelKey = PrivateKey.random();
    admin = new FungibleTokenAdmin(adminContractKey.toPublicKey());
    token = new SpikeToken(tokenKey.toPublicKey());
    channel = new SpikeChannelState(channelKey.toPublicKey());

    // Deploy admin + SpikeToken + channel-state zkApp, initialize at 6 dp.
    const tx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer, 4); // admin, token, circulation, channel
      await admin.deploy({ adminPublicKey: adminAuthority });
      await token.deploy(usdcDeployProps);
      await token.initialize(adminContractKey.toPublicKey(), USDC_DECIMALS_U8, Bool(false));
      await channel.deploy();
    });
    await tx.prove();
    await tx.sign([deployer.key, adminContractKey, tokenKey, channelKey]).send();

    // Mint USDC to the escrow account.
    const mintTx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer, 1); // escrow's token account
      await token.mint(escrow, UInt64.from(MINTED));
    });
    await mintTx.prove();
    await mintTx.sign([deployer.key, adminAuthority.key]).send();

    // Set the channel zkApp's committed value to the enforced payout amount.
    // In the full build this is PaymentChannel.balanceCommitment / a balance.
    const setTx = await Mina.transaction(deployer, async () => {
      await channel.setCommitted(Field(PAYOUT.toBigInt()));
    });
    await setTx.prove();
    await setTx.sign([deployer.key, channelKey]).send();

    // Make the escrow custodial: escrow token account `send: none()`, so the
    // owner's proof can author sends OUT of it with no escrow signature.   [Q1]
    const custTx = await Mina.transaction(deployer, async () => {
      await token.enableCustodialEscrow(escrow);
    });
    await custTx.prove();
    // NB: escrow.key IS in the signers here — `createSigned` needs the escrow's
    // signature to AUTHORIZE the one-time permission change. After this, payouts
    // need no escrow signature.
    await custTx.sign([deployer.key, escrow.key]).send();
  });

  it('escrow holds the minted USDC and channel committed == PAYOUT', async () => {
    expect((await token.getBalanceOf(escrow)).toString()).toBe(MINTED.toString());
    expect(channel.committed.get().toString()).toBe(PAYOUT.toBigInt().toString());
  });

  it('[Q1+Q2] enforcedPayout moves escrow funds with OWNER PROOF ALONE (no escrow sig)', async () => {
    const recipientBefore = (await token.getBalanceOf(recipient)).toBigInt();
    const escrowBefore = (await token.getBalanceOf(escrow)).toBigInt();

    const tx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer, 1); // recipient's token account
      await token.enforcedPayout(escrow, recipient, PAYOUT, channel.address, PAYOUT);
    });
    await tx.prove();
    // CRITICAL: signers are [deployer] ONLY — the escrow does NOT sign. The
    // payout is authorized purely by the token owner's proof + the custodial
    // `send: none()` permission set earlier.
    await tx.sign([deployer.key]).send();

    expect((await token.getBalanceOf(recipient)).toBigInt()).toBe(recipientBefore + PAYOUT.toBigInt());
    expect((await token.getBalanceOf(escrow)).toBigInt()).toBe(escrowBefore - PAYOUT.toBigInt());
  });

  it('[Q1 negative control] WITHOUT custodial setup, owner-proof-alone payout FAILS', async () => {
    // Mint to a fresh holder whose token account keeps DEFAULT `send` permission
    // (Permissions.proofOrSignature). The owner's proof cannot author a send out
    // of it without the holder's signature — proving the custodial `send: none()`
    // setup in beforeAll is genuinely load-bearing, not incidental.
    const plainHolder = PrivateKey.randomKeypair();
    const mintTx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer, 1);
      await token.mint(plainHolder.publicKey, PAYOUT);
    });
    await mintTx.prove();
    await mintTx.sign([deployer.key, adminAuthority.key]).send();

    // Set a second channel-state commit equal to PAYOUT so Q2 passes and only the
    // permission gate can fail (reuse the same channel — committed already PAYOUT).
    const tx = await Mina.transaction(deployer, async () => {
      await token.enforcedPayout(plainHolder.publicKey, recipient, PAYOUT, channel.address, PAYOUT);
    });
    await tx.prove();
    // deployer-only signers; no plainHolder signature. Default `send` perm
    // (proofOrSignature) is NOT satisfied by a lazy-none holder AU → ledger rejects.
    await expect(tx.sign([deployer.key]).send()).rejects.toThrow();
  });

  it('[guard] a TAMPERED amount (!= committed/expected) is REJECTED by the proof', async () => {
    const tampered = UInt64.from(500n * ONE_USDC); // != PAYOUT (300) committed on channel
    await expect(
      Mina.transaction(deployer, async () => {
        // expected still = PAYOUT, but we try to move `tampered` out — both the
        // guard (amount==expected) and the cross-account precondition
        // (amount==channel.committed) must fail.
        await token.enforcedPayout(escrow, recipient, tampered, channel.address, PAYOUT);
      })
    ).rejects.toThrow();
  });

  it('[Q2] amount matching `expected` but NOT the channel state is still REJECTED', async () => {
    // Here expected == amount (guard passes), but channel.committed (PAYOUT=300)
    // != amount (400), so ONLY the cross-account precondition can reject it.
    // This isolates Q2: the proof binds to another zkApp's on-chain @state.
    const amount = UInt64.from(400n * ONE_USDC);
    // The guard (amount==expected) passes at proof time; only the cross-account
    // state precondition can reject — and it does so at LEDGER APPLY (`.send()`),
    // because on-chain `committed` (300) != the precondition value (400).
    const tx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer, 1);
      await token.enforcedPayout(escrow, recipient, amount, channel.address, amount);
    });
    await tx.prove();
    await expect(tx.sign([deployer.key]).send()).rejects.toThrow();
  });
});
