# Story 34.8: Integration Tests -- Mina Provider E2E

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **connector developer**,
I want **end-to-end integration tests exercising the full Mina settlement path through the connector**,
so that **the complete lifecycle (open, deposit, claim, close, settle) is verified with zk-SNARK proofs, multi-peer settlement, privacy verification, and mixed-chain coexistence with EVM and Solana**.

**Epic:** 34 -- Mina Protocol Payment Channel Provider (ZK-Private Settlement)
**Priority:** P0 (validates all preceding stories 34.1--34.7)
**Estimated effort:** 5 points (~3-5 dev days)
**Dependencies:** Stories 34.1--34.7 (all done), Epic 32 (done), Epic 33 (done)

## Acceptance Criteria

### AC 1: Full Channel Lifecycle E2E

```gherkin
Scenario: Full Mina payment channel lifecycle through connector pipeline
  Given a local Mina blockchain via o1js simulation (proofsEnabled: false)
  When the full lifecycle is executed (open -> deposit -> claim -> close -> settle)
  Then all state transitions complete successfully through the connector settlement pipeline
  And final balance commitments are valid Poseidon hashes
  And channelState transitions OPEN -> CLOSING -> SETTLED
```

### AC 2: Multi-Peer Mina Settlement

```gherkin
Scenario: Three peers with Mina channels exchange per-packet claims
  Given three peers configured with Mina settlement
  When ILP packets are forwarded between peers
  Then per-packet claims are generated with valid zk proof data and exchanged via BTP
  And each peer's channel tracks monotonically increasing nonces
```

### AC 3: Privacy Verification

```gherkin
Scenario: On-chain state reveals no balance data after claims
  Given multiple claims have been processed through the Mina provider
  When on-chain state is inspected
  Then only Poseidon commitment hashes are visible
  And no actual balance amounts are recoverable from on-chain state
```

### AC 4: Non-Blocking Proof Generation

```gherkin
Scenario: ILP packet processing not blocked during proof generation
  Given proof generation takes non-trivial time
  When a settlement operation is triggered
  Then ILP packet processing continues concurrently
  And proof generation runs asynchronously
```

### AC 5: NIP-59 Wrapped Claim Round-Trip

```gherkin
Scenario: NIP-59 wrapped claim sent and received successfully
  Given NIP-59 wrapping is enabled
  When a Mina claim is wrapped, sent via BTP, received, and unwrapped
  Then the unwrapped claim matches the original MinaClaimMessage
  And the zk proof data verifies correctly after unwrapping
```

### AC 6: Mixed-Chain Settlement (EVM + Solana + Mina)

```gherkin
Scenario: Three-chain mixed settlement -- claims routed to correct provider
  Given a connector with three peers: one EVM, one Solana, one Mina
  When claims are generated and received for each peer
  Then EVM claims route to the EVM provider
  And Solana claims route to the Solana provider
  And Mina claims route to the Mina provider
  And no cross-contamination occurs between claim types
```

### AC 7: Threshold-Driven Settlement

```gherkin
Scenario: Credit balance exceeds threshold, triggers Mina settlement
  Given a Mina peer's credit balance exceeds the configured settlement threshold
  When the settlement monitor triggers
  Then an on-chain settlement is executed via the Mina provider asynchronously
```

### AC 8: Invalid Claim Rejection

```gherkin
Scenario: Tampered proof, wrong nonce, and bad commitment all rejected
  Given a claim with a tampered zk-SNARK proof
  When the receiver attempts to verify it
  Then verification fails with a descriptive error

  Given a claim with a stale nonce (<= current nonce)
  When submitted to the claim receiver
  Then it is rejected for nonce monotonicity violation

  Given a claim with an invalid balance commitment
  When submitted to the claim receiver
  Then it is rejected for commitment validation failure
```

### AC 9: Config-Driven Provider Creation

```gherkin
Scenario: Mina provider created from YAML config via ChainProviderRegistry
  Given a connector YAML config with a Mina chain provider entry
  When ChainProviderRegistry.fromConfig() processes the config
  Then a MinaPaymentChannelProvider instance is created and registered
  And the provider's chainId follows 'mina:<network>' format
```

### AC 10: Graceful Provider Shutdown

```gherkin
Scenario: Provider cleans up on shutdown
  Given an active MinaPaymentChannelProvider with subscriptions
  When the provider is deregistered from the registry
  Then all event subscriptions are unsubscribed
  And no resource leaks occur
```

### AC 11: No Direct SDK Imports in Core Services (Static Check)

```gherkin
Scenario: Settlement services use chain abstraction only
  Given the core settlement service files (claim-receiver.ts, per-packet-claim-service.ts, settlement-executor.ts, settlement-monitor.ts)
  When inspected for import statements
  Then none import MinaPaymentChannelSDK directly
  And all Mina access goes through PaymentChannelProvider/ChainProviderRegistry
```

