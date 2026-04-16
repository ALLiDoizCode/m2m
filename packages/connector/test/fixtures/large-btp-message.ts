/**
 * Deterministic large-payload generator for the real-binary ATOR integration
 * suite (Story 36.3 T-36.3-08 large-frame sub-case).
 *
 * Generates a byte pattern of the requested size from a FIXED seed at suite
 * load time so the payload is reproducible across runs without committing a
 * binary fixture. Binary fixtures drift silently — see Story 36.3 Dev Notes
 * §Anti-Patterns: "DO NOT commit the generated binary fixture".
 *
 * The generator uses a simple linear-congruential PRNG seeded deterministically
 * — cryptographically weak but fine for a test fixture that just needs to
 * produce a byte-identical payload on both ends of a round-trip.
 *
 * @module test/fixtures/large-btp-message
 */

const FIXED_SEED = 0x36_3_2026 >>> 0; // Epic 36 / Story 36.3 / 2026

/**
 * Generate `size` bytes of deterministic pseudo-random data.
 *
 * @param size - Number of bytes to generate (must be > 0).
 * @returns Buffer of length `size` filled with deterministic content.
 */
export function largeBtpPayload(size: number): Buffer {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`largeBtpPayload: size must be a positive integer, got ${size}`);
  }
  const buf = Buffer.alloc(size);
  let state = FIXED_SEED;
  for (let i = 0; i < size; i++) {
    // LCG constants from Numerical Recipes.
    state = Math.imul(state, 1664525) + 1013904223;
    state = state >>> 0;
    buf[i] = state & 0xff;
  }
  return buf;
}
