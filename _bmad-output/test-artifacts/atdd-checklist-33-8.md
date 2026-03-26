---
stepsCompleted: ['step-01-preflight-and-context', 'step-02-generation-mode', 'step-03-test-strategy', 'step-04-generate-tests', 'step-04c-aggregate', 'step-05-validate-and-complete']
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-03-26'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/33-8-solana-devnet-deployment-documentation.md'
  - '_bmad/tea/testarch/knowledge/data-factories.md'
  - '_bmad/tea/testarch/knowledge/test-quality.md'
  - '_bmad/tea/testarch/knowledge/test-healing-patterns.md'
  - '_bmad/tea/testarch/knowledge/test-levels-framework.md'
  - '_bmad/tea/testarch/knowledge/test-priorities-matrix.md'
  - 'packages/connector/jest.config.js'
  - 'packages/connector/test/integration/solana-config.test.ts'
---

# ATDD Checklist - Epic 33, Story 8: Solana Devnet Deployment & Documentation

**Date:** 2026-03-26
**Author:** Jonathan
**Primary Test Level:** Integration (CI/static verification)

---

## Story Summary

Story 33.8 is the final story in Epic 33 (Solana Payment Channel Provider). It covers deploying the Solana program to devnet, configuring upgrade authority, and creating comprehensive operational documentation (configuration, deposit management, upgrade runbook, monitoring guide).

**As a** connector operator
**I want** the Solana program deployed to devnet with configuration documentation
**So that** I can run the Solana settlement provider in a test environment and onboard new operators with clear operational guides

---

## Acceptance Criteria

1. **AC 1: Devnet Deployment** -- Program deployed to Solana devnet, program ID recorded in project configuration, deployment verifiable via `solana program show`
2. **AC 2: Upgrade Authority Configured** -- Upgrade authority set to designated keypair (not deployer default), authority usable for future upgrades
3. **AC 3: Configuration Documentation** -- Operator can configure SolanaPaymentChannelProvider from docs, config includes RPC endpoint, program ID, token mint, keypair, working example provided
4. **AC 4: Deposit Management Guide** -- Operator can fund a channel vault and verify deposit on-chain using the guide
5. **AC 5: Upgrade Runbook** -- Operator can upgrade program on devnet, upgrade authority correctly managed
6. **AC 6: Monitoring Guide** -- Operator can monitor channel health, detect stuck channels past challenge period

---

## Failing Tests Created (RED Phase)

### Integration Tests (29 tests across 7 describe blocks)

**File:** `packages/connector/test/integration/solana-deployment.test.ts` (394 lines)

- **T-33.8-01** -- Deploy script exists and is executable (3 tests)
  - **Status:** GREEN (regression gate) - deploy.sh exists from Story 33.3
  - **Verifies:** AC 1 -- deployment script is present, executable, and contains required functionality

- **T-33.8-02** -- program-id.json schema validation (2 tests)
  - **Status:** GREEN (regression gate) - schema validation and deploy script content check
  - **Verifies:** AC 1 -- program ID recording schema is correct

- **T-33.8-03** -- Upgrade authority documentation (3 tests)
  - **Status:** RED - docs/solana-deployment.md does not exist yet
  - **Verifies:** AC 2 -- upgrade authority management, transfer process, immutability warnings

- **T-33.8-04** -- SolanaProviderConfig accepts valid devnet config (4 tests)
  - **Status:** MIXED - 2 GREEN (type validation), 2 RED (docs field documentation, YAML example)
  - **Verifies:** AC 3 -- config schema, field documentation, working YAML example

- **T-33.8-06** -- Makefile contains solana-deploy-devnet target (4 tests)
  - **Status:** GREEN (regression gate) - all Makefile targets exist from Story 33.3
  - **Verifies:** AC 1 -- deployment Make targets exist

- **T-33.8-07** -- Documentation file exists (3 tests)
  - **Status:** RED - docs/solana-deployment.md does not exist yet
  - **Verifies:** AC 3 -- documentation file presence, content, headings

- **T-33.8-08** -- Documentation covers all required sections (10 tests)
  - **Status:** RED - docs/solana-deployment.md does not exist yet
  - **Verifies:** AC 3, 4, 5, 6 -- configuration, deposit management, upgrade runbook, monitoring, prerequisites, cost estimates

---

## Data Factories Created

### SolanaDeploymentConfig Factory

**File:** `packages/connector/test/integration/solana-deployment.test.ts` (inline)

**Exports:**
- Inline `SolanaProviderConfig` object literals for devnet testing

**Example Usage:**

```typescript
const config: SolanaProviderConfig = {
  chainType: 'solana',
  rpcUrl: 'https://api.devnet.solana.com',
  wsUrl: 'wss://api.devnet.solana.com',
  programId: 'PayChan1111111111111111111111111111111111111',
  keyId: 'solana-operator-key',
  cluster: 'devnet',
};
```

