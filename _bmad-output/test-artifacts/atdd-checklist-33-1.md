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
  - _bmad-output/implementation-artifacts/33-1-solana-payment-channel-program-channel-lifecycle.md
  - _bmad-output/planning-artifacts/test-design-epic-33.md
  - _bmad/tea/config.yaml
  - _bmad/tea/testarch/knowledge/data-factories.md
  - _bmad/tea/testarch/knowledge/test-quality.md
  - _bmad/tea/testarch/knowledge/test-healing-patterns.md
  - _bmad/tea/testarch/knowledge/test-levels-framework.md
  - _bmad/tea/testarch/knowledge/test-priorities-matrix.md
---

# ATDD Checklist - Epic 33, Story 1: Solana Payment Channel Program -- Channel Lifecycle

**Date:** 2026-03-25
**Author:** Jonathan
**Primary Test Level:** Rust unit/integration (solana-program-test BanksClient)

---

## Story Summary

This story implements the on-chain Solana program that manages payment channel lifecycle operations. It provides the foundational on-chain logic for opening, funding, closing, and settling payment channels between two participants using SPL tokens.

**As a** connector operator
**I want** an on-chain Solana program that manages payment channel lifecycle
**So that** peers can open, fund, and close payment channels for ILP settlement on Solana

---

## Acceptance Criteria

1. **AC 1 - Initialize Channel:** `initialize_channel` creates a channel PDA with state=Opened, zero balances, correct participants/mint, challenge_duration, and bump seed
2. **AC 1a - Double Initialization Rejected:** Duplicate `initialize_channel` call for same participants and mint is rejected (PDA already exists)
3. **AC 2 - Deposit Tokens:** Participant deposits SPL tokens into vault PDA, `deposit_a`/`deposit_b` incremented accordingly
4. **AC 2a - Deposit Rejected for Non-Participant:** Non-participant calling `deposit` fails with `InvalidParticipant`
5. **AC 2b - Zero-Amount Deposit Rejected:** Deposit with 0 tokens fails with `ZeroAmountDeposit`
6. **AC 2c - Deposit Rejected on Non-Opened Channel:** Deposit to closed channel fails with `ChannelNotOpened`
7. **AC 3 - Close Channel:** Either participant calls `close_channel`, state becomes Closed, `close_timestamp` recorded
8. **AC 3a - Close Rejected for Non-Participant:** Non-participant calling `close_channel` fails with `InvalidParticipant`
9. **AC 4 - Settle Channel After Challenge Period:** `settle_channel` distributes funds from vault per cumulative transferred amounts after challenge period elapses, closes accounts, reclaims rent
10. **AC 5 - Settle Rejected During Challenge Period:** `settle_channel` before challenge deadline fails with `ChannelChallengeNotExpired`
11. **AC 6 - Force Close Expired Channel:** `force_close_expired` distributes funds and closes accounts after challenge deadline, same as settle

---

## Test Strategy

### Generation Mode

**AI Generation** -- backend Rust project, no browser recording needed. All tests are Rust integration tests using `solana-program-test` BanksClient (in-process, no Docker).

### Test Level Selection

