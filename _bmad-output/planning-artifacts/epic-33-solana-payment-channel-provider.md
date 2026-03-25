# Epic 33: Solana Payment Channel Provider

**Status:** Proposed
**Dependency:** Epic 32 (Chain-Abstraction Layer / `PaymentChannelProvider` interface)
**Date:** 2026-03-24

---

## Epic Goal

Implement a complete Solana payment channel system — an on-chain Rust program and TypeScript SDK — that implements the `PaymentChannelProvider` interface from Epic 32, enabling ILP settlement over Solana with per-packet Ed25519-signed balance proofs. This is greenfield work: no production-ready payment channel programs exist on Solana today.

## Epic Description

### Existing System Context

- **Current functionality:** The connector settles on EVM (Base L2) via Raiden-style payment channels. Epic 31 added self-describing BTP claims with chain/contract coordinates. Epic 32 (dependency) extracts a chain-agnostic `PaymentChannelProvider` interface and `SettlementMonitor` abstraction from the existing EVM-specific settlement code.
- **Technology stack:** TypeScript 5.3.3, Node.js 22+, Rust (for on-chain program), `@solana/kit`, `tweetnacl` (Ed25519), ethers ^6.16.0 (EVM side), Jest 29.7.x
- **Integration points:**
  - `PaymentChannelProvider` interface (Epic 32) — the contract this epic implements
  - `BaseClaimMessage` / `BlockchainType` in `packages/connector/src/btp/btp-claim-types.ts` — extended with Solana variant
  - `SettlementMonitor` in `packages/connector/src/settlement/settlement-monitor.ts` — event emission target
  - `ClaimReceiver` / `ClaimSender` in `packages/connector/src/settlement/` — consume/produce claims
  - BTP protocolData wire format (`payment-channel-claim` protocol name)

### Enhancement Details

- **What's being added:**
  1. A Solana on-chain program (Pinocchio or native Rust, ~30-60KB binary) implementing payment channel lifecycle: open, deposit, claim, close, settle
  2. A `SolanaPaymentChannelSDK` TypeScript class wrapping program instructions via `@solana/kit`
  3. A `SolanaPaymentChannelProvider` implementing the `PaymentChannelProvider` interface from Epic 32
  4. `SolanaClaimMessage` type extending `BaseClaimMessage` with Solana-specific self-describing fields
  5. Integration and E2E tests using `solana-program-test` / Bankrun and local validator

- **How it integrates:** The `SolanaPaymentChannelProvider` plugs into the chain-abstraction layer from Epic 32. Peers advertising Solana settlement via ILP Peer Info (kind:10032) will have claims routed through this provider. The existing EVM provider continues to work unchanged. A `blockchain: 'solana'` discriminator in `BTPClaimMessage` selects the correct serialization path.

- **Key technical decisions:**
  - **Ed25519 signature verification** via Solana's native Ed25519 precompile (2,280 CU per verification) — no custom crypto needed on-chain
  - **Channel state stored in PDAs** keyed by `[b"channel", participant_a, participant_b, token_mint]` — deterministic, no account tracking needed off-chain
  - **SPL Token escrow** into a program-owned vault PDA for deposits
  - **Account subscriptions** (`onAccountChange`) for event-driven settlement monitoring, replacing EVM's event log approach
  - **Cooperative settlement pattern**: channel stays open after claims; close initiates a challenge period via `Clock` sysvar
  - **Solana Alpenglow upgrade** (mid-2026) will drop finality to ~150ms, further improving settlement latency
  - **Deployment cost:** ~$19-38 in refundable rent-exempt SOL at ~$89.67/SOL (March 2026)

### Success Criteria

- Solana payment channel program deployed to devnet with full lifecycle working
- `SolanaPaymentChannelProvider` passes the `PaymentChannelProvider` interface compliance tests from Epic 32
- Multi-peer integration test with per-packet Solana claim generation and verification
- Mixed-chain test: one peer settling on EVM, another on Solana, both working simultaneously
- Existing EVM settlement unaffected (no regression)

---

## Stories

### Story 33.1: Solana Payment Channel Program — Channel Lifecycle

As a connector operator,
I want an on-chain Solana program that manages payment channel lifecycle,
So that peers can open, fund, and close payment channels for ILP settlement on Solana.

**Scope:**

Write the on-chain program in Rust (Pinocchio or native — no Anchor dependency to minimize binary size).

