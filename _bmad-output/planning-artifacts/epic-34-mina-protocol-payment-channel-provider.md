# Epic 34: Mina Protocol Payment Channel Provider (ZK-Private Settlement)

**Date:** 2026-03-24
**Author:** Jonathan
**Status:** Draft
**Dependencies:** Epic 32 (Chain-Abstraction Layer)
**Type:** Brownfield — extends existing connector with new chain provider

---

## Executive Summary

Implement a Mina Protocol payment channel using zkApps and o1js that implements the `PaymentChannelProvider` interface from Epic 32, enabling ILP settlement over Mina with zero-knowledge private balance proofs. This is the **first payment channel implementation on Mina Protocol** and introduces privacy properties not available on EVM or Solana — transferred amounts are hidden on-chain via zk-SNARK commitments.

### Why Mina

- **Privacy-native settlement:** zk-SNARKs allow balance proofs where transferred amounts are never visible on-chain. EVM and Solana settlement exposes all balances publicly.
- **TypeScript-native smart contracts:** zkApps are written in TypeScript using o1js, aligning with the connector's existing stack.
- **Near-zero deployment cost:** MINA price ~$0.058 (March 2026) — deploying a zkApp costs ~$0.06.
- **Off-chain execution model:** Logic runs locally generating zk-SNARK proofs; only the proof is submitted on-chain. This maps naturally to the off-chain ILP claim model.

### Pioneering Work

There are **no existing payment channel implementations on Mina Protocol**. This epic is novel work with no prior art to reference. The design adapts Raiden-style payment channel patterns to Mina's unique constraint model (8-field on-chain state, Poseidon-friendly commitments, slot-based time conditions).

---

## Existing Architecture Context

The Town Connector currently settles on EVM (Base L2) via Raiden-style payment channels. Epic 32 introduces a `PaymentChannelProvider` chain-abstraction interface. Epic 33 adds Solana as the first non-EVM provider. This epic adds Mina as the second non-EVM provider, differentiated by its privacy properties.

### Integration Points

| Component                                    | Interaction                                                        |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `PaymentChannelProvider` interface (Epic 32) | Mina provider implements this interface                            |
| `PerPacketClaimService`                      | Generates Mina-format claims with zk proofs                        |
| `ClaimReceiver` / `ClaimSender`              | Exchange claims via BTP protocolData (plaintext or NIP-59 wrapped) |
| `SettlementExecutor`                         | Triggers on-chain settlement via Mina provider                     |
| `SettlementMonitor`                          | Monitors Mina account state for settlement events                  |
| `ChannelManager`                             | Manages Mina payment channel lifecycle                             |

---

## Mina Protocol Technical Constraints

| Constraint                                  | Impact                                           | Mitigation                                                                                     |
| ------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **8 on-chain state fields** (32 bytes each) | Cannot store full channel state on-chain         | Merkle tree for extended metadata; Poseidon hash commitments for compact state                 |
| **3-minute block times**                    | Settlement confirmation is slow                  | Off-chain claims provide instant finality between peers; on-chain settlement is batched        |
| **~45 minute probabilistic finality**       | Cannot rely on fast finality for disputes        | Use generous challenge periods (minimum 30 blocks / ~90 minutes)                               |
| **24 zkApp transactions per block**         | Throughput cap for on-chain operations           | Off-chain claim exchange is the primary settlement mechanism; on-chain settlement is rare      |
| **Proof generation latency**                | Generating zk-SNARK proofs takes 30-120 seconds  | Async proof generation; pre-compile circuits at startup; proof caching                         |
| **No existing payment channels**            | No reference implementations to validate against | Comprehensive test suite; formal verification of proof circuits; security audit before mainnet |

---

## Risk Assessment