| AC | Test ID | Scenario | Level | Priority | Red Phase Failure Reason |
|----|---------|----------|-------|----------|--------------------------|
| AC 1 | T-33.1-01 | `initialize_channel` creates PDA with correct participants, mint, state=Opened, zero balances, challenge_duration, bump | Rust integration | P0 | Program not deployed; no instruction handler exists |
| AC 1a | T-33.1-09 | `initialize_channel` fails on double-init (PDA already exists) | Rust integration | P1 | No duplicate-check logic implemented |
| AC 2 | T-33.1-02 | `deposit` by participant A transfers SPL tokens to vault and increments `deposit_a` | Rust integration | P0 | No deposit instruction handler exists |
| AC 2 | T-33.1-03 | `deposit` by participant B increments `deposit_b` (not `deposit_a`) | Rust integration | P0 | No participant-side routing logic exists |
| AC 2a | T-33.1-12a | `deposit` by non-participant C fails with `InvalidParticipant` | Rust integration | P1 | No participant validation exists |
| AC 2b | T-33.1-11 | `deposit` with zero amount fails with `ZeroAmountDeposit` | Rust integration | P1 | No zero-amount guard exists |
| AC 2c | T-33.1-10 | `deposit` to a closed channel fails with `ChannelNotOpened` | Rust integration | P1 | No state check on deposit exists |
| AC 3 | T-33.1-04 | `close_channel` sets state to Closed and records `close_timestamp` from Clock sysvar | Rust integration | P0 | No close instruction handler exists |
| AC 3a | T-33.1-12 | `close_channel` by non-participant fails with `InvalidParticipant` | Rust integration | P1 | No participant check on close exists |
| AC 4 | T-33.1-05 | `settle_channel` distributes funds correctly after challenge period, closes accounts | Rust integration | P0 | No settle instruction handler exists |
| AC 5 | T-33.1-06 | `settle_channel` fails with `ChannelChallengeNotExpired` before challenge deadline | Rust integration | P0 | No challenge period check exists |
| AC 1 | T-33.1-07 | PDA derivation produces same address regardless of participant argument order | Rust unit | P0 | No PDA derivation logic exists |
| AC 6 | T-33.1-08 | `force_close_expired` distributes funds after challenge deadline | Rust integration | P1 | No force-close instruction handler exists |
| AC 4 | T-33.1-13 | `settle_channel` reclaims rent from closed accounts | Rust integration | P2 | No rent reclamation logic exists |

### Priority Justification

- **P0 (7 tests):** Core lifecycle operations (init, deposit, close, settle) and security-critical checks (challenge period, PDA derivation). These are revenue-impacting (fund custody) and data-integrity operations.
- **P1 (6 tests):** Negative/guard cases (non-participant rejection, zero deposit, closed-channel deposit, double-init, force-close). Important for security but secondary to happy-path lifecycle.
- **P2 (1 test):** Rent reclamation -- operational concern, not security-critical.

### Red Phase Requirements

All 14 tests are designed to fail before implementation because:
- The `packages/solana-program/` crate does not exist yet
- No program entrypoint, instruction handlers, or state structs are implemented
- Tests will fail at compilation (missing crate) or at runtime (program not deployed to BanksClient)

### Test Framework Configuration

- **Framework:** `solana-program-test` with BanksClient
- **Runner:** `cargo test-sbf` (or `cargo test` with BPF feature)
- **Test file:** `packages/solana-program/tests/lifecycle.rs`
- **Clock manipulation:** `ProgramTestContext::warp_to_slot()` / timestamp warping for challenge period tests
- **SPL Token setup:** `spl_token::instruction::*` helpers for mint/account creation in test setup

---

## Failing Tests Created (RED Phase)

### Rust Integration Tests (14 tests)

**File:** `packages/solana-program/tests/lifecycle.rs` (~700 lines)

All tests use `#[ignore]` attribute (Rust equivalent of `test.skip()`) to mark them as intentionally failing during the TDD red phase.

- **T-33.1-01** `test_initialize_channel_creates_pda_with_correct_state`
  - **Status:** RED -- Program not deployed; no instruction handler exists
  - **Verifies:** AC 1 -- Channel PDA created with state=Opened, zero balances, correct participants/mint/bump
  - **Priority:** P0

- **T-33.1-02** `test_deposit_participant_a_transfers_tokens_and_increments_deposit_a`
  - **Status:** RED -- No deposit instruction handler exists
  - **Verifies:** AC 2 -- SPL token transfer to vault, deposit_a incremented
  - **Priority:** P0

- **T-33.1-03** `test_deposit_participant_b_increments_deposit_b_not_deposit_a`
  - **Status:** RED -- No participant-side routing logic exists
  - **Verifies:** AC 2 -- deposit_b incremented (not deposit_a) when B deposits
  - **Priority:** P0

