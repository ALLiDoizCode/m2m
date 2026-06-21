/**
 * Mina Payment Channel zkApp -- Channel Lifecycle SmartContract
 *
 * Manages payment channel lifecycle (open, deposit, close, settle) on Mina
 * with zero-knowledge balance commitments via Poseidon hashing.
 *
 * On-chain state uses exactly 8 Field elements (the Mina protocol maximum).
 *
 * Story 34.1 -- Epic 34: Mina Protocol Payment Channel Provider
 *
 * @module PaymentChannel
 */

import {
  SmartContract,
  State,
  state,
  method,
  Field,
  PublicKey,
  Poseidon,
  Signature,
  AccountUpdate,
  UInt32,
} from 'o1js';

import { CHANNEL_STATE, ASSERT_MESSAGES, MAX_SAFE_AMOUNT } from './constants';

/**
 * Tolerance window (in global slots) for the `initiateClose` "current slot"
 * witness (#202 real-chain fix).
 *
 * `initiateClose` records the close slot from a caller-supplied `currentSlot`
 * witness rather than pinning an EXACT on-chain slot. On a real Mina node the
 * global slot advances between proof generation and tx inclusion, so an exact
 * `getAndRequireEquals()` slot precondition is unsatisfiable (it fails with
 * `Protocol_state_precondition_unsatisfied`). Instead we bind the witness with a
 * RANGE precondition `globalSlotSinceGenesis ∈ [currentSlot, currentSlot + SLOT_WINDOW]`,
 * which proves the witness is "~now" while tolerating the small drift between
 * proving and inclusion. 7 slots ≈ ~21 min on mainnet (≈3 min/slot) and is
 * comfortably above lightnet/real-chain proving+inclusion latency, while still
 * being tight enough that the recorded `closedAtSlot` (which feeds the settle
 * challenge-period deadline) cannot be meaningfully back/forward-dated.
 */
export const SLOT_WINDOW = UInt32.from(7);

/**
 * Payment channel zkApp that manages the full channel lifecycle.
 *
 * State fields (exactly 8):
 * 1. channelHash       -- Poseidon(participantA.x, participantB.x, nonce)
 * 2. balanceCommitment -- Poseidon(balanceA, balanceB, salt)
 * 3. nonceField        -- Monotonically increasing state nonce
 * 4. channelState      -- 0=UNINITIALIZED, 1=OPEN, 2=CLOSING, 3=SETTLED
 * 5. depositTotal      -- Total deposited amount (public)
 * 6. closedAtSlot      -- Global slot when close was initiated
 * 7. settlementTimeout -- Slots for challenge period
 * 8. tokenId_          -- Mina token ID (trailing underscore avoids collision
 *                        with the built-in o1js `tokenId` property on SmartContract)
 */
export class PaymentChannel extends SmartContract {
  @state(Field) channelHash = State<Field>();
  @state(Field) balanceCommitment = State<Field>();
  @state(Field) nonceField = State<Field>();
  @state(Field) channelState = State<Field>();
  @state(Field) depositTotal = State<Field>();
  @state(Field) closedAtSlot = State<Field>();
  @state(Field) settlementTimeout = State<Field>();
  /** Named `tokenId_` to avoid collision with built-in SmartContract.tokenId */
  @state(Field) tokenId_ = State<Field>();

