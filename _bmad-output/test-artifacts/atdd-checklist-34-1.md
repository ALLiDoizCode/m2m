---
stepsCompleted:
  - step-01-preflight-and-context
  - step-02-generation-mode
  - step-03-test-strategy
  - step-04-generate-tests
  - step-05-validate-and-complete
lastStep: step-05-validate-and-complete
lastSaved: '2026-03-26'
workflowType: testarch-atdd
inputDocuments:
  - _bmad-output/implementation-artifacts/34-1-mina-payment-channel-zkapp-channel-lifecycle.md
  - _bmad-output/planning-artifacts/test-design-epic-34.md
  - _bmad/tea/config.yaml
  - _bmad/tea/testarch/knowledge/data-factories.md
  - _bmad/tea/testarch/knowledge/test-quality.md
  - _bmad/tea/testarch/knowledge/test-healing-patterns.md
  - _bmad/tea/testarch/knowledge/test-levels-framework.md
  - _bmad/tea/testarch/knowledge/test-priorities-matrix.md
---

# ATDD Checklist - Epic 34, Story 34.1: Mina Payment Channel zkApp -- Channel Lifecycle

**Date:** 2026-03-26
**Author:** Jonathan
**Primary Test Level:** Unit (o1js LocalBlockchain, proofsEnabled: false)

---

## Story Summary

Story 34.1 delivers the foundational Mina zkApp smart contract managing payment channel lifecycle (open, deposit, close, settle) using zero-knowledge balance commitments. This is the first story in Epic 34 and establishes the on-chain contract that all subsequent stories depend upon.

**As a** connector operator
**I want** an on-chain Mina zkApp that manages payment channel lifecycle (open, deposit, close, settle)
**So that** peers can open, fund, and close payment channels for ILP settlement on Mina with zero-knowledge balance commitments

---

## Preflight Summary

- **Detected Stack:** backend (Node.js/TypeScript monorepo with Jest)
- **Test Framework:** Jest with ts-jest preset
- **Test Runner:** `npm run test --workspace=packages/mina-zkapp`
- **Test File Location:** `packages/mina-zkapp/src/payment-channel.test.ts`
- **Story Status:** ready-for-dev
- **Acceptance Criteria Count:** 10 (AC 1, 1a, 2, 2a, 2b, 3, 3a, 3b, 4, 5, 5a, 6)
- **Test Scenarios from Test Design:** 15 (T-34.1-01 through T-34.1-15)
- **Knowledge Fragments Loaded:** data-factories, test-quality, test-healing-patterns, test-levels-framework, test-priorities-matrix
- **Generation Mode:** AI Generation (backend project -- no browser recording needed)

---

## Acceptance Criteria

1. **AC 1: Initialize Channel** -- Create a new payment channel between two participants, verify all 8 on-chain state fields
2. **AC 1a: Double Initialization Rejected** -- Duplicate channel initialization is rejected
3. **AC 2: Deposit Tokens** -- Participant deposits MINA into channel, depositTotal increases
4. **AC 2a: Deposit Rejected on Non-Open Channel** -- Deposit to CLOSING or SETTLED channel rejected
5. **AC 2b: Zero-Amount Deposit Rejected** -- Zero-amount deposit rejected
6. **AC 3: Initiate Close** -- Both participants cooperatively close with final balances, state transitions to CLOSING
7. **AC 3a: Close Rejected on Non-Open Channel** -- Close on non-OPEN channel rejected
8. **AC 3b: Close Rejected with Balance Sum != depositTotal** -- Close with balance conservation violation rejected
9. **AC 4: Settle After Challenge Period** -- Settle channel after challenge period, verify Poseidon commitment, distribute funds
10. **AC 5: Settle Rejected During Challenge Period** -- Settlement rejected before challenge deadline
11. **AC 5a: Settle Rejected on Non-CLOSING Channel** -- Settlement rejected when channel not CLOSING
12. **AC 6: All 8 State Fields Used Correctly** -- zkApp uses exactly 8 on-chain state fields

---

## Test Strategy

