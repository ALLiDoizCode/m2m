/**
 * `RateLimitedUsdcAdmin` — permissionless, per-address-per-day rate-limited
 * mint authority for the mock-USDC `FungibleToken` on Mina devnet.
 *
 * The stock `FungibleTokenAdmin.canMint` demands the admin authority's
 * SIGNATURE on every mint — a mint monopoly. For a shared devnet token we want
 * the opposite: ANY address can mint mock USDC to itself, but only up to a
 * fixed cap per address per ~day, enforced IN THE PROOF + LEDGER (not by an
 * off-chain faucet service). The admin authority keeps ONLY pause/resume,
 * admin-change and verification-key (upgrade) rights — it is NOT needed for
 * minting.
 *
 * ── Design: per-address "mint receipt" accounts under the admin's token id ──
 * `canMint(accountUpdate)` (the fixed `FungibleTokenAdminBase` interface — the
 * token passes the recipient's mint AccountUpdate) reads the recipient +
 * amount off the mint AU and maintains a RECEIPT account at
 * `(recipient, this.deriveTokenId())`:
 *
 *   state[0] = windowStart     — globalSlotSinceGenesis of the first mint in
 *                                the current window (UInt32)
 *   state[1] = mintedInWindow  — USDC base units minted to this address since
 *                                windowStart (UInt64)
 *
 * Window semantics (fixed window anchored at first mint, ≈ rolling day):
 *   - if `currentSlot >= windowStart + MINT_WINDOW_SLOTS` the window has
 *     expired → it resets (`windowStart := currentSlot`, `mintedInWindow := 0`)
 *   - `mintedInWindow + amount <= DAILY_MINT_CAP` must hold, plus the
 *     `PER_MINT_CAP` backstop on the single amount.
 *
 * A fresh address has no receipt account; Mina evaluates account-state
 * preconditions on a nonexistent account against all-zero state, so the first
 * mint proves against `(0, 0)` and CREATES the receipt (the tx funds its
 * 1-MINA new-account fee via `AccountUpdate.fundNewAccount`).
 *
 * ── Why the receipt state is unforgeable ─────────────────────────────────────
 * 1. The receipt lives under the ADMIN CONTRACT's derived token id. The Mina
 *    token rules require every AU under that token id to be parented by an AU
 *    of the admin contract, and the admin account's `access` permission is set
 *    to `proof()` — so the ONLY way to touch a receipt is through one of this
 *    contract's proven methods. (Same mechanism `FungibleToken` itself relies
 *    on: `access: proof` + token-owner approval.)
 * 2. Inside `canMint` the old state is pinned with account-state PRECONDITIONS
 *    (`state[i] == witnessed old value`), so the LEDGER — not just the proof —
 *    rejects any mint built against stale/false receipt state at application
 *    time. A second same-window mint proved against the pre-mint state fails
 *    ON-CHAIN with an app-state precondition failure.
 * 3. The receipt AU requires the RECIPIENT's signature (full-commitment,
 *    replay-safe). Side effects: (a) only `recipient` (its key holder) can
 *    mint to `recipient` — nobody can burn a stranger's daily allowance by
 *    dust-minting at them; (b) the recipient's key must sign the mint tx.
 *
 * Slot arithmetic: Mina slots are 3 minutes; `MINT_WINDOW_SLOTS = 480` ≈ 24 h.
 * The current slot is the prover's witnessed network slot, anchored by a
 * network precondition `globalSlotSinceGenesis ∈ [claimed, claimed +
 * MINT_SLOT_TOLERANCE]` (the #202 slot-drift pattern from `PaymentChannel`),
 * so the claimed slot can be at most `MINT_SLOT_TOLERANCE` slots stale — an
 * address can start its next window at most ~1 h early, but can never mint
 * above the cap inside a window.
 *
 * @module usdc-rate-limited-admin
 */

import {
  AccountUpdate,
  assert,
  Bool,
  Field,
  method,
  Mina,
  Permissions,
  Provable,
  PublicKey,
  SmartContract,
  State,
  state,
  Struct,
  TokenId,
  UInt32,
  UInt64,
  VerificationKey,
} from 'o1js';
import type { FungibleTokenAdminBase, FungibleTokenAdminDeployProps } from 'mina-fungible-token';

import { ONE_USDC } from './usdc-token';

/** Cap on total mints per address per window, in whole USDC. */
export const DAILY_MINT_CAP_USDC = 1_000n;
/** Hard backstop cap on a single mint, in whole USDC. */
export const PER_MINT_CAP_USDC = 1_000n;
/** `DAILY_MINT_CAP_USDC` in 6-decimal base units, as the circuit constant. */
export const DAILY_MINT_CAP = UInt64.from(DAILY_MINT_CAP_USDC * ONE_USDC);
/** `PER_MINT_CAP_USDC` in 6-decimal base units, as the circuit constant. */
export const PER_MINT_CAP = UInt64.from(PER_MINT_CAP_USDC * ONE_USDC);