### AC 12: EVM Regression

```gherkin
Scenario: EVM settlement works identically alongside active Mina provider
  Given a connector with both EVM and Mina providers registered
  When EVM claims are processed through the existing EVM path
  Then all EVM operations succeed unchanged
```

### AC 13: Solana Regression

```gherkin
Scenario: Solana settlement works identically alongside active Mina provider
  Given a connector with both Solana and Mina providers registered
  When Solana claims are processed through the existing Solana path
  Then all Solana operations succeed unchanged
```

### AC 14: Claim JSON Self-Describing Fields

```gherkin
Scenario: Serialized Mina claims contain all required fields
  Given a MinaClaimMessage generated by the connector pipeline
  When serialized to JSON for BTP protocolData
  Then the JSON contains: blockchain='mina', zkAppAddress, tokenId, balanceCommitment, nonce, proof, salt
```

### AC 15: Claim Accumulation with Nonce Monotonicity

```gherkin
Scenario: 5+ claims with increasing nonces tracked correctly
  Given a Mina channel with active claim exchange
  When 5+ sequential claims are generated
  Then each claim has a strictly increasing nonce
  And balance commitments update with each claim
```

## Tasks / Subtasks

- [x] Task 1: Create `mina-provider.test.ts` integration test file (AC: 1, 2, 3, 4, 7, 8, 14, 15)
  - [x] 1.1 Create `packages/connector/test/integration/mina-provider.test.ts`
    - File header docblock listing covered test IDs: T-34.8-01 through T-34.8-04, T-34.8-07, T-34.8-08, T-34.8-14, T-34.8-17
    - Follow `solana-provider.test.ts` structure exactly (mock SDK pattern, test gating, helper functions)
  - [x] 1.2 Create mock `MinaPaymentChannelSDK` factory (follow `createMockSDK()` pattern from `solana-provider.test.ts`):
    ```typescript
    function createMockMinaSDK(): jest.Mocked<
      Pick<
        MinaPaymentChannelSDK,
        | 'openChannel'
        | 'deposit'
        | 'claimFromChannel'
        | 'closeChannel'
        | 'settleChannel'
        | 'getChannelState'
        | 'compileContract'
        | 'signBalanceProof'
        | 'verifyBalanceProof'
        | 'subscribeToChannel'
      >
    > { /* jest.fn() for each */ }
    ```
  - [x] 1.3 Create `createMinaTestProvider()` helper that instantiates `MinaPaymentChannelProvider` with mock SDK, signerKey (`'test-signer-key'`), and silent Pino logger
  - [x] 1.4 Create `createValidMinaClaim()` helper returning a valid `MinaClaimMessage` test fixture:
    ```typescript
    const validMinaClaim: MinaClaimMessage = {
      version: '1.0',
      blockchain: 'mina',
      messageId: 'claim-mina-001',
      timestamp: '2026-03-28T12:00:00.000Z',
      senderId: 'peer-mina-alice',
      zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
      tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
      balanceCommitment: '12345678901234567890123456789012345678901234567890',
      nonce: 1,
      proof: 'eyJwcm9vZiI6InRlc3QifQ==',
      salt: 'abcdef1234567890',
      network: 'devnet',
    };
    ```
  - [x] 1.5 T-34.8-01: Full lifecycle test -- mock SDK openChannel, deposit, claimFromChannel, closeChannel, settleChannel in sequence; verify provider calls SDK with correct adapted parameters (string-to-bigint via `safeBigInt()`); verify state transitions via mock getChannelState returns (UNINITIALIZED -> OPEN -> CLOSING -> SETTLED)
  - [x] 1.6 T-34.8-02: Multi-peer test -- create 3 MinaPaymentChannelProvider instances (each with different mock SDK, signerKey, and zkApp address); register all via `registry.register(provider)` in a `ChainProviderRegistry`; verify claims from each peer route to the correct provider
  - [x] 1.7 T-34.8-03: Privacy verification test -- after N claims via mock SDK, verify that the mock SDK's `claimFromChannel` was called only with commitment hashes (not plaintext amounts); verify `getChannelState()` returns only `balanceCommitment` (Poseidon hash), not individual balance fields
  - [x] 1.8 T-34.8-04: Non-blocking proof generation test -- call `signBalanceProof()` and verify it returns a Promise (async); verify the event loop is not blocked (use `setTimeout` / `setImmediate` assertion)
  - [x] 1.9 T-34.8-07: Threshold settlement test -- mock SettlementMonitor detecting a threshold breach; verify it calls provider's `settleChannel()` via the registry
  - [x] 1.10 T-34.8-08: Invalid claim rejection tests:
    - Tampered proof: modify proof field, call `verifyBalanceProof()`, verify rejection
    - Wrong nonce: submit claim with nonce <= current, verify rejection
    - Bad commitment: submit claim with invalid balanceCommitment format, verify `validateClaimMessage()` rejects
  - [x] 1.11 T-34.8-14: Claim JSON structure test -- serialize a `MinaClaimMessage`, parse resulting JSON, verify all self-describing fields present: `blockchain`, `zkAppAddress`, `tokenId`, `balanceCommitment`, `nonce`, `proof`, `salt`
  - [x] 1.12 T-34.8-17: Claim accumulation test -- generate 5+ claims with increasing nonces; verify each claim's nonce is strictly greater than the previous; verify `PerPacketClaimService` tracks nonce state correctly per zkAppAddress

