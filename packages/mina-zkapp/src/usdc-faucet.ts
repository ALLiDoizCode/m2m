/**
 * Faucet-treasury orchestration for the RATE-LIMITED public-devnet USDC token:
 * accumulate via SELF-MINT, drip via TRANSFER.
 *
 * The canonical public-devnet USDC (infra/linode/endpoints.json "mina") is
 * gated by `RateLimitedUsdcAdmin`: mints are PERMISSIONLESS but (a) capped at
 * `DAILY_MINT_CAP_USDC` per address per ~24h (480-slot) window and (b) only
 * possible TO an address whose key SIGNS the mint (the mint-receipt AU
 * requires the recipient's signature — allowance-griefing protection). So a
 * faucet **cannot mint to its users by design**. What it CAN do:
 *
 *   1. self-mint its own daily allowance to its TREASURY address (the treasury
 *      key signs its own receipt), lazily — only when the treasury balance
 *      falls below a low-water mark, tolerating "window exhausted" gracefully;
 *   2. TRANSFER from the treasury to the requesting user — transfers are NOT
 *      capped by the admin contract (only mints are), so the drip leg always
 *      works while the treasury has balance.
 *
 * The treasury replenishment ceiling is therefore `DAILY_MINT_CAP_USDC`
 * (1,000 USDC) per ~24h — an intentional, honest limit of the design. Anyone
 * who wants more than the faucet drips can bypass it entirely: hold ~1.2
 * devnet MINA and run `tools/mina/self-mint-usdc.mts` for their own 1,000
 * USDC/day. The faucet is a convenience for zero-MINA users.
 *
 * This module is chain-instance-agnostic: it reads accounts through
 * `Mina.getAccount` / `Mina.hasAccount`, so it runs unchanged on a
 * `Mina.LocalBlockchain` (the unit tests) and on `Mina.Network` — PROVIDED a
 * Network caller pre-populates the o1js account cache with `fetchAccount` for
 * every (address, tokenId) pair involved (see `dripUsdcFromTreasury` docs).
 * Lives in packages/mina-zkapp so both build flavors exist (`dist/` CJS for
 * jest, `dist-esm/` ESM for the faucet service — the single-o1js-instance
 * modality, issue #352).
 *
 * @module usdc-faucet
 */

import { AccountUpdate, Field, Mina, PrivateKey, PublicKey, TokenId, UInt64 } from 'o1js';

import { FungibleToken, ONE_USDC } from './usdc-token';
import {
  DAILY_MINT_CAP,
  MINT_WINDOW_SLOTS,
  RATE_LIMIT_ASSERT,
  RECEIPT_STATE_SLOT,
} from './usdc-rate-limited-admin';
import { buildSelfMintTx, MINT_FEE_NANOMINA } from './usdc-deploy';

/** Error code carried by {@link UsdcTreasuryEmptyError} (route → 503). */
export const USDC_TREASURY_EMPTY = 'USDC_TREASURY_EMPTY';

/**
 * Thrown when a drip cannot be served: the treasury balance does not cover the
 * drip AND the treasury's self-mint window is exhausted (or the top-up mint
 * failed). Carries `code = 'USDC_TREASURY_EMPTY'` so service callers can map
 * it to a 503 without string-matching.
 */
export class UsdcTreasuryEmptyError extends Error {
  readonly code = USDC_TREASURY_EMPTY;
}

/** Off-chain view of a mint-receipt account (see usdc-rate-limited-admin.ts). */
export interface MintReceiptState {
  /** False when the (owner, adminTokenId) receipt account does not exist yet. */
  exists: boolean;
  /** Global slot the current mint window was anchored at. */
  windowStart: bigint;
  /** USDC base units minted to the owner since `windowStart`. */
  mintedInWindow: bigint;
}

/**
 * Read `owner`'s mint-receipt account (under the ADMIN CONTRACT's derived
 * token id) off the active Mina instance's ledger/cache. A missing account
 * reads as zeros with `exists: false` — exactly how the ledger evaluates
 * preconditions on nonexistent accounts. Network callers must `fetchAccount`
 * the pair first.
 */
