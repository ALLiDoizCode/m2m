---
stepsCompleted:
  - step-01-preflight-and-context
  - step-02-generation-mode
  - step-03-test-strategy
  - step-04-generate-tests
  - step-04c-aggregate
  - step-05-validate-and-complete
lastStep: step-05-validate-and-complete
lastSaved: '2026-03-25'
workflowType: testarch-atdd
inputDocuments:
  - _bmad-output/implementation-artifacts/33-2-solana-payment-channel-program-claim-verification.md
  - _bmad-output/planning-artifacts/test-design-epic-33.md
  - _bmad/tea/config.yaml
  - _bmad/tea/testarch/knowledge/data-factories.md
  - _bmad/tea/testarch/knowledge/test-quality.md
  - _bmad/tea/testarch/knowledge/test-healing-patterns.md
  - _bmad/tea/testarch/knowledge/test-levels-framework.md
  - _bmad/tea/testarch/knowledge/test-priorities-matrix.md
---

# ATDD Checklist - Epic 33, Story 2: Solana Payment Channel Program -- Claim Verification

**Date:** 2026-03-25
**Author:** Jonathan
**Primary Test Level:** Rust integration (solana-program-test BanksClient)

---

## Story Summary

This story implements the `claim_from_channel` instruction handler for the on-chain Solana payment channel program. It verifies Ed25519-signed balance proofs so that peers can submit claims that update the channel's cumulative transferred amounts, enabling off-chain payment settlement.

**As a** connector operator
**I want** the on-chain program to verify Ed25519-signed balance proofs
**So that** peers can submit claims that update the channel's cumulative transferred amounts

---

## Acceptance Criteria

1. **AC 1 - Valid Claim Updates Channel State:** Valid claim with correct Ed25519 signature updates nonce and transferred_amount for the claiming participant; channel remains Opened
2. **AC 2 - Replay Attack Rejected (Same Nonce):** Claim with replayed nonce (nonce == stored) fails with `NonceNotMonotonic` (code 6)
3. **AC 3 - Stale Nonce Rejected:** Claim with stale nonce (nonce < stored) fails with `NonceNotMonotonic` (code 6)
4. **AC 4 - Invalid Signature Rejected:** Claim with invalid/mismatched Ed25519 signature fails with `InvalidSignature` (code 8)
5. **AC 5 - Unauthorized Signer Rejected:** Claim signed by non-participant keypair fails with `UnauthorizedSigner` (code 9)
6. **AC 6 - Transferred Amount Decrease Rejected:** Claim with decreased transferred_amount fails with `TransferredAmountDecreased` (code 7)
7. **AC 7 - Claim Accepted During Challenge Period:** Valid claim on a Closed channel is accepted (claims can update final balances during challenge period)
8. **AC 8 - Claim Rejected on Settled Channel:** Claim on settled channel fails (account data zeroed/invalid)
9. **AC 9 - Balance Proof Message Format:** Balance proof message is exactly 48 bytes: `channel_pda (32) || nonce (8 LE) || transferred_amount (8 LE)`
10. **AC 10 - Multiple Sequential Claims Succeed:** Multiple valid claims with increasing nonces all succeed
11. **AC 11 - Missing Ed25519 Precompile Instruction Rejected:** Claim without Ed25519 precompile instruction at index 0 fails with `InvalidSignature` (code 8)

---

## Test Strategy

### Generation Mode

**AI Generation** -- backend Rust project, no browser recording needed. All tests are Rust integration tests using `solana-program-test` BanksClient (in-process, no Docker).

### Test Level Selection