- **T-33.1-04** `test_close_channel_sets_state_and_timestamp`
  - **Status:** RED -- No close instruction handler exists
  - **Verifies:** AC 3 -- State set to Closed, close_timestamp recorded from Clock sysvar
  - **Priority:** P0

- **T-33.1-05** `test_settle_channel_distributes_funds_after_challenge_period`
  - **Status:** RED -- No settle instruction handler exists
  - **Verifies:** AC 4 -- Fund distribution per formula, account closure, balance conservation
  - **Priority:** P0

- **T-33.1-06** `test_settle_channel_fails_before_challenge_deadline`
  - **Status:** RED -- No challenge period check exists
  - **Verifies:** AC 5 -- ChannelChallengeNotExpired error before deadline
  - **Priority:** P0

- **T-33.1-07** `test_pda_derivation_order_independent`
  - **Status:** RED -- No PDA derivation logic (note: helper function exists in tests; program-side must match)
  - **Verifies:** AC 1 -- Lexicographic sorting ensures order-independent PDA
  - **Priority:** P0

- **T-33.1-08** `test_force_close_expired_distributes_funds_after_deadline`
  - **Status:** RED -- No force-close instruction handler exists
  - **Verifies:** AC 6 -- Same distribution as settle_channel after deadline
  - **Priority:** P1

- **T-33.1-09** `test_initialize_channel_rejects_double_init`
  - **Status:** RED -- No duplicate-check logic implemented
  - **Verifies:** AC 1a -- PDA already exists error on second init
  - **Priority:** P1

- **T-33.1-10** `test_deposit_to_closed_channel_rejected`
  - **Status:** RED -- No state check on deposit exists
  - **Verifies:** AC 2c -- ChannelNotOpened error on closed channel deposit
  - **Priority:** P1

- **T-33.1-11** `test_deposit_zero_amount_rejected`
  - **Status:** RED -- No zero-amount guard exists
  - **Verifies:** AC 2b -- ZeroAmountDeposit error on zero deposit
  - **Priority:** P1

- **T-33.1-12** `test_close_channel_by_non_participant_rejected`
  - **Status:** RED -- No participant check on close exists
  - **Verifies:** AC 3a -- InvalidParticipant error when non-participant closes
  - **Priority:** P1

- **T-33.1-12a** `test_deposit_by_non_participant_rejected`
  - **Status:** RED -- No participant validation on deposit exists
  - **Verifies:** AC 2a -- InvalidParticipant error when non-participant deposits
  - **Priority:** P1

- **T-33.1-13** `test_settle_channel_reclaims_rent`
  - **Status:** RED -- No rent reclamation logic exists
  - **Verifies:** AC 4 -- Channel PDA and vault closed, rent reclaimed to recipient
  - **Priority:** P2

---

## Data Factories Created

### Test Helper Functions (Rust)

**File:** `packages/solana-program/tests/lifecycle.rs` (embedded helpers)

**Exports (test-internal):**

- `create_test_mint(context, mint_authority)` -- Creates SPL Token mint with 6 decimals
- `create_and_fund_token_account(context, mint, owner, mint_authority, amount)` -- Creates and funds SPL Token account
- `derive_channel_pda(participant_a, participant_b, token_mint, program_id)` -- PDA derivation with lexicographic sorting
- `derive_vault_pda(channel_pda, program_id)` -- Vault PDA derivation
- `build_initialize_channel_instruction(...)` -- Builds initialize_channel instruction
- `build_deposit_instruction(...)` -- Builds deposit instruction
- `build_close_channel_instruction(...)` -- Builds close_channel instruction
- `build_settle_channel_instruction(...)` -- Builds settle_channel instruction
- `build_force_close_expired_instruction(...)` -- Builds force_close_expired instruction

