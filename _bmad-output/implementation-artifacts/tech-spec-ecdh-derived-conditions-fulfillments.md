---
title: 'ECDH-Derived Conditions & Fulfillments for ILP Packets'
slug: 'ecdh-derived-conditions-fulfillments'
created: '2026-03-29'
status: 'implementation-complete'
stepsCompleted: [1, 2, 3, 4]
tech_stack: ['TypeScript', 'secp256k1 (@noble/curves)', 'HKDF-SHA256 (@noble/hashes)', 'ChaCha20-Poly1305 (@noble/ciphers)', 'Vitest']
files_to_modify:
  - 'packages/shared/src/types/ilp.ts'
  - 'packages/shared/src/encoding/oer.ts'
  - 'packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts'
  - 'packages/connector/src/core/packet-handler.ts'
  - 'packages/connector/src/settlement/per-packet-claim-service.ts'
code_patterns:
  - 'ECDH via secp256k1.getSharedSecret() → slice(1) for x-coord → hkdf(sha256, secret, undefined, INFO, 32)'
  - 'OER fixed octet string: encodeFixedOctetString(buffer, 32) / decodeFixedOctetString(buffer, offset, 32)'
  - 'NIP-59 gift wrap layer uses ephemeral keypair + ECDH + HKDF with info=nip59-giftwrap'
  - 'PacketHandler.handlePreparePacket() is the main forwarding method (line 790+)'
  - 'PerPacketClaimService NIP-59 wrapping at lines 281-309 — condition derivation hooks here'
test_patterns:
  - 'Vitest with describe/it blocks, co-located test files (*.test.ts)'
  - 'Existing: oer.test.ts, nip59-claim-wrapper.test.ts, packet-handler.test.ts'
  - 'Existing: per-packet-claim-service.test.ts, claim-receiver.atdd.test.ts'
adversarial_review: 'completed 2026-03-29, 15 findings addressed'
---

# Tech-Spec: ECDH-Derived Conditions & Fulfillments for ILP Packets

**Created:** 2026-03-29

## Overview

### Problem Statement

Currently, ILP packets write 32 zero bytes for `executionCondition` (PREPARE) and `fulfillment` (FULFILL) fields — see `packages/shared/src/encoding/oer.ts`. While self-described claims handle payment verification, there is no cryptographic proof that the actual receiver generated the FULFILL. Any intermediary node could fabricate a FULFILL with zero bytes and the sender would have no way to detect the forgery.

### Solution

Re-enable ILPv4 conditions and fulfillments with a novel ECDH-derived preimage scheme that unifies with existing NIP-59 gift wrapping. A single ephemeral key per packet derives both the claim encryption key and the condition preimage via dual HKDF derivation. This binds the fulfillment to the receiver's identity (only someone with the receiver's private key can derive the preimage) — which is stronger than classic ILP conditions where the preimage is just an arbitrary shared secret.

### Scope

**In Scope:**
- Add optional `executionCondition` and `fulfillment` fields to ILP packet interfaces (backward compatible)
- Real OER serialization/deserialization of these fields (replacing zero-byte stubs), defaulting to 32 zero bytes when fields are absent
- Dual HKDF derivation in NIP-59 wrapper (encryption key + condition preimage from same ECDH shared secret)
- Sender-side fulfillment verification on return path (local variable, no map needed)
- Intermediary condition pass-through with SHA-256 verification on return path
- Receiver-side preimage derivation and fulfillment injection (synchronous, in PacketHandler receive path)
- Per-packet claim service threading condition into PREPARE
- Backward compatibility: NIP-59 disabled → zero-byte conditions, no verification

**Out of Scope:**
- Changes to self-described claim formats (EVM/Solana/Mina claim types unchanged)
- Changes to settlement providers or on-chain contracts

## Context for Development

### Codebase Patterns

