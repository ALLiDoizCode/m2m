# Story 34.2: Mina Payment Channel zkApp — ZK-Private Claims

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **connector operator**,
I want **a `claimFromChannel()` method on the Mina zkApp that allows cooperative balance updates using zk-SNARK proofs without revealing actual amounts on-chain**,
so that **peers can settle ILP claims privately -- neither on-chain observers nor transport intermediaries can determine transferred amounts**.

**Epic:** 34 — Mina Protocol Payment Channel Provider (ZK-Private Settlement)
**Priority:** P0 (core privacy feature; Stories 34.3-34.9 depend on this)
**Estimated effort:** 3-5 dev days
**Dependencies:** Story 34.1 (done -- PaymentChannel zkApp with lifecycle methods)

## Acceptance Criteria

### AC 1: Valid Claim Updates Balance Commitment and Nonce

```gherkin
Scenario: Cooperative balance update via zk-SNARK proof
  Given an OPEN channel with a known balance commitment
  When a valid claimFromChannel proof is submitted with new balances that sum to depositTotal
  Then the on-chain balanceCommitment updates to the new Poseidon commitment
  And the on-chain nonceField updates to the new nonce
```

### AC 2: Conservation Violation Rejected

```gherkin
Scenario: Claim with balances that do not sum to depositTotal is rejected
  Given an OPEN channel
  When a claimFromChannel proof is submitted where new_balance_a + new_balance_b != depositTotal
  Then the proof fails to verify and the transaction is rejected
```

### AC 3: Non-Negativity Violation Rejected

```gherkin
Scenario: Claim with negative balance is rejected
  Given an OPEN channel
  When a claimFromChannel proof is submitted with new_balance_a < 0 (as a large Field near modulus)
  Then the proof fails to verify and the transaction is rejected
```

### AC 4: Nonce Monotonicity Enforced

```gherkin
Scenario: Claim with stale or equal nonce is rejected
  Given an OPEN channel with current nonce N
  When a claimFromChannel proof is submitted with new_nonce <= N
  Then the proof fails to verify and the transaction is rejected
```

### AC 5: Dual-Party Authorization Required

```gherkin
Scenario: Claim without valid signatures from both participants is rejected
  Given an OPEN channel
  When a claimFromChannel proof is submitted with an invalid signature from participant A or B
  Then the proof fails to verify and the transaction is rejected
```

### AC 6: Privacy -- On-Chain State Reveals No Balances

```gherkin
Scenario: Actual balances are not recoverable from on-chain state
  Given a successful claimFromChannel transaction
  When an observer inspects the on-chain state
  Then only the balanceCommitment hash and nonce are visible
  And actual balances (newBalanceA, newBalanceB, salt) are NOT recoverable from on-chain data
```

### AC 7: Channel Remains OPEN After Claim

```gherkin
Scenario: Cooperative claim does not close the channel
  Given an OPEN channel after a successful claim
  When the channel state is inspected
  Then channelState remains OPEN (channel is not closed by a claim)
```

### AC 8: Commitment Mismatch Rejected

```gherkin
Scenario: Claim where computed commitment does not match provided commitment
  Given an OPEN channel
  When a claimFromChannel proof is submitted where Poseidon(newBalanceA, newBalanceB, newSalt) != newBalanceCommitment
  Then the transaction is rejected
```

### AC 9: Participant Key Verification Against channelHash

```gherkin
Scenario: Claim with participant keys that do not match stored channelHash is rejected
  Given an OPEN channel with channelHash = Poseidon(participantA.x, participantB.x, channelNonce)
  When a claimFromChannel proof is submitted with incorrect participantA, participantB, or channelNonce
  Then the proof fails to verify and the transaction is rejected
```

## Tasks / Subtasks