| ID    | Risk                                                   | Likelihood | Impact | Severity | Mitigation                                                                                                      |
| ----- | ------------------------------------------------------ | ---------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------- |
| R-001 | **Proof generation latency blocks settlement**         | High       | High   | 9        | Async proof generation pipeline; pre-compiled circuits; settlement threshold tuning to batch operations         |
| R-002 | **8-field state limit insufficient for channel state** | Medium     | High   | 7        | Merkle tree-based extended state; Poseidon hash commitments compress multi-field data into single field         |
| R-003 | **No prior art for Mina payment channels**             | High       | Medium | 7        | Comprehensive test suite with local blockchain simulation; incremental development with early devnet deployment |
| R-004 | **o1js API instability**                               | Medium     | Medium | 6        | Pin o1js version; abstract behind SDK layer; integration tests catch breaking changes                           |
| R-005 | **Mina throughput cap (24 txns/block)**                | Low        | Medium | 4        | Off-chain claims are primary mechanism; on-chain settlement is rare and batched                                 |
| R-006 | **Archive node reliability for event retrieval**       | Medium     | Medium | 6        | Fallback to account state polling; retry logic with exponential backoff                                         |
| R-007 | **zk-SNARK proof circuit bugs**                        | Medium     | High   | 7        | Unit tests for every proof circuit path; test privacy properties explicitly; third-party audit                  |
| R-008 | **NIP-59 wrapping overhead**                           | Low        | Low    | 2        | Optional feature; plaintext claims supported as fallback                                                        |

---

## Stories

---

### Story 34.1: Mina Payment Channel zkApp — Channel Lifecycle

**Priority:** P0
**Estimate:** 5 points
**Dependencies:** Epic 32 `PaymentChannelProvider` interface defined

#### Description

Write the core payment channel zkApp using o1js TypeScript. This smart contract manages channel lifecycle (open, deposit, close, settle) with zk-SNARK proofs for state transitions. On-chain state is limited to 8 fields, so channel metadata is compressed into Poseidon hash commitments and extended via off-chain Merkle trees.

#### On-Chain State Fields

| Field               | Type    | Purpose                                                                   |
| ------------------- | ------- | ------------------------------------------------------------------------- |
| `channelHash`       | `Field` | `Poseidon(participantA, participantB, nonce)` — unique channel identifier |
| `balanceCommitment` | `Field` | `Poseidon(balance_a, balance_b, salt)` — hides actual balances            |
| `nonceField`        | `Field` | Monotonically increasing state nonce                                      |
| `channelState`      | `Field` | Enum: 0=UNINITIALIZED, 1=OPEN, 2=CLOSING, 3=SETTLED                       |
| `depositTotal`      | `Field` | Total deposited amount (public for deposit verification)                  |
| `closedAtSlot`      | `Field` | Global slot when close was initiated (for challenge period)               |
| `settlementTimeout` | `Field` | Number of slots for challenge period                                      |
| `tokenId`           | `Field` | Mina token ID (MINA native or custom fungible token)                      |

#### zkApp Methods

- `initializeChannel(participantA, participantB, nonce, timeout, tokenId)` — Sets initial state, verifies both participants sign
- `deposit(amount, depositor)` — Adds funds, updates depositTotal, requires signature from depositor
- `initiateClose(balanceA, balanceB, salt, nonce, sigA, sigB)` — Transitions to CLOSING state, records slot for challenge period, verifies balance commitment matches and both parties signed
- `settle()` — After challenge period expires (`currentSlot >= closedAtSlot + settlementTimeout`), distributes funds per final balance commitment

#### Acceptance Criteria

```gherkin
Given a Mina local blockchain is running
When two participants call initializeChannel with valid parameters
Then the zkApp state shows channelState=OPEN and channelHash matches Poseidon(participantA, participantB, nonce)

Given an OPEN channel
When a participant calls deposit with amount and valid signature
Then depositTotal increases by the deposited amount

Given an OPEN channel with deposits
When both participants sign a close request with balances and salt
Then channelState transitions to CLOSING and closedAtSlot is set to current global slot

Given a CLOSING channel
When settle is called before the challenge period expires
Then the transaction is rejected

Given a CLOSING channel
When settle is called after challengePeriod slots have passed
Then funds are distributed per the final balance commitment and channelState transitions to SETTLED
```

---

### Story 34.2: Mina Payment Channel zkApp — ZK-Private Claims

**Priority:** P0
**Estimate:** 5 points
**Dependencies:** Story 34.1

#### Description

