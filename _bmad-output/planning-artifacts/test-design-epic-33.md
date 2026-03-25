---
stepsCompleted:
  - risk-assessment
  - strategy-per-story
  - cross-story-integration
  - regression-analysis
  - test-data-requirements
lastSaved: '2026-03-25'
revision: v1
epicRef: epic-33-solana-payment-channel-provider.md
inputDocuments:
  - _bmad-output/planning-artifacts/epic-33-solana-payment-channel-provider.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/project-context.md
  - _bmad-output/planning-artifacts/test-design-epic-32.md
  - _bmad-output/test-artifacts/test-design-epic-multihop-e2e.md
---

# Test Design: Epic 33 — Solana Payment Channel Provider

**Date:** 2026-03-25
**Author:** Jonathan (generated with Claude)
**Status:** Draft v1

---

## Executive Summary

**Scope:** Risk-based test plan for Epic 33, covering 8 stories (33.1--33.8) that deliver a complete Solana payment channel system: an on-chain Rust program, TypeScript SDK, `SolanaPaymentChannelProvider` implementing the Epic 32 `PaymentChannelProvider` interface, Solana claim message types, integration tests, and devnet deployment.

**Epic Type:** Greenfield. Unlike Epic 32 (brownfield refactor), this is net-new code building on top of the chain-abstraction layer. The dominant constraints are: (1) no existing Solana payment channel reference to follow, (2) cross-language boundary between Rust on-chain and TypeScript off-chain, and (3) EVM regression must remain zero.

**Architecture Constraint:** On-chain program tests use `solana-program-test` BanksClient (Rust) and `solana-bankrun` (TypeScript, in-process). E2E tests requiring real RPC and account subscriptions use Docker-based `solana-test-validator` (`make solana-up`). EVM regression tests continue using Anvil.

**Risk Summary:**

- Total risks identified: 14
- Critical (score >= 8): 4
- High (score 5--7): 5
- Medium (score 3--4): 4
- Low (score 1--2): 1

**Coverage Summary:**

- Rust on-chain test scenarios: 28
- TypeScript unit test scenarios: 34
- Integration/E2E test scenarios: 16
- Regression scenarios: 6
- Estimated effort: 14--20 dev days

---

## 1. Key Risks and Mitigating Tests

### Risk Matrix

| ID   | Risk                                                                  | Likelihood | Impact   | Score | Category    | Mitigating Tests                   |
| ---- | --------------------------------------------------------------------- | ---------- | -------- | ----- | ----------- | ---------------------------------- |
| R-01 | Ed25519 precompile introspection fails silently or is mis-implemented | Medium     | Critical | 9     | CRYPTO      | T-33.2-01 through T-33.2-07       |
| R-02 | Greenfield program has undiscovered balance conservation bugs         | Medium     | Critical | 9     | LOGIC       | T-33.3-01, T-33.3-02, T-33.3-06   |
| R-03 | EVM settlement regression from claim type changes                    | Medium     | Critical | 8     | REGRESSION  | T-REG-01 through T-REG-06         |
| R-04 | Cross-language mismatch: TS SDK serialization != Rust deserialization | Medium     | Critical | 8     | INTEGRATION | T-33.4-03, T-33.4-04, T-33.7-01   |
| R-05 | PDA derivation inconsistency between Rust and TypeScript             | Medium     | High     | 7     | LOGIC       | T-33.1-07, T-33.4-06              |
| R-06 | Account subscription drops or lags under load                        | Medium     | Medium   | 6     | RELIABILITY | T-33.5-04, T-33.7-05              |
| R-07 | Solana claim routed to EVM provider (or vice versa)                  | Low        | High     | 6     | ROUTING     | T-33.6-03, T-33.6-04, T-33.7-04   |
| R-08 | SPL Token transfer fails due to account ownership or ATA issues      | Medium     | Medium   | 6     | INTEGRATION | T-33.1-02, T-33.4-02              |
| R-09 | Nonce monotonicity bypass allows claim replay                        | Low        | Critical | 5     | SECURITY    | T-33.2-02, T-33.2-03, T-33.3-04   |
| R-10 | Challenge period timing exploits in settle/force-close               | Low        | High     | 5     | SECURITY    | T-33.1-05, T-33.1-06, T-33.3-05   |
| R-11 | Compute unit budget exceeded for complex instructions                | Low        | Medium   | 4     | PERF        | T-33.3-07                          |
| R-12 | Solana RPC reconnection fails, leaving provider in broken state      | Medium     | Medium   | 4     | RELIABILITY | T-33.5-05                          |
| R-13 | Program upgrade authority misconfigured, locking out future upgrades  | Low        | Medium   | 3     | OPS         | T-33.8-03                          |
| R-14 | Rent economics miscalculated, accounts not rent-exempt               | Low        | Low      | 2     | OPS         | T-33.3-08                          |

### Risk Detail: Top 4

**R-01: Ed25519 Precompile Introspection** (Score 9)
The `claim_from_channel` instruction verifies Ed25519 signatures by introspecting the `Instructions` sysvar for the Ed25519 program instruction at an expected index. This is a non-trivial pattern with subtle failure modes: wrong instruction index, malformed precompile data, or missing the Ed25519 program instruction entirely. If this fails, no claims can be submitted. Mitigation: Dedicated test suite (Story 33.2) with valid signatures, invalid signatures, missing precompile instruction, and wrong signer scenarios.

**R-02: Balance Conservation Bugs** (Score 9)
As greenfield code with no reference implementation, the on-chain program must correctly conserve funds through every lifecycle path (open, deposit, claim, close, settle, force-close). A bug here means loss of funds. Mitigation: Story 33.3 includes explicit balance conservation tests verifying `vault_balance == deposit_a + deposit_b - settled_amount` at every state transition, plus overflow checks.

