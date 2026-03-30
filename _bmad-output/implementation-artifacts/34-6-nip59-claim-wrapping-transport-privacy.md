# Story 34.6: NIP-59-Inspired Claim Wrapping for Transport Privacy

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **connector operator**,
I want **optional three-layer NIP-59-inspired encryption wrapping for claim messages exchanged over BTP**,
so that **BTP intermediaries cannot observe claim contents, sender identity, or timing -- providing transport-layer privacy alongside Mina's on-chain zk-SNARK privacy**.

**Epic:** 34 -- Mina Protocol Payment Channel Provider (ZK-Private Settlement)
**Priority:** P1
**Estimated effort:** 3 points (~2 dev days)
**Dependencies:** Story 34.5 (MinaPaymentChannelProvider -- done)

## Acceptance Criteria

### AC 1: Three-Layer Wrapping (Rumor -> Seal -> Gift Wrap)

```gherkin
Scenario: Claim wrapped in three layers per NIP-59
  Given a MinaClaimMessage to send to a peer
  When NIP-59 wrapping is enabled in configuration
  Then the claim is wrapped in three layers:
    - Inner (Rumor): unsigned claim payload (deniable)
    - Middle (Seal): encrypted to peer using NIP-44-style ChaCha20, signed by real sender
    - Outer (Gift Wrap): encrypted with ephemeral one-time key, randomized timestamp
```

### AC 2: Gift Wrap Layer Uses Ephemeral Key

```gherkin
Scenario: Gift wrap layer hides sender identity
  Given a wrapped claim is received via BTP protocolData
  When the receiver unwraps the gift wrap layer
  Then an ephemeral key is used for decryption
  And no sender identity is revealed at this layer
```

### AC 3: Seal Layer Verifies Sender

```gherkin
Scenario: Seal layer contains signed rumor
  Given the gift wrap is decrypted
  When the receiver unwraps the seal layer
  Then the real sender's signature is verified
  And the rumor payload is decrypted using shared secret with sender
```

### AC 4: Rumor Contains Valid Claim

```gherkin
Scenario: Rumor contains valid MinaClaimMessage
  Given the seal is decrypted
  When the receiver extracts the rumor
  Then the contained claim message is valid
  And the zk proof (if present) verifies correctly
```

### AC 5: Config Toggle (Disabled = Plaintext)

```gherkin
Scenario: NIP-59 wrapping disabled sends plaintext
  Given NIP-59 wrapping is disabled in configuration
  When a claim is sent
  Then the plaintext claim message is sent via BTP protocolData without wrapping
```

### AC 6: BTP Intermediary Cannot Observe Claim Content

```gherkin
Scenario: Intermediary sees only encrypted bytes
  Given a BTP intermediary observes a wrapped claim in transit
  When the intermediary inspects the protocolData
  Then only encrypted bytes and an ephemeral public key are visible
  And no claim content, sender identity, or balance information is exposed
```

### AC 7: Ephemeral Key Freshness

```gherkin
Scenario: Each wrapping uses a fresh ephemeral key
  Given two successive claims are wrapped
  When the ephemeral keys are compared
  Then they are different (no key reuse across claims)
```

### AC 8: Randomized Gift Wrap Timestamp

```gherkin
Scenario: Gift wrap timestamp is randomized
  Given a claim is wrapped
  When the gift wrap metadata is inspected
  Then the timestamp is within +-48 hours of the actual send time
  And the timestamp does not exactly equal the actual send time (within 1s tolerance)
  And wrapping the same claim twice produces different timestamps
```

### AC 9: Full Round-Trip Correctness

```gherkin
Scenario: Wrap -> transmit -> unwrap -> extract matches original
  Given a MinaClaimMessage
  When wrapped, transmitted via BTP, and unwrapped by the receiver
  Then the extracted claim matches the original exactly
```

### AC 10: Wrong Key Decryption Fails Gracefully

```gherkin
Scenario: Decryption with wrong private key fails gracefully
  Given a wrapped claim encrypted for peer A
  When peer B attempts to unwrap it
  Then decryption fails with a descriptive error (not a crash)
```

## Tasks / Subtasks

- [x] Task 1: Define WrappedClaim types and error class (AC: 1, 6) -- implement FIRST, provides types for Task 2
  - [x] 1.1 Define `WrappedClaim` interface in `nip59-claim-wrapper.ts`:
    ```typescript
    interface WrappedClaim {
      ephemeralPublicKey: string;  // hex-encoded secp256k1 public key
      encryptedPayload: string;    // base64-encoded ChaCha20-Poly1305 ciphertext
      timestamp: number;           // randomized unix timestamp
      version: '1.0';              // protocol version (independent of BTP_CLAIM_PROTOCOL version)
    }
    ```
  - [x] 1.2 Define `NIP59WrapError` custom error class

