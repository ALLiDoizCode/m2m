/**
 * `PermissionlessRateLimitedUsdcAdmin` — FULLY permissionless, per-recipient-
 * per-day rate-limited mint authority for the mock-USDC `FungibleToken` on Mina
 * devnet.
 *
 * This SUPERSEDES `RateLimitedUsdcAdmin` (usdc-rate-limited-admin.ts). Both keep
 * the same public policy — ANY fee payer can mint mock USDC, capped at
 * `DAILY_MINT_CAP_USDC` per recipient per ~24 h window, enforced IN THE PROOF +
 * LEDGER — and the admin authority keeps ONLY pause/resume, admin-change and
 * verification-key (upgrade) rights (it NEVER mints). The difference is the one
 * the product needs:
 *
 *   RateLimitedUsdcAdmin  — the RECIPIENT had to SIGN every mint (its receipt
 *                           AU required the recipient's signature). A mint could
 *                           only be sent to an address whose key was on hand.
 *   PermissionlessRateLimitedUsdcAdmin (THIS)
 *                         — the recipient NEVER signs. Any fee payer mints to
 *                           ANY address; the receipt AU is authorized by the
 *                           admin's `canMint` PROOF ALONE. This is what lets (a)
 *                           a webpage mint to a typed-in address a connected
 *                           wallet does not control, and (b) a third-party /
 *                           on-chain caller mint to an arbitrary address.
 *
 * ACCEPTED TRADE-OFF (devnet, zero real value): because nobody proves control of
 * the recipient, a griefer can burn an address's daily quota by minting junk USDC
 * at it. Harmless here — the tokens are mock and the cap self-heals each window.
 *
 * ── Why the receipt is a packed BALANCE, not @state ──────────────────────────
 * `RateLimitedUsdcAdmin` stored `(windowStart, mintedInWindow)` in the receipt
 * account's zkApp @state. Editing zkApp @state is governed by the receipt
 * account's `editState` permission, which on a freshly-created account is
 * `signature` — i.e. the RECIPIENT's signature. There is no way to set that
 * account's permissions to `none` without, again, the recipient's signature
 * (setting permissions on a fresh account needs the account's own signature).
 * So a recipient-keyed @state receipt CANNOT be maintained without the recipient
 * signing — the exact requirement we are removing. (Empirically confirmed on
 * LocalBlockchain: an owner-proof, signature-less @state edit fails with
 * `Update_not_permitted_app_state`.)
 *
 * The ONE thing a token owner's proof CAN do to a fresh recipient-keyed token
 * account with NO recipient signature is INCREASE its balance — the default
 * `receive` permission is `none`. (A DECREASE needs `send` = the recipient's
 * signature; a state edit needs `editState` = the recipient's signature.) So the
 * receipt keeps its `(windowStart, mintedInWindow)` counter PACKED into the
 * receipt account's BALANCE under the admin's token id:
 *
 *   receiptBalance = windowStart * 2^32 + mintedInWindow
 *
 * with `mintedInWindow < 2^32` (the daily cap, 1e9 base units, is < 2^30) and
 * `windowStart` a UInt32 network slot. This packing is MONOTONICALLY INCREASING:
 *   - a same-window top-up raises `mintedInWindow` (low bits) → balance up;
 *   - a window reset raises `windowStart` by ≥ 480 (high bits), and since
 *     `mintedInWindow < 2^32`, the high-bit jump (≥ 480·2^32) dominates the
 *     low-bit reset → balance still strictly up.
 * So every mint is a pure balance INCREASE (delta = newPacked − oldPacked ≥ 0),
 * authorized by the admin's proof alone. The counter is never decreased, so no
 * recipient `send` authorization is ever needed.
 *
 * ── Why the receipt is unforgeable / non-stale ───────────────────────────────
 * 1. The receipt lives under the ADMIN CONTRACT's derived token id, and the
 *    admin account's `access` permission is `proof()` — so the ONLY way to touch
 *    a receipt is through one of this contract's proven methods (`canMint`). A
 *    stray signature-authorized AU under this token id is rejected (same guard
 *    `FungibleToken` uses: `access: proof` + token-owner approval). The recipient
 *    themselves cannot lower their own counter: a decrease needs BOTH their
 *    signature AND an admin proof authoring it, and no admin method does.
 * 2. `canMint` pins the witnessed prior balance as an account BALANCE
 *    PRECONDITION (`receiptAu.account.balance.requireEquals(oldPacked)`), so the
 *    LEDGER — not just the proof — rejects any mint built against a stale receipt
 *    balance at application time. A second same-window mint proved against the
 *    pre-mint balance fails ON-CHAIN with a balance-precondition failure.
 *
 * Slot arithmetic is identical to `RateLimitedUsdcAdmin` (480-slot ≈ 24 h window;
 * the current slot is anchored by a `globalSlotSinceGenesis ∈ [claimed, claimed +
 * MINT_SLOT_TOLERANCE]` network precondition — the #202 slot-drift pattern).
 *
 * @module usdc-permissionless-admin
 */

