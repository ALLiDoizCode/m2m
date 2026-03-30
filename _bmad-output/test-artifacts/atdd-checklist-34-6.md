---
stepsCompleted: ['step-01-preflight-and-context', 'step-02-generation-mode', 'step-03-test-strategy', 'step-04-generate-tests', 'step-04c-aggregate', 'step-05-validate-and-complete']
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-03-28'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/34-6-nip59-claim-wrapping-transport-privacy.md'
  - '_bmad-output/planning-artifacts/test-design-epic-34.md'
  - 'packages/connector/src/btp/btp-claim-types.ts'
  - '_bmad/tea/testarch/knowledge/data-factories.md'
  - '_bmad/tea/testarch/knowledge/test-quality.md'
  - '_bmad/tea/testarch/knowledge/test-levels-framework.md'
  - '_bmad/tea/testarch/knowledge/test-healing-patterns.md'
  - '_bmad/tea/testarch/knowledge/test-priorities-matrix.md'
---

# ATDD Checklist - Epic 34, Story 34.6: NIP-59-Inspired Claim Wrapping for Transport Privacy

**Date:** 2026-03-28
**Author:** Jonathan
**Primary Test Level:** Unit

---

## Story Summary

Implement optional three-layer NIP-59-inspired encryption wrapping for BTP claim messages. The wrapper provides transport-layer privacy by hiding claim contents, sender identity, and timing from BTP intermediaries, complementing Mina's on-chain zk-SNARK privacy.

**As a** connector operator
**I want** optional three-layer NIP-59-inspired encryption wrapping for claim messages exchanged over BTP
**So that** BTP intermediaries cannot observe claim contents, sender identity, or timing

---

## Acceptance Criteria

1. **AC 1:** Three-layer wrapping: Rumor (unsigned claim) -> Seal (encrypted to peer, signed by sender) -> Gift Wrap (encrypted with ephemeral key, randomized timestamp)
2. **AC 2:** Gift wrap layer uses ephemeral one-time key, hiding sender identity
3. **AC 3:** Seal layer verifies sender via signature and shared secret decryption
4. **AC 4:** Rumor contains valid BTPClaimMessage (with zk proof if present)
5. **AC 5:** Config toggle: disabled = plaintext claim via BTP protocolData
6. **AC 6:** BTP intermediary sees only encrypted bytes and ephemeral public key
7. **AC 7:** Each wrapping uses a fresh ephemeral key (no reuse)
8. **AC 8:** Gift wrap timestamp randomized within +-48 hours, never exactly equal to actual send time
9. **AC 9:** Full round-trip: wrap -> transmit -> unwrap -> extract matches original
10. **AC 10:** Wrong key decryption fails gracefully with descriptive error

---

## Test Strategy

### Test Level Selection

All tests are **Unit** level. Justification: NIP-59 wrapping is pure cryptographic logic with no external dependencies (no database, no network, no file system). The @noble crypto stack operates on in-memory byte arrays. Unit tests provide the fastest feedback and most precise failure diagnosis for this type of work.

No integration or E2E tests are needed for this story. Integration with the claim pipeline (ClaimReceiver, PerPacketClaimService) is deferred to Story 34.8.

### Test Map: Acceptance Criteria to Test Scenarios

| Test ID | AC | Scenario | Level | Priority | Red Phase Failure Reason |
|---------|-----|----------|-------|----------|--------------------------|
| T-34.6-01 | AC 1 | Three-layer wrapping (rumor -> seal -> gift wrap) | Unit | P0 | Module not found: `nip59-claim-wrapper.ts` does not exist |
| T-34.6-02 | AC 2, 6 | Gift wrap uses ephemeral key, no sender identity revealed | Unit | P0 | Module not found |
| T-34.6-03 | AC 3 | Seal decrypted with shared secret, reveals signed rumor | Unit | P0 | Module not found |
| T-34.6-04 | AC 4 | Rumor contains valid claim message (EVM primary, Solana + Mina secondary) | Unit | P0 | Module not found |
| T-34.6-05 | AC 7 | Each wrap uses fresh ephemeral key (no reuse) | Unit | P0 | Module not found |
| T-34.6-06 | AC 9 | Full round-trip correctness (EVM, Solana, Mina fixtures) | Unit | P0 | Module not found |
| T-34.6-07 | AC 6 | Wrapped claim indistinguishable -- only encrypted bytes + ephemeral key visible | Unit | P1 | Module not found |
| T-34.6-08 | AC 5 | NIP-59 disabled -> plaintext claim passthrough | Unit | P0 | Module not found |
| T-34.6-09 | AC 5, 6 | NIP-59 enabled -> protocolName 'claim-wrapped' with APPLICATION_OCTET_STREAM | Unit | P0 | Module not found |
| T-34.6-10 | AC 10 | Wrong private key -> graceful NIP59WrapError | Unit | P1 | Module not found |
| T-34.6-11 | -- | Wrapping overhead measurement (advisory, not a gate) | Unit | P2 | Module not found |
| T-34.6-12 | AC 8 | Gift wrap timestamp randomized within +-48h, not exact | Unit | P1 | Module not found |
| T-34.6-13 | AC 10 | Malformed/truncated WrappedClaim -> graceful error | Unit | P1 | Module not found |

