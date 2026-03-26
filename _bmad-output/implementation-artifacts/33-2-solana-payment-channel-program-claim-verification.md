# Story 33.2: Solana Payment Channel Program — Claim Verification

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **connector operator**,
I want **the on-chain program to verify Ed25519-signed balance proofs**,
so that **peers can submit claims that update the channel's cumulative transferred amounts**.

**Epic:** 33 — Solana Payment Channel Provider
**Priority:** P0 (all subsequent stories depend on claim verification working correctly)
**Estimated effort:** 2-3 dev days
**Dependencies:** Story 33.1 (done — channel lifecycle program exists)

## Acceptance Criteria

### AC 1: Valid Claim Updates Channel State

```gherkin
Scenario: Valid claim with correct Ed25519 signature updates channel state
  Given an open channel between A and B with nonce_a = 5
  When a valid claim is submitted with A's signature, nonce = 6, transferred_amount = 5000
  Then the channel's nonce_a is updated to 6
  And transferred_amount_a is updated to 5000
  And the channel remains in Opened state
```

### AC 2: Replay Attack Rejected (Same Nonce)

```gherkin
Scenario: Claim with replayed nonce is rejected
  Given an open channel between A and B with nonce_a = 5
  When a claim is submitted with nonce = 5 (replay)
  Then the instruction fails with NonceNotMonotonic error (custom error code 6)
```

### AC 3: Stale Nonce Rejected

```gherkin
Scenario: Claim with stale nonce is rejected
  Given an open channel between A and B with nonce_a = 5
  When a claim is submitted with nonce = 4 (stale)
  Then the instruction fails with NonceNotMonotonic error (custom error code 6)
```

### AC 4: Invalid Signature Rejected

```gherkin
Scenario: Claim with invalid Ed25519 signature is rejected
  Given an open channel
  When a claim is submitted with an invalid Ed25519 signature
  Then the instruction fails with InvalidSignature error (custom error code 8)
```

### AC 5: Unauthorized Signer Rejected

```gherkin
Scenario: Claim signed by non-participant keypair is rejected
  Given an open channel between A and B
  When a claim is submitted signed by keypair C (not a participant)
  Then the instruction fails with UnauthorizedSigner error (custom error code 9)
```

### AC 6: Transferred Amount Decrease Rejected

```gherkin
Scenario: Claim with decreased transferred amount is rejected
  Given an open channel with transferred_amount_a = 5000
  When a valid claim is submitted with transferred_amount = 4000 (decrease)
  Then the instruction fails with TransferredAmountDecreased error (custom error code 7)
```

### AC 7: Claim Accepted During Challenge Period

```gherkin
Scenario: Claim accepted on a closed channel during challenge period
  Given a closed channel (state = Closed)
  When a valid claim is submitted
  Then the claim is accepted and channel state fields are updated
  (Claims can still update final balances during the challenge period)
```

### AC 8: Claim Rejected on Settled Channel

```gherkin
Scenario: Claim rejected on a settled channel
  Given a settled channel (account data zeroed after settlement)
  When a claim transaction is submitted referencing the former channel PDA
  Then the instruction fails because the account data is invalid
  Note: In the current implementation, settle_channel zeros the account data and
  reclaims rent, so the PDA no longer contains valid ChannelState. The handler
  should also explicitly reject state == Settled as a defensive check before
  deserialization would catch it.
```

### AC 9: Balance Proof Message Format

```gherkin
Scenario: Balance proof message format is exactly 48 bytes
  Given a channel PDA, nonce, and transferred_amount
  When a balance proof is constructed
  Then the signed message is exactly: channel_pda (32 bytes) || nonce (8 bytes LE) || transferred_amount (8 bytes LE)
  And the total message size is 48 bytes
```

### AC 10: Multiple Sequential Claims Succeed

```gherkin
Scenario: Multiple valid claims with increasing nonces all succeed
  Given an open channel with nonce_a = 0
  When claims are submitted sequentially with nonces 1, 2, 3
  Then each claim updates the channel state correctly
  And the final nonce_a = 3
```

### AC 11: Missing Ed25519 Precompile Instruction Rejected