- [x] Task 2: Create NIP59ClaimWrapper class (AC: 1, 2, 3, 4, 7, 8, 9)
  - [x] 2.1 Create `packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts` (NOTE: The architecture doc calls this `NIP59TransportWrapper` -- use `NIP59ClaimWrapper` as the implementation class name; export an alias `NIP59TransportWrapper = NIP59ClaimWrapper` for architecture-doc consumers)
  - [x] 2.2 Implement `wrapClaim(claim, senderPrivateKey, receiverPublicKey): WrappedClaim`
    - [x] 2.2a Create Rumor: serialize claim to JSON (unsigned, deniable)
    - [x] 2.2b Create Seal: compute shared secret (ECDH with sender + receiver keys), encrypt rumor with ChaCha20-Poly1305, sign with sender's key
    - [x] 2.2c Create Gift Wrap: generate ephemeral secp256k1 keypair, compute shared secret (ECDH with ephemeral + receiver), encrypt seal with ChaCha20-Poly1305, add randomized timestamp
  - [x] 2.3 Implement `unwrapClaim(wrappedClaim, receiverPrivateKey): BTPClaimMessage`
    - [x] 2.3a Decrypt Gift Wrap: ECDH(ephemeral pub, receiver priv) -> ChaCha20 decrypt -> Seal
    - [x] 2.3b Decrypt Seal: extract sender public key, ECDH(sender pub, receiver priv) -> ChaCha20 decrypt -> Rumor, verify sender signature
    - [x] 2.3c Extract Rumor: parse JSON -> BTPClaimMessage
  - [x] 2.4 Ensure each `wrapClaim` call generates a NEW ephemeral keypair (AC 7)
  - [x] 2.5 Randomize gift wrap timestamp: +-48 hours from actual time (AC 8)

- [x] Task 3: Implement BTP serialization for wrapped claims (AC: 5, 6) -- depends on Tasks 1 and 2
  - [x] 3.1 Wrapped claims use `protocolName: 'claim-wrapped'` and `contentType: 0` (APPLICATION_OCTET_STREAM)
  - [x] 3.2 Plaintext claims continue to use `protocolName: 'payment-channel-claim'` and `contentType: 1` (APPLICATION_JSON)
  - [x] 3.3 Add `BTP_WRAPPED_CLAIM_PROTOCOL` constant alongside existing `BTP_CLAIM_PROTOCOL`
  - [x] 3.4 Implement `serializeWrappedClaim(wrapped: WrappedClaim): Buffer` and `deserializeWrappedClaim(data: Buffer): WrappedClaim` -- serialization format is `JSON.stringify(wrapped)` encoded as UTF-8 Buffer (simple, debuggable, and the octet-stream content type refers to the BTP protocolData framing, not a custom binary wire format)

- [x] Task 4: Create unit tests (AC: all)
  - [x] 4.1 Create `packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts`
  - [x] 4.2 T-34.6-01: Three-layer wrapping (rumor -> seal -> gift wrap)
  - [x] 4.3 T-34.6-02: Gift wrap uses ephemeral key, no sender identity revealed
  - [x] 4.4 T-34.6-03: Seal decrypted with shared secret, reveals signed rumor
  - [x] 4.5 T-34.6-04: Rumor contains valid claim message
  - [x] 4.6 T-34.6-05: Each wrap uses a fresh ephemeral key
  - [x] 4.7 T-34.6-06: Full round-trip correctness
  - [x] 4.8 T-34.6-07: Wrapped claim indistinguishable (only encrypted bytes + ephemeral key visible)
  - [x] 4.9 T-34.6-08: NIP-59 disabled -> plaintext claim
  - [x] 4.10 T-34.6-09: NIP-59 enabled -> protocolName 'claim-wrapped' with APPLICATION_OCTET_STREAM
  - [x] 4.11 T-34.6-10: Wrong private key -> graceful error
  - [x] 4.12 T-34.6-11: Wrapping overhead measurement (advisory)
  - [x] 4.13 T-34.6-12: Gift wrap timestamp is randomized
  - [x] 4.14 T-34.6-13: Malformed/truncated WrappedClaim -> graceful error (truncated encryptedPayload, invalid base64, missing ephemeralPublicKey)

- [x] Task 5: Regression gate
  - [x] 5.1 All existing provider tests pass (EVM, Solana, Mina, integration, mixed-chain)
  - [x] 5.2 `npm run build --workspace=packages/shared && npm run build --workspace=packages/connector` clean
  - [x] 5.3 `make test` passes (all project tests green)