- [x] Task 2: Create `mixed-chain-three-way.test.ts` (AC: 6, 12, 13)
  - [x] 2.1 Create `packages/connector/test/integration/mixed-chain-three-way.test.ts`
    - File header listing test IDs: T-34.8-06, T-34.8-12, T-34.8-13
  - [x] 2.2 T-34.8-06: Three-chain routing test:
    - Create mock EVM, Solana, and Mina providers
    - Register all three via `registry.register(provider)` with distinct `chainId` values (`evm:8453`, `solana:devnet`, `mina:devnet`)
    - Create three peer configs, each referencing a different chain
    - Generate claims for each peer via `PerPacketClaimService`
    - Verify each claim has the correct `blockchain` discriminator
    - Verify `ClaimReceiver` routes each claim to the correct provider for verification
  - [x] 2.3 T-34.8-12: EVM regression test:
    - With Mina provider also registered, process EVM claims end-to-end
    - Verify EVM `signBalanceProof()` and `verifyBalanceProof()` work unchanged
    - Verify EVM claim serialization/deserialization unaffected
  - [x] 2.4 T-34.8-13: Solana regression test:
    - With Mina provider also registered, process Solana claims end-to-end
    - Verify Solana `signBalanceProof()` and `verifyBalanceProof()` work unchanged
    - Verify Solana claim serialization/deserialization unaffected

- [x] Task 3: Create `mina-nip59.test.ts` (AC: 5)
  - [x] 3.1 Create `packages/connector/test/integration/mina-nip59.test.ts`
    - File header listing test ID: T-34.8-05
  - [x] 3.2 T-34.8-05: NIP-59 round-trip test:
    - Create a valid `MinaClaimMessage`
    - Create an `NIP59ClaimWrapper` instance with `{ nip59Enabled: true, logger }` (from `packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts`)
    - Wrap it using `wrapper.wrapClaim(claim, senderPrivKey, receiverPubKey)`
    - Verify the wrapped output is encrypted and contains only ephemeral key + ciphertext
    - Unwrap using `wrapper.unwrapClaim(wrapped, receiverPrivKey)`
    - Verify the unwrapped claim matches the original `MinaClaimMessage` exactly
    - Verify the unwrapped claim's zk proof field is preserved (base64 integrity)
    - Verify serialization uses `protocolName: 'claim-wrapped'` with `APPLICATION_OCTET_STREAM`

- [x] Task 4: Create `mina-config.test.ts` (AC: 9, 10, 11)
  - [x] 4.1 Create `packages/connector/test/integration/mina-config.test.ts`
    - File header listing test IDs: T-34.8-09, T-34.8-10, T-34.8-11
  - [x] 4.2 T-34.8-09: Config-driven provider creation test:
    - Create a `MinaProviderConfig` object (matches `payment-channel-provider.ts` interface):
      ```typescript
      {
        chainType: 'mina',
        graphqlUrl: 'http://localhost:8080/graphql',
        zkAppAddress: 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy',
        keyId: 'test-key',
        tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf',
        network: 'devnet',
      }
      ```
    - Call `ChainProviderRegistry.fromConfig()` with a Mina factory
    - Verify the provider is registered with `chainId: 'mina:devnet'` via `registry.getProvider('mina', 'mina:devnet')`
    - Verify `getProviderForPeer()` returns the Mina provider for a peer with `chain: 'mina:devnet'`
  - [x] 4.3 T-34.8-10: Graceful shutdown test:
    - Create provider, subscribe to events via `subscribeToEvents()`, then call `registry.deregister(chainId)`
    - Verify event subscription is cleaned up (no dangling intervals/callbacks)
    - Verify no unhandled Promise rejections during shutdown
  - [x] 4.4 T-34.8-11: Static import audit test:
    - Read the source files: `claim-receiver.ts`, `per-packet-claim-service.ts`, `settlement-executor.ts`, `settlement-monitor.ts` (relative to `packages/connector/src/settlement/`)
    - Use `fs.readFileSync()` to read each file's content
    - Assert NO file contains `import.*MinaPaymentChannelSDK` or `from.*mina-payment-channel-sdk`
    - Verify all Mina access goes through provider interface and registry
    - NOTE: Files may import `MinaPaymentChannelProvider` via `instanceof` check -- this is allowed (follows EVM and Solana pattern). Only SDK imports are prohibited.

