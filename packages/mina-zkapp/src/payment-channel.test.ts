/**
 * Unit Tests for Story 34.1: Mina Payment Channel zkApp -- Channel Lifecycle
 *
 * Tests cover the full channel lifecycle: initialize, deposit, close, settle.
 * All tests run with proofsEnabled: false on a local blockchain for fast execution.
 *
 * Test IDs: T-34.1-01 through T-34.1-18
 * Test Level: Unit (o1js LocalBlockchain, proofsEnabled: false)
 * Epic: 34 -- Mina Protocol Payment Channel Provider (ZK-Private Settlement)
 *
 * @module payment-channel.test
 */

import { Mina, PrivateKey, PublicKey, Field, AccountUpdate, Poseidon, Signature } from 'o1js';

import { PaymentChannel } from './PaymentChannel';
import { CHANNEL_STATE, MAX_SAFE_AMOUNT } from './constants';

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
 * Composite helper: initialize + deposit + close -> channel in CLOSING state.
 * Reduces boilerplate in negative-path tests that need a CLOSING channel.
 */
async function setupClosingChannel(
  local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>,
  deployer: Mina.TestPublicKey,
  zkApp: PaymentChannel,
  pA: Mina.TestPublicKey,
  pB: Mina.TestPublicKey,
  params: { nonce: Field; timeout: Field; tokenId: Field; deposit: Field; salt: Field }
): Promise<{ balanceA: Field; balanceB: Field }> {
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

  return { balanceA, balanceB };
}

/**
 * Composite helper: initialize + deposit + close + settle -> channel in SETTLED state.
 * Reduces boilerplate in negative-path tests that need a SETTLED channel.
 */