### Test Level Selection

All tests are **Unit (o1js)** level using `Mina.LocalBlockchain({ proofsEnabled: false })`. Justification:

- This is a pure smart contract story with no API endpoints, no UI, and no service integrations
- o1js LocalBlockchain provides an in-process blockchain simulator -- tests execute in milliseconds
- Circuit constraints are enforced even with `proofsEnabled: false` -- only proof generation is skipped
- The test-design document (epic 34) confirms this level for all T-34.1-* scenarios

### Test Priority Mapping

| Test ID   | AC    | Scenario                                                              | Priority | Risk Focus        |
|-----------|-------|-----------------------------------------------------------------------|----------|-------------------|
| T-34.1-01 | AC 1  | initializeChannel sets all 8 on-chain state fields correctly          | P0       | R-05 (8-field)    |
| T-34.1-02 | AC 1  | channelHash == Poseidon(participantA, participantB, nonce)            | P0       | R-03 (commitment) |
| T-34.1-03 | AC 2  | deposit increments depositTotal and requires depositor signature      | P0       | R-06 (balance)    |
| T-34.1-04 | AC 3  | initiateClose transitions to CLOSING and records closedAtSlot         | P0       | R-09 (timing)     |
| T-34.1-05 | AC 4  | settle after challenge period distributes funds, transitions SETTLED  | P0       | R-06 (balance)    |
| T-34.1-06 | AC 5  | settle before challenge period is rejected                            | P0       | R-09 (timing)     |
| T-34.1-07 | AC 6  | All 8 state fields used -- no unused, no overflow into field 9        | P0       | R-05 (8-field)    |
| T-34.1-08 | AC 3  | initiateClose verifies balanceCommitment and both signatures          | P0       | R-03 (commitment) |
| T-34.1-09 | AC 1a | Double-init rejected (channelState != UNINITIALIZED)                  | P1       | State guard        |
| T-34.1-10 | AC 2a | Deposit to CLOSING or SETTLED channel rejected                        | P1       | State guard        |
| T-34.1-11 | AC 2b | Deposit with zero amount rejected                                     | P1       | Input validation   |
| T-34.1-12 | AC 3a | initiateClose on non-OPEN channel rejected                            | P1       | State guard        |
| T-34.1-13 | AC 5a | Settle on non-CLOSING channel rejected                                | P1       | State guard        |
| T-34.1-14 | AC 3b | initiateClose with balanceA + balanceB != depositTotal rejected       | P1       | R-06 (balance)    |
| T-34.1-15 | AC 4  | Settle with incorrect balance reveal (commitment mismatch) rejected   | P1       | R-03 (commitment) |

### Red Phase Design

All 15 tests will fail because the implementation files do not yet exist:
- `packages/mina-zkapp/src/PaymentChannel.ts` -- not yet created
- `packages/mina-zkapp/src/constants.ts` -- not yet created
- Tests import from these non-existent modules, causing immediate failure (cannot find module)

---

## Failing Tests Created (RED Phase)

### Unit Tests (15 tests)

**File:** `packages/mina-zkapp/src/payment-channel.test.ts` (676 lines)

All tests use `it.skip()` to document intentional failure (TDD red phase). Remove `.skip` after implementation to verify green phase.

**P0 Tests (8 tests) -- Critical Path:**

- **T-34.1-01:** `[P0] initializeChannel sets all 8 on-chain state fields correctly`
  - **Status:** RED - Module `./PaymentChannel` does not exist
  - **Verifies:** AC 1 -- all 8 state fields (channelHash, balanceCommitment, nonceField, channelState, depositTotal, closedAtSlot, settlementTimeout, tokenId) are set correctly after initialization

- **T-34.1-02:** `[P0] channelHash == Poseidon(participantA, participantB, nonce)`
  - **Status:** RED - Module `./PaymentChannel` does not exist
  - **Verifies:** AC 1 -- channelHash is computed as Poseidon hash of participant public keys and nonce

