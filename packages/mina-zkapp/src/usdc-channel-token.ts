/**
 * `UsdcChannelToken` — in-proof-enforcing USDC token owner for Mina.
 *
 * Mina's stock `mina-fungible-token` lets only the token owner move its token
 * (`Token_owner_not_caller`), so the merged #191/#192 design made `PaymentChannel`
 * accounting-only and had the **SDK** build the `token.transfer(...)` updates. The
 * proof therefore did NOT bind the token payout to the channel's committed
 * balances — a wrong/malicious SDK or compromised channel key could desync
 * accounting from escrow (EVM/Solana bind payouts in-contract; Mina was the
 * outlier).
 *
 * This subclass moves enforcement INTO THE PROOF. It is the custom token owner:
 * the only actor that can move USDC. By gating the only escrow-moving paths
 * behind channel-rule preconditions, the *proof* (not the SDK) binds payouts to
 * the channel's on-chain commitment, matching EVM/Solana trustlessness.
 *
 * Two custom `@method`s on top of the audited `FungibleToken`:
 *
 *   - `depositToChannel(channelAddress, amount, depositor)` — precondition the
 *     channel is OPEN; on the channel's first deposit make its escrow token
 *     account CUSTODIAL (`send: none`, `setPermissions: impossible`); author the
 *     depositor→escrow debit (depositor signs) + escrow credit. The SAME `amount`
 *     field also feeds `channel.deposit(amount, depositor)` in the same tx, and a
 *     post-state precondition on `channel.depositTotal` makes accounting↔escrow
 *     desync impossible.
 *
 *   - `settleFromChannel(channelAddress, balanceA, balanceB, salt, A, B, nonce)` —
 *     bind to the channel's ON-CHAIN pre-settle state via account preconditions:
 *     `balanceCommitment == Poseidon(balanceA,balanceB,salt)`,
 *     `depositTotal == balanceA+balanceB`, `channelState == CLOSING`,
 *     `channelHash == Poseidon(A.x,B.x,nonce)`, and the challenge period elapsed
 *     (`currentSlot >= closedAtSlot + settlementTimeout`). Then author
 *     escrow→participantB (`balanceB`) and escrow→participantA (`balanceA`) using
 *     the custodial lazy-none pattern, SKIPPING zero amounts. Payouts are FORCED
 *     equal to the committed balances by the proof; no channel/escrow signature.
 *
 * Patterns reused from the proven spike (`usdc-inproof-spike.ts`) and documented
 * in `docs/usdc-mina-inproof-enforcement.md` "Spike results":
 *   - custodial escrow (`send: none` + `setPermissions: impossible`),
 *   - owner-authored escrow debit via a manually-built lazy-none AccountUpdate
 *     (o1js `internal.send` hardcodes a lazy *signature*, which a custodial escrow
 *     must not need),
 *   - manual cross-account state preconditions (`body.preconditions.account
 *     .state[i]`, since the high-level `au.account.state` helper is a no-op),
 *   - the `declare events` TS workaround for the `@method` decorator (TS1241).
 *
 * @module usdc-channel-token
 */

import {
  AccountUpdate,
  Bool,
  Field,
  Int64,
  method,
  Permissions,
  Poseidon,
  PublicKey,
  UInt32,
  UInt64,
} from 'o1js';
import { FungibleToken } from 'mina-fungible-token';

import { CHANNEL_STATE } from './constants';

/**
 * `PaymentChannel`'s on-chain @state slot indices (the order the 8 fields are
 * declared on the contract). `settleFromChannel` / `depositToChannel` bind to
 * these via manual account preconditions, so the order MUST stay in lock-step
 * with `PaymentChannel`'s `@state` declarations. Exported so tests can assert it.
 */
export const CHANNEL_STATE_SLOT = {
  channelHash: 0,
  balanceCommitment: 1,
  nonceField: 2,
  channelState: 3,
  depositTotal: 4,
  closedAtSlot: 5,
  settlementTimeout: 6,
  tokenId_: 7,
} as const;

/**
 * Mark an AccountUpdate as authorized by NEITHER signature NOR proof ("lazy
 * none") — the only authorization a token-holder account with `send:
 * Permissions.none()` will accept WITHOUT a holder signature. o1js's
 * `internal.send` hardcodes a lazy *signature* on the sender (a custodial escrow
 * must NOT need one); we author the sender ourselves and set lazy-none.
 *
 * Inlines what o1js's internal `Authorization.setLazyNone` does (that symbol is
 * not exported from the public `o1js` entry). `isProved=false`/`isSigned=false`
 * means the `verificationKeyHash` slot is unused, so we leave the default
 * authorizationKind hash in place and only flip the two flags + the lazy marker.
 *
 * Proven in the feasibility spike (`usdc-inproof-spike.ts setLazyNone`).
 */
