---
stepsCompleted:
  - 'step-01-preflight-and-context'
  - 'step-02-generation-mode'
  - 'step-03-test-strategy'
  - 'step-04c-aggregate'
  - 'step-05-validate-and-complete'
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-03-29'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/34-4-mina-payment-channel-sdk-typescript-integration.md'
  - '_bmad/tea/testarch/knowledge/data-factories.md'
  - '_bmad/tea/testarch/knowledge/test-quality.md'
  - '_bmad/tea/testarch/knowledge/test-healing-patterns.md'
  - '_bmad/tea/testarch/knowledge/test-levels-framework.md'
  - '_bmad/tea/testarch/knowledge/test-priorities-matrix.md'
---

# ATDD Checklist - Epic 34, Story 34.4: MinaPaymentChannelSDK — TypeScript Integration

**Date:** 2026-03-29
**Author:** Jonathan
**Primary Test Level:** Unit (all o1js interactions mocked)

---

## Story Summary

Replace stub method bodies in `MinaPaymentChannelSDK` with real implementations that use o1js to interact with the `PaymentChannel` zkApp. The SDK wraps all Mina zkApp payment channel interactions so the connector can manage payment channels, generate zk-SNARK proofs, and query on-chain state without importing o1js directly.

**As a** connector developer
**I want** a TypeScript SDK that wraps all Mina zkApp payment channel interactions with o1js
**So that** the connector can manage payment channels, generate zk-SNARK proofs, and query on-chain state without importing o1js directly

---

## Acceptance Criteria

1. **AC 1:** compileContract pre-compiles the zkApp circuit via o1js, caches result
2. **AC 2:** openChannel deploys a new zkApp and calls initializeChannel
3. **AC 3:** deposit submits deposit transaction to the Mina network
4. **AC 4:** claimFromChannel generates zk-SNARK proof and submits (dual signatures)
5. **AC 5:** closeChannel initiates cooperative close with final balances
6. **AC 6:** settleChannel executes post-challenge settlement with reveal parameters
7. **AC 7:** getChannelState reads all 8 on-chain state fields as MinaChannelState
8. **AC 8:** getChannelEvents retrieves archive node events in chronological order
9. **AC 9:** signBalanceProof generates Poseidon commitment and signs it
10. **AC 10:** verifyBalanceProof validates zk-SNARK proof
11. **AC 11:** subscribeToChannel polls for state changes via polling interval
12. **AC 12:** Async non-blocking proof generation (returns Promise)

---

## Failing Tests Created (RED Phase)

### Unit Tests (29 tests)

**File:** `packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts` (~800 lines)

- **Test:** `[P0] should compile the PaymentChannel zkApp circuit via o1js`
  - **Status:** RED - `it.skip` (stub throws "not yet implemented")
  - **Verifies:** AC 1 - PaymentChannel.compile() delegation

- **Test:** `[P1] should cache compilation result — subsequent calls are no-ops`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 1 - Compilation caching

- **Test:** `[P1] should throw MinaChannelError with code 1001 on compilation failure`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 1 - Error handling for compile failures

- **Test:** `[P0] should deploy a new zkApp and call initializeChannel`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 2 - zkApp deployment and initialization

- **Test:** `[P1] should generate a new zkApp key pair for the channel`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 2 - Key pair generation

- **Test:** `[P0] should submit a deposit transaction to the Mina network`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 3 - Deposit transaction submission

- **Test:** `[P0] should generate a zk-SNARK proof and submit a claim`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 4 - ZK proof generation and claim submission

- **Test:** `[P1] should require signer private key (claimFromChannel)`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 4 - Signer key validation (code 1008)

- **Test:** `[P0] should submit a close transaction with final balances`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 5 - Cooperative close initiation

- **Test:** `[P0] should submit a settle transaction to the zkApp`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 6 - Post-challenge settlement

- **Test:** `[P0] should read all 8 on-chain state fields and return MinaChannelState`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 7 - State reading and type conversion

- **Test:** `[P1] should throw MinaChannelError code 1005 if account not found`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 7 - Account not found error handling