### Priority Justification

- **P0 (8 tests):** Core wrapping/unwrapping correctness and round-trip integrity. Security-critical: broken wrapping = privacy leak. Config toggle correctness = operational safety.
- **P1 (4 tests):** Privacy verification (intermediary indistinguishability, timestamp randomization), error handling for wrong keys and malformed data. Important but secondary to core correctness.
- **P2 (1 test):** Overhead measurement is advisory only -- not a quality gate, useful for performance awareness.

### Red Phase Confirmation

All 13 tests will fail with `Cannot find module` because the implementation file `packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts` does not exist yet. This is the expected TDD red phase: tests are written against the public API contract before any implementation code exists.

---

## Failing Tests Created (RED Phase)

### Unit Tests (27 test cases across 13 test IDs)

**File:** `packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts` (~390 lines)

- **T-34.6-01:** Three-layer wrapping (rumor -> seal -> gift wrap)
  - Status: RED - Cannot find module './nip59-claim-wrapper'
  - Tests: 2 (structure validation, WrappedClaim format)
  - Verifies: AC 1

- **T-34.6-02:** Gift wrap uses ephemeral key, no sender identity
  - Status: RED - Cannot find module
  - Tests: 2 (ephemeral != sender key, no sender identity in serialized output)
  - Verifies: AC 2, AC 6

- **T-34.6-03:** Seal layer verification
  - Status: RED - Cannot find module
  - Tests: 1 (unwrap reveals sender identity after seal decryption)
  - Verifies: AC 3

- **T-34.6-04:** Rumor contains valid claim message
  - Status: RED - Cannot find module
  - Tests: 3 (EVM with validateClaimMessage, Solana with validateClaimMessage, Mina with JSON equality)
  - Verifies: AC 4

- **T-34.6-05:** Fresh ephemeral key per wrapping
  - Status: RED - Cannot find module
  - Tests: 2 (different ephemeral keys, different encrypted payloads)
  - Verifies: AC 7

- **T-34.6-06:** Full round-trip correctness
  - Status: RED - Cannot find module
  - Tests: 4 (EVM round-trip, Solana round-trip, Mina round-trip, round-trip with serialization)
  - Verifies: AC 9

- **T-34.6-07:** Wrapped claim indistinguishable
  - Status: RED - Cannot find module
  - Tests: 2 (no plaintext fields visible, only 4 allowed keys)
  - Verifies: AC 6

- **T-34.6-08:** NIP-59 disabled sends plaintext
  - Status: RED - Cannot find module
  - Tests: 2 (wrapClaim returns null, isEnabled returns false)
  - Verifies: AC 5

- **T-34.6-09:** NIP-59 enabled uses claim-wrapped protocol
  - Status: RED - Cannot find module
  - Tests: 4 (BTP_WRAPPED_CLAIM_PROTOCOL constants, isEnabled true, serialize produces Buffer, deserialize recovers)
  - Verifies: AC 5, AC 6

- **T-34.6-10:** Wrong private key fails gracefully
  - Status: RED - Cannot find module
  - Tests: 3 (throws NIP59WrapError, descriptive message, preserves cause)
  - Verifies: AC 10

- **T-34.6-11:** Wrapping overhead measurement
  - Status: RED - Cannot find module
  - Tests: 1 (advisory overhead ratio)
  - Verifies: Performance awareness (not a gate)