- [x] Task 1: Implement `claimFromChannel()` method on `PaymentChannel` zkApp (AC: 1-9)
  - [x] 1.1 Add `@method async claimFromChannel(newBalanceA, newBalanceB, newSalt, signatureA, signatureB, newBalanceCommitment, newNonce, participantA, participantB, channelNonce)` to `PaymentChannel.ts` (10 params -- see Dev Notes for full signature)
  - [x] 1.2 Implement circuit constraint: `channelState.assertEquals(CHANNEL_STATE.OPEN)` (AC: 7)
  - [x] 1.3 Implement circuit constraint: commitment validity -- `Poseidon.hash([newBalanceA, newBalanceB, newSalt]).assertEquals(newBalanceCommitment)` (AC: 1, 8)
  - [x] 1.4 Implement circuit constraint: conservation -- `newBalanceA.add(newBalanceB).assertEquals(depositTotal)` (AC: 2)
  - [x] 1.5 Implement circuit constraint: non-negativity -- `newBalanceA.assertGreaterThanOrEqual(Field(0))` and same for `newBalanceB`, plus range checks `assertLessThanOrEqual(depositTotal)` to prevent modular arithmetic exploits (AC: 3)
  - [x] 1.6 Implement circuit constraint: monotonic nonce -- `newNonce.assertGreaterThan(currentNonce)` (AC: 4)
  - [x] 1.7 Implement circuit constraint: channelHash binding -- `Poseidon.hash([participantA.x, participantB.x, channelNonce]).assertEquals(storedChannelHash)` (AC: 5, 9)
  - [x] 1.8 Implement circuit constraint: authorization -- `signatureA.verify(participantA, message).assertTrue()` and same for signatureB over `[newBalanceCommitment, newNonce, channelHash]` (AC: 5)
  - [x] 1.9 Update on-chain state: `balanceCommitment.set(newBalanceCommitment)` and `nonceField.set(newNonce)` (AC: 1)
  - [x] 1.10 Read `channelHash` with `getAndRequireEquals()` for precondition binding (security)
  - [x] 1.11 Read `depositTotal` with `getAndRequireEquals()` for conservation check (security)

