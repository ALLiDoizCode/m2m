---
stepsCompleted:
  [
    'step-01-preflight-and-context',
    'step-02-generation-mode',
    'step-03-test-strategy',
    'step-04-generate-tests',
    'step-04c-aggregate',
    'step-05-validate-and-complete',
  ]
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-03-27'
workflowType: 'testarch-atdd'
inputDocuments:
  [
    '_bmad-output/implementation-artifacts/34-2-mina-payment-channel-zkapp-zk-private-claims.md',
    '_bmad-output/planning-artifacts/test-design-epic-34.md',
    '_bmad-output/project-context.md',
    'packages/mina-zkapp/src/PaymentChannel.ts',
    'packages/mina-zkapp/src/constants.ts',
    'packages/mina-zkapp/src/payment-channel.test.ts',
    'packages/mina-zkapp/jest.config.ts',
  ]
---

# ATDD Checklist - Epic 34, Story 34.2: Mina Payment Channel zkApp -- ZK-Private Claims

**Date:** 2026-03-27
**Author:** Jonathan
**Primary Test Level:** Unit (o1js LocalBlockchain, proofsEnabled: false)

---

## Story Summary

Story 34.2 adds a `claimFromChannel()` method to the existing PaymentChannel zkApp that allows cooperative balance updates using zk-SNARK proofs without revealing actual amounts on-chain. This is the core privacy mechanism for the Mina payment channel settlement.

**As a** connector operator
**I want** a `claimFromChannel()` method on the Mina zkApp that allows cooperative balance updates using zk-SNARK proofs without revealing actual amounts on-chain
**So that** peers can settle ILP claims privately -- neither on-chain observers nor transport intermediaries can determine transferred amounts

---

## Acceptance Criteria

1. **AC 1:** Valid claim updates balance commitment and nonce on-chain
2. **AC 2:** Conservation violation (balances != depositTotal) is rejected
3. **AC 3:** Non-negativity violation (negative balance via modular arithmetic) is rejected
4. **AC 4:** Nonce monotonicity enforced (stale nonce rejected)
5. **AC 5:** Dual-party authorization required (invalid signatures rejected)
6. **AC 6:** Privacy -- on-chain state reveals no balances (only Poseidon commitment)
7. **AC 7:** Channel remains OPEN after claim
8. **AC 8:** Commitment mismatch rejected (Poseidon hash != provided commitment)
9. **AC 9:** Participant key verification against channelHash

---

## Failing Tests Created (RED Phase)

### Unit Tests (13 tests)

**File:** `packages/mina-zkapp/src/payment-channel-claims.test.ts` (580 lines)

- **Test:** `[P0] T-34.2-01: valid claim updates balanceCommitment and nonceField`
  - **Status:** RED - `claimFromChannel` method does not exist on PaymentChannel
  - **Verifies:** AC 1 -- valid claim updates on-chain state correctly

- **Test:** `[P0] T-34.2-02: claim with conservation violation (balances != depositTotal) is rejected`
  - **Status:** RED - `claimFromChannel` method does not exist on PaymentChannel
  - **Verifies:** AC 2 -- balance sum must equal depositTotal

- **Test:** `[P0] T-34.2-03: claim with non-negativity violation (balance > depositTotal via modular arith) is rejected`
  - **Status:** RED - `claimFromChannel` method does not exist on PaymentChannel
  - **Verifies:** AC 3 -- individual balance cannot exceed depositTotal

- **Test:** `[P0] T-34.2-04: claim with stale nonce (<= current nonce) is rejected`
  - **Status:** RED - `claimFromChannel` method does not exist on PaymentChannel
  - **Verifies:** AC 4 -- nonce must be strictly greater than current nonce

- **Test:** `[P0] T-34.2-05: claim with invalid signature from participant A is rejected`
  - **Status:** RED - `claimFromChannel` method does not exist on PaymentChannel
  - **Verifies:** AC 5 -- both participants must sign the claim

- **Test:** `[P0] T-34.2-06: claim with invalid signature from participant B is rejected`
  - **Status:** RED - `claimFromChannel` method does not exist on PaymentChannel
  - **Verifies:** AC 5 -- both participants must sign the claim