- **T-34.6-12:** Gift wrap timestamp randomization
  - Status: RED - Cannot find module
  - Tests: 3 (within +-48h, not exact, different across wraps)
  - Verifies: AC 8

- **T-34.6-13:** Malformed WrappedClaim handling
  - Status: RED - Cannot find module
  - Tests: 5 (truncated payload, invalid base64, missing ephemeralPublicKey, invalid object, garbage buffer)
  - Verifies: AC 10

### Additional Test

- **NIP59TransportWrapper alias:** Verifies architecture-doc alias exports correctly
  - Tests: 1

---

## Data Factories Created

### Claim Fixture Factories (inline in test file)

**File:** `packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts`

**Exports (test-local):**

- `createEVMClaimFixture()` - Creates valid EVMClaimMessage with realistic fields (channelId, nonce, transferredAmount, EIP-712 signature, chainId, token addresses)
- `createSolanaClaimFixture()` - Creates valid SolanaClaimMessage with base58 addresses, Ed25519 signature, cluster
- `createMinaClaimFixture()` - Creates minimal MinaClaimMessage stub (zkAppAddress, proof)
- `createWrapper(nip59Enabled?)` - Creates NIP59ClaimWrapper instance with mock logger

**Design Notes:**
- Factories use inline timestamps (`Date.now()`) for uniqueness across parallel runs
- EVM fixture passes `validateClaimMessage()` for full correctness validation
- Solana fixture passes `validateClaimMessage()` for full correctness validation
- Mina fixture uses JSON equality only (validateClaimMessage throws for Mina until Story 34.7)
- No `@faker-js/faker` needed -- crypto test data is deterministic by nature (hex strings, base58 addresses)

---

## Fixtures Created

No Playwright/Cypress fixtures needed. This is a pure unit test story with inline test helpers.

Test keypairs are generated once per suite in `beforeAll()` using `crypto.randomBytes(32)` and `secp256k1.getPublicKey()`. This provides real secp256k1 keypairs for each test run.

---

## Mock Requirements

No external service mocking required. The NIP-59 wrapper operates entirely on in-memory byte arrays using the @noble crypto stack. No network calls, no database, no file system access.

The test file uses a mock logger (jest.fn() stubs for info/warn/error/debug/child) to verify the wrapper does not log sensitive data.

---

## Required data-testid Attributes

Not applicable. This is a backend unit test story with no UI components.

---

## Implementation Checklist

### Task 1: Install @noble dependencies

**Tasks to make tests importable:**

- [ ] Run `npm install @noble/ciphers @noble/hashes @noble/curves --workspace=packages/connector`
- [ ] Verify `@noble/curves/secp256k1` resolves
- [ ] Verify `@noble/ciphers` provides `chacha20poly1305`
- [ ] Verify `@noble/hashes` provides `sha256` and `hkdf`

**Estimated Effort:** 0.25 hours

---

### Task 2: Create nip59-claim-wrapper.ts -- Types and Error Class (T-34.6-01, T-34.6-09, T-34.6-10)

**File:** `packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts`

**Tasks to make these tests pass:**

- [ ] Define `WrappedClaim` interface (`ephemeralPublicKey`, `encryptedPayload`, `timestamp`, `version`)
- [ ] Define `NIP59WrapError` class extending `Error` with `name = 'NIP59WrapError'` and `cause` property
- [ ] Define `BTP_WRAPPED_CLAIM_PROTOCOL` constant (`NAME: 'claim-wrapped'`, `CONTENT_TYPE: 0`, `VERSION: '1.0'`)
- [ ] Implement `serializeWrappedClaim(wrapped: WrappedClaim): Buffer` -- `JSON.stringify` to UTF-8 Buffer
- [ ] Implement `deserializeWrappedClaim(data: Buffer): WrappedClaim` -- parse JSON from Buffer
- [ ] Run tests: `npx jest packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts -t "T-34.6-09"`
- [ ] Tests pass (green phase for T-34.6-09 constants and serialization)

**Estimated Effort:** 0.5 hours

---

### Task 3: Implement NIP59ClaimWrapper.wrapClaim (T-34.6-01, T-34.6-02, T-34.6-05, T-34.6-07, T-34.6-08, T-34.6-12)

**File:** `packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts`

**Tasks to make these tests pass:**

