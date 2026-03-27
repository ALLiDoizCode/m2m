/**
 * Unit Tests for Story 34.2: Mina Payment Channel zkApp -- ZK-Private Claims
 *
 * Tests cover the claimFromChannel() method which enables cooperative balance
 * updates via zk-SNARK proofs without revealing actual amounts on-chain.
 *
 * All tests run with proofsEnabled: false on a local blockchain for fast execution.
 * Tests were scaffolded in a TDD RED phase and are now GREEN with the
 * claimFromChannel() implementation on the PaymentChannel zkApp.
 *
 * Test IDs: T-34.2-01 through T-34.2-13
 * Test Level: Unit (o1js LocalBlockchain, proofsEnabled: false)
 * Epic: 34 -- Mina Protocol Payment Channel Provider (ZK-Private Settlement)
 *
 * @module payment-channel-claims.test
 */

import { Mina, PrivateKey, PublicKey, Field, AccountUpdate, Poseidon, Signature } from 'o1js';

import { PaymentChannel } from './PaymentChannel';
import { CHANNEL_STATE, ASSERT_MESSAGES } from './constants';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Deploy the PaymentChannel zkApp to a local blockchain */
async function deployZkApp(
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

/** Initialize a channel between two participants */
async function initializeChannel(
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

/** Deposit into the channel */
async function depositToChannel(
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

/** Initiate channel close with both participant signatures */
async function closeChannel(
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

/** Settle the channel after challenge period */
async function settleChannel(
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

/**
 * Submit a claim on the channel (cooperative balance update via zk proof).
 *
 * @param sender - Transaction sender
 * @param zkApp - PaymentChannel zkApp instance
 * @param params - Claim parameters (balances, salt, signatures, keys, nonces, commitment)
 * @param signers - Private keys to sign the Mina transaction
 */
async function submitClaim(
  sender: Mina.TestPublicKey,
  zkApp: PaymentChannel,
  params: {
    newBalanceA: Field;
    newBalanceB: Field;
    newSalt: Field;
    signatureA: Signature;
    signatureB: Signature;
    participantA: PublicKey;
    participantB: PublicKey;
    channelNonce: Field;
    newBalanceCommitment: Field;
    newNonce: Field;
  },
  signers: PrivateKey[]
): Promise<void> {
  const tx = await Mina.transaction(sender, async () => {
    await zkApp.claimFromChannel(
      params.newBalanceA,
      params.newBalanceB,
      params.newSalt,
      params.signatureA,
      params.signatureB,
      params.participantA,
      params.participantB,
      params.channelNonce,
      params.newBalanceCommitment,
      params.newNonce
    );
  });
  await tx.prove();
  await tx.sign(signers).send();
}

/**
 * Build a valid claim parameter set for the given channel state.
 *
 * Creates properly signed claim data that should pass all circuit constraints.
 */
function buildValidClaimParams(
  participantAKey: PrivateKey,
  participantBKey: PrivateKey,
  participantA: PublicKey,
  participantB: PublicKey,
  channelNonce: Field,
  newBalanceA: Field,
  newBalanceB: Field,
  newNonce: Field,
  channelHash: Field
): {
  newBalanceA: Field;
  newBalanceB: Field;
  newSalt: Field;
  signatureA: Signature;
  signatureB: Signature;
  participantA: PublicKey;
  participantB: PublicKey;
  channelNonce: Field;
  newBalanceCommitment: Field;
  newNonce: Field;
} {
  const newSalt = Field(99999);
  const newBalanceCommitment = Poseidon.hash([newBalanceA, newBalanceB, newSalt]);
  const message = [newBalanceCommitment, newNonce, channelHash];
  const signatureA = Signature.create(participantAKey, message);
  const signatureB = Signature.create(participantBKey, message);

  return {
    newBalanceA,
    newBalanceB,
    newSalt,
    signatureA,
    signatureB,
    participantA,
    participantB,
    channelNonce,
    newBalanceCommitment,
    newNonce,
  };
}

/**
 * Composite helper: deploy + initialize + deposit -> OPEN channel ready for claims.
 * Returns all values needed to construct claim parameters.
 */
async function setupOpenChannelWithDeposit(
  deployer: Mina.TestPublicKey,
  zkApp: PaymentChannel,
  pA: Mina.TestPublicKey,
  pB: Mina.TestPublicKey,
  params: { nonce: Field; timeout: Field; tokenId: Field; deposit: Field }
): Promise<{ channelHash: Field; depositTotal: Field }> {
  await initializeChannel(deployer, zkApp, pA, pB, params.nonce, params.timeout, params.tokenId, [
    deployer.key,
    pA.key,
    pB.key,
  ]);
  await depositToChannel(pA, zkApp, params.deposit, pA, [pA.key]);

  const channelHash = Poseidon.hash([pA.x, pB.x, params.nonce]);
  return { channelHash, depositTotal: params.deposit };
}

/**
 * Composite helper: initialize + deposit + close -> channel in CLOSING state.
 */
async function setupClosingChannel(
  local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>,
  deployer: Mina.TestPublicKey,
  zkApp: PaymentChannel,
  pA: Mina.TestPublicKey,
  pB: Mina.TestPublicKey,
  params: { nonce: Field; timeout: Field; tokenId: Field; deposit: Field; salt: Field }
): Promise<{ channelHash: Field; balanceA: Field; balanceB: Field }> {
  await initializeChannel(deployer, zkApp, pA, pB, params.nonce, params.timeout, params.tokenId, [
    deployer.key,
    pA.key,
    pB.key,
  ]);
  await depositToChannel(pA, zkApp, params.deposit, pA, [pA.key]);

  const balanceA = params.deposit;
  const balanceB = Field(0);
  const closeMsg = [balanceA, balanceB, params.salt, Field(1)];
  const sigA = Signature.create(pA.key, closeMsg);
  const sigB = Signature.create(pB.key, closeMsg);

  local.setGlobalSlot(100);
  await closeChannel(deployer, zkApp, balanceA, balanceB, params.salt, Field(1), sigA, sigB, [
    deployer.key,
  ]);

  const channelHash = Poseidon.hash([pA.x, pB.x, params.nonce]);
  return { channelHash, balanceA, balanceB };
}

/**
 * Composite helper: initialize + deposit + close + settle -> channel in SETTLED state.
 */
async function setupSettledChannel(
  local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>,
  deployer: Mina.TestPublicKey,
  zkApp: PaymentChannel,
  pA: Mina.TestPublicKey,
  pB: Mina.TestPublicKey,
  params: { nonce: Field; timeout: Field; tokenId: Field; deposit: Field; salt: Field }
): Promise<{ channelHash: Field }> {
  const { balanceA, balanceB } = await setupClosingChannel(local, deployer, zkApp, pA, pB, params);

  local.setGlobalSlot(200);
  await settleChannel(deployer, zkApp, balanceA, balanceB, params.salt, pA, pB, params.nonce, [
    deployer.key,
  ]);

  const channelHash = Poseidon.hash([pA.x, pB.x, params.nonce]);
  return { channelHash };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('PaymentChannel zkApp -- ZK-Private Claims (Story 34.2)', () => {
  let Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  let deployer: Mina.TestPublicKey;
  let participantA: Mina.TestPublicKey;
  let participantB: Mina.TestPublicKey;
  let zkAppKey: PrivateKey;
  let zkAppAddress: PublicKey;
  let zkApp: PaymentChannel;

  // Common test values
  const channelNonce = Field(42);
  const settlementTimeout = Field(30);
  const tokenId = Field(1);
  const depositAmount = Field(1_000_000_000); // 1 MINA in nanomina

  beforeAll(async () => {
    // Use proofsEnabled: false for fast unit tests
    Local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(Local);
  });

  beforeEach(async () => {
    // Reset global slot to avoid leaking slot state between tests
    Local.setGlobalSlot(0);

    // Fresh accounts for each test
    [deployer, participantA, participantB] = Local.testAccounts;

    zkAppKey = PrivateKey.random();
    zkAppAddress = zkAppKey.toPublicKey();
    zkApp = new PaymentChannel(zkAppAddress);

    // Deploy the zkApp
    await deployZkApp(deployer, zkAppKey, zkApp);
  });

  // =========================================================================
  // P0 Tests -- Core Claim Functionality
  // =========================================================================

  // T-34.2-01: Valid claim updates balanceCommitment and nonceField
  // AC: 1
  it('[P0] T-34.2-01: valid claim updates balanceCommitment and nonceField', async () => {
    // Given: an OPEN channel with a deposit
    const { channelHash } = await setupOpenChannelWithDeposit(
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount }
    );

    // When: a valid claimFromChannel proof is submitted with new balances
    const newBalanceA = Field(700_000_000);
    const newBalanceB = Field(300_000_000);
    const newNonce = Field(1);

    const claimParams = buildValidClaimParams(
      participantA.key,
      participantB.key,
      participantA,
      participantB,
      channelNonce,
      newBalanceA,
      newBalanceB,
      newNonce,
      channelHash
    );

    await submitClaim(deployer, zkApp, claimParams, [deployer.key]);

    // Then: the on-chain balanceCommitment updates to the new Poseidon commitment
    const expectedCommitment = Poseidon.hash([newBalanceA, newBalanceB, claimParams.newSalt]);
    expect(zkApp.balanceCommitment.get().toString()).toBe(expectedCommitment.toString());

    // And: the on-chain nonceField updates to the new nonce
    expect(zkApp.nonceField.get().toString()).toBe(newNonce.toString());
  });

  // T-34.2-02: Claim with conservation violation rejected
  // AC: 2
  it('[P0] T-34.2-02: claim with conservation violation (balances != depositTotal) is rejected', async () => {
    // Given: an OPEN channel with a deposit
    const { channelHash } = await setupOpenChannelWithDeposit(
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount }
    );

    // When: a claim is submitted where new_balance_a + new_balance_b != depositTotal
    const newBalanceA = Field(600_000_000);
    const newBalanceB = Field(600_000_000); // Sum = 1.2B, but depositTotal = 1B
    const newNonce = Field(1);

    const claimParams = buildValidClaimParams(
      participantA.key,
      participantB.key,
      participantA,
      participantB,
      channelNonce,
      newBalanceA,
      newBalanceB,
      newNonce,
      channelHash
    );

    // Then: the proof fails to verify and the transaction is rejected
    await expect(submitClaim(deployer, zkApp, claimParams, [deployer.key])).rejects.toThrow(
      ASSERT_MESSAGES.BALANCE_CONSERVATION_VIOLATED
    );
  });

  // T-34.2-03: Claim with non-negativity violation rejected
  // AC: 3
  it('[P0] T-34.2-03: claim with non-negativity violation (balance > depositTotal via modular arith) is rejected', async () => {
    // Given: an OPEN channel with a deposit
    const { channelHash } = await setupOpenChannelWithDeposit(
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount }
    );

    // When: a claim is submitted with newBalanceA > depositTotal
    // (simulating a "negative" balance via large Field near modulus)
    const exploitBalanceA = depositAmount.add(Field(1)); // Exceeds depositTotal
    // balanceB would need to wrap around modularly to make sum == depositTotal
    // but the individual balance check (assertLessThanOrEqual) should catch this
    const exploitBalanceB = Field(0);
    const newNonce = Field(1);

    // Build params manually since the balances are intentionally invalid
    const newSalt = Field(99999);
    const newBalanceCommitment = Poseidon.hash([exploitBalanceA, exploitBalanceB, newSalt]);
    const message = [newBalanceCommitment, newNonce, channelHash];
    const signatureA = Signature.create(participantA.key, message);
    const signatureB = Signature.create(participantB.key, message);

    // Then: the proof fails to verify and the transaction is rejected.
    // The conservation check (sum != depositTotal) fires before the range check
    // because exploitBalanceA + exploitBalanceB = depositTotal + 1.
    await expect(
      submitClaim(
        deployer,
        zkApp,
        {
          newBalanceA: exploitBalanceA,
          newBalanceB: exploitBalanceB,
          newSalt,
          signatureA,
          signatureB,
          participantA,
          participantB,
          channelNonce,
          newBalanceCommitment,
          newNonce,
        },
        [deployer.key]
      )
    ).rejects.toThrow(ASSERT_MESSAGES.BALANCE_CONSERVATION_VIOLATED);
  });

  // T-34.2-04: Claim with stale nonce rejected
  // AC: 4
  it('[P0] T-34.2-04: claim with stale nonce (<= current nonce) is rejected', async () => {
    // Given: an OPEN channel with a deposit and a successful prior claim at nonce 1
    const { channelHash } = await setupOpenChannelWithDeposit(
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount }
    );

    // First valid claim to advance nonce to 1
    const firstClaim = buildValidClaimParams(
      participantA.key,
      participantB.key,
      participantA,
      participantB,
      channelNonce,
      Field(700_000_000),
      Field(300_000_000),
      Field(1),
      channelHash
    );
    await submitClaim(deployer, zkApp, firstClaim, [deployer.key]);

    // When: a claim is submitted with newNonce <= current nonce (stale nonce = 1)
    const staleClaim = buildValidClaimParams(
      participantA.key,
      participantB.key,
      participantA,
      participantB,
      channelNonce,
      Field(600_000_000),
      Field(400_000_000),
      Field(1), // Same nonce as current -- should be rejected
      channelHash
    );

    // Then: the proof fails to verify and the transaction is rejected
    await expect(submitClaim(deployer, zkApp, staleClaim, [deployer.key])).rejects.toThrow(
      ASSERT_MESSAGES.NONCE_MUST_INCREASE
    );
  });

  // T-34.2-05: Claim with invalid signature from participant A rejected
  // AC: 5
  it('[P0] T-34.2-05: claim with invalid signature from participant A is rejected', async () => {
    // Given: an OPEN channel with a deposit
    const { channelHash } = await setupOpenChannelWithDeposit(
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount }
    );

    // When: a claim is submitted with an invalid signature from participant A
    const newBalanceA = Field(700_000_000);
    const newBalanceB = Field(300_000_000);
    const newNonce = Field(1);
    const newSalt = Field(99999);
    const newBalanceCommitment = Poseidon.hash([newBalanceA, newBalanceB, newSalt]);
    const message = [newBalanceCommitment, newNonce, channelHash];

    // Use a random key to create an invalid signature for participant A
    const fakeKeyA = PrivateKey.random();
    const invalidSignatureA = Signature.create(fakeKeyA, message);
    const validSignatureB = Signature.create(participantB.key, message);

    // Then: the proof fails to verify and the transaction is rejected
    await expect(
      submitClaim(
        deployer,
        zkApp,
        {
          newBalanceA,
          newBalanceB,
          newSalt,
          signatureA: invalidSignatureA,
          signatureB: validSignatureB,
          participantA,
          participantB,
          channelNonce,
          newBalanceCommitment,
          newNonce,
        },
        [deployer.key]
      )
    ).rejects.toThrow(ASSERT_MESSAGES.INVALID_SIGNATURE_A);
  });

  // T-34.2-06: Claim with invalid signature from participant B rejected
  // AC: 5
  it('[P0] T-34.2-06: claim with invalid signature from participant B is rejected', async () => {
    // Given: an OPEN channel with a deposit
    const { channelHash } = await setupOpenChannelWithDeposit(
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount }
    );

    // When: a claim is submitted with an invalid signature from participant B
    const newBalanceA = Field(700_000_000);
    const newBalanceB = Field(300_000_000);
    const newNonce = Field(1);
    const newSalt = Field(99999);
    const newBalanceCommitment = Poseidon.hash([newBalanceA, newBalanceB, newSalt]);
    const message = [newBalanceCommitment, newNonce, channelHash];

    const validSignatureA = Signature.create(participantA.key, message);
    // Use a random key to create an invalid signature for participant B
    const fakeKeyB = PrivateKey.random();
    const invalidSignatureB = Signature.create(fakeKeyB, message);

    // Then: the proof fails to verify and the transaction is rejected
    await expect(
      submitClaim(
        deployer,
        zkApp,
        {
          newBalanceA,
          newBalanceB,
          newSalt,
          signatureA: validSignatureA,
          signatureB: invalidSignatureB,
          participantA,
          participantB,
          channelNonce,
          newBalanceCommitment,
          newNonce,
        },
        [deployer.key]
      )
    ).rejects.toThrow(ASSERT_MESSAGES.INVALID_SIGNATURE_B);
  });

  // T-34.2-07: After claim, on-chain state reveals only Poseidon commitment (privacy)
  // AC: 6
  it('[P0] T-34.2-07: after claim, on-chain state reveals only commitment hash (privacy)', async () => {
    // Given: an OPEN channel with a deposit
    const { channelHash } = await setupOpenChannelWithDeposit(
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount }
    );

    // When: a valid claim is submitted
    const newBalanceA = Field(700_000_000);
    const newBalanceB = Field(300_000_000);
    const newNonce = Field(1);

    const claimParams = buildValidClaimParams(
      participantA.key,
      participantB.key,
      participantA,
      participantB,
      channelNonce,
      newBalanceA,
      newBalanceB,
      newNonce,
      channelHash
    );

    await submitClaim(deployer, zkApp, claimParams, [deployer.key]);

    // Then: only the balanceCommitment hash and nonce are visible on-chain
    const onChainCommitment = zkApp.balanceCommitment.get();
    const onChainNonce = zkApp.nonceField.get();

    // The commitment is a Poseidon hash -- not zero (was updated)
    expect(onChainCommitment).not.toEqual(Field(0));
    // The commitment matches the expected Poseidon hash of the private balances
    const expectedCommitment = Poseidon.hash([newBalanceA, newBalanceB, claimParams.newSalt]);
    expect(onChainCommitment.toString()).toBe(expectedCommitment.toString());
    // The nonce was updated
    expect(onChainNonce.toString()).toBe(newNonce.toString());

    // Actual balances (newBalanceA, newBalanceB, salt) are NOT recoverable from on-chain data.
    // The on-chain state contains exactly 8 Field elements. We verify that NONE of them
    // equal the private balance values or the salt. This proves that an on-chain observer
    // cannot read the actual transfer amounts from the contract state.
    const allOnChainFields = [
      zkApp.channelHash.get(),
      zkApp.balanceCommitment.get(),
      zkApp.nonceField.get(),
      zkApp.channelState.get(),
      zkApp.depositTotal.get(),
      zkApp.closedAtSlot.get(),
      zkApp.settlementTimeout.get(),
      zkApp.tokenId_.get(),
    ];

    const privateValues = [newBalanceA, newBalanceB, claimParams.newSalt];

    for (const onChainField of allOnChainFields) {
      for (const privateVal of privateValues) {
        expect(onChainField.toString()).not.toBe(privateVal.toString());
      }
    }
  });

  // T-34.2-08: Channel remains OPEN after claim
  // AC: 7
  it('[P0] T-34.2-08: channel remains OPEN after successful claim', async () => {
    // Given: an OPEN channel with a deposit
    const { channelHash } = await setupOpenChannelWithDeposit(
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount }
    );

    // When: a valid claim is submitted
    const claimParams = buildValidClaimParams(
      participantA.key,
      participantB.key,
      participantA,
      participantB,
      channelNonce,
      Field(700_000_000),
      Field(300_000_000),
      Field(1),
      channelHash
    );

    await submitClaim(deployer, zkApp, claimParams, [deployer.key]);

    // Then: channelState remains OPEN (channel is not closed by a claim)
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.OPEN.toString());
  });

  // T-34.2-12: Commitment mismatch rejected
  // AC: 8
  it('[P0] T-34.2-12: claim where computed commitment != provided commitment is rejected', async () => {
    // Given: an OPEN channel with a deposit
    const { channelHash } = await setupOpenChannelWithDeposit(
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount }
    );

    // When: a claim is submitted where Poseidon(newBalanceA, newBalanceB, newSalt) != newBalanceCommitment
    const newBalanceA = Field(700_000_000);
    const newBalanceB = Field(300_000_000);
    const newNonce = Field(1);
    const newSalt = Field(99999);

    // Create a WRONG commitment (hash of different values)
    const wrongCommitment = Poseidon.hash([Field(123), Field(456), Field(789)]);

    const message = [wrongCommitment, newNonce, channelHash];
    const signatureA = Signature.create(participantA.key, message);
    const signatureB = Signature.create(participantB.key, message);

    // Then: the transaction is rejected with commitment mismatch
    await expect(
      submitClaim(
        deployer,
        zkApp,
        {
          newBalanceA,
          newBalanceB,
          newSalt,
          signatureA,
          signatureB,
          participantA,
          participantB,
          channelNonce,
          newBalanceCommitment: wrongCommitment,
          newNonce,
        },
        [deployer.key]
      )
    ).rejects.toThrow(ASSERT_MESSAGES.COMMITMENT_MISMATCH);
  });

  // T-34.2-13: Claim with wrong participant keys (channelHash mismatch) rejected
  // AC: 9
  it('[P0] T-34.2-13: claim with wrong participant keys (channelHash mismatch) is rejected', async () => {
    // Given: an OPEN channel with a deposit
    const { channelHash } = await setupOpenChannelWithDeposit(
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount }
    );

    // When: a claim is submitted with incorrect participant keys
    const fakeParticipantA = PrivateKey.random().toPublicKey();
    const newBalanceA = Field(700_000_000);
    const newBalanceB = Field(300_000_000);
    const newNonce = Field(1);
    const newSalt = Field(99999);
    const newBalanceCommitment = Poseidon.hash([newBalanceA, newBalanceB, newSalt]);

    // Sign with the real keys but provide a fake participant public key
    const message = [newBalanceCommitment, newNonce, channelHash];
    const signatureA = Signature.create(participantA.key, message);
    const signatureB = Signature.create(participantB.key, message);

    // Then: the proof fails to verify (channelHash mismatch)
    await expect(
      submitClaim(
        deployer,
        zkApp,
        {
          newBalanceA,
          newBalanceB,
          newSalt,
          signatureA,
          signatureB,
          participantA: fakeParticipantA, // Wrong participant A key
          participantB,
          channelNonce,
          newBalanceCommitment,
          newNonce,
        },
        [deployer.key]
      )
    ).rejects.toThrow(ASSERT_MESSAGES.CHANNEL_HASH_MISMATCH);
  });

  // =========================================================================
  // P1 Tests -- Edge Cases and State Guards
  // =========================================================================

  // T-34.2-09: Multiple sequential claims with increasing nonces succeed
  // AC: 1, 4
  it('[P1] T-34.2-09: multiple sequential claims with increasing nonces all succeed', async () => {
    // Given: an OPEN channel with a deposit
    const { channelHash } = await setupOpenChannelWithDeposit(
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount }
    );

    // When: three sequential claims with increasing nonces
    const claim1 = buildValidClaimParams(
      participantA.key,
      participantB.key,
      participantA,
      participantB,
      channelNonce,
      Field(700_000_000),
      Field(300_000_000),
      Field(1),
      channelHash
    );
    await submitClaim(deployer, zkApp, claim1, [deployer.key]);

    const claim2 = buildValidClaimParams(
      participantA.key,
      participantB.key,
      participantA,
      participantB,
      channelNonce,
      Field(500_000_000),
      Field(500_000_000),
      Field(2),
      channelHash
    );
    await submitClaim(deployer, zkApp, claim2, [deployer.key]);

    const claim3 = buildValidClaimParams(
      participantA.key,
      participantB.key,
      participantA,
      participantB,
      channelNonce,
      Field(400_000_000),
      Field(600_000_000),
      Field(3),
      channelHash
    );
    await submitClaim(deployer, zkApp, claim3, [deployer.key]);

    // Then: all three claims succeed and state reflects the latest
    const expectedCommitment = Poseidon.hash([
      Field(400_000_000),
      Field(600_000_000),
      claim3.newSalt,
    ]);
    expect(zkApp.balanceCommitment.get().toString()).toBe(expectedCommitment.toString());
    expect(zkApp.nonceField.get().toString()).toBe(Field(3).toString());
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.OPEN.toString());
  });

  // T-34.2-10: Claim on CLOSING channel is rejected (OPEN-only policy)
  // AC: 7
  it('[P1] T-34.2-10: claim on CLOSING channel is rejected (OPEN-only policy)', async () => {
    // Given: a channel in CLOSING state
    const salt = Field(12345);
    const { channelHash } = await setupClosingChannel(
      Local,
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount, salt }
    );

    // When: a claim is attempted on the CLOSING channel
    const claimParams = buildValidClaimParams(
      participantA.key,
      participantB.key,
      participantA,
      participantB,
      channelNonce,
      Field(700_000_000),
      Field(300_000_000),
      Field(1),
      channelHash
    );

    // Then: the transaction is rejected (channel must be OPEN)
    await expect(submitClaim(deployer, zkApp, claimParams, [deployer.key])).rejects.toThrow(
      ASSERT_MESSAGES.CHANNEL_MUST_BE_OPEN
    );
  });

  // T-34.2-11: Claim on SETTLED channel is rejected
  it('[P1] T-34.2-11: claim on SETTLED channel is rejected', async () => {
    // Given: a channel in SETTLED state
    const salt = Field(12345);
    const { channelHash } = await setupSettledChannel(
      Local,
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount, salt }
    );

    // When: a claim is attempted on the SETTLED channel
    const claimParams = buildValidClaimParams(
      participantA.key,
      participantB.key,
      participantA,
      participantB,
      channelNonce,
      Field(700_000_000),
      Field(300_000_000),
      Field(1),
      channelHash
    );

    // Then: the transaction is rejected (channel must be OPEN)
    await expect(submitClaim(deployer, zkApp, claimParams, [deployer.key])).rejects.toThrow(
      ASSERT_MESSAGES.CHANNEL_MUST_BE_OPEN
    );
  });

  // =========================================================================
  // Gap-Filling Tests -- Coverage Expansion (automate workflow)
  // =========================================================================

  // T-34.2-14: Claim with nonce strictly less than current is rejected
  // AC: 4 (gap: T-34.2-04 tests equal nonce, this tests strictly less)
  it('[P1] T-34.2-14: claim with nonce strictly less than current nonce is rejected', async () => {
    // Given: an OPEN channel with a deposit and nonce advanced to 5
    const { channelHash } = await setupOpenChannelWithDeposit(
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount }
    );

    // Advance nonce to 5 via valid claim
    const firstClaim = buildValidClaimParams(
      participantA.key,
      participantB.key,
      participantA,
      participantB,
      channelNonce,
      Field(700_000_000),
      Field(300_000_000),
      Field(5),
      channelHash
    );
    await submitClaim(deployer, zkApp, firstClaim, [deployer.key]);

    // When: a claim is submitted with newNonce = 3 (strictly less than current 5)
    const staleClaim = buildValidClaimParams(
      participantA.key,
      participantB.key,
      participantA,
      participantB,
      channelNonce,
      Field(600_000_000),
      Field(400_000_000),
      Field(3), // Strictly less than current nonce 5
      channelHash
    );

    // Then: the proof fails to verify and the transaction is rejected
    await expect(submitClaim(deployer, zkApp, staleClaim, [deployer.key])).rejects.toThrow(
      ASSERT_MESSAGES.NONCE_MUST_INCREASE
    );
  });

  // T-34.2-15: Claim with wrong participant B key (channelHash mismatch) is rejected
  // AC: 9 (gap: T-34.2-13 only tests wrong participant A, this tests wrong participant B)
  it('[P1] T-34.2-15: claim with wrong participant B key (channelHash mismatch) is rejected', async () => {
    // Given: an OPEN channel with a deposit
    const { channelHash } = await setupOpenChannelWithDeposit(
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount }
    );

    // When: a claim is submitted with incorrect participant B key
    const fakeParticipantB = PrivateKey.random().toPublicKey();
    const newBalanceA = Field(700_000_000);
    const newBalanceB = Field(300_000_000);
    const newNonce = Field(1);
    const newSalt = Field(99999);
    const newBalanceCommitment = Poseidon.hash([newBalanceA, newBalanceB, newSalt]);

    const message = [newBalanceCommitment, newNonce, channelHash];
    const signatureA = Signature.create(participantA.key, message);
    const signatureB = Signature.create(participantB.key, message);

    // Then: the proof fails to verify (channelHash mismatch because participant B key is wrong)
    await expect(
      submitClaim(
        deployer,
        zkApp,
        {
          newBalanceA,
          newBalanceB,
          newSalt,
          signatureA,
          signatureB,
          participantA,
          participantB: fakeParticipantB, // Wrong participant B key
          channelNonce,
          newBalanceCommitment,
          newNonce,
        },
        [deployer.key]
      )
    ).rejects.toThrow(ASSERT_MESSAGES.CHANNEL_HASH_MISMATCH);
  });

  // T-34.2-16: Claim with wrong channelNonce (channelHash mismatch) is rejected
  // AC: 9 (gap: T-34.2-13 tests wrong participant key, this tests wrong channelNonce)
  it('[P1] T-34.2-16: claim with wrong channelNonce (channelHash mismatch) is rejected', async () => {
    // Given: an OPEN channel with a deposit
    const { channelHash } = await setupOpenChannelWithDeposit(
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount }
    );

    // When: a claim is submitted with incorrect channelNonce
    const wrongChannelNonce = Field(999); // Different from the actual channelNonce (42)
    const newBalanceA = Field(700_000_000);
    const newBalanceB = Field(300_000_000);
    const newNonce = Field(1);
    const newSalt = Field(99999);
    const newBalanceCommitment = Poseidon.hash([newBalanceA, newBalanceB, newSalt]);

    const message = [newBalanceCommitment, newNonce, channelHash];
    const signatureA = Signature.create(participantA.key, message);
    const signatureB = Signature.create(participantB.key, message);

    // Then: the proof fails to verify (channelHash mismatch because channelNonce is wrong)
    await expect(
      submitClaim(
        deployer,
        zkApp,
        {
          newBalanceA,
          newBalanceB,
          newSalt,
          signatureA,
          signatureB,
          participantA,
          participantB,
          channelNonce: wrongChannelNonce, // Wrong channelNonce
          newBalanceCommitment,
          newNonce,
        },
        [deployer.key]
      )
    ).rejects.toThrow(ASSERT_MESSAGES.CHANNEL_HASH_MISMATCH);
  });

  // T-34.2-17: Claim on UNINITIALIZED channel is rejected
  // AC: 7 (gap: T-34.2-10 and T-34.2-11 test CLOSING and SETTLED, this tests UNINITIALIZED)
  it('[P1] T-34.2-17: claim on UNINITIALIZED channel is rejected', async () => {
    // Given: a freshly deployed zkApp (UNINITIALIZED state, no initializeChannel called)
    // The channelHash and other fields are zero

    const fakeChannelHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);
    const newBalanceA = Field(700_000_000);
    const newBalanceB = Field(300_000_000);
    const newNonce = Field(1);
    const newSalt = Field(99999);
    const newBalanceCommitment = Poseidon.hash([newBalanceA, newBalanceB, newSalt]);

    const message = [newBalanceCommitment, newNonce, fakeChannelHash];
    const signatureA = Signature.create(participantA.key, message);
    const signatureB = Signature.create(participantB.key, message);

    // When: a claim is attempted on the UNINITIALIZED channel
    // Then: the transaction is rejected (channelState must be OPEN, but it is UNINITIALIZED)
    await expect(
      submitClaim(
        deployer,
        zkApp,
        {
          newBalanceA,
          newBalanceB,
          newSalt,
          signatureA,
          signatureB,
          participantA,
          participantB,
          channelNonce,
          newBalanceCommitment,
          newNonce,
        },
        [deployer.key]
      )
    ).rejects.toThrow(ASSERT_MESSAGES.CHANNEL_MUST_BE_OPEN);
  });

  // T-34.2-18: Valid claim with one balance at zero (full transfer to one side)
  // AC: 1 (gap: T-34.2-01 uses split balances, this tests edge case of zero balance)
  it('[P1] T-34.2-18: valid claim with one balance at zero succeeds', async () => {
    // Given: an OPEN channel with a deposit
    const { channelHash } = await setupOpenChannelWithDeposit(
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount }
    );

    // When: a valid claim assigns all funds to participant A, zero to participant B
    const newBalanceA = depositAmount; // 1,000,000,000
    const newBalanceB = Field(0);
    const newNonce = Field(1);

    const claimParams = buildValidClaimParams(
      participantA.key,
      participantB.key,
      participantA,
      participantB,
      channelNonce,
      newBalanceA,
      newBalanceB,
      newNonce,
      channelHash
    );

    await submitClaim(deployer, zkApp, claimParams, [deployer.key]);

    // Then: the on-chain balanceCommitment updates correctly
    const expectedCommitment = Poseidon.hash([newBalanceA, newBalanceB, claimParams.newSalt]);
    expect(zkApp.balanceCommitment.get().toString()).toBe(expectedCommitment.toString());
    expect(zkApp.nonceField.get().toString()).toBe(newNonce.toString());
    // And: channel remains OPEN
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.OPEN.toString());
  });

  // T-34.2-19: Claim where participant B signs with participant A's key is rejected
  // AC: 5 (gap: tests use random keys; this tests same-key double-signing attack)
  it('[P1] T-34.2-19: claim where both signatures come from same participant is rejected', async () => {
    // Given: an OPEN channel with a deposit
    const { channelHash } = await setupOpenChannelWithDeposit(
      deployer,
      zkApp,
      participantA,
      participantB,
      { nonce: channelNonce, timeout: settlementTimeout, tokenId, deposit: depositAmount }
    );

    // When: a claim is submitted where participant A signs both signatures
    const newBalanceA = Field(700_000_000);
    const newBalanceB = Field(300_000_000);
    const newNonce = Field(1);
    const newSalt = Field(99999);
    const newBalanceCommitment = Poseidon.hash([newBalanceA, newBalanceB, newSalt]);

    const message = [newBalanceCommitment, newNonce, channelHash];
    // Both signatures created with participant A's key
    const signatureA = Signature.create(participantA.key, message);
    const signatureBFake = Signature.create(participantA.key, message); // A signs for B

    // Then: the proof fails (signatureB.verify(participantB, ...) fails because
    // the signature was created with participantA's key, not participantB's key)
    await expect(
      submitClaim(
        deployer,
        zkApp,
        {
          newBalanceA,
          newBalanceB,
          newSalt,
          signatureA,
          signatureB: signatureBFake,
          participantA,
          participantB,
          channelNonce,
          newBalanceCommitment,
          newNonce,
        },
        [deployer.key]
      )
    ).rejects.toThrow(ASSERT_MESSAGES.INVALID_SIGNATURE_B);
  });
});