```gherkin
Scenario: Claim without Ed25519 precompile instruction in transaction is rejected
  Given an open channel between A and B
  When a claim_from_channel instruction is submitted without an Ed25519 precompile instruction at index 0
  Then the instruction fails with InvalidSignature error (custom error code 8)
```

## Tasks / Subtasks

- [x] Task 1: Update `ClaimFromChannel` instruction variant to include parsed fields (AC: all)
  - [x] 1.1 Modify `PaymentChannelInstruction::ClaimFromChannel` in `instruction.rs` to carry `nonce: u64` and `transferred_amount: u64` parsed from instruction data (16 bytes after discriminator)
  - [x] 1.2 Update `unpack()` to parse `nonce` (8 bytes LE) and `transferred_amount` (8 bytes LE) from instruction data after the discriminator
  - [x] 1.3 Update the `match` arm in `processor.rs` to pass parsed fields to the handler

- [x] Task 2: Implement `process_claim_from_channel` handler (AC: 1, 2, 3, 5, 6, 7, 8, 10)
  - [x] 2.1 Define expected accounts list (see Dev Notes — Accounts Layout)
  - [x] 2.2 Validate channel PDA derivation against expected (reuse `derive_channel_pda`)
  - [x] 2.3 Reject if channel state == Settled (allow Opened and Closed)
  - [x] 2.4 Determine which participant the signer is (A or B); reject with `UnauthorizedSigner` if neither
  - [x] 2.5 Verify nonce is strictly greater than stored nonce for that participant; reject with `NonceNotMonotonic`
  - [x] 2.6 Verify transferred_amount >= stored transferred_amount for that participant; reject with `TransferredAmountDecreased`
  - [x] 2.7 Invoke Ed25519 precompile verification (Task 3)
  - [x] 2.8 Update `transferred_amount` and `nonce` for the claiming participant
  - [x] 2.9 Serialize updated state back to the channel account

- [x] Task 3: Implement Ed25519 precompile introspection (AC: 4, 9, 11)
  - [x] 3.1 Load the Instructions sysvar account (`Sysvar1nstructions1111111111111111111111111`)
  - [x] 3.2 Use `solana_program::sysvar::instructions::load_instruction_at_checked()` to read the Ed25519 precompile instruction at expected index (index 0 in the transaction)
  - [x] 3.3 Verify the loaded instruction's program_id is `Ed25519Program` (`ed25519_program::id()`)
  - [x] 3.4 Parse the Ed25519 instruction data to extract: num_signatures, public_key, signature, message
  - [x] 3.5 Verify the public_key matches the signer (channel participant)
  - [x] 3.6 Verify the message matches the expected balance proof: `channel_pda (32) || nonce (8 LE) || transferred_amount (8 LE)`
  - [x] 3.7 The Ed25519 precompile itself validates the signature — if the transaction succeeds, the signature is valid. Our job is to verify the precompile instruction was present with correct parameters.
  - [x] 3.8 Handle missing or malformed precompile instruction gracefully with `InvalidSignature` error