Implement the `claimFromChannel()` method on the zkApp that allows cooperative balance updates using zk-SNARK proofs. This is the core privacy feature: a peer submits a proof that new balances are valid without revealing the actual amounts on-chain. The channel stays open after a claim (cooperative off-chain settlement pattern).

#### Privacy Properties

The zk proof circuit proves ALL of the following without revealing `balance_a`, `balance_b`, or `salt` on-chain:

1. **Commitment validity:** `Poseidon(new_balance_a, new_balance_b, new_salt) == new_balanceCommitment`
2. **Conservation:** `new_balance_a + new_balance_b == depositTotal` (total funds conserved)
3. **Non-negativity:** `new_balance_a >= 0 AND new_balance_b >= 0`
4. **Monotonic nonce:** `new_nonce > current_nonce`
5. **Authorization:** Both participants signed `(new_balanceCommitment, new_nonce, channelHash)`

#### Method Signature

```typescript
@method async claimFromChannel(
  // PRIVATE inputs — not visible on-chain
  newBalanceA: Field,
  newBalanceB: Field,
  newSalt: Field,
  signatureA: Signature,
  signatureB: Signature,
  // PUBLIC inputs — visible on-chain
  newBalanceCommitment: Field,
  newNonce: Field,
): Promise<void>
```

#### Acceptance Criteria

```gherkin
Given an OPEN channel with a known balance commitment
When a valid claimFromChannel proof is submitted with new balances that sum to depositTotal
Then the on-chain balanceCommitment updates to the new commitment and nonce increments

Given an OPEN channel
When a claimFromChannel proof is submitted where new_balance_a + new_balance_b != depositTotal
Then the proof fails to verify and the transaction is rejected

Given an OPEN channel
When a claimFromChannel proof is submitted with new_balance_a < 0
Then the proof fails to verify and the transaction is rejected

Given an OPEN channel
When a claimFromChannel proof is submitted with a nonce <= current nonce
Then the proof fails to verify and the transaction is rejected

Given a successful claimFromChannel transaction
When an observer inspects the on-chain state
Then only the balanceCommitment hash and nonce are visible — actual balances are not recoverable from on-chain data

Given an OPEN channel after a successful claim
When the channel state is inspected
Then channelState remains OPEN (channel is not closed by a claim)
```

---

### Story 34.3: Mina Payment Channel zkApp — Tests & Deployment

**Priority:** P0
**Estimate:** 3 points
**Dependencies:** Stories 34.1, 34.2

#### Description

Build a comprehensive test suite using o1js local blockchain simulation covering all zkApp methods, proof generation, and privacy properties. Deploy the zkApp to Mina devnet and generate verification keys.

#### Test Categories

1. **Lifecycle tests:** Channel open, deposit, close, settle — happy path and error cases
2. **Privacy tests:** Verify on-chain state reveals no balance information after claims
3. **Proof circuit tests:** Invalid proofs are rejected (bad balances, wrong nonce, missing signatures)
4. **Edge cases:** Zero balances, maximum field values, concurrent operations
5. **Compilation:** Proof compilation succeeds and verification key is deterministic

#### Acceptance Criteria

```gherkin
Given the zkApp source code
When the proof circuit is compiled using o1js
Then compilation succeeds and produces a deterministic verification key

Given a local Mina blockchain
When the full channel lifecycle is executed (open -> deposit -> claim -> close -> settle)
Then all state transitions complete successfully and final balances are correct

Given a channel with multiple claims executed
When on-chain state history is inspected
Then no individual balance amounts are recoverable — only Poseidon commitments are stored

Given the zkApp compiled artifact
When deployed to Mina devnet with a funded account
Then the zkApp is accessible at a known address and accepts transactions

Given a claim proof with tampered inputs
When the proof is submitted to the zkApp
Then the transaction is rejected with a verification failure
```

---

### Story 34.4: MinaPaymentChannelSDK — TypeScript Integration

**Priority:** P0
**Estimate:** 5 points
**Dependencies:** Story 34.3

#### Description