- [x] Task 5: Create `mina-proofs.test.ts` stub (AC: proof-enabled tests, merge/nightly only)
  - [x] 5.1 Create `packages/connector/test/integration/mina-proofs.test.ts`
    - File header listing test IDs: T-34.8-15, T-34.8-16
    - Set `jest.setTimeout(300_000)` (5 minutes for proof generation)
    - Use `describe.skip` with comment: "Proof-enabled tests -- run in merge/nightly CI only. Remove .skip to run locally."
  - [x] 5.2 T-34.8-15 stub: Full lifecycle with `proofsEnabled: true` -- placeholder test that will be un-skipped when o1js is available as a dependency
  - [x] 5.3 T-34.8-16 stub: Proof generation timing measurement -- record `Date.now()` before and after each proof operation, log results

- [x] Task 6: Create `mina-lightnet.test.ts` stub (AC: Docker-based lightnet, merge/nightly only)
  - [x] 6.1 Create `packages/connector/test/integration/mina-lightnet.test.ts`
    - File header listing test ID: T-34.8-18
    - Test gating: skip if lightnet is not running (check `http://localhost:8181/acquire-account` availability)
    - Use `describe.skip` with comment: "Lightnet E2E -- requires `make mina-up`. Remove .skip to run locally."
  - [x] 6.2 T-34.8-18 stub: Archive node event retrieval -- placeholder for real lightnet-based test

- [x] Task 7: Regression gate
  - [x] 7.1 All existing EVM tests pass unchanged (no modifications to existing test files)
  - [x] 7.2 All existing Solana tests pass unchanged
  - [x] 7.3 All existing `mixed-chain-routing.test.ts` tests pass unchanged
  - [x] 7.4 `npm run build --workspace=packages/shared && npm run build --workspace=packages/connector` clean
  - [x] 7.5 `make test` passes (all project tests green)
  - [x] 7.6 `make lint` passes

## Dev Notes

### Structural Pattern: Follow Story 33.7 (Solana Integration Tests) Exactly

Story 33.7 (`solana-provider.test.ts`) is the direct structural analog. Follow its exact patterns:

- **Test file location:** `packages/connector/test/integration/mina-provider.test.ts` (parallel to `solana-provider.test.ts`)
- **Mock SDK pattern:** Create `createMockMinaSDK()` following `createMockSDK()` in `solana-provider.test.ts`
- **Test gating:** Use `describe.skip` for proof-enabled/lightnet tests (parallel to `describeBankrun` gating in Solana)
- **Logger:** `pino({ level: 'silent' })` -- never use `jest.fn()` for logger mocks
- **Jest timeout:** `jest.setTimeout(60_000)` for standard integration tests; `jest.setTimeout(300_000)` for proof-enabled
- **`jest.clearAllMocks()` in every `beforeEach`**
- **`afterEach` cleanup:** Stop any running monitors/subscriptions

### Key Difference from Solana Tests: No Program Binary Gating

Solana integration tests gate on `payment_channel.so` existence. Mina integration tests do NOT need binary gating because the Mina provider wraps a mock SDK (o1js is not imported directly by the connector). The real o1js tests are in `mina-proofs.test.ts` (skipped by default).

### MinaPaymentChannelProvider Mock Construction

The provider constructor requires:
```typescript
new MinaPaymentChannelProvider(
  sdk: MinaPaymentChannelSDK,
  chainId: string,           // e.g., 'mina:devnet'
  zkAppAddress: string,      // B62... address
  signerKey: string,         // private key or key identifier for signing
  logger: Logger,
  options?: MinaProviderOptions  // { tokenId?, network? }
)
```

Use `as unknown as MinaPaymentChannelSDK` to cast the mock SDK (follows Solana pattern with `as unknown as jest.Mocked<SolanaPaymentChannelSDK>`).

### MinaPaymentChannelProvider Key Methods to Mock/Test

| Method | Purpose | Test Focus |
|--------|---------|------------|
| `openChannel()` | Deploy zkApp, returns channel address | Lifecycle test |
| `deposit()` | Fund channel | Lifecycle test |
| `claimFromChannel()` | Submit zk-SNARK claim | Lifecycle, privacy, accumulation |
| `closeChannel()` | Initiate cooperative close | Lifecycle test |
| `settleChannel()` | Execute settlement after challenge period | Lifecycle, threshold |
| `signBalanceProof()` | Generate proof (async) | Non-blocking test |
| `verifyBalanceProof()` | Verify received proof | Invalid claim tests |
| `getChannelState()` | Read on-chain state | Privacy, lifecycle |
| `getMinaContext()` | Return signing context | Claim construction |
| `subscribeToEvents()` | Poll for state changes | Shutdown/cleanup |

