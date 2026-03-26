---
stepsCompleted: ['step-01-preflight-and-context', 'step-02-generation-mode', 'step-03-test-strategy', 'step-04-generate-tests', 'step-04c-aggregate', 'step-05-validate-and-complete']
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-03-26'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/33-5-implement-solana-payment-channel-provider.md'
  - '_bmad/tea/testarch/knowledge/data-factories.md'
  - '_bmad/tea/testarch/knowledge/test-quality.md'
  - '_bmad/tea/testarch/knowledge/test-levels-framework.md'
  - '_bmad/tea/testarch/knowledge/test-healing-patterns.md'
  - '_bmad/tea/testarch/knowledge/test-priorities-matrix.md'
  - 'packages/connector/src/settlement/provider/payment-channel-provider.ts'
  - 'packages/connector/src/settlement/provider/evm-payment-channel-provider.test.ts'
  - 'packages/connector/jest.config.js'
---

# ATDD Checklist - Epic 33, Story 5: Implement SolanaPaymentChannelProvider

**Date:** 2026-03-26
**Author:** Jonathan
**Primary Test Level:** Unit

---

## Story Summary

Implement a Solana-specific `PaymentChannelProvider` that wraps the `SolanaPaymentChannelSDK` (Story 33.4) to conform to the chain-agnostic provider interface (Epic 32). This enables the connector to settle with peers over Solana using the same abstraction layer used by the EVM provider.

**As a** connector operator
**I want** a Solana implementation of the `PaymentChannelProvider` interface
**So that** the connector can settle with peers over Solana using the chain-abstraction layer from Epic 32

---

## Acceptance Criteria

1. **AC 1:** SolanaPaymentChannelProvider implements PaymentChannelProvider interface, chainType = 'solana', chainId = 'solana:<cluster>'
2. **AC 2:** openChannel delegates to SolanaPaymentChannelSDK.openChannel() with correct param mapping
3. **AC 3:** deposit converts string amount to bigint, derives ATA, delegates to SDK
4. **AC 4:** claimFromChannel extracts nonce/transferredAmount from balanceProof, decodes base64 signature, delegates to SDK
5. **AC 5:** closeChannel and settleChannel delegate to corresponding SDK methods
6. **AC 6:** signBalanceProof calls SDK static method with _signer.keyPair, returns base64
7. **AC 7:** verifyBalanceProof reconstructs message, verifies Ed25519 signature off-chain
8. **AC 8:** getChannelState maps SolanaChannelState to ProviderChannelState
9. **AC 9:** subscribeToEvents diffs previous/current state and emits appropriate ProviderEvent
10. **AC 10:** Solana program errors wrapped with provider context (chainId, channelId)
11. **AC 11:** createSolanaProviderFactory produces providers from config, registers with ChainProviderRegistry

---

## Test Strategy

**Detected Stack:** Backend (Node.js/TypeScript with Jest)
**Generation Mode:** AI Generation (no browser recording needed)
**Primary Test Level:** Unit (all tests mock SolanaPaymentChannelSDK)
**Test Framework:** Jest 29.7.0 + ts-jest
**Test File:** `packages/connector/src/settlement/provider/solana-payment-channel-provider.test.ts`

### Test Level Justification

All 22 tests are **unit tests** because:
- The provider is a thin adapter/wrapper around the SDK
- All SDK methods are mocked -- no real Solana RPC or on-chain interaction
- Pure business logic: param conversion, error mapping, state diffing
- Follows the established EVM provider test pattern exactly

### AC-to-Test Mapping