Create `MinaPaymentChannelSDK` — a TypeScript SDK using o1js that wraps all zkApp interactions for use by the connector. This SDK handles client-side proof generation, transaction construction, balance commitment management, and archive node integration. It mirrors the role of `PaymentChannelSDK` (ethers.js) in the EVM stack.

#### SDK Methods

| Method                                                                         | Purpose                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------- |
| `openChannel(participantA, participantB, timeout, tokenId)`                    | Deploy and initialize zkApp                 |
| `deposit(channelAddress, amount)`                                              | Deposit funds into channel                  |
| `claimFromChannel(channelAddress, newBalanceA, newBalanceB, salt, signatures)` | Generate zk proof and submit claim          |
| `closeChannel(channelAddress, finalBalanceA, finalBalanceB, salt, signatures)` | Initiate cooperative close                  |
| `settleChannel(channelAddress)`                                                | Execute settlement after challenge period   |
| `getChannelState(channelAddress)`                                              | Read on-chain state fields                  |
| `getChannelEvents(channelAddress)`                                             | Retrieve events/actions from archive node   |
| `compileContract()`                                                            | Pre-compile proof circuit (call at startup) |

#### Acceptance Criteria

```gherkin
Given a configured MinaPaymentChannelSDK instance
When compileContract is called
Then the zkApp circuit is compiled and ready for proof generation

Given a compiled SDK
When openChannel is called with valid parameters
Then a new zkApp is deployed and the channel address is returned

Given an open channel
When claimFromChannel is called with valid balances and signatures
Then a zk-SNARK proof is generated client-side and submitted as a transaction

Given an open channel
When deposit is called with an amount and valid signature
Then the deposit transaction is submitted and depositTotal increases

Given any SDK method that generates a proof
When the method is invoked
Then it returns a Promise that resolves asynchronously (non-blocking)

Given a channel address
When getChannelState is called
Then the current on-chain state fields are returned as typed objects

Given a channel with historical transactions
When getChannelEvents is called
Then events are retrieved from the archive node in chronological order
```

---

### Story 34.5: Implement MinaPaymentChannelProvider

**Priority:** P0
**Estimate:** 5 points
**Dependencies:** Story 34.4, Epic 32 (`PaymentChannelProvider` interface)

#### Description

Implement the `PaymentChannelProvider` interface from Epic 32 for Mina Protocol. This provider wraps `MinaPaymentChannelSDK` and integrates with the connector's settlement pipeline. It handles proof generation latency via async non-blocking operations, defines the `MinaClaimMessage` format with self-describing fields, and monitors channel state via archive node polling.

#### Provider Responsibilities

- Map `PaymentChannelProvider` interface methods to `MinaPaymentChannelSDK` calls
- Handle async proof generation: claim/settle operations return Promises; the settlement pipeline must not block on proof generation
- Emit settlement events when archive node reports state changes (channel opened, claim processed, channel settled)
- Pre-compile zkApp circuit during provider initialization
- Manage Mina account nonces to avoid transaction conflicts

#### MinaClaimMessage Self-Describing Fields

| Field               | Type     | Purpose                                                              |
| ------------------- | -------- | -------------------------------------------------------------------- |
| `chain`             | `'mina'` | Discriminator for chain identification                               |
| `zkAppAddress`      | `string` | Base58-encoded zkApp address                                         |
| `tokenId`           | `string` | Mina token ID                                                        |
| `balanceCommitment` | `string` | Poseidon hash of (balance_a, balance_b, salt)                        |
| `nonce`             | `number` | Monotonic claim nonce                                                |
| `proof`             | `string` | Serialized zk-SNARK proof (base64)                                   |
| `salt`              | `string` | Shared salt for commitment verification (sent to peer, not on-chain) |

#### Acceptance Criteria

```gherkin
Given a MinaPaymentChannelProvider instance
When it is initialized with valid Mina configuration
Then the zkApp circuit is pre-compiled and the provider is ready to process claims

Given the provider implements PaymentChannelProvider
When any method from the interface is called
Then the provider delegates to MinaPaymentChannelSDK and returns the expected result type

Given a claim is generated via the provider
When the claim message is serialized
Then it contains all self-describing fields (chain, zkAppAddress, tokenId, balanceCommitment, nonce, proof)

Given a peer sends a MinaClaimMessage
When the provider receives and verifies it
Then the zk-SNARK proof is verified and the balance commitment is validated

Given proof generation takes 30-120 seconds
When a settlement operation is triggered
Then the operation runs asynchronously and does not block the ILP packet processing pipeline

Given an archive node is configured
When channel state changes occur on-chain
Then the provider emits corresponding settlement events
```