- **T-34.1-03:** `[P0] deposit increments depositTotal and requires depositor signature`
  - **Status:** RED - Module `./PaymentChannel` does not exist
  - **Verifies:** AC 2 -- deposit method increments depositTotal, works for both participants

- **T-34.1-04:** `[P0] initiateClose transitions to CLOSING and records closedAtSlot`
  - **Status:** RED - Module `./PaymentChannel` does not exist
  - **Verifies:** AC 3 -- state transitions from OPEN to CLOSING, closedAtSlot recorded, balanceCommitment updated

- **T-34.1-05:** `[P0] settle after challenge period distributes funds and transitions to SETTLED`
  - **Status:** RED - Module `./PaymentChannel` does not exist
  - **Verifies:** AC 4 -- full lifecycle through SETTLED state after challenge period elapses

- **T-34.1-06:** `[P0] settle before challenge period expires is rejected`
  - **Status:** RED - Module `./PaymentChannel` does not exist
  - **Verifies:** AC 5 -- premature settlement rejected (challenge period not elapsed)

- **T-34.1-07:** `[P0] all 8 state fields used -- no unused fields, no overflow`
  - **Status:** RED - Module `./PaymentChannel` does not exist
  - **Verifies:** AC 6 -- exactly 8 state fields defined, no 9th field

- **T-34.1-08:** `[P0] initiateClose verifies balanceCommitment and both signatures`
  - **Status:** RED - Module `./PaymentChannel` does not exist
  - **Verifies:** AC 3 -- Poseidon commitment correctness and dual-signature verification

**P1 Tests (7 tests) -- State Guards and Input Validation:**

- **T-34.1-09:** `[P1] double initialization is rejected`
  - **Status:** RED - Module `./PaymentChannel` does not exist
  - **Verifies:** AC 1a -- channelState must be UNINITIALIZED for init

- **T-34.1-10:** `[P1] deposit to CLOSING channel is rejected`
  - **Status:** RED - Module `./PaymentChannel` does not exist
  - **Verifies:** AC 2a -- deposit requires channelState == OPEN

- **T-34.1-11:** `[P1] deposit with zero amount is rejected`
  - **Status:** RED - Module `./PaymentChannel` does not exist
  - **Verifies:** AC 2b -- zero-amount deposit rejected

- **T-34.1-12:** `[P1] initiateClose on non-OPEN channel is rejected`
  - **Status:** RED - Module `./PaymentChannel` does not exist
  - **Verifies:** AC 3a -- close requires channelState == OPEN

- **T-34.1-13:** `[P1] settle on OPEN channel is rejected`
  - **Status:** RED - Module `./PaymentChannel` does not exist
  - **Verifies:** AC 5a -- settle requires channelState == CLOSING

- **T-34.1-14:** `[P1] initiateClose with balance sum != depositTotal is rejected`
  - **Status:** RED - Module `./PaymentChannel` does not exist
  - **Verifies:** AC 3b -- balance conservation invariant enforced

- **T-34.1-15:** `[P1] settle with incorrect balance reveal is rejected`
  - **Status:** RED - Module `./PaymentChannel` does not exist
  - **Verifies:** AC 4 -- Poseidon commitment mismatch detected and rejected

---

## Data Factories Created

No traditional data factories are needed for this story. Test data is constructed directly using o1js primitives:

- `Mina.LocalBlockchain()` provides pre-funded test accounts via `Local.testAccounts`
- `PrivateKey.random()` generates fresh zkApp keys per test
- `Field(n)` constructs field elements for amounts, nonces, timeouts
- `Signature.create(privateKey, fields)` creates Schnorr signatures for close operations
- `Poseidon.hash([...fields])` computes expected commitments for assertion

**Rationale:** o1js operates on algebraic field elements, not JSON/REST payloads. Factory functions for `User` or `Product` objects are not applicable. Instead, helper functions (`deployZkApp`, `initializeChannel`, `depositToChannel`, `closeChannel`, `settleChannel`) provide reusable test setup.

---

## Fixtures Created

### Test Helper Functions

**File:** `packages/mina-zkapp/src/payment-channel.test.ts` (inline helpers)