- **ECDH pattern**: `secp256k1.getSharedSecret(privKey, pubKey, true).slice(1)` → 32-byte x-coord shared secret
- **HKDF pattern**: `hkdf(sha256, sharedSecret, undefined, INFO_STRING, 32)` — no salt, info string differentiates derivations
- **OER fixed fields**: `encodeFixedOctetString(buffer, 32)` for 32-byte fields, `decodeFixedOctetString(buffer, offset, 32)` to read
- **NIP-59 gift wrap layer**: ephemeral keypair generated with `randomBytes(32)`, zeroed after use (`ephemeralPrivKey.fill(0)`)
- **PacketHandler forwarding**: `handlePreparePacket()` (line 790) → validate → route → generate claim → `forwardToNextHop()` → return response. Response is currently returned without condition verification.
- **PacketHandler local delivery**: auto-fulfill stub (line 926) and BLS handler (line 907) both construct `ILPFulfillPacket`. These need to include the derived preimage as `fulfillment`.
- **PerPacketClaimService NIP-59 path**: lines 281-309 — checks `_nip59Wrapper?.isEnabled()`, calls `wrapClaim()`, returns as `BTP_WRAPPED_CLAIM_PROTOCOL` protocolData
- **Packet construction via spread**: `forwardingPacket = { ...packet, expiresAt: newExpiry }` (line 1073) — spread naturally copies `executionCondition` if present, so intermediaries forward it without extra logic.
- Peer secp256k1 public keys configured via `nip59PublicKey` in peer config
- Node private key derived from treasury key in `connector-node.ts` (lines 783-803)

### Files to Reference

| File | Purpose | Anchor Points |
| ---- | ------- | ------------- |
| `packages/shared/src/types/ilp.ts` | ILP packet type definitions | `ILPPreparePacket` (line 61), `ILPFulfillPacket` (line 87) — add optional fields |
| `packages/shared/src/encoding/oer.ts` | OER serialization | `serializePrepare` (line 378, zero-byte at 383), `serializeFulfill` (line 406, zero-byte at 409), `deserializePrepare` (line 495, skip at 520), `deserializeFulfill` (line 563, skip at 580) |
| `packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts` | NIP-59 three-layer wrapping | `wrapClaim()` (line 174), `_encryptGiftWrap` (line 419), `_decryptGiftWrap` (line 441), `_computeSharedSecret` (line 463). Constants at line 126. |
| `packages/connector/src/core/packet-handler.ts` | Packet forwarding + response handling | `handlePreparePacket()` (line 790), auto-fulfill (line 926), BLS delivery (line 907), `forwardToNextHop()` (line 649), forwarding packet construction (line 1073), claim generation (line 1147), forward+return (line 1187-1206) |
| `packages/connector/src/settlement/per-packet-claim-service.ts` | Per-packet claim generation | NIP-59 wrapping block (lines 281-309), `PerPacketClaimResult` interface (line 85) |

### Test Files

| Test File | Tests For |
| --------- | --------- |
| `packages/shared/src/types/ilp.test.ts` | Packet type definitions — update for new optional fields |
| `packages/shared/src/encoding/oer.test.ts` | OER encoding/decoding — update for real condition/fulfillment bytes |
| `packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts` | NIP-59 wrapper — add dual derivation tests |
| `packages/connector/src/core/packet-handler.test.ts` | PacketHandler — add condition/fulfillment verification tests |
| `packages/connector/src/settlement/per-packet-claim-service.test.ts` | Claim service — add condition threading tests |

### Technical Decisions

1. **Unified ECDH derivation**: Single ephemeral key derives both claim encryption key (`info='nip59-giftwrap'`) and condition preimage (`info='ilp-condition-preimage'`) via HKDF-SHA256. Zero additional bytes on the wire — preimage is implicit in the ephemeral key already sent.
2. **NIP-59 hard requirement for conditions**: Condition/fulfillment only works with NIP-59 enabled. Without NIP-59, conditions remain as 32 zero bytes (existing behavior, fully backward compatible).
3. **Identity-bound fulfillment**: Unlike classic ILP where preimage is an arbitrary secret, our preimage is derived from `ECDH(receiver_priv, ephemeral_pub)` — only the receiver can compute it.
4. **Intermediary verification**: Intermediary connectors verify `SHA-256(fulfillment) == condition` on the return path. The condition is already on the `forwardingPacket` local variable — no map or state storage needed.
5. **Optional fields with OER defaults**: `executionCondition` and `fulfillment` are optional on the TypeScript interfaces. OER serialization uses `packet.executionCondition ?? Buffer.alloc(32)` and `packet.fulfillment ?? Buffer.alloc(32)`. This means zero callsite breakage — all existing code that constructs packets without these fields continues to work.
6. **Zero-byte condition = skip verification**: If `executionCondition` is all zeros (NIP-59 disabled or legacy peer), fulfillment verification is skipped. Checked via `Buffer.from(condition).every(b => b === 0)`.
7. **Synchronous preimage injection on receiver**: The receiver derives the preimage in the PacketHandler's local delivery path (same synchronous call stack as FULFILL construction), NOT via async ClaimReceiver events. The NIP-59 wrapper's `unwrapClaimWithPreimage()` is called directly in the receive path, and the preimage is set on the FULFILL before returning.
8. **`_decryptGiftWrap` refactoring**: Refactor to return `{ plaintext: Uint8Array, sharedSecret: Uint8Array }` instead of just `Uint8Array`, so `unwrapClaimWithPreimage()` can derive the preimage from the same shared secret without re-computing ECDH.
9. **Return type changes**: New `WrapClaimResult` interface from `wrapClaimWithCondition()`. `PerPacketClaimResult` gains optional `executionCondition` field.

