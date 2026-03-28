---
stepsCompleted:
  - 'step-01-preflight-and-context'
  - 'step-02-generation-mode'
  - 'step-03-test-strategy'
  - 'step-04-generate-tests'
  - 'step-05-validate-and-complete'
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-03-28'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/34-9-mina-devnet-deployment-documentation.md'
  - 'packages/connector/test/integration/solana-deployment.test.ts'
  - 'packages/connector/test/integration/mina-config.test.ts'
  - 'packages/connector/src/settlement/provider/payment-channel-provider.ts'
  - 'packages/connector/src/config/types.ts'
  - 'tools/mina/deploy-zkapp.ts'
  - 'Makefile'
---

# ATDD Checklist - Epic 34, Story 9: Mina Devnet Deployment & Documentation

**Date:** 2026-03-28
**Author:** Jonathan
**Primary Test Level:** Integration (static file inspection + runtime config validation)

---

## Story Summary

Story 34.9 delivers the final piece of Epic 34 (Mina Protocol Payment Channel Provider): deploying the Mina zkApp to devnet and producing comprehensive documentation covering deployment, configuration, performance benchmarks, privacy model, and operations.

**As a** connector operator
**I want** the Mina payment channel zkApp deployed to devnet with configuration documentation, performance benchmarks, and a privacy model explanation
**So that** I can run the Mina settlement provider in a test environment and onboard new operators with clear guides

---

## Acceptance Criteria

1. **AC 1:** zkApp deployed to Mina devnet at a stable address with verification key hash recorded
2. **AC 2:** Deployed zkApp is verifiable via Mina GraphQL API with expected verification key hash
3. **AC 3:** Operator can configure MinaPaymentChannelProvider from documentation (YAML example, all config fields)
4. **AC 4:** Proof generation times documented by operation type with hardware recommendations
5. **AC 5:** Privacy guarantees clearly explained for non-ZK audience (what is hidden, visible, limitations)
6. **AC 6:** Operational requirements documented (archive node, block times, channel lifecycle, troubleshooting)
7. **AC 7:** Deployment verification tests pass against mock/static validation (config schema, address format, deploy script args)
8. **AC 8:** Makefile targets documented (mina-build, mina-test, mina-deploy-devnet)

---

## Failing Tests Created (RED Phase)

### Integration Tests (51 tests)

**File:** `packages/connector/test/integration/mina-deployment.test.ts` (~400 lines)

#### T-34.9-01: Deploy script argument parsing (8 tests) -- GREEN

- **Test:** should have deploy-zkapp.ts at tools/mina/deploy-zkapp.ts
  - **Status:** GREEN - Deploy script exists (Story 34.3)
  - **Verifies:** AC 7 - deploy script existence

- **Test:** should require --network argument
  - **Status:** GREEN - Script validates --network
  - **Verifies:** AC 7 - argument validation

- **Test:** should enforce HTTPS on network URL
  - **Status:** GREEN - Script rejects non-HTTPS
  - **Verifies:** AC 7 - HTTPS enforcement

- **Test:** should support --deployer-key as CLI argument
  - **Status:** GREEN - Script accepts --deployer-key
  - **Verifies:** AC 7 - deployer key argument

- **Test:** should fall back to MINA_DEPLOYER_KEY environment variable
  - **Status:** GREEN - Script checks env var
  - **Verifies:** AC 7 - env var fallback

- **Test:** should output zkApp private key to stderr for security
  - **Status:** GREEN - Script uses console.error for keys
  - **Verifies:** AC 7 - security best practice

- **Test:** should compile PaymentChannel circuit before deployment
  - **Status:** GREEN - Script calls PaymentChannel.compile
  - **Verifies:** AC 7 - compilation step

- **Test:** should output verification key hash
  - **Status:** GREEN - Script logs verificationKey.hash
  - **Verifies:** AC 7 - verification key output

#### T-34.9-02: MinaProviderConfig schema validation (7 tests) -- GREEN

- **Test:** should accept a valid Mina devnet configuration
  - **Status:** GREEN - Config type checks pass
  - **Verifies:** AC 7 - valid config acceptance

- **Test:** should accept config with only required fields
  - **Status:** GREEN - Optional fields can be omitted
  - **Verifies:** AC 7 - minimal config

- **Test:** should pass runtime validateChainProviders for valid Mina devnet config
  - **Status:** GREEN - Runtime validation passes
  - **Verifies:** AC 7 - runtime config validation

- **Test:** should reject Mina config missing required graphqlUrl
  - **Status:** GREEN - Missing field rejected
  - **Verifies:** AC 7 - required field enforcement

- **Test:** should reject Mina config missing required zkAppAddress
  - **Status:** GREEN - Missing field rejected
  - **Verifies:** AC 7 - required field enforcement

- **Test:** should reject peer referencing unregistered Mina chain
  - **Status:** GREEN - Unregistered chain rejected
  - **Verifies:** AC 7 - chain reference validation

#### T-34.9-03: zkApp address format validation (4 tests) -- GREEN