- **Test:** `[P1] should fetch historical events from the archive node`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 8 - Event retrieval

- **Test:** `[P2] should return events in chronological order`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 8 - Event ordering

- **Test:** `[P0] should compute Poseidon hash commitment and sign it`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 9 - Poseidon commitment + signature generation

- **Test:** `[P0] should throw MinaChannelError code 1008 when no signer key configured`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 9 - Missing signer key error

- **Test:** `[P0] should return true for valid proofs`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 10 - Valid proof verification

- **Test:** `[P1] should return false for invalid proofs`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 10 - Invalid proof rejection

- **Test:** `[P0] should invoke callback when state changes are detected`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 11 - Subscription callback mechanism

- **Test:** `[P1] should stop polling when unsubscribe is called`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 11 - Subscription cleanup

- **Test:** `[P1] should guard against overlapping polls`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 11 - Overlapping poll prevention

- **Test:** `[P0] should return a Promise from proof-generating operations`
  - **Status:** RED - `it.skip`
  - **Verifies:** AC 12 - Async non-blocking proof generation

- **Test:** `[P0] should throw MinaChannelError code 9999 when o1js not installed`
  - **Status:** RED - `it.skip`
  - **Verifies:** Error handling - Optional dependency absence

- **Test:** `[P0] should throw MinaChannelError code 1002 on transaction failure`
  - **Status:** RED - `it.skip`
  - **Verifies:** Error handling - Transaction rejection

- **Test:** `[P1] should throw MinaChannelError code 1003 on proof generation failure`
  - **Status:** RED - `it.skip`
  - **Verifies:** Error handling - Proof generation failure

- **Test:** `[P0] should accept optional 4th parameter for signer private key`
  - **Status:** RED - `it.skip`
  - **Verifies:** Constructor extension - Signer key parameter

- **Test:** `[P0] should remain backward compatible without signer key`
  - **Status:** RED - `it.skip`
  - **Verifies:** Constructor extension - Backward compatibility

- **Test:** `[P1] should use dynamic import for o1js (not static import)`
  - **Status:** RED - `it.skip`
  - **Verifies:** Dynamic import pattern - o1js lazy loading

- **Test:** `[P1] should use dynamic import for @toon-protocol/mina-zkapp`
  - **Status:** RED - `it.skip`
  - **Verifies:** Dynamic import pattern - mina-zkapp lazy loading

---

## Data Factories Created

N/A - This story tests a low-level SDK with mocked o1js primitives. Test data is defined as constants in the test file (addresses, keys, amounts). No factory pattern needed since data is deterministic blockchain primitives, not domain objects.

---

## Fixtures Created

N/A - Jest-based unit tests with `beforeEach` setup. No Playwright fixtures needed (backend-only).

---

## Mock Requirements

### o1js Mock

**Module:** `o1js` (dynamic import, intercepted by jest.mock)

**Mocked exports:**
- `Mina.Network()`, `Mina.setActiveInstance()`, `Mina.transaction()`
- `PrivateKey.random()`, `PrivateKey.fromBase58()`
- `PublicKey.fromBase58()`
- `Field()` - value wrapper
- `Poseidon.hash()` - commitment computation
- `Signature.create()`, `Signature.fromJSON()` - signing/verification
- `fetchAccount()` - on-chain state fetching
- `AccountUpdate.fundNewAccount()` - account creation

**Notes:** All o1js interactions are mocked. No real proof generation runs in unit tests. The mock transaction flow is: `Mina.transaction()` -> `prove()` -> `sign()` -> `send()`.

### @toon-protocol/mina-zkapp Mock

**Module:** `@toon-protocol/mina-zkapp` (dynamic import, intercepted by jest.mock)

**Mocked exports:**
- `PaymentChannel` class with `compile()` static method and instance methods
- `CHANNEL_STATE` constants (UNINITIALIZED=0, OPEN=1, CLOSING=2, SETTLED=3)

---

## Required data-testid Attributes

N/A - Backend SDK with no UI components.

---

## Implementation Checklist

### Test: compileContract pre-compiles circuit (AC 1)