## Implementation Plan

### Tasks

- [x] **Task 1: Add optional `executionCondition` and `fulfillment` fields to ILP packet interfaces**
  - File: `packages/shared/src/types/ilp.ts`
  - Action:
    - Add `executionCondition?: Uint8Array` to `ILPPreparePacket` interface (after `expiresAt`). JSDoc: "SHA-256 condition hash (32 bytes). Present when NIP-59 is enabled. Omit or pass undefined for legacy zero-byte behavior."
    - Add `fulfillment?: Uint8Array` to `ILPFulfillPacket` interface (after `type`). JSDoc: "Preimage (32 bytes) that satisfies SHA-256(fulfillment) === condition. Present when NIP-59 is enabled."
    - Update JSDoc on both interfaces to remove "legacy/unused" language for the wire format fields.
    - Fix existing JSDoc example in `isFulfillPacket` (line 256) — `packet.fulfillment` will now be valid.
    - **No changes to type guards** — they check `type` discriminator only, not field presence.
  - Callsite impact: **Zero** — both fields are optional (`?`), so all existing code that constructs `ILPPreparePacket` or `ILPFulfillPacket` without these fields compiles unchanged.
  - Tests: Update `packages/shared/src/types/ilp.test.ts` — add tests that packets with and without optional fields both pass type guards.

- [x] **Task 2: Enable real OER serialization/deserialization of condition and fulfillment**
  - File: `packages/shared/src/encoding/oer.ts`
  - Action:
    - `serializePrepare()` (line 383): Replace `Buffer.alloc(32)` with `encodeFixedOctetString(Buffer.from(packet.executionCondition ?? Buffer.alloc(32)), 32)`. The `?? Buffer.alloc(32)` ensures backward compatibility when the field is omitted.
    - `serializeFulfill()` (line 409): Replace `Buffer.alloc(32)` with `encodeFixedOctetString(Buffer.from(packet.fulfillment ?? Buffer.alloc(32)), 32)`. Same default.
    - `deserializePrepare()` (line 520-522): Change from skip to `const { value: executionCondition, bytesRead: conditionBytes } = decodeFixedOctetString(buffer, offset, 32)`. Include `executionCondition: new Uint8Array(executionCondition)` in the returned object.
    - `deserializeFulfill()` (line 580-582): Change from skip to `const { value: fulfillment, bytesRead: fulfillmentBytes } = decodeFixedOctetString(buffer, offset, 32)`. Include `fulfillment: new Uint8Array(fulfillment)` in the returned object.
  - Tests: Update `packages/shared/src/encoding/oer.test.ts`:
    - Update existing round-trip tests to verify condition/fulfillment bytes are preserved (not zero).
    - Add test: serialize PREPARE without `executionCondition` field → deserialize → verify 32 zero bytes in output (backward compat).
    - Add test: serialize PREPARE with known 32-byte condition → deserialize → bytes match exactly.
    - Add test: serialize FULFILL without `fulfillment` field → deserialize → verify 32 zero bytes (backward compat).
    - Add test: serialize FULFILL with known 32-byte fulfillment → deserialize → bytes match exactly.

