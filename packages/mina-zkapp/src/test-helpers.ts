/**
 * Shared test helpers for Mina Payment Channel zkApp tests.
 *
 * Provides reusable functions for deploying, initializing, depositing,
 * claiming, closing, and settling payment channels in test environments.
 *
 * #191 (USDC across all chains): the channel now custodies the **USDC custom
 * token** (`mina-fungible-token`) instead of native MINA. `depositToChannel`
 * and `settleChannel` therefore build the USDC `token.transfer(...)`
 * AccountUpdates in the SAME transaction as the channel's accounting method
 * (`deposit` / `settle`). The channel zkApp does only the accounting; the token
 * owner moves the USDC (a channel-proof-authored custom-token move is rejected
 * with `Token_owner_not_caller`). See PaymentChannel.deposit/settle for the
 * full rationale.
 *
 * @module test-helpers
 */

import {
  Mina,
  PrivateKey,
  PublicKey,
  Field,
  AccountUpdate,
  Poseidon,
  Signature,
  Bool,
  UInt64,
} from 'o1js';

import { PaymentChannel } from './PaymentChannel';
import { FungibleToken, FungibleTokenAdmin, USDC_DECIMALS_U8, usdcDeployProps } from './usdc-token';
import { UsdcChannelToken } from './usdc-channel-token';

/**
 * A deployed USDC token context threaded into deposit/settle so the channel can
 * custody and distribute USDC instead of native MINA.
 */
export interface UsdcContext {
  /** The deployed USDC FungibleToken (token owner). */
  token: FungibleToken;
  /** The admin/mint authority — a FUNDED account that signs mints. */
  adminAuthority: Mina.TestPublicKey;
  /** The USDC tokenId (token.deriveTokenId()). Equals the channel's tokenId_. */
  tokenId: Field;
}

/**
 * Deploy the USDC token (admin + FungibleToken) at 6 decimals and return a
 * context for threading into channel deposit/settle.
 *
 * Mirrors usdc-token.test.ts: the mint authority MUST be a funded account.
 */
export async function deployUsdcToken(
  deployer: Mina.TestPublicKey,
  adminAuthority: Mina.TestPublicKey
): Promise<UsdcContext> {
  const adminContractKey = PrivateKey.random();
  const tokenKey = PrivateKey.random();
  const admin = new FungibleTokenAdmin(adminContractKey.toPublicKey());
  const token = new FungibleToken(tokenKey.toPublicKey());

  const tx = await Mina.transaction(deployer, async () => {
    AccountUpdate.fundNewAccount(deployer, 3); // admin acct, token acct, circulation acct
    await admin.deploy({ adminPublicKey: adminAuthority });
    await token.deploy(usdcDeployProps);
    await token.initialize(adminContractKey.toPublicKey(), USDC_DECIMALS_U8, Bool(false));
  });
  await tx.prove();
  await tx.sign([deployer.key, adminContractKey, tokenKey]).send();

  return { token, adminAuthority, tokenId: token.deriveTokenId() };
}

/**
 * Mint USDC to a recipient via the admin authority. Funds the recipient's token
 * account (new-account fee) by default.
 */
export async function mintUsdc(
  deployer: Mina.TestPublicKey,
  ctx: UsdcContext,
  recipient: PublicKey,
  amount: bigint,
  fundRecipient = true
): Promise<void> {
  const tx = await Mina.transaction(deployer, async () => {
    if (fundRecipient) AccountUpdate.fundNewAccount(deployer, 1);
    await ctx.token.mint(recipient, UInt64.from(amount));
  });
  await tx.prove();
  await tx.sign([deployer.key, ctx.adminAuthority.key]).send();
}

/**
 * Deploy a PaymentChannel zkApp to the local blockchain.
 */
export async function deployZkApp(
  deployer: Mina.TestPublicKey,
  zkAppKey: PrivateKey,
  zkApp: PaymentChannel
): Promise<void> {
  const tx = await Mina.transaction(deployer, async () => {
    AccountUpdate.fundNewAccount(deployer);
    await zkApp.deploy();
  });
  await tx.prove();
  await tx.sign([deployer.key, zkAppKey]).send();
}

/**
 * Initialize a payment channel between two participants.
 */