---

## Fixtures Created

No complex fixtures required for this story. Tests are static/CI verification tests that inspect file existence, content patterns, and config schema validation. No database, network, or program runtime needed.

---

## Mock Requirements

No external service mocking required. All tests are static file inspection and config type validation. T-33.8-05 (devnet smoke test) is manual-only and excluded from CI.

---

## Required data-testid Attributes

Not applicable -- this story has no UI components. All tests are backend integration/static verification.

---

## Implementation Checklist

### Test: T-33.8-07 -- Documentation file exists at docs/solana-deployment.md

**File:** `packages/connector/test/integration/solana-deployment.test.ts`

**Tasks to make this test pass:**

- [ ] Create `docs/solana-deployment.md` with a top-level heading
- [ ] Add sufficient content (>100 characters) covering Solana deployment
- [ ] Run test: `npx jest --testPathPattern="solana-deployment" -t "T-33.8-07" --verbose`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: T-33.8-03 -- Upgrade authority documentation

**File:** `packages/connector/test/integration/solana-deployment.test.ts`

**Tasks to make this test pass:**

- [ ] Add "Upgrade Authority" section to `docs/solana-deployment.md`
- [ ] Document `solana program set-upgrade-authority` or `--upgrade-authority` flag usage
- [ ] Include warning about `--final` flag (irreversible immutability)
- [ ] Run test: `npx jest --testPathPattern="solana-deployment" -t "T-33.8-03" --verbose`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: T-33.8-04 -- SolanaProviderConfig documentation

**File:** `packages/connector/test/integration/solana-deployment.test.ts`

**Tasks to make this test pass:**

- [ ] Add configuration section to `docs/solana-deployment.md` documenting all SolanaProviderConfig fields (rpcUrl, wsUrl, programId, keyId, cluster)
- [ ] Add working YAML config example with `chainProviders` and `chainType: solana`
- [ ] Run test: `npx jest --testPathPattern="solana-deployment" -t "T-33.8-04" --verbose`
- [ ] Test passes (green phase)

**Estimated Effort:** 0.5 hours

---

### Test: T-33.8-08 -- Documentation covers all required sections

**File:** `packages/connector/test/integration/solana-deployment.test.ts`

**Tasks to make this test pass:**

- [ ] Add configuration section (RPC endpoint, program ID)
- [ ] Add deposit management section (funding channels, verifying deposits, vault)
- [ ] Add upgrade runbook section (cargo build-sbf, solana program deploy)
- [ ] Add monitoring section (channel health, stuck channel detection, challenge period)
- [ ] Add prerequisites section (Solana CLI, keypair, airdrop)
- [ ] Add cost estimates section (rent, SOL costs)
- [ ] Run test: `npx jest --testPathPattern="solana-deployment" -t "T-33.8-08" --verbose`
- [ ] Test passes (green phase)

**Estimated Effort:** 2 hours

---

### Regression Gate

**Tasks:**

- [ ] `npm test` in `packages/connector` -- all 2134+ existing tests pass
- [ ] `npx tsc --noEmit` -- TypeScript compiles with no errors
- [ ] Existing EVM and Solana integration tests pass unchanged
- [ ] Run: `npx jest --testPathPattern="solana-deployment" --verbose` -- all 29 tests pass

**Estimated Effort:** 0.5 hours

---

**Total Estimated Effort:** 4 hours

---

## Running Tests

