/**
 * Read a recipient's remaining daily mint allowance WITHOUT o1js — a plain
 * GraphQL balance read + the same bigint unpack the contract uses.
 *
 * The `PermissionlessRateLimitedUsdcAdmin` stores each recipient's per-window
 * counter PACKED into the balance of that recipient's account under the admin's
 * derived token id (`ADMIN_TOKEN_ID_B58`):
 *
 *     packed = windowStart * 2^32 + mintedInWindow
 *
 * (see usdc-permissionless-admin.ts `decodeReceiptBalance`). A missing/zero
 * account means the recipient has never minted → full 1000 USDC available.
 *
 * The window RESETS when the chain's current slot reaches
 * `windowStart + MINT_WINDOW_SLOTS` (~24h). So to report what's ACTUALLY
 * available right now we also read the chain's current global slot: if the
 * stored window has expired, the effective minted-this-window is 0 (a fresh
 * 1000 is available), exactly as `canMint` recomputes it.
 */

import {
  ADMIN_TOKEN_ID_B58,
  DAILY_MINT_CAP_USDC,
  MINT_WINDOW_SLOTS,
  NETWORK_GRAPHQL,
  ONE_USDC,
} from './config';

const RECEIPT_SHIFT = 1n << 32n;

export interface AllowanceInfo {
  /** Base units already minted in the CURRENT (unexpired) window. */
  mintedBaseUnits: bigint;
  /** Base units still mintable in the current window (cap − minted, ≥ 0). */
  remainingBaseUnits: bigint;
  /** Whole-USDC daily cap (1000). */
  capWholeUsdc: bigint;
  /** True if the recipient has already hit the cap this window. */
  exhausted: boolean;
  /** True if the stored window had expired (counter treated as reset). */
  windowReset: boolean;
}

export function decodeReceiptBalance(packed: bigint): {
  windowStart: bigint;
  mintedInWindow: bigint;
} {
  return {
    windowStart: packed >> 32n,
    mintedInWindow: packed & (RECEIPT_SHIFT - 1n),
  };
}

async function gql<T>(query: string): Promise<T> {
  const res = await fetch(NETWORK_GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data: T; errors?: unknown };
  return body.data;
}

/** Best-effort current global slot (bestChain tip). 0 if unavailable. */
async function fetchCurrentSlot(): Promise<bigint> {
  try {
    const data = await gql<{
      bestChain?: { protocolState: { consensusState: { slotSinceGenesis: string } } }[];
    }>(`query { bestChain(maxLength: 1) { protocolState { consensusState { slotSinceGenesis } } } }`);
    const slot = data.bestChain?.[0]?.protocolState.consensusState.slotSinceGenesis;
    return slot ? BigInt(slot) : 0n;
  } catch {
    return 0n;
  }
}

async function fetchReceiptPacked(recipient: string): Promise<bigint> {
  const data = await gql<{ account?: { balance?: { total?: string } } }>(
    `query { account(publicKey: "${recipient}", token: "${ADMIN_TOKEN_ID_B58}") { balance { total } } }`
  );
  const total = data.account?.balance?.total;
  return total ? BigInt(total) : 0n;
}

/**
 * Query + decode the recipient's remaining allowance for the current window.
 * Throws only on a malformed address; network hiccups surface as a full/unknown
 * allowance so the UI can still let the user try.
 */
export async function fetchAllowance(recipient: string): Promise<AllowanceInfo> {
  const cap = DAILY_MINT_CAP_USDC * ONE_USDC;
  const [packed, currentSlot] = await Promise.all([
    fetchReceiptPacked(recipient),
    fetchCurrentSlot(),
  ]);

  const { windowStart, mintedInWindow } = decodeReceiptBalance(packed);

  // Replicate canMint's window-expiry check: if the chain has advanced past
  // windowStart + MINT_WINDOW_SLOTS, the counter resets to 0 for the next mint.
  const windowReset =
    currentSlot > 0n && currentSlot >= windowStart + MINT_WINDOW_SLOTS && packed > 0n;
  const effectiveMinted = windowReset ? 0n : mintedInWindow;

  const remaining = cap > effectiveMinted ? cap - effectiveMinted : 0n;
  return {
    mintedBaseUnits: effectiveMinted,
    remainingBaseUnits: remaining,
    capWholeUsdc: DAILY_MINT_CAP_USDC,
    exhausted: remaining === 0n,
    windowReset,
  };
}

/** Format base units as a human USDC string (6 dp, trimmed). */
export function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / ONE_USDC;
  const frac = baseUnits % ONE_USDC;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}