**File:** `packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts`

**Tasks to make this test pass:**

- [ ] Add dynamic `await import('o1js')` lazy loader with caching
- [ ] Add dynamic `await import('@toon-protocol/mina-zkapp')` lazy loader
- [ ] Implement `compileContract()` calling `PaymentChannel.compile()`
- [ ] Store verification key for later use
- [ ] Cache compilation result (boolean flag, no-op on subsequent calls)
- [ ] Wrap compilation errors in `MinaChannelError` code 1001
- [ ] Run test: `npx jest --testPathPattern mina-payment-channel-sdk.atdd --no-coverage`
- [ ] Test passes (green phase)

**Estimated Effort:** 2 hours

---

### Test: openChannel deploys and initializes zkApp (AC 2)

**File:** `packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts`

**Tasks to make this test pass:**

- [ ] Generate new zkApp key pair via `PrivateKey.random()`
- [ ] Set active Mina network instance
- [ ] Build transaction deploying `PaymentChannel` smart contract
- [ ] Call `initializeChannel()` with provided parameters
- [ ] Sign and submit transaction via `txn.prove()` then `txn.sign().send()`
- [ ] Return `MinaOpenChannelResult` with zkApp address and tx hash
- [ ] Run test: `npx jest --testPathPattern mina-payment-channel-sdk.atdd --no-coverage`
- [ ] Test passes (green phase)

**Estimated Effort:** 3 hours

---

### Test: deposit submits deposit transaction (AC 3)

**File:** `packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts`

**Tasks to make this test pass:**

- [ ] Fetch zkApp instance via `fetchAccount()`
- [ ] Call `deposit()` on zkApp with amount and depositor public key
- [ ] Sign and submit transaction
- [ ] Return `MinaTxResult` with tx hash
- [ ] Run test: `npx jest --testPathPattern mina-payment-channel-sdk.atdd --no-coverage`
- [ ] Test passes (green phase)

**Estimated Effort:** 2 hours

---

### Test: claimFromChannel generates ZK proof (AC 4)

**File:** `packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts`

**Tasks to make this test pass:**

- [ ] Update method signature: add `signatureA` and `signatureB` parameters
- [ ] Validate `_signerPrivateKey` is set (throw code 1008 if not)
- [ ] Compute Poseidon commitment from balances + salt
- [ ] Deserialize signature strings into o1js `Signature` objects
- [ ] Call `claimFromChannel()` on zkApp with all 10 parameters
- [ ] `txn.prove()` generates the zk-SNARK proof asynchronously
- [ ] Sign and submit, return `MinaTxResult`
- [ ] Update provider `mina-payment-channel-provider.ts` to pass both signatures
- [ ] Run test: `npx jest --testPathPattern mina-payment-channel-sdk.atdd --no-coverage`
- [ ] Test passes (green phase)

**Estimated Effort:** 4 hours

---

### Test: closeChannel initiates cooperative close (AC 5)

**File:** `packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts`

**Tasks to make this test pass:**

- [ ] Update method signature: add `nonce`, change to `signatureA`/`signatureB`
- [ ] Validate `_signerPrivateKey` is set
- [ ] Deserialize signature strings
- [ ] Call `initiateClose()` on zkApp
- [ ] Sign and submit transaction
- [ ] Update provider to pass nonce and individual signatures
- [ ] Run test: `npx jest --testPathPattern mina-payment-channel-sdk.atdd --no-coverage`
- [ ] Test passes (green phase)

**Estimated Effort:** 2 hours

---

### Test: settleChannel executes settlement (AC 6)

**File:** `packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts`

**Tasks to make this test pass:**

- [ ] Update method signature: add `balanceA`, `balanceB`, `salt`, `participantA`, `participantB`, `nonce`
- [ ] Validate `_signerPrivateKey` is set
- [ ] Convert participant strings to o1js `PublicKey` objects
- [ ] Call `settle()` on zkApp with 6 parameters
- [ ] Sign and submit transaction
- [ ] Update provider to pass reveal parameters
- [ ] Run test: `npx jest --testPathPattern mina-payment-channel-sdk.atdd --no-coverage`
- [ ] Test passes (green phase)