```bash
# Run all failing tests for this story
npx jest --testPathPattern="solana-deployment" --verbose

# Run specific test file
npx jest packages/connector/test/integration/solana-deployment.test.ts --verbose

# Run tests with coverage
npx jest --testPathPattern="solana-deployment" --coverage

# Run all connector tests (regression gate)
npm test --workspace=packages/connector
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

**TEA Agent Responsibilities:**

- All 29 tests written (11 passing regression gates + 18 failing)
- Config type validation tests created
- Static file inspection tests created
- Documentation content verification tests created
- Implementation checklist created

**Verification:**

- 29 tests total: 11 passing (regression gates for existing artifacts), 18 failing (RED)
- All failures are due to missing `docs/solana-deployment.md` -- not test bugs
- Failure messages are clear and actionable (ENOENT or expect(false).toBe(true))

---

### GREEN Phase (DEV Team - Next Steps)

**DEV Agent Responsibilities:**

1. **Create `docs/solana-deployment.md`** -- this single file will make all 18 failing tests pass
2. **Include all required sections:** configuration, deposit management, upgrade runbook, monitoring, prerequisites, cost estimates
3. **Run tests after each section** to verify incremental progress
4. **All 29 tests should pass** when documentation is complete

**Key Principles:**

- One section at a time (start with basic file creation, then add sections)
- Run tests frequently (immediate feedback)
- Use implementation checklist as roadmap

---

### REFACTOR Phase (DEV Team - After All Tests Pass)

**DEV Agent Responsibilities:**

1. **Verify all 29 tests pass** (green phase complete)
2. **Review documentation for quality** (readability, completeness, accuracy)
3. **Ensure tests still pass** after each refactor
4. **Execute devnet deployment** (Task 1 from story) and update docs with actual program ID

---

## Next Steps

1. **Share this checklist and failing tests** with the dev workflow (manual handoff)
2. **Review this checklist** with team in standup or planning
3. **Run failing tests** to confirm RED phase: `npx jest --testPathPattern="solana-deployment" --verbose`
4. **Begin implementation** using implementation checklist as guide
5. **Work one test at a time** (red -> green for each)
6. **When all tests pass**, refactor documentation for quality
7. **When refactoring complete**, manually update story status to 'done' in sprint-status.yaml

---

## Knowledge Base References Applied

- **data-factories.md** - Factory patterns for test config objects with overrides
- **test-quality.md** - Test design principles (determinism, isolation, explicit assertions)
- **test-healing-patterns.md** - Common failure patterns and diagnostic signatures
- **test-levels-framework.md** - Test level selection (integration for service contracts, static for file verification)
- **test-priorities-matrix.md** - P0/P1 priority assignment for deployment verification tests

See `tea-index.csv` for complete knowledge fragment mapping.

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest --testPathPattern="solana-deployment" --verbose`

**Results:**

```
FAIL packages/connector/test/integration/solana-deployment.test.ts
  [T-33.8-01] Deploy script exists and is executable (Story 33.8)
    PASS should have deploy.sh at tools/solana/deploy.sh
    PASS should have deploy.sh marked as executable
    PASS should contain required deployment functionality
  [T-33.8-02] program-id.json schema validation (Story 33.8)
    PASS should validate a well-formed program-id.json structure
    PASS should verify deploy script writes program-id.json on deployment
  [T-33.8-03] Upgrade authority documentation covers authority transfer (Story 33.8)
    FAIL should have documentation covering upgrade authority management
    FAIL should document authority transfer process
    FAIL should warn about making program immutable
  [T-33.8-04] SolanaProviderConfig accepts valid devnet config (Story 33.8)
    PASS should accept a valid devnet configuration
    PASS should accept config without optional fields
    FAIL should have documentation explaining all config fields
    FAIL should have documentation with a working YAML config example
  [T-33.8-06] Makefile contains solana-deploy-devnet target (Story 33.8)
    PASS should have solana-deploy-devnet target in Makefile
    PASS should have solana-build target in Makefile
    PASS should have solana-test target in Makefile
    PASS should require DEPLOYER_KEYPAIR for deployment
  [T-33.8-07] Documentation file exists at docs/solana-deployment.md (Story 33.8)
    FAIL should have documentation file at docs/solana-deployment.md
    FAIL should have non-empty documentation content
    FAIL should have a top-level heading
  [T-33.8-08] Documentation covers all required sections (Story 33.8)
    FAIL should have a configuration section
    FAIL should document RPC endpoint configuration
    FAIL should document program ID configuration
    FAIL should have a deposit management section
    FAIL should have an upgrade runbook section
    FAIL should document the upgrade process steps
    FAIL should have a monitoring section
    FAIL should document stuck channel detection
    FAIL should document deployment prerequisites
    FAIL should document deployment cost estimates

Test Suites: 1 failed, 1 total
Tests:       18 failed, 11 passed, 29 total
```

**Summary:**

- Total tests: 29
- Passing: 11 (regression gates for existing artifacts)
- Failing: 18 (RED -- docs/solana-deployment.md does not exist yet)
- Status: RED phase verified

**Expected Failure Messages:**
- T-33.8-03, T-33.8-07, T-33.8-08: `ENOENT: no such file or directory, open '.../docs/solana-deployment.md'`
- T-33.8-04 (docs tests): `expect(received).toBe(expected) // Expected: true, Received: false`

---

## Notes

- T-33.8-05 (devnet full lifecycle smoke test) is manual-only, NOT automated in CI due to devnet airdrop rate limits (~5 SOL/hr)
- The deploy script `tools/solana/deploy.sh` already exists from Story 33.3 -- tests verify its existence, not its creation
- Documentation file `docs/solana-deployment.md` is the primary deliverable that will make all 18 failing tests pass
- No Zod schema exists for SolanaProviderConfig -- tests use TypeScript interface validation only
- 11 tests pass as regression gates (deploy script, Makefile, config type) confirming Story 33.3 artifacts intact

---

## Contact

**Questions or Issues?**

- Ask in team standup
- Refer to `_bmad/tea/testarch/knowledge/` for testing best practices

---

**Generated by BMad TEA Agent** - 2026-03-26