| AC | Test ID | Scenario | Level | Priority | Red Phase Failure |
|----|---------|----------|-------|----------|-------------------|
| 1 | T-33.5-01 | Constructor validates non-empty chainId and tokenMint | Unit | P0 | Class does not exist |
| 1 | T-33.5-02 | chainType is 'solana', chainId matches constructor arg | Unit | P0 | Class does not exist |
| 2 | T-33.5-03 | openChannel delegates to SDK with correct params, returns OpenChannelResult | Unit | P0 | Method not implemented |
| 3 | T-33.5-04 | deposit converts string amount to bigint, derives ATA, delegates to SDK | Unit | P0 | Method not implemented |
| 3 | T-33.5-20 | deposit derives correct associated token account for depositor | Unit | P0 | ATA derivation not implemented |
| 4 | T-33.5-05 | claimFromChannel decodes base64 signature, extracts nonce/amount, delegates | Unit | P0 | Method not implemented |
| 5 | T-33.5-06 | closeChannel delegates to SDK | Unit | P1 | Method not implemented |
| 5 | T-33.5-07 | settleChannel fetches state, derives ATAs, delegates to SDK | Unit | P1 | Method not implemented |
| 5 | T-33.5-21 | settleChannel fetches state and derives ATAs for both participants | Unit | P0 | ATA derivation not implemented |
| 6 | T-33.5-08 | signBalanceProof calls SDK static method, returns base64 signature | Unit | P0 | Method not implemented |
| 6 | T-33.5-22 | signBalanceProof passes _signer.keyPair (not _signer) to SDK static method | Unit | P0 | Wrong argument passed |
| 7 | T-33.5-09 | verifyBalanceProof reconstructs message and verifies Ed25519 signature | Unit | P0 | Method not implemented |
| 8 | T-33.5-10 | getChannelState maps SolanaChannelState to ProviderChannelState | Unit | P0 | Method not implemented |
| 9 | T-33.5-11 | subscribeToEvents detects claim (transferredAmount increase), emits channel_claimed | Unit | P1 | Method not implemented |
| 9 | T-33.5-12 | subscribeToEvents detects deposit, emits channel_deposited | Unit | P1 | Method not implemented |
| 9 | T-33.5-13 | subscribeToEvents detects close, emits channel_closed | Unit | P1 | Method not implemented |
| 9 | T-33.5-14 | subscribeToEvents detects settle, emits channel_settled | Unit | P1 | Method not implemented |
| 10 | T-33.5-15 | SolanaChannelError mapped to descriptive provider Error with context | Unit | P0 | Error mapping not implemented |
| 11 | T-33.5-16 | createSolanaProviderFactory rejects non-solana config | Unit | P0 | Factory not implemented |
| 11 | T-33.5-17 | createSolanaProviderFactory returns SolanaPaymentChannelProvider from valid config | Unit | P0 | Factory not implemented |
| 6 | T-33.5-18 | lockedAmount and locksRoot safely ignored with warning log | Unit | P1 | Warning not implemented |
| 1 | T-33.5-19 | getSolanaContext returns programId, tokenMint, cluster, signerAddress | Unit | P1 | Method not implemented |

---

## Failing Tests Created (RED Phase)

### Unit Tests (27 tests)

**File:** `packages/connector/src/settlement/provider/solana-payment-channel-provider.test.ts` (580 lines)

- **Test:** Constructor validates non-empty chainId (T-33.5-01)
  - **Status:** RED - Class does not exist (TS2307: Cannot find module)
  - **Verifies:** Constructor throws on empty chainId

- **Test:** Constructor validates non-empty tokenMint (T-33.5-01)
  - **Status:** RED - Class does not exist
  - **Verifies:** Constructor throws on empty tokenMint

- **Test:** chainType is 'solana' (T-33.5-02)
  - **Status:** RED - Class does not exist
  - **Verifies:** chainType readonly property returns 'solana'

- **Test:** chainId matches constructor arg (T-33.5-02)
  - **Status:** RED - Class does not exist
  - **Verifies:** chainId returns 'solana:devnet'

- **Test:** implements PaymentChannelProvider interface (T-33.5-02)
  - **Status:** RED - Class does not exist
  - **Verifies:** All interface methods present and typed correctly

- **Test:** openChannel delegates to SDK with correct params (T-33.5-03)
  - **Status:** RED - Method not implemented
  - **Verifies:** SDK called with signer, participantA, participantB, tokenMint, BigInt(timeout)

- **Test:** deposit converts string amount to bigint and delegates (T-33.5-04)
  - **Status:** RED - Method not implemented
  - **Verifies:** String amount converted to bigint, ATA derived, SDK called

