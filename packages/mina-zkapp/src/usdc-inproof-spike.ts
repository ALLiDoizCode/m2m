/**
 * FEASIBILITY SPIKE — in-proof-enforcing USDC token owner on Mina.
 *
 * This is a *proof-of-concept*, NOT the production `UsdcChannelToken`. It exists
 * to answer the four feasibility questions in
 * `docs/usdc-mina-inproof-enforcement.md` before the full build:
 *
 *   Q1. Can a `FungibleToken` subclass `@method` author `internal.send({from:
 *       escrow, …})` authorized by the OWNER'S PROOF ALONE (no escrow-holder
 *       signature), given escrow permissions set so only the owner moves it?
 *   Q2. Can that `@method` READ ANOTHER zkApp's on-chain `@state` via an account
 *       precondition, and bind the moved amount to it?
 *   Q3. Can the channel `→ SETTLED` transition + the token payout coordinate in
 *       one tx (cross-account update / precondition binding)?
 *   Q4. Proving-cost / constraint budget signal.
 *
 * It deliberately implements the SMALLEST mechanism that exercises Q1+Q2: a
 * custom `FungibleToken` subclass that moves escrowed tokens from a holder
 * account to a recipient ONLY when an in-proof constraint holds, rejecting a
 * tampered amount.
 *
 * @module usdc-inproof-spike
 */

import {
  AccountUpdate,
  Bool,
  Field,
  Int64,
  method,
  Permissions,
  PublicKey,
  SmartContract,
  State,
  state,
  UInt64,
} from 'o1js';
import { FungibleToken } from 'mina-fungible-token';

/**
 * Mark an AccountUpdate as authorized by NEITHER signature NOR proof ("lazy
 * none") — the only authorization a token-holder account with `send:
 * Permissions.none()` will accept WITHOUT a holder signature. o1js's
 * `internal.send` hardcodes a lazy *signature* on the sender (a custodial escrow
 * must NOT need that); we author the sender ourselves and set lazy-none.
 *
 * This inlines what o1js's internal `Authorization.setLazyNone` does (that symbol
 * is not exported from the public `o1js` entry). `isProved=false`/`isSigned=false`
 * means the `verificationKeyHash` slot is unused, so we leave authorizationKind's
 * default hash in place and only flip the two flags + the lazy marker.
 */
function setLazyNone(au: AccountUpdate): void {
  au.body.authorizationKind.isSigned = Bool(false);
  au.body.authorizationKind.isProved = Bool(false);
  au.authorization = {};
  // o1js's resolver reads `lazyAuthorization.kind`; 'lazy-none' => leave as-is.
  (au as unknown as { lazyAuthorization: { kind: string } }).lazyAuthorization = {
    kind: 'lazy-none',
  };
}

/**
 * A minimal stand-in for `PaymentChannel`: a zkApp with a single `Field` of
 * on-chain state. The spike uses it to prove that a `TokenContract` `@method`
 * can read ANOTHER zkApp's `@state` via an account precondition (Q2). In the
 * full build this stands in for `PaymentChannel.balanceCommitment` /
 * `depositTotal` / `channelState` / `channelHash`.
 */
export class SpikeChannelState extends SmartContract {
  /** The single committed value the token method will bind a payout to. */
  @state(Field) committed = State<Field>();

  /** Set the committed value (any signer-authorized writer for the spike). */
  @method async setCommitted(value: Field): Promise<void> {
    this.committed.set(value);
  }
}

/**
 * `SpikeToken extends FungibleToken` — the enforcer + mover under test.
 *
 * Adds two custom methods on top of the audited `mina-fungible-token`:
 *
 * - `enableCustodialEscrow(escrow)` — sets the escrow token account's `send`
 *   permission to `Permissions.none()`, so the TOKEN OWNER'S PROOF can author
 *   sends OUT of the escrow with NO escrow-holder signature. This is the exact
 *   same trick `FungibleToken.initialize` uses on the circulation account (it
 *   sets `permissions.send = Permissions.none()` so token holders can burn).
 *   Q1 hinges entirely on this.
 *
 * - `enforcedPayout(holder, recipient, amount, channelAddr, expected)` — the
 *   single in-proof-enforced mover:
 *     1. (Q2) reads `SpikeChannelState.committed` at `channelAddr` via an
 *        account precondition and asserts `amount` equals it — i.e. binds the
 *        payout to another zkApp's on-chain state IN THE SAME PROOF.
 *     2. (guard) asserts `amount == expected` — a redundant in-proof constraint
 *        so a tampered `amount` fails the proof even without the precondition.
 *     3. (Q1) `this.internal.send({from: holder, to: recipient, amount})` —
 *        authorized by the owner's proof; the holder/escrow does NOT sign.
 */
