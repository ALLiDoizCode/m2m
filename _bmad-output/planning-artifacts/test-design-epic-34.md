---
stepsCompleted:
  - risk-assessment
  - strategy-per-story
  - cross-story-integration
  - regression-analysis
  - test-data-requirements
lastSaved: '2026-03-26'
revision: v1
epicRef: epic-34-mina-protocol-payment-channel-provider.md
inputDocuments:
  - _bmad-output/planning-artifacts/epic-34-mina-protocol-payment-channel-provider.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/project-context.md
  - _bmad-output/planning-artifacts/test-design-epic-32.md
  - _bmad-output/planning-artifacts/test-design-epic-33.md
  - _bmad-output/test-artifacts/test-design-epic-multihop-e2e.md
---

# Test Design: Epic 34 — Mina Protocol Payment Channel Provider (ZK-Private Settlement)

**Date:** 2026-03-26
**Author:** Jonathan (generated with Claude)
**Status:** Draft v1

---

## Executive Summary

**Scope:** Risk-based test plan for Epic 34, covering 9 stories (34.1--34.9) that deliver a complete Mina Protocol payment channel system: a zkApp smart contract (o1js), TypeScript SDK, `MinaPaymentChannelProvider` implementing the `PaymentChannelProvider` interface from Epic 32, NIP-59-inspired claim wrapping for transport privacy, Mina claim message types, E2E integration tests, and devnet deployment.

**Epic Type:** Greenfield with novel constraints. This is the **first payment channel implementation on Mina Protocol** -- there is no prior art to reference. The dominant constraints are: (1) zk-SNARK proof generation latency (30--120s) must be async and non-blocking, (2) o1js 8-field on-chain state limit forces a Poseidon commitment pattern, (3) ZK circuit correctness is critical for both security and privacy, and (4) three-chain coexistence (EVM + Solana + Mina) must not regress existing settlement.

**Architecture Constraint:** Unit tests use `Mina.LocalBlockchain({ proofsEnabled: false })` (in-process, no Docker, milliseconds per test). Proof-enabled integration tests use `proofsEnabled: true` (30--120s/tx, 5-minute Jest timeout, merge/nightly only). E2E tests requiring real block production use Docker-based lightnet (`make mina-up`, image `o1labs/mina-local-network:o1js-main`). EVM and Solana regression tests continue using Anvil and solana-bankrun respectively.

**Risk Summary:**

- Total risks identified: 16
- Critical (score >= 8): 5
- High (score 5--7): 6
- Medium (score 3--4): 4
- Low (score 1--2): 1

**Coverage Summary:**

- zkApp unit test scenarios (proofsEnabled: false): 32
- zkApp proof-enabled test scenarios (proofsEnabled: true): 8
- TypeScript unit test scenarios: 42
- Integration/E2E test scenarios: 18
- Regression scenarios: 8
- Estimated effort: 16--22 dev days

---

## 1. Key Risks and Mitigating Tests

### Risk Matrix

| ID   | Risk                                                                    | Likelihood | Impact   | Score | Category    | Mitigating Tests                      |
| ---- | ----------------------------------------------------------------------- | ---------- | -------- | ----- | ----------- | ------------------------------------- |
| R-01 | zk-SNARK proof circuit bug allows invalid balance transitions           | Medium     | Critical | 9     | SECURITY    | T-34.2-01 through T-34.2-08, T-34.3-04 |
| R-02 | Proof generation latency (30-120s) blocks ILP packet pipeline           | High       | Critical | 9     | PERF        | T-34.5-08, T-34.8-04                 |
| R-03 | Poseidon commitment mismatch between off-chain signing and on-chain verification | Medium | Critical | 8 | CRYPTO | T-34.2-01, T-34.4-03, T-34.8-01      |
| R-04 | EVM/Solana settlement regression from claim type changes                | Medium     | Critical | 8     | REGRESSION  | T-REG-01 through T-REG-08            |
| R-05 | 8-field on-chain state constraint violated or data loss                 | Medium     | Critical | 8     | DESIGN      | T-34.1-01, T-34.1-07                 |
| R-06 | Balance conservation bug -- funds lost or created in state transitions  | Medium     | High     | 7     | LOGIC       | T-34.1-05, T-34.3-02, T-34.3-03      |
| R-07 | Privacy leak -- actual balances recoverable from on-chain state         | Medium     | High     | 7     | PRIVACY     | T-34.2-07, T-34.3-05, T-34.8-03      |
| R-08 | o1js API instability breaks build after version update                  | Medium     | Medium   | 6     | COMPAT      | T-34.3-01, T-34.4-01                 |
| R-09 | Challenge period timing exploit allows premature settlement             | Low        | High     | 6     | SECURITY    | T-34.1-04, T-34.3-06                 |
| R-10 | Mina claim routed to EVM/Solana provider (or vice versa)               | Low        | High     | 6     | ROUTING     | T-34.7-05, T-34.8-06                 |
| R-11 | NIP-59 wrapping overhead or failure prevents claim delivery             | Medium     | Medium   | 5     | RELIABILITY | T-34.6-01 through T-34.6-06, T-34.8-05 |
| R-12 | Archive node unavailability leaves provider in broken state             | Medium     | Medium   | 5     | RELIABILITY | T-34.5-09, T-34.8-08                 |
| R-13 | Nonce monotonicity bypass allows claim replay                           | Low        | High     | 5     | SECURITY    | T-34.2-04, T-34.3-04                 |
| R-14 | Mina account nonce conflict causes transaction rejection                | Medium     | Medium   | 4     | OPS         | T-34.5-10                            |
| R-15 | zkApp upgrade authority misconfigured, locking out future upgrades      | Low        | Medium   | 3     | OPS         | T-34.9-03                            |
| R-16 | NIP-59 ephemeral key reuse degrades transport privacy                   | Low        | Low      | 2     | PRIVACY     | T-34.6-05                            |

### Risk Detail: Top 5

**R-01: ZK Circuit Bug Allows Invalid Balance Transitions** (Score 9)
The `claimFromChannel()` method uses a zk-SNARK proof circuit that must enforce five invariants: commitment validity, fund conservation, non-negativity, monotonic nonce, and dual-party authorization. A bug in any circuit constraint could allow an attacker to drain funds or create tokens from nothing. Unlike EVM/Solana where on-chain code is auditable bytecode, zk circuits have subtle failure modes -- a missing constraint is invisible at runtime. Mitigation: Exhaustive negative testing of every circuit constraint (Story 34.2), proof-enabled integration tests (Story 34.3), and privacy verification tests that confirm balances are not leaking.

**R-02: Proof Generation Latency Blocks ILP Pipeline** (Score 9)
Generating a zk-SNARK proof takes 30--120 seconds depending on hardware. If proof generation runs synchronously in the settlement path, the entire ILP packet processing pipeline stalls. This is the highest-likelihood critical risk because it affects every settlement operation. Mitigation: The provider must generate proofs asynchronously (Story 34.5). Integration tests (Story 34.8) explicitly verify that ILP packet forwarding continues during proof generation by measuring packet throughput during a settlement operation.

