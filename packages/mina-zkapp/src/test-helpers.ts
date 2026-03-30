/**
 * Shared test helpers for Mina Payment Channel zkApp tests.
 *
 * Provides reusable functions for deploying, initializing, depositing,
 * claiming, closing, and settling payment channels in test environments.
 *
 * Extracted from Stories 34.1-34.3 test files to eliminate duplication.
 *
 * @module test-helpers
 */

import { Mina, PrivateKey, PublicKey, Field, AccountUpdate, Poseidon, Signature } from 'o1js';

import { PaymentChannel } from './PaymentChannel';

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
 */
export async function depositToChannel(
  sender: Mina.TestPublicKey,
  zkApp: PaymentChannel,
  amount: Field,
  depositor: PublicKey,
  signers: PrivateKey[]
): Promise<void> {
  const tx = await Mina.transaction(sender, async () => {
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
  const tx = await Mina.transaction(sender, async () => {
    await zkApp.initiateClose(balanceA, balanceB, salt, nonce, sigA, sigB);
  });
  await tx.prove();
  await tx.sign(signers).send();
}

/**
 * Settle a channel after the challenge period has elapsed.
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
  signers: PrivateKey[]
): Promise<void> {
  const tx = await Mina.transaction(sender, async () => {
    await zkApp.settle(balanceA, balanceB, salt, participantA, participantB, nonce);
  });
  await tx.prove();
  await tx.sign(signers).send();
}