**R-03: EVM Regression from Claim Type Changes** (Score 8)
Story 33.6 adds `'solana'` to the `BlockchainType` union and introduces `SolanaClaimMessage`. If the discriminated union is modified incorrectly, existing EVM claim parsing, validation, or routing could break. Mitigation: Explicit backward-compatibility tests ensuring all existing EVM claim paths work unchanged, plus regression gate on existing claim-receiver and claim-sender test files.

**R-04: Cross-Language Serialization Mismatch** (Score 8)
The balance proof message format (`channel_pda || nonce || transferred_amount`) must be serialized identically in TypeScript (for signing) and Rust (for verification). Little-endian byte ordering, field sizes, and concatenation must match exactly. A mismatch means valid off-chain signatures are rejected on-chain. Mitigation: Cross-language serialization tests in Story 33.4 and end-to-end lifecycle test in Story 33.7.

---

## 2. Test Strategy Per Story

### Story 33.1: Solana Payment Channel Program — Channel Lifecycle

**Test Level:** Rust unit/integration (solana-program-test BanksClient)
**Risk Focus:** R-02 (balance conservation), R-05 (PDA derivation), R-08 (SPL token), R-10 (challenge period)

| ID        | Scenario                                                                                               | Type            | Priority |
| --------- | ------------------------------------------------------------------------------------------------------ | --------------- | -------- |
| T-33.1-01 | `initialize_channel` creates PDA with correct participants, token mint, state = Opened, zero balances  | Rust unit       | P0       |
| T-33.1-02 | `deposit` transfers SPL tokens from participant to vault PDA and increments deposit tracker            | Rust unit       | P0       |
| T-33.1-03 | `deposit` by participant B increments `deposit_b` (not `deposit_a`)                                   | Rust unit       | P0       |
| T-33.1-04 | `close_channel` sets state to `Closed` and records `close_timestamp` from Clock sysvar                | Rust unit       | P0       |
| T-33.1-05 | `settle_channel` distributes funds correctly after challenge period and closes accounts                | Rust unit       | P0       |
| T-33.1-06 | `settle_channel` fails with `ChannelChallengeNotExpired` when called before challenge deadline         | Rust unit       | P0       |
| T-33.1-07 | PDA derivation produces same address regardless of participant argument order (lexicographic sorting)  | Rust unit       | P0       |
| T-33.1-08 | `force_close_expired` distributes funds after challenge deadline                                       | Rust unit       | P1       |
| T-33.1-09 | `initialize_channel` fails on double-init (PDA already exists)                                        | Rust unit       | P1       |
| T-33.1-10 | `deposit` to a closed channel fails                                                                    | Rust unit       | P1       |
| T-33.1-11 | `deposit` with zero amount fails or is no-op                                                           | Rust unit       | P1       |
| T-33.1-12 | `close_channel` can only be called by a channel participant                                            | Rust unit       | P1       |
| T-33.1-13 | `settle_channel` reclaims rent from closed accounts                                                    | Rust unit       | P2       |

**Approach:** All tests use `solana-program-test` BanksClient (in-process, no Docker). Create helper functions to build test transactions. Use `ProgramTestContext` to manipulate Clock sysvar for challenge period tests (warp time forward).

**Test File:** `packages/solana-program/tests/lifecycle.rs`

---

### Story 33.2: Solana Payment Channel Program — Claim Verification

**Test Level:** Rust unit/integration (solana-program-test BanksClient)
**Risk Focus:** R-01 (Ed25519 precompile), R-09 (nonce replay)

| ID        | Scenario                                                                                                              | Type      | Priority |
| --------- | --------------------------------------------------------------------------------------------------------------------- | --------- | -------- |
| T-33.2-01 | Valid `claim_from_channel` with correct Ed25519 signature updates nonce and transferred_amount                         | Rust unit | P0       |
| T-33.2-02 | Claim with replayed nonce (nonce == stored nonce) fails with `NonceNotMonotonic`                                      | Rust unit | P0       |
| T-33.2-03 | Claim with stale nonce (nonce < stored nonce) fails with `NonceNotMonotonic`                                          | Rust unit | P0       |
| T-33.2-04 | Claim with invalid Ed25519 signature fails with `InvalidSignature`                                                    | Rust unit | P0       |
| T-33.2-05 | Claim signed by non-participant keypair fails with `UnauthorizedSigner`                                               | Rust unit | P0       |
| T-33.2-06 | Claim with decreased transferred_amount fails with `TransferredAmountDecreased`                                       | Rust unit | P0       |
| T-33.2-07 | Claim on closed channel succeeds (challenge period allows balance updates)                                            | Rust unit | P0       |
| T-33.2-08 | Ed25519 precompile instruction missing from transaction fails gracefully                                              | Rust unit | P1       |
| T-33.2-09 | Ed25519 precompile instruction at wrong index fails gracefully                                                        | Rust unit | P1       |
| T-33.2-10 | Multiple sequential claims with increasing nonces all succeed                                                         | Rust unit | P1       |
| T-33.2-11 | Claim on settled channel fails (state = Settled)                                                                      | Rust unit | P1       |
| T-33.2-12 | Balance proof message format is exactly `channel_pda (32) || nonce (8 LE) || transferred_amount (8 LE)` (48 bytes)    | Rust unit | P0       |

**Approach:** Each test constructs a transaction with the Ed25519 precompile instruction prepended, followed by the `claim_from_channel` instruction. The precompile instruction carries the public key, message, and signature. BanksClient simulates the full transaction including precompile verification.