- [x] **Task 3: Add dual HKDF derivation to NIP-59 wrapper**
  - File: `packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts`
  - Action:
    - Add constant: `const CONDITION_HKDF_INFO = 'ilp-condition-preimage';` (after line 126).
    - Create new interface `WrapClaimResult`: `{ wrapped: WrappedClaim; executionCondition: Uint8Array; }`.
    - Create new interface `UnwrapClaimResult`: `{ claim: BTPClaimMessage; fulfillmentPreimage: Uint8Array; }`.
    - **Refactor `_decryptGiftWrap()`** to return `{ plaintext: Uint8Array; sharedSecret: Uint8Array }` instead of just `Uint8Array`. Update `unwrapClaim()` to destructure and use `plaintext` (existing behavior preserved). This avoids re-computing ECDH in the new unwrap method.
    - Add new public method `wrapClaimWithCondition(claim, senderPrivateKey, receiverPublicKey): WrapClaimResult | null`:
      1. If NIP-59 disabled, return null (same as `wrapClaim`)
      2. Generate ephemeral keypair: `ephemeralPrivKey = randomBytes(32)`, `ephemeralPubKey = secp256k1.getPublicKey(ephemeralPrivKey, true)`
      3. Compute `sharedSecret = this._computeSharedSecret(ephemeralPrivKey, receiverPublicKey)`
      4. Derive `preimage = hkdf(sha256, sharedSecret, undefined, CONDITION_HKDF_INFO, HKDF_KEY_BYTES)` (32 bytes)
      5. Compute `executionCondition = sha256(preimage)` (32 bytes)
      6. Derive encryption key and encrypt (reuse existing seal + gift wrap logic with same `sharedSecret`)
      7. Zero ephemeral private key: `ephemeralPrivKey.fill(0)`
      8. Return `{ wrapped: WrappedClaim, executionCondition }`
    - Add new public method `unwrapClaimWithPreimage(wrappedClaim, receiverPrivateKey): UnwrapClaimResult`:
      1. Decrypt gift wrap layer using refactored `_decryptGiftWrap()` which now returns `{ plaintext, sharedSecret }`
      2. Derive `fulfillmentPreimage = hkdf(sha256, sharedSecret, undefined, CONDITION_HKDF_INFO, HKDF_KEY_BYTES)`
      3. Parse seal payload, verify signature, decrypt seal → claim (same as existing `unwrapClaim`)
      4. Return `{ claim, fulfillmentPreimage }`
    - Keep existing `wrapClaim()` and `unwrapClaim()` unchanged for backward compatibility.
  - Tests: Update `packages/connector/src/settlement/privacy/nip59-claim-wrapper.test.ts`:
    - Add test: `wrapClaimWithCondition()` returns 32-byte `executionCondition` (not all zeros).
    - Add test: `unwrapClaimWithPreimage()` returns `fulfillmentPreimage` where `SHA-256(preimage) === executionCondition` from the corresponding `wrapClaimWithCondition()` call.
    - Add test: two successive `wrapClaimWithCondition()` calls with same claim/keys produce different `executionCondition` values (per-packet uniqueness from fresh ephemeral keys).
    - Add test: with mocked `randomBytes()` returning fixed bytes, verify HKDF produces expected preimage against pinned test vector (deterministic given fixed ephemeral key).
    - Add test: `wrapClaimWithCondition()` returns null when NIP-59 is disabled.
    - Add test: existing `wrapClaim()` behavior is unchanged after refactoring.

- [x] **Task 4: Thread condition into per-packet claim generation**
  - File: `packages/connector/src/settlement/per-packet-claim-service.ts`
  - Action:
    - Update `PerPacketClaimResult` interface (line 85): add `executionCondition?: Uint8Array` field.
    - In `generateClaimForPacket()` NIP-59 block (lines 281-309):
      - Call `this._nip59Wrapper.wrapClaimWithCondition(...)` instead of `this._nip59Wrapper.wrapClaim(...)`.
      - If result is non-null, extract `result.executionCondition` and `result.wrapped`.
      - Include `executionCondition` in the returned `PerPacketClaimResult`.
    - When NIP-59 is disabled (or result is null), `executionCondition` remains undefined in the result. Caller uses `packet.executionCondition ?? Buffer.alloc(32)` via OER serialization default.
  - Tests: Update `packages/connector/src/settlement/per-packet-claim-service.test.ts`:
    - Add test: when NIP-59 enabled, `generateClaimForPacket()` result includes 32-byte `executionCondition`.
    - Add test: when NIP-59 disabled, `executionCondition` is undefined in result.