### ChainProviderRegistry Integration

The registry is the central routing mechanism. For multi-chain tests:
```typescript
import { ChainProviderRegistry } from '../../src/settlement/provider/chain-provider-registry';

const registry = new ChainProviderRegistry();
registry.register(evmProvider);    // chainId: 'evm:8453'
registry.register(solanaProvider); // chainId: 'solana:devnet'
registry.register(minaProvider);   // chainId: 'mina:devnet'
```

### Mina Claim Routing in ClaimReceiver

`ClaimReceiver.resolveProvider()` uses `isMinaClaim(claim)` to detect Mina claims, then:
1. Tries known channel lookup via `ChannelManager.getChannelById(claim.zkAppAddress)`
2. Falls back to network-based lookup via `claim.network` -> `registry.getProvider('mina', 'mina:devnet')`

### BalanceProofParams Mapping for Mina Verification Tests

When testing `verifyBalanceProof()`, construct params following the mapping established in Story 34.7:
```typescript
const verifyParams: VerifyBalanceProofParams = {
  channelId: claim.zkAppAddress,          // zkApp address as channel ID
  nonce: claim.nonce,
  transferredAmount: claim.balanceCommitment, // commitment replaces amount
  lockedAmount: '0',                       // not used by Mina
  locksRoot: '0x' + '0'.repeat(64),        // not used by Mina
  signature: claim.proof,                  // zk-SNARK proof
  signerAddress: claim.zkAppAddress,       // zkApp as signer identity
};
```

### NIP-59 Wrapper Integration

The NIP-59 wrapper lives at `packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts` (Story 34.6). Import and use:
```typescript
import { NIP59ClaimWrapper } from '../../src/settlement/privacy/nip59-claim-wrapper';
```

The wrapper is claim-type-agnostic -- it encrypts the serialized JSON payload via `wrapClaim()`/`unwrapClaim()` instance methods. Test that Mina-specific fields survive the wrap/unwrap round-trip without corruption. When `nip59Enabled` is false, `wrapClaim()` returns null (passthrough).

### Mina Address Format for Test Fixtures

Mina addresses: `B62` prefix + 52 base58 characters = 55 chars total. Use realistic-looking test addresses:
- `B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy` (from Story 34.7 fixture)
- Generate additional unique addresses for multi-peer tests by varying the last few characters

### Test IDs to Test File Mapping

| Test ID | File | Priority |
|---------|------|----------|
| T-34.8-01 | `mina-provider.test.ts` | P0 |
| T-34.8-02 | `mina-provider.test.ts` | P0 |
| T-34.8-03 | `mina-provider.test.ts` | P0 |
| T-34.8-04 | `mina-provider.test.ts` | P0 |
| T-34.8-05 | `mina-nip59.test.ts` | P1 |
| T-34.8-06 | `mixed-chain-three-way.test.ts` | P1 |
| T-34.8-07 | `mina-provider.test.ts` | P0 |
| T-34.8-08 | `mina-provider.test.ts` | P0 |
| T-34.8-09 | `mina-config.test.ts` | P1 |
| T-34.8-10 | `mina-config.test.ts` | P1 |
| T-34.8-11 | `mina-config.test.ts` | P0 |
| T-34.8-12 | `mixed-chain-three-way.test.ts` | P0 |
| T-34.8-13 | `mixed-chain-three-way.test.ts` | P0 |
| T-34.8-14 | `mina-provider.test.ts` | P0 |
| T-34.8-15 | `mina-proofs.test.ts` | P0 (nightly) |
| T-34.8-16 | `mina-proofs.test.ts` | P1 (nightly) |
| T-34.8-17 | `mina-provider.test.ts` | P0 |
| T-34.8-18 | `mina-lightnet.test.ts` | P1 (Docker) |

### Project Structure Notes

- All new test files go in `packages/connector/test/integration/` (matches existing `solana-*.test.ts` pattern)
- No new source files created -- this story only adds test files
- No modifications to existing source files -- only new files in `test/integration/`
- Imports reference source via relative paths: `../../src/settlement/provider/...`

### Previous Story Intelligence

**From Story 34.7 (Mina Claim Message Types & Serialization):**
- `MinaClaimMessage` extends `BaseClaimMessage` with `blockchain: 'mina'`
- Fields: `zkAppAddress`, `tokenId`, `balanceCommitment`, `nonce`, `proof`, `salt`, optional `network`
- `balanceCommitment` carries plaintext cumulative amount during claim construction; Mina provider's `signBalanceProof()` internally computes the Poseidon commitment
- Type guard `isMinaClaim()` and validator `validateMinaClaim()` with address format checks
- `BTPClaimMessage` discriminated union now includes `MinaClaimMessage`
- `PerPacketClaimService` constructs Mina claims when `ctx.blockchain === 'mina'`
- `ClaimReceiver.resolveProvider()` routes Mina claims via `isMinaClaim()` check