**Test File:** `packages/solana-program/tests/claims.rs`

---

### Story 33.3: Solana Payment Channel Program — Tests & Deployment

**Test Level:** Rust integration (solana-program-test), security, deployment verification
**Risk Focus:** R-02 (balance conservation), R-09 (nonce replay), R-10 (challenge timing), R-11 (CU budget), R-14 (rent)

| ID        | Scenario                                                                                                                    | Type               | Priority |
| --------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------- |
| T-33.3-01 | Full lifecycle: open -> deposit -> claim -> close -> settle, final balances match cumulative transferred amounts             | Rust integration   | P0       |
| T-33.3-02 | Balance conservation: `vault_balance == deposit_a + deposit_b` holds at every state transition until settle                 | Rust integration   | P0       |
| T-33.3-03 | Balance conservation after settle: `token_balance_a + token_balance_b == initial_deposit_a + initial_deposit_b`             | Rust integration   | P0       |
| T-33.3-04 | Security: nonce replay attack across multiple claims is rejected                                                            | Rust security      | P0       |
| T-33.3-05 | Security: settle before challenge timeout is rejected, settle after timeout succeeds                                        | Rust security      | P0       |
| T-33.3-06 | Security: PDA derivation with swapped participants produces same address                                                    | Rust security      | P0       |
| T-33.3-07 | CU profile: `claim_from_channel` with Ed25519 verification stays under 50K CU                                              | Rust performance   | P1       |
| T-33.3-08 | Rent economics: channel PDA and vault accounts are rent-exempt after initialization                                         | Rust unit          | P1       |
| T-33.3-09 | Overflow: deposit amounts near u64::MAX do not cause overflow in balance tracking                                           | Rust security      | P1       |
| T-33.3-10 | Deployment script deploys program to devnet successfully (manual/CI gate)                                                   | Deployment         | P1       |
| T-33.3-11 | Upgrade authority is set to designated keypair, not deployer default                                                         | Deployment         | P1       |

**Approach:** Integration tests run `cargo test-sbf`. Security tests are the same framework but organized by attack vector. CU profiling uses `compute_units_consumed` from transaction simulation. Deployment tests are CI-gated manual verification steps.

**Test Files:**
- `packages/solana-program/tests/lifecycle.rs` (T-33.3-01 through T-33.3-03, combined lifecycle)
- `packages/solana-program/tests/security.rs` (T-33.3-04 through T-33.3-06, T-33.3-09)
- `packages/solana-program/tests/performance.rs` (T-33.3-07, T-33.3-08)

---

### Story 33.4: SolanaPaymentChannelSDK — TypeScript Integration

**Test Level:** TypeScript unit + integration (solana-bankrun for fast in-process tests)
**Risk Focus:** R-04 (cross-language serialization), R-05 (PDA derivation), R-08 (SPL token)

| ID        | Scenario                                                                                                          | Type             | Priority |
| --------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- | -------- |
| T-33.4-01 | `openChannel()` builds and submits `initialize_channel` transaction, channel PDA created on-chain                 | Integration (BR) | P0       |
| T-33.4-02 | `deposit()` transfers SPL tokens to vault, transaction confirmed                                                  | Integration (BR) | P0       |
| T-33.4-03 | `signBalanceProof()` produces Ed25519 signature over canonical message format                                     | Unit             | P0       |
| T-33.4-04 | Signature from `signBalanceProof()` is accepted by on-chain `claim_from_channel`                                  | Integration (BR) | P0       |
| T-33.4-05 | `claimFromChannel()` builds transaction with Ed25519 precompile + claim instruction, succeeds on-chain            | Integration (BR) | P0       |
| T-33.4-06 | `deriveChannelPDA()` produces same address as Rust-side derivation for identical inputs                           | Unit             | P0       |
| T-33.4-07 | `deriveChannelPDA()` produces same address regardless of argument order                                           | Unit             | P0       |
| T-33.4-08 | `getChannelState()` deserializes channel account data correctly                                                   | Integration (BR) | P0       |
| T-33.4-09 | `closeChannel()` and `settleChannel()` delegate correctly                                                         | Integration (BR) | P1       |
| T-33.4-10 | `subscribeToChannel()` fires callback on account change                                                           | Integration (TV) | P1       |
| T-33.4-11 | Balance proof message bytes match expected format: `channel_pda(32) || nonce(8 LE) || transferred_amount(8 LE)`   | Unit             | P0       |

**(BR) = solana-bankrun (in-process, fast), (TV) = solana-test-validator (Docker, real RPC/subscriptions)**

**Approach:** Most tests use `solana-bankrun` for speed. The `subscribeToChannel` test requires a real WebSocket connection and therefore uses the Docker-based validator. PDA derivation tests compare TypeScript output against known Rust-derived values (golden test).

**Test File:** `packages/connector/src/settlement/solana-payment-channel-sdk.test.ts`

---

### Story 33.5: Implement SolanaPaymentChannelProvider

**Test Level:** TypeScript unit (mocked SDK) + integration
**Risk Focus:** R-06 (subscription reliability), R-07 (claim routing), R-12 (RPC reconnection)