- **Test:** deposit throws on invalid amount string (T-33.5-04)
  - **Status:** RED - Method not implemented
  - **Verifies:** safeBigInt throws descriptive error

- **Test:** deposit derives correct ATA for depositor (T-33.5-20)
  - **Status:** RED - ATA derivation not implemented
  - **Verifies:** Third argument to sdk.deposit is a non-empty ATA string

- **Test:** claimFromChannel decodes base64 signature, extracts nonce/amount (T-33.5-05)
  - **Status:** RED - Method not implemented
  - **Verifies:** Base64 decoded to Uint8Array, nonce as bigint, amount as bigint

- **Test:** closeChannel delegates to SDK (T-33.5-06)
  - **Status:** RED - Method not implemented
  - **Verifies:** SDK called with signer as closer

- **Test:** settleChannel fetches state, derives ATAs, delegates (T-33.5-07)
  - **Status:** RED - Method not implemented
  - **Verifies:** getChannelState called first, then settleChannel with both ATAs

- **Test:** settleChannel derives distinct ATAs for both participants (T-33.5-21)
  - **Status:** RED - ATA derivation not implemented
  - **Verifies:** Two distinct non-empty ATA strings passed to SDK

- **Test:** signBalanceProof calls SDK static method, returns base64 (T-33.5-08)
  - **Status:** RED - Method not implemented
  - **Verifies:** SDK static method called, Uint8Array result encoded as base64

- **Test:** signBalanceProof passes _signer.keyPair not _signer (T-33.5-22)
  - **Status:** RED - Method not implemented
  - **Verifies:** 4th argument has publicKey/privateKey but NOT address

- **Test:** verifyBalanceProof returns boolean for valid signature (T-33.5-09)
  - **Status:** RED - Method not implemented
  - **Verifies:** Returns boolean, reconstructs 48-byte message

- **Test:** verifyBalanceProof returns false on error (T-33.5-09)
  - **Status:** RED - Method not implemented
  - **Verifies:** Invalid input returns false, does not throw

- **Test:** getChannelState maps SolanaChannelState to ProviderChannelState (T-33.5-10)
  - **Status:** RED - Method not implemented
  - **Verifies:** channelId, status, participants, deposit (sum) mapping

- **Test:** getChannelState maps closed state correctly (T-33.5-10)
  - **Status:** RED - Method not implemented
  - **Verifies:** status='closed', deposit sums correctly

- **Test:** subscribeToEvents detects claim (T-33.5-11)
  - **Status:** RED - Method not implemented
  - **Verifies:** transferredAmount increase emits channel_claimed

- **Test:** subscribeToEvents detects deposit (T-33.5-12)
  - **Status:** RED - Method not implemented
  - **Verifies:** deposit increase emits channel_deposited

- **Test:** subscribeToEvents detects close (T-33.5-13)
  - **Status:** RED - Method not implemented
  - **Verifies:** State transition to closed emits channel_closed

- **Test:** subscribeToEvents detects settle (T-33.5-14)
  - **Status:** RED - Method not implemented
  - **Verifies:** State transition to settled emits channel_settled

- **Test:** subscribeToEvents returns subscription with unsubscribe (T-33.5-14)
  - **Status:** RED - Method not implemented
  - **Verifies:** unsubscribe method calls SDK unsubscribe

- **Test:** SolanaChannelError wrapped with provider context (T-33.5-15)
  - **Status:** RED - Error mapping not implemented
  - **Verifies:** Error message includes chainId, channelId, errorName

- **Test:** Non-SolanaChannelError re-thrown as-is (T-33.5-15)
  - **Status:** RED - Error mapping not implemented
  - **Verifies:** Generic errors pass through unchanged

- **Test:** createSolanaProviderFactory rejects non-solana config (T-33.5-16)
  - **Status:** RED - Factory not implemented
  - **Verifies:** Throws on config.chainType !== 'solana'