export async function initializeChannel(
  sender: Mina.TestPublicKey,
  zkApp: PaymentChannel,
  participantA: PublicKey,
  participantB: PublicKey,
  nonce: Field,
  timeout: Field,
  tokenId: Field,
  signers: PrivateKey[]
): Promise<void> {
  const tx = await Mina.transaction(sender, async () => {
    await zkApp.initializeChannel(participantA, participantB, nonce, timeout, tokenId);
  });
  await tx.prove();
  await tx.sign(signers).send();
}

/**
 * Deposit funds into an open channel.
 *
 * The channel method (`deposit`) does the accounting; when a `usdc` context is
 * supplied, this also builds `token.transfer(depositor → channel)` for the USDC
 * custody move in the same tx (funding the channel's token account on first
 * deposit). The depositor must sign (for both the deposit binding and the token
 * outflow).
 *
 * @param fundChannelTokenAccount - whether to pay the new-account fee for the
 *   channel's USDC token account (true on the channel's first-ever deposit).
 */
export async function depositToChannel(
  sender: Mina.TestPublicKey,
  zkApp: PaymentChannel,
  amount: Field,
  depositor: PublicKey,
  signers: PrivateKey[],
  usdc?: UsdcContext,
  fundChannelTokenAccount = true
): Promise<void> {
  const tx = await Mina.transaction(sender, async () => {
    if (usdc) {
      if (fundChannelTokenAccount) AccountUpdate.fundNewAccount(sender, 1);
      await usdc.token.transfer(depositor, zkApp.address, UInt64.Unsafe.fromField(amount));
    }
    await zkApp.deposit(amount, depositor);
  });
  await tx.prove();
  await tx.sign(signers).send();
}

/**
 * Submit a balance claim with dual-party signatures.
 */
export async function submitClaim(
  sender: Mina.TestPublicKey,
  zkApp: PaymentChannel,
  newBalanceA: Field,
  newBalanceB: Field,
  newSalt: Field,
  participantAKey: PrivateKey,
  participantBKey: PrivateKey,
  channelNonce: Field,
  newNonce: Field,
  channelHash: Field,
  signers: PrivateKey[]
): Promise<void> {
  const newCommitment = Poseidon.hash([newBalanceA, newBalanceB, newSalt]);
  const message = [newCommitment, newNonce, channelHash];
  const signatureA = Signature.create(participantAKey, message);
  const signatureB = Signature.create(participantBKey, message);

  const tx = await Mina.transaction(sender, async () => {
    await zkApp.claimFromChannel(
      newBalanceA,
      newBalanceB,
      newSalt,
      signatureA,
      signatureB,
      participantAKey.toPublicKey(),
      participantBKey.toPublicKey(),
      channelNonce,
      newCommitment,
      newNonce
    );
  });
  await tx.prove();
  await tx.sign(signers).send();
}

/**
 * Initiate cooperative channel closure.
 *
 * #202: `initiateClose` now takes a `currentSlot` witness (the live global slot,
 * pinned to "~now" by a range precondition) instead of pinning the exact on-chain
 * slot — an exact slot precondition is unsatisfiable on a real chain. This helper
 * reads the current network slot off-chain via `Mina.getNetworkState()` and passes
 * it as the witness (mirroring how the SDK reads it from the live network).
 */
export async function closeChannel(
  sender: Mina.TestPublicKey,
  zkApp: PaymentChannel,
  balanceA: Field,
  balanceB: Field,
  salt: Field,
  nonce: Field,
  sigA: Signature,
  sigB: Signature,
  signers: PrivateKey[]
): Promise<void> {
  const currentSlot = Mina.getNetworkState().globalSlotSinceGenesis;
  const tx = await Mina.transaction(sender, async () => {
    await zkApp.initiateClose(balanceA, balanceB, salt, nonce, sigA, sigB, currentSlot);
  });
  await tx.prove();
  await tx.sign(signers).send();
}

/**
 * Settle a channel after the challenge period has elapsed.
 *
 * The channel method (`settle`) does the accounting + state transition; when a
 * `usdc` context is supplied, this also builds the two USDC distributions
 * (`token.transfer(channel → participantB, balanceB)` and
 * `token.transfer(channel → participantA, balanceA)`) in the same tx. The token
 * outflows debit the channel's token account, authorized by the channel key,
 * so the channel key MUST be among `signers`. New participant token accounts
 * are funded via `fundParticipantTokenAccounts`.
 *
 * Zero-amount transfers are skipped (no balance change, no new account needed).
 *
 * @param fundParticipantTokenAccounts - number of new participant token accounts
 *   to pay the creation fee for (0, 1, or 2 depending on which already exist).
 */