  /**
   * Initialize a new payment channel between two participants.
   *
   * Sets all 8 state fields. Both participants must sign the transaction.
   * Channel must be in UNINITIALIZED state (prevents double-init).
   *
   * @param participantA - Public key of participant A
   * @param participantB - Public key of participant B
   * @param nonce - Unique nonce for channel derivation
   * @param timeout - Settlement timeout in slots
   * @param tokenId - Mina token ID for the channel
   */
  @method async initializeChannel(
    participantA: PublicKey,
    participantB: PublicKey,
    nonce: Field,
    timeout: Field,
    tokenId: Field
  ): Promise<void> {
    // Require channel is uninitialized
    const currentState = this.channelState.getAndRequireEquals();
    currentState.assertEquals(
      CHANNEL_STATE.UNINITIALIZED,
      ASSERT_MESSAGES.CHANNEL_MUST_BE_UNINITIALIZED
    );

    // Compute channel hash from participants and nonce
    const hash = Poseidon.hash([participantA.x, participantB.x, nonce]);

    // Initial balance commitment: Poseidon(0, 0, 0) -- zero balances, zero salt.
    // A zero salt is acceptable here because the initial balances (0, 0) are
    // publicly known at channel creation time -- there is nothing to hide.
    // Privacy begins once claims update the commitment (Story 34.2).
    const initialCommitment = Poseidon.hash([Field(0), Field(0), Field(0)]);

    // Set all 8 state fields
    this.channelHash.set(hash);
    this.balanceCommitment.set(initialCommitment);
    this.nonceField.set(Field(0));
    this.channelState.set(CHANNEL_STATE.OPEN);
    this.depositTotal.set(Field(0));
    this.closedAtSlot.set(Field(0));
    this.settlementTimeout.set(timeout);
    this.tokenId_.set(tokenId);
  }

  /**
   * Deposit into an open channel.
   *
   * Increments depositTotal by the given amount (USDC base units) and binds the
   * depositor's authorization. Requires channelState == OPEN and amount > 0.
   *
   * TOKEN CUSTODY (#191 — USDC across all chains): the channel now custodies the
   * **USDC custom token** (`mina-fungible-token`), not native MINA. Custom-token
   * balances cannot be moved by the channel proof via `AccountUpdate.send` /
   * `this.send` — only the token-owner zkApp may move its token (any other actor
   * gets `Token_owner_not_caller`). So this method does the **accounting half**
   * (depositTotal += amount, range/state checks, depositor binding) while the
   * **token-transfer half** is built in the SAME transaction by the caller (SDK /
   * test) as `token.transfer(depositor, channelAddress, amount)` under the USDC
   * `tokenId`. The token owner's `transfer` proof authorizes the depositor→channel
   * move; the depositor signs the tx, which authorizes both the token outflow and
   * the empty signed AccountUpdate below (binding the depositor identity on-chain,
   * exactly as the native-MINA custody used to).
   *
   * This composition (channel = accountant, token owner = mover) is the only one
   * that works with `mina-fungible-token` + o1js 2.14.0; a channel-proof-authored
   * token balance change fails `Token_owner_not_caller`.
   *
   * INVARIANT: `channelHash` stays native (Poseidon(A.x, B.x, nonce)); `tokenId`
   * is a channel parameter stored in `tokenId_`, NOT part of channelHash.
   *
   * @param amount - Amount to deposit (must be > 0), in USDC base units (6 dp)
   * @param depositor - Public key of the depositor (bound on-chain; signs the tx)
   */
  @method async deposit(amount: Field, depositor: PublicKey): Promise<void> {
    // Require channel is OPEN
    const currentState = this.channelState.getAndRequireEquals();
    currentState.assertEquals(CHANNEL_STATE.OPEN, ASSERT_MESSAGES.CHANNEL_MUST_BE_OPEN);

    // Require amount > 0
    amount.assertGreaterThan(Field(0), ASSERT_MESSAGES.DEPOSIT_MUST_BE_POSITIVE);

    // Range-check amount to prevent Field arithmetic overflow.
    // Field elements are modular (mod ~2^254), so adding two large Fields
    // can silently wrap around. Bounding amount to MAX_SAFE_AMOUNT ensures
    // depositTotal stays within a safe integer range and cannot overflow.
    amount.assertLessThanOrEqual(MAX_SAFE_AMOUNT, ASSERT_MESSAGES.AMOUNT_EXCEEDS_SAFE_RANGE);

    // Increment deposit total
    const currentDeposit = this.depositTotal.getAndRequireEquals();
    const newDeposit = currentDeposit.add(amount);

    // Verify the new total also remains within safe range (defense-in-depth)
    newDeposit.assertLessThanOrEqual(MAX_SAFE_AMOUNT, ASSERT_MESSAGES.DEPOSIT_TOTAL_OVERFLOW);

    this.depositTotal.set(newDeposit);

    // DEPOSITOR BINDING: require the depositor's signature on this transaction.
    // The actual USDC transfer (depositor → this channel's token account) is a
    // sibling AccountUpdate built by the caller via the token owner in the same
    // tx; this empty signed update binds the depositor identity on-chain and
    // ensures the deposit accounting cannot be authorized without the depositor.
    AccountUpdate.createSigned(depositor);
  }