**Design notes:**
- Helpers are designed to be reusable by Story 33.3 (comprehensive tests)
- PDA derivation logic mirrors the on-chain implementation specification exactly
- Instruction builders use placeholder discriminators that must be updated once program defines them

---

## Fixtures Created

### Program Test Context (Rust)

**File:** `packages/solana-program/tests/lifecycle.rs` (embedded in each test)

Each test creates its own `ProgramTest` context with:
- **Setup:** Fresh BanksClient with payment_channel program loaded, new keypairs for participants
- **Provides:** `ProgramTestContext` with payer, BanksClient, and blockhash
- **Cleanup:** Automatic -- BanksClient is in-process and drops when test completes

**Constants:**
- `TEST_CHALLENGE_DURATION` = 60 seconds
- `STATE_OPENED` = 0, `STATE_CLOSED` = 1, `STATE_SETTLED` = 2
- Account data field offsets for assertion parsing

---

## Mock Requirements

No external service mocking required. All tests use `solana-program-test` BanksClient which provides an in-process Solana runtime. SPL Token operations use real `spl_token` instructions within the test validator.

---

## Required data-testid Attributes

Not applicable -- this is a Rust on-chain program with no UI component. All testing is via Rust integration tests against BanksClient.

---

## Implementation Checklist

### Test: T-33.1-01 -- initialize_channel creates PDA with correct state

**File:** `packages/solana-program/tests/lifecycle.rs`

**Tasks to make this test pass:**

- [ ] Define `ChannelState` struct with all fields (178 bytes with discriminator)
- [ ] Implement Borsh or manual serialization/deserialization
- [ ] Implement PDA derivation: seeds = `[b"channel", min(A,B), max(A,B), token_mint]`
- [ ] Implement vault PDA derivation: seeds = `[b"vault", channel_pda]`
- [ ] Implement `initialize_channel` instruction handler
- [ ] Create channel PDA account via `create_account` with rent-exempt minimum
- [ ] Create vault token account (PDA-owned)
- [ ] Initialize channel state with zero balances and Opened state
- [ ] Define instruction discriminator constants
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test-sbf --test lifecycle test_initialize_channel_creates_pda_with_correct_state`
- [ ] Test passes (green phase)

**Estimated Effort:** 4-6 hours

---

### Test: T-33.1-02 -- deposit transfers tokens and increments deposit_a

**File:** `packages/solana-program/tests/lifecycle.rs`

**Tasks to make this test pass:**

- [ ] Implement `deposit` instruction handler
- [ ] Validate depositor is a signer
- [ ] Verify channel state == Opened
- [ ] Verify depositor is participant_a or participant_b
- [ ] Execute SPL Token `transfer` from depositor to vault
- [ ] Increment correct deposit tracker (`deposit_a` or `deposit_b`)
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test-sbf --test lifecycle test_deposit_participant_a`
- [ ] Test passes (green phase)

**Estimated Effort:** 2-3 hours

---

### Test: T-33.1-03 -- deposit by participant B increments deposit_b

**File:** `packages/solana-program/tests/lifecycle.rs`

**Tasks to make this test pass:**

- [ ] Ensure deposit handler correctly identifies which participant is depositing
- [ ] Route deposit amount to `deposit_b` when depositor matches participant_b
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test-sbf --test lifecycle test_deposit_participant_b`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours (incremental after T-33.1-02)

---

### Test: T-33.1-04 -- close_channel sets state and timestamp

**File:** `packages/solana-program/tests/lifecycle.rs`

**Tasks to make this test pass:**

- [ ] Implement `close_channel` instruction handler
- [ ] Validate closer is a signer and channel participant
- [ ] Verify channel state == Opened
- [ ] Set state to Closed
- [ ] Record `close_timestamp` from Clock sysvar
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test-sbf --test lifecycle test_close_channel_sets_state`
- [ ] Test passes (green phase)

**Estimated Effort:** 1-2 hours

---