/** Mint window length in global slots — 480 slots × 3 min ≈ 24 h. */
export const MINT_WINDOW_SLOTS = UInt32.from(480);
/**
 * Allowed staleness of the witnessed "current" slot (network-precondition
 * range width) — 20 slots ≈ 1 h: a mint proof stays submittable for ~1 h, and
 * a malicious prover can predate a window start by at most this much.
 */
export const MINT_SLOT_TOLERANCE = UInt32.from(20);

/** Receipt account @state slot indices (exported so tests/tools can read them). */
export const RECEIPT_STATE_SLOT = {
  windowStart: 0,
  mintedInWindow: 1,
} as const;

/** Assertion messages surfaced by the rate-limit circuit. */
export const RATE_LIMIT_ASSERT = {
  NEGATIVE_MINT: 'mint amount must be non-negative',
  PER_MINT_CAP_EXCEEDED: 'mint exceeds the per-mint cap',
  DAILY_CAP_EXCEEDED: 'mint exceeds the per-address daily mint cap',
} as const;

/** The witnessed prior contents of a recipient's mint-receipt account. */
export class MintReceipt extends Struct({
  windowStart: UInt32,
  mintedInWindow: UInt64,
}) {}

/**
 * Read the recipient's receipt account off the (local or cached-network)
 * ledger — PROVER-ONLY helper for the `Provable.witness` in `canMint`. A
 * missing account (first mint) reads as zeros, matching how the ledger
 * evaluates preconditions on nonexistent accounts.
 *
 * On `Mina.Network`, `Mina.getAccount` participates in o1js's two-pass tx
 * construction: the first ("test") pass marks `(recipient, tokenId)` to be
 * fetched, o1js fetches it, and the second ("cached") pass + `tx.prove()` read
 * the cached account.
 */
function readMintReceipt(recipient: PublicKey, tokenId: Field): MintReceipt {
  try {
    const account = Mina.getAccount(recipient, tokenId);
    const appState = account.zkapp?.appState;
    return new MintReceipt({
      windowStart: UInt32.from((appState?.[RECEIPT_STATE_SLOT.windowStart] ?? Field(0)).toBigInt()),
      mintedInWindow: UInt64.from(
        (appState?.[RECEIPT_STATE_SLOT.mintedInWindow] ?? Field(0)).toBigInt()
      ),
    });
  } catch {
    // Account does not exist yet (or, on Network, was reported missing by the
    // fetch layer) — the ledger checks preconditions against zeroed state.
    return new MintReceipt({ windowStart: UInt32.zero, mintedInWindow: UInt64.zero });
  }
}

/**
 * Pin one @state slot of the receipt AU as an account PRECONDITION. The
 * high-level `au.account.state` helper is a no-op for the state array in o1js
 * (documented in usdc-channel-token.ts), so the slot is set directly — the
 * ledger then rejects the tx at apply time unless the on-chain slot equals
 * `expected`, even if the proof verifies.
 */
function requireReceiptState(receiptAu: AccountUpdate, slot: number, expected: Field): void {
  const pre = receiptAu.body.preconditions.account.state[slot];
  pre.isSome = Bool(true);
  pre.value = expected;
}

/** Write one @state slot of the receipt AU (the post-mint receipt contents). */
function setReceiptState(receiptAu: AccountUpdate, slot: number, value: Field): void {
  const update = receiptAu.body.update.appState[slot];
  update.isSome = Bool(true);
  update.value = value;
}

/**
 * The rate-limited mint authority. Drop-in `FungibleToken.AdminContract`
 * implementation: deploys with the same `{ adminPublicKey }` props as the
 * stock `FungibleTokenAdmin`; only `canMint` differs (permissionless +
 * rate-limited instead of admin-signed).
 */
export class RateLimitedUsdcAdmin extends SmartContract implements FungibleTokenAdminBase {
  /** Pause/upgrade authority — NOT a mint authority. */
  @state(PublicKey)
  private adminPublicKey = State<PublicKey>();

  /**
   * The token id the mint-receipt accounts live under (`SmartContract`, unlike
   * `TokenContract`, does not ship this helper).
   */
  deriveTokenId(): Field {
    return TokenId.derive(this.address, this.tokenId);
  }

  async deploy(props: FungibleTokenAdminDeployProps): Promise<void> {
    await super.deploy(props);
    this.adminPublicKey.set(props.adminPublicKey);
    this.account.permissions.set({
      ...Permissions.default(),
      // Receipt-forgery guard: every AU under this contract's token id needs a
      // PROVEN admin-contract AU as its token-owner parent (see module docs).
      access: Permissions.proof(),
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
    });
  }