- **Test:** should accept a valid B62 address
  - **Status:** GREEN - B62 prefix and length validated
  - **Verifies:** AC 7 - address format

- **Test:** should reject address without B62 prefix
  - **Status:** GREEN - Non-B62 rejected
  - **Verifies:** AC 7 - invalid prefix

- **Test:** should reject address with wrong length
  - **Status:** GREEN - Wrong length rejected
  - **Verifies:** AC 7 - length validation

- **Test:** should reject empty address
  - **Status:** GREEN - Empty string rejected
  - **Verifies:** AC 7 - empty address

#### T-34.9-04: Mina chainId format validation (4 tests) -- GREEN

- **Test:** should accept mina:devnet as valid chainId
  - **Status:** GREEN - Regex match passes
  - **Verifies:** AC 7 - devnet chainId

- **Test:** should accept mina:mainnet as valid chainId
  - **Status:** GREEN - Regex match passes
  - **Verifies:** AC 7 - mainnet chainId

- **Test:** should reject invalid chainId format
  - **Status:** GREEN - Invalid formats rejected
  - **Verifies:** AC 7 - format enforcement

- **Test:** should validate chainId in runtime config context
  - **Status:** GREEN - Runtime validation passes
  - **Verifies:** AC 7 - end-to-end config

#### T-34.9-05: Documentation file exists (3 tests) -- RED

- **Test:** should have documentation file at docs/mina-deployment.md
  - **Status:** RED - File does not exist yet
  - **Verifies:** AC 3 - documentation existence

- **Test:** should have non-empty documentation content
  - **Status:** RED - File does not exist yet
  - **Verifies:** AC 3 - documentation content

- **Test:** should have a top-level heading
  - **Status:** RED - File does not exist yet
  - **Verifies:** AC 3 - documentation structure

#### T-34.9-05b: Documentation sections (21 tests) -- RED

- **Test:** should have a configuration section
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 3

- **Test:** should document GraphQL endpoint configuration
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 3

- **Test:** should document zkApp address configuration
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 3

- **Test:** should include a complete YAML config example with peers section
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 3

- **Test:** should document the chainId format for Mina
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 3

- **Test:** should document the MinaProviderConfig field table
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 3

- **Test:** should document devnet GraphQL endpoint URL
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 3

- **Test:** should have a performance benchmarks section
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 4

- **Test:** should document hardware recommendations
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 4

- **Test:** should document proof generation tuning
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 4

- **Test:** should have a privacy model section
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 5

- **Test:** should document what is hidden on-chain
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 5

- **Test:** should document what is visible on-chain
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 5

- **Test:** should document NIP-59 transport privacy
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 5

- **Test:** should document privacy limitations
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 5

- **Test:** should document archive node requirements
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 6

- **Test:** should document block times and finality
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 6

- **Test:** should document channel lifecycle operations
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 6

- **Test:** should have a troubleshooting section
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 6

- **Test:** should document deployment prerequisites
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 1

- **Test:** should document deployment cost estimates
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 1

- **Test:** should document deployment verification via GraphQL
  - **Status:** RED - docs/mina-deployment.md missing
  - **Verifies:** AC 2

#### T-34.9-06: Makefile targets (4 tests) -- GREEN

- **Test:** should have mina-deploy-devnet target in Makefile
  - **Status:** GREEN - Target exists (Story 34.3)
  - **Verifies:** AC 8

- **Test:** should have mina-build target in Makefile
  - **Status:** GREEN - Target exists (Story 34.3)
  - **Verifies:** AC 8

- **Test:** should have mina-test target in Makefile
  - **Status:** GREEN - Target exists (Story 34.3)
  - **Verifies:** AC 8

- **Test:** should require DEPLOYER_KEY for mina deployment
  - **Status:** GREEN - DEPLOYER_KEY check exists
  - **Verifies:** AC 8

---

## Data Factories Created

N/A -- This story does not require data factories. Tests use static file inspection and TypeScript type validation. No dynamic data generation needed.

---

## Fixtures Created

N/A -- This story uses direct `fs` file reads and TypeScript type assertions. No test fixtures needed beyond `jest.clearAllMocks()` in `beforeEach`.

---

## Mock Requirements

N/A -- No external services are mocked. Tests verify:
- Static file existence and content (fs.existsSync, fs.readFileSync)
- TypeScript type compatibility (compile-time)
- Runtime config validation (validateChainProviders)
- Regex pattern matching on file content

---

## Required data-testid Attributes

N/A -- No UI components in this story. Backend/docs only.

---

## Implementation Checklist

### Test: Documentation file and content tests (26 tests)

**File:** `packages/connector/test/integration/mina-deployment.test.ts`

**Tasks to make these tests pass:**

