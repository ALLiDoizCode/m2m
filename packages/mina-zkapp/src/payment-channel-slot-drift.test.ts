/**
 * Slot-drift regression (#202): `initiateClose` must survive a real-chain global
 * slot advance between `tx.prove()` and `tx.send()`.
 *
 * ROOT CAUSE (confirmed on lightnet): the merged `initiateClose` (#191/#192) read
 * `this.network.globalSlotSinceGenesis.getAndRequireEquals()` to record
 * `closedAtSlot`. `getAndRequireEquals()` pins an EXACT global-slot precondition.
 * On `Mina.LocalBlockchain` the slot is frozen for the duration of a tx, so the
 * exact precondition always holds and the bug is invisible. On a REAL Mina node
 * the slot advances between proof generation and block inclusion, so the exact
 * precondition is unsatisfiable and the ledger rejects the tx with
 * `Protocol_state_precondition_unsatisfied`. The same applied to `settle`'s
 * exact-slot challenge-period read.
 *
 * This test reproduces the drift WITHOUT a lightnet by advancing the
 * LocalBlockchain slot AFTER `tx.prove()` but BEFORE `tx.send()` (via
 * `Local.setGlobalSlot`), which is exactly what a real chain does on its own.
 *
 *   1. OLD pattern (exact precondition, reproduced inline in `ExactSlotProbe`):
 *      a slot advance after prove → send FAILS. This is the bug.
 *   2. FIX (the production `PaymentChannel`, RANGE precondition): the same slot
 *      advance (within `SLOT_WINDOW`) → send SUCCEEDS, and an advance BEYOND the
 *      window is correctly rejected (the witness must be "~now").
 *
 * Gated on MINA_PROOFS=true like the other proofs-enabled suites (real proving is
 * slow). Run locally with:
 *   MINA_PROOFS=true npx jest src/payment-channel-slot-drift.test.ts --runInBand
 *
 * @module payment-channel-slot-drift.test
 */

import {
  Mina,
  PrivateKey,
  Field,
  Signature,
  SmartContract,
  State,
  state,
  method,
  AccountUpdate,
} from 'o1js';

import { PaymentChannel, SLOT_WINDOW } from './PaymentChannel';
import { CHANNEL_STATE } from './constants';
import { deployZkApp, initializeChannel, depositToChannel } from './test-helpers';

const RUN_PROOFS = process.env.MINA_PROOFS === 'true';
const describeProofs = RUN_PROOFS ? describe : describe.skip;

// Override jest timeout for proof-enabled tests -- each proof takes 30-120s.
jest.setTimeout(20 * 60_000);

/**
 * Minimal probe that reproduces the OLD, buggy exact-slot precondition pattern:
 * it pins the EXACT on-chain global slot via `getAndRequireEquals()`. Used ONLY
 * to demonstrate that an inter-prove/send slot advance breaks an exact-slot
 * precondition (the bug). The production `PaymentChannel` no longer does this.
 */
class ExactSlotProbe extends SmartContract {
  @state(Field) slotField = State<Field>();

  @method async recordSlotExact(): Promise<void> {
    // OLD pattern: EXACT precondition on the current global slot.
    const currentSlot = this.network.globalSlotSinceGenesis.getAndRequireEquals();
    this.slotField.set(currentSlot.value);
  }
}

describeProofs('PaymentChannel slot-drift (#202)', () => {
  beforeAll(async () => {
    await ExactSlotProbe.compile();
    await PaymentChannel.compile();
  }, 20 * 60_000);

  it('OLD exact-slot precondition FAILS when the slot advances between prove and send', async () => {
    const Local = await Mina.LocalBlockchain({ proofsEnabled: true });
    Mina.setActiveInstance(Local);
    const [deployer] = Local.testAccounts;

    const probeKey = PrivateKey.random();
    const probe = new ExactSlotProbe(probeKey.toPublicKey());

    const deployTx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer);
      await probe.deploy();
    });
    await deployTx.prove();
    await deployTx.sign([deployer.key, probeKey]).send();

    Local.setGlobalSlot(100);

    const tx = await Mina.transaction(deployer, async () => {
      await probe.recordSlotExact();
    });
    await tx.prove(); // proof pins the EXACT slot 100
    // Simulate real-chain drift: the slot advances before the tx is included.
    Local.setGlobalSlot(105);

    // The ledger rejects the tx: on-chain slot (105) != pinned slot (100).
    await expect(tx.sign([deployer.key]).send()).rejects.toThrow();
  });

  it('FIX: range precondition lets initiateClose survive a slot advance within SLOT_WINDOW', async () => {
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

    const balA = Field(600_000_000);
    const balB = Field(400_000_000);
    const salt = Field(99999);
    const closeMsg = [balA, balB, salt, Field(2)];
    const sigA = Signature.create(participantA.key, closeMsg);
    const sigB = Signature.create(participantB.key, closeMsg);

    // Read the "current" slot off-chain (as the SDK does) and witness it.
    const witnessedSlot = Mina.getNetworkState().globalSlotSinceGenesis; // slot 0 here
    const tx = await Mina.transaction(deployer, async () => {
      await zkApp.initiateClose(balA, balB, salt, Field(2), sigA, sigB, witnessedSlot);
    });
    await tx.prove(); // range precondition: slot ∈ [witnessed, witnessed + SLOT_WINDOW]

    // Simulate real-chain drift WITHIN the tolerance window.
    Local.setGlobalSlot(Number(SLOT_WINDOW.toBigint()) - 1);

    // With the fix this is accepted (the witnessed slot is still "~now").
    await tx.sign([deployer.key]).send();

    expect(zkApp.channelState.get().toString()).toBe(CHANNEL_STATE.CLOSING.toString());
    // closedAtSlot is the witnessed slot, not the (drifted) inclusion slot.
    expect((zkApp.closedAtSlot.get() as Field).toString()).toBe(witnessedSlot.value.toString());
  });

  it('FIX: a slot advance BEYOND SLOT_WINDOW is correctly rejected (witness must be ~now)', async () => {
    const Local = await Mina.LocalBlockchain({ proofsEnabled: true });
    Mina.setActiveInstance(Local);
    const [deployer, participantA, participantB] = Local.testAccounts;

    const zkAppKey = PrivateKey.random();
    const zkApp = new PaymentChannel(zkAppKey.toPublicKey());

    const channelNonce = Field(7);
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

    const balA = Field(600_000_000);
    const balB = Field(400_000_000);
    const salt = Field(99999);
    const closeMsg = [balA, balB, salt, Field(2)];
    const sigA = Signature.create(participantA.key, closeMsg);
    const sigB = Signature.create(participantB.key, closeMsg);

    const witnessedSlot = Mina.getNetworkState().globalSlotSinceGenesis; // slot 0
    const tx = await Mina.transaction(deployer, async () => {
      await zkApp.initiateClose(balA, balB, salt, Field(2), sigA, sigB, witnessedSlot);
    });
    await tx.prove();

    // Drift PAST the window: on-chain slot > witnessed + SLOT_WINDOW.
    Local.setGlobalSlot(Number(SLOT_WINDOW.toBigint()) + 5);

    await expect(tx.sign([deployer.key]).send()).rejects.toThrow();
  });
});