function setLazyNone(au: AccountUpdate): void {
  au.body.authorizationKind.isSigned = Bool(false);
  au.body.authorizationKind.isProved = Bool(false);
  au.authorization = {};
  (au as unknown as { lazyAuthorization: { kind: string } }).lazyAuthorization = {
    kind: 'lazy-none',
  };
}

/**
 * Pin a single on-chain @state slot of `channelAu` as an account precondition.
 *
 * The high-level `au.account.state` helper is a NO-OP for the state array in
 * o1js (precondition.js returns `{}` for array layouts), so we set the slot
 * directly — exactly how `State.requireEquals` wires its precondition internally.
 * Setting `isSome=true, value=expected` makes the ledger REJECT the tx at apply
 * time unless the channel's on-chain `state[slot]` equals `expected`. This is the
 * proof-level binding to `PaymentChannel`'s committed state.
 */
function requireChannelState(channelAu: AccountUpdate, slot: number, expected: Field): void {
  const pre = channelAu.body.preconditions.account.state[slot];
  pre.isSome = Bool(true);
  pre.value = expected;
}

/**
 * `UsdcChannelToken extends FungibleToken` — the in-proof enforcer + escrow mover.
 *
 * Deploy/initialize EXACTLY like the stock USDC `FungibleToken` (same
 * `usdcDeployProps`, same `initialize(adminContract, decimals, startPaused)`);
 * this only ADDS the two channel-bound methods. The channel zkApp is UNCHANGED.
 */
export class UsdcChannelToken extends FungibleToken {
  /**
   * Re-declare `events` with a looser type. `mina-fungible-token`'s
   * `FungibleToken` types `events` with Structs containing `PublicKey` (not
   * `FlexibleProvablePure`), which trips the `@method` decorator's bound when a
   * `.ts` subclass adds methods (TS1241). TYPE-ONLY widening — no runtime change
   * (the base class still defines the actual event Structs in its constructor).
   * Documented spike friction; required for any `FungibleToken` `.ts` subclass.
   */
  declare events: FungibleToken['events'] & Record<string, never>;

  /**
   * One-time: make `channelAddress`'s escrow token account CUSTODIAL.
   *
   * Creates the channel's token account (under this token's id) with
   * `send: Permissions.none()` (so the OWNER'S PROOF can author settle payouts out
   * of it with NO escrow signature) and `setPermissions: Permissions.impossible()`
   * (so that can never be loosened). This is the exact trick
   * `FungibleToken.initialize` uses on its circulation account.
   *
   * AUTHORIZATION: setting permissions on a fresh account requires the account's
   * SIGNATURE (the default `setPermissions` permission is `signature`, not
   * `proof`), so the CHANNEL KEY must sign THIS one-time setup tx (exactly as the
   * spike's `enableCustodialEscrow` required the escrow's signature). After this,
   * settle payouts need NO channel/escrow signature — only the owner's proof. Run
   * this once per channel, before or alongside the first deposit; the caller pays
   * the escrow account's new-account fee.
   *
   * @param channelAddress - the `PaymentChannel` zkApp address whose token account
   *   becomes the custodial escrow
   */
  @method async enableChannelEscrow(channelAddress: PublicKey): Promise<void> {
    const escrowUpdate = AccountUpdate.createSigned(channelAddress, this.deriveTokenId());
    const permissions = Permissions.default();
    permissions.send = Permissions.none();
    permissions.setPermissions = Permissions.impossible();
    escrowUpdate.account.permissions.set(permissions);
    this.approve(escrowUpdate);
  }