- [ ] Create `NIP59ClaimWrapper` class with constructor accepting `{ nip59Enabled, logger }`
- [ ] Implement `isEnabled()` returning the config flag
- [ ] Implement `wrapClaim(claim, senderPrivateKey, receiverPublicKey): WrappedClaim | null`
  - [ ] If disabled, return `null` (T-34.6-08)
  - [ ] Create Rumor: `JSON.stringify(claim)`
  - [ ] Create Seal: ECDH shared secret (sender + receiver) -> HKDF-SHA256 (info: "nip59-seal") -> ChaCha20-Poly1305 encrypt rumor, sign ciphertext with sender key
  - [ ] Create Gift Wrap: generate ephemeral keypair, ECDH (ephemeral + receiver) -> HKDF-SHA256 (info: "nip59-giftwrap") -> ChaCha20-Poly1305 encrypt (seal + senderPubKey + signature)
  - [ ] Randomize timestamp within +-48 hours (T-34.6-12)
  - [ ] Return `WrappedClaim` with ephemeral public key, encrypted payload, randomized timestamp, version
- [ ] Export `NIP59TransportWrapper = NIP59ClaimWrapper` alias
- [ ] Run tests: `npx jest packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts -t "T-34.6-01|T-34.6-02|T-34.6-05|T-34.6-07|T-34.6-08|T-34.6-12"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 2 hours

---

### Task 4: Implement NIP59ClaimWrapper.unwrapClaim (T-34.6-03, T-34.6-04, T-34.6-06, T-34.6-10, T-34.6-13)

**File:** `packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts`

**Tasks to make these tests pass:**

- [ ] Implement `unwrapClaim(wrappedClaim, receiverPrivateKey): BTPClaimMessage`
  - [ ] Validate input fields (ephemeralPublicKey, encryptedPayload non-empty) -- throw `NIP59WrapError` on malformed input
  - [ ] Decrypt Gift Wrap: ECDH(receiverPriv, ephemeralPub) -> HKDF (info: "nip59-giftwrap") -> ChaCha20-Poly1305 decrypt
  - [ ] Extract sender public key and signature from decrypted gift wrap
  - [ ] Verify sender signature over seal ciphertext (SHA-256 hash -> secp256k1 verify)
  - [ ] Decrypt Seal: ECDH(receiverPriv, senderPub) -> HKDF (info: "nip59-seal") -> ChaCha20-Poly1305 decrypt
  - [ ] Parse Rumor JSON -> `BTPClaimMessage`
  - [ ] Wrap all failures in `NIP59WrapError` with descriptive message indicating which layer failed and preserving original error as `cause`
- [ ] Run tests: `npx jest packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts -t "T-34.6-03|T-34.6-04|T-34.6-06|T-34.6-10|T-34.6-13"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 2 hours

---

### Task 5: Create barrel export and verify overhead (T-34.6-11)

**File:** `packages/connector/src/settlement/privacy/index.ts`

**Tasks:**

- [ ] Create barrel `index.ts` exporting `NIP59ClaimWrapper`, `NIP59TransportWrapper`, `NIP59WrapError`, `BTP_WRAPPED_CLAIM_PROTOCOL`, `serializeWrappedClaim`, `deserializeWrappedClaim`, and `WrappedClaim` type
- [ ] Run full test suite: `npx jest packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts --no-coverage`
- [ ] All 27 tests pass (green phase)
- [ ] T-34.6-11 overhead measurement logged (advisory)

**Estimated Effort:** 0.25 hours

---

### Task 6: Regression gate

**Tasks:**

- [ ] `npm run build --workspace=packages/shared && npm run build --workspace=packages/connector` clean
- [ ] `make test` passes (all project tests green)
- [ ] All existing provider tests pass: EVM, Solana, Mina

**Estimated Effort:** 0.5 hours

---

## Running Tests

```bash
# Run all failing tests for this story
npx jest --config packages/connector/jest.config.js packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts --no-coverage

# Run specific test by ID pattern
npx jest --config packages/connector/jest.config.js packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts -t "T-34.6-06" --no-coverage

# Run with verbose output
npx jest --config packages/connector/jest.config.js packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts --verbose --no-coverage

# Run all connector tests (regression check)
npx jest --config packages/connector/jest.config.js --no-coverage

# Run full project tests
make test
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 27 tests written and failing (Cannot find module)
- Claim fixture factories created for EVM, Solana, Mina
- Real secp256k1 keypairs generated per test run
- Mock logger provided for privacy verification
- Implementation checklist created with 6 tasks

**Verification:**

```
FAIL packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts
  TS2307: Cannot find module './nip59-claim-wrapper' or its corresponding type declarations.