| AC | Test ID | Scenario | Level | Priority | Red Phase Failure Reason |
|----|---------|----------|-------|----------|--------------------------|
| AC 1 | T-33.2-01 | Valid claim updates nonce and transferred_amount | Rust integration | P0 | `claim_from_channel` handler returns `InvalidInstructionData` (stub) |
| AC 2 | T-33.2-02 | Replayed nonce (nonce == stored) fails with `NonceNotMonotonic` | Rust integration | P0 | Handler not implemented |
| AC 3 | T-33.2-03 | Stale nonce (nonce < stored) fails with `NonceNotMonotonic` | Rust integration | P0 | Handler not implemented |
| AC 4 | T-33.2-04 | Invalid/mismatched Ed25519 signature fails with `InvalidSignature` | Rust integration | P0 | Handler not implemented |
| AC 5 | T-33.2-05 | Non-participant signer fails with `UnauthorizedSigner` | Rust integration | P0 | Handler not implemented |
| AC 6 | T-33.2-06 | Decreased transferred_amount fails with `TransferredAmountDecreased` | Rust integration | P0 | Handler not implemented |
| AC 7 | T-33.2-07 | Claim on closed channel during challenge period succeeds | Rust integration | P0 | Handler not implemented |
| AC 11 | T-33.2-08 | Missing Ed25519 precompile instruction fails with `InvalidSignature` | Rust integration | P1 | Handler not implemented |
| AC 11 | T-33.2-09 | Ed25519 precompile at wrong index fails | Rust integration | P1 | Handler not implemented |
| AC 10 | T-33.2-10 | Multiple sequential claims with increasing nonces succeed | Rust integration | P1 | Handler not implemented |
| AC 8 | T-33.2-11 | Claim on settled channel fails (account zeroed) | Rust integration | P1 | Handler not implemented |
| AC 9 | T-33.2-12 | Balance proof message format is exactly 48 bytes | Rust unit | P0 | N/A (passes -- tests helper function, not on-chain code) |
| AC 1 | T-33.2-13 | Claim from participant B updates B's fields (not A's) | Rust integration | P0 | Handler not implemented |

---

## Failing Tests Created (RED Phase)

### Rust Integration Tests (13 tests)

**File:** `packages/solana-program/tests/claims.rs` (approx. 680 lines)

- **Test:** `test_valid_claim_updates_channel_state` (T-33.2-01)
  - **Status:** RED -- `#[ignore]` (handler returns `InvalidInstructionData`)
  - **Verifies:** Valid claim with correct Ed25519 signature updates nonce_a, transferred_amount_a; channel stays Opened; B's fields unchanged

- **Test:** `test_replayed_nonce_rejected` (T-33.2-02)
  - **Status:** RED -- `#[ignore]` (handler not implemented)
  - **Verifies:** Claim with replayed nonce (== stored) fails with `NonceNotMonotonic` (code 6)

- **Test:** `test_stale_nonce_rejected` (T-33.2-03)
  - **Status:** RED -- `#[ignore]` (handler not implemented)
  - **Verifies:** Claim with stale nonce (< stored) fails with `NonceNotMonotonic` (code 6)

- **Test:** `test_invalid_signature_rejected` (T-33.2-04)
  - **Status:** RED -- `#[ignore]` (handler not implemented)
  - **Verifies:** Claim with mismatched Ed25519 signature fails with `InvalidSignature` (code 8)

- **Test:** `test_unauthorized_signer_rejected` (T-33.2-05)
  - **Status:** RED -- `#[ignore]` (handler not implemented)
  - **Verifies:** Claim from non-participant keypair fails with `UnauthorizedSigner` (code 9)

- **Test:** `test_decreased_transferred_amount_rejected` (T-33.2-06)
  - **Status:** RED -- `#[ignore]` (handler not implemented)
  - **Verifies:** Claim with decreased transferred_amount fails with `TransferredAmountDecreased` (code 7)

- **Test:** `test_claim_on_closed_channel_succeeds` (T-33.2-07)
  - **Status:** RED -- `#[ignore]` (handler not implemented)
  - **Verifies:** Valid claim on Closed channel (during challenge period) is accepted

- **Test:** `test_missing_ed25519_precompile_rejected` (T-33.2-08)
  - **Status:** RED -- `#[ignore]` (handler not implemented)
  - **Verifies:** Claim without Ed25519 precompile instruction fails with `InvalidSignature` (code 8)

- **Test:** `test_ed25519_precompile_at_wrong_index_rejected` (T-33.2-09)
  - **Status:** RED -- `#[ignore]` (handler not implemented)
  - **Verifies:** Ed25519 precompile at wrong transaction index (not index 0) fails

- **Test:** `test_multiple_sequential_claims_succeed` (T-33.2-10)
  - **Status:** RED -- `#[ignore]` (handler not implemented)
  - **Verifies:** Sequential claims with nonces 1, 2, 3 all succeed; final nonce_a = 3

- **Test:** `test_claim_on_settled_channel_fails` (T-33.2-11)
  - **Status:** RED -- `#[ignore]` (handler not implemented)
  - **Verifies:** Claim on settled channel (zeroed account) fails