| ID        | Scenario                                                                                                     | Type        | Priority |
| --------- | ------------------------------------------------------------------------------------------------------------ | ----------- | -------- |
| T-33.5-01 | `SolanaPaymentChannelProvider` implements `PaymentChannelProvider` interface (TypeScript compiles)            | Type check  | P0       |
| T-33.5-02 | `chainType` returns `'solana'`, `chainId` returns configured chain ID string (e.g., `'solana:devnet'`)       | Unit        | P0       |
| T-33.5-03 | `openChannel()` delegates to `SolanaPaymentChannelSDK.openChannel()`, returns provider-canonical format      | Unit        | P0       |
| T-33.5-04 | `subscribeToEvents()` wraps `onAccountChange`, emits provider-compatible state-change events                 | Unit        | P0       |
| T-33.5-05 | `subscribeToEvents()` unsubscribe cleans up underlying SDK subscription                                      | Unit        | P1       |
| T-33.5-06 | `signBalanceProof()` delegates to SDK and returns provider-standard signature format                         | Unit        | P0       |
| T-33.5-07 | `verifyBalanceProof()` delegates to SDK Ed25519 verification                                                 | Unit        | P0       |
| T-33.5-08 | `getChannelState()` translates Solana channel state to `ProviderChannelState`                                | Unit        | P1       |
| T-33.5-09 | Solana program error (`NonceNotMonotonic`) is mapped to provider-level error type                            | Unit        | P0       |
| T-33.5-10 | `claimFromChannel()`, `closeChannel()`, `settleChannel()`, `deposit()` delegate correctly                    | Unit        | P1       |
| T-33.5-11 | Provider registered in `ChainProviderRegistry` and retrievable by `chainId`                                  | Unit        | P0       |
| T-33.5-12 | `getProviderForPeer(peerConfig)` resolves `SolanaPaymentChannelProvider` for Solana-configured peer          | Unit        | P0       |

**Approach:** Unit tests mock `SolanaPaymentChannelSDK` and verify delegation. The provider is tested in isolation; integration with the registry and other services is covered in Story 33.7.

**Test File:** `packages/connector/src/settlement/solana-payment-channel-provider.test.ts`

---

### Story 33.6: Solana Claim Message Types & Serialization

**Test Level:** TypeScript unit
**Risk Focus:** R-03 (EVM regression), R-07 (claim routing)

| ID        | Scenario                                                                                                         | Type       | Priority |
| --------- | ---------------------------------------------------------------------------------------------------------------- | ---------- | -------- |
| T-33.6-01 | `BlockchainType` union includes `'solana'` alongside existing `'evm'`                                            | Type check | P0       |
| T-33.6-02 | `SolanaClaimMessage` extends `BaseClaimMessage` with all required fields (programId, tokenMint, channelPDA, etc) | Type check | P0       |
| T-33.6-03 | `isSolanaClaim()` type guard narrows `BTPClaimMessage` to `SolanaClaimMessage`                                   | Unit       | P0       |
| T-33.6-04 | `isEVMClaim()` continues to narrow correctly after `'solana'` addition (EVM backward compat)                     | Unit       | P0       |
| T-33.6-05 | `SolanaClaimMessage` serialized to BTP protocolData JSON includes `blockchain: 'solana'` discriminator           | Unit       | P0       |
| T-33.6-06 | BTP protocolData with `blockchain: 'solana'` deserialized into `SolanaClaimMessage`                              | Unit       | P0       |
| T-33.6-07 | BTP protocolData with `blockchain: 'evm'` continues to deserialize as `EVMClaimMessage` (no change)              | Unit       | P0       |
| T-33.6-08 | `ClaimReceiver` routes Solana claims to Solana provider verification path                                        | Unit       | P0       |
| T-33.6-09 | `ClaimReceiver` routes EVM claims unchanged (backward compat)                                                    | Unit       | P0       |
| T-33.6-10 | `ClaimSender` constructs `SolanaClaimMessage` with self-describing fields from provider context                  | Unit       | P1       |
| T-33.6-11 | `validateClaimMessage()` accepts valid `SolanaClaimMessage`                                                      | Unit       | P0       |
| T-33.6-12 | `validateClaimMessage()` rejects `SolanaClaimMessage` with missing required fields                               | Unit       | P1       |
| T-33.6-13 | Claim with tampered `programId` fails PDA re-derivation check                                                    | Unit       | P1       |

**Approach:** Type-check tests verify compilation. Runtime tests verify serialization round-trip and discriminated union dispatch. Backward-compatibility tests ensure no EVM path regressions. Mock providers used for ClaimReceiver/ClaimSender tests.

**Test Files:**
- `packages/connector/src/btp/btp-claim-types.test.ts` (T-33.6-01 through T-33.6-07, T-33.6-11, T-33.6-12)
- Modify existing `packages/connector/src/settlement/claim-receiver.test.ts` (T-33.6-08, T-33.6-09, T-33.6-13)
- Modify existing `packages/connector/src/settlement/claim-sender.test.ts` (T-33.6-10)

---

### Story 33.7: Integration Tests — Solana Provider E2E

**Test Level:** Integration/E2E (solana-bankrun + solana-test-validator + Anvil for mixed-chain)
**Risk Focus:** R-01 (precompile), R-02 (balance conservation), R-03 (EVM regression), R-04 (cross-language), R-06 (subscriptions), R-07 (claim routing)