Test Suites: 1 failed, 1 total
Tests:       0 total
```

- All tests fail as expected (RED phase confirmed)
- Failure is due to missing implementation, not test bugs
- Existing tests unaffected (96 suites, 2329 tests passing)

---

### GREEN Phase (DEV Team -- Next Steps)

**DEV Agent Responsibilities:**

1. **Install dependencies** (`@noble/ciphers`, `@noble/hashes`, `@noble/curves`)
2. **Create `nip59-claim-wrapper.ts`** with types, error class, constants
3. **Implement `wrapClaim`** -- three-layer wrapping (rumor -> seal -> gift wrap)
4. **Implement `unwrapClaim`** -- three-layer unwrapping with error handling
5. **Create `index.ts` barrel** exports
6. **Run tests** to verify all 27 pass
7. **Run regression gate** (`make test`)

**Key Principles:**

- One task at a time (follow the implementation checklist order)
- Use @noble crypto stack exclusively (no Node.js crypto except randomBytes)
- Never log private keys, shared secrets, or decrypted content
- Preserve original errors as `cause` in NIP59WrapError

---

### REFACTOR Phase (DEV Team -- After All Tests Pass)

**DEV Agent Responsibilities:**

1. Verify all 27 tests pass (green phase complete)
2. Review code for crypto security (constant-time operations, no key leaks)
3. Verify Pino logging follows project convention (structured fields first)
4. Ensure JSDoc on all public methods
5. Run `make lint` and `npm run format:check`

---

## Next Steps

1. **Share this checklist** with the dev workflow (manual handoff)
2. **Run failing tests** to confirm RED phase: `npx jest --config packages/connector/jest.config.js packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts --no-coverage`
3. **Begin implementation** using implementation checklist as guide (Tasks 1-6)
4. **Work one task at a time** (red -> green for each)
5. **When all tests pass**, refactor code for quality
6. **When refactoring complete**, run `make test` for full regression gate

---

## Knowledge Base References Applied

This ATDD workflow consulted the following knowledge fragments:

- **data-factories.md** -- Factory patterns for test data generation with overrides (adapted for crypto fixtures)
- **test-quality.md** -- Test design principles: deterministic, isolated, explicit assertions, under 300 lines
- **test-levels-framework.md** -- Test level selection: unit tests for pure crypto logic (no DB/network/UI)
- **test-priorities-matrix.md** -- P0-P3 priority assignment based on security and correctness risk
- **test-healing-patterns.md** -- Error pattern awareness for descriptive failure messages

See `tea-index.csv` for complete knowledge fragment mapping.

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest --config packages/connector/jest.config.js packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts --no-coverage`

**Results:**

```
FAIL connector packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts
  TS2307: Cannot find module './nip59-claim-wrapper' or its corresponding type declarations.

Test Suites: 1 failed, 1 total
Tests:       0 total
Snapshots:   0 total
Time:        1.352 s
```

**Summary:**

- Total test cases: 27 (across 13 test IDs + 1 alias test)
- Passing: 0 (expected)
- Failing: 1 suite (expected -- module not found)
- Status: RED phase verified

**Regression Check:**

```
Test Suites: 96 passed, 96 of 99 total (3 skipped)
Tests:       2329 passed, 2401 total (72 skipped)
```

- All existing tests unaffected by the new test file

---

## Notes

- The wrapper is **chain-agnostic** by design. Tests include EVM, Solana, and Mina claim fixtures to prove this.
- `validateClaimMessage()` is NOT called on Mina claims in tests because it throws "not yet supported" -- JSON equality is used instead. Story 34.7 will fix this.
- The `NIP59TransportWrapper` alias test ensures architecture-doc consumers can import the class by either name.
- No `@faker-js/faker` is used because crypto test data (hex keys, base58 addresses) is inherently deterministic and collision-free.
- Story 34.8 will wire the privacy module into the settlement barrel (`settlement/index.ts`) and the claim pipeline.

---

**Generated by BMad TEA Agent** -- 2026-03-28