## Dev Notes

### Architecture Context -- NIP-59 is Chain-Agnostic

Per the architecture document, `NIP59TransportWrapper` lives in `settlement/privacy/` and is a **transport-layer concern independent of the chain provider**. Although Story 34.6 is part of the Mina epic, the wrapper MUST be chain-agnostic -- it wraps any `BTPClaimMessage` (EVM, Solana, Mina). The `blockchain` discriminator in the claim is inside the encrypted payload, invisible to intermediaries.

The architecture specifies: "Configurable per-peer via `nip59Enabled: true` in peer configuration."

### MinaClaimMessage Stub and validateClaimMessage Caveat

The current `MinaClaimMessage` in `btp-claim-types.ts` is a minimal stub with only `zkAppAddress` and `proof` fields. Story 34.7 will expand it. Additionally, `validateClaimMessage()` currently throws `"Blockchain type 'mina' validation not yet supported"` for Mina claims.

**Implications for this story's tests:**
- Round-trip tests (T-34.6-04, T-34.6-06) MUST use **EVM claim fixtures** as the primary correctness gate, since EVM validation works end-to-end.
- Include at least one test with the Mina stub to prove chain-agnosticism (wrap/unwrap succeeds), but do NOT call `validateClaimMessage()` on the unwrapped Mina claim -- just verify JSON equality.
- Include at least one test with a Solana claim fixture for additional chain-agnostic coverage.
- Do NOT expand `MinaClaimMessage` or modify `validateClaimMessage` -- that is Story 34.7 scope.

### Cryptographic Library: @noble Stack

The architecture lists `@noble/secp256k1` for transport privacy, but the modern replacement is `@noble/curves` (which includes secp256k1 as a submodule). Use `@noble/curves` -- it is actively maintained and provides the same API via `@noble/curves/secp256k1`.

Libraries to use:
- **`@noble/ciphers`** -- ChaCha20-Poly1305 authenticated encryption
- **`@noble/hashes`** -- SHA-256, HKDF for key derivation
- **`@noble/curves`** -- secp256k1 ECDH shared secret computation, ephemeral key generation (import from `@noble/curves/secp256k1`)

The project has `ethereum-cryptography@^3.2.0` (which re-exports @noble packages). Import directly from `@noble/*` for clarity and explicit dependency management.

**CRITICAL: Do NOT use Node.js built-in `crypto` module for the core wrapping.** The @noble stack provides constant-time implementations and is audited. Node.js crypto is acceptable for randomness (`crypto.randomBytes`) only.

### Three-Layer Wrapping Detail

```
Original Claim (BTPClaimMessage)
    |
    v
[Rumor] = JSON.stringify(claim)  -- unsigned, deniable
    |
    v
[Seal]  = ChaCha20-Poly1305(
            key: ECDH(senderPriv, receiverPub) -> HKDF-SHA256,
            plaintext: Rumor,
            aad: senderPublicKey  -- authenticated additional data
          ) + senderSignature(ciphertext)
    |
    v
[Gift Wrap] = ChaCha20-Poly1305(
               key: ECDH(ephemeralPriv, receiverPub) -> HKDF-SHA256,
               plaintext: Seal + senderPublicKey + senderSignature,
               aad: none
             ) + ephemeralPublicKey + randomizedTimestamp
```

**Key derivation:** Use HKDF-SHA256 to derive the ChaCha20 key from the ECDH shared secret. The HKDF info parameter should include context bytes (e.g., `"nip59-seal"` or `"nip59-giftwrap"`) to domain-separate the two encryption layers.

**Nonce strategy:** ChaCha20-Poly1305 requires a 12-byte nonce. Generate randomly via `crypto.randomBytes(12)` for each encryption. Include the nonce prepended to the ciphertext.

**Nonce collision safety:** The Gift Wrap layer uses a fresh ephemeral key per message, so each derived key is unique -- nonce collision is impossible. The Seal layer reuses the same ECDH-derived key for a given sender-receiver pair across multiple claims. With 12-byte random nonces, birthday collision probability reaches 1% after ~2^48 messages under the same key. At ILP per-packet claim rates this is astronomically unlikely. Random nonces are sufficient -- no counter-based scheme is needed.

### Unwrapping Flow (Receiver Side)