**Helpers:**

- `deployZkApp(deployer, zkAppKey, zkApp)` -- Deploys the PaymentChannel zkApp, funds the account
  - **Setup:** Creates and signs a deploy transaction
  - **Provides:** Deployed zkApp instance ready for method calls

- `initializeChannel(sender, zkApp, participantA, participantB, nonce, timeout, tokenId, signers)` -- Calls initializeChannel method
  - **Setup:** Constructs and signs the initialization transaction
  - **Provides:** Channel in OPEN state with all 8 fields set

- `depositToChannel(sender, zkApp, amount, depositor, signers)` -- Calls deposit method
  - **Setup:** Constructs deposit transaction
  - **Provides:** Updated depositTotal on-chain

- `closeChannel(sender, zkApp, balanceA, balanceB, salt, nonce, sigA, sigB, signers)` -- Calls initiateClose method
  - **Setup:** Constructs close transaction with dual signatures
  - **Provides:** Channel in CLOSING state with balanceCommitment and closedAtSlot set

- `settleChannel(sender, zkApp, balanceA, balanceB, salt, signers)` -- Calls settle method
  - **Setup:** Constructs settle transaction with balance reveal
  - **Provides:** Channel in SETTLED state (if challenge period elapsed)

**Design notes:** Helpers are defined inline in the test file for Story 34.1. Story 34.3 will refactor these into a shared `test-helpers.ts` module for reuse across multiple test files.

---

## Mock Requirements

No external service mocking is required. All tests run against `Mina.LocalBlockchain({ proofsEnabled: false })`, which is an in-process blockchain simulator provided by o1js. There are no HTTP APIs, no Docker containers, and no network calls.

---

## Required data-testid Attributes

Not applicable. This is a backend smart contract story with no UI components.

---

## Implementation Checklist

### Test: T-34.1-01 -- initializeChannel sets all 8 state fields

**File:** `packages/mina-zkapp/src/payment-channel.test.ts`

**Tasks to make this test pass:**

- [ ] Create `packages/mina-zkapp/src/constants.ts` with `CHANNEL_STATE` enum and `ASSERT_MESSAGES` map
- [ ] Create `packages/mina-zkapp/src/PaymentChannel.ts` with SmartContract class
- [ ] Define all 8 `@state(Field)` decorators on the class
- [ ] Implement `@method async initializeChannel(participantA, participantB, nonce, timeout, tokenId)`
- [ ] Compute `channelHash = Poseidon.hash([participantA.x, participantB.x, nonce])`
- [ ] Set initial `balanceCommitment = Poseidon.hash([Field(0), Field(0), Field(0)])`
- [ ] Set `channelState = CHANNEL_STATE.OPEN`
- [ ] Assert `channelState == CHANNEL_STATE.UNINITIALIZED` (guard against double-init)
- [ ] Create `packages/mina-zkapp/src/index.ts` barrel exports
- [ ] Run test: `npm run test --workspace=packages/mina-zkapp -- --testNamePattern="T-34.1-01"`
- [ ] Test passes (green phase)

**Estimated Effort:** 3-4 hours (includes full package scaffolding)

---

### Test: T-34.1-02 -- channelHash Poseidon computation

**File:** `packages/mina-zkapp/src/payment-channel.test.ts`

**Tasks to make this test pass:**

- [ ] Verify Poseidon.hash field ordering matches: `[participantA.x, participantB.x, nonce]`
- [ ] Run test: `npm run test --workspace=packages/mina-zkapp -- --testNamePattern="T-34.1-02"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours (covered by T-34.1-01 implementation)

---

### Test: T-34.1-03 -- deposit increments depositTotal

**File:** `packages/mina-zkapp/src/payment-channel.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `@method async deposit(amount, depositor)`
- [ ] Assert `channelState == CHANNEL_STATE.OPEN`
- [ ] Assert `amount > 0` (Field comparison)
- [ ] Increment `depositTotal = depositTotal.add(amount)`
- [ ] Run test: `npm run test --workspace=packages/mina-zkapp -- --testNamePattern="T-34.1-03"`
- [ ] Test passes (green phase)