export function readMintReceiptState(owner: PublicKey, adminContract: PublicKey): MintReceiptState {
  try {
    const account = Mina.getAccount(owner, TokenId.derive(adminContract));
    const appState = account.zkapp?.appState;
    return {
      exists: true,
      windowStart: (appState?.[RECEIPT_STATE_SLOT.windowStart] ?? Field(0)).toBigInt(),
      mintedInWindow: (appState?.[RECEIPT_STATE_SLOT.mintedInWindow] ?? Field(0)).toBigInt(),
    };
  } catch {
    return { exists: false, windowStart: 0n, mintedInWindow: 0n };
  }
}

/**
 * How many USDC base units `receipt`'s owner may still self-mint.
 *
 * Mirrors the `canMint` circuit's window arithmetic: a fresh address (or an
 * expired window, when `currentSlot` is known) gets the full
 * `DAILY_MINT_CAP`; otherwise the cap minus what was already minted since
 * `windowStart`. When `currentSlot` is unknown (a failed network probe) the
 * result is CONSERVATIVE — no window-reset credit is assumed, so the returned
 * allowance is a lower bound the circuit will always accept.
 */
export function remainingMintAllowance(receipt: MintReceiptState, currentSlot?: bigint): bigint {
  const cap = DAILY_MINT_CAP.toBigInt();
  if (!receipt.exists) return cap;
  if (
    currentSlot !== undefined &&
    currentSlot >= receipt.windowStart + MINT_WINDOW_SLOTS.toBigint()
  ) {
    return cap; // window expired — the circuit re-anchors and resets the count
  }
  const minted = receipt.mintedInWindow;
  return minted >= cap ? 0n : cap - minted;
}

/**
 * `owner`'s USDC balance (base units) under `token`, read off the active
 * instance; 0 when the token account does not exist (or is not cached —
 * Network callers must `fetchAccount` first).
 */
export function getUsdcBalance(token: FungibleToken, owner: PublicKey): bigint {
  try {
    return Mina.getAccount(owner, token.deriveTokenId()).balance.toBigInt();
  } catch {
    return 0n;
  }
}

/** Options for building a plain (uncapped) USDC token transfer transaction. */
export interface UsdcTransferTxOptions {
  token: FungibleToken;
  feePayer: PublicKey;
  /** Token sender — its key must be in `signers` (and SHOULD be the fee payer,
   * so o1js signs the token AU with full commitment instead of a token-account
   * nonce precondition). */
  from: PublicKey;
  to: PublicKey;
  /** Whole USDC to transfer (scaled to 6-dp base units). */
  wholeUsdc: bigint;
  signers: PrivateKey[];
  /** 1 when `to` has no token account yet (fee payer funds its creation). */
  fundNewAccounts?: number;
  /** zkApp tx fee in nanomina; defaults to MINT_FEE_NANOMINA (0.1 MINA). */
  feeNanomina?: bigint;
  /** Explicit fee-payer nonce override (for queueing txs before inclusion). */
  nonce?: number;
}

/**
 * Build + prove + sign (but do NOT send) a USDC transfer. Transfers go through
 * `FungibleToken.transfer` (a token @method — token-owner proof, NOT the admin
 * contract), so they are NOT subject to the mint rate limit: this is the
 * faucet's uncapped drip leg. Mirrors {@link buildSelfMintTx}'s shape.
 */
export async function buildUsdcTransferTx(
  opts: UsdcTransferTxOptions
): Promise<Mina.Transaction<true, true>> {
  const amount = UInt64.from(opts.wholeUsdc * ONE_USDC);
  const fundNewAccounts = opts.fundNewAccounts ?? 0;
  const tx = await Mina.transaction(
    {
      sender: opts.feePayer,
      fee: UInt64.from(opts.feeNanomina ?? MINT_FEE_NANOMINA),
      ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
    },
    async () => {
      if (fundNewAccounts > 0) AccountUpdate.fundNewAccount(opts.feePayer, fundNewAccounts);
      await opts.token.transfer(opts.from, opts.to, amount);
    }
  );
  const proven = await tx.prove();
  return proven.sign(opts.signers);
}