import {
  AccountUpdate,
  assert,
  Bool,
  Field,
  Int64,
  method,
  Mina,
  Permissions,
  Provable,
  PublicKey,
  SmartContract,
  State,
  state,
  TokenId,
  UInt32,
  UInt64,
  VerificationKey,
} from 'o1js';
import type { FungibleTokenAdminBase, FungibleTokenAdminDeployProps } from 'mina-fungible-token';

// Policy constants + assertion messages + the MintReceipt shape are shared with
// the recipient-signed flavor — only the receipt STORAGE mechanism differs here.
import {
  DAILY_MINT_CAP,
  MINT_SLOT_TOLERANCE,
  MINT_WINDOW_SLOTS,
  MintReceipt,
  PER_MINT_CAP,
  RATE_LIMIT_ASSERT,
} from './usdc-rate-limited-admin';

export {
  DAILY_MINT_CAP,
  DAILY_MINT_CAP_USDC,
  MINT_SLOT_TOLERANCE,
  MINT_WINDOW_SLOTS,
  MintReceipt,
  PER_MINT_CAP,
  PER_MINT_CAP_USDC,
  RATE_LIMIT_ASSERT,
} from './usdc-rate-limited-admin';

/**
 * Bit width the receipt packs `windowStart` above `mintedInWindow`
 * (`packed = windowStart * 2^SHIFT_BITS + mintedInWindow`). 32 bits leaves room
 * for `mintedInWindow` up to 2^32−1 base units (the daily cap, 1e9, is < 2^30)
 * and holds `windowStart` (a UInt32 slot) — the pack stays well under 2^64 for
 * millennia of slots.
 */
export const RECEIPT_SHIFT_BITS = 32n;
/** `2^RECEIPT_SHIFT_BITS` — the windowStart multiplier / mintedInWindow modulus. */
export const RECEIPT_SHIFT = 1n << RECEIPT_SHIFT_BITS;
const RECEIPT_SHIFT_U64 = UInt64.from(RECEIPT_SHIFT);

/** Assertion message for an invalid witnessed receipt-balance decomposition. */
export const RECEIPT_DECODE_ASSERT = 'receipt mintedInWindow out of packed range';

/**
 * Decode a receipt account's packed balance into its `(windowStart,
 * mintedInWindow)` fields — the inverse of the in-circuit pack. Exported so
 * tests + tools (which read the receipt balance off the ledger / GraphQL) share
 * one decoder. A zero / missing balance decodes to `(0, 0)`.
 */
export function decodeReceiptBalance(packed: bigint): {
  windowStart: bigint;
  mintedInWindow: bigint;
} {
  return {
    windowStart: packed >> RECEIPT_SHIFT_BITS,
    mintedInWindow: packed & (RECEIPT_SHIFT - 1n),
  };
}

/** Pack `(windowStart, mintedInWindow)` into the receipt balance (inverse of decode). */
export function encodeReceiptBalance(windowStart: bigint, mintedInWindow: bigint): bigint {
  return windowStart * RECEIPT_SHIFT + mintedInWindow;
}

/**
 * Read the recipient's receipt-account BALANCE off the (local or cached-network)
 * ledger — PROVER-ONLY helper for the `Provable.witness` in `canMint`. A missing
 * account (first mint) reads as 0, matching how the ledger evaluates a balance
 * precondition on a nonexistent account (0).
 *
 * On `Mina.Network`, `Mina.getAccount` participates in o1js's two-pass tx
 * construction (the first pass marks `(recipient, tokenId)` to be fetched; the
 * cached pass + `tx.prove()` read it).
 */
function readReceiptBalance(recipient: PublicKey, tokenId: Field): bigint {
  try {
    return Mina.getAccount(recipient, tokenId).balance.toBigInt();
  } catch {
    return 0n;
  }
}

/**
 * The permissionless, rate-limited mint authority. Drop-in
 * `FungibleToken.AdminContract` implementation: deploys with the same
 * `{ adminPublicKey }` props as the stock `FungibleTokenAdmin`; only `canMint`
 * differs (permissionless + rate-limited, and NO recipient signature).
 */