**Instructions:**

| Instruction           | Description                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `initialize_channel`  | Create channel PDA, set participants and token mint, state = `Opened`                                   |
| `deposit`             | SPL Token transfer from participant to program-owned vault PDA, update deposit tracking                 |
| `close_channel`       | Set state to `Closed`, record challenge deadline via `Clock` sysvar                                     |
| `settle_channel`      | Distribute funds from vault after challenge timeout, state = `Settled`, close accounts and reclaim rent |
| `force_close_expired` | Allow either participant to settle after challenge deadline if counterparty is unresponsive             |

**Channel state account layout:**

- `participant_a: Pubkey` (32 bytes)
- `participant_b: Pubkey` (32 bytes)
- `token_mint: Pubkey` (32 bytes)
- `deposit_a: u64`
- `deposit_b: u64`
- `transferred_amount_a: u64` (cumulative A→B)
- `transferred_amount_b: u64` (cumulative B→A)
- `nonce_a: u64` (latest nonce from A)
- `nonce_b: u64` (latest nonce from B)
- `state: u8` (0=Opened, 1=Closed, 2=Settled)
- `close_timestamp: i64`
- `challenge_duration: u64` (seconds)
- `bump: u8` (PDA bump seed)

**PDA derivation:** seeds = `[b"channel", participant_a, participant_b, token_mint]`
(participants sorted lexicographically by pubkey to ensure deterministic derivation regardless of who opens)

**Acceptance Criteria:**

**Given** two Solana keypairs and an SPL token mint
**When** `initialize_channel` is called with both participants and the token mint
**Then** a channel PDA is created with state `Opened`, zero balances, and the correct participants and mint stored

**Given** an open channel with participant A
**When** participant A calls `deposit` with 1000 tokens
**Then** 1000 tokens are transferred from A's token account to the vault PDA and `deposit_a` is incremented by 1000

**Given** an open channel
**When** either participant calls `close_channel`
**Then** channel state becomes `Closed` and `close_timestamp` is set to current `Clock` sysvar time

**Given** a closed channel where `Clock.unix_timestamp >= close_timestamp + challenge_duration`
**When** `settle_channel` is called
**Then** funds are distributed according to cumulative transferred amounts, remaining accounts are closed, and rent is reclaimed

**Given** a closed channel where the challenge period has not elapsed
**When** `settle_channel` is called
**Then** the instruction fails with `ChannelChallengeNotExpired` error

**Given** a closed channel past the challenge deadline
**When** `force_close_expired` is called by either participant
**Then** funds are distributed and accounts are closed, same as `settle_channel`

---

### Story 33.2: Solana Payment Channel Program — Claim Verification

As a connector operator,
I want the on-chain program to verify Ed25519-signed balance proofs,
So that peers can submit claims that update the channel's cumulative transferred amounts.

**Scope:**

Add the `claim_from_channel` instruction that verifies Ed25519 signatures via Solana's native precompile and updates the channel state.

**Balance proof format (signed message):**

```
channel_pda (32 bytes) || nonce (8 bytes LE) || transferred_amount (8 bytes LE)
```

Signed by the sender's Ed25519 keypair. Signature verified by introspecting the Ed25519 precompile instruction in the same transaction.

**Instruction: `claim_from_channel`**

1. Verify the Ed25519 signature via precompile introspection (check `Instructions` sysvar for Ed25519 program instruction at expected index)
2. Verify the signer is a channel participant
3. Verify nonce is strictly greater than the stored nonce for that participant (monotonic enforcement)
4. Verify transferred_amount is greater than or equal to the current stored value (cumulative, non-decreasing)
5. Update `transferred_amount` and `nonce` for the claiming participant
6. Channel stays in `Opened` state (cooperative pattern)

**Acceptance Criteria:**

**Given** an open channel between A and B with nonce_a = 5
**When** a valid claim is submitted with A's signature, nonce = 6, transferred_amount = 5000
**Then** the channel's `nonce_a` is updated to 6 and `transferred_amount_a` is updated to 5000

**Given** an open channel between A and B with nonce_a = 5
**When** a claim is submitted with nonce = 5 (replay)
**Then** the instruction fails with `NonceNotMonotonic` error

**Given** an open channel between A and B with nonce_a = 5
**When** a claim is submitted with nonce = 4 (stale)
**Then** the instruction fails with `NonceNotMonotonic` error