**R-03: Poseidon Commitment Mismatch** (Score 8)
The balance commitment is `Poseidon(balance_a, balance_b, salt)`. This must be computed identically: (a) in the SDK when signing claims, (b) in the zkApp when verifying proofs, and (c) in the provider when constructing claim messages. If any implementation computes the hash differently (field ordering, encoding), valid claims will be rejected on-chain. Mitigation: Golden test vectors shared between zkApp tests and SDK tests. Cross-layer integration tests in Story 34.8 verify the full round-trip.

**R-04: EVM/Solana Settlement Regression** (Score 8)
Story 34.7 adds `'mina'` to the `BlockchainType` union and introduces `MinaClaimMessage`. The discriminated union modification touches shared code paths in `ClaimReceiver`, `ClaimSender`, and `validateClaimMessage()`. If the union extension breaks existing type narrowing, EVM or Solana claims could fail. Mitigation: Explicit backward-compatibility tests ensuring all existing EVM and Solana claim paths work unchanged, plus regression gate on existing test files.

**R-05: 8-Field On-Chain State Constraint** (Score 8)
Mina zkApps are limited to 8 `Field` elements (32 bytes each) of on-chain state. The channel design must fit all essential state into these 8 fields using Poseidon hash commitments. If the design requires a 9th field or a commitment is computed incorrectly, the zkApp will fail to compile or lose data. Mitigation: Story 34.1 tests verify all 8 fields are populated correctly and that the Poseidon commitment pattern reconstructs correctly.

---

## 2. Test Strategy Per Story

### Story 34.1: Mina Payment Channel zkApp -- Channel Lifecycle

**Test Level:** o1js unit (LocalBlockchain, proofsEnabled: false)
**Risk Focus:** R-05 (8-field state), R-06 (balance conservation), R-09 (challenge period)

| ID        | Scenario                                                                                                       | Type             | Priority |
| --------- | -------------------------------------------------------------------------------------------------------------- | ---------------- | -------- |
| T-34.1-01 | `initializeChannel` sets all 8 on-chain state fields: channelHash, balanceCommitment, nonceField, channelState, depositTotal, closedAtSlot, settlementTimeout, tokenId | Unit (o1js) | P0 |
| T-34.1-02 | `initializeChannel` computes channelHash as `Poseidon(participantA, participantB, nonce)` correctly            | Unit (o1js)      | P0       |
| T-34.1-03 | `deposit` increments depositTotal by deposited amount and requires depositor signature                         | Unit (o1js)      | P0       |
| T-34.1-04 | `initiateClose` transitions channelState from OPEN to CLOSING and records closedAtSlot                         | Unit (o1js)      | P0       |
| T-34.1-05 | `settle` after challenge period distributes funds and transitions to SETTLED                                    | Unit (o1js)      | P0       |
| T-34.1-06 | `settle` before challenge period expires is rejected                                                            | Unit (o1js)      | P0       |
| T-34.1-07 | All 8 state fields are used -- no unused fields, no overflow into field 9                                      | Unit (o1js)      | P0       |
| T-34.1-08 | `initiateClose` verifies balanceCommitment matches `Poseidon(balanceA, balanceB, salt)` and both signatures    | Unit (o1js)      | P0       |
| T-34.1-09 | `initializeChannel` fails on double-init (channelState != UNINITIALIZED)                                       | Unit (o1js)      | P1       |
| T-34.1-10 | `deposit` to CLOSING or SETTLED channel is rejected                                                             | Unit (o1js)      | P1       |
| T-34.1-11 | `deposit` with zero amount is rejected or no-op                                                                 | Unit (o1js)      | P1       |
| T-34.1-12 | `initiateClose` can only be called when channelState == OPEN                                                    | Unit (o1js)      | P1       |
| T-34.1-13 | `settle` can only be called when channelState == CLOSING                                                        | Unit (o1js)      | P1       |

**Approach:** All tests use `Mina.LocalBlockchain({ proofsEnabled: false })` for sub-second execution. State assertions read zkApp on-chain fields directly via `zkApp.channelState.get()` etc. Challenge period tests manipulate the local blockchain's global slot via `localBlockchain.setGlobalSlot()`.

**Test File:** `packages/mina-zkapp/src/payment-channel.test.ts`

---

### Story 34.2: Mina Payment Channel zkApp -- ZK-Private Claims

**Test Level:** o1js unit (LocalBlockchain, proofsEnabled: false) + proof-enabled tests
**Risk Focus:** R-01 (circuit correctness), R-03 (Poseidon commitment), R-07 (privacy), R-13 (nonce replay)

| ID        | Scenario                                                                                                       | Type                  | Priority |
| --------- | -------------------------------------------------------------------------------------------------------------- | --------------------- | -------- |
| T-34.2-01 | Valid `claimFromChannel` with correct balances, salt, and dual signatures updates balanceCommitment and nonce   | Unit (o1js)           | P0       |
| T-34.2-02 | Claim where `new_balance_a + new_balance_b != depositTotal` is rejected (conservation violation)                | Unit (o1js)           | P0       |
| T-34.2-03 | Claim where `new_balance_a < 0` is rejected (non-negativity violation)                                          | Unit (o1js)           | P0       |
| T-34.2-04 | Claim with `new_nonce <= current_nonce` is rejected (monotonicity violation)                                     | Unit (o1js)           | P0       |
| T-34.2-05 | Claim with invalid signature from participant A is rejected                                                      | Unit (o1js)           | P0       |
| T-34.2-06 | Claim with invalid signature from participant B is rejected                                                      | Unit (o1js)           | P0       |
| T-34.2-07 | After successful claim, on-chain state reveals only Poseidon commitment -- not actual balances                  | Unit (o1js)           | P0       |
| T-34.2-08 | Channel remains OPEN after claim (cooperative claim does not close channel)                                      | Unit (o1js)           | P0       |
| T-34.2-09 | Multiple sequential claims with increasing nonces all succeed and update commitment                             | Unit (o1js)           | P1       |
| T-34.2-10 | Claim on CLOSING channel succeeds (balance updates allowed during challenge period)                              | Unit (o1js)           | P1       |
| T-34.2-11 | Claim on SETTLED channel is rejected                                                                             | Unit (o1js)           | P1       |
| T-34.2-12 | Claim with mismatched commitment (Poseidon hash of provided balances != newBalanceCommitment) is rejected       | Unit (o1js)           | P0       |
| T-34.2-13 | **[Proof-enabled]** Valid claim generates and verifies zk-SNARK proof successfully                              | Unit (proofs: true)   | P0       |
| T-34.2-14 | **[Proof-enabled]** Invalid claim proof is rejected by verifier                                                  | Unit (proofs: true)   | P0       |