export class PermissionlessRateLimitedUsdcAdmin
  extends SmartContract
  implements FungibleTokenAdminBase
{
  /** Pause/upgrade authority — NOT a mint authority. */
  @state(PublicKey)
  private adminPublicKey = State<PublicKey>();

  /** The token id the mint-receipt accounts live under. */
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
   * Permissionless, rate-limited mint gate — NO admin signature, NO recipient
   * signature.
   *
   * `accountUpdate` is the recipient's mint AU built by `FungibleToken.mint`
   * (`publicKey` = recipient, `balanceChange` = +amount); its fields are bound
   * into this proof via the token→admin call data. The recipient's USDC token
   * account is created/credited by that AU (default `receive: none`, so no
   * recipient signature there either). This method maintains the recipient's
   * per-day receipt counter as an INCREASE-ONLY packed balance under the admin's
   * token id (see module docs), authorized by THIS proof alone.
   */
  @method.returns(Bool)
  public async canMint(accountUpdate: AccountUpdate): Promise<Bool> {
    const recipient = accountUpdate.body.publicKey;
    const balanceChange = accountUpdate.body.balanceChange;
    // A mint AU's balance change is non-negative by construction; forbid a
    // hostile direct call from recording a "negative mint".
    balanceChange.isNonNegative().assertTrue(RATE_LIMIT_ASSERT.NEGATIVE_MINT);
    const amount = balanceChange.magnitude;

    // Hard per-tx backstop.
    amount.assertLessThanOrEqual(PER_MINT_CAP, RATE_LIMIT_ASSERT.PER_MINT_CAP_EXCEEDED);

    // Witness the current global slot; anchor it with a range precondition so it
    // is at most MINT_SLOT_TOLERANCE slots stale at application time (#202).
    const claimedSlot = this.network.globalSlotSinceGenesis.get();
    this.network.globalSlotSinceGenesis.requireBetween(
      claimedSlot,
      claimedSlot.add(MINT_SLOT_TOLERANCE)
    );

    // Witness the prior receipt by reading + decomposing the receipt balance
    // (zeros for a fresh address) …
    const tokenId = this.deriveTokenId();
    const prior = Provable.witness(MintReceipt, () => {
      const decoded = decodeReceiptBalance(readReceiptBalance(recipient, tokenId));
      return new MintReceipt({
        windowStart: UInt32.from(decoded.windowStart),
        mintedInWindow: UInt64.from(decoded.mintedInWindow),
      });
    });
    // Constrain the decomposition to be valid: mintedInWindow must fit the low
    // RECEIPT_SHIFT_BITS bits (windowStart is a UInt32, already < 2^32). With the
    // balance precondition below this pins a UNIQUE, correct decomposition.
    prior.mintedInWindow.assertLessThan(RECEIPT_SHIFT_U64, RECEIPT_DECODE_ASSERT);
    const priorWindowStart64 = UInt64.Unsafe.fromField(prior.windowStart.value);
    const oldPacked = priorWindowStart64.mul(RECEIPT_SHIFT_U64).add(prior.mintedInWindow);

    // … and compute the windowed accounting.
    const windowExpired = claimedSlot.greaterThanOrEqual(prior.windowStart.add(MINT_WINDOW_SLOTS));
    const windowStart = Provable.if(windowExpired, UInt32, claimedSlot, prior.windowStart);
    const alreadyMinted = Provable.if(windowExpired, UInt64, UInt64.zero, prior.mintedInWindow);
    const mintedInWindow = alreadyMinted.add(amount);
    mintedInWindow.assertLessThanOrEqual(DAILY_MINT_CAP, RATE_LIMIT_ASSERT.DAILY_CAP_EXCEEDED);

    // Re-pack and take the (non-negative) delta. The pack is monotonic (module
    // docs), so `sub` never underflows for an in-policy mint — a same-window
    // top-up raises the low bits by `amount`; a reset raises the high bits by
    // ≥ 480·2^32, dwarfing the low-bit reset.
    const windowStart64 = UInt64.Unsafe.fromField(windowStart.value);
    const newPacked = windowStart64.mul(RECEIPT_SHIFT_U64).add(mintedInWindow);
    const delta = newPacked.sub(oldPacked);

    // Receipt AU: pin the witnessed prior balance as a LEDGER precondition and
    // INCREASE the balance by `delta`. The increase is a `receive` (default
    // permission `none`) so it needs NO recipient signature; the whole AU is
    // authorized by this method's proof via `approve` (+ the admin's `access:
    // proof`). The balance precondition is what makes a stale/duplicate mint
    // fail on-chain (its `oldPacked` no longer matches the current balance).
    const receiptAu = AccountUpdate.create(recipient, tokenId);
    receiptAu.balanceChange = Int64.fromUnsigned(delta);
    receiptAu.account.balance.requireEquals(oldPacked);
    this.approve(receiptAu);

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