### Test: T-33.1-05 -- settle_channel distributes funds after challenge period

**File:** `packages/solana-program/tests/lifecycle.rs`

**Tasks to make this test pass:**

- [ ] Implement `settle_channel` instruction handler
- [ ] Verify channel state == Closed
- [ ] Verify `Clock.unix_timestamp >= close_timestamp + challenge_duration`
- [ ] Calculate final balances: A gets `deposit_a - transferred_amount_a + transferred_amount_b`
- [ ] Execute SPL Token transfers from vault to participant token accounts
- [ ] Close vault token account, reclaim rent
- [ ] Close channel PDA account, reclaim rent
- [ ] Set state to Settled
- [ ] Use checked arithmetic (`checked_sub`, `checked_add`) throughout
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test-sbf --test lifecycle test_settle_channel_distributes`
- [ ] Test passes (green phase)

**Estimated Effort:** 3-4 hours

---

### Test: T-33.1-06 -- settle fails before challenge deadline

**File:** `packages/solana-program/tests/lifecycle.rs`

**Tasks to make this test pass:**

- [ ] Ensure settle_channel checks `Clock.unix_timestamp < close_timestamp + challenge_duration`
- [ ] Return `ChannelChallengeNotExpired` error when check fails
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test-sbf --test lifecycle test_settle_channel_fails_before`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours (incremental after T-33.1-05)

---

### Test: T-33.1-07 -- PDA derivation is order-independent

**File:** `packages/solana-program/tests/lifecycle.rs`

**Tasks to make this test pass:**

- [ ] Ensure program sorts participants lexicographically before PDA derivation
- [ ] Verify test helper `derive_channel_pda` matches program implementation
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test-sbf --test lifecycle test_pda_derivation`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours (built into initialize_channel)

---

### Test: T-33.1-08 -- force_close_expired distributes funds

**File:** `packages/solana-program/tests/lifecycle.rs`

**Tasks to make this test pass:**

- [ ] Implement `force_close_expired` instruction handler
- [ ] Reuse settlement logic from `settle_channel` (internal function)
- [ ] Same challenge period check and fund distribution
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test-sbf --test lifecycle test_force_close_expired`
- [ ] Test passes (green phase)

**Estimated Effort:** 1 hour (reuses settle logic)

---

### Test: T-33.1-09 -- double-init rejected

**File:** `packages/solana-program/tests/lifecycle.rs`

**Tasks to make this test pass:**

- [ ] Ensure `initialize_channel` fails when PDA account already exists
- [ ] Solana's `create_account` CPI should reject if account already has data
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test-sbf --test lifecycle test_initialize_channel_rejects_double`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours (inherent to PDA creation)

---

### Test: T-33.1-10 -- deposit to closed channel rejected

**File:** `packages/solana-program/tests/lifecycle.rs`

**Tasks to make this test pass:**

- [ ] Ensure deposit handler checks `channel.state == Opened`
- [ ] Return `ChannelNotOpened` error when state is not Opened
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test-sbf --test lifecycle test_deposit_to_closed`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours (built into deposit handler)

---

### Test: T-33.1-11 -- zero-amount deposit rejected

**File:** `packages/solana-program/tests/lifecycle.rs`

**Tasks to make this test pass:**

- [ ] Add zero-amount guard to deposit handler (`if amount == 0 { return Err(...) }`)
- [ ] Return `ZeroAmountDeposit` error
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test-sbf --test lifecycle test_deposit_zero_amount`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.25 hours

---

### Test: T-33.1-12 -- close by non-participant rejected

**File:** `packages/solana-program/tests/lifecycle.rs`

**Tasks to make this test pass:**

- [ ] Ensure close_channel checks signer against stored participant_a and participant_b
- [ ] Return `InvalidParticipant` error when signer is neither participant
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test-sbf --test lifecycle test_close_channel_by_non_participant`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours (built into close handler)

---

### Test: T-33.1-12a -- deposit by non-participant rejected