1. Receiver gets `WrappedClaim` from BTP protocolData (`protocolName: 'claim-wrapped'`)
2. Extract `ephemeralPublicKey` from wrapped claim
3. Compute `sharedSecret = ECDH(receiverPrivateKey, ephemeralPublicKey)`
4. Derive `key = HKDF(sharedSecret, info="nip59-giftwrap")`
5. Decrypt Gift Wrap ciphertext with ChaCha20-Poly1305 -> reveals Seal + senderPublicKey + senderSignature
6. Verify senderSignature over Seal ciphertext
7. Compute `sharedSecret2 = ECDH(receiverPrivateKey, senderPublicKey)`
8. Derive `key2 = HKDF(sharedSecret2, info="nip59-seal")`
9. Decrypt Seal ciphertext with ChaCha20-Poly1305 -> reveals Rumor (JSON)
10. Parse Rumor JSON -> `BTPClaimMessage`

### File Locations (Exact Paths)

| File | Action | Purpose |
|------|--------|---------|
| `packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts` | CREATE | NIP59ClaimWrapper class + WrappedClaim types + serialization |
| `packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts` | CREATE | Unit tests (13 test IDs: T-34.6-01 through T-34.6-13) |
| `packages/connector/src/settlement/privacy/index.ts` | CREATE | Barrel exports for privacy module (do NOT update `settlement/index.ts` or `lib.ts` -- Story 34.8 will wire the privacy module into the settlement barrel when integrating with the claim pipeline) |

### Existing Files -- Do NOT Modify (This Story)

| File | Reason |
|------|--------|
| `packages/connector/src/btp/btp-claim-types.ts` | Story 34.7 scope -- claim type expansion |
| `packages/connector/src/settlement/claim-sender.ts` | Deprecated, not the active claim path |
| `packages/connector/src/settlement/claim-receiver.ts` | Integration with NIP-59 unwrapping is Story 34.8 scope |
| `packages/connector/src/settlement/per-packet-claim-service.ts` | Wiring NIP-59 into the pipeline is Story 34.8 scope |
| `packages/connector/src/config/` | Config schema for `nip59Enabled` is deferred to Story 34.8 |

This story creates the **standalone wrapper module** only. Integration with the claim pipeline (ClaimReceiver, PerPacketClaimService, config schema) is done in Story 34.8.

### BTP Protocol Name Convention

The existing `BTP_CLAIM_PROTOCOL` in `btp-claim-types.ts`:
```typescript
export const BTP_CLAIM_PROTOCOL = {
  NAME: 'payment-channel-claim',
  CONTENT_TYPE: 1,   // APPLICATION_JSON
  VERSION: '1.0',
} as const;
```

Add a new constant in the wrapper file (or a shared location):
```typescript
export const BTP_WRAPPED_CLAIM_PROTOCOL = {
  NAME: 'claim-wrapped',
  CONTENT_TYPE: 0,   // APPLICATION_OCTET_STREAM
  VERSION: '1.0',
} as const;
```

### Testing Approach

Tests use real secp256k1 keypairs generated in the test setup. No mocking of crypto -- test the actual encryption/decryption path.

```typescript
import { secp256k1 } from '@noble/curves/secp256k1';
import { randomBytes } from 'crypto';

// Generate test keypairs
const senderPrivKey = randomBytes(32);
const senderPubKey = secp256k1.getPublicKey(senderPrivKey, true); // compressed
const receiverPrivKey = randomBytes(32);
const receiverPubKey = secp256k1.getPublicKey(receiverPrivKey, true);
```

For T-34.6-08/09 (config toggle), test the wrapper's static method or factory that checks a boolean flag and either wraps or passes through.

**Chain-agnostic test fixtures:** To prove the wrapper is chain-agnostic, tests MUST include fixtures for multiple blockchain types:
- **EVM claim fixture** -- use as the primary round-trip correctness fixture (full `validateClaimMessage` works for EVM)
- **Solana claim fixture** -- secondary round-trip to prove chain-agnosticism
- **Mina claim stub fixture** -- wrap/unwrap succeeds and JSON equality holds, but do NOT call `validateClaimMessage` (it throws for Mina until Story 34.7)

### Error Handling

- `NIP59WrapError` extends `Error` with `name = 'NIP59WrapError'`
- Wrapping errors: invalid keys, serialization failures
- Unwrapping errors: decryption failure (wrong key), signature verification failure, invalid JSON payload
- All errors must be descriptive (include which layer failed) and preserve original error as `cause`
- **NEVER log decrypted claim content** in error paths -- only log the error type and layer

### Pino Logging Format

```typescript
this._logger.info(
  { event: 'nip59_wrap', claimMessageId: claim.messageId },
  'Wrapping claim with NIP-59 Gift Wrap'
);

this._logger.warn(
  { event: 'nip59_unwrap_failed', layer: 'gift_wrap', error: err.message },
  'Failed to unwrap NIP-59 gift wrap layer'
);
```