- **Test:** `test_balance_proof_message_format` (T-33.2-12)
  - **Status:** GREEN -- passes (tests helper function, not on-chain code)
  - **Verifies:** Message is exactly 48 bytes: channel_pda (32) || nonce (8 LE) || transferred_amount (8 LE)

- **Test:** `test_claim_from_participant_b_updates_b_fields` (T-33.2-13)
  - **Status:** RED -- `#[ignore]` (handler not implemented)
  - **Verifies:** Claim from participant B updates nonce_b and transferred_amount_b; A's fields unchanged

---

## Data Factories Created

N/A -- Rust tests use `Keypair::new()` for random keypair generation and `sorted_participants()` for deterministic test setup. No external factory library needed.

---

## Fixtures Created

### Channel Setup Fixture

**File:** `packages/solana-program/tests/claims.rs` (inline helpers)

**Fixtures (helper functions):**

- `program_test()` -- creates ProgramTest instance with payment channel program loaded
- `sorted_participants()` -- generates two keypairs with deterministic ordering (A < B lexicographically)
- `create_test_mint()` -- creates SPL Token mint for testing
- `create_and_fund_token_account()` -- creates and funds a token account
- `setup_channel()` -- initializes a channel and returns (channel_pda, vault_pda, token_mint)
- `deposit_to_channel()` -- deposits tokens into a channel for a participant
- `advance_clock_by_seconds()` -- advances the Solana clock sysvar
- `build_balance_proof_message()` -- constructs the 48-byte balance proof message
- `build_ed25519_precompile_instruction()` -- builds and signs Ed25519 precompile instruction
- `build_claim_from_channel_instruction()` -- builds the claim instruction with nonce and transferred_amount
- `submit_claim()` -- convenience helper that builds and submits a full claim transaction (Ed25519 precompile + claim instruction)
- `read_channel_u64()` -- reads a u64 field from channel account data
- `read_channel_state()` -- reads the channel state byte

**Cleanup:** Solana BanksClient tests use isolated ProgramTest contexts -- each test gets a fresh blockchain state with automatic cleanup.

---

## Mock Requirements

N/A -- Tests use `solana-program-test` BanksClient which provides an in-process Solana runtime. No external service mocking required.

---

## Required data-testid Attributes

N/A -- This is a Rust on-chain program with no UI components.

---

## Implementation Checklist

### Test: test_valid_claim_updates_channel_state (T-33.2-01)

**File:** `packages/solana-program/tests/claims.rs`

**Tasks to make this test pass:**

- [ ] Update `PaymentChannelInstruction::ClaimFromChannel` to carry `nonce: u64, transferred_amount: u64` in `instruction.rs`
- [ ] Update `unpack()` to parse nonce (8 bytes LE) and transferred_amount (8 bytes LE) after discriminator
- [ ] Implement `process_claim_from_channel` handler in `processor.rs`
- [ ] Validate channel PDA derivation
- [ ] Determine which participant the signer is (A or B)
- [ ] Verify nonce is strictly greater than stored nonce
- [ ] Verify transferred_amount >= stored transferred_amount
- [ ] Implement Ed25519 precompile introspection (load Instructions sysvar, verify precompile at index 0)
- [ ] Verify precompile public_key matches claimer, message matches balance proof
- [ ] Update nonce and transferred_amount for the claiming participant
- [ ] Serialize updated state back to account
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test --test claims test_valid_claim_updates_channel_state`
- [ ] Test passes (green phase)

**Estimated Effort:** 4-6 hours (includes Ed25519 precompile introspection implementation)

---

### Test: test_replayed_nonce_rejected (T-33.2-02)

**File:** `packages/solana-program/tests/claims.rs`

**Tasks to make this test pass:**

- [ ] Nonce monotonicity check already part of handler implementation (Task 2.5 from story)
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test --test claims test_replayed_nonce_rejected`
- [ ] Test passes (green phase)

**Estimated Effort:** Included in T-33.2-01 implementation

---

### Test: test_stale_nonce_rejected (T-33.2-03)

**File:** `packages/solana-program/tests/claims.rs`

**Tasks to make this test pass:**

- [ ] Same nonce monotonicity check covers this case
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test --test claims test_stale_nonce_rejected`
- [ ] Test passes (green phase)

**Estimated Effort:** Included in T-33.2-01 implementation

---

### Test: test_invalid_signature_rejected (T-33.2-04)

**File:** `packages/solana-program/tests/claims.rs`

**Tasks to make this test pass:**

- [ ] Ed25519 precompile introspection verifies message matches expected balance proof
- [ ] Mismatched message causes `InvalidSignature` error
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test --test claims test_invalid_signature_rejected`
- [ ] Test passes (green phase)