**Approach:** Most tests run with `proofsEnabled: false` for speed -- o1js still enforces circuit constraints but skips actual proof generation. T-34.2-13 and T-34.2-14 run with `proofsEnabled: true` to verify real zk-SNARK proofs; these are slow (30--120s each) and should run in merge/nightly CI only.

**Test File:** `packages/mina-zkapp/src/payment-channel-claims.test.ts`

---

### Story 34.3: Mina Payment Channel zkApp -- Tests & Deployment

**Test Level:** o1js integration + proof-enabled + deployment verification
**Risk Focus:** R-01 (circuit bugs), R-06 (balance conservation), R-07 (privacy), R-08 (o1js compat), R-09 (challenge timing), R-13 (nonce replay)

| ID        | Scenario                                                                                                       | Type                | Priority |
| --------- | -------------------------------------------------------------------------------------------------------------- | ------------------- | -------- |
| T-34.3-01 | zkApp circuit compiles successfully and produces a deterministic verification key                               | Unit (o1js)         | P0       |
| T-34.3-02 | Full lifecycle: open -> deposit -> claim (private) -> close -> settle, final fund distribution correct          | Integration (o1js)  | P0       |
| T-34.3-03 | Balance conservation: `depositTotal == balance_a + balance_b` holds at every state transition                   | Integration (o1js)  | P0       |
| T-34.3-04 | Security: nonce replay attack across multiple claims is rejected                                                | Security (o1js)     | P0       |
| T-34.3-05 | Privacy: after N claims, on-chain state history contains only Poseidon commitments -- no balance amounts         | Privacy (o1js)      | P0       |
| T-34.3-06 | Security: settle before challenge timeout rejected, settle after timeout succeeds                               | Security (o1js)     | P0       |
| T-34.3-07 | Edge case: claim with zero balance for one participant (full transfer to other) succeeds                        | Unit (o1js)         | P1       |
| T-34.3-08 | Edge case: claim at maximum Field value boundary does not overflow                                              | Unit (o1js)         | P1       |
| T-34.3-09 | **[Proof-enabled]** Full lifecycle with real proofs: open -> deposit -> claim -> close -> settle                 | Integration (proof) | P0       |
| T-34.3-10 | **[Proof-enabled]** Verification key from compilation matches verification key from deployment                  | Integration (proof) | P0       |
| T-34.3-11 | **[Proof-enabled]** Tampered proof inputs rejected by on-chain verifier                                         | Security (proof)    | P0       |
| T-34.3-12 | **[Proof-enabled]** Proof generation time measured and documented per operation type                             | Performance (proof) | P1       |
| T-34.3-13 | Deployment script deploys zkApp to Mina devnet successfully (manual/CI gate)                                    | Deployment          | P1       |

**Approach:** Integration tests run the full lifecycle with `proofsEnabled: false` for fast CI. Proof-enabled tests (T-34.3-09 through T-34.3-12) run with `proofsEnabled: true` in merge/nightly pipeline only -- each takes 30--120s. T-34.3-12 records timing metrics for the performance documentation in Story 34.9.

**Test Files:**
- `packages/mina-zkapp/src/payment-channel-lifecycle.test.ts` (T-34.3-02, T-34.3-03)
- `packages/mina-zkapp/src/payment-channel-security.test.ts` (T-34.3-04, T-34.3-06, T-34.3-07, T-34.3-08)
- `packages/mina-zkapp/src/payment-channel-privacy.test.ts` (T-34.3-05)
- `packages/mina-zkapp/src/payment-channel-proofs.test.ts` (T-34.3-09 through T-34.3-12, jest timeout: 300000ms)

---

### Story 34.4: MinaPaymentChannelSDK -- TypeScript Integration

**Test Level:** TypeScript unit + integration (o1js LocalBlockchain)
**Risk Focus:** R-02 (proof latency), R-03 (Poseidon commitment), R-08 (o1js API)

| ID        | Scenario                                                                                                       | Type              | Priority |
| --------- | -------------------------------------------------------------------------------------------------------------- | ----------------- | -------- |
| T-34.4-01 | `compileContract()` compiles zkApp circuit and returns verification key                                         | Integration (o1js)| P0       |
| T-34.4-02 | `openChannel()` deploys zkApp and returns channel address (base58)                                              | Integration (o1js)| P0       |
| T-34.4-03 | `signBalanceProof()` computes Poseidon commitment matching golden test vector                                   | Unit              | P0       |
| T-34.4-04 | Signature from `signBalanceProof()` is accepted by on-chain `claimFromChannel()`                                | Integration (o1js)| P0       |
| T-34.4-05 | `claimFromChannel()` generates proof and submits transaction to local blockchain                                | Integration (o1js)| P0       |
| T-34.4-06 | `deposit()` submits deposit transaction and increments on-chain depositTotal                                    | Integration (o1js)| P0       |
| T-34.4-07 | `closeChannel()` and `settleChannel()` delegate correctly through lifecycle                                     | Integration (o1js)| P1       |
| T-34.4-08 | `getChannelState()` deserializes all 8 on-chain fields into typed SDK objects                                   | Integration (o1js)| P0       |
| T-34.4-09 | `getChannelEvents()` retrieves actions/events from archive node (or local simulation)                           | Integration (o1js)| P1       |
| T-34.4-10 | `compileContract()` returns a Promise that resolves asynchronously (non-blocking)                               | Unit              | P0       |
| T-34.4-11 | `claimFromChannel()` returns a Promise -- caller is not blocked during proof generation                         | Unit              | P0       |
| T-34.4-12 | Poseidon commitment golden vector: `Poseidon(balanceA, balanceB, salt)` matches expected hash for known inputs  | Unit              | P0       |

**Approach:** Integration tests use `Mina.LocalBlockchain({ proofsEnabled: false })` for speed. T-34.4-03 and T-34.4-12 use golden test vectors to verify Poseidon commitment consistency. Async behavior tests (T-34.4-10, T-34.4-11) verify that SDK methods return Promises without blocking the event loop.

**Test File:** `packages/connector/src/settlement/providers/mina/mina-payment-channel-sdk.test.ts`

---

### Story 34.5: Implement MinaPaymentChannelProvider

**Test Level:** TypeScript unit (mocked SDK) + integration
**Risk Focus:** R-02 (proof latency), R-10 (claim routing), R-12 (archive node), R-14 (account nonce)