| ID        | Scenario                                                                                                                   | Type             | Priority |
| --------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------- |
| T-33.7-01 | Full lifecycle: open -> deposit -> per-packet claim -> verify claim -> threshold settlement -> close -> settle -> rent reclaim | Integration (BR) | P0       |
| T-33.7-02 | Multi-peer Solana: three peers settling on Solana, each generating per-packet claims with correct nonces                   | Integration (BR) | P0       |
| T-33.7-03 | Claim accumulation: 10+ claims with increasing nonces, cumulative transferred amounts tracked correctly                    | Integration (BR) | P0       |
| T-33.7-04 | Mixed-chain: Peer A on EVM, Peer B on Solana, ILP packets forwarded — correct claims generated for each                   | Integration      | P0       |
| T-33.7-05 | Account subscription: `onAccountChange` fires when claim lands on-chain, `SettlementMonitor` receives event                | Integration (TV) | P1       |
| T-33.7-06 | Error: invalid Ed25519 signature rejected with provider-level `InvalidSignature` error                                     | Integration (BR) | P0       |
| T-33.7-07 | Error: stale nonce rejected with provider-level error, valid re-attempt succeeds                                           | Integration (BR) | P1       |
| T-33.7-08 | Error: wrong program ID in claim detected and rejected                                                                     | Integration (BR) | P1       |
| T-33.7-09 | Config-driven: Solana provider created from YAML config via `ChainProviderRegistry.fromConfig()`                           | Integration      | P1       |
| T-33.7-10 | Graceful shutdown: provider unsubscribes all account watchers, registry deregisters provider                               | Integration      | P1       |
| T-33.7-11 | No direct `SolanaPaymentChannelSDK` imports in core settlement services (import audit)                                     | Static           | P0       |
| T-33.7-12 | EVM settlement continues to work identically alongside active Solana provider (regression)                                 | Integration      | P0       |

**(BR) = solana-bankrun, (TV) = solana-test-validator (Docker)**

**Approach:** Most scenarios use `solana-bankrun` for speed. The mixed-chain test (T-33.7-04) requires both Anvil (EVM) and solana-bankrun (Solana) running. The account subscription test (T-33.7-05) requires the Docker-based `solana-test-validator` for real WebSocket behavior. T-33.7-11 is a static analysis check (grep for direct SDK imports in settlement service files).

**Test Files:**
- `packages/connector/test/integration/solana-provider.test.ts` (T-33.7-01 through T-33.7-03, T-33.7-06 through T-33.7-08)
- `packages/connector/test/integration/mixed-chain.test.ts` (T-33.7-04, T-33.7-12)
- `packages/connector/test/integration/solana-subscription.test.ts` (T-33.7-05, T-33.7-10)
- `packages/connector/test/integration/solana-config.test.ts` (T-33.7-09, T-33.7-11)

---

### Story 33.8: Solana Devnet Deployment & Documentation

**Test Level:** Manual/CI verification
**Risk Focus:** R-13 (upgrade authority), R-14 (rent)

| ID        | Scenario                                                                                         | Type              | Priority |
| --------- | ------------------------------------------------------------------------------------------------ | ----------------- | -------- |
| T-33.8-01 | Deployment script deploys program to Solana devnet successfully                                  | CI/manual         | P0       |
| T-33.8-02 | Program ID recorded in project config matches deployed program                                   | CI/manual         | P0       |
| T-33.8-03 | Upgrade authority set to designated keypair (not deployer default)                                | CI/manual         | P0       |
| T-33.8-04 | Connector YAML config with Solana provider settings loads and validates                          | Unit              | P1       |
| T-33.8-05 | Devnet full lifecycle smoke test: open -> deposit -> claim -> close -> settle                     | Manual E2E        | P1       |

**Approach:** Deployment verification is a CI gate or manual checklist step. The smoke test (T-33.8-05) runs against real devnet — it is not automated in CI due to devnet rate limits.

**Test File:** No dedicated test file. T-33.8-04 covered by config validation tests. T-33.8-01 through T-33.8-03 are deployment script outputs.

---

## 3. Cross-Story Integration Points

### 3.1 Rust Program to TypeScript SDK (33.1/33.2 + 33.4)

**Seam:** The on-chain program (Rust) and the TypeScript SDK must agree on: balance proof message format, PDA derivation seeds, account data layout, and instruction encoding.

**Risk:** Cross-language serialization mismatch (R-04). A single byte ordering difference in the balance proof message means all signatures fail.

**Tests:** T-33.4-04 (signature accepted on-chain), T-33.4-06 (PDA match), T-33.4-11 (message format).

### 3.2 TypeScript SDK to Provider Adapter (33.4 + 33.5)

**Seam:** `SolanaPaymentChannelProvider` wraps `SolanaPaymentChannelSDK` methods and translates between provider-level abstractions and Solana-specific calls.

**Risk:** Incorrect delegation or result translation. Provider returns generic `ChannelMetadata` but SDK returns Solana-specific types.

**Tests:** T-33.5-03 through T-33.5-10 (delegation tests).

### 3.3 Provider to Registry to Settlement Services (33.5 + Epic 32 registry)

**Seam:** `SolanaPaymentChannelProvider` registered in `ChainProviderRegistry`, looked up by `PerPacketClaimService`, `SettlementExecutor`, and `ClaimReceiver` for Solana-configured peers.

**Risk:** Registry lookup key mismatch (e.g., `'solana:devnet'` vs `'solana:mainnet-beta'`).

**Tests:** T-33.5-11, T-33.5-12, T-33.7-09.

### 3.4 Claim Types to BTP Wire Format (33.6 + BTP layer)

**Seam:** `SolanaClaimMessage` serialized into BTP protocolData JSON, transmitted over WebSocket, deserialized by receiver, routed to Solana provider.

**Risk:** Missing discriminator, incorrect field names, or deserialization failure (R-07).

**Tests:** T-33.6-05 through T-33.6-09.

### 3.5 Solana Provider + EVM Provider Coexistence (33.5 + 33.6 + Epic 32)

**Seam:** Both providers registered simultaneously. Per-peer `chain` field selects the correct provider. Claims must not cross-contaminate.