export async function settleChannel(
  sender: Mina.TestPublicKey,
  zkApp: PaymentChannel,
  balanceA: Field,
  balanceB: Field,
  salt: Field,
  participantA: PublicKey,
  participantB: PublicKey,
  nonce: Field,
  signers: PrivateKey[],
  usdc?: UsdcContext,
  fundParticipantTokenAccounts = 0
): Promise<void> {
  const tx = await Mina.transaction(sender, async () => {
    if (usdc) {
      if (fundParticipantTokenAccounts > 0) {
        AccountUpdate.fundNewAccount(sender, fundParticipantTokenAccounts);
      }
      // Distribute USDC out of the channel's token account. Skip zero transfers.
      if (balanceB.toBigInt() > 0n) {
        await usdc.token.transfer(zkApp.address, participantB, UInt64.Unsafe.fromField(balanceB));
      }
      if (balanceA.toBigInt() > 0n) {
        await usdc.token.transfer(zkApp.address, participantA, UInt64.Unsafe.fromField(balanceA));
      }
    }
    await zkApp.settle(balanceA, balanceB, salt, participantA, participantB, nonce);
  });
  await tx.prove();
  await tx.sign(signers).send();
}

// ===========================================================================
// IN-PROOF token-owner flow (UsdcChannelToken) — the #191/#194 guarantees now
// enforced by the CONTRACT proof, not the SDK. Mirrors the SDK-enforced helpers
// above (`deployUsdcToken`/`depositToChannel`/`settleChannel`) but routes escrow
// movement through `UsdcChannelToken.depositToChannel` / `.settleFromChannel`,
// composed in the SAME tx as the channel's accounting method.
// ===========================================================================

/**
 * A deployed USDC `UsdcChannelToken` context — the in-proof-enforcing variant of
 * {@link UsdcContext}. `token` is the enforcing token owner whose
 * `depositToChannel`/`settleFromChannel` methods move escrow under proof.
 */
export interface UsdcChannelContext {
  /** The deployed in-proof-enforcing USDC token owner. */
  token: UsdcChannelToken;
  /** The admin/mint authority — a FUNDED account that signs mints. */
  adminAuthority: Mina.TestPublicKey;
  /** The USDC tokenId (token.deriveTokenId()). Equals the channel's tokenId_. */
  tokenId: Field;
}

/**
 * Deploy the in-proof-enforcing USDC token (`UsdcChannelToken` + admin) at 6
 * decimals. Identical deploy sequence to {@link deployUsdcToken}; only the token
 * class differs (the enforcing subclass).
 */
export async function deployUsdcChannelToken(
  deployer: Mina.TestPublicKey,
  adminAuthority: Mina.TestPublicKey
): Promise<UsdcChannelContext> {
  const adminContractKey = PrivateKey.random();
  const tokenKey = PrivateKey.random();
  const admin = new FungibleTokenAdmin(adminContractKey.toPublicKey());
  const token = new UsdcChannelToken(tokenKey.toPublicKey());

  const tx = await Mina.transaction(deployer, async () => {
    AccountUpdate.fundNewAccount(deployer, 3); // admin acct, token acct, circulation acct
    await admin.deploy({ adminPublicKey: adminAuthority });
    await token.deploy(usdcDeployProps);
    await token.initialize(adminContractKey.toPublicKey(), USDC_DECIMALS_U8, Bool(false));
  });
  await tx.prove();
  await tx.sign([deployer.key, adminContractKey, tokenKey]).send();

  return { token, adminAuthority, tokenId: token.deriveTokenId() };
}

/**
 * Mint USDC via a {@link UsdcChannelContext}. (Thin wrapper so callers don't have
 * to reshape the context; mint is unchanged from the stock token.)
 */
export async function mintUsdcChannel(
  deployer: Mina.TestPublicKey,
  ctx: UsdcChannelContext,
  recipient: PublicKey,
  amount: bigint,
  fundRecipient = true
): Promise<void> {
  const tx = await Mina.transaction(deployer, async () => {
    if (fundRecipient) AccountUpdate.fundNewAccount(deployer, 1);
    await ctx.token.mint(recipient, UInt64.from(amount));
  });
  await tx.prove();
  await tx.sign([deployer.key, ctx.adminAuthority.key]).send();
}