- **Test:** createSolanaProviderFactory returns valid provider (T-33.5-17)
  - **Status:** RED - Factory not implemented
  - **Verifies:** Returns SolanaPaymentChannelProvider instance with correct chainId

- **Test:** Factory defaults cluster to devnet (T-33.5-17)
  - **Status:** RED - Factory not implemented
  - **Verifies:** chainId = 'solana:devnet' when cluster not specified

- **Test:** lockedAmount and locksRoot ignored with warning (T-33.5-18)
  - **Status:** RED - Warning not implemented
  - **Verifies:** logger.warn called when lockedAmount non-zero or locksRoot non-empty

- **Test:** getSolanaContext returns Solana-specific context (T-33.5-19)
  - **Status:** RED - Method not implemented
  - **Verifies:** Returns { programId, tokenMint, cluster, signerAddress }

---

## Data Factories Created

No separate data factory files needed. Test data is defined inline using constants and the `createMockChannelState()` helper function within the test file. This follows the EVM provider test pattern.

### SolanaChannelState Factory

**File:** Inline in `solana-payment-channel-provider.test.ts`

**Exports:**
- `createMockChannelState(overrides?)` - Create SolanaChannelState with sensible defaults and optional overrides

**Example Usage:**

```typescript
const state = createMockChannelState({ depositA: 2000n, state: 'closed' });
```

---

## Fixtures Created

No separate fixture files needed. Mock creation utilities are defined inline in the test file:

### Test Helpers (inline)

**File:** `packages/connector/src/settlement/provider/solana-payment-channel-provider.test.ts`

**Helpers:**
- `createMockLogger()` - Creates silent pino-compatible mock logger with jest.fn() stubs
- `createMockSDK()` - Creates mock SolanaPaymentChannelSDK with jest.fn() stubs for all methods
- `createMockSigner()` - Creates mock KeyPairSigner with address and keyPair properties
- `createProvider(sdk, options?)` - Creates SolanaPaymentChannelProvider with mock dependencies
- `createMockChannelState(overrides?)` - Creates default SolanaChannelState for testing

---

## Mock Requirements

### SolanaPaymentChannelSDK Mock

All SDK instance methods are mocked with `jest.fn()`:
- `openChannel` - Returns `{ channelPDA, txSignature }`
- `deposit` - Returns `{ txSignature }`
- `claimFromChannel` - Returns `{ txSignature }`
- `closeChannel` - Returns `{ txSignature }`
- `settleChannel` - Returns `{ txSignature }`
- `getChannelState` - Returns `SolanaChannelState`
- `subscribeToChannel` - Returns `{ unsubscribe: jest.fn() }`

### SolanaPaymentChannelSDK Static Methods

- `SolanaPaymentChannelSDK.signBalanceProof` - Mocked via `jest.spyOn(jest.requireActual(...))` to return `Uint8Array`
- `SolanaPaymentChannelSDK._buildBalanceProofMessage` - Used internally by verifyBalanceProof

### KeyPairSigner Mock

```typescript
{ address: 'Signer11111...', keyPair: { publicKey: Uint8Array(32), privateKey: Uint8Array(64) } }
```

### findAssociatedTokenPda Mock

The ATA derivation from `@solana-program/token` will be called by the provider. Tests verify the derived ATA is passed as a non-empty string argument.

**Notes:** All mocks are inline in the test file using Jest patterns. No external mock setup files needed.

---

## Required data-testid Attributes

Not applicable -- this is a backend-only unit test story with no UI components.

---

## Implementation Checklist

### Test: Constructor validation (T-33.5-01, T-33.5-02)