**Estimated Effort:** Included in T-33.2-01 implementation

---

### Test: test_unauthorized_signer_rejected (T-33.2-05)

**File:** `packages/solana-program/tests/claims.rs`

**Tasks to make this test pass:**

- [ ] Participant check determines if signer is A or B; rejects with `UnauthorizedSigner` if neither
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test --test claims test_unauthorized_signer_rejected`
- [ ] Test passes (green phase)

**Estimated Effort:** Included in T-33.2-01 implementation

---

### Test: test_decreased_transferred_amount_rejected (T-33.2-06)

**File:** `packages/solana-program/tests/claims.rs`

**Tasks to make this test pass:**

- [ ] Transferred amount monotonicity check already part of handler (Task 2.6 from story)
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test --test claims test_decreased_transferred_amount_rejected`
- [ ] Test passes (green phase)

**Estimated Effort:** Included in T-33.2-01 implementation

---

### Test: test_claim_on_closed_channel_succeeds (T-33.2-07)

**File:** `packages/solana-program/tests/claims.rs`

**Tasks to make this test pass:**

- [ ] Handler allows claims on both Opened and Closed channels (rejects only Settled)
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test --test claims test_claim_on_closed_channel_succeeds`
- [ ] Test passes (green phase)

**Estimated Effort:** Included in T-33.2-01 implementation

---

### Test: test_missing_ed25519_precompile_rejected (T-33.2-08)

**File:** `packages/solana-program/tests/claims.rs`

**Tasks to make this test pass:**

- [ ] Handler loads instruction at index 0 from Instructions sysvar and checks it is Ed25519 precompile
- [ ] Missing instruction or wrong program_id returns `InvalidSignature`
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test --test claims test_missing_ed25519_precompile_rejected`
- [ ] Test passes (green phase)

**Estimated Effort:** Included in T-33.2-01 implementation

---

### Test: test_ed25519_precompile_at_wrong_index_rejected (T-33.2-09)

**File:** `packages/solana-program/tests/claims.rs`

**Tasks to make this test pass:**

- [ ] Handler expects precompile at index 0; reads instruction at index 0 and verifies program_id
- [ ] When claim is at index 0 and precompile at index 1, the handler sees the wrong program_id
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test --test claims test_ed25519_precompile_at_wrong_index_rejected`
- [ ] Test passes (green phase)

**Estimated Effort:** Included in T-33.2-01 implementation

---

### Test: test_multiple_sequential_claims_succeed (T-33.2-10)

**File:** `packages/solana-program/tests/claims.rs`

**Tasks to make this test pass:**

- [ ] Handler correctly updates state on each successive claim with increasing nonce
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test --test claims test_multiple_sequential_claims_succeed`
- [ ] Test passes (green phase)

**Estimated Effort:** Included in T-33.2-01 implementation

---

### Test: test_claim_on_settled_channel_fails (T-33.2-11)

**File:** `packages/solana-program/tests/claims.rs`

**Tasks to make this test pass:**

- [ ] Handler rejects state == Settled (or account with zeroed/invalid data after settlement)
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test --test claims test_claim_on_settled_channel_fails`
- [ ] Test passes (green phase)

**Estimated Effort:** Included in T-33.2-01 implementation

---

### Test: test_claim_from_participant_b_updates_b_fields (T-33.2-13)

**File:** `packages/solana-program/tests/claims.rs`

**Tasks to make this test pass:**

- [ ] Handler correctly routes to nonce_b/transferred_amount_b when signer is participant B
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test --test claims test_claim_from_participant_b_updates_b_fields`
- [ ] Test passes (green phase)

**Estimated Effort:** Included in T-33.2-01 implementation

---

## Running Tests

```bash
# Run all claim tests (ignored tests are skipped)
cargo test --test claims

# Run all claim tests including ignored (RED phase -- all will fail)
cargo test --test claims -- --include-ignored

# Run a specific test
cargo test --test claims test_valid_claim_updates_channel_state -- --include-ignored

# Run all tests (lifecycle + claims) to verify no regressions
cargo test

# Run with SBF target (full on-chain simulation)
cargo test-sbf

# Run with verbose output
cargo test --test claims -- --nocapture
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 13 tests written (12 with `#[ignore]`, 1 passing unit test)
- Test helpers created for channel setup, claim submission, Ed25519 precompile construction
- Balance proof message format verified (48 bytes: channel_pda || nonce || transferred_amount)
- Implementation checklist created mapping each failing test to concrete tasks
- All tests compile and the ignored tests are properly skipped