/**
 * One-time: make a channel's escrow token account custodial via the in-proof
 * token owner. The CHANNEL KEY must sign (the only signature this flow needs;
 * settle needs none). Pays the escrow account's new-account fee.
 */
export async function enableChannelEscrow(
  sender: Mina.TestPublicKey,
  zkApp: PaymentChannel,
  usdc: UsdcChannelContext,
  channelKey: PrivateKey
): Promise<void> {
  const tx = await Mina.transaction(sender, async () => {
    AccountUpdate.fundNewAccount(sender, 1); // escrow token account
    await usdc.token.enableChannelEscrow(zkApp.address);
  });
  await tx.prove();
  await tx.sign([sender.key, channelKey]).send();
}

/**
 * Deposit into a channel via the IN-PROOF token owner.
 *
 * Composes, in ONE tx: `token.depositToChannel(...)` (escrow move, bound to the
 * channel being OPEN + to the resulting depositTotal) and `channel.deposit(...)`
 * (the accounting half). The depositor signs — that single signature authorizes
 * both the USDC outflow and the channel's depositor-binding update. The escrow
 * must already be custodial (see {@link enableChannelEscrow}).
 *
 * @param amount - deposit amount in USDC base units
 * @param currentDepositTotal - the channel's on-chain depositTotal BEFORE this
 *   deposit (helper computes `+ amount` as the precondition)
 */
export async function depositToChannelInProof(
  sender: Mina.TestPublicKey,
  zkApp: PaymentChannel,
  usdc: UsdcChannelContext,
  amount: bigint,
  depositor: PublicKey,
  currentDepositTotal: bigint,
  signers: PrivateKey[]
): Promise<void> {
  const tx = await Mina.transaction(sender, async () => {
    // ORDER MATTERS: the channel's accounting `deposit` AU must precede the
    // token's depositTotal precondition AU, because o1js/Mina evaluate account
    // preconditions against the ledger state as updates are applied IN ORDER. The
    // precondition then sees the POST-deposit total and pins escrow ↔ accounting.
    await zkApp.deposit(Field(amount), depositor);
    await usdc.token.depositToChannel(
      zkApp.address,
      UInt64.from(amount),
      depositor,
      Field(currentDepositTotal + amount)
    );
  });
  await tx.prove();
  await tx.sign(signers).send();
}

/**
 * Settle a channel via the IN-PROOF token owner.
 *
 * Composes, in ONE tx: `token.settleFromChannel(...)` (escrow → A/B payouts bound
 * to the channel's pre-settle commitment) and `channel.settle(...)` (the
 * CLOSING→SETTLED accounting transition). The CHANNEL KEY IS NOT REQUIRED — the
 * escrow moves are authorized by the token owner's proof + the escrow's custodial
 * `send: none` permission. `signers` typically need only contain the fee payer.
 *
 * Zero-balance payouts are skipped inside the contract; pass
 * `fundParticipantTokenAccounts` = the number of NON-zero payouts that need a new
 * token account.
 */
export async function settleFromChannelInProof(
  sender: Mina.TestPublicKey,
  zkApp: PaymentChannel,
  usdc: UsdcChannelContext,
  balanceA: bigint,
  balanceB: bigint,
  salt: Field,
  participantA: PublicKey,
  participantB: PublicKey,
  nonce: Field,
  closedAtSlot: bigint,
  settlementTimeout: bigint,
  signers: PrivateKey[],
  fundParticipantTokenAccounts = 0
): Promise<void> {
  const { UInt32 } = await import('o1js');
  const tx = await Mina.transaction(sender, async () => {
    if (fundParticipantTokenAccounts > 0) {
      AccountUpdate.fundNewAccount(sender, fundParticipantTokenAccounts);
    }
    await usdc.token.settleFromChannel(
      zkApp.address,
      UInt64.from(balanceA),
      UInt64.from(balanceB),
      salt,
      participantA,
      participantB,
      nonce,
      UInt32.from(closedAtSlot),
      UInt32.from(settlementTimeout)
    );
    await zkApp.settle(Field(balanceA), Field(balanceB), salt, participantA, participantB, nonce);
  });
  await tx.prove();
  await tx.sign(signers).send();
}