Follow project convention: structured fields FIRST, message string SECOND. Use `event:` field for structured log queries. **NEVER log private keys, shared secrets, or decrypted content.**

### Project Structure Notes

- New directory `packages/connector/src/settlement/privacy/` -- this is the first file in this directory
- Co-locate test file with source: `nip59-claim-wrapper.test.ts` next to `nip59-claim-wrapper.ts`
- Create `index.ts` barrel in the privacy directory
- Build order: `packages/shared` first, then `packages/connector`
- The wrapper does NOT depend on o1js, @solana/kit, or ethers -- it uses only @noble crypto libraries

### Dependencies to Add

The project has `ethereum-cryptography@^3.2.0` which re-exports @noble packages, but this story requires direct @noble imports. Add these to `packages/connector/package.json` if not already present:

```bash
npm install @noble/ciphers @noble/hashes @noble/curves --workspace=packages/connector
```

Verify after install: `@noble/curves` provides `@noble/curves/secp256k1` (ECDH + key generation), `@noble/ciphers` provides `chacha20poly1305`, `@noble/hashes` provides `sha256` and `hkdf`.

### secp256k1 Key Format

- Private keys: 32-byte `Uint8Array`
- Public keys: 33-byte compressed secp256k1 (hex-encoded in `WrappedClaim.ephemeralPublicKey`)
- ECDH shared secret: use `secp256k1.getSharedSecret(privateKey, publicKey)` -> returns 33-byte compressed point -> take x-coordinate (bytes 1-32) as the raw shared secret
- Key derivation: HKDF-SHA256 with the raw shared secret as input keying material

### Signature Scheme for Seal

The sender signs the Seal ciphertext (not the plaintext) to prove:
1. The sender encrypted this specific ciphertext
2. The ciphertext has not been tampered with (in addition to Poly1305 authentication)

Use `secp256k1.sign(messageHash, privateKey)` where `messageHash = SHA-256(sealCiphertext)`. The signature is compact (64 bytes) + recovery byte.

### Pattern Reference: Solana Provider as Structural Guide

While the NIP-59 wrapper is not a chain provider, follow similar class structure patterns:
- Constructor-based dependency injection (logger, optional config)
- Private `_logger` field
- Public methods with clear JSDoc
- Custom error class with `name` set
- Factory function or static create method

### Previous Story Intelligence

**From Story 34.5 (most recent in epic):**
- 71 tests passing (after code review fixes)
- Provider class ~660 lines, test file ~1500 lines
- `MinaPaymentChannelProvider` is fully functional with `PaymentChannelProvider` interface
- `MinaClaimMessage` stub exists in `btp-claim-types.ts` with `blockchain: 'mina'`, `zkAppAddress`, `proof`
- The claim receiver dispatches to the correct provider based on `blockchain` discriminator
- `getMinaContext()` returns `{ zkAppAddress, tokenId, network, signerAddress }`

**From Story 34.5 code review:**
- Security review (Semgrep clean) identified private key leak in `getMinaContext()` which was fixed to return `_zkAppAddress`
- `verifyBalanceProof` swallowed errors silently -- fixed to log warnings
- Constructor validates `signerKey` parameter
- These are relevant patterns: validate inputs, don't leak secrets, log errors properly

### Git Intelligence

Recent commits on `epic-34`:
```
ee13667a feat(34-5): Implement MinaPaymentChannelProvider -- story complete
3d15ef7c feat(34-3): Mina payment channel zkApp -- tests & deployment
be83f83e feat(34-2): Mina payment channel zkApp -- zk-private claims
71a10f3e feat(34-1): Mina payment channel zkApp -- channel lifecycle
55f688b2 chore(epic-34): epic start -- baseline green, retro actions resolved
```

Expected commit: `feat(34-6): NIP-59-inspired claim wrapping for transport privacy`

### Cross-Story Dependencies

- **Story 34.5** (MinaPaymentChannelProvider) -- DONE -- this story depends on it
- **Story 34.7** (Claim Message Types) -- will expand `MinaClaimMessage` and add serialization; can run in parallel with this story
- **Story 34.8** (Integration Tests E2E) -- will wire NIP-59 into the claim pipeline and test end-to-end round-trips

### References