**Given** an open channel
**When** a claim is submitted with an invalid Ed25519 signature
**Then** the instruction fails with `InvalidSignature` error

**Given** an open channel between A and B
**When** a claim is submitted signed by keypair C (not a participant)
**Then** the instruction fails with `UnauthorizedSigner` error

**Given** an open channel with transferred_amount_a = 5000
**When** a valid claim is submitted with transferred_amount = 4000 (decrease)
**Then** the instruction fails with `TransferredAmountDecreased` error

**Given** a closed channel
**When** a claim is submitted
**Then** the claim is accepted (claims can still be submitted during the challenge period to update final balances)

---

### Story 33.3: Solana Payment Channel Program — Tests & Deployment

As a developer,
I want comprehensive tests and deployment scripts for the Solana program,
So that the program is verified correct and deployable to devnet/mainnet.

**Scope:**

| Area                      | Details                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Test framework            | `solana-program-test` or Bankrun for local program testing                                                                                    |
| Unit tests                | All instructions: `initialize_channel`, `deposit`, `close_channel`, `settle_channel`, `force_close_expired`, `claim_from_channel`             |
| Edge case tests           | Double-init, deposit to closed channel, claim with wrong participant, settle before timeout, overflow checks, zero-amount deposits            |
| Security tests            | Invalid signature, nonce replay, nonce regression, transferred_amount decrease, unauthorized signer, PDA derivation with swapped participants |
| Deployment                | Script targeting devnet and mainnet-beta, with configurable upgrade authority                                                                 |
| Program upgrade authority | Multi-sig or designated authority pubkey, documented process for upgrades                                                                     |

**Acceptance Criteria:**

**Given** the complete on-chain program
**When** the test suite is run via `cargo test-sbf` or equivalent
**Then** all lifecycle tests pass: open → deposit → claim → close → settle

**Given** the test suite
**When** invalid signature, replayed nonce, and unauthorized signer tests are run
**Then** all security edge cases are caught with appropriate error codes

**Given** the deployment script targeting devnet
**When** the script is executed with a funded deployer keypair
**Then** the program is deployed to devnet and the program ID is recorded

**Given** a deployed program
**When** the upgrade authority configuration is reviewed
**Then** the authority is set to the designated keypair (not the deployer default) and the process for upgrading is documented

**Given** the test suite
**When** PDA derivation tests run with participants (A, B) and (B, A)
**Then** both orderings produce the same PDA (lexicographic sorting verified)

---

### Story 33.4: SolanaPaymentChannelSDK — TypeScript Integration

As a connector developer,
I want a TypeScript SDK that wraps the Solana program instructions,
So that the connector can interact with payment channels programmatically.

**Scope:**

Create `SolanaPaymentChannelSDK` class in `packages/connector/src/settlement/solana-payment-channel-sdk.ts` using `@solana/kit`.

**Methods:**

| Method                                                                  | Description                                                                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `openChannel(participantA, participantB, tokenMint, challengeDuration)` | Build and send `initialize_channel` transaction                                     |
| `deposit(channelPDA, amount, depositor)`                                | Build and send `deposit` transaction (SPL token transfer to vault)                  |
| `claimFromChannel(channelPDA, nonce, transferredAmount, signature)`     | Build and send `claim_from_channel` transaction with Ed25519 precompile instruction |
| `closeChannel(channelPDA, closer)`                                      | Build and send `close_channel` transaction                                          |
| `settleChannel(channelPDA)`                                             | Build and send `settle_channel` transaction                                         |
| `getChannelState(channelPDA)`                                           | Fetch and deserialize channel account data                                          |
| `deriveChannelPDA(participantA, participantB, tokenMint)`               | Derive PDA address (static utility)                                                 |
| `subscribeToChannel(channelPDA, callback)`                              | Subscribe to account changes via `onAccountChange`                                  |
| `signBalanceProof(channelPDA, nonce, transferredAmount, keypair)`       | Sign the balance proof message using Ed25519 (`tweetnacl` or `@solana/kit`)         |

**Acceptance Criteria:**

**Given** a configured `SolanaPaymentChannelSDK` with an RPC endpoint and program ID
**When** `openChannel()` is called with valid parameters
**Then** a transaction is built, signed, and submitted that creates the channel PDA on-chain

**Given** an open channel PDA
**When** `deposit()` is called with an amount and depositor keypair
**Then** SPL tokens are transferred to the vault and the transaction confirmation is returned

