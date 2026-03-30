/**
 * Proof-Enabled Tests for Story 34.3: Mina Payment Channel zkApp -- Real zk-SNARKs
 *
 * Tests run with proofsEnabled: true, generating and verifying real zk-SNARK proofs.
 * Each proof takes 30-120 seconds; the entire suite may take 5-10 minutes.
 *
 * These tests verify: deterministic compilation, verification key consistency,
 * full lifecycle with real proofs, tampered proof rejection, and proof timing.
 *
 * Test IDs: T-34.3-01, T-34.3-09, T-34.3-10, T-34.3-11, T-34.3-12
 * Test Level: Integration (o1js LocalBlockchain, proofsEnabled: true)
 * Epic: 34 -- Mina Protocol Payment Channel Provider (ZK-Private Settlement)
 *
 * @module payment-channel-proofs.test
 */

// Override jest timeout for proof-enabled tests -- each proof takes 30-120s
jest.setTimeout(300000); // 5 minutes

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

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

interface ProofTimings {
  deploy: number;
  initialize: number;
  deposit: number;
  claim: number;
  close: number;
  settle: number;
  total: number;
}

describe('PaymentChannel zkApp -- Proof-Enabled Tests (Story 34.3)', () => {
  let compiledVerificationKey: { hash: Field; data: string };
  let proofTimings: ProofTimings;

  // Compile once for all proof-enabled tests (slowest operation)
  beforeAll(async () => {
    const result = await PaymentChannel.compile();
    compiledVerificationKey = result.verificationKey;
  }, 300000);

  // =========================================================================
  // T-34.3-01: Deterministic Verification Key
  // AC: 1
  // =========================================================================

  it('[P0] T-34.3-01: zkApp compiles and produces deterministic verification key', async () => {
    // Compile a second time and compare
    const { verificationKey: vk2 } = await PaymentChannel.compile();

    expect(compiledVerificationKey.hash.toString()).toBe(vk2.hash.toString());
    expect(compiledVerificationKey.data).toBe(vk2.data);
  });

  // =========================================================================
  // T-34.3-09: Full Lifecycle with Real Proofs
  // AC: 8
  // =========================================================================

  it('[P0] T-34.3-09: full lifecycle with real zk-SNARK proofs', async () => {
    const Local = await Mina.LocalBlockchain({ proofsEnabled: true });
    Mina.setActiveInstance(Local);

    const [deployer, participantA, participantB] = Local.testAccounts;
    const zkAppKey = PrivateKey.random();
    const zkApp = new PaymentChannel(zkAppKey.toPublicKey());

    const channelNonce = Field(42);
    const settlementTimeout = Field(30);
    const tokenId = Field(1);
    const depositAmount = Field(1_000_000_000);

    // Deploy
    const deployStart = Date.now();
    await deployZkApp(deployer, zkAppKey, zkApp);
    const deployTime = Date.now() - deployStart;

    // Initialize
    const initStart = Date.now();
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
    const initTime = Date.now() - initStart;
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.OPEN.toString());

    // Deposit
    const depositStart = Date.now();
    await depositToChannel(participantA, zkApp, depositAmount, participantA, [participantA.key]);
    const depositTime = Date.now() - depositStart;
    expect(zkApp.depositTotal.get().toString()).toBe(depositAmount.toString());

    const channelHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);

    // Claim
    const claimStart = Date.now();
    const balA = Field(600_000_000);
    const balB = Field(400_000_000);
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
    const claimTime = Date.now() - claimStart;

    // Close
    const closeStart = Date.now();
    const closeMsg = [balA, balB, salt, Field(2)];
    const sigA = Signature.create(participantA.key, closeMsg);
    const sigB = Signature.create(participantB.key, closeMsg);

    Local.setGlobalSlot(100);
    await closeChannel(deployer, zkApp, balA, balB, salt, Field(2), sigA, sigB, [deployer.key]);
    const closeTime = Date.now() - closeStart;
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.CLOSING.toString());

    // Settle
    const settleStart = Date.now();
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
    const settleTime = Date.now() - settleStart;
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());

    // Store timings for T-34.3-12
    proofTimings = {
      deploy: deployTime,
      initialize: initTime,
      deposit: depositTime,
      claim: claimTime,
      close: closeTime,
      settle: settleTime,
      total: deployTime + initTime + depositTime + claimTime + closeTime + settleTime,
    };
  });

  // =========================================================================
  // T-34.3-12: Proof Generation Timing
  // AC: 8 (performance aspect)
  // =========================================================================

  it('[P1] T-34.3-12: proof generation time measured per operation type', () => {
    // This test depends on T-34.3-09 having run first (same describe block, sequential).
    // If T-34.3-09 was skipped or failed, skip this test gracefully.
    if (!proofTimings) {
      // eslint-disable-next-line no-console
      console.warn('T-34.3-12 skipped: T-34.3-09 did not run (proofTimings not populated)');
      return;
    }

    // Verify each operation was timed (non-zero duration)
    expect(proofTimings.deploy).toBeGreaterThan(0);
    expect(proofTimings.initialize).toBeGreaterThan(0);
    expect(proofTimings.deposit).toBeGreaterThan(0);
    expect(proofTimings.claim).toBeGreaterThan(0);
    expect(proofTimings.close).toBeGreaterThan(0);
    expect(proofTimings.settle).toBeGreaterThan(0);
    expect(proofTimings.total).toBeGreaterThan(0);

    // Log timings for CI visibility
    // eslint-disable-next-line no-console
    console.log('Proof generation times (ms):', proofTimings);
  });

  // =========================================================================
  // T-34.3-10: Verification Key Consistency
  // AC: 10
  // =========================================================================

  it('[P0] T-34.3-10: verification key from compilation matches deployed zkApp', async () => {
    const Local = await Mina.LocalBlockchain({ proofsEnabled: true });
    Mina.setActiveInstance(Local);

    const [deployer] = Local.testAccounts;
    const zkAppKey = PrivateKey.random();
    const zkApp = new PaymentChannel(zkAppKey.toPublicKey());

    await deployZkApp(deployer, zkAppKey, zkApp);

    // The deployed zkApp's verification key should match compilation output.
    // In o1js, the verification key is set during deploy() from the compiled
    // circuit. We verify the compiled VK is deterministic (T-34.3-01) and
    // that the deployed contract accepts proofs generated with this VK by
    // successfully executing a transaction (which requires proof verification).
    // The verification key hash from compilation is our reference.
    expect(compiledVerificationKey.hash.toString()).toBeTruthy();
    expect(compiledVerificationKey.data.length).toBeGreaterThan(0);

    // Execute a transaction to prove the deployed VK matches -- if the VK
    // were different, the proof would fail verification on the local chain.
    const [, pA, pB] = Local.testAccounts;
    await initializeChannel(deployer, zkApp, pA, pB, Field(1), Field(10), Field(1), [
      deployer.key,
      pA.key,
      pB.key,
    ]);

    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.OPEN.toString());
  });

  // =========================================================================
  // T-34.3-11: Tampered Proof Inputs Rejected
  // AC: 9
  // =========================================================================

  it('[P0] T-34.3-11: tampered proof inputs rejected by verifier', async () => {
    const Local = await Mina.LocalBlockchain({ proofsEnabled: true });
    Mina.setActiveInstance(Local);

    const [deployer, participantA, participantB] = Local.testAccounts;
    const zkAppKey = PrivateKey.random();
    const zkApp = new PaymentChannel(zkAppKey.toPublicKey());

    const channelNonce = Field(42);
    const depositAmount = Field(1_000_000_000);

    await deployZkApp(deployer, zkAppKey, zkApp);
    await initializeChannel(
      deployer,
      zkApp,
      participantA,
      participantB,
      channelNonce,
      Field(30),
      Field(1),
      [deployer.key, participantA.key, participantB.key]
    );
    await depositToChannel(participantA, zkApp, depositAmount, participantA, [participantA.key]);

    const channelHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);

    // Tampered claim: wrong balances (don't sum to depositTotal)
    const tamperedBalA = Field(800_000_000);
    const tamperedBalB = Field(300_000_000); // 800M + 300M = 1.1B != 1B
    const salt = Field(55555);
    const tamperedCommitment = Poseidon.hash([tamperedBalA, tamperedBalB, salt]);
    const message = [tamperedCommitment, Field(1), channelHash];
    const sigA = Signature.create(participantA.key, message);
    const sigB = Signature.create(participantB.key, message);

    await expect(async () => {
      const tx = await Mina.transaction(deployer, async () => {
        await zkApp.claimFromChannel(
          tamperedBalA,
          tamperedBalB,
          salt,
          sigA,
          sigB,
          participantA,
          participantB,
          channelNonce,
          tamperedCommitment,
          Field(1)
        );
      });
      await tx.prove();
      await tx.sign([deployer.key]).send();
    }).rejects.toThrow();

    // Tampered claim: correct sum but wrong salt in commitment
    const correctBalA = Field(600_000_000);
    const correctBalB = Field(400_000_000);
    const wrongSalt = Field(99999);
    const correctSalt = Field(88888);
    // Commitment uses wrongSalt, but we claim correctSalt -- mismatch
    const wrongCommitment = Poseidon.hash([correctBalA, correctBalB, wrongSalt]);
    const message2 = [wrongCommitment, Field(1), channelHash];
    const sigA2 = Signature.create(participantA.key, message2);
    const sigB2 = Signature.create(participantB.key, message2);

    await expect(async () => {
      const tx = await Mina.transaction(deployer, async () => {
        await zkApp.claimFromChannel(
          correctBalA,
          correctBalB,
          correctSalt, // Does not match wrongCommitment
          sigA2,
          sigB2,
          participantA,
          participantB,
          channelNonce,
          wrongCommitment,
          Field(1)
        );
      });
      await tx.prove();
      await tx.sign([deployer.key]).send();
    }).rejects.toThrow();
  });
});