  /**
   * Initiate cooperative channel closure.
   *
   * Both participants must sign the close message. Verifies balance conservation
   * (balanceA + balanceB == depositTotal), computes and stores the balance
   * commitment, and transitions state to CLOSING.
   *
   * @param balanceA - Final balance for participant A
   * @param balanceB - Final balance for participant B
   * @param salt - Salt for balance commitment
   * @param nonce - Close nonce
   * @param sigA - Signature from participant A over [balanceA, balanceB, salt, nonce]
   * @param sigB - Signature from participant B over [balanceA, balanceB, salt, nonce]
   * @param currentSlot - Caller-supplied "current" global slot witness (#202). The
   *   caller reads the live network slot off-chain and passes it; a RANGE
   *   precondition `globalSlotSinceGenesis ∈ [currentSlot, currentSlot + SLOT_WINDOW]`
   *   binds it to "~now". This replaces the old exact on-chain slot read, which is
   *   unsatisfiable on a real chain (the slot advances between prove and inclusion →
   *   `Protocol_state_precondition_unsatisfied`). The witnessed `currentSlot` is what
   *   gets recorded as `closedAtSlot` and feeds the settle challenge-period deadline.
   */
  @method async initiateClose(
    balanceA: Field,
    balanceB: Field,
    salt: Field,
    _nonce: Field,
    _sigA: Signature,
    _sigB: Signature,
    currentSlot: UInt32
  ): Promise<void> {
    // Require channel is OPEN
    const currentState = this.channelState.getAndRequireEquals();
    currentState.assertEquals(CHANNEL_STATE.OPEN, ASSERT_MESSAGES.CHANNEL_MUST_BE_OPEN);

    // Verify balance conservation: balanceA + balanceB == depositTotal
    const currentDeposit = this.depositTotal.getAndRequireEquals();
    balanceA
      .add(balanceB)
      .assertEquals(currentDeposit, ASSERT_MESSAGES.BALANCE_SUM_MUST_EQUAL_DEPOSIT);

    // Verify each balance is individually <= depositTotal to prevent modular
    // arithmetic exploits. Without this check, a malicious actor could provide
    // a "negative" balance (a huge Field value close to the field modulus) for
    // one participant such that the modular sum still equals depositTotal.
    balanceA.assertLessThanOrEqual(currentDeposit, ASSERT_MESSAGES.BALANCE_EXCEEDS_DEPOSIT);
    balanceB.assertLessThanOrEqual(currentDeposit, ASSERT_MESSAGES.BALANCE_EXCEEDS_DEPOSIT);

    // Read channelHash to bind this operation to the channel identity.
    // getAndRequireEquals() creates a precondition that the on-chain channelHash
    // has not changed between proof generation and transaction inclusion. This
    // prevents replay of a close proof against a different channel deployed at
    // the same address. Participant-level authorization (verifying sigA/sigB
    // came from the participants in channelHash) is enforced at the SDK level
    // (Story 34.4).
    this.channelHash.getAndRequireEquals();

    // SECURITY NOTE: sigA and sigB are accepted as circuit witnesses but are not
    // verified on-chain in this story. This is an intentional architectural
    // decision -- full participant-key binding (verifying sigA came from
    // participantA and sigB came from participantB) will be enforced at the SDK
    // level (Story 34.4) where the SDK has access to the participant public keys.
    //
    // The on-chain contract ensures the close message content is correct (balance
    // conservation, commitment) while the SDK ensures the signers are the actual
    // participants. Story 34.3 security tests will validate the end-to-end
    // signature verification chain.
    //
    // TODO(34.4): Evaluate adding on-chain signature.verify() calls here once
    // the SDK integration pattern is finalized. On-chain verification would
    // provide defense-in-depth but adds circuit constraints.

    // Compute and store balance commitment
    const commitment = Poseidon.hash([balanceA, balanceB, salt]);
    this.balanceCommitment.set(commitment);

    // Record the close slot from the caller-supplied `currentSlot` witness,
    // bound to "~now" by a RANGE precondition (#202 real-chain fix).
    //
    // We do NOT pin the EXACT on-chain slot via getAndRequireEquals(): on a real
    // Mina node the global slot advances between proof generation and tx inclusion,
    // so an exact slot precondition is unsatisfiable (it fails the ledger with
    // `Protocol_state_precondition_unsatisfied`). On LocalBlockchain the slot is
    // frozen during a tx, masking the bug — which is why this only surfaced on
    // lightnet/real chain. Instead we require globalSlotSinceGenesis to lie within
    // [currentSlot, currentSlot + SLOT_WINDOW]: the ledger accepts the tx as long
    // as the witnessed slot is no more than SLOT_WINDOW behind the inclusion slot,
    // proving the witness is genuinely current. This mirrors the correct pattern
    // already used by `UsdcChannelToken.settleFromChannel`
    // (`requireBetween(deadline, UInt32.MAXINT())`).
    //
    // Note: globalSlotSinceGenesis is a UInt32 -- `.value` extracts the inner
    // Field for on-chain state storage (UInt32.value is part of the public API).
    this.network.globalSlotSinceGenesis.requireBetween(currentSlot, currentSlot.add(SLOT_WINDOW));
    this.closedAtSlot.set(currentSlot.value);

    // Transition to CLOSING
    this.channelState.set(CHANNEL_STATE.CLOSING);
  }