- **Test:** `[P0] T-34.2-07: after claim, on-chain state reveals only commitment hash (privacy)`
  - **Status:** RED - `claimFromChannel` method does not exist on PaymentChannel
  - **Verifies:** AC 6 -- actual balances are not recoverable from on-chain data

- **Test:** `[P0] T-34.2-08: channel remains OPEN after successful claim`
  - **Status:** RED - `claimFromChannel` method does not exist on PaymentChannel
  - **Verifies:** AC 7 -- cooperative claim does not close the channel

- **Test:** `[P0] T-34.2-12: claim where computed commitment != provided commitment is rejected`
  - **Status:** RED - `claimFromChannel` method does not exist on PaymentChannel
  - **Verifies:** AC 8 -- Poseidon hash of balances must match provided commitment

- **Test:** `[P0] T-34.2-13: claim with wrong participant keys (channelHash mismatch) is rejected`
  - **Status:** RED - `claimFromChannel` method does not exist on PaymentChannel
  - **Verifies:** AC 9 -- participant keys must match stored channelHash

- **Test:** `[P1] T-34.2-09: multiple sequential claims with increasing nonces all succeed`
  - **Status:** RED - `claimFromChannel` method does not exist on PaymentChannel
  - **Verifies:** AC 1, 4 -- sequential claims work and nonce advances

- **Test:** `[P1] T-34.2-10: claim on CLOSING channel is rejected (OPEN-only policy)`
  - **Status:** RED - `claimFromChannel` method does not exist on PaymentChannel
  - **Verifies:** AC 7 -- claims require channel to be OPEN

- **Test:** `[P1] T-34.2-11: claim on SETTLED channel is rejected`
  - **Status:** RED - `claimFromChannel` method does not exist on PaymentChannel
  - **Verifies:** AC 7 -- claims require channel to be OPEN

---

## Data Factories Created

### Claim Parameter Factory

**File:** `packages/mina-zkapp/src/payment-channel-claims.test.ts` (inline helpers)

**Exports (test-scoped):**

- `buildValidClaimParams(participantAKey, participantBKey, ...)` - Build a valid claim parameter set with proper signatures and Poseidon commitment
- `setupOpenChannelWithDeposit(deployer, zkApp, ...)` - Deploy, initialize, and deposit into a channel ready for claims
- `setupClosingChannel(local, deployer, ...)` - Full setup to CLOSING state
- `setupSettledChannel(local, deployer, ...)` - Full setup to SETTLED state

**Example Usage:**

```typescript
const claimParams = buildValidClaimParams(
  participantA.key, participantB.key,
  participantA, participantB,
  channelNonce, Field(700_000_000), Field(300_000_000),
  Field(1), channelHash
);
await submitClaim(deployer, zkApp, claimParams, [deployer.key]);
```

---

## Fixtures Created

### Channel State Fixtures (inline in test file)

**Fixtures:**

- `setupOpenChannelWithDeposit` - OPEN channel ready for claim testing
  - **Setup:** deploy + initializeChannel + deposit
  - **Provides:** channelHash, depositTotal
  - **Cleanup:** each test uses fresh zkApp instance via beforeEach

- `setupClosingChannel` - CLOSING channel for state guard tests
  - **Setup:** deploy + initializeChannel + deposit + initiateClose
  - **Provides:** channelHash, balanceA, balanceB
  - **Cleanup:** each test uses fresh zkApp instance via beforeEach

- `setupSettledChannel` - SETTLED channel for state guard tests
  - **Setup:** deploy + initializeChannel + deposit + initiateClose + settle
  - **Provides:** channelHash
  - **Cleanup:** each test uses fresh zkApp instance via beforeEach

---

## Mock Requirements

No external service mocking required. All tests run against `Mina.LocalBlockchain({ proofsEnabled: false })` which provides a fully deterministic, in-memory blockchain environment.

---

## Required data-testid Attributes

Not applicable -- this is a backend/smart contract story with no UI components.

---

## Implementation Checklist

### Test: T-34.2-01 through T-34.2-08, T-34.2-12, T-34.2-13 (P0 -- Core)

**File:** `packages/mina-zkapp/src/PaymentChannel.ts`

**Tasks to make these tests pass:**