  /**
   * Deposit `amount` USDC from `depositor` into `channelAddress`'s escrow token
   * account, bound IN-PROOF to the channel being OPEN and to the channel's
   * resulting `depositTotal` accounting.
   *
   * Composition (same `Mina.transaction`): the caller ALSO invokes
   * `channel.deposit(amount, depositor)` (the channel's accounting half). The
   * `depositor` signs the tx — that single signature authorizes BOTH the USDC
   * outflow from the depositor's token account (default `send` permission) and
   * the channel's depositor-binding empty signed AccountUpdate.
   *
   * Binding (why accounting can't desync from escrow):
   *   1. `channelState == OPEN` precondition (the channel only accepts deposits
   *      when OPEN; `channel.deposit` asserts the same on its proof side).
   *   2. the SAME `amount` field moves the USDC here AND feeds
   *      `channel.deposit(amount, …)`, so they are identical by construction.
   *   3. a `depositTotal` precondition on the channel's resulting total
   *      (`expectedDepositTotalAfter`) — the caller passes the channel's CURRENT
   *      `depositTotal + amount`; this is evaluated against the channel's state at
   *      the point this AU is applied, AFTER the sibling `channel.deposit` AU has
   *      run in the same tx, so if `channel.deposit` does not land that exact total
   *      (e.g. a tampered sibling amount) the ledger rejects the tx. This makes a
   *      deposit whose escrow move ≠ accounted amount impossible.
   *
   * The escrow token account must already be CUSTODIAL — run `enableChannelEscrow`
   * once per channel first (or in the same tx as the first deposit). This method
   * never changes permissions, so every deposit needs only the depositor's
   * signature (no channel key).
   *
   * @param channelAddress - the `PaymentChannel` zkApp address (escrow = its
   *   token account under this token's id)
   * @param amount - USDC base units to deposit (must be > 0; `channel.deposit`
   *   asserts positivity)
   * @param depositor - the depositing account (signs the tx)
   * @param expectedDepositTotalAfter - the channel's `depositTotal` AFTER this
   *   deposit (current on-chain `depositTotal` + `amount`); pinned as a
   *   precondition so escrow ↔ accounting cannot diverge
   */
  @method async depositToChannel(
    channelAddress: PublicKey,
    amount: UInt64,
    depositor: PublicKey,
    expectedDepositTotalAfter: Field
  ): Promise<void> {
    const tokenId = this.deriveTokenId();

    // ---- bind to the channel: OPEN now, and the post-deposit total ----
    // One channel AccountUpdate carries both preconditions. It is a read-only
    // (zero balance change) native-token update over the channel zkApp account.
    // The depositTotal precondition is evaluated against the channel's state at
    // the point this AU is applied; because the channel's `deposit` accounting AU
    // (the caller's sibling `channel.deposit`) applies first in the same tx, this
    // pins the ESCROWED amount to the ACCOUNTED total — escrow can't desync.
    const channelAu = AccountUpdate.create(channelAddress);
    requireChannelState(channelAu, CHANNEL_STATE_SLOT.channelState, CHANNEL_STATE.OPEN);
    requireChannelState(channelAu, CHANNEL_STATE_SLOT.depositTotal, expectedDepositTotalAfter);
    this.approve(channelAu);

    // ---- depositor → escrow, owner-authored, depositor SIGNS the debit ----
    // The depositor's token account has DEFAULT permissions, so its outflow needs
    // a signature; the depositor signs the tx. The escrow CREDIT is owner-proof
    // authorized (lazy-none) and rides on the already-custodial escrow account.
    const debitAu = AccountUpdate.create(depositor, tokenId);
    debitAu.balanceChange = Int64.from(amount).neg();
    debitAu.body.useFullCommitment = Bool(true);
    debitAu.requireSignature(); // depositor authorizes the outflow
    this.approve(debitAu);

    const creditAu = AccountUpdate.create(channelAddress, tokenId);
    creditAu.balanceChange = Int64.from(amount);
    setLazyNone(creditAu);
    this.approve(creditAu);
  }