**Given** a channel PDA and keypair
**When** `signBalanceProof()` is called with nonce and transferred amount
**Then** an Ed25519 signature is produced over the canonical message format `(channel_pda || nonce || transferred_amount)`

**Given** a signed balance proof
**When** `claimFromChannel()` is called
**Then** the transaction includes both the Ed25519 precompile instruction and the `claim_from_channel` instruction, and the transaction succeeds

**Given** a channel PDA
**When** `subscribeToChannel()` is called with a callback
**Then** the callback fires whenever the channel account data changes on-chain

**Given** any two pubkeys (A, B) in any order
**When** `deriveChannelPDA()` is called
**Then** the same PDA is returned regardless of argument order (lexicographic sorting)

---

### Story 33.5: Implement SolanaPaymentChannelProvider

As a connector operator,
I want a Solana implementation of the `PaymentChannelProvider` interface,
So that the connector can settle with peers over Solana using the chain-abstraction layer from Epic 32.

**Scope:**

Create `SolanaPaymentChannelProvider` in `packages/connector/src/settlement/solana-payment-channel-provider.ts` implementing the `PaymentChannelProvider` interface from Epic 32.

**Responsibilities:**

- Wrap `SolanaPaymentChannelSDK` methods to satisfy the provider interface
- Translate between provider-level abstractions and Solana-specific SDK calls
- Define `SolanaClaimMessage` type with self-describing fields (`programId`, `tokenMint`, `channelPDA`, `chainId`)
- Emit events compatible with `SettlementMonitor` expectations (channel state changes, claim confirmations)
- Use `onAccountChange` subscriptions to detect on-chain state changes and translate them to provider events
- Handle Solana-specific error mapping (program errors → provider error types)

**Acceptance Criteria:**

**Given** the `PaymentChannelProvider` interface from Epic 32
**When** `SolanaPaymentChannelProvider` is instantiated with Solana RPC config and program ID
**Then** all interface methods are implemented and type-check correctly

**Given** a `SolanaPaymentChannelProvider` instance
**When** `openChannel()` is called via the provider interface
**Then** the call is delegated to `SolanaPaymentChannelSDK.openChannel()` and the result is returned in the provider's canonical format

**Given** a `SolanaPaymentChannelProvider` with an active channel subscription
**When** the channel account data changes on-chain (e.g., a claim is submitted)
**Then** the provider emits a state-change event compatible with `SettlementMonitor`

**Given** a Solana program error (e.g., `NonceNotMonotonic`)
**When** the error propagates through the provider
**Then** it is mapped to the corresponding provider-level error type defined in Epic 32

**Given** a `SolanaPaymentChannelProvider` instance
**When** `generateClaim()` is called for a channel
**Then** a `SolanaClaimMessage` is produced with all self-describing fields populated (`programId`, `tokenMint`, `channelPDA`, `chainId`)

---

### Story 33.6: Solana Claim Message Types & Serialization

As a connector developer,
I want Solana-specific claim message types with proper serialization,
So that Solana balance proofs can be exchanged over BTP alongside existing EVM claims.

**Scope:**

| File                                                  | Change                                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `packages/connector/src/btp/btp-claim-types.ts`       | Add `'solana'` to `BlockchainType` union. Define `SolanaClaimMessage` extending `BaseClaimMessage`. Update validation functions. |
| `packages/connector/src/settlement/claim-sender.ts`   | Add Solana claim construction path (gated by `blockchain` discriminator)                                                         |
| `packages/connector/src/settlement/claim-receiver.ts` | Add Solana claim verification path (Ed25519 signature check, PDA validation)                                                     |

**`SolanaClaimMessage` fields:**

```typescript
interface SolanaClaimMessage extends BaseClaimMessage {
  blockchain: 'solana';
  programId: string; // Base58 Solana program ID
  tokenMint: string; // Base58 SPL token mint address
  channelPDA: string; // Base58 channel PDA address
  chainId: string; // 'mainnet-beta' | 'devnet' | 'testnet'
  nonce: number; // Monotonically increasing
  transferredAmount: string; // Cumulative, string for bigint precision
  signature: string; // Base64-encoded Ed25519 signature
  signerAddress: string; // Base58 signer public key
}
```

**Acceptance Criteria:**

**Given** the `BlockchainType` union in `btp-claim-types.ts`
**When** `'solana'` is added
**Then** all existing EVM claim paths continue to work unchanged (discriminated union)