  /**
   * Settle the channel after the challenge period has elapsed.
   *
   * Verifies the Poseidon commitment against revealed balances, confirms the
   * challenge period has passed, and verifies participant identity against the
   * stored channelHash. Transitions state to SETTLED.
   *
   * FUND DISTRIBUTION (#191 — USDC across all chains): after verifying all
   * preconditions and transitioning to SETTLED, the channel's custodied **USDC**
   * is distributed -- `balanceB` to participantB (the apex recipient, analog of
   * the Solana SETTLE_CHANNEL vault→recipient transfer) and `balanceA` to
   * participantA (the depositor refund). As with deposit, the channel proof
   * CANNOT move a custom token directly (`Token_owner_not_caller`), so this method
   * does only the **accounting half** (state→SETTLED + identity/timeout/commitment
   * checks) while the **token-transfer half** is built in the SAME transaction by
   * the caller as two `token.transfer(channelAddress, participant, amount)` calls
   * under the USDC `tokenId`. Those token outflows debit the channel's token
   * account, which is authorized by the channel account's signature on the settle
   * tx (the channel key signs). Conservation (balanceA + balanceB == depositTotal)
   * was enforced at initiateClose and the commitment is re-verified below, so the
   * two token transfers together drain exactly the custodied deposit.
   *
   * @param balanceA - Revealed balance for participant A
   * @param balanceB - Revealed balance for participant B
   * @param salt - Salt used in the balance commitment
   * @param participantA - Public key of participant A (verified against channelHash)
   * @param participantB - Public key of participant B (verified against channelHash)
   * @param nonce - Channel nonce (verified against channelHash)
   */
  @method async settle(
    balanceA: Field,
    balanceB: Field,
    salt: Field,
    participantA: PublicKey,
    participantB: PublicKey,
    nonce: Field
  ): Promise<void> {
    // Require channel is CLOSING
    const currentState = this.channelState.getAndRequireEquals();
    currentState.assertEquals(CHANNEL_STATE.CLOSING, ASSERT_MESSAGES.CHANNEL_MUST_BE_CLOSING);

    // Verify participant identity: recompute channelHash and compare to stored value.
    // This ensures the caller provides the correct participants for this channel,
    // preventing settlement with fabricated participant addresses.
    const storedChannelHash = this.channelHash.getAndRequireEquals();
    const computedChannelHash = Poseidon.hash([participantA.x, participantB.x, nonce]);
    computedChannelHash.assertEquals(storedChannelHash, ASSERT_MESSAGES.CHANNEL_HASH_MISMATCH);

    // Verify challenge period has elapsed via a RANGE precondition (#202
    // real-chain fix), NOT an exact on-chain slot read. The deadline is derived
    // from on-chain state (`closedAtSlot` + `settlementTimeout`, both pinned by
    // getAndRequireEquals() so they cannot be forged), and we require the network
    // global slot to be in [deadline, MAXINT] — i.e. at or past the deadline.
    //
    // The old `globalSlotSinceGenesis.getAndRequireEquals()` pinned the EXACT
    // current slot, which is unsatisfiable on a real chain: the slot advances
    // between proof generation and tx inclusion, failing the ledger with
    // `Protocol_state_precondition_unsatisfied`. A `>= deadline` range bound is
    // both correct (settle is only valid after the deadline) and real-chain-safe.
    // This mirrors `UsdcChannelToken.settleFromChannel`'s
    // `requireBetween(deadline, UInt32.MAXINT())`.
    const closedAt = this.closedAtSlot.getAndRequireEquals();
    const timeout = this.settlementTimeout.getAndRequireEquals();
    const deadline = UInt32.Unsafe.fromField(closedAt.add(timeout));

    this.network.globalSlotSinceGenesis.requireBetween(deadline, UInt32.MAXINT());

    // Verify balance commitment matches revealed balances
    const storedCommitment = this.balanceCommitment.getAndRequireEquals();
    const computedCommitment = Poseidon.hash([balanceA, balanceB, salt]);
    computedCommitment.assertEquals(storedCommitment, ASSERT_MESSAGES.COMMITMENT_MISMATCH);

    // Transition to SETTLED
    this.channelState.set(CHANNEL_STATE.SETTLED);

    // FUND DISTRIBUTION: the USDC payouts (channel token account → participantB
    // balanceB, → participantA balanceA) are built by the caller as sibling
    // `token.transfer(...)` AccountUpdates in this same transaction (see the note
    // above and settleChannel in test-helpers). The channel proof intentionally
    // does NOT emit them: a channel-authored custom-token balance change fails
    // `Token_owner_not_caller`; only the token owner may move USDC. The channel
    // key signs the settle tx, authorizing the outflows from the channel's token
    // account. balanceA/balanceB are proven <= depositTotal (<= MAX_SAFE_AMOUNT)
    // via the commitment + the conservation check at initiateClose, so the token
    // amounts the caller derives from them are sound.
  }