  /**
   * Settle `channelAddress` after its challenge period: pay `balanceB` to
   * `participantB` and `balanceA` to `participantA` out of the escrow, FORCED
   * equal to the channel's committed balances by the proof.
   *
   * Composition (same `Mina.transaction`): the caller ALSO invokes
   * `channel.settle(balanceA, balanceB, salt, A, B, nonce)` (the channel's
   * CLOSING→SETTLED accounting transition). The channel key is NOT needed — the
   * escrow moves are authorized purely by THIS owner's proof + the escrow's
   * custodial `send: none` permission (set at first deposit).
   *
   * Enforcement (each wired as a manual account precondition on the channel's
   * on-chain @state, so the LEDGER rejects any mismatch at tx-apply time — even
   * with a valid proof):
   *   - `channelState == CLOSING (2)`        — slot 3
   *   - `balanceCommitment == Poseidon(balanceA, balanceB, salt)` — slot 1
   *   - `depositTotal == balanceA + balanceB` (conservation)      — slot 4
   *   - `channelHash == Poseidon(A.x, B.x, nonce)` (participants) — slot 0
   *   - challenge elapsed: `currentSlot >= closedAtSlot + settlementTimeout`,
   *     enforced via a NETWORK `globalSlotSinceGenesis` lower-bound precondition
   *     computed from the channel's on-chain `closedAtSlot`/`settlementTimeout`
   *     (which are themselves pinned by slot-5/slot-6 preconditions, so the
   *     deadline cannot be forged).
   *
   * Double-settle guard: the `channelState == CLOSING` precondition + the channel
   * transitioning to SETTLED in this same tx (via `channel.settle`) means a second
   * settle finds `channelState == SETTLED`, fails its CLOSING precondition, and
   * reverts. Confirmed by the `double settle` test.
   *
   * Payouts use the custodial lazy-none debit and SKIP zero amounts (a
   * zero-balance payout would be a wasted/needless AccountUpdate + new-account
   * fee). Because conservation is pinned, the two non-zero payouts together drain
   * EXACTLY the escrow.
   *
   * @param channelAddress - the `PaymentChannel` zkApp address (escrow = its
   *   token account)
   * @param balanceA - participant A's committed balance (refund)
   * @param balanceB - participant B's committed balance (payout)
   * @param salt - the balance-commitment salt
   * @param participantA - participant A's public key
   * @param participantB - participant B's public key
   * @param nonce - the channel nonce (binds `channelHash`)
   * @param closedAtSlot - the channel's on-chain `closedAtSlot` (pinned via a
   *   slot-5 precondition, so the deadline cannot be forged)
   * @param settlementTimeout - the channel's on-chain `settlementTimeout` (pinned
   *   via a slot-6 precondition)
   */
  @method async settleFromChannel(
    channelAddress: PublicKey,
    balanceA: UInt64,
    balanceB: UInt64,
    salt: Field,
    participantA: PublicKey,
    participantB: PublicKey,
    nonce: Field,
    closedAtSlot: UInt32,
    settlementTimeout: UInt32
  ): Promise<void> {
    const tokenId = this.deriveTokenId();

    // ---- bind to the channel's ON-CHAIN pre-settle state ----
    const channelAu = AccountUpdate.create(channelAddress);

    // state[3] channelState == CLOSING (also the double-settle guard).
    requireChannelState(channelAu, CHANNEL_STATE_SLOT.channelState, CHANNEL_STATE.CLOSING);

    // state[1] balanceCommitment == Poseidon(balanceA, balanceB, salt). Forces the
    // revealed balances (hence the payouts below) to match the channel's commit.
    const commitment = Poseidon.hash([balanceA.value, balanceB.value, salt]);
    requireChannelState(channelAu, CHANNEL_STATE_SLOT.balanceCommitment, commitment);

    // state[4] depositTotal == balanceA + balanceB (conservation). The two payouts
    // therefore drain EXACTLY the escrow — no over/under distribution.
    const total = balanceA.add(balanceB);
    requireChannelState(channelAu, CHANNEL_STATE_SLOT.depositTotal, total.value);

    // state[0] channelHash == Poseidon(A.x, B.x, nonce) (participant binding).
    const channelHash = Poseidon.hash([participantA.x, participantB.x, nonce]);
    requireChannelState(channelAu, CHANNEL_STATE_SLOT.channelHash, channelHash);

    // Pin closedAtSlot (state[5]) + settlementTimeout (state[6]) to the witness
    // values, so the deadline we compute from them is the channel's REAL deadline
    // (un-forgeable: a caller passing the wrong closedAtSlot/timeout fails the
    // slot-5/slot-6 precondition). Then require the network global slot to be >=
    // that deadline.
    requireChannelState(channelAu, CHANNEL_STATE_SLOT.closedAtSlot, closedAtSlot.value);
    requireChannelState(channelAu, CHANNEL_STATE_SLOT.settlementTimeout, settlementTimeout.value);
    // deadline = closedAtSlot + settlementTimeout (UInt32 add range-checks the sum
    // and forbids overflow past 2^32 - 1).
    const deadline = closedAtSlot.add(settlementTimeout);
    // NETWORK precondition: globalSlotSinceGenesis in [deadline, MAXINT]. The
    // ledger rejects a settle submitted before the challenge period elapses.
    this.network.globalSlotSinceGenesis.requireBetween(deadline, UInt32.MAXINT());

    this.approve(channelAu);

    // ---- author the escrow payouts (owner proof alone; skip zeros) ----
    // Custodial escrow (`send: none`): each debit is a manually-built lazy-none
    // sender AU. `createIf` skips the AccountUpdate entirely when the balance is
    // zero, so a zero payout costs nothing and needs no recipient account.
    this.payOut(channelAddress, participantB, balanceB, tokenId);
    this.payOut(channelAddress, participantA, balanceA, tokenId);
  }

  /**
   * Author one escrow→recipient payout of `amount`, authorized by the owner's
   * proof alone (custodial `send: none` escrow, lazy-none sender). SKIPPED when
   * `amount == 0` via `createIf`, so zero-balance payouts emit no AccountUpdate
   * and need no recipient token account.
   */
  private payOut(escrow: PublicKey, recipient: PublicKey, amount: UInt64, tokenId: Field): void {
    const nonZero = amount.greaterThan(UInt64.zero);

    const senderAu = AccountUpdate.createIf(nonZero, escrow, tokenId);
    senderAu.balanceChange = Int64.from(amount).neg();
    senderAu.body.useFullCommitment = Bool(true);
    setLazyNone(senderAu);
    this.approve(senderAu);

    const receiverAu = AccountUpdate.createIf(nonZero, recipient, tokenId);
    receiverAu.balanceChange = Int64.from(amount);
    this.approve(receiverAu);
  }
}