/** Options for a treasury drip (lazy self-mint top-up + transfer). */
export interface TreasuryDripOptions {
  /** Token deployed with the RATE-LIMITED admin contract. */
  token: FungibleToken;
  /** The `RateLimitedUsdcAdmin` contract address (receipt token id source). */
  adminContract: PublicKey;
  /** Treasury private key — fee payer, self-mint recipient AND transfer sender. */
  treasuryKey: PrivateKey;
  /** Drip recipient (does NOT sign anything — transfers need no recipient sig). */
  recipient: PublicKey;
  /** Whole USDC to transfer to the recipient. */
  dripUsdc: bigint;
  /** Self-mint top-up trigger: mint when treasury balance < this (whole USDC). */
  lowWaterUsdc: bigint;
  /**
   * Current global slot (for window-reset credit in the allowance math).
   * Optional: when unknown, the top-up is conservative — it never assumes the
   * window reset, so it may mint less than actually allowed but never builds a
   * mint the circuit rejects. LocalBlockchain tests pass it explicitly;
   * Network callers probe it best-effort.
   */
  currentSlot?: bigint;
  /** zkApp tx fee in nanomina per leg; defaults to MINT_FEE_NANOMINA. */
  feeNanomina?: bigint;
  /**
   * Fee-payer nonce for the FIRST tx sent (pool-aware `inferredNonce` on
   * Network). The second leg uses `baseNonce + 1`. Omit on LocalBlockchain.
   */
  baseNonce?: number;
  /**
   * Awaited between sending the mint leg and BUILDING the transfer leg.
   * Network callers use it to wait for inclusion when the mint is creating the
   * treasury's very first token account (the one case where the transfer
   * cannot be safely pipelined behind the pending mint).
   */
  onMintSent?: (
    pending: Mina.PendingTransaction,
    info: { createdTreasuryTokenAccount: boolean }
  ) => Promise<void>;
}

/** Outcome of a treasury drip. Amounts in whole USDC unless noted. */
export interface TreasuryDripResult {
  /** Whole USDC self-minted to the treasury in the top-up leg (0 when none). */
  mintedUsdc: bigint;
  mintHash?: string;
  /** Why a wanted top-up was skipped (typically: mint window exhausted). */
  mintSkipped?: string;
  /** Whole USDC transferred to the recipient (== dripUsdc on success). */
  transferredUsdc: bigint;
  transferHash?: string;
  /** True when this drip paid the recipient's 1-MINA token-account creation. */
  fundedRecipientAccount: boolean;
  /** Treasury USDC balance (base units) before the drip. */
  treasuryBalanceBefore: bigint;
  /** Treasury USDC balance (base units) after both legs (as sent). */
  treasuryBalanceAfter: bigint;
}

/** True for errors the rate-limit circuit/ledger raises when the window is
 * exhausted or the receipt state moved under us — the "tolerate gracefully"
 * set for the top-up leg. */
function isMintWindowError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return msg.includes(RATE_LIMIT_ASSERT.DAILY_CAP_EXCEEDED) || /precondition/i.test(msg);
}

/**
 * Serve one faucet drip from the treasury:
 *
 *   1. LAZY TOP-UP — when the treasury USDC balance is below `lowWaterUsdc`
 *      (or below the drip amount), self-mint the treasury's remaining window
 *      allowance to itself. "Window exhausted" is tolerated gracefully (noted
 *      in the result, not thrown) as long as the balance still covers the
 *      drip.
 *   2. TRANSFER `dripUsdc` to `recipient` — uncapped by the admin contract.
 *      If the recipient has no token account, the treasury funds its 1-MINA
 *      creation fee via `AccountUpdate.fundNewAccount`.
 *
 * Throws {@link UsdcTreasuryEmptyError} when the balance (after any top-up)
 * cannot cover the drip — i.e. treasury empty AND window exhausted.
 *
 * Network callers MUST pre-populate the o1js account cache (`fetchAccount`)
 * for: the treasury base account, the token + admin contract accounts, and
 * the (treasury, usdcTokenId), (treasury, adminTokenId), (recipient,
 * usdcTokenId) pairs — missing accounts included (a "missing" fetch result is
 * what makes `Mina.hasAccount` answer false).
 */