**Given** a `SolanaClaimMessage` object
**When** it is serialized to BTP protocolData JSON
**Then** the `blockchain: 'solana'` discriminator is present and all fields are correctly encoded

**Given** a BTP protocolData payload with `blockchain: 'solana'`
**When** it is deserialized by `ClaimReceiver`
**Then** it is parsed into a `SolanaClaimMessage` and routed to the Solana verification path

**Given** a BTP protocolData payload with `blockchain: 'evm'`
**When** it is deserialized by `ClaimReceiver`
**Then** it continues to be parsed as `EVMClaimMessage` with no change in behavior (backward compat)

**Given** a `SolanaClaimMessage` with all self-describing fields
**When** the claim is verified by the receiver
**Then** the `programId`, `channelPDA`, and `tokenMint` are validated against the on-chain state (or cached metadata)

**Given** a `SolanaClaimMessage` with a tampered `programId`
**When** verification is attempted
**Then** it fails because the PDA derivation from participants + tokenMint does not match the provided `channelPDA` for the given `programId`

---

### Story 33.7: Integration Tests — Solana Provider E2E

As a developer,
I want end-to-end integration tests for the Solana settlement flow,
So that the full lifecycle is verified from channel open through claim settlement.

**Scope:**

Integration tests using local Solana infrastructure (see Architecture doc → Local Blockchain Infrastructure → Solana Test Validator). Use `solana-bankrun` for fast in-process TS integration tests and Docker-based `solana-test-validator` (`make solana-up`) for E2E tests requiring real RPC, account subscriptions, and deployed programs. Rust-level tests use `solana-program-test` BanksClient (`cargo test-sbf`). Docker image: `ghcr.io/beeman/solana-test-validator:latest` (multi-arch amd64 + arm64).

**Test Scenarios:**

1. **Full lifecycle:** Channel open → deposit → per-packet claim generation → claim verification → threshold-triggered settlement → channel close → settle → rent reclaimed
2. **Multi-peer Solana:** Three peers all settling on Solana, forwarding ILP packets through the connector, each generating per-packet claims
3. **Claim accumulation:** Multiple claims with increasing nonces, verify cumulative transferred amounts are tracked correctly
4. **Mixed-chain:** Peer A settles on EVM (Base L2), Peer B settles on Solana — both connected to the same connector, ILP packets forwarded between them
5. **Account subscription:** Verify that `onAccountChange` subscription fires when claims are submitted on-chain, and `SettlementMonitor` receives the events
6. **Error handling:** Invalid signatures, stale nonces, wrong program ID — all rejected with appropriate errors

**Acceptance Criteria:**

**Given** a local Solana validator with the payment channel program deployed
**When** the full lifecycle test is run (open → deposit → claim → close → settle)
**Then** all steps complete successfully and final balances reflect cumulative transferred amounts

**Given** a connector with two peers — one configured for EVM, one for Solana
**When** ILP packets are forwarded between them
**Then** EVM claims are generated for the EVM peer and Solana claims for the Solana peer, with no cross-contamination

**Given** multiple claims submitted with increasing nonces
**When** the channel state is queried after each claim
**Then** the cumulative transferred amount and nonce are monotonically increasing

**Given** an active channel subscription
**When** a claim transaction lands on-chain
**Then** the `SettlementMonitor` receives a state-change event within the subscription callback

**Given** a claim with an invalid Ed25519 signature
**When** it is submitted through the provider
**Then** the transaction fails and the error is surfaced as a provider-level `InvalidSignature` error

---

### Story 33.8: Solana Devnet Deployment & Documentation

As a connector operator,
I want the Solana program deployed to devnet with configuration documentation,
So that I can run the Solana settlement provider in a test environment.

**Scope:**

| Deliverable           | Details                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Devnet deployment     | Program deployed to Solana devnet with verified program ID                                                                    |
| Configuration example | YAML config snippet for `SolanaPaymentChannelProvider` (RPC endpoint, program ID, token mint, keypair path)                   |
| Operational docs      | Deposit management (funding vault), program upgrades (authority transfer), monitoring (account subscriptions), rent economics |
| Upgrade runbook       | Step-by-step for deploying program upgrades, authority management, rollback                                                   |
| Monitoring guide      | How to monitor channel health via RPC and account subscriptions, alerting on stuck channels                                   |

**Acceptance Criteria:**

