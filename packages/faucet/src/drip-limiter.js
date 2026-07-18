// ---------------------------------------------------------------------------
// Per-address off-chain drip cooldown (in-memory)
// ---------------------------------------------------------------------------
// The Mina USDC leg drips by TRANSFER from a treasury that can only replenish
// itself at 1,000 USDC per ~24h (the RateLimitedUsdcAdmin self-mint cap — see
// packages/mina-zkapp/src/usdc-faucet.ts). Unlike the mint cap, transfers are
// NOT rate-limited on-chain, so without a service-side limit one address could
// drain the whole daily treasury allowance. This limiter is that service-side
// leg: one successful USDC drip per address per cooldown window.
//
// In-memory by design (matching the faucet's other state: none of the legs
// persist anything) — a faucet restart forgets cooldowns, which is acceptable
// for a devnet convenience; the hard backstop is the on-chain treasury
// replenishment ceiling itself.
//
// Concurrency: `claim()` RESERVES the slot immediately (before the drip runs
// on the serialized queue) and `release()` rolls the reservation back when the
// drip fails, so two concurrent requests for the same address can never
// double-drip, and a failed drip never burns the address's cooldown.

/**
 * Create a per-address cooldown limiter.
 *
 * @param {object} opts
 * @param {number} opts.cooldownMs  – window during which an address may drip once
 * @param {() => number} [opts.now] – clock override (tests)
 * @param {number} [opts.maxEntries] – prune guard for the in-memory map
 */
export function createDripLimiter({ cooldownMs, now = Date.now, maxEntries = 50_000 }) {
  if (!(Number.isFinite(cooldownMs) && cooldownMs >= 0)) {
    throw new Error(
      `createDripLimiter: cooldownMs must be a non-negative number, got ${cooldownMs}`
    );
  }
  /** @type {Map<string, number>} address → last successful-claim timestamp */
  const lastClaim = new Map();

  function pruneExpired(t) {
    for (const [addr, ts] of lastClaim) {
      if (t - ts >= cooldownMs) lastClaim.delete(addr);
    }
  }

  function enforceCap() {
    // Memory guard: evict oldest-first (Map iteration order is insertion
    // order), so a flood of fresh addresses can never grow the map unbounded.
    while (lastClaim.size > maxEntries) {
      const oldest = lastClaim.keys().next().value;
      lastClaim.delete(oldest);
    }
  }

  return {
    /**
     * Try to reserve a drip slot for `address`. Returns `{ allowed: true }`
     * and RECORDS the claim, or `{ allowed: false, retryAfterMs }` while the
     * address is still cooling down. Call `release()` if the drip then fails.
     */
    claim(address) {
      const t = now();
      pruneExpired(t);
      const prev = lastClaim.get(address);
      if (prev !== undefined && t - prev < cooldownMs) {
        return { allowed: false, retryAfterMs: cooldownMs - (t - prev) };
      }
      lastClaim.set(address, t);
      enforceCap();
      return { allowed: true, retryAfterMs: 0 };
    },

    /** Roll back a claim after a FAILED drip so the failure costs no cooldown. */
    release(address) {
      lastClaim.delete(address);
    },

    /** Cooldown remaining for `address` (0 when it may drip), without claiming. */
    retryAfterMs(address) {
      const prev = lastClaim.get(address);
      if (prev === undefined) return 0;
      const remaining = cooldownMs - (now() - prev);
      return remaining > 0 ? remaining : 0;
    },

    /** Number of live reservations (tests / diagnostics). */
    size() {
      return lastClaim.size;
    },
  };
}