**File:** `solana-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Create `packages/connector/src/settlement/provider/solana-payment-channel-provider.ts`
- [ ] Implement `SolanaPaymentChannelProvider` class with constructor
- [ ] Validate non-empty `chainId` and `tokenMint` in constructor
- [ ] Set `readonly chainType: BlockchainType = 'solana'`
- [ ] Set `readonly chainId: string` from constructor arg
- [ ] Run test: `npx jest --testPathPattern=solana-payment-channel-provider`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: openChannel delegation (T-33.5-03)

**File:** `solana-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `openChannel(participant, settlementTimeout)` method
- [ ] Pass `this._signer` as payer, `this._signer.address` as participantA
- [ ] Pass `participant` as participantB, `this._tokenMint`, `BigInt(settlementTimeout)`
- [ ] Map result: `{ channelId: result.channelPDA, txHash: result.txSignature }`
- [ ] Run test: `npx jest --testPathPattern=solana-payment-channel-provider -t "openChannel"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: deposit delegation with ATA derivation (T-33.5-04, T-33.5-20)

**File:** `solana-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `deposit(channelId, amount)` method
- [ ] Implement `safeBigInt()` helper for amount conversion
- [ ] Implement `_deriveATA(owner)` private helper using `findAssociatedTokenPda`
- [ ] Derive depositor ATA from `this._signer.address` + `this._tokenMint`
- [ ] Delegate to SDK with signer, channelId, ATA, bigint amount
- [ ] Map result: `{ txHash: result.txSignature }`
- [ ] Run test: `npx jest --testPathPattern=solana-payment-channel-provider -t "deposit"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 1 hour

---

### Test: claimFromChannel delegation (T-33.5-05)

**File:** `solana-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `claimFromChannel(channelId, balanceProof, signature)` method
- [ ] Extract `BigInt(balanceProof.nonce)` and `safeBigInt(balanceProof.transferredAmount)`
- [ ] Decode base64 signature to `Uint8Array` via `Buffer.from(signature, 'base64')`
- [ ] Pass `this._signer` as claimer to SDK
- [ ] Map result: `{ txHash: result.txSignature }`
- [ ] Run test: `npx jest --testPathPattern=solana-payment-channel-provider -t "claimFromChannel"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: closeChannel and settleChannel delegation (T-33.5-06, T-33.5-07, T-33.5-21)

**File:** `solana-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `closeChannel(channelId)` -- pass `this._signer` as closer
- [ ] Implement `settleChannel(channelId)` -- fetch channel state first
- [ ] Derive both participants' ATAs using `_deriveATA`
- [ ] Pass `this._signer.address` as rentRecipient
- [ ] Map results: `{ txHash: result.txSignature }`
- [ ] Run test: `npx jest --testPathPattern=solana-payment-channel-provider -t "(close|settle)Channel"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 1 hour

---

### Test: signBalanceProof delegation (T-33.5-08, T-33.5-22)

**File:** `solana-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `signBalanceProof(params)` method
- [ ] Call `SolanaPaymentChannelSDK.signBalanceProof(channelId, BigInt(nonce), safeBigInt(amount), this._signer.keyPair)`
- [ ] Return `Buffer.from(resultBytes).toString('base64')`
- [ ] Log warning if `lockedAmount` non-zero or `locksRoot` non-empty
- [ ] Run test: `npx jest --testPathPattern=solana-payment-channel-provider -t "signBalanceProof"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: verifyBalanceProof off-chain verification (T-33.5-09)

**File:** `solana-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `verifyBalanceProof(params)` method
- [ ] Reconstruct 48-byte message via `SolanaPaymentChannelSDK._buildBalanceProofMessage()`
- [ ] Decode base64 signature to Uint8Array
- [ ] Decode signerAddress (base58) to 32-byte pubkey using `getAddressEncoder().encode()`
- [ ] Import pubkey as CryptoKey: `crypto.subtle.importKey('raw', pubkeyBytes, 'Ed25519', true, ['verify'])`
- [ ] Verify: `crypto.subtle.verify('Ed25519', key, signature, message)`
- [ ] Return `true`/`false`, wrap in try-catch returning `false` on error
- [ ] Run test: `npx jest --testPathPattern=solana-payment-channel-provider -t "verifyBalanceProof"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 1 hour

---

### Test: getChannelState mapping (T-33.5-10)

**File:** `solana-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `getChannelState(channelId)` method
- [ ] Delegate to SDK, map result to ProviderChannelState
- [ ] Map: channelId=PDA, status=state, participants=[A,B], deposit=depositA+depositB
- [ ] Run test: `npx jest --testPathPattern=solana-payment-channel-provider -t "getChannelState"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: subscribeToEvents state diffing (T-33.5-11 to T-33.5-14)

**File:** `solana-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `subscribeToEvents(channelId, callback)` method
- [ ] Wrap `sdk.subscribeToChannel()` callback
- [ ] Store previous state per channel subscription
- [ ] Diff previous vs current state to determine ProviderEventType
- [ ] Emit ProviderEvent with correct type for claim/deposit/close/settle
- [ ] Return `{ unsubscribe }` that delegates to SDK unsubscribe
- [ ] Run test: `npx jest --testPathPattern=solana-payment-channel-provider -t "subscribeToEvents"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 1 hour

---

### Test: Error mapping (T-33.5-15)

**File:** `solana-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Add try-catch around all SDK calls
- [ ] Catch `SolanaChannelError`, wrap with provider context string
- [ ] Re-throw non-SolanaChannelError errors as-is
- [ ] Run test: `npx jest --testPathPattern=solana-payment-channel-provider -t "Error mapping"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: Factory function (T-33.5-16, T-33.5-17)

**File:** `solana-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `createSolanaProviderFactory(logger, signer, tokenMint)`
- [ ] Validate `config.chainType === 'solana'`
- [ ] Create SDK from config.rpcUrl and config.programId
- [ ] Default cluster to 'devnet' when not specified
- [ ] Return new SolanaPaymentChannelProvider instance
- [ ] Run test: `npx jest --testPathPattern=solana-payment-channel-provider -t "Factory"`
- [ ] Tests pass (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: getSolanaContext (T-33.5-19)

**File:** `solana-payment-channel-provider.test.ts`

**Tasks to make this test pass:**

- [ ] Implement `getSolanaContext()` method
- [ ] Return `{ programId, tokenMint, cluster, signerAddress }`
- [ ] Extract cluster from chainId (split on ':')
- [ ] Run test: `npx jest --testPathPattern=solana-payment-channel-provider -t "getSolanaContext"`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.25 hours

---

### Test: Barrel exports (Task 6)

**Tasks:**

- [ ] Add `SolanaPaymentChannelProvider` and `createSolanaProviderFactory` to `provider/index.ts`
- [ ] Run `npx tsc --noEmit` -- TypeScript compiles
- [ ] Run `npx jest --testPathPattern=solana-payment-channel-provider` -- all 27 tests pass

**Estimated Effort:** 0.25 hours

---

## Running Tests

```bash
# Run all failing tests for this story
npx jest --config packages/connector/jest.config.js --testPathPattern=solana-payment-channel-provider --no-coverage

# Run specific test group
npx jest --config packages/connector/jest.config.js --testPathPattern=solana-payment-channel-provider -t "openChannel"

# Run with verbose output
npx jest --config packages/connector/jest.config.js --testPathPattern=solana-payment-channel-provider --verbose --no-coverage

# Run with coverage
npx jest --config packages/connector/jest.config.js --testPathPattern=solana-payment-channel-provider --coverage

# Run full regression gate
npm test --workspace=packages/connector
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All tests written and failing (module does not exist)
- Mock infrastructure created (SDK mock, signer mock, channel state factory)
- Implementation checklist created with granular tasks
- Test file follows EVM provider test pattern exactly

**Verification:**

- Test suite fails with: `TS2307: Cannot find module './solana-payment-channel-provider'`
- Failure is due to missing implementation, not test bugs
- 89 existing test suites (2088 tests) continue to pass

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. **Create** `solana-payment-channel-provider.ts` with class skeleton
2. **Implement constructor** -- first 5 tests should pass (T-33.5-01, T-33.5-02)
3. **Implement lifecycle methods** one at a time (openChannel, deposit, close, settle)
4. **Implement claim methods** (claimFromChannel, signBalanceProof, verifyBalanceProof)
5. **Implement state/events** (getChannelState, subscribeToEvents)
6. **Implement error mapping and factory** (error wrapping, createSolanaProviderFactory)
7. **Update barrel exports** in `provider/index.ts`
8. **Run full regression gate** -- all existing + new tests pass

**Key Principles:**

- One test group at a time (do not try to fix all at once)
- Minimal implementation (do not over-engineer)
- Run tests frequently (immediate feedback)
- Use implementation checklist as roadmap

---

### REFACTOR Phase (DEV Team - After All Tests Pass)

**DEV Agent Responsibilities:**

1. **Verify all tests pass** (green phase complete)
2. **Review code for quality** (readability, maintainability)
3. **Extract duplications** (ensure `_deriveATA` is reused by deposit and settleChannel)
4. **Verify logger format** (fields first, message second -- Pino convention)
5. **Ensure tests still pass** after each refactor
6. **Run regression gate** (`npm test` in packages/connector + `npx tsc --noEmit`)

---

## Next Steps

1. **Review this checklist** and failing tests with the dev workflow
2. **Run failing tests** to confirm RED phase: `npx jest --testPathPattern=solana-payment-channel-provider`
3. **Begin implementation** using implementation checklist as guide
4. **Work one test group at a time** (red -> green for each)
5. **When all tests pass**, refactor code for quality
6. **Run regression gate**: `npm test` in packages/connector
7. **When complete**, update story status

---

## Knowledge Base References Applied

This ATDD workflow consulted the following knowledge fragments:

- **data-factories.md** - Factory patterns with overrides for test data generation
- **test-quality.md** - Deterministic, isolated, explicit test design principles
- **test-levels-framework.md** - Test level selection (unit tests for pure adapter logic)
- **test-healing-patterns.md** - Common failure patterns and prevention
- **test-priorities-matrix.md** - P0-P3 priority assignment based on risk/impact

See `tea-index.csv` for complete knowledge fragment mapping.

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest --config packages/connector/jest.config.js --testPathPattern=solana-payment-channel-provider --no-coverage`

**Results:**

```
FAIL connector packages/connector/src/settlement/provider/solana-payment-channel-provider.test.ts
  Test suite failed to run

    packages/connector/src/settlement/provider/solana-payment-channel-provider.test.ts:49:8 - error TS2307: Cannot find module './solana-payment-channel-provider' or its corresponding type declarations.

    49 } from './solana-payment-channel-provider';
              ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Test Suites: 1 failed, 1 total
Tests:       0 total
Time:        1.323 s
```

**Summary:**

- Total tests: 27 (in 1 test file)
- Passing: 0 (expected)
- Failing: 1 suite (expected -- module not found)
- Status: RED phase verified

**Expected Failure Message:**
- `TS2307: Cannot find module './solana-payment-channel-provider'` -- Implementation file does not exist yet

### Regression Gate (Existing Tests)

**Command:** `npx jest --config packages/connector/jest.config.js --testPathIgnorePatterns='solana-payment-channel-provider' --no-coverage`

**Results:**
- Test Suites: 89 passed, 89 of 92 total (3 skipped)
- Tests: 2088 passed, 70 skipped, 2158 total
- Status: All existing tests pass

---

## Notes

- All tests follow the EVM provider test pattern from `evm-payment-channel-provider.test.ts` for consistency
- Tests use `jest.requireActual()` for SDK static method spying (signBalanceProof) since the class will need to be partially mocked
- The ATA derivation tests verify the derived address is passed as a non-empty string rather than asserting a specific address, since the actual derivation depends on `@solana-program/token`
- `verifyBalanceProof` tests are minimal since the implementation uses Node.js `crypto.subtle` which requires real CryptoKey objects -- full verification will be tested in Story 33.7 integration tests
- Logger mock uses `jest.fn()` stubs to verify `logger.warn` calls for lockedAmount/locksRoot warnings

---

## Contact

**Questions or Issues?**

- Ask in team standup
- Refer to `_bmad-output/implementation-artifacts/33-5-implement-solana-payment-channel-provider.md` for full story context
- Reference `evm-payment-channel-provider.ts` and its test file as the implementation pattern

---

**Generated by BMad TEA Agent** - 2026-03-26