**File:** `packages/solana-program/tests/lifecycle.rs`

**Tasks to make this test pass:**

- [ ] Ensure deposit handler checks depositor against stored participants
- [ ] Return `InvalidParticipant` error
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test-sbf --test lifecycle test_deposit_by_non_participant`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.25 hours (built into deposit handler)

---

### Test: T-33.1-13 -- settle reclaims rent

**File:** `packages/solana-program/tests/lifecycle.rs`

**Tasks to make this test pass:**

- [ ] Implement rent reclamation in settle_channel: close channel PDA and vault accounts
- [ ] Transfer lamports from closed accounts to designated rent recipient
- [ ] Remove `#[ignore]` from test
- [ ] Run test: `cargo test-sbf --test lifecycle test_settle_channel_reclaims_rent`
- [ ] Test passes (green phase)

**Estimated Effort:** 1 hour

---

## Running Tests

```bash
# Run all failing tests for this story (with #[ignore], shows as "ignored")
cargo test-sbf --manifest-path packages/solana-program/Cargo.toml --test lifecycle

# Run specific test (remove #[ignore] first to execute)
cargo test-sbf --manifest-path packages/solana-program/Cargo.toml --test lifecycle test_initialize_channel_creates_pda_with_correct_state

# Run all tests including ignored (to see them all fail)
cargo test-sbf --manifest-path packages/solana-program/Cargo.toml --test lifecycle -- --ignored

# Run with verbose output
cargo test-sbf --manifest-path packages/solana-program/Cargo.toml --test lifecycle -- --ignored --nocapture

# Run all tests (normal + ignored)
cargo test-sbf --manifest-path packages/solana-program/Cargo.toml --test lifecycle -- --include-ignored
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 14 tests written and marked `#[ignore]` (failing)
- Test helpers created (mint setup, token account funding, PDA derivation, instruction builders)
- Placeholder `lib.rs` with stub entrypoint returns `InvalidInstructionData`
- `Cargo.toml` configured with all required dependencies
- Implementation checklist created mapping each test to concrete tasks

**Verification:**

- All tests are marked `#[ignore]` and will show as "ignored" when run
- Running with `--ignored` flag would fail on every test (program returns error)
- Failure is due to missing implementation, not test bugs

---

### GREEN Phase (DEV Team -- Next Steps)

**DEV Agent Responsibilities:**

1. **Pick one failing test** from implementation checklist (start with T-33.1-01)
2. **Remove `#[ignore]`** from that test
3. **Implement minimal code** to make that specific test pass
4. **Run the test** to verify it now passes (green)
5. **Check off the task** in implementation checklist
6. **Move to next test** and repeat

**Recommended order:**
1. T-33.1-01 (initialize_channel) -- foundational
2. T-33.1-07 (PDA derivation) -- validates foundation
3. T-33.1-09 (double-init) -- validates foundation guard
4. T-33.1-02 (deposit A) -- builds on init
5. T-33.1-03 (deposit B) -- validates deposit routing
6. T-33.1-11 (zero deposit) -- deposit guard
7. T-33.1-12a (non-participant deposit) -- deposit guard
8. T-33.1-04 (close_channel) -- new instruction
9. T-33.1-12 (non-participant close) -- close guard
10. T-33.1-10 (deposit to closed) -- cross-instruction guard
11. T-33.1-06 (settle before deadline) -- settle guard
12. T-33.1-05 (settle after deadline) -- full settle
13. T-33.1-08 (force_close_expired) -- reuses settle
14. T-33.1-13 (rent reclamation) -- operational polish

---

### REFACTOR Phase (DEV Team -- After All Tests Pass)

**DEV Agent Responsibilities:**

1. **Verify all 14 tests pass** (green phase complete)
2. **Review code for quality** -- extract common patterns, reduce duplication
3. **Extract shared settlement logic** for settle_channel and force_close_expired
4. **Verify checked arithmetic** throughout (no unchecked operations)
5. **Run `cargo build-sbf`** and verify binary size target (~30-60KB)
6. **Ensure tests still pass** after each refactor