- [ ] Add `INVALID_SIGNATURE_A`, `INVALID_SIGNATURE_B`, `NONCE_EXCEEDS_SAFE_RANGE` messages to `ASSERT_MESSAGES` in `constants.ts`
- [ ] Add `@method async claimFromChannel(newBalanceA, newBalanceB, newSalt, signatureA, signatureB, participantA, participantB, channelNonce, newBalanceCommitment, newNonce)` to `PaymentChannel.ts`
- [ ] Implement circuit constraint: `channelState.assertEquals(CHANNEL_STATE.OPEN)` (state guard)
- [ ] Implement circuit constraint: commitment validity -- `Poseidon.hash([newBalanceA, newBalanceB, newSalt]).assertEquals(newBalanceCommitment)`
- [ ] Implement circuit constraint: conservation -- `newBalanceA.add(newBalanceB).assertEquals(depositTotal)`
- [ ] Implement circuit constraint: non-negativity range checks -- `newBalanceA.assertLessThanOrEqual(depositTotal)` and same for `newBalanceB`
- [ ] Implement circuit constraint: monotonic nonce -- `newNonce.assertGreaterThan(currentNonce)`
- [ ] Implement circuit constraint: channelHash binding -- `Poseidon.hash([participantA.x, participantB.x, channelNonce]).assertEquals(storedChannelHash)`
- [ ] Implement circuit constraint: dual-party authorization -- `signatureA.verify(participantA, message).assertTrue()` and same for signatureB
- [ ] Update on-chain state: `balanceCommitment.set(newBalanceCommitment)` and `nonceField.set(newNonce)`
- [ ] Read `channelHash` with `getAndRequireEquals()` for precondition binding
- [ ] Read `depositTotal` with `getAndRequireEquals()` for conservation check
- [ ] Add nonce and balance range checks using `MAX_SAFE_AMOUNT`
- [ ] Run tests: `npm run test --workspace=packages/mina-zkapp -- --testPathPattern="payment-channel-claims"`
- [ ] All 13 tests pass (green phase)

**Estimated Effort:** 3-5 hours

---

### Test: T-34.2-09 (P1 -- Sequential Claims)

**Tasks to make this test pass:**

- [ ] Already covered by core implementation above -- sequential claims with increasing nonces should work once claimFromChannel is implemented
- [ ] Verify nonce increments correctly across multiple claims
- [ ] Run test: `npm run test --workspace=packages/mina-zkapp -- --testPathPattern="payment-channel-claims" -t "T-34.2-09"`
- [ ] Test passes (green phase)

---

### Test: T-34.2-10 (P1 -- CLOSING State Guard)

**Tasks to make this test pass:**

- [ ] Already covered by `channelState.assertEquals(CHANNEL_STATE.OPEN)` constraint
- [ ] Run test: `npm run test --workspace=packages/mina-zkapp -- --testPathPattern="payment-channel-claims" -t "T-34.2-10"`
- [ ] Test passes (green phase)

---

### Test: T-34.2-11 (P1 -- SETTLED State Guard)

**Tasks to make this test pass:**

- [ ] Already covered by `channelState.assertEquals(CHANNEL_STATE.OPEN)` constraint
- [ ] Run test: `npm run test --workspace=packages/mina-zkapp -- --testPathPattern="payment-channel-claims" -t "T-34.2-11"`
- [ ] Test passes (green phase)

---

## Running Tests