  /** Same escape hatch as the stock admin (usable only after a protocol upgrade). */
  @method
  async updateVerificationKey(vk: VerificationKey): Promise<void> {
    this.account.verificationKey.set(vk);
  }

  /** Require the pause/upgrade authority's signature (stock-admin pattern). */
  private async ensureAdminSignature(): Promise<AccountUpdate> {
    const admin = await Provable.witnessAsync(PublicKey, async () => {
      const pk = await this.adminPublicKey.fetch();
      assert(pk !== undefined, 'could not fetch admin public key');
      return pk;
    });
    this.adminPublicKey.requireEquals(admin);
    return AccountUpdate.createSigned(admin);
  }

  /**
   * Permissionless, rate-limited mint gate — NO admin signature.
   *
   * `accountUpdate` is the recipient's mint AU built by `FungibleToken.mint`
   * (`publicKey` = recipient, `balanceChange` = +amount); its fields are bound
   * into this proof via the token→admin call data.
   */
  @method.returns(Bool)
  public async canMint(accountUpdate: AccountUpdate): Promise<Bool> {
    const recipient = accountUpdate.body.publicKey;
    const balanceChange = accountUpdate.body.balanceChange;
    // A mint AU's balance change is non-negative by construction; forbid a
    // hostile direct call from recording a "negative mint" on a receipt.
    balanceChange.isNonNegative().assertTrue(RATE_LIMIT_ASSERT.NEGATIVE_MINT);
    const amount = balanceChange.magnitude;

    // Hard per-tx backstop.
    amount.assertLessThanOrEqual(PER_MINT_CAP, RATE_LIMIT_ASSERT.PER_MINT_CAP_EXCEEDED);

    // Witness the current global slot; anchor it with a range precondition so
    // it is at most MINT_SLOT_TOLERANCE slots stale at application time
    // (PaymentChannel's #202 slot-drift pattern).
    const claimedSlot = this.network.globalSlotSinceGenesis.get();
    this.network.globalSlotSinceGenesis.requireBetween(
      claimedSlot,
      claimedSlot.add(MINT_SLOT_TOLERANCE)
    );

    // Witness the prior receipt (zeros for a fresh address) …
    const tokenId = this.deriveTokenId();
    const prior = Provable.witness(MintReceipt, () => readMintReceipt(recipient, tokenId));

    // … and compute the windowed accounting.
    const windowExpired = claimedSlot.greaterThanOrEqual(prior.windowStart.add(MINT_WINDOW_SLOTS));
    const windowStart = Provable.if(windowExpired, UInt32, claimedSlot, prior.windowStart);
    const alreadyMinted = Provable.if(windowExpired, UInt64, UInt64.zero, prior.mintedInWindow);
    const mintedInWindow = alreadyMinted.add(amount);
    mintedInWindow.assertLessThanOrEqual(DAILY_MINT_CAP, RATE_LIMIT_ASSERT.DAILY_CAP_EXCEEDED);

    // Receipt AU: pin the witnessed prior state as LEDGER preconditions and
    // write the new state. The recipient signs (full commitment — replay-safe
    // without a nonce precondition, so the only stale-state failure mode is
    // the app-state precondition itself).
    const receiptAu = AccountUpdate.createSigned(recipient, tokenId);
    receiptAu.body.useFullCommitment = Bool(true);
    receiptAu.body.incrementNonce = Bool(false);
    // Clear the nonce precondition `requireSignature()` added (full-commitment
    // signing replaces it for replay protection). A cleared ("None") option
    // must carry its DEFAULT value — the ledger recomputes the commitment from
    // JSON (where None serializes without the value), so a leftover non-default
    // value would desync the signed commitment from the applied one.
    const noncePrecondition = receiptAu.body.preconditions.account.nonce;
    noncePrecondition.isSome = Bool(false);
    noncePrecondition.value.lower = UInt32.zero;
    noncePrecondition.value.upper = UInt32.MAXINT();
    requireReceiptState(receiptAu, RECEIPT_STATE_SLOT.windowStart, prior.windowStart.value);
    requireReceiptState(receiptAu, RECEIPT_STATE_SLOT.mintedInWindow, prior.mintedInWindow.value);
    setReceiptState(receiptAu, RECEIPT_STATE_SLOT.windowStart, windowStart.value);
    setReceiptState(receiptAu, RECEIPT_STATE_SLOT.mintedInWindow, mintedInWindow.value);

    return Bool(true);
  }

  @method.returns(Bool)
  public async canChangeAdmin(_admin: PublicKey): Promise<Bool> {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  @method.returns(Bool)
  public async canPause(): Promise<Bool> {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  @method.returns(Bool)
  public async canResume(): Promise<Bool> {
    await this.ensureAdminSignature();
    return Bool(true);
  }

  @method.returns(Bool)
  public async canChangeVerificationKey(_vk: VerificationKey): Promise<Bool> {
    await this.ensureAdminSignature();
    return Bool(true);
  }
}