| ID        | Scenario                                                                                                       | Type        | Priority |
| --------- | -------------------------------------------------------------------------------------------------------------- | ----------- | -------- |
| T-34.5-01 | `MinaPaymentChannelProvider` implements `PaymentChannelProvider` interface (TypeScript compiles)                | Type check  | P0       |
| T-34.5-02 | `chainType` returns `'mina'`, `chainId` returns configured chain ID string (e.g., `'mina:devnet'`)            | Unit        | P0       |
| T-34.5-03 | `openChannel()` delegates to `MinaPaymentChannelSDK.openChannel()`, returns provider-canonical format          | Unit        | P0       |
| T-34.5-04 | `signBalanceProof()` delegates to SDK and returns Poseidon commitment + zk proof                               | Unit        | P0       |
| T-34.5-05 | `verifyBalanceProof()` validates zk-SNARK proof and checks commitment consistency                              | Unit        | P0       |
| T-34.5-06 | `claimFromChannel()` delegates to SDK, handles async proof generation                                          | Unit        | P0       |
| T-34.5-07 | `getChannelState()` translates Mina channel state to `ProviderChannelState`                                    | Unit        | P1       |
| T-34.5-08 | Proof generation runs asynchronously -- `claimFromChannel()` returns Promise without blocking event loop        | Unit        | P0       |
| T-34.5-09 | Archive node unavailability handled gracefully with retry/fallback to account state polling                     | Unit        | P1       |
| T-34.5-10 | Concurrent claim submissions manage Mina account nonces correctly (no conflicts)                               | Unit        | P1       |
| T-34.5-11 | `subscribeToEvents()` emits provider-compatible state-change events on channel updates                         | Unit        | P1       |
| T-34.5-12 | `subscribeToEvents()` unsubscribe cleans up underlying subscription                                            | Unit        | P1       |
| T-34.5-13 | Provider registered in `ChainProviderRegistry` and retrievable by `'mina:devnet'`                              | Unit        | P0       |
| T-34.5-14 | `getProviderForPeer(peerConfig)` resolves MinaPaymentChannelProvider for Mina-configured peer                  | Unit        | P0       |
| T-34.5-15 | `closeChannel()`, `settleChannel()`, `deposit()` delegate correctly                                            | Unit        | P1       |
| T-34.5-16 | Provider pre-compiles zkApp circuit during initialization                                                       | Unit        | P0       |
| T-34.5-17 | Mina-specific error (proof generation failure) is mapped to provider-level error type                          | Unit        | P0       |

**Approach:** Unit tests mock `MinaPaymentChannelSDK` and verify delegation. Async behavior tests use `jest.useFakeTimers()` or Promise inspection to verify non-blocking behavior. The provider is tested in isolation; integration with the registry and settlement services is covered in Story 34.8.

**Test File:** `packages/connector/src/settlement/providers/mina/mina-payment-channel-provider.test.ts`

---

### Story 34.6: NIP-59-Inspired Claim Wrapping for Transport Privacy

**Test Level:** TypeScript unit
**Risk Focus:** R-11 (wrapping overhead), R-16 (ephemeral key reuse)

| ID        | Scenario                                                                                                       | Type | Priority |
| --------- | -------------------------------------------------------------------------------------------------------------- | ---- | -------- |
| T-34.6-01 | Claim wrapped in three layers: rumor (unsigned payload) -> seal (encrypted to peer) -> gift wrap (ephemeral key) | Unit | P0       |
| T-34.6-02 | Gift wrap layer uses ephemeral one-time key -- receiver decrypts without knowing sender identity                | Unit | P0       |
| T-34.6-03 | Seal layer decrypted using shared secret with real sender, reveals signed rumor                                  | Unit | P0       |
| T-34.6-04 | Rumor layer contains valid MinaClaimMessage with verifiable zk proof                                            | Unit | P0       |
| T-34.6-05 | Each wrapping operation uses a fresh ephemeral key (no reuse across claims)                                     | Unit | P0       |
| T-34.6-06 | Full round-trip: wrap claim -> transmit -> unwrap -> extracted claim matches original                           | Unit | P0       |
| T-34.6-07 | Wrapped claim is indistinguishable: BTP intermediary sees only encrypted bytes and ephemeral public key         | Unit | P1       |
| T-34.6-08 | NIP-59 wrapping disabled in config: claim sent as plaintext MinaClaimMessage                                    | Unit | P0       |
| T-34.6-09 | NIP-59 wrapping enabled in config: claim sent as `protocolName: 'claim-wrapped'` with APPLICATION_OCTET_STREAM | Unit | P0       |
| T-34.6-10 | Decryption with wrong private key fails gracefully with descriptive error                                       | Unit | P1       |
| T-34.6-11 | Wrapping overhead measured: serialized wrapped size vs. plaintext size (advisory, not a gate)                   | Unit | P2       |
| T-34.6-12 | Gift wrap timestamp is randomized (not correlated with actual send time)                                        | Unit | P1       |

**Approach:** Unit tests create keypair pairs, wrap claims, and verify each layer independently. The round-trip test (T-34.6-06) is the primary correctness gate. Privacy tests (T-34.6-07, T-34.6-12) verify that wrapped claims do not leak metadata.

**Test File:** `packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts`

---

### Story 34.7: Mina Claim Message Types & Serialization

**Test Level:** TypeScript unit
**Risk Focus:** R-04 (EVM/Solana regression), R-10 (claim routing)

| ID        | Scenario                                                                                                       | Type       | Priority |
| --------- | -------------------------------------------------------------------------------------------------------------- | ---------- | -------- |
| T-34.7-01 | `BlockchainType` union includes `'mina'` alongside existing `'evm'` and `'solana'`                             | Type check | P0       |
| T-34.7-02 | `MinaClaimMessage` extends `BaseClaimMessage` with all required fields (zkAppAddress, tokenId, balanceCommitment, nonce, proof, salt) | Type check | P0 |
| T-34.7-03 | `isMinaClaim()` type guard narrows `BTPClaimMessage` to `MinaClaimMessage`                                     | Unit       | P0       |
| T-34.7-04 | `isEVMClaim()` continues to narrow correctly after `'mina'` addition (EVM backward compat)                     | Unit       | P0       |
| T-34.7-05 | `isSolanaClaim()` continues to narrow correctly after `'mina'` addition (Solana backward compat)               | Unit       | P0       |
| T-34.7-06 | `MinaClaimMessage` serialized to BTP protocolData JSON includes `chain: 'mina'` discriminator                  | Unit       | P0       |
| T-34.7-07 | BTP protocolData with `chain: 'mina'` deserialized into typed `MinaClaimMessage`                               | Unit       | P0       |
| T-34.7-08 | BTP protocolData with `chain: 'evm'` continues to deserialize as `EVMClaimMessage` (no change)                 | Unit       | P0       |
| T-34.7-09 | BTP protocolData with `chain: 'solana'` continues to deserialize as `SolanaClaimMessage` (no change)           | Unit       | P0       |
| T-34.7-10 | `MinaClaimMessage` with missing required field (e.g., no zkAppAddress) rejected by Zod validation              | Unit       | P0       |
| T-34.7-11 | `ClaimReceiver` routes Mina claims to Mina provider verification path                                          | Unit       | P0       |
| T-34.7-12 | `ClaimReceiver` routes EVM and Solana claims unchanged (backward compat)                                       | Unit       | P0       |
| T-34.7-13 | `ClaimSender` constructs `MinaClaimMessage` with self-describing fields from provider context                  | Unit       | P1       |
| T-34.7-14 | `validateClaimMessage()` accepts valid `MinaClaimMessage`                                                       | Unit       | P0       |
| T-34.7-15 | `validateClaimMessage()` rejects `MinaClaimMessage` with invalid balanceCommitment format                      | Unit       | P1       |
| T-34.7-16 | NIP-59-wrapped claim uses `protocolName: 'claim-wrapped'` with APPLICATION_OCTET_STREAM content type           | Unit       | P1       |