**Verification:**

- `cargo test --test claims` -- 1 passed, 0 failed, 12 ignored
- `cargo test --test lifecycle` -- 19 passed, 0 failed (no regressions)

---

### GREEN Phase (DEV Team -- Next Steps)

**DEV Agent Responsibilities:**

1. **Implement `process_claim_from_channel`** in `processor.rs` (the core handler)
2. **Update instruction parsing** in `instruction.rs` to carry nonce and transferred_amount
3. **Remove `#[ignore]`** from each test as you implement the corresponding functionality
4. **Run tests** to verify each passes (green)
5. **Check off tasks** in implementation checklist above

**Key Principles:**

- One test at a time (don't try to fix all at once)
- Start with T-33.2-01 (valid claim) -- it exercises the full happy path
- Minimal implementation (don't over-engineer)
- Run tests frequently (immediate feedback)

---

### REFACTOR Phase (DEV Team -- After All Tests Pass)

**DEV Agent Responsibilities:**

1. Verify all 13 tests pass (green phase complete)
2. Review code quality (readability, error handling, compute budget)
3. Consider extracting shared PDA validation logic with existing handlers
4. Optimize compute usage if needed
5. Ensure tests still pass after each refactor
6. Run `cargo build-sbf` to check binary size

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `cargo test --test claims`

**Results:**

```
running 13 tests
test test_claim_from_participant_b_updates_b_fields ... ignored
test test_claim_on_closed_channel_succeeds ... ignored
test test_claim_on_settled_channel_fails ... ignored
test test_decreased_transferred_amount_rejected ... ignored
test test_ed25519_precompile_at_wrong_index_rejected ... ignored
test test_invalid_signature_rejected ... ignored
test test_missing_ed25519_precompile_rejected ... ignored
test test_multiple_sequential_claims_succeed ... ignored
test test_replayed_nonce_rejected ... ignored
test test_stale_nonce_rejected ... ignored
test test_unauthorized_signer_rejected ... ignored
test test_valid_claim_updates_channel_state ... ignored
test test_balance_proof_message_format ... ok

test result: ok. 1 passed; 0 failed; 12 ignored; 0 measured; 0 filtered out
```

**Summary:**

- Total tests: 13
- Passing: 1 (balance proof format unit test)
- Ignored: 12 (RED phase -- handler not implemented)
- Status: RED phase verified

### Regression Check

**Command:** `cargo test --test lifecycle`

**Results:** 19 passed; 0 failed; 0 ignored -- no regressions from adding claims.rs

---

## Notes

- The Rust equivalent of `test.skip()` is `#[ignore]` -- tests compile but are skipped by default. Remove `#[ignore]` to run them against the implementation.
- `ed25519-dalek = "=1.0.1"` was added to `[dev-dependencies]` in `Cargo.toml` to match the version used by `solana-sdk 2.1.0`. This is needed to construct Ed25519 precompile instructions in tests via `solana_sdk::ed25519_instruction::new_ed25519_instruction()`.
- Test helpers are duplicated from `lifecycle.rs` for test isolation. A future refactor could extract shared helpers into a common test module.
- The `submit_claim()` helper parses custom error codes from `BanksClientError` debug output. This is a pragmatic approach for the test environment.
- Tests for T-33.2-02 and T-33.2-03 (replay/stale nonce) build on T-33.2-01 by first submitting valid claims to advance the nonce, then attempting invalid claims.

---

## Knowledge Base References Applied

This ATDD workflow consulted the following knowledge fragments:

- **data-factories.md** -- Adapted factory pattern to Rust (Keypair::new(), sorted_participants())
- **test-quality.md** -- Given-When-Then structure, one assertion focus per test, determinism, isolation
- **test-healing-patterns.md** -- Error code parsing pattern for BanksClient custom errors
- **test-levels-framework.md** -- Selected Rust integration tests as primary level (no E2E/UI)
- **test-priorities-matrix.md** -- P0 for core claim functionality, P1 for edge cases

See `tea-index.csv` for complete knowledge fragment mapping.

---

**Generated by BMad TEA Agent** - 2026-03-25