---

### Story 34.6: NIP-59-Inspired Claim Wrapping for Transport Privacy

**Priority:** P1
**Estimate:** 3 points
**Dependencies:** Story 34.5

#### Description

Implement three-layer claim wrapping inspired by Nostr NIP-59 Gift Wrap for transport-layer privacy. This is an optional privacy enhancement that ensures BTP intermediaries cannot observe claim contents — they see only ephemeral keys and encrypted blobs. Combined with the zk-SNARK on-chain privacy from Story 34.2, this provides end-to-end privacy: neither on-chain observers nor transport intermediaries can determine transferred amounts.

#### Three-Layer Wrapping

| Layer  | Name          | Purpose                                                                                   |
| ------ | ------------- | ----------------------------------------------------------------------------------------- |
| Inner  | **Rumor**     | Unsigned claim payload (deniable) containing zk proof + balance commitment                |
| Middle | **Seal**      | Encrypted to peer using NIP-44-style ChaCha20 encryption, signed by real sender           |
| Outer  | **Gift Wrap** | Encrypted with ephemeral one-time key, randomized timestamps — no link to sender identity |

#### Receiver Unwrapping Flow

1. Decrypt gift wrap using receiver's private key → reveals seal
2. Decrypt seal using shared secret with sender → reveals rumor
3. Extract claim payload from rumor → verify zk proof and balance commitment

#### Acceptance Criteria

```gherkin
Given a MinaClaimMessage to send to a peer
When NIP-59 wrapping is enabled in configuration
Then the claim is wrapped in three layers (rumor -> seal -> gift wrap) before BTP transmission

Given a wrapped claim is received via BTP protocolData
When the receiver unwraps the gift wrap layer
Then an ephemeral key is used for decryption and no sender identity is revealed at this layer

Given the gift wrap is decrypted
When the receiver unwraps the seal layer
Then the real sender's signature is verified and the rumor payload is decrypted

Given the seal is decrypted
When the receiver extracts the rumor
Then the contained MinaClaimMessage is valid and the zk proof verifies correctly

Given NIP-59 wrapping is disabled in configuration
When a claim is sent
Then the plaintext MinaClaimMessage is sent via BTP protocolData without wrapping

Given a BTP intermediary observes a wrapped claim in transit
When the intermediary inspects the protocolData
Then only encrypted bytes and an ephemeral public key are visible — no claim content, sender identity, or balance information is exposed
```

---

### Story 34.7: Mina Claim Message Types & Serialization

**Priority:** P0
**Estimate:** 2 points
**Dependencies:** Story 34.5

#### Description

Define `MinaClaimMessage` as a concrete type extending the base `ClaimMessage` from Epic 32. Implement serialization/deserialization for BTP protocolData transport, supporting both plaintext and NIP-59-wrapped formats. Include a discriminator field (`chain: 'mina'`) for multi-chain claim routing.

#### Type Definition

```typescript
interface MinaClaimMessage extends ClaimMessage {
  chain: 'mina';
  zkAppAddress: string;
  tokenId: string;
  balanceCommitment: string;
  nonce: number;
  proof: string; // base64-encoded zk-SNARK proof
  salt: string; // shared with peer for commitment verification
}
```

#### Serialization Format

- BTP protocolData: `protocolName: 'claim'`, `contentType: APPLICATION_JSON`
- JSON payload with `chain` discriminator for deserialization routing
- Wrapped format: `protocolName: 'claim-wrapped'`, `contentType: APPLICATION_OCTET_STREAM`
- Zod schema validation on deserialization

#### Acceptance Criteria