**Approach:** Type-check tests verify compilation. Runtime tests verify serialization round-trip and discriminated union dispatch. Backward-compatibility tests ensure no EVM or Solana path regressions. Mock providers used for ClaimReceiver/ClaimSender tests.

**Test Files:**
- `packages/connector/src/btp/btp-claim-types.test.ts` (extend with Mina tests: T-34.7-01 through T-34.7-10, T-34.7-14 through T-34.7-16)
- Modify existing `packages/connector/src/settlement/claim-receiver.test.ts` (T-34.7-11, T-34.7-12)
- Modify existing `packages/connector/src/settlement/claim-sender.test.ts` (T-34.7-13)

---

### Story 34.8: Integration Tests -- Mina Provider E2E

**Test Level:** Integration/E2E (o1js LocalBlockchain + lightnet for full E2E)
**Risk Focus:** R-01 (circuit bugs), R-02 (proof latency), R-03 (Poseidon commitment), R-04 (regression), R-07 (privacy), R-10 (routing), R-11 (NIP-59), R-12 (archive node)

| ID        | Scenario                                                                                                       | Type                  | Priority |
| --------- | -------------------------------------------------------------------------------------------------------------- | --------------------- | -------- |
| T-34.8-01 | Full lifecycle E2E: open -> deposit -> claim (private) -> close -> settle through connector pipeline           | Integration (o1js)    | P0       |
| T-34.8-02 | Multi-peer settlement: 3 peers with Mina channels, ILP packets trigger claims, settlement executes             | Integration (o1js)    | P0       |
| T-34.8-03 | Privacy verification: after N claims, on-chain state reveals no balance data -- only Poseidon commitments      | Integration (o1js)    | P0       |
| T-34.8-04 | Proof generation latency: ILP packet processing is not blocked during proof generation (throughput check)      | Integration (o1js)    | P0       |
| T-34.8-05 | NIP-59 round-trip: wrapped claim sent via BTP, receiver unwraps and verifies zk proof                          | Integration           | P1       |
| T-34.8-06 | Mixed-chain: peer A on EVM, peer B on Solana, peer C on Mina -- connector routes claims correctly              | Integration           | P1       |
| T-34.8-07 | Threshold settlement: credit balance exceeds threshold, triggers Mina settlement automatically                 | Integration (o1js)    | P0       |
| T-34.8-08 | Invalid claim rejection: tampered proof, wrong nonce, bad commitment -- all rejected with descriptive errors    | Integration (o1js)    | P0       |
| T-34.8-09 | Config-driven: Mina provider created from YAML config via `ChainProviderRegistry.fromConfig()`                 | Integration           | P1       |
| T-34.8-10 | Graceful shutdown: provider unsubscribes, registry deregisters provider                                         | Integration           | P1       |
| T-34.8-11 | No direct `MinaPaymentChannelSDK` imports in core settlement services (import audit)                           | Static                | P0       |
| T-34.8-12 | EVM settlement continues to work identically alongside active Mina provider (regression)                       | Integration           | P0       |
| T-34.8-13 | Solana settlement continues to work identically alongside active Mina provider (regression)                    | Integration           | P0       |
| T-34.8-14 | Claim JSON structure for Mina includes all self-describing fields (zkAppAddress, tokenId, balanceCommitment, nonce, proof) | Integration | P0 |
| T-34.8-15 | **[Proof-enabled]** Full lifecycle with real zk-SNARK proofs through connector pipeline                        | Integration (proof)   | P0       |
| T-34.8-16 | **[Proof-enabled]** Proof generation time measured per operation (open, claim, close, settle)                   | Performance (proof)   | P1       |
| T-34.8-17 | Mina claim accumulation: 5+ claims with increasing nonces, cumulative commitments tracked correctly            | Integration (o1js)    | P0       |
| T-34.8-18 | Archive node event retrieval: channel state changes detected via event polling                                  | Integration (lightnet)| P1       |

**Approach:** Most scenarios use `Mina.LocalBlockchain({ proofsEnabled: false })` for speed. The mixed-chain test (T-34.8-06) requires Anvil (EVM), solana-bankrun (Solana), and o1js local blockchain (Mina) running simultaneously. Proof-enabled tests (T-34.8-15, T-34.8-16) run in merge/nightly only. The lightnet test (T-34.8-18) requires Docker-based `mina-local-network` for real archive node behavior. T-34.8-11 is a static analysis check (grep for direct SDK imports in settlement service files).

**Test Files:**
- `packages/connector/test/integration/mina-provider.test.ts` (T-34.8-01 through T-34.8-04, T-34.8-07, T-34.8-08, T-34.8-14, T-34.8-17)
- `packages/connector/test/integration/mixed-chain-three-way.test.ts` (T-34.8-06, T-34.8-12, T-34.8-13)
- `packages/connector/test/integration/mina-nip59.test.ts` (T-34.8-05)
- `packages/connector/test/integration/mina-config.test.ts` (T-34.8-09, T-34.8-10, T-34.8-11)
- `packages/connector/test/integration/mina-proofs.test.ts` (T-34.8-15, T-34.8-16, jest timeout: 300000ms)
- `packages/connector/test/integration/mina-lightnet.test.ts` (T-34.8-18, requires `make mina-up`)

---

### Story 34.9: Mina Devnet Deployment & Documentation

**Test Level:** Manual/CI verification
**Risk Focus:** R-15 (upgrade authority)

| ID        | Scenario                                                                                           | Type         | Priority |
| --------- | -------------------------------------------------------------------------------------------------- | ------------ | -------- |
| T-34.9-01 | Deployment script deploys zkApp to Mina devnet successfully                                        | CI/manual    | P0       |
| T-34.9-02 | zkApp address and verification key recorded in project config match deployed contract              | CI/manual    | P0       |
| T-34.9-03 | zkApp upgrade authority is correctly set (not locked to deployer default)                           | CI/manual    | P0       |
| T-34.9-04 | Connector YAML config with Mina provider settings loads and validates                              | Unit         | P1       |
| T-34.9-05 | Devnet smoke test: open -> deposit -> claim -> close -> settle on live devnet                       | Manual E2E   | P1       |
| T-34.9-06 | Performance benchmarks documented: proof generation time by operation type with hardware specs      | Manual       | P1       |

**Approach:** Deployment verification is a CI gate or manual checklist. The smoke test (T-34.9-05) runs against real devnet -- it is not automated in CI due to Mina devnet block times (~3 min) and rate limits. Performance benchmarks (T-34.9-06) use data from T-34.3-12 and T-34.8-16.