- [Source: _bmad-output/planning-artifacts/epic-34-mina-protocol-payment-channel-provider.md#Story 34.6]
- [Source: _bmad-output/planning-artifacts/test-design-epic-34.md#Story 34.6 -- T-34.6-01 through T-34.6-12]
- [Source: _bmad-output/planning-artifacts/architecture.md#NIP-59 Transport Privacy]
- [Source: _bmad-output/planning-artifacts/architecture.md#Tech Stack -- Transport Privacy libraries]
- [Source: _bmad-output/project-context.md -- Testing Rules, Critical Implementation Rules]
- [Source: _bmad-output/implementation-artifacts/34-5-implement-mina-payment-channel-provider.md -- previous story learnings]
- [Source: packages/connector/src/btp/btp-claim-types.ts -- BTP_CLAIM_PROTOCOL constant, BTPClaimMessage union type]
- [Source: packages/connector/src/btp/btp-types.ts -- BTPProtocolData interface]

## Preconditions

- Story 34.5 (MinaPaymentChannelProvider) is complete (status: done)
- Stories 34.1-34.3 are complete (zkApp verified and tested)
- Epic 32 is complete (PaymentChannelProvider interface, ChainProviderRegistry)
- @noble crypto libraries available (add if not already in package.json)

## Out of Scope

- Modifying `MinaClaimMessage` in `btp-claim-types.ts` (Story 34.7)
- Wiring NIP-59 into `ClaimReceiver` or `PerPacketClaimService` (Story 34.8)
- Config schema changes for `nip59Enabled` peer config (Story 34.8)
- Integration tests through the full connector pipeline (Story 34.8)
- EVM or Solana chain-specific **integration** tests through the full connector pipeline (Story 34.8 scope); unit-level chain-agnostic fixture tests using EVM/Solana/Mina claims ARE in scope for this story

## Test Plan

Reference: [Source: _bmad-output/planning-artifacts/test-design-epic-34.md#Story 34.6]

| Test ID | Scenario | Type | Priority | File |
|---------|----------|------|----------|------|
| T-34.6-01 | Three-layer wrapping (rumor -> seal -> gift wrap) | Unit | P0 | nip59-claim-wrapper.test.ts |
| T-34.6-02 | Gift wrap uses ephemeral key, no sender identity | Unit | P0 | nip59-claim-wrapper.test.ts |
| T-34.6-03 | Seal decrypted with shared secret, reveals signed rumor | Unit | P0 | nip59-claim-wrapper.test.ts |
| T-34.6-04 | Rumor contains valid claim message | Unit | P0 | nip59-claim-wrapper.test.ts |
| T-34.6-05 | Each wrap uses fresh ephemeral key | Unit | P0 | nip59-claim-wrapper.test.ts |
| T-34.6-06 | Full round-trip correctness | Unit | P0 | nip59-claim-wrapper.test.ts |
| T-34.6-07 | Wrapped claim indistinguishable (encrypted bytes + ephemeral key only) | Unit | P1 | nip59-claim-wrapper.test.ts |
| T-34.6-08 | NIP-59 disabled -> plaintext claim | Unit | P0 | nip59-claim-wrapper.test.ts |
| T-34.6-09 | NIP-59 enabled -> claim-wrapped with APPLICATION_OCTET_STREAM | Unit | P0 | nip59-claim-wrapper.test.ts |
| T-34.6-10 | Wrong private key -> graceful error | Unit | P1 | nip59-claim-wrapper.test.ts |
| T-34.6-11 | Wrapping overhead measurement (advisory) | Unit | P2 | nip59-claim-wrapper.test.ts |
| T-34.6-12 | Gift wrap timestamp is randomized | Unit | P1 | nip59-claim-wrapper.test.ts |
| T-34.6-13 | Malformed/truncated WrappedClaim -> graceful error | Unit | P1 | nip59-claim-wrapper.test.ts |

### Regression Gate

- All existing provider tests pass: EVM, Solana, Mina provider suites
- All integration tests pass: mixed-chain routing, provider integration
- `npm run build --workspace=packages/shared && npm run build --workspace=packages/connector` clean
- `make test` passes (all project tests green)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context) -- claude-opus-4-6[1m]

### Debug Log References

None required -- all tests passed on first implementation attempt.

### Completion Notes List

- Task 1: Defined `WrappedClaim` interface with ephemeralPublicKey (hex), encryptedPayload (base64), timestamp (randomized), version fields. Defined `NIP59WrapError` custom error class with `name`, `cause` support, and `Error.captureStackTrace`.
- Task 2: Implemented `NIP59ClaimWrapper` class with full three-layer wrapping (Rumor/Seal/Gift Wrap). Uses @noble/curves secp256k1 for ECDH and signing, @noble/ciphers ChaCha20-Poly1305 for authenticated encryption, @noble/hashes HKDF-SHA256 for key derivation with domain-separated info strings ("nip59-seal" / "nip59-giftwrap"). Ephemeral keypair generated fresh per wrap. Timestamp randomized +-48h. Exported `NIP59TransportWrapper` alias for architecture-doc consumers.
- Task 3: Implemented `BTP_WRAPPED_CLAIM_PROTOCOL` constant (NAME: 'claim-wrapped', CONTENT_TYPE: 0, VERSION: '1.0'). Implemented `serializeWrappedClaim` and `deserializeWrappedClaim` with JSON.stringify/parse over UTF-8 Buffer. Existing BTP_CLAIM_PROTOCOL unchanged.
- Task 4: 44 unit tests across 13 test IDs (T-34.6-01 through T-34.6-13) plus alias test and gap-coverage tests for ACs 3, 5, 6, 9. Tests use real secp256k1 keypairs, no crypto mocking. Chain-agnostic coverage with EVM, Solana, and Mina claim fixtures. Uses `pino({ level: 'silent' })` for mock logger per project standards.
- Task 5: Full regression suite passed -- 93 test suites, 2302 tests (3 skipped, pre-existing). Build clean for both shared and connector packages. Lint clean.

### File List

- `packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts` -- CREATED -- NIP59ClaimWrapper class, WrappedClaim types, NIP59WrapError, BTP_WRAPPED_CLAIM_PROTOCOL, serialization functions, NIP59TransportWrapper alias
- `packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts` -- MODIFIED -- Fixed TypeScript strict null issues (added wrapClaimNonNull helper, replaced nullable wrapper.wrapClaim calls)
- `packages/connector/src/settlement/privacy/index.ts` -- CREATED -- Barrel exports for privacy module
- `packages/connector/package.json` -- MODIFIED -- Added @noble/ciphers, @noble/hashes, @noble/curves dependencies

### Senior Developer Review (AI)

**Reviewer:** Jonathan (via Claude Opus 4.6 code review workflow)
**Date:** 2026-03-28
**Outcome:** Approved (all issues fixed)

**Issues Found & Fixed:**
- **MEDIUM** (2 fixed):
  1. `deserializeWrappedClaim` did not wrap `JSON.parse` errors in `NIP59WrapError` -- raw `SyntaxError` leaked to callers. Fixed by wrapping in try/catch with `NIP59WrapError`.
  2. Mock logger used plain `jest.fn()` objects instead of `pino({ level: 'silent' })` per project testing standards. Fixed.
- **LOW** (2 fixed):
  1. Story completion notes reported "35 unit tests" but actual count is 44. Fixed to reflect accurate count.
  2. Test for `deserializeWrappedClaim` with garbage buffer only asserted `.toThrow()` (any error) rather than `.toThrow(NIP59WrapError)`. Fixed to assert specific error type.

**Verification:**
- Semgrep scan: clean (0 findings)
- ESLint: clean
- All 44 NIP-59 tests pass
- Full regression: 93 suites, 2311 tests pass (3 suites skipped, pre-existing)

### Change Log

- 2026-03-28: Code review #3 -- ephemeral key zeroing after use, rumor payload runtime validation, encryptedPayload presence check in unwrapClaim, deserializeWrappedClaim JSDoc @throws fix, replaced console.log in test with assertion, added 2 new tests (46 total)
- 2026-03-28: Code review #2 -- added senderPublicKey as AAD to seal layer ChaCha20-Poly1305 encryption/decryption, corrected _verifyCiphertext JSDoc @throws to NIP59WrapError
- 2026-03-28: Code review #1 -- fixed deserializeWrappedClaim error wrapping, mock logger pattern, test assertion specificity, stale completion notes
- 2026-03-28: Implemented Story 34.6 -- NIP-59-inspired three-layer claim wrapping for transport privacy. Created standalone NIP59ClaimWrapper module in settlement/privacy/ with ChaCha20-Poly1305 encryption, secp256k1 ECDH key exchange, HKDF-SHA256 key derivation, ephemeral key generation, and randomized timestamps. 35 tests passing across all 13 test IDs. Chain-agnostic -- wraps EVM, Solana, and Mina claims identically.

## Code Review Record

### Review Pass #1

- **Date:** 2026-03-28
- **Reviewer model:** Claude Opus 4.6 (1M context) -- claude-opus-4-6[1m]
- **Issue counts:** 0 critical, 0 high, 2 medium, 2 low (4 total, all fixed)
- **Outcome:** Approved (all issues fixed)

**Issues found & fixed:**

| # | Severity | Description | Resolution |
|---|----------|-------------|------------|
| 1 | MEDIUM | `deserializeWrappedClaim` leaked raw `SyntaxError` instead of `NIP59WrapError` for malformed JSON | Wrapped `JSON.parse` in try/catch, re-throws as `NIP59WrapError` |
| 2 | MEDIUM | Mock logger used plain `jest.fn()` instead of `pino({ level: 'silent' })` per project testing standards | Replaced with `pino({ level: 'silent' })` |
| 3 | LOW | Test for garbage buffer deserialization only asserted `.toThrow()` instead of `.toThrow(NIP59WrapError)` | Updated assertion to check specific error type |
| 4 | LOW | Story completion notes reported "35 unit tests" but actual count is 44 | Corrected count in completion notes |

**Verification after fixes:**
- Semgrep scan: clean (0 findings)
- ESLint: clean
- All 44 NIP-59 tests pass
- Full regression: 93 suites, 2311 tests pass (3 suites skipped, pre-existing)

### Review Pass #2

- **Date:** 2026-03-28
- **Reviewer model:** Claude Opus 4.6 (1M context) -- claude-opus-4-6[1m]
- **Issue counts:** 0 critical, 0 high, 1 medium, 1 low (2 total, all fixed)
- **Outcome:** Approved (all issues fixed)

**Issues found & fixed:**

| # | Severity | Description | Resolution |
|---|----------|-------------|------------|
| 1 | MEDIUM | Seal layer ChaCha20-Poly1305 encryption missing `senderPublicKey` as AAD (authenticated additional data) per story design spec -- seal should bind sender identity to ciphertext at the AEAD level | Added `senderPublicKey` as AAD via `chacha20poly1305(key, nonce, senderPublicKey)` in both `_encryptSeal` and `_decryptSeal`; refactored `_encryptSeal` to accept pre-computed sender public key to avoid redundant derivation |
| 2 | LOW | `_verifyCiphertext` JSDoc `@throws` annotation said `Error` instead of `NIP59WrapError` | Corrected to `@throws NIP59WrapError` |

**Verification after fixes:**
- Semgrep scan: clean (0 findings)
- TypeScript compilation: clean (no errors)
- All 44 NIP-59 tests pass
- Full regression: 93 suites, 2311 tests pass (3 suites skipped, pre-existing)

### Review Pass #3

- **Date:** 2026-03-28
- **Reviewer model:** Claude Opus 4.6 (1M context) -- claude-opus-4-6[1m]
- **Issue counts:** 0 critical, 0 high, 2 medium, 3 low (5 total, all fixed)
- **Outcome:** Approved (all issues fixed)
- **Security scan:** Semgrep default rules clean; custom rules for OWASP top 10 (injection, crypto hygiene, key management) executed
- **OWASP assessment:** No injection risks (inputs are encrypted/authenticated via AEAD), no authentication/authorization flaws (ECDH + signature verification), no sensitive data exposure (ephemeral keys zeroed, no logging of secrets)

**Issues found & fixed:**

| # | Severity | Description | Resolution |
|---|----------|-------------|------------|
| 1 | MEDIUM | Ephemeral private key not zeroed after use in `wrapClaim` -- key material persists in memory until GC, risk of exposure via memory dump | Added `ephemeralPrivKey.fill(0)` after gift wrap encryption completes |
| 2 | MEDIUM | `unwrapClaim` returns `JSON.parse` result cast as `BTPClaimMessage` with no runtime validation -- attacker with compromised sender key could inject arbitrary JSON | Added runtime validation of required `BTPClaimMessage` base fields (version, blockchain, messageId, timestamp, senderId) after JSON parse |
| 3 | LOW | `unwrapClaim` validates `ephemeralPublicKey` presence but not `encryptedPayload` -- missing field would cause unclear error downstream | Added explicit `encryptedPayload` presence check with descriptive `NIP59WrapError` |
| 4 | LOW | `deserializeWrappedClaim` JSDoc says `@throws Error` instead of `@throws NIP59WrapError` | Corrected to `@throws NIP59WrapError` |
| 5 | LOW | Test T-34.6-11 uses `console.log` (suppressed via eslint-disable) to output overhead measurement, violating project `no-console` rule | Replaced with assertion-only approach: `expect(overheadRatio).toBeLessThan(10)` upper bound check |

**New tests added:**
- `missing encryptedPayload throws NIP59WrapError` (T-34.6-13 gap)
- `rumor with invalid JSON structure (not a BTPClaimMessage) throws NIP59WrapError` (T-34.6-13 gap)

**Verification after fixes:**
- Semgrep scan: clean (0 findings, default + custom OWASP rules)
- TypeScript compilation: clean (no errors)
- ESLint: clean (no warnings)
- All 46 NIP-59 tests pass (44 original + 2 new)
- Build: `npm run build --workspace=packages/connector` clean
