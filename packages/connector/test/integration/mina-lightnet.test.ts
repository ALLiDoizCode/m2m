/**
 * Mina Lightnet E2E Integration Tests (Stub)
 *
 * Story 34.8: Docker-based lightnet tests that require a running Mina lightnet
 * instance. These tests are skipped by default and should only be run when
 * the lightnet is available (via `make mina-up`).
 *
 * Test IDs covered:
 * - T-34.8-18: Archive node event retrieval
 *
 * Test gating: skip if lightnet is not running (checks http://localhost:8181/acquire-account).
 *
 * To run locally: start the lightnet with `make mina-up`, then remove the
 * .skip from the describe block.
 *
 * @packageDocumentation
 */

jest.setTimeout(120_000);

// ---------------------------------------------------------------------------
// Lightnet E2E -- requires `make mina-up`. Remove .skip to run locally.
// ---------------------------------------------------------------------------

// Skipped: Lightnet E2E tests require `make mina-up` (Docker infrastructure)
describe.skip('Mina Lightnet E2E Integration Tests (Story 34.8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // T-34.8-18: Archive Node Event Retrieval
  // -------------------------------------------------------------------------

  describe('[T-34.8-18] Archive node event retrieval', () => {
    it('should retrieve channel events from the Mina archive node', async () => {
      // Placeholder: Un-skip when lightnet infrastructure is available.
      //
      // This test will:
      // 1. Acquire funded accounts from lightnet (http://localhost:8181/acquire-account)
      // 2. Deploy a PaymentChannel zkApp to the local Mina network
      // 3. Open a channel and submit claims
      // 4. Query the archive node for channel events via GraphQL
      // 5. Verify event data matches the submitted transactions
      //
      // Prerequisites:
      //   make mina-up  (starts Docker containers: mina-daemon, archive-node, lightnet)
      //
      // Expected duration: 30-60 seconds (lightnet block time ~20s)
      // Stub: no assertions until lightnet infrastructure is available
      expect.assertions(0);
    });
  });
});