**Estimated Effort:** 1-2 hours

---

### Test: T-34.1-04 -- initiateClose transitions to CLOSING

**File:** `packages/mina-zkapp/src/payment-channel.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `@method async initiateClose(balanceA, balanceB, salt, nonce, sigA, sigB)`
- [ ] Assert `channelState == CHANNEL_STATE.OPEN`
- [ ] Assert `balanceA.add(balanceB).assertEquals(depositTotal)`
- [ ] Verify both signatures against close message
- [ ] Set `balanceCommitment = Poseidon.hash([balanceA, balanceB, salt])`
- [ ] Read `network.globalSlotSinceGenesis` and set `closedAtSlot`
- [ ] Set `channelState = CHANNEL_STATE.CLOSING`
- [ ] Run test: `npm run test --workspace=packages/mina-zkapp -- --testNamePattern="T-34.1-04"`
- [ ] Test passes (green phase)

**Estimated Effort:** 2-3 hours

---

### Test: T-34.1-05 -- settle after challenge period

**File:** `packages/mina-zkapp/src/payment-channel.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `@method async settle(balanceA, balanceB, salt)`
- [ ] Assert `channelState == CHANNEL_STATE.CLOSING`
- [ ] Read `network.globalSlotSinceGenesis` and assert `currentSlot >= closedAtSlot + settlementTimeout`
- [ ] Assert `Poseidon.hash([balanceA, balanceB, salt]).assertEquals(balanceCommitment)`
- [ ] Distribute funds per revealed balances (send to participants)
- [ ] Set `channelState = CHANNEL_STATE.SETTLED`
- [ ] Run test: `npm run test --workspace=packages/mina-zkapp -- --testNamePattern="T-34.1-05"`
- [ ] Test passes (green phase)

**Estimated Effort:** 2-3 hours

---

### Tests: T-34.1-06 through T-34.1-15 -- Negative/Guard Tests

**File:** `packages/mina-zkapp/src/payment-channel.test.ts`

**Tasks to make these tests pass:**

- [ ] T-34.1-06: Challenge period guard in `settle` (assertGreaterThanOrEqual on slot)
- [ ] T-34.1-07: Verify 8 state field definitions exist and are accessible
- [ ] T-34.1-08: Signature verification in `initiateClose` (both sigA and sigB verified)
- [ ] T-34.1-09: UNINITIALIZED guard in `initializeChannel`
- [ ] T-34.1-10: OPEN guard in `deposit`
- [ ] T-34.1-11: Positive amount guard in `deposit`
- [ ] T-34.1-12: OPEN guard in `initiateClose`
- [ ] T-34.1-13: CLOSING guard in `settle`
- [ ] T-34.1-14: Balance conservation assertion in `initiateClose`
- [ ] T-34.1-15: Commitment verification in `settle`
- [ ] Run all tests: `npm run test --workspace=packages/mina-zkapp`
- [ ] All 15 tests pass (green phase)

**Estimated Effort:** 1-2 hours (guards are single-line assertions, mostly covered by happy-path implementation)

---

## Running Tests