**Estimated Effort:** 2 hours

---

### Test: getChannelState reads on-chain state (AC 7)

**File:** `packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts`

**Tasks to make this test pass:**

- [ ] Use `fetchAccount()` to fetch zkApp account
- [ ] Read all 8 on-chain state fields from zkApp instance
- [ ] Convert Field values: `toString()` for hashes, `toBigInt()` for amounts, `Number()` for channelState
- [ ] Set `participantA`/`participantB` to `''` if not in cache (document limitation)
- [ ] Return complete `MinaChannelState` object
- [ ] Throw `MinaChannelError` code 1005 if account not found
- [ ] Run test: `npx jest --testPathPattern mina-payment-channel-sdk.atdd --no-coverage`
- [ ] Test passes (green phase)

**Estimated Effort:** 2 hours

---

### Test: getChannelEvents retrieves events (AC 8)

**File:** `packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts`

**Tasks to make this test pass:**

- [ ] Query Mina GraphQL endpoint for zkApp actions/events
- [ ] Parse and type the returned event data
- [ ] Return events in chronological order
- [ ] Throw `MinaChannelError` code 1007 on archive node query failure
- [ ] Run test: `npx jest --testPathPattern mina-payment-channel-sdk.atdd --no-coverage`
- [ ] Test passes (green phase)

**Estimated Effort:** 2 hours

---

### Test: signBalanceProof generates Poseidon commitment (AC 9)

**File:** `packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts`

**Tasks to make this test pass:**

- [ ] Validate `_signerPrivateKey` is set (throw code 1008 if not)
- [ ] Compute `Poseidon.hash([Field(balanceA), Field(balanceB), Field(salt)])`
- [ ] Sign with `Signature.create(privateKey, [commitment, Field(nonce), channelHashField])`
- [ ] Serialize as JSON: `{ commitment, signature: { r, s }, nonce }`
- [ ] Run test: `npx jest --testPathPattern mina-payment-channel-sdk.atdd --no-coverage`
- [ ] Test passes (green phase)

**Estimated Effort:** 2 hours

---

### Test: verifyBalanceProof validates proof (AC 10)

**File:** `packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts`

**Tasks to make this test pass:**

- [ ] Deserialize the proof string
- [ ] Verify the signature against the commitment using `Signature.fromJSON().verify()`
- [ ] Return boolean result
- [ ] Run test: `npx jest --testPathPattern mina-payment-channel-sdk.atdd --no-coverage`
- [ ] Test passes (green phase)

**Estimated Effort:** 1 hour

---

### Test: subscribeToChannel polls for state changes (AC 11)

**File:** `packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts`

**Tasks to make this test pass:**

- [ ] Set up `setInterval()` polling (default ~30s)
- [ ] Call `getChannelState()` on each poll, compare with previous
- [ ] Invoke callback when state changes detected
- [ ] Return `MinaSubscription` handle with `unsubscribe()` calling `clearInterval()`
- [ ] Guard against overlapping polls (in-flight flag)
- [ ] Wrap poll errors in `_logger.warn()` without propagating
- [ ] Run test: `npx jest --testPathPattern mina-payment-channel-sdk.atdd --no-coverage`
- [ ] Test passes (green phase)

**Estimated Effort:** 2 hours

---

### Test: Error handling (cross-cutting)

**File:** `packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts`

**Tasks to make this test pass:**

- [ ] Implement dynamic `await import('o1js')` with error wrapping (code 9999)
- [ ] Wrap transaction send failures in `MinaChannelError` code 1002
- [ ] Wrap proof generation failures in `MinaChannelError` code 1003
- [ ] Add optional 4th constructor parameter for signer private key
- [ ] Maintain backward compatibility (3-param constructor still works)
- [ ] Run test: `npx jest --testPathPattern mina-payment-channel-sdk.atdd --no-coverage`
- [ ] Test passes (green phase)

**Estimated Effort:** 2 hours

---

## Running Tests