**Risk:** Solana claim routed to EVM provider or vice versa (R-07).

**Tests:** T-33.7-04 (mixed-chain), T-33.7-12 (EVM regression).

### 3.6 Account Subscription to Settlement Monitor (33.5 + SettlementMonitor)

**Seam:** `SolanaPaymentChannelProvider.subscribeToEvents()` uses `onAccountChange` to detect on-chain state changes. These events must be translated to `ProviderEvent` objects that `SettlementMonitor` can consume.

**Risk:** Event format mismatch or dropped subscriptions (R-06).

**Tests:** T-33.5-04, T-33.7-05.

---

## 4. Regression Risks

All existing EVM settlement must keep working identically. The Solana provider is additive, but claim type changes (Story 33.6) touch shared code paths.

### Regression Test Suite

| ID       | Scenario                                                                        | Pre-Condition                              | Assertion              | Story Gate |
| -------- | ------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------- | ---------- |
| T-REG-01 | `claim-receiver.test.ts` passes with Solana claim types added                   | Existing tests plus new Solana tests       | All existing tests green | 33.6       |
| T-REG-02 | `claim-sender.test.ts` passes with Solana claim construction added              | Existing tests plus new Solana tests       | All existing tests green | 33.6       |
| T-REG-03 | `btp-claim-types.test.ts` EVM paths unchanged                                  | `isEVMClaim()` and `validateClaimMessage()` | Identical behavior     | 33.6       |
| T-REG-04 | EVM claim JSON serialization unchanged (fixture comparison)                     | Pre-epic fixture from Epic 32              | Byte-for-byte match    | 33.6       |
| T-REG-05 | `per-packet-claim-service.test.ts` passes (EVM paths unmodified)               | Existing test file                         | All tests green        | 33.6       |
| T-REG-06 | Multi-hop E2E test (existing, EVM-only) passes with Solana provider registered  | Full Anvil E2E from test-design-multihop   | All tests green        | 33.7       |

### Regression Strategy

1. **Before starting Story 33.6:** Verify all existing claim-related tests pass. Capture baseline test results.
2. **Per-story gate:** Each story's PR must pass `npm test` (all unit tests including existing EVM tests).
3. **Story 33.7 final gate:** Mixed-chain integration test explicitly verifies EVM settlement works alongside Solana.
4. **No modification to existing EVM test files:** New Solana tests are additive. Existing EVM test scenarios must not be removed or modified.

### Existing Test Files at Risk from Story 33.6 Changes

| Test File                     | Risk                                          | Adaptation                         |
| ----------------------------- | --------------------------------------------- | ---------------------------------- |
| `btp-claim-types.test.ts`     | `BlockchainType` union extended               | Add Solana tests, keep EVM tests   |
| `claim-receiver.test.ts`      | New Solana dispatch path added                | Add Solana scenarios, keep EVM     |
| `claim-sender.test.ts`        | New Solana construction path added            | Add Solana scenarios, keep EVM     |
| `per-packet-claim-service.test.ts` | May need Solana provider in mock registry | Add Solana provider mock, keep EVM |

---

## 5. Test Data Requirements

### 5.1 Solana Test Keypairs

```typescript
// Standard test keypairs (deterministic, NOT for production)
const TEST_PARTICIPANT_A = Keypair.generate(); // Or use deterministic seed
const TEST_PARTICIPANT_B = Keypair.generate();
const TEST_TOKEN_MINT = /* SPL Token mint created in test setup */;
const TEST_PROGRAM_ID = /* Deployed program ID from build */;
```

### 5.2 Mock Solana Provider

```typescript
const createMockSolanaProvider = (): jest.Mocked<PaymentChannelProvider> => ({
  chainType: 'solana' as const,
  chainId: 'solana:devnet',
  openChannel: jest.fn().mockResolvedValue({
    channelId: 'ChannelPDABase58...',
    txHash: 'TxSignatureBase58...',
  }),
  deposit: jest.fn().mockResolvedValue({ txHash: 'TxSignatureBase58...' }),
  claimFromChannel: jest.fn().mockResolvedValue({ txHash: 'TxSignatureBase58...' }),
  closeChannel: jest.fn().mockResolvedValue({ txHash: 'TxSignatureBase58...' }),
  settleChannel: jest.fn().mockResolvedValue({ txHash: 'TxSignatureBase58...' }),
  signBalanceProof: jest.fn().mockResolvedValue('Base64Ed25519Signature...'),
  verifyBalanceProof: jest.fn().mockResolvedValue(true),
  getChannelState: jest.fn().mockResolvedValue({
    channelId: 'ChannelPDABase58...',
    status: 'opened',
    participants: ['ParticipantABase58...', 'ParticipantBBase58...'],
    deposit: 1000000n,
  }),
  subscribeToEvents: jest.fn().mockReturnValue({
    unsubscribe: jest.fn(),
    on: jest.fn(),
  }),
});
```

### 5.3 Solana Claim Message Fixture

```json
{
  "version": "1.0",
  "blockchain": "solana",
  "channelPDA": "ChannelPDABase58...",
  "nonce": 42,
  "transferredAmount": "1000000",
  "signature": "Base64Ed25519Signature...",
  "signerPubkey": "SignerPubkeyBase58...",
  "programId": "ProgramIdBase58...",
  "tokenMint": "TokenMintBase58...",
  "cluster": "devnet"
}
```

### 5.4 Cross-Language Golden Test Vectors

For R-04 mitigation, maintain golden test vectors that both Rust and TypeScript tests validate against:

```typescript
// Golden balance proof message (hex)
const GOLDEN_BALANCE_PROOF = {
  channelPDA: 'Base58EncodedPDA...',
  nonce: 42,
  transferredAmount: 1000000n,
  expectedMessageHex: '...48 bytes hex...', // channel_pda(32) || nonce(8 LE) || amount(8 LE)
  expectedSignatureBase64: '...', // Ed25519 signature from known keypair
};
```

Store in `packages/connector/src/settlement/__fixtures__/solana-golden-vectors.json` and `packages/solana-program/tests/fixtures/golden-vectors.json` (duplicated intentionally — each language validates independently).

### 5.5 Configuration Fixtures

**Solana provider config:**

```yaml
chainProviders:
  - chainType: solana
    chainId: 'solana:devnet'
    rpcUrl: 'http://localhost:8899'
    wsUrl: 'ws://localhost:8900'
    programId: 'ProgramIdBase58...'
    tokenMint: 'TokenMintBase58...'
    keypairPath: './test-keypair.json'
```

**Mixed-chain config (EVM + Solana):**

```yaml
chainProviders:
  - chainType: evm
    chainId: 'evm:31337'
    rpcUrl: 'http://localhost:8545'
    registryAddress: '0xRegistry...'
    keyId: 'evm-signer-1'
  - chainType: solana
    chainId: 'solana:devnet'
    rpcUrl: 'http://localhost:8899'
    programId: 'ProgramIdBase58...'
    tokenMint: 'TokenMintBase58...'
peers:
  - id: evm-peer
    chain: 'evm:31337'
    evmAddress: '0xPeerB...'
  - id: solana-peer
    chain: 'solana:devnet'
    solanaPubkey: 'PeerPubkeyBase58...'
```

### 5.6 Test Data Constants

```typescript
// Solana test chain IDs
const TEST_SOLANA_CHAIN_ID = 'solana:devnet';
const TEST_SOLANA_CHAIN_ID_MAINNET = 'solana:mainnet-beta';

// Solana test amounts
const TEST_DEPOSIT_AMOUNT = 1000000n;
const TEST_TRANSFER_AMOUNT = 500000n;
const TEST_CLAIM_NONCE_START = 1;

// Challenge duration (seconds)
const TEST_CHALLENGE_DURATION = 3600; // 1 hour for tests
const TEST_CHALLENGE_DURATION_SHORT = 5; // 5 seconds for timeout tests
```

### 5.7 Mock Factory Additions

Add to existing `packages/connector/src/test-utils/mock-factories.ts`:

```typescript
export function createMockSolanaPaymentChannelProvider(
  overrides?: Partial<PaymentChannelProvider>
): jest.Mocked<PaymentChannelProvider>;

export function createMockSolanaPaymentChannelSDK(
  overrides?: Partial<SolanaPaymentChannelSDK>
): jest.Mocked<SolanaPaymentChannelSDK>;
```

---

## 6. Test Execution Strategy

### 6.1 Story Execution Order (follows dependency graph)

```
Phase 1: 33.1 (On-chain lifecycle) — Rust tests only
Phase 2: 33.2 (On-chain claims) — Rust tests, depends on 33.1
Phase 3: 33.3 (On-chain comprehensive + deployment) — Rust integration, depends on 33.1+33.2
Phase 4: 33.4 (TypeScript SDK) — TS tests + cross-language, depends on 33.1+33.2
Phase 5: 33.5 (Provider adapter) — TS unit tests, depends on 33.4
Phase 6: 33.6 (Claim types) — TS unit tests + regression gate, depends on 33.5
Phase 7: 33.7 (Integration/E2E) — full integration, depends on all above
Phase 8: 33.8 (Devnet deployment) — manual/CI, depends on 33.3
```

Note: Phases 4 and 3 can partially overlap since the SDK (33.4) can be developed against a stable program from 33.1+33.2. Phase 8 can start as soon as Phase 3 completes.

### 6.2 CI Gate per Story PR

Each story PR must pass:

1. `npm run lint` (ESLint + Prettier) for TypeScript changes
2. `npm run typecheck` (tsc --noEmit) for TypeScript changes
3. `cargo clippy` and `cargo fmt --check` for Rust changes
4. `cargo test-sbf` for Rust program tests (Stories 33.1--33.3)
5. `npm test` for all TypeScript unit tests (Stories 33.4--33.7)
6. Story-specific regression tests identified in section 4

### 6.3 Infrastructure Requirements

| Test Level      | Infrastructure              | Setup Command         | Teardown Command      |
| --------------- | --------------------------- | --------------------- | --------------------- |
| Rust unit       | None (in-process)           | N/A                   | N/A                   |
| TS unit         | None (mocked SDK)           | N/A                   | N/A                   |
| TS integration (bankrun) | None (in-process)  | N/A                   | N/A                   |
| TS integration (TV) | Docker solana-test-validator | `make solana-up`   | `make solana-down`    |
| Mixed-chain E2E | Docker Anvil + solana-test-validator | `make anvil-up && make solana-up` | `make solana-down && make anvil-down` |
| Devnet          | Real Solana devnet          | Funded deployer keypair | N/A                 |

### 6.4 Coverage Targets

Per project conventions:

- TypeScript branches: 60%, functions: 75%, lines: 70%, statements: 70%
- New TypeScript files should aim for: lines 85%+, branches 75%+
- Rust program: aim for line coverage 90%+ (critical financial code, greenfield)

### 6.5 Test Timeout Configuration

- Rust tests (`cargo test-sbf`): 300s default (program compilation can be slow)
- TypeScript unit tests: 30s default
- TypeScript integration (solana-bankrun): 60s
- TypeScript integration (solana-test-validator): 120s (account for validator startup)
- Mixed-chain E2E: 180s