- [x] Task 4: Write tests (AC: all)
  - [x] 4.1 Test: Valid claim updates nonce and transferred_amount (T-33.2-01)
  - [x] 4.2 Test: Replayed nonce fails with `NonceNotMonotonic` (T-33.2-02)
  - [x] 4.3 Test: Stale nonce fails with `NonceNotMonotonic` (T-33.2-03)
  - [x] 4.4 Test: Invalid signature fails with `InvalidSignature` (T-33.2-04)
  - [x] 4.5 Test: Non-participant signer fails with `UnauthorizedSigner` (T-33.2-05)
  - [x] 4.6 Test: Decreased transferred_amount fails with `TransferredAmountDecreased` (T-33.2-06)
  - [x] 4.7 Test: Claim on closed channel succeeds (T-33.2-07)
  - [x] 4.8 Test: Claim on settled channel fails (T-33.2-11)
  - [x] 4.9 Test: Multiple sequential claims with increasing nonces (T-33.2-10)
  - [x] 4.10 Test: Balance proof message is exactly 48 bytes with correct format (T-33.2-12)
  - [x] 4.11 Test: Ed25519 precompile instruction missing from transaction fails with `InvalidSignature` (T-33.2-08)
  - [x] 4.12 Test: Ed25519 precompile instruction at wrong index fails (T-33.2-09)
  - [x] 4.13 Test: Claim from participant B updates nonce_b and transferred_amount_b (not A's fields)

## Dev Notes

### This is a Rust On-Chain Program

All work is in `packages/solana-program/`. This is NOT TypeScript. The test file goes in `packages/solana-program/tests/claims.rs` (separate from the lifecycle tests in `tests/lifecycle.rs`).

### Files to Modify

| File | Change |
|------|--------|
| `packages/solana-program/src/instruction.rs` | Update `ClaimFromChannel` variant to carry `nonce: u64, transferred_amount: u64`; update `unpack()` parsing |
| `packages/solana-program/src/processor.rs` | Replace stub with `process_claim_from_channel` handler; update match arm to pass parsed fields |
| `packages/solana-program/Cargo.toml` | Added `ed25519-dalek = "=1.0.1"` dev-dependency (v1.x required for solana-sdk 2.1.0 compatibility) |
| `packages/solana-program/src/lib.rs` | No changes expected (modules already wired) |
| `packages/solana-program/src/error.rs` | No changes needed (error codes 6-9 already defined in Story 33.1) |
| `packages/solana-program/src/state.rs` | No changes needed (nonce/transferred_amount fields already in ChannelState) |

### New Files

| File | Purpose |
|------|---------|
| `packages/solana-program/tests/claims.rs` | All claim verification tests (T-33.2-01 through T-33.2-12) |

### Accounts Layout for `claim_from_channel`

```
Accounts:
  0. [signer]    claimer        — the participant submitting the claim (must be participant_a or participant_b)
  1. [writable]  channel_pda    — the channel state account to update
  2. []          instructions   — Instructions sysvar (Sysvar1nstructions1111111111111111111111111)
```

**Note:** The claimer is the participant whose signature is on the balance proof. The channel PDA must be writable because we update `nonce` and `transferred_amount`. The Instructions sysvar is read-only (we introspect the Ed25519 precompile instruction from it).

### Ed25519 Precompile Introspection Pattern

The Solana Ed25519 precompile (`Ed25519SigVerify111111111111111111111111111`) verifies Ed25519 signatures as a native program. It does NOT run in our program — it runs as a separate instruction in the same transaction.

**Transaction structure:**
```
Transaction {
  instructions: [
    Instruction 0: Ed25519 precompile (signature verification)
    Instruction 1: claim_from_channel (our program)
  ]
}
```

**Our program's job:**
1. Load the Instructions sysvar
2. Read instruction at index 0
3. Verify it is an Ed25519 precompile instruction
4. Parse the precompile instruction data to extract public_key, message, and signature
5. Verify the public_key matches the claimer
6. Verify the message matches `channel_pda || nonce || transferred_amount`
7. If the transaction executed successfully, the precompile already verified the signature is valid

**Ed25519 precompile instruction data format:**

```rust
// Ed25519 instruction data layout:
// [0]      num_signatures: u8
// [1]      padding: u8
// [2..4]   signature_offset: u16 LE
// [4..6]   signature_instruction_index: u16 LE (0xFFFF = current instruction)
// [6..8]   public_key_offset: u16 LE
// [8..10]  public_key_instruction_index: u16 LE (0xFFFF = current instruction)
// [10..12] message_data_offset: u16 LE
// [12..14] message_data_size: u16 LE
// [14..16] message_instruction_index: u16 LE (0xFFFF = current instruction)
// Then: signature bytes (64), public key bytes (32), message bytes (variable)
//
// For our use case: num_signatures = 1, all data in same instruction (0xFFFF)
```

**Key Solana APIs to use:**
```rust
use solana_program::sysvar::instructions::{
    load_instruction_at_checked,  // Load instruction from sysvar
};
use solana_program::ed25519_program;  // Ed25519 program ID
```

**CRITICAL:** The Ed25519 precompile instruction index is expected to be 0 (first instruction in the transaction). Verify this explicitly. If the precompile is at a different index or missing, fail with `InvalidSignature`.

### Balance Proof Message Format

```
channel_pda (32 bytes) || nonce (8 bytes LE) || transferred_amount (8 bytes LE)
```

Total: 48 bytes. This is the message that gets signed by the participant's Ed25519 keypair. The format must match exactly between:
- On-chain verification (this story)
- TypeScript SDK signing (Story 33.4 — `signBalanceProof()`)

### Error Codes Already Defined (from Story 33.1)

All needed error codes exist in `error.rs`:
- `NonceNotMonotonic = 6` — nonce not strictly increasing
- `TransferredAmountDecreased = 7` — transferred amount went down
- `InvalidSignature = 8` — Ed25519 verification failed or precompile not found
- `UnauthorizedSigner = 9` — signer is not a channel participant

Do NOT add new error codes unless absolutely necessary.

### Channel State Fields Updated by `claim_from_channel`

For participant A claiming:
- `nonce_a` = new nonce (must be > current `nonce_a`)
- `transferred_amount_a` = new transferred_amount (must be >= current `transferred_amount_a`)

For participant B claiming:
- `nonce_b` = new nonce (must be > current `nonce_b`)
- `transferred_amount_b` = new transferred_amount (must be >= current `transferred_amount_b`)

The instruction does NOT change:
- `state` (stays Opened or Closed)
- `deposit_a`, `deposit_b`
- Other participant's nonce/transferred_amount

### State Offsets (from state.rs)

These are the byte offsets in the account data for the fields this instruction writes:
- `TRANSFERRED_AMOUNT_A_OFFSET = 120` (8 bytes)
- `TRANSFERRED_AMOUNT_B_OFFSET = 128` (8 bytes)
- `NONCE_A_OFFSET = 136` (8 bytes)
- `NONCE_B_OFFSET = 144` (8 bytes)

You can write directly at these offsets OR deserialize/serialize the full ChannelState. Both approaches work — existing instructions use full deserialize/serialize via `ChannelState::deserialize()` and `ChannelState::serialize()`.

### Test Approach

- **Framework:** `solana-program-test` BanksClient (in-process, no Docker)
- **Test file:** `packages/solana-program/tests/claims.rs`
- **Reuse test helpers** from `tests/lifecycle.rs` — extract common setup functions (create mint, create token accounts, initialize channel, deposit) into a shared helper module or duplicate them in claims.rs
- **Ed25519 signing in tests:** Use `ed25519_dalek` crate or `solana_sdk::signature::Keypair` (which uses Ed25519 internally) to sign balance proofs in test code
- **Constructing Ed25519 precompile instruction:** Use `solana_sdk::ed25519_instruction::new_ed25519_instruction()` to build the precompile instruction with the signed message
- **Transaction ordering:** The Ed25519 precompile instruction MUST be at index 0, followed by the `claim_from_channel` instruction at index 1

**Test setup pattern:**
```rust
// 1. Initialize channel (reuse lifecycle helpers)
// 2. Deposit tokens (reuse lifecycle helpers)
// 3. Construct balance proof message: channel_pda || nonce || transferred_amount
// 4. Sign message with participant's keypair
// 5. Build Ed25519 precompile instruction via new_ed25519_instruction()
// 6. Build claim_from_channel instruction
// 7. Send transaction with both instructions [precompile, claim]
// 8. Verify channel state was updated correctly
```

**Add to Cargo.toml dev-dependencies (if not already present):**
```toml
[dev-dependencies]
ed25519-dalek = "=1.0.1"  # Must use v1.x for compatibility with solana-sdk 2.1.0's ed25519-dalek dependency
```
> **Note:** The original spec suggested `ed25519-dalek = "2"` but solana-sdk 2.1.0 depends on ed25519-dalek 1.x internally. Using v2 would cause type incompatibilities with `new_ed25519_instruction()`. Pinned to `=1.0.1` for compatibility.

### Previous Story (33.1) Intelligence

Key learnings from Story 33.1 implementation:
- **Binary size:** 95KB (above 30-60KB target but acceptable — no Anchor used)
- **Serialization:** Manual byte-level serialization (not Borsh) — maintain this pattern
- **Account validation pattern:** Every instruction validates PDA derivation, signer, and system program/token program identity
- **Test pattern:** Each test creates a fresh `ProgramTest` context, sets up mint/token accounts, initializes channel, then tests the specific instruction
- **Clock manipulation:** Use `context.warp_to_slot()` with appropriate timestamp for time-dependent tests
- **Solana CLI version:** 3.1.12 (upgraded from 2.1.0 for edition2024 compatibility)
- **All 14 lifecycle tests pass** — run `cargo test-sbf` to verify no regressions

### Project Structure Notes

- Code lives in `packages/solana-program/src/` (Rust crate)
- Tests in `packages/solana-program/tests/` (Rust integration tests)
- Build: `cargo build-sbf` (from `packages/solana-program/`)
- Test: `cargo test-sbf` (runs all tests including lifecycle.rs and the new claims.rs)
- Makefile targets: `make solana-build`, `make solana-test`

### Cross-Story Dependencies

- **Story 33.3** will add comprehensive security and edge-case tests on top of this — keep test helpers modular
- **Story 33.4** will build the TypeScript SDK that calls `claim_from_channel` — the balance proof message format `channel_pda || nonce || transferred_amount` MUST match exactly
- **Story 33.5** will implement `SolanaPaymentChannelProvider` that delegates to the SDK — error codes must be stable

### Git Intelligence

- Branch: `epic-33` (current)
- Last commit: `bdced7b feat(33-1): Solana payment channel program — channel lifecycle`
- Commit convention: `feat(33-2): <description>`
- All existing lifecycle tests must still pass after this change

### References

- [Source: _bmad-output/planning-artifacts/epic-33-solana-payment-channel-provider.md#Story 33.2]
- [Source: _bmad-output/planning-artifacts/architecture.md#Section 8 Settlement Architecture]
- [Source: _bmad-output/planning-artifacts/architecture.md#Fraud Detection (Multi-Chain)]
- [Source: _bmad-output/planning-artifacts/test-design-epic-33.md#Story 33.2]
- [Source: _bmad-output/project-context.md#Chain Abstraction Layer]
- [Source: packages/solana-program/src/instruction.rs — CLAIM_FROM_CHANNEL discriminator]
- [Source: packages/solana-program/src/error.rs — error codes 6-9]
- [Source: packages/solana-program/src/processor.rs — stub at line 43-47]
- [Source: packages/solana-program/src/state.rs — field offsets for nonce and transferred_amount]

## Preconditions

- Story 33.1 is complete — channel lifecycle program exists in `packages/solana-program/`
- All 14 lifecycle tests pass (`cargo test-sbf`)
- Error codes 6-9 and `CLAIM_FROM_CHANNEL` discriminator already defined
- Branch `epic-33` is current with commit `bdced7b`

## Out of Scope

- TypeScript SDK wrapping `claim_from_channel` (Story 33.4)
- Comprehensive security and deployment tests beyond this story's AC (Story 33.3)
- `SolanaPaymentChannelProvider` implementation (Story 33.5)
- Solana claim message types in BTP (Story 33.6)
- Integration and E2E tests (Story 33.7)
- Token-2022 support (explicitly deferred)

## Test Plan

Reference: [Source: _bmad-output/planning-artifacts/test-design-epic-33.md#Story 33.2]

| Test ID   | Scenario                                                                              | Type      | Priority |
| --------- | ------------------------------------------------------------------------------------- | --------- | -------- |
| T-33.2-01 | Valid claim with correct Ed25519 signature updates nonce and transferred_amount        | Rust integration | P0       |
| T-33.2-02 | Claim with replayed nonce (nonce == stored) fails with `NonceNotMonotonic`             | Rust integration | P0       |
| T-33.2-03 | Claim with stale nonce (nonce < stored) fails with `NonceNotMonotonic`                 | Rust integration | P0       |
| T-33.2-04 | Claim with invalid Ed25519 signature fails with `InvalidSignature`                    | Rust integration | P0       |
| T-33.2-05 | Claim signed by non-participant keypair fails with `UnauthorizedSigner`                | Rust integration | P0       |
| T-33.2-06 | Claim with decreased transferred_amount fails with `TransferredAmountDecreased`        | Rust integration | P0       |
| T-33.2-07 | Claim on closed channel succeeds (during challenge period)                             | Rust integration | P0       |
| T-33.2-08 | Ed25519 precompile instruction missing from transaction fails with `InvalidSignature`  | Rust integration | P1       |
| T-33.2-09 | Ed25519 precompile instruction at wrong index fails                                    | Rust integration | P1       |
| T-33.2-10 | Multiple sequential claims with increasing nonces all succeed                          | Rust integration | P1       |
| T-33.2-11 | Claim on settled channel fails                                                         | Rust integration | P1       |
| T-33.2-12 | Balance proof message format is exactly 48 bytes (channel_pda || nonce || amount)       | Rust integration | P0       |

### Regression Gate

- `cargo build-sbf` compiles successfully with no warnings
- `cargo test-sbf` passes ALL tests — both `tests/lifecycle.rs` (existing 14 tests) and `tests/claims.rs` (new tests)
- No TypeScript code changes in this story — existing TS tests unaffected

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed — comprehensive developer guide created
- Task 1: Updated `ClaimFromChannel` enum variant to carry `nonce: u64` and `transferred_amount: u64`; updated `unpack()` to parse 16 bytes (two u64 LE) after discriminator
- Task 2: Implemented `process_claim_from_channel` handler — validates channel PDA, rejects Settled state, identifies participant (A or B), enforces monotonic nonce, enforces non-decreasing transferred_amount, delegates Ed25519 verification, updates per-participant state fields
- Task 3: Implemented `verify_ed25519_precompile` — loads instruction at index 0 via Instructions sysvar, verifies Ed25519 program ID, parses precompile data offsets, validates public key matches claimer, validates message matches expected 48-byte balance proof format
- Task 4: All 13 claim verification tests pass (T-33.2-01 through T-33.2-12 plus participant B test); all 19 existing lifecycle tests pass with no regressions

### File List

- `packages/solana-program/src/instruction.rs` — modified (ClaimFromChannel variant + unpack)
- `packages/solana-program/src/processor.rs` — modified (match arm + process_claim_from_channel + verify_ed25519_precompile)
- `packages/solana-program/tests/claims.rs` — modified (rewrote RED phase stubs with GREEN phase implementation)
- `packages/solana-program/Cargo.toml` — modified (added ed25519-dalek dev-dependency)
- `packages/solana-program/Cargo.lock` — auto-generated (dependency resolution for ed25519-dalek)

### Change Log

| Date | Summary |
| ---- | ------- |
| 2026-03-25 | Implemented claim_from_channel instruction with Ed25519 precompile introspection, balance proof verification, and 13 integration tests. All 32 tests pass (13 claims + 19 lifecycle). |
| 2026-03-25 | Code review 1: 0 critical, 0 high, 3 medium, 2 low issues found. Fixed: heap Vec replaced with fixed [u8;48] array in verify_ed25519_precompile, added clarifying comment for Settled state error reuse, updated File List to include Cargo.toml, documented ed25519-dalek v1.0.1 version choice. |
| 2026-03-25 | Code review 2: 0 critical, 0 high, 2 medium, 2 low issues found. Fixed: added Ed25519 instruction index validation (signature/pubkey/message indices must be 0xFFFF) for defense-in-depth, updated processor.rs header comment to include claim_from_channel, added Cargo.lock to File List. |

## Code Review Record

| Review | Date | Reviewer Model | Critical | High | Medium | Low | Outcome |
| ------ | ---- | -------------- | -------- | ---- | ------ | --- | ------- |
| 1 | 2026-03-25 | Claude Opus 4.6 (1M context) | 0 | 0 | 3 | 2 | Approved with fixes applied |
| 2 | 2026-03-25 | Claude Opus 4.6 (1M context) | 0 | 0 | 2 | 2 | Approved with fixes applied |
| 3 | 2026-03-25 | Claude Opus 4.6 (1M context) | 0 | 0 | 0 | 0 | Clean pass — no issues found, no files changed |