```bash
# Run all ATDD tests for this story
npx jest packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts --no-coverage

# Run with verbose output
npx jest packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts --no-coverage --verbose

# Run a specific test by name
npx jest packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts --no-coverage -t "should compile"

# Run with coverage
npx jest packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts --coverage
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 29 tests written and skipped (`it.skip`)
- o1js and mina-zkapp mocks configured
- FutureMinaSDK interface defines the Story 34.4 API shape
- Implementation checklist created mapping each AC to tasks

**Verification:**

- All 29 tests run and are skipped as expected
- Failure is due to stub methods, not test bugs
- Test run output: `Tests: 29 skipped, 29 total`

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. **Pick one failing test** from implementation checklist (start with AC 1: compileContract)
2. **Read the test** to understand expected behavior
3. **Implement minimal code** to make that specific test pass
4. **Remove `it.skip`** from the test to enable it
5. **Run the test** to verify it now passes (green)
6. **Move to next test** and repeat
7. **Update provider** (`mina-payment-channel-provider.ts`) for SDK signature changes

**Key Principles:**

- One test at a time (do not try to fix all at once)
- Minimal implementation (do not over-engineer)
- Run tests frequently (immediate feedback)
- Use implementation checklist as roadmap
- Remove `FutureMinaSDK` interface once real SDK matches

---

### REFACTOR Phase (DEV Team - After All Tests Pass)

**DEV Agent Responsibilities:**

1. **Verify all tests pass** (green phase complete)
2. **Remove FutureMinaSDK** interface from test file (use real SDK types)
3. **Remove `as unknown as FutureMinaSDK`** casts
4. **Review code for quality** (readability, maintainability)
5. **Ensure tests still pass** after each refactor
6. **Run full regression**: `make test`

---

## Next Steps

1. **Review this checklist** with team
2. **Run failing tests** to confirm RED phase: `npx jest packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts --no-coverage`
3. **Begin implementation** using implementation checklist as guide
4. **Work one test at a time** (red -> green for each)
5. **When all tests pass**, refactor code for quality
6. **Run regression gate**: `make test && make lint`

---

## Knowledge Base References Applied

This ATDD workflow consulted the following knowledge fragments:

- **data-factories.md** - Factory patterns (adapted: deterministic blockchain constants used instead of faker for crypto primitives)
- **test-quality.md** - Test design principles (Given-When-Then, isolation, determinism)
- **test-healing-patterns.md** - Common failure patterns and automated fixes
- **test-levels-framework.md** - Test level selection (unit chosen for SDK with mocked o1js)
- **test-priorities-matrix.md** - P0-P3 priority assignment based on risk

See `tea-index.csv` for complete knowledge fragment mapping.

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest packages/connector/src/settlement/mina-payment-channel-sdk.atdd.test.ts --no-coverage`

**Results:**

```
Test Suites: 1 skipped, 0 of 1 total
Tests:       29 skipped, 29 total
Snapshots:   0 total
Time:        1.316 s
```

**Summary:**

- Total tests: 29
- Passing: 0 (expected)
- Failing: 0 (all skipped)
- Skipped: 29 (expected -- RED phase uses `it.skip`)
- Status: RED phase verified

---

## Notes

- **No E2E or API tests**: This is a backend SDK story with all o1js interactions mocked at the unit level. No browser or HTTP endpoint testing needed.
- **FutureMinaSDK interface**: The test file defines a `FutureMinaSDK` interface that matches the Story 34.4 extended signatures. This allows type-safe tests against the future API while the current stub has different signatures. Once the SDK is implemented, remove this interface and use `MinaPaymentChannelSDK` directly.
- **Provider updates required**: Story 34.4 changes SDK method signatures (claimFromChannel, closeChannel, settleChannel, constructor). The provider file `mina-payment-channel-provider.ts` must be updated to match. Existing provider tests may need mock signature updates.
- **Integration tests out of scope**: Per the story notes, this is unit-test only. A future story should add integration tests with real o1js compilation.

---

**Generated by BMad TEA Agent** - 2026-03-29