**Test File:** No dedicated test file. T-34.9-04 covered by config validation tests. T-34.9-01 through T-34.9-03 are deployment script outputs verified manually.

---

## 3. Cross-Story Integration Points

### 3.1 zkApp to TypeScript SDK (34.1/34.2 + 34.4)

**Seam:** The zkApp (o1js) and the TypeScript SDK must agree on: Poseidon commitment field ordering, on-chain state field indices, transaction method signatures, and proof format.

**Risk:** Poseidon commitment mismatch (R-03). If the SDK computes `Poseidon(balance_a, balance_b, salt)` with different field ordering than the zkApp expects, all claims will be rejected.

**Tests:** T-34.4-03 (Poseidon golden vector), T-34.4-04 (signature accepted on-chain), T-34.4-12 (commitment golden vector).

### 3.2 TypeScript SDK to Provider Adapter (34.4 + 34.5)

**Seam:** `MinaPaymentChannelProvider` wraps `MinaPaymentChannelSDK` methods and translates between provider-level abstractions and Mina-specific calls. The async proof generation must be preserved through the adapter layer.

**Risk:** Incorrect delegation or blocking the event loop during proof generation (R-02).

**Tests:** T-34.5-03 through T-34.5-08 (delegation + async behavior tests).

### 3.3 Provider to Registry to Settlement Services (34.5 + Epic 32 registry)

**Seam:** `MinaPaymentChannelProvider` registered in `ChainProviderRegistry`, looked up by `PerPacketClaimService`, `SettlementExecutor`, and `ClaimReceiver` for Mina-configured peers.

**Risk:** Registry lookup key mismatch (e.g., `'mina:devnet'` vs `'mina:mainnet'`).

**Tests:** T-34.5-13, T-34.5-14, T-34.8-09.

### 3.4 Claim Types to BTP Wire Format (34.7 + BTP layer)

**Seam:** `MinaClaimMessage` serialized into BTP protocolData JSON (plaintext) or APPLICATION_OCTET_STREAM (NIP-59 wrapped), transmitted over WebSocket, deserialized by receiver, routed to Mina provider.

**Risk:** Missing discriminator, incorrect field names, or deserialization failure (R-10).

**Tests:** T-34.7-06 through T-34.7-12.

### 3.5 NIP-59 Wrapping to Claim Transport (34.6 + 34.7)

**Seam:** NIP-59 wrapper encrypts `MinaClaimMessage` into three-layer gift wrap. The BTP layer must recognize `protocolName: 'claim-wrapped'` and the receiver must unwrap before verification.

**Risk:** Wrapping/unwrapping failure breaks claim delivery (R-11).

**Tests:** T-34.6-06 (round-trip), T-34.6-08/T-34.6-09 (config toggle), T-34.8-05 (E2E).

### 3.6 Three-Chain Provider Coexistence (34.5 + 34.7 + Epics 32/33)

**Seam:** All three providers (EVM, Solana, Mina) registered simultaneously. Per-peer `chain` field selects the correct provider. Claims must not cross-contaminate.

**Risk:** Mina claim routed to EVM or Solana provider, or vice versa (R-10). This is the first time three providers coexist and represents the highest integration risk.

**Tests:** T-34.8-06 (three-way mixed-chain), T-34.8-12 (EVM regression), T-34.8-13 (Solana regression).

### 3.7 Proof Latency to ILP Pipeline (34.2 + 34.4 + 34.5 + 34.8)

**Seam:** zk-SNARK proof generation (30--120s) runs in the settlement path. The ILP packet forwarding pipeline must continue processing packets while proofs are being generated.

**Risk:** Synchronous proof generation blocks the Node.js event loop (R-02). This cuts across all Mina-related layers.

**Tests:** T-34.4-10, T-34.4-11 (SDK async), T-34.5-08 (provider async), T-34.8-04 (E2E throughput check).

---

## 4. Regression Risks

All existing EVM and Solana settlement must keep working identically. The Mina provider is additive, but claim type changes (Story 34.7) touch shared code paths.

### Regression Test Suite

| ID       | Scenario                                                                         | Pre-Condition                                    | Assertion              | Story Gate |
| -------- | -------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------- | ---------- |
| T-REG-01 | `claim-receiver.test.ts` passes with Mina claim types added                      | Existing EVM + Solana tests plus new Mina tests  | All existing tests green | 34.7       |
| T-REG-02 | `claim-sender.test.ts` passes with Mina claim construction added                 | Existing EVM + Solana tests plus new Mina tests  | All existing tests green | 34.7       |
| T-REG-03 | `btp-claim-types.test.ts` EVM and Solana paths unchanged                         | `isEVMClaim()`, `isSolanaClaim()`, `validateClaimMessage()` | Identical behavior | 34.7 |
| T-REG-04 | EVM claim JSON serialization unchanged (fixture comparison)                      | Pre-epic fixture from Epic 32                    | Byte-for-byte match    | 34.7       |
| T-REG-05 | Solana claim JSON serialization unchanged (fixture comparison)                   | Pre-epic fixture from Epic 33                    | Byte-for-byte match    | 34.7       |
| T-REG-06 | `per-packet-claim-service.test.ts` passes (EVM + Solana paths unmodified)       | Existing test file                               | All tests green        | 34.7       |
| T-REG-07 | Multi-hop E2E test (existing, EVM-only) passes with Mina provider registered     | Full Anvil E2E from test-design-multihop         | All tests green        | 34.8       |
| T-REG-08 | Solana E2E test passes with Mina provider registered alongside                   | Solana integration tests from Epic 33            | All tests green        | 34.8       |

### Regression Strategy

1. **Before starting Story 34.7:** Verify all existing EVM and Solana claim-related tests pass. Capture baseline test results.
2. **Per-story gate:** Each story's PR must pass `npm test` (all unit tests including existing EVM and Solana tests) and `make solana-test` (Rust tests).
3. **Story 34.8 final gate:** Mixed-chain integration test explicitly verifies EVM and Solana settlement work alongside Mina.
4. **No modification to existing EVM/Solana test files:** New Mina tests are additive. Existing EVM and Solana test scenarios must not be removed or modified.

### Existing Test Files at Risk from Story 34.7 Changes

| Test File                          | Risk                                          | Adaptation                              |
| ---------------------------------- | --------------------------------------------- | --------------------------------------- |
| `btp-claim-types.test.ts`          | `BlockchainType` union extended to include `'mina'` | Add Mina tests, keep EVM + Solana tests |
| `claim-receiver.test.ts`           | New Mina dispatch path added                  | Add Mina scenarios, keep EVM + Solana   |
| `claim-sender.test.ts`             | New Mina construction path added              | Add Mina scenarios, keep EVM + Solana   |
| `per-packet-claim-service.test.ts` | May need Mina provider in mock registry       | Add Mina provider mock, keep existing   |