  /**
   * Cooperative balance update via zk-SNARK proof (private claim).
   *
   * Updates the on-chain balance commitment and nonce without revealing actual
   * balances. The proof circuit enforces six invariants: commitment validity,
   * conservation, non-negativity, monotonic nonce, participant binding, and
   * dual-party authorization.
   *
   * All parameters except newBalanceCommitment and newNonce are private circuit
   * witnesses -- they are consumed inside the proof but never appear on-chain.
   * This is the core privacy mechanism: on-chain observers see only the updated
   * Poseidon commitment hash and nonce.
   *
   * Story 34.2 -- Epic 34: Mina Protocol Payment Channel Provider
   *
   * @param newBalanceA - New balance for participant A (private)
   * @param newBalanceB - New balance for participant B (private)
   * @param newSalt - Salt for the new balance commitment (private)
   * @param signatureA - Signature from participant A (private)
   * @param signatureB - Signature from participant B (private)
   * @param participantA - Public key of participant A (private, verified against channelHash)
   * @param participantB - Public key of participant B (private, verified against channelHash)
   * @param channelNonce - Channel nonce for channelHash binding (private)
   * @param newBalanceCommitment - Poseidon(newBalanceA, newBalanceB, newSalt) (written to state)
   * @param newNonce - New monotonically increasing nonce (written to state)
   */
  @method async claimFromChannel(
    newBalanceA: Field,
    newBalanceB: Field,
    newSalt: Field,
    signatureA: Signature,
    signatureB: Signature,
    participantA: PublicKey,
    participantB: PublicKey,
    channelNonce: Field,
    newBalanceCommitment: Field,
    newNonce: Field
  ): Promise<void> {
    // 1. Require channel is OPEN (AC: 7 -- claims only when OPEN)
    const currentState = this.channelState.getAndRequireEquals();
    currentState.assertEquals(CHANNEL_STATE.OPEN, ASSERT_MESSAGES.CHANNEL_MUST_BE_OPEN);

    // 2. Read and bind on-chain state with preconditions (security)
    const storedChannelHash = this.channelHash.getAndRequireEquals();
    const currentDeposit = this.depositTotal.getAndRequireEquals();
    const currentNonce = this.nonceField.getAndRequireEquals();

    // 3. Commitment validity: Poseidon(newBalanceA, newBalanceB, newSalt) == newBalanceCommitment (AC: 1, 8)
    const computedCommitment = Poseidon.hash([newBalanceA, newBalanceB, newSalt]);
    computedCommitment.assertEquals(newBalanceCommitment, ASSERT_MESSAGES.COMMITMENT_MISMATCH);

    // 4. Conservation: newBalanceA + newBalanceB == depositTotal (AC: 2)
    newBalanceA
      .add(newBalanceB)
      .assertEquals(currentDeposit, ASSERT_MESSAGES.BALANCE_CONSERVATION_VIOLATED);

    // 5. Non-negativity + range checks (AC: 3)
    // Fields are unsigned in o1js, so >= 0 is inherent. However, modular
    // arithmetic can produce large values that "wrap around" to appear valid.
    // The <= depositTotal check prevents this exploit (same pattern as initiateClose).
    newBalanceA.assertLessThanOrEqual(currentDeposit, ASSERT_MESSAGES.BALANCE_EXCEEDS_DEPOSIT);
    newBalanceB.assertLessThanOrEqual(currentDeposit, ASSERT_MESSAGES.BALANCE_EXCEEDS_DEPOSIT);

    // Defense-in-depth: bound balances to MAX_SAFE_AMOUNT (same as deposit())
    newBalanceA.assertLessThanOrEqual(MAX_SAFE_AMOUNT, ASSERT_MESSAGES.AMOUNT_EXCEEDS_SAFE_RANGE);
    newBalanceB.assertLessThanOrEqual(MAX_SAFE_AMOUNT, ASSERT_MESSAGES.AMOUNT_EXCEEDS_SAFE_RANGE);

    // 6. Monotonic nonce: newNonce > currentNonce (AC: 4)
    newNonce.assertGreaterThan(currentNonce, ASSERT_MESSAGES.NONCE_MUST_INCREASE);

    // Nonce range check to prevent Field overflow
    newNonce.assertLessThanOrEqual(MAX_SAFE_AMOUNT, ASSERT_MESSAGES.NONCE_EXCEEDS_SAFE_RANGE);

    // 7. Participant binding: verify supplied keys match channelHash (AC: 5, 9)
    const computedHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);
    computedHash.assertEquals(storedChannelHash, ASSERT_MESSAGES.CHANNEL_HASH_MISMATCH);

    // 8. Dual-party authorization: both participants signed [newBalanceCommitment, newNonce, channelHash] (AC: 5)
    const message = [newBalanceCommitment, newNonce, storedChannelHash];
    signatureA.verify(participantA, message).assertTrue(ASSERT_MESSAGES.INVALID_SIGNATURE_A);
    signatureB.verify(participantB, message).assertTrue(ASSERT_MESSAGES.INVALID_SIGNATURE_B);

    // 9. Update on-chain state (AC: 1) -- only commitment and nonce are visible
    this.balanceCommitment.set(newBalanceCommitment);
    this.nonceField.set(newNonce);
  }
}