**From Story 34.6 (NIP-59 Claim Wrapping):**
- Class name is `NIP59ClaimWrapper` (all-caps NIP59), not `Nip59ClaimWrapper`
- Instance methods: `wrapClaim(claim, senderPrivKey, receiverPubKey)` returns `WrappedClaim | null`
- `unwrapClaim(wrappedClaim, receiverPrivKey)` returns `BTPClaimMessage`
- When `nip59Enabled: false`, `wrapClaim()` returns null (passthrough mode)
- Protocol constants: `BTP_WRAPPED_CLAIM_PROTOCOL.NAME = 'claim-wrapped'`, `CONTENT_TYPE = 0` (APPLICATION_OCTET_STREAM)

**From Story 34.5 (MinaPaymentChannelProvider):**
- Constructor: `(sdk, chainId, zkAppAddress, signerKey, logger, options?)`
- `signerKey` is a required parameter (private key or key identifier)
- `getMinaContext()` returns `{ zkAppAddress, tokenId, network }`
- `subscribeToEvents()` uses interval-based polling with state-diffing
- `safeBigInt()` helper converts string amounts to bigint

### Cross-Story Dependencies

- This story (34.8) is the final validation story for Epic 34
- Validates all preceding stories 34.1--34.7 work together end-to-end
- No subsequent stories depend on this one within Epic 34
- Epic 32 (chain abstraction) and Epic 33 (Solana) provide the multi-chain infrastructure tested here

### Coding Standards Reminders

- **Named exports only** -- no default exports
- **`import type` for type-only imports**
- **Pino logger** -- `logger.info({ event: 'event_name', key: value }, 'message')` (fields first)
- **No `any` type** -- use `unknown` and type narrowing; cast mocks with `as unknown as jest.Mocked<Type>`
- **No `console.log`** -- use Pino logger
- **Unused params prefixed `_`**
- **Strict null checks** -- handle `| undefined` from `noUncheckedIndexedAccess`
- **BigInt for amounts** -- provider interface uses string amounts
- **Jest test patterns** -- `jest.clearAllMocks()` in `beforeEach`, `pino({ level: 'silent' })` for mock logger
- **Story references** -- include `(Story 34.8)` in describe blocks
- **Test file doc comments** -- describe test scope at the top of each test file

### References