```gherkin
Given a MinaClaimMessage object
When serialized for BTP protocolData
Then the output contains protocolName 'claim' and a valid JSON payload with chain='mina'

Given a BTP protocolData payload with chain='mina'
When deserialized
Then a typed MinaClaimMessage object is returned with all fields populated

Given a MinaClaimMessage with an invalid field (e.g., missing zkAppAddress)
When Zod validation runs during deserialization
Then a validation error is thrown with a descriptive message

Given a NIP-59-wrapped claim
When serialized for BTP protocolData
Then the output uses protocolName 'claim-wrapped' with APPLICATION_OCTET_STREAM content type

Given a claim from an EVM peer and a claim from a Mina peer
When both are received by the same connector
Then the chain discriminator field routes each to the correct provider for verification
```

---

### Story 34.8: Integration Tests — Mina Provider E2E

**Priority:** P0
**Estimate:** 5 points
**Dependencies:** Stories 34.1–34.7

#### Description

End-to-end integration tests exercising the full Mina settlement path through the connector. Uses o1js local blockchain simulation (not devnet) for deterministic, fast test execution. Tests cover multi-peer settlement, per-packet claim generation with zk-proof verification, threshold-driven settlement, and privacy verification.

#### Test Scenarios

| Scenario                 | Priority | Description                                                                      |
| ------------------------ | -------- | -------------------------------------------------------------------------------- |
| Channel lifecycle E2E    | P0       | open -> deposit -> claim (private) -> close -> settle through connector pipeline |
| Multi-peer settlement    | P0       | 3 peers with Mina channels, ILP packets trigger claims, settlement executes      |
| Privacy verification     | P0       | After N claims, verify on-chain state reveals no balance data                    |
| Proof generation latency | P0       | Verify ILP packet processing is not blocked during proof generation              |
| NIP-59 round-trip        | P1       | Wrapped claim sent via BTP, receiver unwraps and verifies                        |
| Mixed-chain settlement   | P1       | One peer on EVM, one peer on Mina — connector routes claims to correct provider  |
| Threshold settlement     | P0       | Credit balance exceeds threshold, triggers Mina settlement automatically         |
| Invalid claim rejection  | P0       | Tampered proof, wrong nonce, bad commitment — all rejected                       |

#### Acceptance Criteria

```gherkin
Given a local Mina blockchain via o1js simulation
When the full channel lifecycle is executed through the connector
Then open, deposit, claim, close, and settle all complete successfully

Given three peers configured with Mina settlement
When ILP packets are forwarded between peers
Then per-packet claims are generated with valid zk proofs and exchanged via BTP

Given multiple claims have been processed
When on-chain state is inspected via the Mina provider
Then only Poseidon commitment hashes are visible — no actual balance amounts

Given a peer's credit balance exceeds the configured threshold
When the settlement monitor triggers
Then an on-chain settlement is executed via the Mina provider asynchronously

Given a claim with a tampered zk proof
When the receiver attempts to verify it
Then verification fails and the claim is rejected with a descriptive error

Given NIP-59 wrapping is enabled
When a claim is sent and received between two peers
Then the unwrapped claim matches the original and the zk proof verifies
```

---

### Story 34.9: Mina Devnet Deployment & Documentation

**Priority:** P1
**Estimate:** 2 points
**Dependencies:** Stories 34.1–34.8

#### Description

Deploy the payment channel zkApp to Mina devnet, provide configuration examples for the Mina provider, and document operational requirements including proof generation performance, archive node setup, and privacy guarantees. Include performance benchmarks for proof generation and settlement latency.

#### Deliverables

1. **Devnet deployment:** zkApp deployed to Mina devnet with known address and verification key
2. **Configuration example:** YAML config snippet for adding Mina settlement to a connector
3. **Operational documentation:** Archive node requirements, proof generation hardware recommendations, privacy model explanation
4. **Performance benchmarks:** Proof generation time (by operation type), settlement latency end-to-end, memory usage during proof generation

#### Acceptance Criteria