- [x] Task 2: Add nonce and balance range checks for safety (AC: 3, 4)
  - [x] 2.1 Add `newNonce.assertLessThanOrEqual(MAX_SAFE_AMOUNT)` to prevent Field overflow on nonce values
  - [x] 2.2 Add `newBalanceA.assertLessThanOrEqual(MAX_SAFE_AMOUNT)` and same for `newBalanceB` for defense-in-depth (matches deposit() pattern from Story 34.1 review #3)

- [x] Task 3: Add any new assertion messages to `constants.ts` (AC: all)
  - [x] 3.1 Add `INVALID_SIGNATURE_A` and `INVALID_SIGNATURE_B` messages for dual-party authorization failures
  - [x] 3.2 Add `NONCE_EXCEEDS_SAFE_RANGE` message for nonce overflow protection
  - [x] 3.3 Verify existing messages (`NONCE_MUST_INCREASE`, `BALANCE_CONSERVATION_VIOLATED`, `BALANCE_EXCEEDS_DEPOSIT`, `CHANNEL_HASH_MISMATCH`) are reusable for claim context

- [x] Task 4: Write unit tests with `proofsEnabled: false` (AC: 1-9)
  - [x] 4.1 T-34.2-01: Valid claim updates balanceCommitment and nonceField (AC: 1)
  - [x] 4.2 T-34.2-02: Claim with conservation violation rejected (AC: 2)
  - [x] 4.3 T-34.2-03: Claim with non-negativity violation rejected (AC: 3)
  - [x] 4.4 T-34.2-04: Claim with stale nonce rejected (AC: 4)
  - [x] 4.5 T-34.2-05: Claim with invalid signature A rejected (AC: 5)
  - [x] 4.6 T-34.2-06: Claim with invalid signature B rejected (AC: 5)
  - [x] 4.7 T-34.2-07: After claim, on-chain state reveals only commitment hash (AC: 6)
  - [x] 4.8 T-34.2-08: Channel remains OPEN after claim (AC: 7)
  - [x] 4.9 T-34.2-09: Multiple sequential claims with increasing nonces succeed (AC: 1, 4)
  - [x] 4.10 T-34.2-10: Claim on CLOSING channel is rejected (OPEN-only policy) (AC: 7)
  - [x] 4.11 T-34.2-11: Claim on SETTLED channel is rejected
  - [x] 4.12 T-34.2-12: Commitment mismatch rejected (AC: 8)
  - [x] 4.13 T-34.2-13: Claim with wrong participant keys (channelHash mismatch) rejected (AC: 9)

## Dev Notes

### This Extends the Existing PaymentChannel zkApp from Story 34.1

You are adding a NEW METHOD `claimFromChannel()` to the existing `PaymentChannel` class in `packages/mina-zkapp/src/PaymentChannel.ts`. Do NOT create a new file or class. The existing zkApp already has 8 state fields, 4 lifecycle methods, and all the imports you need.

### Method Signature (Final -- Option A with participant key verification)

The epic spec shows 7 parameters, but on-chain signature verification requires the participant public keys and channel nonce to verify against `channelHash`. The final signature has **10 parameters**:

```typescript
@method async claimFromChannel(
  // PRIVATE inputs -- not visible on-chain
  newBalanceA: Field,
  newBalanceB: Field,
  newSalt: Field,
  signatureA: Signature,
  signatureB: Signature,
  participantA: PublicKey,    // needed for signature verification + channelHash binding
  participantB: PublicKey,    // needed for signature verification + channelHash binding
  channelNonce: Field,        // needed for channelHash binding
  // PUBLIC inputs -- written to on-chain state
  newBalanceCommitment: Field,
  newNonce: Field,
): Promise<void>
```

**IMPORTANT:** In o1js, ALL `@method` parameters are circuit witnesses (private inputs to the proof). The distinction between "private" and "public" in the epic spec refers to what is stored on-chain: `newBalanceCommitment` and `newNonce` are written to on-chain state (visible), while `newBalanceA`, `newBalanceB`, `newSalt`, `participantA`, `participantB`, `channelNonce` are consumed only within the proof circuit (invisible on-chain). This is the core privacy mechanism.

**If the 10-parameter signature causes o1js circuit compilation issues** (too many constraints), fall back to 7 parameters and defer signature verification to the SDK (Story 34.4). Document the deferral.

### ZK Proof Circuit -- Six Invariants

The proof circuit must enforce ALL six of these properties. A missing constraint is a security vulnerability:

1. **Commitment validity:** `Poseidon.hash([newBalanceA, newBalanceB, newSalt]) == newBalanceCommitment`
2. **Conservation:** `newBalanceA + newBalanceB == depositTotal`
3. **Non-negativity:** `newBalanceA >= 0 AND newBalanceB >= 0` (plus range checks `<= depositTotal` to prevent modular arithmetic exploits, same pattern as `initiateClose`)
4. **Monotonic nonce:** `newNonce > currentNonce`
5. **Participant binding:** `Poseidon.hash([participantA.x, participantB.x, channelNonce]) == channelHash` (verifies supplied keys match stored channel identity)
6. **Authorization:** Both participants signed `[newBalanceCommitment, newNonce, channelHash]` (verified via `Signature.verify().assertTrue()`)

### Signature Verification Pattern

Story 34.1 deferred on-chain signature verification to the SDK level (Story 34.4). However, for `claimFromChannel`, **on-chain signature verification IS required** because the claim is the core privacy mechanism -- the proof must be self-contained. The signatures bind the claim to both participants' keys.

Since participant public keys are NOT stored on-chain (only `channelHash` is), the method accepts `participantA`, `participantB`, and `channelNonce` as additional private inputs and verifies them against `channelHash`. This makes the proof fully self-contained.

Implementation pattern:

```typescript
// 1. Read and bind channelHash
const storedChannelHash = this.channelHash.getAndRequireEquals();

// 2. Verify participant keys match channelHash (same pattern as settle())
const computedHash = Poseidon.hash([participantA.x, participantB.x, channelNonce]);
computedHash.assertEquals(storedChannelHash, ASSERT_MESSAGES.CHANNEL_HASH_MISMATCH);

// 3. Construct signed message
const message = [newBalanceCommitment, newNonce, storedChannelHash];

// 4. Verify both signatures (Signature.verify returns Bool -- call assertTrue)
signatureA.verify(participantA, message).assertTrue(ASSERT_MESSAGES.INVALID_SIGNATURE_A);
signatureB.verify(participantB, message).assertTrue(ASSERT_MESSAGES.INVALID_SIGNATURE_B);
```

This is the same `channelHash` verification pattern used in `settle()` (Story 34.1 review #2), so the developer can reference that method for the exact pattern.

### Assertion Messages -- Existing and New

Story 34.1 pre-defined some claim messages in `constants.ts`. The following are **already defined** and can be reused directly:

```typescript
// Already in constants.ts -- DO NOT duplicate
NONCE_MUST_INCREASE: 'nonce must be greater than current nonce',
INVALID_CLAIM_PROOF: 'claim proof verification failed',
BALANCE_CONSERVATION_VIOLATED: 'claim violates balance conservation invariant',
CHANNEL_MUST_BE_OPEN: 'channelState must be OPEN',
CHANNEL_HASH_MISMATCH: 'participant keys and nonce do not match stored channelHash',
BALANCE_EXCEEDS_DEPOSIT: 'individual balance must not exceed depositTotal',
```

The following **new messages must be added** to `ASSERT_MESSAGES` in `constants.ts`:

```typescript
// Story 34.2 -- NEW messages to add
INVALID_SIGNATURE_A: 'participant A signature verification failed',
INVALID_SIGNATURE_B: 'participant B signature verification failed',
NONCE_EXCEEDS_SAFE_RANGE: 'nonce exceeds safe range (max 2^64 - 1)',
```

Follow the established naming pattern (UPPER_SNAKE_CASE keys, descriptive string values).

### Range Checks for Modular Arithmetic Safety

Story 34.1 review #3 added `MAX_SAFE_AMOUNT` (2^64 - 1) range checks to `deposit()` to prevent Field arithmetic overflow. Apply the same pattern to `claimFromChannel`:

```typescript
import { MAX_SAFE_AMOUNT } from './constants';

// In claimFromChannel:
newBalanceA.assertLessThanOrEqual(currentDeposit, ASSERT_MESSAGES.BALANCE_EXCEEDS_DEPOSIT);
newBalanceB.assertLessThanOrEqual(currentDeposit, ASSERT_MESSAGES.BALANCE_EXCEEDS_DEPOSIT);
```

The `BALANCE_EXCEEDS_DEPOSIT` message and `MAX_SAFE_AMOUNT` constant already exist in `constants.ts`.

### Claim on CLOSING Channel -- Design Decision

The epic spec says claims keep the channel OPEN. Test T-34.2-10 asks about claims on a CLOSING channel. Two options:

- **Allow claims during CLOSING:** Enables balance updates during the challenge period (useful for dispute resolution). Requires channelState check to allow both OPEN and CLOSING.
- **Reject claims during CLOSING:** Simpler. Once close is initiated, no more balance updates.

**Recommended:** Allow claims only when `channelState == OPEN`. This matches the epic AC7 ("channelState remains OPEN") and keeps the state machine simple. A claim during CLOSING would need to reset the challenge period, which is out of scope.

### o1js Circuit Programming Reminders

From Story 34.1 dev notes -- these still apply:

- **No `if/else` in circuits** -- use `Provable.if(condition, trueValue, falseValue)` if needed
- **`Field` arithmetic is modular** -- range checks via `assertLessThanOrEqual` prevent overflow
- **`assertEquals` becomes a constraint** -- the prover must satisfy it; it does not throw at runtime in the same way
- **`getAndRequireEquals()`** -- reads on-chain state AND creates a precondition (mandatory for security)
- **Signature.verify returns a Bool** -- call `.assertTrue(message)` on the result to make it a circuit constraint

### Test File Location and Pattern

**Test file:** `packages/mina-zkapp/src/payment-channel-claims.test.ts` (NEW file per test design doc)

Follow the test setup pattern from Story 34.1's `payment-channel.test.ts`:

```typescript
import { Mina, PrivateKey, PublicKey, Field, Signature, Poseidon } from 'o1js';
import { PaymentChannel } from './PaymentChannel';
import { CHANNEL_STATE, ASSERT_MESSAGES } from './constants';

// Setup helper (reuse pattern from payment-channel.test.ts)
async function setupLocalBlockchain() {
  const Local = await Mina.LocalBlockchain({ proofsEnabled: false });
  Mina.setActiveInstance(Local);
  const [deployerAccount, participantAAccount, participantBAccount] = Local.testAccounts;
  return { Local, deployerAccount, participantAAccount, participantBAccount };
}

// Channel initialization helper (reuse from existing tests or extract)
async function initializeTestChannel(
  zkApp: PaymentChannel,
  zkAppKey: PrivateKey,
  deployer: Mina.TestPublicKey,
  participantA: Mina.TestPublicKey,
  participantB: Mina.TestPublicKey,
  depositAmount?: Field
): Promise<{ channelHash: Field; channelNonce: Field; depositTotal: Field }> {
  // Deploy, initialize, optionally deposit
  // Return channelHash, channelNonce, and depositTotal for claim construction
  // channelNonce is the nonce passed to initializeChannel (needed for channelHash binding)
}
```

**Negative test assertions:** Assert specific error message patterns (not bare `toThrow()`):

```typescript
await expect(txn.prove()).rejects.toThrow(ASSERT_MESSAGES.NONCE_MUST_INCREASE);
```

### Existing File Map (from Story 34.1)

| File | Status | What to do |
|------|--------|------------|
| `packages/mina-zkapp/src/PaymentChannel.ts` | EXISTS | Add `claimFromChannel()` method |
| `packages/mina-zkapp/src/constants.ts` | EXISTS | Add any new assertion messages |
| `packages/mina-zkapp/src/index.ts` | EXISTS | No changes needed (exports PaymentChannel class) |
| `packages/mina-zkapp/src/payment-channel.test.ts` | EXISTS | Do NOT modify (Story 34.1 tests) |
| `packages/mina-zkapp/src/payment-channel-claims.test.ts` | NEW | Create -- Story 34.2 claim tests |
| `packages/mina-zkapp/package.json` | EXISTS | No changes expected |
| `packages/mina-zkapp/tsconfig.json` | EXISTS | No changes expected |
| `packages/mina-zkapp/jest.config.ts` | EXISTS | No changes expected |

### Review Follow-ups from Story 34.1

Story 34.1 deferred two HIGH review items to Story 34.4:
1. On-chain signature verification for `deposit()` -- SDK-level binding
2. On-chain signature verification for `initiateClose()` -- SDK-level binding

These are NOT your responsibility in this story. However, `claimFromChannel()` SHOULD implement on-chain signature verification (see "Signature Verification Pattern" section above) because the zk proof must be self-contained for privacy.

### Cross-Story Dependencies

- **Story 34.3** will add proof-enabled integration tests for this method (with `proofsEnabled: true`, per test design doc T-34.2-13/14 IDs which are allocated to Story 34.3)
- **Story 34.4** SDK will wrap `claimFromChannel()` with client-side proof generation
- **Story 34.5** provider will call SDK's `claimFromChannel()` for settlement
- Keep test helpers reusable for Story 34.3

### Privacy Verification in Tests

T-34.2-07 must verify that after a claim, ONLY the commitment hash is visible on-chain:

```typescript
// After successful claim:
const commitment = zkApp.balanceCommitment.get();
const nonce = zkApp.nonceField.get();

// These are the ONLY claim-related values visible on-chain
// Verify they do NOT reveal actual balances:
// commitment is a Poseidon hash -- not reversible to (balanceA, balanceB, salt)
// The test proves privacy by showing the commitment is opaque:
expect(commitment).not.toEqual(Field(0)); // Not zero (was updated)
expect(commitment).toEqual(Poseidon.hash([expectedBalanceA, expectedBalanceB, expectedSalt]));
// But an observer without the salt cannot derive balanceA or balanceB from commitment alone
```

### Git Intelligence

Recent commit: `71a10f3e feat(34-1): Mina payment channel zkApp — channel lifecycle`
Branch: `epic-34` (current)
Commit message pattern: `feat(34-2): <description>`

### Project Structure Notes

- All changes are within `packages/mina-zkapp/` -- no connector package changes
- Build: `npm run build --workspace=packages/mina-zkapp`
- Test: `npm run test --workspace=packages/mina-zkapp`
- The zkApp class is exported from `index.ts` via barrel export

### References

- [Source: _bmad-output/planning-artifacts/epic-34-mina-protocol-payment-channel-provider.md#Story 34.2]
- [Source: _bmad-output/planning-artifacts/architecture.md#Section 8 Settlement Architecture]
- [Source: _bmad-output/planning-artifacts/architecture.md#Section 12 Testing Strategy, Multi-Chain Test Pyramid]
- [Source: _bmad-output/planning-artifacts/test-design-epic-34.md#Story 34.2]
- [Source: _bmad-output/implementation-artifacts/34-1-mina-payment-channel-zkapp-channel-lifecycle.md — pattern reference]
- [Source: packages/mina-zkapp/src/PaymentChannel.ts — existing zkApp to extend]
- [Source: packages/mina-zkapp/src/constants.ts — ASSERT_MESSAGES with 34.2 placeholders]
- [Source: _bmad-output/project-context.md#Testing Rules, Critical Implementation Rules]

## Preconditions

- Story 34.1 is complete (PaymentChannel zkApp with lifecycle methods, 20 tests green)
- Branch `epic-34` with commit `71a10f3e` (Story 34.1 done)
- `packages/mina-zkapp/` workspace exists with o1js dependency
- `proofsEnabled: false` test infrastructure established
- All Story 34.1 tests passing (`make mina-test`)

## Out of Scope

- Proof-enabled integration tests (Story 34.3 -- proof-enabled variants per test design doc)
- TypeScript SDK wrapping `claimFromChannel()` (Story 34.4)
- `MinaPaymentChannelProvider` implementation (Story 34.5)
- NIP-59 claim wrapping (Story 34.6)
- Claim message type expansion (Story 34.7)
- E2E integration tests (Story 34.8)
- Devnet deployment (Story 34.9)
- Claims on CLOSING channels (keep state machine simple -- claims require OPEN state only)

## Test Plan

Reference: [Source: _bmad-output/planning-artifacts/test-design-epic-34.md#Story 34.2]

| Test ID   | Scenario                                                                          | Type        | Priority |
|-----------|-----------------------------------------------------------------------------------|-------------|----------|
| T-34.2-01 | Valid claim updates balanceCommitment and nonceField                               | Unit (o1js) | P0       |
| T-34.2-02 | Claim with conservation violation (balances != depositTotal) rejected             | Unit (o1js) | P0       |
| T-34.2-03 | Claim with non-negativity violation (balance > depositTotal via modular arith) rejected | Unit (o1js) | P0       |
| T-34.2-04 | Claim with stale nonce (<= current nonce) rejected                                | Unit (o1js) | P0       |
| T-34.2-05 | Claim with invalid signature from participant A rejected                           | Unit (o1js) | P0       |
| T-34.2-06 | Claim with invalid signature from participant B rejected                           | Unit (o1js) | P0       |
| T-34.2-07 | After claim, on-chain state reveals only Poseidon commitment (privacy)            | Unit (o1js) | P0       |
| T-34.2-08 | Channel remains OPEN after successful claim                                       | Unit (o1js) | P0       |
| T-34.2-09 | Multiple sequential claims with increasing nonces all succeed                     | Unit (o1js) | P1       |
| T-34.2-10 | Claim on CLOSING channel is rejected (OPEN-only policy)                           | Unit (o1js) | P1       |
| T-34.2-11 | Claim on SETTLED channel is rejected                                              | Unit (o1js) | P1       |
| T-34.2-12 | Claim with commitment mismatch rejected                                           | Unit (o1js) | P0       |
| T-34.2-13 | Claim with wrong participant keys (channelHash mismatch) rejected                 | Unit (o1js) | P0       |

### Test Approach

- All tests use `Mina.LocalBlockchain({ proofsEnabled: false })` for sub-second execution
- Reuse channel setup helpers from Story 34.1 test patterns
- Negative tests assert specific `ASSERT_MESSAGES` error strings
- Privacy test (T-34.2-07) verifies on-chain state opacity after claim

### Regression Gate

- `npm run build --workspace=packages/mina-zkapp` compiles with no errors
- `npm run test --workspace=packages/mina-zkapp` passes all tests (Story 34.1 + 34.2)
- Existing Story 34.1 tests unaffected (same PaymentChannel class, additive change)
- `make test` still passes (all existing tests green)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context) — claude-opus-4-6[1m]

### Debug Log References

N/A — no debug issues encountered.

### Completion Notes List

- **Task 1**: Implemented `claimFromChannel()` method on `PaymentChannel` zkApp with all 10 parameters (full signature with participant key verification). All six ZK proof circuit invariants enforced: commitment validity, conservation, non-negativity + range checks, monotonic nonce, participant binding via channelHash, and dual-party signature authorization. On-chain state updates limited to `balanceCommitment` and `nonceField` only (core privacy mechanism). Used `getAndRequireEquals()` for all on-chain state reads (channelHash, depositTotal, nonceField, channelState) for precondition binding security.
- **Task 2**: Added nonce range check (`assertLessThanOrEqual(MAX_SAFE_AMOUNT)`) and balance range checks (`assertLessThanOrEqual(MAX_SAFE_AMOUNT)`) for defense-in-depth, matching the `deposit()` pattern from Story 34.1 review #3.
- **Task 3**: Added 3 new assertion messages to `constants.ts`: `INVALID_SIGNATURE_A`, `INVALID_SIGNATURE_B`, `NONCE_EXCEEDS_SAFE_RANGE`. Confirmed existing messages (`NONCE_MUST_INCREASE`, `BALANCE_CONSERVATION_VIOLATED`, `BALANCE_EXCEEDS_DEPOSIT`, `CHANNEL_HASH_MISMATCH`, `COMMITMENT_MISMATCH`, `CHANNEL_MUST_BE_OPEN`, `AMOUNT_EXCEEDS_SAFE_RANGE`) are reusable for claim context.
- **Task 4**: All 13 unit tests (T-34.2-01 through T-34.2-13) pass with `proofsEnabled: false`. Test file was pre-scaffolded from a prior TDD RED phase and worked correctly against the implementation without modification. Tests cover all 9 ACs including privacy verification (T-34.2-07), sequential claims (T-34.2-09), and state guard rejections for CLOSING and SETTLED channels.
- **Regression**: All 33 mina-zkapp tests pass (20 from Story 34.1 + 13 from Story 34.2). Full project `make test` passes (all suites green).

### File List

- `packages/mina-zkapp/src/PaymentChannel.ts` — modified (added `claimFromChannel()` method, ~75 lines)
- `packages/mina-zkapp/src/constants.ts` — modified (added 3 new assertion messages)
- `packages/mina-zkapp/src/payment-channel-claims.test.ts` — existing (pre-scaffolded TDD RED tests, no modifications needed)

### Change Log

| Date | Summary |
|------|---------|
| 2026-03-27 | Story 34.2 implemented: added `claimFromChannel()` method to PaymentChannel zkApp with 10-parameter signature, 6 ZK circuit invariants, 3 new assertion messages, and all 13 unit tests passing. Full on-chain signature verification enabled (not deferred to SDK). |

## Code Review Record

| Review # | Date | Reviewer Model | Critical | High | Medium | Low | Outcome |
|----------|------|----------------|----------|------|--------|-----|---------|
| 1 | 2026-03-27 | Claude Opus 4.6 (1M context) | 0 | 0 | 0 | 1 | Pass — no substantive code changes needed. Low: stale "TDD RED phase" comment in test file header (fixed in-review). |
| 2 | 2026-03-27 | Claude Opus 4.6 (1M context) | 0 | 0 | 0 | 1 | Pass — removed unused INVALID_CLAIM_PROOF constant from constants.ts (dead code). All 6 ZK circuit invariants correct, all 9 ACs satisfied, all 39 tests green, build clean. |
| 3 | 2026-03-27 | Claude Opus 4.6 (1M context) | 0 | 0 | 0 | 0 | Pass — full adversarial review with Semgrep security scan (OWASP top 10, auth/authz, injection). All 6 ZK circuit invariants verified correct. All 9 ACs satisfied. All 39 tests green. Build clean. Lint clean. No issues found. |