```bash
# Run all failing tests for this story
npm run test --workspace=packages/mina-zkapp -- --testPathPattern="payment-channel-claims"

# Run specific test by name
npm run test --workspace=packages/mina-zkapp -- --testPathPattern="payment-channel-claims" -t "T-34.2-01"

# Run with verbose output
npm run test --workspace=packages/mina-zkapp -- --testPathPattern="payment-channel-claims" --verbose

# Run all mina-zkapp tests (34.1 + 34.2 regression)
npm run test --workspace=packages/mina-zkapp

# Run with coverage
npm run test --workspace=packages/mina-zkapp -- --coverage
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 13 tests written and failing (TypeScript compilation error: `claimFromChannel` does not exist)
- Test helpers and factories created with proper setup/teardown via beforeEach
- No mock requirements (uses o1js LocalBlockchain)
- Implementation checklist created

**Verification:**

- All tests fail as expected (RED phase confirmed)
- Failure is due to missing `claimFromChannel()` method, not test bugs
- Story 34.1 tests unaffected (20/20 passing)

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. Add new assertion messages to `constants.ts` (Task 3)
2. Implement `claimFromChannel()` method on `PaymentChannel` class (Task 1)
3. Add range checks for nonce and balance safety (Task 2)
4. Run tests after each constraint is added
5. All 13 tests should pass when all 6 invariants are enforced

**Key Principles:**

- Implement one circuit constraint at a time
- Run tests after each constraint addition
- The state guard (`CHANNEL_MUST_BE_OPEN`) will make T-34.2-10 and T-34.2-11 pass immediately
- Signature verification (T-34.2-05, T-34.2-06) requires the full message construction pattern from the story dev notes

---

### REFACTOR Phase (DEV Team - After All Tests Pass)

**DEV Agent Responsibilities:**

1. Verify all 13 tests pass
2. Review circuit constraints for optimization (minimize constraint count)
3. Ensure assertion messages are consistent with Story 34.1 patterns
4. Verify no unused imports or dead code
5. Run full regression: `npm run test --workspace=packages/mina-zkapp`
6. Build check: `npm run build --workspace=packages/mina-zkapp`

---

## Next Steps

1. **Begin implementation** using the implementation checklist as guide
2. **Run failing tests** to confirm RED phase: `npm run test --workspace=packages/mina-zkapp -- --testPathPattern="payment-channel-claims"`
3. **Implement `claimFromChannel()`** method with all 6 circuit invariants
4. **Work one constraint at a time** (implement constraint, run tests, verify progress)
5. **When all 13 tests pass**, refactor for quality
6. **Run full regression** to verify Story 34.1 tests still pass
7. **Build check** to ensure compilation succeeds

---

## Knowledge Base References Applied

- **test-quality.md** - Given-When-Then structure, one assertion per test, deterministic test design
- **data-factories.md** - Factory pattern for test data (`buildValidClaimParams` helper)
- **test-levels-framework.md** - Unit level selection for zkApp circuit testing (backend stack)
- **project-context.md** - TypeScript strict mode, Jest configuration, test file co-location patterns
- **test-design-epic-34.md** - Test IDs, priorities, and scenarios for Story 34.2

See `tea-index.csv` for complete knowledge fragment mapping.

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npm run test --workspace=packages/mina-zkapp -- --testPathPattern="payment-channel-claims"`

**Results:**

```
FAIL mina-zkapp src/payment-channel-claims.test.ts
  Test suite failed to run

    src/payment-channel-claims.test.ts:138:17 - error TS2339: Property 'claimFromChannel' does not exist on type 'PaymentChannel'.

Test Suites: 1 failed, 1 total
Tests:       0 total
```

**Summary:**

- Total tests: 13 (defined)
- Passing: 0 (expected)
- Failing: 13 (expected -- suite fails to compile because claimFromChannel does not exist)
- Status: RED phase verified

**Regression Check:**

```
PASS mina-zkapp src/payment-channel.test.ts
  20 passed, 20 total
```

Story 34.1 tests unaffected.

---

## Notes

- Tests do NOT use `test.skip()` because the failure mode is a TypeScript compilation error (`claimFromChannel` does not exist on `PaymentChannel`). This is the strongest possible RED phase signal -- the entire test suite fails to compile until the method is implemented.
- The test file follows the exact same patterns as `payment-channel.test.ts` (Story 34.1) for consistency: same helpers, same setup pattern, same assertion style.
- Test T-34.2-10 (claim on CLOSING channel) follows the story recommendation of REJECT, not ALLOW. The test design doc (T-34.2-10) originally said "succeeds" but the story AC 7 and dev notes recommend OPEN-only policy. The test asserts rejection.
- Proof-enabled tests (T-34.2-13, T-34.2-14 from test design doc) are allocated to Story 34.3 per the story spec and are NOT included here.
- The `buildValidClaimParams` helper constructs properly signed claims including Poseidon commitment and dual-party Signature objects, making it reusable for Story 34.3 integration tests.

---

**Generated by BMad TEA Agent** - 2026-03-27
