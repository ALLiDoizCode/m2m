/**
 * Privacy Tests for Story 34.3: Mina Payment Channel zkApp -- Privacy Verification
 *
 * Tests verify that after multiple claims, on-chain state contains only Poseidon
 * commitment hashes and no individual balance amounts are recoverable.
 *
 * All tests run with proofsEnabled: false on a local blockchain for fast execution.
 * o1js enforces circuit constraints even with proofsEnabled: false.
 *
 * Test IDs: T-34.3-05
 * Test Level: Privacy (o1js LocalBlockchain, proofsEnabled: false)
 * Epic: 34 -- Mina Protocol Payment Channel Provider (ZK-Private Settlement)
 *
 * @module payment-channel-privacy.test
 */

import { Mina, PrivateKey, Field, Poseidon } from 'o1js';

import { PaymentChannel } from './PaymentChannel';
import { CHANNEL_STATE } from './constants';
import { deployZkApp, initializeChannel, depositToChannel, submitClaim } from './test-helpers';

jest.setTimeout(60000); // 60 seconds — privacy test submits 3 claims + setup

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('PaymentChannel zkApp -- Privacy Verification (Story 34.3)', () => {
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

  // T-34.3-05: After N claims, on-chain state reveals only Poseidon commitments
  // AC: 5
  it('[P0] T-34.3-05: after 3 claims, only Poseidon commitments visible on-chain', async () => {
    // Setup channel
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

    // Define 3 different balance splits with unique salts
    const claims = [
      { balA: Field(700_000_000), balB: Field(300_000_000), salt: Field(11111), nonce: Field(1) },
      { balA: Field(400_000_000), balB: Field(600_000_000), salt: Field(22222), nonce: Field(2) },
      { balA: Field(100_000_000), balB: Field(900_000_000), salt: Field(33333), nonce: Field(3) },
    ];

    const commitments: string[] = [];

    // Execute 3 claims, recording on-chain state after each
    for (const claim of claims) {
      await submitClaim(
        deployer,
        zkApp,
        claim.balA,
        claim.balB,
        claim.salt,
        participantA.key,
        participantB.key,
        channelNonce,
        claim.nonce,
        channelHash,
        [deployer.key]
      );

      const commitment = zkApp.balanceCommitment.get().toString();
      commitments.push(commitment);
    }

    // Verify: all 3 commitments are different (different balance splits)
    expect(new Set(commitments).size).toBe(3);

    // Collect all balance values used across all claims
    const allBalanceValues = claims.flatMap((c) => [
      c.balA.toString(),
      c.balB.toString(),
      c.salt.toString(),
    ]);

    // Read all 8 on-chain state fields
    const onChainFields = [
      zkApp.channelHash.get(),
      zkApp.balanceCommitment.get(),
      zkApp.nonceField.get(),
      zkApp.channelState.get(),
      zkApp.depositTotal.get(),
      zkApp.closedAtSlot.get(),
      zkApp.settlementTimeout.get(),
      zkApp.tokenId_.get(),
    ];

    // Verify: no on-chain field matches any actual balance value or salt
    for (const field of onChainFields) {
      const fieldStr = field.toString();
      for (const balanceValue of allBalanceValues) {
        // Skip the trivial case where Field(0) might match closedAtSlot (both zero)
        // and where nonce values might match channelState/nonceField
        // We only check actual balance amounts and salts
        if (balanceValue === '0') continue;

        expect(fieldStr).not.toBe(balanceValue);
      }
    }

    // Verify: the current commitment is a Poseidon hash, not plaintext balances
    const lastClaim = claims[claims.length - 1]!;
    const expectedCommitment = Poseidon.hash([lastClaim.balA, lastClaim.balB, lastClaim.salt]);
    expect(zkApp.balanceCommitment.get().toString()).toBe(expectedCommitment.toString());

    // Verify: commitments change after each claim (privacy refresh)
    const commitment1 = Poseidon.hash([claims[0]!.balA, claims[0]!.balB, claims[0]!.salt]);
    const commitment2 = Poseidon.hash([claims[1]!.balA, claims[1]!.balB, claims[1]!.salt]);
    const commitment3 = Poseidon.hash([lastClaim.balA, lastClaim.balB, lastClaim.salt]);

    expect(commitment1.toString()).not.toBe(commitment2.toString());
    expect(commitment2.toString()).not.toBe(commitment3.toString());
    expect(commitment1.toString()).not.toBe(commitment3.toString());

    // Verify: the channel is still OPEN (claims don't change state)
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.OPEN.toString());
  });
});