---

## 5. Test Data Requirements

### 5.1 Mina Test Accounts

```typescript
// Standard test accounts (o1js LocalBlockchain provides funded accounts)
const TEST_PARTICIPANT_A = localBlockchain.testAccounts[0]; // { publicKey, privateKey }
const TEST_PARTICIPANT_B = localBlockchain.testAccounts[1];
const TEST_DEPLOYER = localBlockchain.testAccounts[2];
```

### 5.2 Poseidon Commitment Golden Vectors

```typescript
// Golden test vectors for cross-layer consistency (zkApp + SDK + provider)
const GOLDEN_COMMITMENT = {
  balanceA: Field(500000),
  balanceB: Field(500000),
  salt: Field(12345),
  expectedCommitment: '...', // Poseidon(500000, 500000, 12345) computed once and frozen
};

const GOLDEN_CHANNEL_HASH = {
  participantA: '...', // PublicKey base58
  participantB: '...', // PublicKey base58
  nonce: Field(1),
  expectedHash: '...', // Poseidon(participantA, participantB, 1) computed once and frozen
};
```

Store in `packages/mina-zkapp/src/__fixtures__/mina-golden-vectors.json` and `packages/connector/src/settlement/providers/mina/__fixtures__/mina-golden-vectors.json` (duplicated intentionally -- each layer validates independently).

### 5.3 Mock Mina Provider

```typescript
const createMockMinaProvider = (): jest.Mocked<PaymentChannelProvider> => ({
  chainType: 'mina' as const,
  chainId: 'mina:devnet',
  openChannel: jest.fn().mockResolvedValue({
    channelId: 'B62q...zkAppAddress',
    txHash: 'CkpZ...txHash',
  }),
  deposit: jest.fn().mockResolvedValue({ txHash: 'CkpZ...txHash2' }),
  claimFromChannel: jest.fn().mockResolvedValue({ txHash: 'CkpZ...txHash3' }),
  closeChannel: jest.fn().mockResolvedValue({ txHash: 'CkpZ...txHash4' }),
  settleChannel: jest.fn().mockResolvedValue({ txHash: 'CkpZ...txHash5' }),
  signBalanceProof: jest.fn().mockResolvedValue('MockPoseidonCommitment...'),
  verifyBalanceProof: jest.fn().mockResolvedValue(true),
  getChannelState: jest.fn().mockResolvedValue({
    channelId: 'B62q...zkAppAddress',
    status: 'opened',
    participants: ['B62q...participantA', 'B62q...participantB'],
    deposit: 1000000n,
  }),
  subscribeToEvents: jest.fn().mockReturnValue({
    unsubscribe: jest.fn(),
    on: jest.fn(),
  }),
});
```

### 5.4 Mina Claim Message Fixture

```json
{
  "version": "1.0",
  "blockchain": "mina",
  "channelHash": "...",
  "nonce": 42,
  "balanceCommitment": "...",
  "proof": "<base64-encoded zk-SNARK proof>",
  "zkAppAddress": "B62q...",
  "tokenId": "...",
  "network": "devnet",
  "salt": "..."
}
```

### 5.5 Configuration Fixtures

**Mina provider config:**

```yaml
chainProviders:
  - chainType: mina
    chainId: 'mina:devnet'
    graphqlUrl: 'http://localhost:3085/graphql'
    archiveUrl: 'http://localhost:8282'
    zkAppAddress: 'B62q...'
    tokenId: '...'
    keypairPath: './test-mina-keypair.json'
```

**Three-chain config (EVM + Solana + Mina):**

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
  - chainType: mina
    chainId: 'mina:devnet'
    graphqlUrl: 'http://localhost:3085/graphql'
    zkAppAddress: 'B62q...'
peers:
  - id: evm-peer
    chain: 'evm:31337'
    evmAddress: '0xPeerB...'
  - id: solana-peer
    chain: 'solana:devnet'
    solanaPubkey: 'PeerPubkeyBase58...'
  - id: mina-peer
    chain: 'mina:devnet'
    minaPublicKey: 'B62q...'
```

### 5.6 Test Data Constants

```typescript
// Mina test chain IDs
const TEST_MINA_CHAIN_ID = 'mina:devnet';
const TEST_MINA_CHAIN_ID_MAINNET = 'mina:mainnet';

// Mina test amounts (Field-compatible)
const TEST_DEPOSIT_AMOUNT = 1000000n;
const TEST_TRANSFER_AMOUNT = 500000n;
const TEST_CLAIM_NONCE_START = 1;

// Challenge period (slots)
const TEST_SETTLEMENT_TIMEOUT = 30; // 30 slots (~90 minutes on mainnet)
const TEST_SETTLEMENT_TIMEOUT_SHORT = 2; // 2 slots for timeout tests

// Proof generation timeout
const TEST_PROOF_TIMEOUT_MS = 300000; // 5 minutes for proof-enabled tests
```

### 5.7 Mock Factory Additions

Add to existing `packages/connector/src/test-utils/mock-factories.ts`:

```typescript
export function createMockMinaPaymentChannelProvider(
  overrides?: Partial<PaymentChannelProvider>
): jest.Mocked<PaymentChannelProvider>;

export function createMockMinaPaymentChannelSDK(
  overrides?: Partial<MinaPaymentChannelSDK>
): jest.Mocked<MinaPaymentChannelSDK>;