- [ ] Create `docs/mina-deployment.md` with all required sections (Story Task 1)
- [ ] Prerequisites section: Node.js >= 22.11.0, o1js, funded devnet account, build order
- [ ] Deployment section: make targets, deploy script behavior, security notes
- [ ] Deployment cost estimates: 1 MINA account creation, ~0.01 MINA per tx
- [ ] Verify deployment section: GraphQL query, verification key hash check
- [ ] Configuration section: MinaProviderConfig field table, YAML example with peers
- [ ] Privacy model section: hidden vs visible on-chain, NIP-59 transport, limitations
- [ ] Performance benchmarks: operation timings, hardware recommendations, tuning
- [ ] Operational requirements: archive node, block times, channel lifecycle
- [ ] Troubleshooting section: compilation, transaction, proof, archive node issues
- [ ] Run test: `npx jest packages/connector/test/integration/mina-deployment.test.ts --no-coverage`
- [ ] All 51 tests pass (green phase)

**Estimated Effort:** 3-4 hours

---

### Test: Config validation tests (25 tests -- already passing)

**File:** `packages/connector/test/integration/mina-deployment.test.ts`

**Status:** These tests validate existing infrastructure (deploy script, config types, Makefile targets) and are already GREEN. No implementation needed.

---

## Running Tests

```bash
# Run all failing tests for this story
npx jest packages/connector/test/integration/mina-deployment.test.ts --no-coverage

# Run specific test group
npx jest packages/connector/test/integration/mina-deployment.test.ts -t "T-34.9-05"

# Run with verbose output
npx jest packages/connector/test/integration/mina-deployment.test.ts --verbose --no-coverage

# Run all integration tests
npx jest packages/connector/test/integration/ --no-coverage
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 51 tests written
- 26 tests failing (docs/mina-deployment.md does not exist)
- 25 tests passing (existing infrastructure: deploy script, config types, Makefile)
- Test patterns follow solana-deployment.test.ts structural analog
- jest.clearAllMocks() in every beforeEach
- Given-When-Then comments in all tests

**Verification:**

- 26 tests fail because `docs/mina-deployment.md` does not exist yet
- Failures are clear: `ENOENT: no such file or directory`
- Once documentation is created with correct content, all 26 doc tests will pass

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. Create `docs/mina-deployment.md` following the structure in Story 34.9 tasks 1-2
2. Use `docs/solana-deployment.md` as the structural analog
3. Include all required sections (prerequisites, deployment, configuration, privacy, benchmarks, operations, troubleshooting)
4. Run tests after each section to track progress
5. Update `CLAUDE.md` with Mina make targets (Story Task 4)

**Key Principles:**

- One section at a time -- run tests after each to see progress
- Follow the story task list order (Tasks 1.1 through 1.10, then Task 2)
- Use exact field names and URLs from the story specification

---

### REFACTOR Phase (DEV Team - After All Tests Pass)

1. Review documentation for clarity and completeness
2. Verify all code examples are syntactically correct
3. Cross-reference with existing Mina test files for consistency
4. Run full regression gate: `make test && make lint`

---

## Next Steps

1. **Share this checklist and failing tests** with the dev workflow
2. **Run failing tests** to confirm RED phase: `npx jest packages/connector/test/integration/mina-deployment.test.ts --no-coverage`
3. **Begin implementation** using implementation checklist as guide
4. **Create `docs/mina-deployment.md`** -- this is the primary deliverable that makes 26 tests pass
5. **Update CLAUDE.md** with Mina make targets
6. **When all tests pass**, run regression gate: `make test && make lint`

---

## Knowledge Base References Applied

This ATDD workflow consulted the following knowledge fragments:

- **data-factories.md** - Confirmed N/A for this story (no dynamic test data needed)
- **test-quality.md** - Applied: Given-When-Then format, deterministic tests, explicit assertions
- **test-healing-patterns.md** - Noted: ENOENT failures are expected RED phase, not test bugs
- **test-levels-framework.md** - Applied: integration level selected for static file inspection + config validation
- **test-priorities-matrix.md** - Applied: P0 for config validation (AC 7), P1 for doc sections (AC 3-6,8)

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest packages/connector/test/integration/mina-deployment.test.ts --no-coverage`

**Results:**

```
Test Suites: 1 failed, 1 total
Tests:       26 failed, 25 passed, 51 total
Snapshots:   0 total
Time:        2.376 s
```

**Summary:**

- Total tests: 51
- Passing: 25 (existing infrastructure tests)
- Failing: 26 (documentation tests -- docs/mina-deployment.md missing)
- Status: RED phase verified

**Expected Failure Messages:**
- All 26 failures: `ENOENT: no such file or directory, open '.../docs/mina-deployment.md'`
- This is expected and correct -- the documentation file has not been created yet

---

## Notes

- This story is a docs + tests story -- no source code modifications required
- The test file follows `solana-deployment.test.ts` structure exactly as specified in the story
- AC 1 and AC 2 (actual devnet deployment) are manual E2E tasks not automated in CI
- The test file validates documentation content via regex matching, not semantic analysis
- `validateChainProviders` already supports Mina (added in earlier stories), so config validation tests pass immediately

---

**Generated by BMad TEA Agent** - 2026-03-28