- [x] **Task 5: Add condition/fulfillment handling to PacketHandler (sender, receiver, intermediary)**
  - File: `packages/connector/src/core/packet-handler.ts`
  - Action — **three distinct roles** handled in the same method:

    **A. Sender role (forwarding to peer with claim generation):**
    - After claim generation result (after line 1167, `claimProtocolData = [result.protocolData]`):
      - If `result.executionCondition` is defined, set `forwardingPacket.executionCondition = result.executionCondition`.
      - The condition is now on `forwardingPacket` (a local variable) — no map or external state needed.
    - After `forwardToNextHop()` returns response (line 1187):
      - If response is FULFILL and `forwardingPacket.executionCondition` is present and non-zero:
        - Import `sha256` from `@noble/hashes/sha2`
        - Compute `expectedCondition = sha256(new Uint8Array(response.fulfillment ?? Buffer.alloc(32)))`
        - Compare `Buffer.from(expectedCondition).equals(Buffer.from(forwardingPacket.executionCondition))`
        - If mismatch: return `this.generateReject(ILPErrorCode.F99_APPLICATION_ERROR, 'Fulfillment does not match execution condition', this.nodeId)`
      - If `forwardingPacket.executionCondition` is absent or all zeros: skip verification (backward compat).

    **B. Intermediary role (forwarding without claim generation):**
    - The spread `forwardingPacket = { ...packet, expiresAt: newExpiry }` (line 1073) already copies `executionCondition` from the incoming PREPARE to the outgoing PREPARE. No additional code needed for forwarding.
    - On the return path, the same verification logic from (A) applies — `forwardingPacket.executionCondition` holds the condition from the incoming PREPARE.

    **C. Receiver role (local delivery — auto-fulfill or BLS):**
    - Add constructor parameter: `nip59Wrapper?: NIP59ClaimWrapper` and `nodePrivateKey?: Uint8Array` (for receiver-side preimage derivation).
    - Add private method `derivePreimageFromProtocolData(protocolData): Uint8Array | undefined`:
      1. Find protocol entry with name `'claim-wrapped'` in protocolData
      2. Deserialize to `WrappedClaim`
      3. Call `this.nip59Wrapper.unwrapClaimWithPreimage(wrappedClaim, this.nodePrivateKey)`
      4. Return `fulfillmentPreimage`
      5. If no wrapped claim found or NIP-59 disabled, return `undefined`
    - In auto-fulfill stub (line 926): before constructing the FULFILL, call `derivePreimageFromProtocolData()` to get the preimage. Set `fulfillment: preimage ?? Buffer.alloc(32)` on the FULFILL packet.
    - In BLS/local delivery handler path (line 907, `localDeliveryClient.deliver()`): the BLS returns a FULFILL via HTTP. The BLS does not have access to NIP-59 keys, so the connector must inject the preimage. After receiving the BLS response, if it is a FULFILL, set `response.fulfillment = preimage ?? Buffer.alloc(32)`.
    - In function handler path (line 889): same pattern — after `localDeliveryHandler()` returns, inject preimage into FULFILL.
    - **Note**: The receiver also needs access to the incoming BTP protocolData. Currently `handlePreparePacket()` does not receive protocolData. Add an optional parameter: `handlePreparePacket(packet, fromPeerId?, incomingProtocolData?)`. Wire this from BTP server's message handler.

  - Tests: Update `packages/connector/src/core/packet-handler.test.ts`:
    - Add test: sender — FULFILL with correct fulfillment passes SHA-256 verification and is forwarded.
    - Add test: sender — FULFILL with wrong fulfillment (random bytes) → REJECT F99.
    - Add test: sender — PREPARE with zero-byte condition (NIP-59 disabled) → skip verification, forward FULFILL as-is.
    - Add test: intermediary — incoming condition is copied to outgoing PREPARE via spread.
    - Add test: receiver auto-fulfill — preimage derived from wrapped claim protocolData and set on FULFILL.
    - Add test: receiver auto-fulfill — no wrapped claim → fulfillment is 32 zero bytes.

### Acceptance Criteria

- [ ] **AC 1**: Given an `ILPPreparePacket` with `executionCondition` set, when serialized and deserialized, then the round-tripped bytes match exactly. Given a packet WITHOUT `executionCondition`, when serialized and deserialized, then 32 zero bytes are read.