export function createMockNIP59Wrapper(
  overrides?: Partial<NIP59TransportWrapper>
): jest.Mocked<NIP59TransportWrapper>;
```

---

## 6. Test Execution Strategy

### 6.1 Story Execution Order (follows dependency graph)

```
Phase 1: 34.1 (zkApp lifecycle) — o1js tests, proofsEnabled: false
Phase 2: 34.2 (zkApp claims) — o1js tests, proofsEnabled: false + proof-enabled
Phase 3: 34.3 (zkApp comprehensive + deployment) — integration + proof-enabled, depends on 34.1+34.2
Phase 4: 34.4 (TypeScript SDK) — TS unit + o1js integration, depends on 34.1+34.2+34.3
Phase 5: 34.5 (Provider adapter) — TS unit tests, depends on 34.4
Phase 6: 34.6, 34.7 (parallel) — NIP-59 wrapping + claim types, depends on 34.5
Phase 7: 34.8 (Integration E2E) — full integration, depends on all above
Phase 8: 34.9 (Deployment + docs) — manual/CI, depends on all above
```

### 6.2 CI Pipeline Configuration

**Every PR (fast, < 2 minutes):**
- `npm run lint` (ESLint + Prettier)
- `npm run typecheck` (tsc --noEmit)
- `npm test` (all unit tests)
- zkApp tests with `proofsEnabled: false`

**Merge to main (slow, 10--15 minutes):**
- All of the above, plus:
- zkApp tests with `proofsEnabled: true` (30--120s per transaction)
- Integration tests against o1js LocalBlockchain

**Nightly (full, 30--60 minutes):**
- All of the above, plus:
- Docker-based lightnet E2E tests (`make mina-up`)
- Three-way mixed-chain integration (Anvil + solana-bankrun + o1js)
- Performance benchmarking (proof generation times)

### 6.3 CI Gate per Story PR

Each story PR must pass:

1. `npm run lint` (ESLint + Prettier)
2. `npm run typecheck` (tsc --noEmit)
3. `npm test` (all unit tests, including unmodified existing EVM + Solana tests)
4. Story-specific regression tests identified in section 4

### 6.4 Coverage Targets

Per project conventions:

- Branches: 60%
- Functions: 75%
- Lines: 70%
- Statements: 70%

New files in `settlement/providers/mina/` and `mina-zkapp/src/` should aim for:

- Lines: 85%+ (new code should have higher coverage)
- Branches: 75%+

### 6.5 Test Timeout Configuration

- Unit tests (proofsEnabled: false): 30s default
- Integration tests (proofsEnabled: false): 60s
- Proof-enabled tests (proofsEnabled: true): 300s (5 minutes)
- Lightnet E2E tests: 600s (10 minutes, accounts for block production)
- No Docker-based lightnet in standard CI -- merge/nightly only

---

## 7. Traceability Matrix

| Story | Acceptance Criteria                      | Test IDs                            | Risk IDs        |
| ----- | ---------------------------------------- | ----------------------------------- | --------------- |
| 34.1  | Channel lifecycle state transitions      | T-34.1-01 through T-34.1-06        | R-05, R-06      |
| 34.1  | 8-field on-chain state correct           | T-34.1-01, T-34.1-07               | R-05            |
| 34.1  | Challenge period enforced                | T-34.1-04, T-34.1-06               | R-09            |
| 34.1  | Balance commitment verified on close     | T-34.1-08                           | R-03            |
| 34.2  | Valid claim updates commitment + nonce   | T-34.2-01                           | R-01, R-03      |
| 34.2  | Invalid proofs rejected (5 invariants)   | T-34.2-02 through T-34.2-06        | R-01            |
| 34.2  | Privacy: balances not visible on-chain   | T-34.2-07                           | R-07            |
| 34.2  | Channel stays open after claim           | T-34.2-08                           | R-01            |
| 34.3  | Circuit compiles deterministically       | T-34.3-01                           | R-08            |
| 34.3  | Full lifecycle with proofs               | T-34.3-02, T-34.3-09               | R-01, R-06      |
| 34.3  | Balance conservation                     | T-34.3-03                           | R-06            |
| 34.3  | Privacy over multiple claims             | T-34.3-05                           | R-07            |
| 34.3  | Tampered proof rejected                  | T-34.3-11                           | R-01            |
| 34.4  | SDK compiles and wraps zkApp             | T-34.4-01, T-34.4-02               | R-08            |
| 34.4  | Poseidon commitment matches golden       | T-34.4-03, T-34.4-12               | R-03            |
| 34.4  | SDK claim accepted on-chain              | T-34.4-04, T-34.4-05               | R-03            |
| 34.4  | Async proof generation                   | T-34.4-10, T-34.4-11               | R-02            |
| 34.5  | Implements PaymentChannelProvider        | T-34.5-01                           | R-04            |
| 34.5  | Delegates to SDK correctly               | T-34.5-03 through T-34.5-06        | R-02            |
| 34.5  | Async non-blocking proofs                | T-34.5-08                           | R-02            |
| 34.5  | Registry integration                     | T-34.5-13, T-34.5-14               | R-10            |
| 34.5  | Error mapping                            | T-34.5-17                           | R-12            |
| 34.6  | Three-layer wrapping                     | T-34.6-01 through T-34.6-04        | R-11            |
| 34.6  | Round-trip correctness                   | T-34.6-06                           | R-11            |
| 34.6  | Config toggle (enabled/disabled)         | T-34.6-08, T-34.6-09               | R-11            |
| 34.6  | Ephemeral key freshness                  | T-34.6-05                           | R-16            |
| 34.7  | BlockchainType extended to 'mina'        | T-34.7-01                           | R-04, R-10      |
| 34.7  | Existing type guards still work          | T-34.7-04, T-34.7-05               | R-04            |
| 34.7  | Serialization round-trip                 | T-34.7-06, T-34.7-07               | R-10            |
| 34.7  | EVM/Solana backward compat               | T-34.7-08, T-34.7-09, T-34.7-12    | R-04            |
| 34.7  | Zod validation                           | T-34.7-10, T-34.7-14, T-34.7-15    | R-10            |
| 34.8  | Full lifecycle E2E                       | T-34.8-01, T-34.8-15               | R-01, R-02, R-03|
| 34.8  | Multi-peer settlement                    | T-34.8-02                           | R-02            |
| 34.8  | Privacy verification                     | T-34.8-03                           | R-07            |
| 34.8  | Proof latency non-blocking               | T-34.8-04                           | R-02            |
| 34.8  | Three-way mixed-chain                    | T-34.8-06                           | R-10            |
| 34.8  | EVM + Solana regression                  | T-34.8-12, T-34.8-13               | R-04            |
| 34.8  | No direct SDK imports                    | T-34.8-11                           | R-04            |
| 34.9  | Devnet deployment                        | T-34.9-01, T-34.9-02               | R-15            |
| 34.9  | Upgrade authority                        | T-34.9-03                           | R-15            |
| 34.9  | Config loads and validates               | T-34.9-04                           | R-08            |

---

## 8. Open Questions

1. **o1js version pinning:** Which o1js version to target? The API has changed significantly between releases. The test suite should lock the version and include a compilation gate (T-34.3-01) to detect breaking changes.

2. **Proof-enabled test CI timing:** With 30--120s per proof generation, a full lifecycle test (open + deposit + claim + close + settle = 5 proofs) could take 10 minutes. Should proof-enabled tests run on merge only, or also on nightly? Current plan: merge + nightly.

3. **Archive node in test infrastructure:** The lightnet Docker image includes an archive node. Should integration tests use the archive node directly, or should SDK tests mock archive responses? Current plan: mock for unit/integration, real archive for lightnet E2E only.

4. **NIP-59 scope:** Story 34.6 describes NIP-59 wrapping as optional and Mina-specific. Should the wrapper be chain-agnostic (usable for EVM/Solana claims too)? The test plan assumes Mina-only initially but notes the wrapper interface should be generic.

5. **Proof caching:** Should generated proofs be cached to disk for recovery after crashes? If yes, this adds test scenarios for cache invalidation and stale proof detection. Current plan: defer to future story.

6. **Three-chain mixed test infrastructure:** The mixed-chain test (T-34.8-06) requires Anvil + solana-bankrun + o1js LocalBlockchain simultaneously. Verify this does not cause memory pressure in CI. Solana-bankrun runs in-process; o1js LocalBlockchain runs in-process; only Anvil is external (Docker).