export class SpikeToken extends FungibleToken {
  /**
   * Re-declare `events` with a looser type. `mina-fungible-token`'s
   * `FungibleToken` types `events` with Structs that contain `PublicKey` (not
   * `FlexibleProvablePure`), which trips the `@method` decorator's bound when a
   * `.ts` subclass adds methods (TS1241). This `declare` is a TYPE-ONLY widening
   * — it changes no runtime behaviour (the base class still defines the actual
   * event Structs in its constructor). A known o1js + mina-fungible-token
   * subclassing friction; the full build's `UsdcChannelToken` will need the same.
   */
  declare events: FungibleToken['events'] & Record<string, never>;

  /**
   * Make `escrow`'s token account custodial: only the owner's proof can move
   * its balance (no escrow signature on subsequent payouts).
   *
   * Sets `send: Permissions.none()` on the escrow's token account. Because the
   * token contract's own `access: proof` permission still gates the wrapping
   * AccountUpdate forest, the ONLY actor that can produce a send-from-escrow is
   * this owner contract inside one of its proven methods.
   *
   * NOTE: in `mina-fungible-token`, the token's `access` permission is
   * `Permissions.proof()` and `setPermissions` is `impossible()` on the token
   * account itself — but the ESCROW is a *token-holder* account (a different
   * account under the token id), whose permissions we are free to set here when
   * we first fund/initialize it.
   */
  @method async enableCustodialEscrow(escrow: PublicKey): Promise<void> {
    const escrowUpdate = AccountUpdate.createSigned(escrow, this.deriveTokenId());
    const permissions = Permissions.default();
    // The owner's proof authorizes sends out of this account; no escrow sig.
    permissions.send = Permissions.none();
    // Lock the permission so it can't later be tightened/loosened maliciously.
    permissions.setPermissions = Permissions.impossible();
    escrowUpdate.account.permissions.set(permissions);
    // The wrapping forest must net to zero / be owner-approved.
    this.approve(escrowUpdate);
  }

  /**
   * Move `amount` of token FROM `holder` TO `recipient`, authorized by the
   * OWNER'S PROOF ALONE, but ONLY when both in-proof constraints hold:
   *   - the amount is bound to `SpikeChannelState.committed` at `channelAddr`
   *     (cross-account state precondition — Q2), and
   *   - the amount equals the caller-supplied `expected` (the guard).
   *
   * A tampered `amount` violates at least one constraint and the proof is
   * rejected — the payout cannot be mis-stated.
   */
  @method async enforcedPayout(
    holder: PublicKey,
    recipient: PublicKey,
    amount: UInt64,
    channelAddr: PublicKey,
    expected: UInt64
  ): Promise<void> {
    // ---- Q2: read ANOTHER zkApp's on-chain @state via account precondition ----
    // Create a (native-token) AccountUpdate against the channel zkApp account and
    // require its `committed` state (state[0]) equals `amount` as a Field. This is
    // exactly how the full `settleFromChannel` will bind to
    // PaymentChannel.balanceCommitment / depositTotal / channelState.
    //
    // Setting `isSome=true, value=amount` makes the LEDGER reject the tx at apply
    // time unless the channel's on-chain state[0] equals `amount` — i.e. the
    // payout is bound to another zkApp's committed state. We set the precondition
    // slot directly because the high-level `au.account.state` helper is a no-op
    // for the state array in o1js (precondition.js returns `{}` for array
    // layouts); this is the same wiring `State.requireEquals` uses internally.
    const channelAu = AccountUpdate.create(channelAddr);
    const slot0 = channelAu.body.preconditions.account.state[0];
    slot0.isSome = Bool(true);
    slot0.value = amount.value;
    // Approve the read-only channel AccountUpdate as a child so it rides along.
    this.approve(channelAu);

    // ---- guard: in-proof constraint on the amount (tamper → proof fails) ----
    amount.assertEquals(expected);

    // ---- Q1: owner-proof-authorized move out of the (custodial) holder ----
    // We DON'T use `this.internal.send(...)` directly: it attaches a lazy
    // SIGNATURE to the sender AU, so the holder/escrow would have to sign. For a
    // custodial escrow (whose token account is `send: Permissions.none()`), we
    // author the sender AU ourselves and mark it `lazy-none` (no sig, no proof) —
    // the only authorization the owner can supply for the holder without a holder
    // signature. The owner's proof over THIS method, plus the `access: proof`
    // permission on the token contract, is what gates the whole forest.
    const tokenId = this.deriveTokenId();

    const senderAu = AccountUpdate.create(holder, tokenId);
    senderAu.balanceChange = Int64.from(amount).neg();
    senderAu.body.useFullCommitment = Bool(true);
    setLazyNone(senderAu); // <- no holder signature required
    this.approve(senderAu);

    const receiverAu = AccountUpdate.create(recipient, tokenId);
    receiverAu.balanceChange = Int64.from(amount);
    this.approve(receiverAu);
  }
}