- [ ] **AC 2**: Given an `ILPFulfillPacket` with `fulfillment` set, when serialized and deserialized, then the round-tripped bytes match exactly. Given a packet WITHOUT `fulfillment`, when serialized and deserialized, then 32 zero bytes are read.

- [ ] **AC 3**: Given NIP-59 is enabled and `wrapClaimWithCondition()` is called, when the receiver calls `unwrapClaimWithPreimage()` with their private key, then `SHA-256(fulfillmentPreimage) === executionCondition` from the wrap result.

- [ ] **AC 4**: Given two successive calls to `wrapClaimWithCondition()` with the same claim and keys, when comparing the results, then each produces a different `executionCondition` (per-packet uniqueness from fresh ephemeral keys).

- [ ] **AC 5**: Given a sender forwards a PREPARE with a non-zero `executionCondition`, when the receiver returns a FULFILL with the correct preimage-derived `fulfillment`, then PacketHandler verifies `SHA-256(fulfillment) === condition` and forwards the FULFILL upstream.

- [ ] **AC 6**: Given a sender forwards a PREPARE with a non-zero `executionCondition`, when a FULFILL with incorrect `fulfillment` bytes is returned, then PacketHandler rejects with `F99_APPLICATION_ERROR`.

- [ ] **AC 7**: Given NIP-59 is disabled, when a PREPARE is generated, then `executionCondition` is absent/undefined, OER serializes 32 zero bytes, and fulfillment verification is skipped on the return path. All existing behavior is preserved.

- [ ] **AC 8**: Given the receiver gets a PREPARE with NIP-59 wrapped claim protocolData, when processing local delivery (auto-fulfill or BLS), then the receiver derives the preimage synchronously from the wrapped claim's ephemeral key and sets it as the FULFILL's `fulfillment` field before returning.

- [ ] **AC 9**: Given an intermediary connector receives a PREPARE with non-zero `executionCondition`, when it forwards via `{ ...packet, expiresAt: newExpiry }`, then the outgoing PREPARE carries the same `executionCondition`. On the return path, it verifies `SHA-256(fulfillment) === condition`.

- [ ] **AC 10**: Given all existing tests that construct `ILPPreparePacket` or `ILPFulfillPacket` without the new optional fields, when running the test suite, then all tests pass without modification (backward compatibility).

## Additional Context

### Dependencies

- `@noble/curves` (secp256k1 ECDH) — already installed
- `@noble/hashes` (HKDF-SHA256, SHA-256) — already installed
- `@noble/ciphers` (ChaCha20-Poly1305) — already installed
- No new npm dependencies required

### Testing Strategy

**Unit Tests (pinned crypto vectors):**
1. With mocked `randomBytes()` returning fixed ephemeral key, verify HKDF with `info='ilp-condition-preimage'` produces expected 32-byte preimage against pinned test vector
2. `SHA-256(preimage)` matches expected condition hash for the pinned vector
3. OER round-trip serialization preserves condition/fulfillment bytes exactly
4. OER serialization defaults to 32 zero bytes when optional fields are omitted

**Integration Tests:**
5. Full sender→receiver round-trip: `wrapClaimWithCondition()` → `unwrapClaimWithPreimage()` → verify `SHA-256(preimage) === condition`
6. Attacker returns random bytes as fulfillment → PacketHandler rejects with F99
7. NIP-59 disabled path: zero-byte conditions, no verification, all existing behavior preserved
8. Intermediary: condition copied through packet spread, verified on return path

**Performance:**
9. Benchmark `wrapClaimWithCondition()` vs existing `wrapClaim()` — delta should be < 0.5ms (single additional HKDF + SHA-256)

### Protocol Flow

**Sender (per packet):**
1. `PerPacketClaimService.generateClaimForPacket()` calls `wrapClaimWithCondition()`
2. Inside wrapper: generate ephemeral keypair, ECDH, dual HKDF derivation
3. `preimage = HKDF(shared_secret, info='ilp-condition-preimage')` → 32 bytes
4. `condition = SHA-256(preimage)` → 32 bytes
5. `encryption_key = HKDF(shared_secret, info='nip59-giftwrap')`
6. Encrypt claim with `encryption_key`, return `{ wrapped, executionCondition }`
7. `PacketHandler` sets `forwardingPacket.executionCondition = condition`
8. After `forwardToNextHop()` returns FULFILL: verify `SHA-256(fulfillment) === condition`