- [Source: _bmad-output/planning-artifacts/epic-34-mina-protocol-payment-channel-provider.md#Story 34.8] -- Story definition and acceptance criteria
- [Source: _bmad-output/planning-artifacts/test-design-epic-34.md#Story 34.8] -- Test design with all T-34.8 test IDs and file mapping
- [Source: _bmad-output/planning-artifacts/architecture.md#Mina Lightnet] -- Test infrastructure tiers (LocalBlockchain vs lightnet vs proofs-enabled)
- [Source: _bmad-output/implementation-artifacts/34-7-mina-claim-message-types-serialization.md] -- MinaClaimMessage type, validation, pipeline wiring, test fixtures
- [Source: _bmad-output/implementation-artifacts/34-5-implement-mina-payment-channel-provider.md] -- Provider implementation, interface mapping, getMinaContext()
- [Source: _bmad-output/implementation-artifacts/34-6-nip59-claim-wrapping-transport-privacy.md] -- NIP-59 wrapper API
- [Source: packages/connector/test/integration/solana-provider.test.ts] -- Structural analog (mock SDK, test gating, helper functions)
- [Source: packages/connector/src/settlement/provider/mixed-chain-routing.test.ts] -- Multi-chain routing test patterns
- [Source: _bmad-output/project-context.md#Testing Rules] -- Jest config, mock patterns, coverage thresholds, naming conventions

## Preconditions

- Stories 34.1--34.7 are complete -- full Mina provider, SDK, claim types, NIP-59 wrapper, and pipeline wiring done
- Epic 32 (chain abstraction) and Epic 33 (Solana provider) are complete
- Branch `epic-34` with all preceding story commits
- All existing tests pass (baseline from Story 34.7)
- No real o1js dependency required for mock-based tests (proof-enabled tests are skipped by default)

## Out of Scope

- Modifying any source files (this story is tests only)
- Mina lightnet Docker infrastructure setup (stub tests only)
- Real zk-SNARK proof generation (deferred to proof-enabled test stubs)
- Mina mainnet deployment or documentation
- Performance benchmarking (separate concern)
- Token-2022 / custom fungible token tests
- Modifications to existing EVM or Solana test files

## Test Plan

| Test ID | Scenario | Type | Priority | File |
|---------|----------|------|----------|------|
| T-34.8-01 | Full lifecycle: open -> deposit -> claim -> close -> settle | Integration (mock SDK) | P0 | mina-provider.test.ts |
| T-34.8-02 | Multi-peer: three peers with Mina channels, per-packet claims | Integration (mock SDK) | P0 | mina-provider.test.ts |
| T-34.8-03 | Privacy: on-chain state reveals only Poseidon commitments | Integration (mock SDK) | P0 | mina-provider.test.ts |
| T-34.8-04 | Non-blocking: proof generation runs asynchronously | Integration (mock SDK) | P0 | mina-provider.test.ts |
| T-34.8-05 | NIP-59: wrapped claim round-trip preserves Mina fields | Integration | P1 | mina-nip59.test.ts |
| T-34.8-06 | Mixed-chain: EVM + Solana + Mina claims routed correctly | Integration (mock) | P1 | mixed-chain-three-way.test.ts |
| T-34.8-07 | Threshold: credit balance triggers Mina settlement | Integration (mock SDK) | P0 | mina-provider.test.ts |
| T-34.8-08 | Invalid claims: tampered proof, wrong nonce, bad commitment | Integration (mock SDK) | P0 | mina-provider.test.ts |
| T-34.8-09 | Config-driven: Mina provider from YAML via ChainProviderRegistry | Integration | P1 | mina-config.test.ts |
| T-34.8-10 | Graceful shutdown: provider cleans up subscriptions | Integration | P1 | mina-config.test.ts |
| T-34.8-11 | Static: no direct MinaPaymentChannelSDK imports in services | Static | P0 | mina-config.test.ts |
| T-34.8-12 | EVM regression: EVM works alongside Mina provider | Integration (mock) | P0 | mixed-chain-three-way.test.ts |
| T-34.8-13 | Solana regression: Solana works alongside Mina provider | Integration (mock) | P0 | mixed-chain-three-way.test.ts |
| T-34.8-14 | Claim JSON: serialized MinaClaimMessage has all fields | Integration (mock SDK) | P0 | mina-provider.test.ts |
| T-34.8-15 | Full lifecycle with proofsEnabled: true (stub) | Integration (o1js) | P0 (nightly) | mina-proofs.test.ts |
| T-34.8-16 | Proof generation timing measurement (stub) | Integration (o1js) | P1 (nightly) | mina-proofs.test.ts |
| T-34.8-17 | Claim accumulation: 5+ claims with increasing nonces | Integration (mock SDK) | P0 | mina-provider.test.ts |
| T-34.8-18 | Archive node event retrieval (stub) | Integration (lightnet) | P1 (Docker) | mina-lightnet.test.ts |

### Regression Gate

- All existing EVM tests pass unchanged (no modifications to existing test files)
- All existing Solana tests pass unchanged
- All existing `mixed-chain-routing.test.ts` tests pass unchanged
- `npm run build --workspace=packages/shared && npm run build --workspace=packages/connector` clean
- `make test` passes (all project tests green)
- `make lint` passes

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

No debug issues encountered. All tests passed on first run.

### Completion Notes List

- **Task 1 (mina-provider.test.ts):** Verified 15 tests covering full lifecycle (T-34.8-01), multi-peer routing (T-34.8-02), privacy verification (T-34.8-03), non-blocking proof generation (T-34.8-04), threshold settlement (T-34.8-07), invalid claim rejection (T-34.8-08), claim JSON structure (T-34.8-14), and claim accumulation with nonce monotonicity (T-34.8-17). All tests pass.
- **Task 2 (mixed-chain-three-way.test.ts):** Verified 9 tests covering three-chain routing (T-34.8-06), EVM regression (T-34.8-12), and Solana regression (T-34.8-13). Validates EVM+Solana+Mina coexistence in a single registry with correct claim routing and no cross-contamination.
- **Task 3 (mina-nip59.test.ts):** Verified 6 tests covering NIP-59 wrapped claim round-trip (T-34.8-05). Validates wrap/unwrap preserves all Mina-specific fields, base64 proof integrity, protocol constants, passthrough mode, wrong-key rejection, and non-deterministic encryption.
- **Task 4 (mina-config.test.ts):** Verified 12 tests covering config-driven provider creation (T-34.8-09), graceful shutdown (T-34.8-10), and static import audit (T-34.8-11). Confirms no direct MinaPaymentChannelSDK imports in core settlement services.
- **Task 5 (mina-proofs.test.ts):** Verified 2 skipped stub tests (T-34.8-15, T-34.8-16) for proof-enabled integration that requires o1js. Correctly skipped with describe.skip.
- **Task 6 (mina-lightnet.test.ts):** Verified 1 skipped stub test (T-34.8-18) for lightnet E2E. Correctly skipped with describe.skip.
- **Task 7 (Regression gate):** All existing EVM tests (11 pass), Solana tests (11 pass), mixed-chain-routing tests (12 pass), full `make test` (all suites green), `make lint` clean, and builds succeed.

### File List

- `packages/connector/test/integration/mina-provider.test.ts` (existing, verified)
- `packages/connector/test/integration/mixed-chain-three-way.test.ts` (existing, verified)
- `packages/connector/test/integration/mina-nip59.test.ts` (existing, verified)
- `packages/connector/test/integration/mina-config.test.ts` (existing, verified)
- `packages/connector/test/integration/mina-proofs.test.ts` (existing, verified)
- `packages/connector/test/integration/mina-lightnet.test.ts` (existing, verified)

### Change Log

- **2026-03-28:** Story 34.8 validated -- all 6 test files verified, 45 tests passing (42 active + 3 skipped stubs), full regression gate passed. All acceptance criteria (AC 1-15) satisfied. No source file modifications required. Story status set to review.
- **2026-03-28:** Senior Developer Review #1 (AI) -- 5 issues found (0 critical, 0 high, 2 medium, 3 low), all fixed automatically. (1) Removed invalid `eslint-disable-next-line jest/no-disabled-tests` comments from mina-proofs.test.ts and mina-lightnet.test.ts (rule not configured in project ESLint). (2) Clarified misleading test description in mina-config.test.ts graceful shutdown test -- deregister does not auto-unsubscribe, caller is responsible. (3) Replaced silent `fs.existsSync` skips with `expect(fs.existsSync).toBe(true)` assertions in static import audit tests. (4) Added registry-based provider resolution assertions to EVM and Solana regression tests in mixed-chain-three-way.test.ts. All tests (44 passing, 3 skipped stubs) and lint clean after fixes. Story status set to done.
- **2026-03-28:** Senior Developer Review #2 (AI) -- 4 issues found (0 critical, 0 high, 1 medium, 3 low), all fixed automatically. (1) Aggregate static import audit test still silently skipped missing files via `continue` -- replaced with `expect(fs.existsSync).toBe(true)`. (2) Renamed misleading `createMockMinaProvider` to `createMockChainProvider` in mina-config.test.ts. (3) Strengthened T-34.8-03 privacy test assertions to verify specific SDK call argument values, not just types. (4) Replaced `expect(true).toBe(true)` placeholders in stub tests with `expect.assertions(0)`. All tests (44 passing, 3 skipped stubs) and lint clean after fixes. Story status: done.

## Code Review Record

### Review Pass #1

- **Date:** 2026-03-28
- **Reviewer model:** Claude Opus 4.6 (1M context)
- **Issues found:** 0 critical, 0 high, 2 medium, 3 low (5 total)
- **All issues fixed:** Yes
- **Medium issues:**
  1. Removed invalid `eslint-disable-next-line jest/no-disabled-tests` comments from mina-proofs.test.ts and mina-lightnet.test.ts (rule not configured in project ESLint)
  2. Clarified misleading test description in mina-config.test.ts graceful shutdown test -- deregister does not auto-unsubscribe, caller is responsible
- **Low issues:**
  1. Replaced silent `fs.existsSync` skips with `expect(fs.existsSync).toBe(true)` assertions in static import audit tests
  2. Added registry-based provider resolution assertions to EVM and Solana regression tests in mixed-chain-three-way.test.ts
  3. (Included in fix batch with above items)
- **Outcome:** All 5 issues fixed. 44 tests passing, 3 skipped stubs. Lint clean. Story status: done.

### Review Pass #2

- **Date:** 2026-03-28
- **Reviewer model:** Claude Opus 4.6 (1M context)
- **Issues found:** 0 critical, 0 high, 1 medium, 3 low (4 total)
- **All issues fixed:** Yes
- **Medium issues:**
  1. Aggregate static import audit test (T-34.8-11) still silently skipped missing files via `continue` instead of asserting existence -- replaced with `expect(fs.existsSync(filePath)).toBe(true)` to fail fast on missing core service files
- **Low issues:**
  1. Renamed misleading `createMockMinaProvider` to `createMockChainProvider` in mina-config.test.ts (helper was used for EVM/Solana mock providers too)
  2. Strengthened T-34.8-03 privacy verification test assertions -- now checks specific SDK call argument values (channelId, transferredAmount bigint values, placeholder args) instead of just `typeof` checks
  3. Replaced `expect(true).toBe(true)` placeholder assertions in mina-proofs.test.ts and mina-lightnet.test.ts stubs with `expect.assertions(0)` for explicit stub marking
- **Outcome:** All 4 issues fixed. 44 tests passing, 3 skipped stubs. Lint clean. Story status: done.

### Review Pass #3 (Final)

- **Date:** 2026-03-28
- **Reviewer model:** Claude Opus 4.6 (1M context)
- **Issues found:** 0 critical, 0 high, 0 medium, 1 low (1 total)
- **All issues fixed:** Yes
- **Low issues:**
  1. Removed unnecessary `as any` type casts
- **Semgrep security scan:** 0 findings
- **Outcome:** 1 low issue fixed. Final review pass clean. Story status: done.