export async function dripUsdcFromTreasury(opts: TreasuryDripOptions): Promise<TreasuryDripResult> {
  const treasury = opts.treasuryKey.toPublicKey();
  const usdcTokenId = opts.token.deriveTokenId();
  const dripBase = opts.dripUsdc * ONE_USDC;
  const lowWaterBase = opts.lowWaterUsdc * ONE_USDC;

  const treasuryBalanceBefore = getUsdcBalance(opts.token, treasury);
  let nonce = opts.baseNonce;
  let mintedUsdc = 0n;
  let mintHash: string | undefined;
  let mintSkipped: string | undefined;

  // ── Leg 1: lazy self-mint top-up ──────────────────────────────────────────
  if (treasuryBalanceBefore < lowWaterBase || treasuryBalanceBefore < dripBase) {
    const receipt = readMintReceiptState(treasury, opts.adminContract);
    const allowanceBase = remainingMintAllowance(receipt, opts.currentSlot);
    const mintWhole = allowanceBase / ONE_USDC; // mint in whole USDC only
    if (mintWhole > 0n) {
      const treasuryHasTokenAccount = Mina.hasAccount(treasury, usdcTokenId);
      // First-ever top-up funds the treasury's token account and/or its
      // mint-receipt account (1 MINA each).
      const fundNewAccounts = (treasuryHasTokenAccount ? 0 : 1) + (receipt.exists ? 0 : 1);
      try {
        const mintTx = await buildSelfMintTx({
          token: opts.token,
          feePayer: treasury,
          recipient: treasury, // self-mint: the treasury signs its own receipt
          wholeUsdc: mintWhole,
          signers: [opts.treasuryKey],
          fundNewAccounts,
          ...(opts.feeNanomina !== undefined ? { feeNanomina: opts.feeNanomina } : {}),
          ...(nonce !== undefined ? { nonce } : {}),
        });
        const pending = await mintTx.send();
        mintedUsdc = mintWhole;
        mintHash = pending.hash;
        if (nonce !== undefined) nonce += 1;
        if (opts.onMintSent) {
          await opts.onMintSent(pending, {
            createdTreasuryTokenAccount: !treasuryHasTokenAccount,
          });
        }
      } catch (err) {
        // The off-chain allowance math can be stale (e.g. a competing mint or
        // an unknown current slot) — tolerate window/receipt failures and fall
        // through to the transfer leg, which decides whether the balance still
        // covers the drip. Anything else (fees, connectivity) is a real error.
        if (!isMintWindowError(err)) throw err;
        mintSkipped = `self-mint top-up failed (window exhausted / stale receipt): ${String(
          (err as Error)?.message ?? err
        )}`;
      }
    } else {
      mintSkipped =
        'mint window exhausted: the treasury already minted its full daily allowance ' +
        'this ~24h window (transfers continue while the balance lasts)';
    }
  }

  // ── Leg 2: uncapped transfer drip ─────────────────────────────────────────
  const availableBase = treasuryBalanceBefore + mintedUsdc * ONE_USDC;
  if (availableBase < dripBase) {
    throw new UsdcTreasuryEmptyError(
      `USDC treasury cannot cover the drip: have ${availableBase} base units, need ${dripBase}. ` +
        `The treasury's self-mint window is exhausted (cap ${DAILY_MINT_CAP.toBigInt()} base ` +
        `units per ~24h); drips resume when the window resets or someone transfers USDC to the ` +
        `treasury ${treasury.toBase58()}. You can also self-mint your own 1,000 USDC/day ` +
        `directly with tools/mina/self-mint-usdc.mts (needs ~1.2 devnet MINA for fees).`
    );
  }

  const fundedRecipientAccount = !Mina.hasAccount(opts.recipient, usdcTokenId);
  const transferTx = await buildUsdcTransferTx({
    token: opts.token,
    feePayer: treasury,
    from: treasury,
    to: opts.recipient,
    wholeUsdc: opts.dripUsdc,
    signers: [opts.treasuryKey],
    fundNewAccounts: fundedRecipientAccount ? 1 : 0,
    ...(opts.feeNanomina !== undefined ? { feeNanomina: opts.feeNanomina } : {}),
    ...(nonce !== undefined ? { nonce } : {}),
  });
  const pendingTransfer = await transferTx.send();

  return {
    mintedUsdc,
    ...(mintHash !== undefined ? { mintHash } : {}),
    ...(mintSkipped !== undefined ? { mintSkipped } : {}),
    transferredUsdc: opts.dripUsdc,
    transferHash: pendingTransfer.hash,
    fundedRecipientAccount,
    treasuryBalanceBefore,
    treasuryBalanceAfter: availableBase - dripBase,
  };
}