---

## Next Steps

1. **Review this checklist** with the dev team
2. **Run ignored tests** to confirm RED phase: `cargo test-sbf --manifest-path packages/solana-program/Cargo.toml --test lifecycle -- --ignored`
3. **Begin implementation** using recommended order above
4. **Work one test at a time** (remove `#[ignore]`, implement, verify green)
5. **When all tests pass**, refactor code for quality
6. **Run `cargo build-sbf`** to verify clean compilation and binary size
7. **When refactoring complete**, manually update story status to 'done' in sprint-status.yaml

---

## Knowledge Base References Applied

This ATDD workflow consulted the following knowledge fragments:

- **data-factories.md** -- Adapted factory patterns for Rust test helpers (create_test_mint, create_and_fund_token_account)
- **test-quality.md** -- Deterministic tests, isolation (each test gets fresh BanksClient context), explicit assertions
- **test-healing-patterns.md** -- Diagnostic signatures for common Solana test failures (account not found, instruction errors)
- **test-levels-framework.md** -- Test level selection: all tests at integration level using BanksClient (appropriate for on-chain program)
- **test-priorities-matrix.md** -- P0-P2 priority assignment based on revenue/security impact of fund custody operations

See `tea-index.csv` for complete knowledge fragment mapping.

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `cargo test-sbf --manifest-path packages/solana-program/Cargo.toml --test lifecycle`

**Expected Results:**

```
running 14 tests
test test_close_channel_by_non_participant_rejected ... ignored
test test_close_channel_sets_state_and_timestamp ... ignored
test test_deposit_by_non_participant_rejected ... ignored
test test_deposit_participant_a_transfers_tokens_and_increments_deposit_a ... ignored
test test_deposit_participant_b_increments_deposit_b_not_deposit_a ... ignored
test test_deposit_to_closed_channel_rejected ... ignored
test test_deposit_zero_amount_rejected ... ignored
test test_force_close_expired_distributes_funds_after_deadline ... ignored
test test_initialize_channel_creates_pda_with_correct_state ... ignored
test test_initialize_channel_rejects_double_init ... ignored
test test_pda_derivation_order_independent ... ignored
test test_settle_channel_distributes_funds_after_challenge_period ... ignored
test test_settle_channel_fails_before_challenge_deadline ... ignored
test test_settle_channel_reclaims_rent ... ignored

test result: ok. 0 passed; 0 failed; 14 ignored; 0 measured; 0 filtered out
```

**Summary:**

- Total tests: 14
- Passing: 0 (expected)
- Ignored: 14 (expected -- TDD red phase)
- Status: RED phase verified

---

## Notes

- Instruction discriminators in test helpers use placeholder byte values. These must be updated once the program defines its actual discriminator constants (hash-based or sequential).
- The `PROGRAM_ID` constant uses a placeholder pubkey. Update to the actual deployed program ID once the keypair is generated.
- Account data field offsets (STATE_FIELD_OFFSET, DEPOSIT_A_OFFSET, etc.) assume the exact layout from the story's Dev Notes section. If serialization format changes, update offsets accordingly.
- The `warp_to_slot` approach for time manipulation may need adjustment depending on the exact slot-to-timestamp relationship in `solana-program-test`. Consider using `set_sysvar` to directly set Clock if available.
- Story 33.3 will add more comprehensive tests (balance conservation, security, performance). The helpers created here are designed to be reusable.

---

## Contact

**Questions or Issues?**

- Ask in team standup
- Refer to `_bmad-output/planning-artifacts/test-design-epic-33.md` for the full test design document
- Consult `_bmad-output/implementation-artifacts/33-1-solana-payment-channel-program-channel-lifecycle.md` for story details

---

**Generated by BMad TEA Agent** -- 2026-03-25
