/**
 * Mina Proof-Enabled Integration Tests (Stub)
 *
 * Story 34.8: Proof-enabled tests that require o1js and real zk-SNARK
 * proof generation. These tests are skipped by default and should only
 * be run in merge/nightly CI when o1js is available as a dependency.
 *
 * Test IDs covered:
 * - T-34.8-15: Full lifecycle with proofsEnabled: true
 * - T-34.8-16: Proof generation timing measurement
 *
 * To run locally: remove the .skip from the describe block and ensure
 * o1js is installed.
 *
 * @packageDocumentation
 */

// Proof-enabled tests require extended timeout (5 minutes for proof generation)
jest.setTimeout(300_000);

// ---------------------------------------------------------------------------
// Proof-enabled tests -- run in merge/nightly CI only. Remove .skip to run locally.
// ---------------------------------------------------------------------------

// Skipped: Proof-enabled tests require o1js dependency (merge/nightly CI only)
describe.skip('Mina Proof-Enabled Integration Tests (Story 34.8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // T-34.8-15: Full Lifecycle with proofsEnabled: true
  // -------------------------------------------------------------------------

  describe('[T-34.8-15] Full lifecycle with proofsEnabled: true', () => {
    it('should complete full lifecycle with real zk-SNARK proofs', async () => {
      // Placeholder: Un-skip when o1js is available as a dependency.
      //
      // This test will:
      // 1. Initialize o1js LocalBlockchain with proofsEnabled: true
      // 2. Compile the PaymentChannel zkApp circuit
      // 3. Open a channel, deposit, generate real zk-SNARK claims
      // 4. Close and settle with real proof verification
      // 5. Verify Poseidon commitments are correct on-chain
      //
      // Expected duration: 60-180 seconds depending on hardware
      // Stub: no assertions until o1js is available
      expect.assertions(0);
    });
  });

  // -------------------------------------------------------------------------
  // T-34.8-16: Proof Generation Timing Measurement
  // -------------------------------------------------------------------------

  describe('[T-34.8-16] Proof generation timing measurement', () => {
    it('should measure proof generation time and log results', async () => {
      // Placeholder: Un-skip when o1js is available as a dependency.
      //
      // This test will:
      // 1. Record Date.now() before each proof operation
      // 2. Generate multiple proofs (compile, sign, verify)
      // 3. Record Date.now() after each operation
      // 4. Log timing results for CI performance tracking
      //
      // Expected timings:
      // - Circuit compilation: 30-60 seconds
      // - Proof generation (signBalanceProof): 15-45 seconds
      // - Proof verification (verifyBalanceProof): 5-15 seconds
      const startTime = Date.now();
      const endTime = Date.now();

      // Stub: timing assertions will be added when o1js is available
      expect(endTime - startTime).toBeGreaterThanOrEqual(0);
    });
  });
});