```bash
# Run all failing tests for this story
npm run test --workspace=packages/mina-zkapp

# Run specific test by name pattern
npm run test --workspace=packages/mina-zkapp -- --testNamePattern="T-34.1-01"

# Run tests with verbose output
npm run test --workspace=packages/mina-zkapp -- --verbose

# Run tests with coverage
npm run test:coverage --workspace=packages/mina-zkapp

# Run all project tests (regression gate)
make test
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 15 tests written and skipped (it.skip)
- Helper functions created for deploy, initialize, deposit, close, settle
- No external mocking needed (LocalBlockchain is in-process)
- Implementation checklist created mapping each test to code tasks

**Verification:**

- All tests are skipped via `it.skip()` -- they will show as "skipped" in Jest output
- When `.skip` is removed, tests fail due to missing `./PaymentChannel` module
- Failure is due to missing implementation, not test bugs

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. **Create package scaffolding** -- `constants.ts`, `PaymentChannel.ts`, `index.ts`
2. **Pick one failing test** from implementation checklist (start with T-34.1-01)
3. **Remove `it.skip`** from that test only
4. **Implement minimal code** to make that specific test pass
5. **Run the test** to verify it now passes (green)
6. **Move to next test** and repeat

**Key Principles:**

- One test at a time (do not try to fix all at once)
- Minimal implementation (do not over-engineer)
- Run tests frequently (immediate feedback)
- Use implementation checklist as roadmap

---

### REFACTOR Phase (DEV Team - After All Tests Pass)

**DEV Agent Responsibilities:**

1. **Verify all 15 tests pass** (green phase complete)
2. **Extract test helpers** to `test-helpers.ts` for Story 34.3 reuse
3. **Review code for quality** (readability, maintainability)
4. **Ensure `make test` still passes** (regression gate)

---

## Next Steps

1. **Run `npm install` in workspace** to install o1js dependency
2. **Begin implementation** using implementation checklist as guide
3. **Work one test at a time** (red to green for each)
4. **When all tests pass**, refactor code for quality
5. **When refactoring complete**, update story status to 'done'
6. **Run `make test`** to verify no regression in existing packages

---

## Knowledge Base References Applied

This ATDD workflow consulted the following knowledge fragments:

- **data-factories.md** -- Factory patterns (adapted: o1js uses Field/Poseidon primitives, not JSON factories)
- **test-quality.md** -- Deterministic, isolated, explicit test design (applied: each test gets fresh LocalBlockchain accounts)
- **test-healing-patterns.md** -- Failure pattern catalog (noted: o1js circuit assertion failures differ from browser test failures)
- **test-levels-framework.md** -- Test level selection (applied: unit-level chosen for pure smart contract logic)
- **test-priorities-matrix.md** -- P0/P1 priority assignment based on risk and business impact

See `tea-index.csv` for complete knowledge fragment mapping.

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npm run test --workspace=packages/mina-zkapp`

**Expected Results:**

```
Test Suites: 1 skipped, 1 total
Tests:       15 skipped, 15 total
Snapshots:   0 total
Time:        ~1s
```

**Summary:**

- Total tests: 15
- Passing: 0 (expected)
- Skipped: 15 (expected -- all marked with it.skip)
- Failing: 0 (tests are skipped, not failing -- remove .skip to see module-not-found failures)
- Status: RED phase verified

**Expected Failure When .skip Removed:**

```
Cannot find module './PaymentChannel' from 'src/payment-channel.test.ts'
```

---

## Notes

- **o1js version:** Tests target o1js ^2.2.0. The o1js API has stabilized but field naming may vary between versions. Pin the version in package.json.
- **proofsEnabled: false:** All tests skip actual zk-SNARK proof generation. Story 34.3 will add proof-enabled tests separately.
- **Global slot manipulation:** Tests use `Local.setGlobalSlot(n)` to control time for challenge period testing. This API is specific to LocalBlockchain and is not available on devnet/mainnet.
- **Test helpers reuse:** Story 34.3 will extract helpers into a shared module. For now, helpers are inline to keep Story 34.1 self-contained.
- **tokenId field naming:** The o1js `SmartContract` base class has a built-in `tokenId` property. The zkApp field may need to be named `tokenId_` or similar to avoid collision. Tests use `tokenId_` defensively.

---

## Package Files Created

| File | Purpose | Lines |
|------|---------|-------|
| `packages/mina-zkapp/package.json` | Package manifest with o1js dependency | 25 |
| `packages/mina-zkapp/tsconfig.json` | TypeScript config (ES2022, strict, decorators) | 18 |
| `packages/mina-zkapp/jest.config.ts` | Jest config (ts-jest, node env, 60s timeout) | 17 |
| `packages/mina-zkapp/src/payment-channel.test.ts` | ATDD failing test file (15 tests) | 676 |

---

**Generated by BMad TEA Agent** - 2026-03-26