**Receiver (local delivery path in PacketHandler):**
1. Receive PREPARE + BTP protocolData containing wrapped claim
2. `PacketHandler.derivePreimageFromProtocolData()`: extract wrapped claim, call `unwrapClaimWithPreimage()`
3. Inside wrapper: ECDH with ephemeral key from wrapped claim, derive `preimage = HKDF(shared_secret, info='ilp-condition-preimage')`
4. Verify `SHA-256(preimage) === PREPARE.executionCondition` (receiver-side sanity check)
5. Process local delivery (auto-fulfill or BLS)
6. Set `FULFILL.fulfillment = preimage` before returning

**Intermediary (pure forwarding):**
1. Receive PREPARE with `executionCondition` from upstream
2. `{ ...packet, expiresAt: newExpiry }` copies condition to outgoing PREPARE automatically
3. Forward via `forwardToNextHop()`
4. On FULFILL return: verify `SHA-256(fulfillment) === condition` (local variable)
5. If match: forward FULFILL upstream. If mismatch: REJECT F99.

### Addressed Review Findings

| Finding | Resolution |
| ------- | ---------- |
| F1 (Critical): No mechanism to inject preimage into FULFILL | Preimage derivation moved to PacketHandler's synchronous local delivery path. `derivePreimageFromProtocolData()` is called in same call stack as FULFILL construction. ClaimReceiver is NOT involved in fulfillment path. |
| F2 (Critical): Required fields break all callsites | Fields are optional (`?`). Zero callsite breakage. AC 10 explicitly verifies this. |
| F3 (High): Default value underspecified | OER serialization uses `packet.executionCondition ?? Buffer.alloc(32)`. Explicit and clear. |
| F4 (High): Wrong line references | Corrected all line references in anchor points table. |
| F5/F15 (High/Low): Deterministic test impossible | Replaced with pinned-vector test using mocked `randomBytes()`. AC 4 correctly tests uniqueness. |
| F6 (High): pendingConditions map unnecessary | Removed entirely. Condition is on `forwardingPacket` local variable — already in scope for return-path verification. |
| F7 (High): Receiver never verifies condition | Added receiver-side verification: `SHA-256(preimage) === PREPARE.executionCondition` in `derivePreimageFromProtocolData()`. |
| F8 (Medium): Intermediary forwarding not addressed | Clarified: `{ ...packet }` spread copies condition automatically. Same return-path verification as sender. |
| F9 (Medium): Backward compat contradiction | Fixed: backward compat IS in scope. Optional fields, zero-byte defaults, skip verification when all zeros. |
| F10 (Medium): `_decryptGiftWrap` doesn't expose shared secret | Refactored to return `{ plaintext, sharedSecret }`. Existing `unwrapClaim()` destructures and uses `plaintext` only. |
| F11 (Medium): O(n) lazy eviction | Moot — no map, no eviction needed. |
| F12 (Medium): Ordering constraint implicit | Documented: condition set on `forwardingPacket` after claim generation, before `forwardToNextHop()`. Sequential in same function. |
| F13 (Low): JSDoc example references nonexistent field | Will be valid after Task 1. Noted in task description. |
| F14 (Low): Import paths assumed | Verified: `sha256` from `@noble/hashes/sha2`, `hkdf` from `@noble/hashes/hkdf` — both already imported in nip59-claim-wrapper.ts. |

### Notes

- Performance impact: ~0.5ms additional per packet (single HKDF + SHA-256), negligible vs existing claim signing (~1-5ms for EVM ECDSA)
- Per-packet uniqueness guaranteed by fresh ephemeral key generation
- Design is stronger than classic ILPv4 — fulfillment is identity-bound, not just knowledge-bound
- Existing `wrapClaim()` and `unwrapClaim()` preserved for backward compatibility
- `handlePreparePacket()` gains optional `incomingProtocolData` parameter for receiver-side preimage derivation — wire from BTP server message handler
- ClaimReceiver is NOT modified — it handles async claim verification for settlement monitoring, orthogonal to the synchronous fulfillment path

## Review Notes
- Adversarial review completed (13 findings)
- Findings: 13 total, 5 fixed, 8 skipped (noise/out-of-scope)
- Resolution approach: auto-fix
- Key fixes: explicit reject on missing fulfillment (F2), intermediary condition preservation (F3), OER absent-vs-zero semantics (F8)