---

## 7. Traceability Matrix

| Story | Acceptance Criteria                                  | Test IDs                         | Risk IDs       |
| ----- | ---------------------------------------------------- | -------------------------------- | -------------- |
| 33.1  | Channel PDA created with correct state               | T-33.1-01                        | R-05           |
| 33.1  | Deposit transfers tokens to vault                    | T-33.1-02, T-33.1-03            | R-08           |
| 33.1  | Close sets state and timestamp                       | T-33.1-04                        | R-10           |
| 33.1  | Settle distributes after challenge                   | T-33.1-05                        | R-02, R-10     |
| 33.1  | Settle fails before challenge deadline               | T-33.1-06                        | R-10           |
| 33.1  | Force close works after deadline                     | T-33.1-08                        | R-10           |
| 33.2  | Valid claim updates nonce and amount                  | T-33.2-01                        | R-01           |
| 33.2  | Replay nonce rejected                                | T-33.2-02, T-33.2-03            | R-09           |
| 33.2  | Invalid signature rejected                           | T-33.2-04                        | R-01           |
| 33.2  | Non-participant rejected                             | T-33.2-05                        | R-01           |
| 33.2  | Decreased amount rejected                            | T-33.2-06                        | R-09           |
| 33.2  | Claims accepted during challenge period              | T-33.2-07                        | R-10           |
| 33.3  | Full lifecycle test passes                           | T-33.3-01                        | R-02           |
| 33.3  | Security edge cases caught                           | T-33.3-04, T-33.3-05, T-33.3-06 | R-09, R-10     |
| 33.3  | Devnet deployment successful                         | T-33.3-10, T-33.3-11            | R-13           |
| 33.3  | PDA ordering verified                                | T-33.3-06                        | R-05           |
| 33.4  | SDK submits transactions on-chain                    | T-33.4-01, T-33.4-02, T-33.4-05 | R-04, R-08     |
| 33.4  | Balance proof signature accepted on-chain            | T-33.4-04                        | R-04           |
| 33.4  | PDA derivation matches Rust                          | T-33.4-06, T-33.4-07            | R-05           |
| 33.4  | Account subscription works                           | T-33.4-10                        | R-06           |
| 33.5  | Implements PaymentChannelProvider                    | T-33.5-01                        | —              |
| 33.5  | Delegates to SDK correctly                           | T-33.5-03, T-33.5-06, T-33.5-07 | —              |
| 33.5  | Events compatible with SettlementMonitor             | T-33.5-04                        | R-06           |
| 33.5  | Error mapping works                                  | T-33.5-09                        | —              |
| 33.5  | Provider registered and discoverable                 | T-33.5-11, T-33.5-12            | R-07           |
| 33.6  | BlockchainType includes 'solana'                     | T-33.6-01                        | R-03           |
| 33.6  | EVM paths unchanged                                  | T-33.6-04, T-33.6-07, T-33.6-09 | R-03           |
| 33.6  | Solana serialization/deserialization works            | T-33.6-05, T-33.6-06            | R-07           |
| 33.6  | ClaimReceiver routes Solana claims correctly          | T-33.6-08                        | R-07           |
| 33.6  | Tampered programId rejected                          | T-33.6-13                        | R-07           |
| 33.7  | Full Solana lifecycle E2E                            | T-33.7-01                        | R-01, R-02, R-04 |
| 33.7  | Mixed-chain EVM + Solana works                       | T-33.7-04                        | R-07           |
| 33.7  | Account subscription fires events                    | T-33.7-05                        | R-06           |
| 33.7  | EVM regression check                                 | T-33.7-12                        | R-03           |
| 33.7  | No direct SDK imports in services                    | T-33.7-11                        | —              |
| 33.8  | Devnet deployment successful                         | T-33.8-01, T-33.8-02            | R-13           |
| 33.8  | Upgrade authority correct                            | T-33.8-03                        | R-13           |
| 33.8  | Config documentation works                           | T-33.8-04                        | —              |

---

## 8. Open Questions

1. **Balance proof message format finalization:** The epic specifies `channel_pda (32) || nonce (8 LE) || transferred_amount (8 LE)`. Should this include a domain separator (like EIP-712's `typeHash`) to prevent cross-program signature reuse? Recommend adding a prefix like `b"toon_solana_bp_v1"` to the signed message.

2. **u64 vs string amounts:** The on-chain program uses `u64` for amounts. The `PaymentChannelProvider` interface uses string amounts for bigint precision (per Epic 32 convention). The SDK must handle this conversion. Should the SDK accept `bigint` and convert to `u64` with overflow checking?

3. **solana-bankrun vs solana-test-validator boundary:** The test plan assumes `solana-bankrun` for most integration tests and Docker-based validator only for subscription tests. Confirm that `solana-bankrun` supports Ed25519 precompile simulation correctly. If not, more tests move to the Docker-based validator tier.

4. **Golden test vector source of truth:** Should the golden vectors be generated by the Rust program (canonical) and consumed by TypeScript, or maintained as a shared fixture? Recommend Rust-generated vectors committed to a shared fixture directory.

5. **Devnet rate limits for CI:** The devnet smoke test (T-33.8-05) uses real devnet SOL. Solana devnet airdrop is rate-limited to ~5 SOL/hr. Should this test be excluded from CI and run manually?

6. **Token-2022 future compatibility:** The epic explicitly defers Token-2022. Should the SDK's SPL token interactions be written to support Token-2022 extension in the future (use `@solana-program/token-2022` types), or keep it simple with standard SPL Token for now?