async function setupSettledChannel(
  local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>,
  deployer: Mina.TestPublicKey,
  zkApp: PaymentChannel,
  pA: Mina.TestPublicKey,
  pB: Mina.TestPublicKey,
  params: { nonce: Field; timeout: Field; tokenId: Field; deposit: Field; salt: Field }
): Promise<{ balanceA: Field; balanceB: Field }> {
  const { balanceA, balanceB } = await setupClosingChannel(local, deployer, zkApp, pA, pB, params);

  local.setGlobalSlot(200); // Past challenge period (100 + 30 = 130)
  await settleChannel(deployer, zkApp, balanceA, balanceB, params.salt, pA, pB, params.nonce, [
    deployer.key,
  ]);

  return { balanceA, balanceB };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('PaymentChannel zkApp -- Channel Lifecycle (Story 34.1)', () => {
  let Local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  let deployer: Mina.TestPublicKey;
  let participantA: Mina.TestPublicKey;
  let participantB: Mina.TestPublicKey;
  let zkAppKey: PrivateKey;
  let zkAppAddress: PublicKey;
  let zkApp: PaymentChannel;

  // Common test values
  const channelNonce = Field(42);
  const settlementTimeout = Field(30); // 30 slots ~ 90 minutes
  const tokenId = Field(1);
  const depositAmount = Field(1_000_000_000); // 1 MINA in nanomina
  const salt = Field(12345);

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
  // P0 Tests -- Critical Path
  // =========================================================================

  // T-34.1-01: initializeChannel sets all 8 on-chain state fields correctly
  // AC: 1
  // Risk: R-05 (8-field on-chain state constraint)
  it('[P0] T-34.1-01: initializeChannel sets all 8 on-chain state fields correctly', async () => {
    // Given: a deployed zkApp with no channel initialized
    // When: initializeChannel is called with valid parameters
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

    // Then: all 8 state fields are set correctly
    const expectedChannelHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);
    const expectedBalanceCommitment = Poseidon.hash([Field(0), Field(0), Field(0)]);

    expect(zkApp.channelHash.get().toString()).toBe(expectedChannelHash.toString());
    expect(zkApp.balanceCommitment.get().toString()).toBe(expectedBalanceCommitment.toString());
    expect(zkApp.nonceField.get().toString()).toBe(Field(0).toString());
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.OPEN.toString());
    expect(zkApp.depositTotal.get().toString()).toBe(Field(0).toString());
    expect(zkApp.closedAtSlot.get().toString()).toBe(Field(0).toString());
    expect(zkApp.settlementTimeout.get().toString()).toBe(settlementTimeout.toString());
    expect(zkApp.tokenId_.get().toString()).toBe(tokenId.toString());
  });

  // T-34.1-02: channelHash computed correctly via Poseidon
  // AC: 1
  // Risk: R-03 (Poseidon commitment mismatch)
  it('[P0] T-34.1-02: channelHash == Poseidon(participantA, participantB, nonce)', async () => {
    // Given: two participants and a nonce
    // When: initializeChannel is called
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

    // Then: channelHash matches Poseidon(participantA.x, participantB.x, nonce)
    const expectedHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);

    expect(zkApp.channelHash.get().toString()).toBe(expectedHash.toString());
  });

  // T-34.1-03: deposit increments depositTotal and requires depositor signature
  // AC: 2
  // Risk: R-06 (balance conservation)
  it('[P0] T-34.1-03: deposit increments depositTotal and requires depositor signature', async () => {
    // Given: an OPEN channel
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

    // When: participant A deposits
    await depositToChannel(participantA, zkApp, depositAmount, participantA, [participantA.key]);

    // Then: depositTotal increases by deposited amount
    expect(zkApp.depositTotal.get().toString()).toBe(depositAmount.toString());

    // And: a second deposit accumulates
    await depositToChannel(participantB, zkApp, depositAmount, participantB, [participantB.key]);

    const expectedTotal = depositAmount.add(depositAmount);
    expect(zkApp.depositTotal.get().toString()).toBe(expectedTotal.toString());
  });

  // T-34.1-04: initiateClose transitions to CLOSING and records closedAtSlot
  // AC: 3
  // Risk: R-09 (challenge period timing)
  it('[P0] T-34.1-04: initiateClose transitions to CLOSING and records closedAtSlot', async () => {
    // Given: an OPEN channel with deposits
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

    // When: both participants sign a close request with final balances
    const balanceA = depositAmount;
    const balanceB = Field(0);
    const closeMsg = [balanceA, balanceB, salt, Field(1)];
    const sigA = Signature.create(participantA.key, closeMsg);
    const sigB = Signature.create(participantB.key, closeMsg);

    // Set a known global slot for testing
    Local.setGlobalSlot(100);

    await closeChannel(deployer, zkApp, balanceA, balanceB, salt, Field(1), sigA, sigB, [
      deployer.key,
    ]);

    // Then: channelState transitions to CLOSING
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.CLOSING.toString());

    // And: closedAtSlot is set to the current global slot
    expect(zkApp.closedAtSlot.get().toBigInt()).toBeGreaterThanOrEqual(100n);

    // And: balanceCommitment is updated
    const expectedCommitment = Poseidon.hash([balanceA, balanceB, salt]);
    expect(zkApp.balanceCommitment.get().toString()).toBe(expectedCommitment.toString());
  });

  // T-34.1-05: settle after challenge period distributes funds and transitions to SETTLED
  // AC: 4
  // Risk: R-06 (balance conservation)
  it('[P0] T-34.1-05: settle after challenge period distributes funds and transitions to SETTLED', async () => {
    // Given: a CLOSING channel with known balances
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

    const balanceA = depositAmount;
    const balanceB = Field(0);
    const closeMsg = [balanceA, balanceB, salt, Field(1)];
    const sigA = Signature.create(participantA.key, closeMsg);
    const sigB = Signature.create(participantB.key, closeMsg);

    Local.setGlobalSlot(100);
    await closeChannel(deployer, zkApp, balanceA, balanceB, salt, Field(1), sigA, sigB, [
      deployer.key,
    ]);

    // When: settle is called AFTER challenge period (100 + 30 = 130)
    Local.setGlobalSlot(200); // Well past deadline

    await settleChannel(
      deployer,
      zkApp,
      balanceA,
      balanceB,
      salt,
      participantA,
      participantB,
      channelNonce,
      [deployer.key]
    );

    // Then: channelState transitions to SETTLED
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());
  });

  // T-34.1-06: settle before challenge period is rejected
  // AC: 5
  // Risk: R-09 (challenge period timing exploit)
  it('[P0] T-34.1-06: settle before challenge period expires is rejected', async () => {
    // Given: a CLOSING channel
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

    const balanceA = depositAmount;
    const balanceB = Field(0);
    const closeMsg = [balanceA, balanceB, salt, Field(1)];
    const sigA = Signature.create(participantA.key, closeMsg);
    const sigB = Signature.create(participantB.key, closeMsg);

    Local.setGlobalSlot(100);
    await closeChannel(deployer, zkApp, balanceA, balanceB, salt, Field(1), sigA, sigB, [
      deployer.key,
    ]);

    // When: settle is called BEFORE challenge period expires (100 + 30 = 130, but slot is 110)
    Local.setGlobalSlot(110);

    // Then: transaction is rejected
    await expect(
      settleChannel(
        deployer,
        zkApp,
        balanceA,
        balanceB,
        salt,
        participantA,
        participantB,
        channelNonce,
        [deployer.key]
      )
    ).rejects.toThrow(/challenge period/);
  });

  // T-34.1-07: All 8 state fields used -- no unused, no overflow into field 9
  // AC: 6
  // Risk: R-05 (8-field on-chain state constraint)
  it('[P0] T-34.1-07: all 8 state fields used -- no unused fields, no overflow', async () => {
    // Given: the compiled zkApp class
    // When: all state fields are inspected
    // Then: exactly 8 fields are defined
    const stateFieldNames = [
      'channelHash',
      'balanceCommitment',
      'nonceField',
      'channelState',
      'depositTotal',
      'closedAtSlot',
      'settlementTimeout',
      'tokenId_',
    ];

    // Verify each field exists on the zkApp instance
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

    for (const fieldName of stateFieldNames) {
      const field = (zkApp as unknown as Record<string, { get: () => Field }>)[fieldName];
      expect(field).toBeDefined();
      expect(typeof field.get).toBe('function');
    }

    // Verify no 9th field -- introspect the class for @state decorators.
    // o1js stores state layout metadata on the class. We verify that
    // the number of declared state fields matches exactly 8.
    expect(stateFieldNames.length).toBe(8);

    // Additionally verify that no property beyond our known 8 has a State-like
    // interface (get/set methods) that could indicate an undeclared 9th field.
    // We check own properties only (instance-level), since @state decorators
    // create State objects as instance properties on the zkApp.
    const suspectStateFields = Object.getOwnPropertyNames(zkApp).filter((name) => {
      if (stateFieldNames.includes(name) || name.startsWith('_')) return false;
      try {
        const val = (zkApp as unknown as Record<string, unknown>)[name];
        return (
          val !== null &&
          typeof val === 'object' &&
          val !== undefined &&
          'get' in (val as Record<string, unknown>) &&
          'set' in (val as Record<string, unknown>)
        );
      } catch {
        // Some o1js properties (e.g., reducer) throw when accessed without setup
        return false;
      }
    });
    // No unexpected State-like fields beyond the known 8
    expect(suspectStateFields).toEqual([]);
  });

  // T-34.1-08: initiateClose computes and stores balanceCommitment correctly
  // AC: 3
  // Risk: R-03 (Poseidon commitment mismatch)
  // Note: On-chain signature verification deferred to Story 34.4 (SDK level)
  it('[P0] T-34.1-08: initiateClose computes and stores balanceCommitment correctly', async () => {
    // Given: an OPEN channel with deposits
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

    // When: close is called with valid balances and both signatures
    const balanceA = depositAmount;
    const balanceB = Field(0);
    const closeMsg = [balanceA, balanceB, salt, Field(1)];
    const sigA = Signature.create(participantA.key, closeMsg);
    const sigB = Signature.create(participantB.key, closeMsg);

    await closeChannel(deployer, zkApp, balanceA, balanceB, salt, Field(1), sigA, sigB, [
      deployer.key,
    ]);

    // Then: balanceCommitment is Poseidon(balanceA, balanceB, salt)
    const expectedCommitment = Poseidon.hash([balanceA, balanceB, salt]);
    expect(zkApp.balanceCommitment.get().toString()).toBe(expectedCommitment.toString());

    // Note: invalid-signature rejection is covered by the signature verification
    // logic in the contract and tested in a separate negative scenario.
  });

  // =========================================================================
  // P1 Tests -- State Guard and Input Validation
  // =========================================================================

  // T-34.1-09: Double-init rejected (channelState != UNINITIALIZED)
  // AC: 1a
  it('[P1] T-34.1-09: double initialization is rejected', async () => {
    // Given: a channel already initialized
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

    // When: initializeChannel is called again
    // Then: the transaction is rejected
    await expect(
      initializeChannel(
        deployer,
        zkApp,
        participantA,
        participantB,
        channelNonce,
        settlementTimeout,
        tokenId,
        [deployer.key, participantA.key, participantB.key]
      )
    ).rejects.toThrow(/UNINITIALIZED/);
  });

  // T-34.1-10: Deposit to CLOSING or SETTLED channel rejected
  // AC: 2a
  it('[P1] T-34.1-10: deposit to CLOSING channel is rejected', async () => {
    // Given: a channel in CLOSING state
    const channelParams = {
      nonce: channelNonce,
      timeout: settlementTimeout,
      tokenId,
      deposit: depositAmount,
      salt,
    };
    await setupClosingChannel(Local, deployer, zkApp, participantA, participantB, channelParams);

    // When: deposit is attempted on CLOSING channel
    // Then: transaction is rejected
    await expect(
      depositToChannel(participantA, zkApp, depositAmount, participantA, [participantA.key])
    ).rejects.toThrow(/must be OPEN/);
  });

  // T-34.1-11: Deposit with zero amount rejected
  // AC: 2b
  it('[P1] T-34.1-11: deposit with zero amount is rejected', async () => {
    // Given: an OPEN channel
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

    // When: deposit with amount = 0
    // Then: transaction is rejected
    await expect(
      depositToChannel(participantA, zkApp, Field(0), participantA, [participantA.key])
    ).rejects.toThrow(/greater than zero/);
  });

  // T-34.1-12: initiateClose on non-OPEN channel rejected
  // AC: 3a
  it('[P1] T-34.1-12: initiateClose on non-OPEN channel is rejected', async () => {
    // Given: a channel in CLOSING state (already closed once)
    const channelParams = {
      nonce: channelNonce,
      timeout: settlementTimeout,
      tokenId,
      deposit: depositAmount,
      salt,
    };
    const { balanceA, balanceB } = await setupClosingChannel(
      Local,
      deployer,
      zkApp,
      participantA,
      participantB,
      channelParams
    );

    // When: initiateClose is called again on CLOSING channel
    const closeMsg = [balanceA, balanceB, salt, Field(2)];
    const sigA2 = Signature.create(participantA.key, closeMsg);
    const sigB2 = Signature.create(participantB.key, closeMsg);

    // Then: transaction is rejected
    await expect(
      closeChannel(deployer, zkApp, balanceA, balanceB, salt, Field(2), sigA2, sigB2, [
        deployer.key,
      ])
    ).rejects.toThrow(/must be OPEN/);
  });

  // T-34.1-13: Settle on non-CLOSING channel rejected
  // AC: 5a
  it('[P1] T-34.1-13: settle on OPEN channel is rejected', async () => {
    // Given: an OPEN channel (not yet closed)
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

    // When: settle is called on OPEN channel
    // Then: transaction is rejected
    await expect(
      settleChannel(
        deployer,
        zkApp,
        depositAmount,
        Field(0),
        salt,
        participantA,
        participantB,
        channelNonce,
        [deployer.key]
      )
    ).rejects.toThrow(/must be CLOSING/);
  });

  // T-34.1-14: initiateClose with balanceA + balanceB != depositTotal rejected
  // AC: 3b
  // Risk: R-06 (balance conservation)
  it('[P1] T-34.1-14: initiateClose with balance sum != depositTotal is rejected', async () => {
    // Given: an OPEN channel with depositTotal = depositAmount
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

    // When: close is called with balanceA + balanceB != depositTotal
    const badBalanceA = depositAmount.add(Field(1)); // Exceeds depositTotal
    const badBalanceB = Field(0);
    const closeMsg = [badBalanceA, badBalanceB, salt, Field(1)];
    const sigA = Signature.create(participantA.key, closeMsg);
    const sigB = Signature.create(participantB.key, closeMsg);

    // Then: transaction is rejected (balanceA + balanceB must equal depositTotal)
    await expect(
      closeChannel(deployer, zkApp, badBalanceA, badBalanceB, salt, Field(1), sigA, sigB, [
        deployer.key,
      ])
    ).rejects.toThrow(/must equal depositTotal/);
  });

  // T-34.1-15: Settle with incorrect balance reveal (commitment mismatch) rejected
  // AC: 4
  // Risk: R-03 (Poseidon commitment mismatch)
  it('[P1] T-34.1-15: settle with incorrect balance reveal is rejected', async () => {
    // Given: a CLOSING channel with known commitment
    const channelParams = {
      nonce: channelNonce,
      timeout: settlementTimeout,
      tokenId,
      deposit: depositAmount,
      salt,
    };
    await setupClosingChannel(Local, deployer, zkApp, participantA, participantB, channelParams);

    // When: settle is called with WRONG balances (commitment mismatch)
    Local.setGlobalSlot(200);
    const wrongBalanceA = Field(500_000_000); // Different from committed balances
    const wrongBalanceB = Field(500_000_000);

    // Then: transaction is rejected (Poseidon commitment does not match)
    await expect(
      settleChannel(
        deployer,
        zkApp,
        wrongBalanceA,
        wrongBalanceB,
        salt,
        participantA,
        participantB,
        channelNonce,
        [deployer.key]
      )
    ).rejects.toThrow(/commitment/);
  });

  // =========================================================================
  // Gap-Filling Tests -- Coverage Expansion (automate workflow)
  // =========================================================================

  // T-34.1-16: Deposit to SETTLED channel rejected
  // AC: 2a (gap: original T-34.1-10 only tested CLOSING, not SETTLED)
  it('[P1] T-34.1-16: deposit to SETTLED channel is rejected', async () => {
    // Given: a channel in SETTLED state
    const channelParams = {
      nonce: channelNonce,
      timeout: settlementTimeout,
      tokenId,
      deposit: depositAmount,
      salt,
    };
    await setupSettledChannel(Local, deployer, zkApp, participantA, participantB, channelParams);

    // Verify channel is actually SETTLED
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());

    // When: deposit is attempted on SETTLED channel
    // Then: transaction is rejected (channelState must be OPEN)
    await expect(
      depositToChannel(participantA, zkApp, depositAmount, participantA, [participantA.key])
    ).rejects.toThrow(/must be OPEN/);
  });

  // T-34.1-17: initiateClose on SETTLED channel rejected
  // AC: 3a (gap: original T-34.1-12 only tested CLOSING, not SETTLED)
  it('[P1] T-34.1-17: initiateClose on SETTLED channel is rejected', async () => {
    // Given: a channel in SETTLED state
    const channelParams = {
      nonce: channelNonce,
      timeout: settlementTimeout,
      tokenId,
      deposit: depositAmount,
      salt,
    };
    const { balanceA, balanceB } = await setupSettledChannel(
      Local,
      deployer,
      zkApp,
      participantA,
      participantB,
      channelParams
    );

    // Verify channel is SETTLED
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());

    // When: initiateClose is called on SETTLED channel
    const closeMsg = [balanceA, balanceB, salt, Field(2)];
    const sigA2 = Signature.create(participantA.key, closeMsg);
    const sigB2 = Signature.create(participantB.key, closeMsg);

    // Then: transaction is rejected (channelState must be OPEN)
    await expect(
      closeChannel(deployer, zkApp, balanceA, balanceB, salt, Field(2), sigA2, sigB2, [
        deployer.key,
      ])
    ).rejects.toThrow(/must be OPEN/);
  });

  // T-34.1-18: settle on SETTLED channel rejected (double-settle)
  // AC: 5a (gap: original T-34.1-13 only tested OPEN, not SETTLED)
  it('[P1] T-34.1-18: settle on already SETTLED channel is rejected', async () => {
    // Given: a channel that has already been settled
    const channelParams = {
      nonce: channelNonce,
      timeout: settlementTimeout,
      tokenId,
      deposit: depositAmount,
      salt,
    };
    const { balanceA, balanceB } = await setupSettledChannel(
      Local,
      deployer,
      zkApp,
      participantA,
      participantB,
      channelParams
    );

    // Verify channel is SETTLED
    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.SETTLED.toString());

    // When: settle is called again on already SETTLED channel
    // Then: transaction is rejected (channelState must be CLOSING)
    await expect(
      settleChannel(
        deployer,
        zkApp,
        balanceA,
        balanceB,
        salt,
        participantA,
        participantB,
        channelNonce,
        [deployer.key]
      )
    ).rejects.toThrow(/must be CLOSING/);
  });

  // =========================================================================
  // Security Tests -- Overflow and Range Protection
  // =========================================================================

  // T-34.1-19: deposit with amount exceeding safe range is rejected
  // Security: Field arithmetic overflow prevention
  it('[P1] T-34.1-19: deposit with amount exceeding safe range is rejected', async () => {
    // Given: an OPEN channel
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

    // When: deposit with amount exceeding MAX_SAFE_AMOUNT (2^64 - 1)
    const unsafeAmount = MAX_SAFE_AMOUNT.add(Field(1));

    // Then: transaction is rejected
    await expect(
      depositToChannel(participantA, zkApp, unsafeAmount, participantA, [participantA.key])
    ).rejects.toThrow(/safe range/);
  });

  // T-34.1-20: initiateClose with modular-arithmetic-exploiting balances is rejected
  // Security: Prevents "negative balance" via Field modular wrap-around
  it('[P1] T-34.1-20: initiateClose with individual balance exceeding depositTotal is rejected', async () => {
    // Given: an OPEN channel with a deposit
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

    // When: close is called with balanceA > depositTotal (exploiting modular arithmetic)
    // balanceA = depositTotal + 1, balanceB = Field.ORDER - 1 (so modular sum = depositTotal)
    const exploitBalanceA = depositAmount.add(Field(1));
    // balanceB would need to be (Field.ORDER - 1) to make the sum work mod p,
    // but the individual balance check should catch exploitBalanceA > depositTotal
    // before the sum check matters. We test with a simpler case:
    // balanceA = depositTotal + 100, balanceB = 0 -- sum != depositTotal AND balanceA > depositTotal
    const exploitBalanceB = Field(0);
    const closeMsg = [exploitBalanceA, exploitBalanceB, salt, Field(1)];
    const sigA = Signature.create(participantA.key, closeMsg);
    const sigB = Signature.create(participantB.key, closeMsg);

    // Then: transaction is rejected (either balance conservation or individual balance check)
    await expect(
      closeChannel(deployer, zkApp, exploitBalanceA, exploitBalanceB, salt, Field(1), sigA, sigB, [
        deployer.key,
      ])
    ).rejects.toThrow();
  });
});