```gherkin
Given a funded Mina devnet account
When the zkApp deployment script is executed
Then the zkApp is deployed and accessible at a stable devnet address

Given the documentation
When a developer reads the Mina provider configuration example
Then they can configure a connector with Mina settlement by copying and adapting the YAML

Given the performance benchmarks
When proof generation times are measured for each operation type
Then results are documented with hardware specifications and recommendations

Given the privacy documentation
When reviewed by a developer unfamiliar with zk-SNARKs
Then the privacy guarantees and limitations are clearly explained
```

---

## Compatibility Requirements

| Requirement                      | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Epic 32 interface compliance** | `MinaPaymentChannelProvider` must implement `PaymentChannelProvider` without modifications to the interface                                                                                                                                                                                                                                                                                                                                                |
| **BTP protocol compatibility**   | Claims transported via existing BTP protocolData mechanism; no BTP protocol changes required                                                                                                                                                                                                                                                                                                                                                               |
| **Multi-chain coexistence**      | Mina provider runs alongside EVM provider; `chain` discriminator routes claims correctly                                                                                                                                                                                                                                                                                                                                                                   |
| **Node.js version**              | o1js requires Node.js >= 18; connector requires >= 22.11.0 — no conflict                                                                                                                                                                                                                                                                                                                                                                                   |
| **TypeScript compatibility**     | o1js uses TypeScript; must compile under project's `strict` mode and ES2022 target                                                                                                                                                                                                                                                                                                                                                                         |
| **Test infrastructure**          | See Architecture doc → Local Blockchain Infrastructure → Mina Lightnet. Unit tests use `Mina.LocalBlockchain({ proofsEnabled: false })` (in-process, no Docker). Proof-enabled integration tests use `proofsEnabled: true` (30-120s/tx, 5-min Jest timeout, merge/nightly only). E2E tests use Docker-based lightnet (`make mina-up`, image: `o1labs/mina-local-network:o1js-main`). Accounts manager at `http://localhost:8181` provides funded keypairs. |

---

## Definition of Done

- [ ] All stories have passing acceptance criteria tests
- [ ] zkApp compiles and generates deterministic verification keys
- [ ] Privacy property verified: on-chain state reveals no balance amounts after claims
- [ ] Integration tests pass using o1js local blockchain simulation
- [ ] `MinaPaymentChannelProvider` implements `PaymentChannelProvider` interface from Epic 32
- [ ] Claims serialize/deserialize correctly via BTP protocolData
- [ ] NIP-59 wrapping/unwrapping round-trip works end-to-end
- [ ] Proof generation does not block ILP packet processing
- [ ] zkApp deployed to Mina devnet
- [ ] Documentation covers configuration, operations, and privacy model
- [ ] Code passes ESLint, Prettier, and TypeScript strict checks
- [ ] No `any` types; all o1js types properly typed
- [ ] Test coverage meets project thresholds (branches 60%, functions 75%, lines 70%, statements 70%)

---

## Estimated Total Effort

| Story     | Points | Description                         |
| --------- | ------ | ----------------------------------- |
| 34.1      | 5      | zkApp — Channel Lifecycle           |
| 34.2      | 5      | zkApp — ZK-Private Claims           |
| 34.3      | 3      | zkApp — Tests & Deployment          |
| 34.4      | 5      | MinaPaymentChannelSDK               |
| 34.5      | 5      | MinaPaymentChannelProvider          |
| 34.6      | 3      | NIP-59 Claim Wrapping               |
| 34.7      | 2      | Claim Message Types & Serialization |
| 34.8      | 5      | Integration Tests E2E               |
| 34.9      | 2      | Devnet Deployment & Documentation   |
| **Total** | **35** |                                     |

---

## Open Questions

1. **o1js version pinning:** Which o1js version to target? The API has changed significantly between releases (SnarkyJS -> o1js rename). Need to evaluate latest stable release.
2. **Archive node hosting:** Should the connector bundle an archive node client, or require operators to configure an external archive node endpoint?
3. **Custom token support:** Initial implementation targets native MINA. When should Mina Fungible Token standard support be added — in this epic or deferred?
4. **Challenge period duration:** 30 blocks (~90 minutes) is proposed. Should this be configurable per-channel or fixed?
5. **Proof caching:** Should generated proofs be cached to disk for recovery after crashes, or regenerated on demand?
