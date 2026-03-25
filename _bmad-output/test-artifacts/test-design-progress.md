---
stepsCompleted:
  - step-01-detect-mode
  - step-02-load-context
  - step-03-risk-and-testability
  - step-04-coverage-plan
  - step-05-generate-output
  - step-06-architecture-alignment
lastStep: step-06-architecture-alignment
lastSaved: '2026-03-11'
---

# Test Design Progress: Multi-Hop E2E Integration Test

## Step 1: Mode Detection

- **Mode**: Epic-Level
- **Reasoning**: Specific, well-scoped E2E test scenario (not system-wide architecture review)
- **Prerequisites**: All met (architecture context, acceptance criteria, test infrastructure available)

## Step 2: Context Loading

- **Stack type**: Backend (Node.js/TypeScript)
- **Key artifacts loaded**: PacketHandler, SettlementExecutor, SettlementMonitor, PerPacketClaimService, test-utils
- **Knowledge fragments**: risk-governance, probability-impact, test-levels-framework, test-priorities-matrix
- **Critical finding**: All 8+ integration tests deleted in Epic 30.6 — this test fills the gap

## Step 3: Risk Assessment

- **Total risks**: 11
- **Critical (Score 9)**: 2 (BTP race conditions, real EVM test timeout)
- **High (Score 6-8)**: 3 (settlement timing, balance drift, real EVM dependency chain)
- **Medium (Score 3-5)**: 4
- **Low (Score 1-2)**: 2

## Step 4: Coverage Plan

- **P0**: 6 scenarios (core packet flow + settlement lifecycle)
- **P1**: 7 scenarios (fee cascade, real claims, credit limits, state machine, self-describing verification)
- **P2**: 5 scenarios (edge cases, validation, burst testing)
- **P3**: 2 scenarios (concurrency, bi-directional)
- **Total**: 20 test scenarios
- **Estimated effort**: ~39-59 hours (~5-8 dev days)

## Step 5: Output Generation

- **Mode**: Sequential (single output document)
- **Output file**: `_bmad-output/test-artifacts/test-design-epic-multihop-e2e.md`
- **Validation**: Checklist validated, priority headers fixed, execution strategy simplified
- **Status**: Complete

## Step 6: Architecture Alignment (v2 Revision)

- **Trigger**: Architecture states "Integration tests run against real infrastructure — never mocks"
- **Changes applied**:
  - Removed all PaymentChannelSDK mocks — replaced with real Anvil-connected SDK
  - Added Anvil + Faucet Docker infrastructure as prerequisite
  - Added phased startup: fund accounts → start connectors → open channels → readiness gate
  - R-004 revised: mock dependency chain → real EVM dependency chain
  - R-005 elevated to Score 9: real Anvil RPC adds latency, timeout increased to 180s
  - R-010 revised: mock divergence risk eliminated → Anvil state reset risk
  - Added T-020: self-describing claim on-chain verification test
  - Updated config examples with `settlementInfra` and Anvil deterministic addresses
  - Test gated by `EVM_INTEGRATION=true` environment variable
- **Status**: Complete