**Given** a funded Solana devnet deployer keypair
**When** the deployment script is executed
**Then** the program is deployed to devnet and the program ID is recorded in the project configuration

**Given** a new connector operator
**When** they read the configuration documentation
**Then** they can configure `SolanaPaymentChannelProvider` in their connector YAML with RPC endpoint, program ID, token mint, and keypair

**Given** a deployed devnet program
**When** the operator follows the deposit management guide
**Then** they can fund a channel vault and verify the deposit on-chain

**Given** a program upgrade is needed
**When** the operator follows the upgrade runbook
**Then** the program is upgraded on devnet with the new binary and the upgrade authority is correctly managed

**Given** the monitoring documentation
**When** the operator sets up monitoring
**Then** they can observe channel state changes and detect stuck channels (e.g., closed but not settled past challenge period)

---

## Deferred Items

- **Mainnet deployment:** Devnet only for this epic. Mainnet deployment will follow after testnet validation period.
- **Multi-sig upgrade authority:** Initial deployment uses single-keypair authority. Multi-sig (e.g., Squads) can be added later.
- **Alpenglow optimizations:** Solana's Alpenglow upgrade (mid-2026, ~150ms finality) may enable further latency optimizations for claim confirmation — deferred until after upgrade ships.
- **Token-2022 support:** Initial implementation targets standard SPL Token. Token-2022 (token extensions) support is deferred.

---

## Compatibility Requirements

- [x] Existing EVM settlement paths remain unchanged (discriminated union on `blockchain` field)
- [x] `BaseClaimMessage` interface is extended, not modified
- [x] BTP protocolData wire format remains backward compatible (new `blockchain: 'solana'` variant added alongside existing `'evm'`)
- [x] `PaymentChannelProvider` interface from Epic 32 is implemented without modification
- [x] Existing connector YAML configuration works unchanged (Solana provider is additive)
- [x] No changes to ILP packet format or routing protocol
- [x] Pre-registered EVM channels (Admin API) continue working

## Risk Mitigation

| Risk                                                                                                            | Likelihood | Impact | Mitigation                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **No existing Solana payment channel reference** — greenfield development increases risk of design errors       | Medium     | High   | Comprehensive test suite (Story 33.3), formal verification of critical paths (nonce monotonicity, balance conservation), staged rollout (devnet first)                   |
| **Ed25519 precompile introspection complexity** — verifying signatures via `Instructions` sysvar is non-trivial | Medium     | Medium | Isolate precompile interaction in a dedicated module with thorough unit tests. Reference Solana's Ed25519 program documentation and existing examples (e.g., Serum)      |
| **Solana RPC reliability** — account subscriptions may drop or lag                                              | Medium     | Medium | Implement reconnection logic in SDK subscription handler. Use confirmed commitment level. Add periodic polling fallback for critical state checks                        |
| **Compute unit limits** — complex instructions may exceed per-transaction CU budget                             | Low        | Medium | Profile CU usage in tests. Ed25519 verification is 2,280 CU which is well within the 200K default. Keep instructions lean by using Pinocchio/native (no Anchor overhead) |
| **Cross-chain claim confusion** — mixed EVM/Solana environment could route claims incorrectly                   | Low        | High   | Discriminated union on `blockchain` field ensures type-safe routing. Integration test (Story 33.7 scenario 4) explicitly tests mixed-chain correctness                   |

**Rollback Plan:** The Solana provider is purely additive. If issues arise, remove the Solana provider from configuration and all peers fall back to EVM settlement. No schema migrations or data format changes to undo. On-chain program remains deployed but unused.

## Definition of Done

- [ ] Solana payment channel program passes all unit and security tests (Stories 33.1-33.3)
- [ ] `SolanaPaymentChannelSDK` wraps all program instructions with TypeScript types (Story 33.4)
- [ ] `SolanaPaymentChannelProvider` implements `PaymentChannelProvider` interface and passes compliance tests (Story 33.5)
- [ ] `SolanaClaimMessage` type integrated into BTP claim exchange with backward compatibility (Story 33.6)
- [ ] All E2E integration tests pass including mixed-chain scenario (Story 33.7)
- [ ] Program deployed to Solana devnet with operational documentation (Story 33.8)
- [ ] Existing EVM settlement functionality verified — no regression
- [ ] All stories have acceptance criteria met
- [ ] CI pipeline includes Solana program build and test steps
