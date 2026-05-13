# Epic 40: Passkey-PRF Identity Root

**Date:** 2026-05-01
**Author:** Jonathan (with BMAD multi-agent roundtable)
**Status:** Draft
**Dependencies:** Epic 38 (RFC 9421 surface to consume the derived Ed25519). Soft dep on Epic 39 (admin UI co-located with operator passkey registration).
**Type:** Greenfield — new identity layer
**North-star tier served:** T2 (architectural)
**Spec source:** `technical-http-sigs-webauthn-nostr-research-2026-05-01.md` Architecture B + Pattern E

---

## Executive Summary

One passkey ceremony, processed through the WebAuthn PRF extension and HKDF, deterministically derives every signing key the connector needs — Ed25519 for HTTP-Sig, secp256k1 for BTP claims and EVM, Ed25519 for Solana, Schnorr-over-Pallas for Mina, and BIP-340 Schnorr for Nostr. The passkey is the root; each level signs in its native algorithm. New operators register with a passkey + recovery passkey and never type a seed phrase. Existing operators get a migration path.

### Why this comes after Epic 38

The PRF-derived Ed25519 key is a *consumer* of RFC 9421's signing surface. Epic 38 ships RFC 9421 with KMS-managed Ed25519 keys; Epic 40 swaps in passkey-derived keys as the default identity root for new operator registrations.

### What's being built

- WebAuthn registration UI in admin surface (passkey + ≥ 1 recovery passkey).
- Server-side PRF salt provisioning + at-rest encryption.
- HKDF derivation tree with six domain-separated `info` strings — one per signing surface.
- Each derived key encrypted at rest (NIP-49-style ncryptsec1, reusing patterns from `nip59-claim-wrapper.ts`).
- Per-key signers wired into existing flows: HTTP-Sig client (Epic 38), BTP claim signer, settlement signers per chain, Nostr event signer.
- ≥ 2 passkeys at registration enforced (recovery principle P-7 from research).
- Seed-phrase fallback path (BIP-39) for users opting out of passkey-only.
- FIDO MDS3 service for AAGUID validation; weekly refresh.

### What's NOT being built

- Architecture C (Nostr-key-as-RFC-9421-keyid). Phase 3 standards-track contribution; not on this epic.
- Cross-vendor passkey portability (FIDO CXP/CXF still slipping; out of v1 scope).
- ML-DSA / hybrid PQ derivation (Phase 4 tracking).
- Mobile operator UX (Node.js + browser only in v1).

---

## Architecture

### Derivation tree

```
Operator's passkey (single ceremony)
        │
        │ WebAuthn PRF extension
        │   prf.salt = server-provisioned-32-bytes
        │
        ▼
  PRF result (32 bytes, deterministic per credential+salt)
        │
        │ HKDF-SHA256
        │
        ├─ info "rfc9421/ed25519/v1"          → Ed25519 (HTTP-Sig)
        ├─ info "btp/secp256k1/v1"            → secp256k1 (BTP claims)
        ├─ info "evm/secp256k1/v1"            → secp256k1 (EVM settlement)
        ├─ info "solana/ed25519/v1"           → Ed25519 (Solana settlement)
        ├─ info "mina/pallas-schnorr/v1"      → Pallas Schnorr (Mina settlement)
        └─ info "nostr/secp256k1-schnorr/v1"  → secp256k1 (Nostr event signing)
```

### Storage model

| Asset | Storage | Encryption |
|---|---|---|
| WebAuthn credential record (cred ID, pubkey, sign counter, AAGUID, transports) | Existing relational DB | None at rest (public material) |
| `prf.salt` per credential | Existing relational DB | At rest with server master key |
| Six derived keys (encrypted) | Existing relational DB or filesystem | NIP-49-style wrap; key from PRF output, never persisted |
| FIDO MDS3 cache | Filesystem | Signed by FIDO root; verified on load |

Derived keys are decrypted on-demand via a passkey assertion (the PRF re-derivation is the unwrap key). Plaintext keys live in process memory only for the duration of a signing operation.

### Recovery model

Per research P-7 (Coinbase Smart Wallet lesson): single-passkey users get locked out on iCloud↔Android cross-device flows. Mandate ≥ 2 passkeys at registration; both produce the same PRF output via different credentials when authenticated separately (possible only with the same `prf.salt`).

Two recovery options at registration time:
- **Multi-passkey** (default): primary + recovery passkey, both with the same salt.
- **Seed-phrase fallback** (opt-in): BIP-39 seed encrypts the PRF output via a separate KEK; user writes phrase down once. Used only when migrating from existing seed-phrase-based operator identities.

---

## Stories

### Story 40.1: WebAuthn RP setup with SimpleWebAuthn

**Goal.** Stand up the WebAuthn relying-party server-side surface in the admin API.

**AC.**
- AC1: SimpleWebAuthn v13.x or current. Library version pinned.
- AC2: Registration challenge endpoint: `POST /admin/api/webauthn/register/begin`.
- AC3: Verification endpoint: `POST /admin/api/webauthn/register/finish`.
- AC4: Credential records persist to existing DB (new table `webauthn_credentials`).
- AC5: AAGUID captured + validated against MDS3 (Story 40.8).

**Files.** `packages/connector/src/auth/webauthn/rp-server.ts`, `packages/connector/src/db/schema/webauthn-credentials.sql`.

---

### Story 40.2: PRF extension request + result handling

**Goal.** Enable the WebAuthn PRF extension on `create()` and `get()`; capture the deterministic 32-byte output.

**AC.**
- AC1: `create()` request includes `extensions: { prf: { eval: { first: <salt> } } }` when client supports it.
- AC2: Salt provisioning (Story 40.3) supplies `<salt>`.
- AC3: PRF result captured; client-side never sends raw PRF bytes to server (PRF stays client-side; server gets only credential public key + attestation).
- AC4: Browser support detection: feature-test `isUVPAA()` + PRF extension; graceful degrade with explicit "passkey-PRF unsupported" UX.
- AC5: PRF-on-create may be unavailable on some authenticators (research §"Integration Challenges" #5); mitigation: register-then-immediately-authenticate flow.

**Files.** `packages/connector/src/auth/webauthn/client/register.ts`, `packages/connector/src/auth/webauthn/client/derive.ts`, browser bundle.

---

### Story 40.3: Server-side PRF salt provisioning

**Goal.** Provision a 32-byte random salt per credential at registration; persist encrypted.

**AC.**
- AC1: Salt generated via `crypto.randomBytes(32)` server-side.
- AC2: Stored in `webauthn_credentials.prf_salt`, encrypted with the connector's existing master key (same KEK pattern as `wallet-security.ts`).
- AC3: Salt rotation: explicit API; rotation invalidates all derived keys (operator must re-derive).
- AC4: Salt never logged at INFO/WARN/ERROR/FATAL (existing redaction patterns).

**Files.** `packages/connector/src/auth/webauthn/salt-provisioner.ts`.

**Dependencies.** Existing master-key infrastructure (`wallet-security.ts`).

---

### Story 40.4: HKDF derivation library with domain-separated info

**Goal.** Pure HKDF-SHA256 with six well-defined `info` strings producing the six per-level keys.

**AC.**
- AC1: `deriveKey(prfOutput: Uint8Array, info: string, length: number): Uint8Array` — HKDF-SHA256.
- AC2: Six info strings (per Architecture overview); all v1 prefixed.
- AC3: Length output appropriate per algorithm: 32 for Ed25519/secp256k1/Pallas, 64 for any extended-form.
- AC4: Library reuses `@noble/hashes` HKDF (already a dep).
- AC5: Test vectors against IETF RFC 5869 §A.

**Files.** `packages/connector/src/auth/webauthn/hkdf-tree.ts`, `.test.ts`.

---

### Story 40.5: Derived-key encrypted-at-rest storage

**Goal.** NIP-49-style wrap of derived keys with the PRF output as the KEK. Never persist plaintext keys.

**AC.**
- AC1: Wrap: `chacha20poly1305(plaintext_key, prf_output, salt=info_string)`.
- AC2: Unwrap requires re-deriving via WebAuthn PRF assertion (i.e., user authentication).
- AC3: In-process plaintext lifetime: only during a signing operation; zeroed via `crypto.timingSafeEqual` patterns post-use.
- AC4: Existing `nip59-claim-wrapper.ts` patterns referenced for ChaCha20-Poly1305 import path.

**Files.** `packages/connector/src/auth/webauthn/key-vault.ts`.

---

### Story 40.6: Enforce ≥ 2 passkeys at registration

**Goal.** Operator registration UX requires registering at least one recovery passkey alongside the primary.

**AC.**
- AC1: Registration wizard collects two consecutive passkey ceremonies; both with the same `prf.salt`.
- AC2: Connector refuses to provision derived keys if only one credential is registered.
- AC3: UX explains why (Coinbase lesson; iCloud↔Android lockout) — link to research §"recovery-pattern decision matrix."
- AC4: Recovery drill: device-lost simulation in operator docs; second passkey unlocks.

**Files.** Admin UI work + `packages/connector/src/auth/webauthn/registration-policy.ts`.

---

### Story 40.7: Seed-phrase fallback (BIP-39)

**Goal.** Optional BIP-39 seed-phrase fallback for operators migrating from existing seed-phrase identity or who explicitly opt out of passkey-only.

**AC.**
- AC1: Opt-in flag at registration: `useSeedPhraseFallback: boolean`.
- AC2: BIP-39 mnemonic generated client-side; displayed once; user copies; never sent to server.
- AC3: Mnemonic encrypts the PRF output via separate KEK (PBKDF2 over user passphrase + mnemonic).
- AC4: Recovery flow: paste mnemonic + passphrase → recover PRF → re-derive all six keys.
- AC5: Operator docs explicitly call out the security tradeoffs (single point of failure; phishing surface).

**Files.** `packages/connector/src/auth/webauthn/seed-fallback.ts`, admin UI.

---

### Story 40.8: FIDO MDS3 service

**Goal.** Validate AAGUIDs against the FIDO Alliance Metadata Service v3. Weekly refresh; shared service (not per-process).

**AC.**
- AC1: Fetches `https://mds.fidoalliance.org/` JWT-signed metadata blob.
- AC2: Verifies JWT against FIDO root cert (pinned).
- AC3: Refresh cadence: weekly; serve from cache between refreshes.
- AC4: AAGUID lookup returns metadata for two-tier policy: consumer (any AAGUID OK, including all-zero synced passkeys) vs operator-trust (MDS-pinned only).
- AC5: Failure mode: stale cache acceptable for ≤ 30 days; alert at 7 days.

**Files.** `packages/connector/src/auth/webauthn/mds3-service.ts`.

---

### Story 40.9: Wire derived Ed25519 into Epic 38's RFC 9421 client

**Goal.** Replace KMS-managed Ed25519 with passkey-derived Ed25519 for new operator registrations.

**AC.**
- AC1: Config flag `auth.signingKeySource: 'kms' | 'passkey-prf'`; default `'kms'` for back-compat.
- AC2: When `'passkey-prf'`, the RFC 9421 signer fetches the derived Ed25519 from the key vault on each sign.
- AC3: JWKS publication: passkey-derived public key advertised at the same `/.well-known/http-message-signatures-directory`; `keyid` is JWK SHA-256 thumbprint as before.
- AC4: KMS path remains supported for org/enterprise deployments.

**Files.** Edits to `packages/connector/src/auth/rfc9421/sign.ts` (Epic 38).

**Dependencies.** Epic 38 Stories 38.2, 38.4. Story 40.5 (key vault).

---

### Story 40.10: Wire derived secp256k1 into BTP claim signer

**Goal.** BTP claims signed by the operator's passkey-derived secp256k1 key.

**AC.**
- AC1: `BtpClaimSigner` accepts a key source: existing seed-derived OR passkey-derived.
- AC2: Migration path: existing operators continue with seed-derived until they opt in.
- AC3: Wallet-security audit: derived key never serialised to disk.

**Files.** Edits to `packages/connector/src/btp/btp-claim-types.ts`, `packages/connector/src/btp/inbound-claim-validator.ts`.

---

### Story 40.11: Wire derived chain keys into settlement signers

**Goal.** EVM, Solana, Mina settlement signers consume passkey-derived keys.

**AC.**
- AC1: One subtask per chain provider:
  - 40.11.1 EVM: `payment-channel-sdk.ts` accepts derived secp256k1.
  - 40.11.2 Solana: `solana-payment-channel-provider.ts` accepts derived Ed25519.
  - 40.11.3 Mina: `mina-payment-channel-sdk.ts` accepts derived Pallas-Schnorr.
- AC2: Each chain's existing test suite passes with derived keys.
- AC3: Settlement transactions on each chain settle on-chain with derived signatures.

**Files.** Edits to `packages/connector/src/settlement/payment-channel-sdk.ts`, `solana-payment-channel-provider.ts`, `mina-payment-channel-sdk.ts`.

---

### Story 40.12: Operator migration: seed-phrase → passkey-PRF

**Goal.** Migration path for existing operators with seed-phrase identity to switch to passkey-PRF.

**AC.**
- AC1: Migration wizard: "register passkey + recovery; we'll re-derive your keys."
- AC2: Verifies derived keys match existing on-chain identities (otherwise abort with clear error).
- AC3: Old seed-phrase remains a valid recovery path during a configurable overlap window (default 30 days).
- AC4: Audit log entry per migration.

**Files.** `packages/connector/src/auth/webauthn/migration.ts`, admin UI.

---

## Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| PRF data-loss on single-credential users | High (without P-7) | Catastrophic | Story 40.6: ≥ 2 passkeys enforced |
| PRF-on-create unavailable on some authenticators | Medium | Medium | Story 40.2 register-then-authenticate flow |
| Sign-counter constant-zero on synced passkeys | Medium | Low | Two-tier policy (P-6); accept zero counter on consumer-tier |
| Salt rotation bricks all derived keys | Low | High | Explicit operator action; clear UX warning; backup wizard |
| FIDO MDS3 service outage | Low | Medium | 30-day stale-cache acceptance; weekly refresh; alert at 7 days |
| Browser PRF support drift | Low (post-Q1 2026) | Low | Feature detection + graceful degrade per Story 40.2 AC4 |

---

## Definition of Done

- All 12 stories shipped (Story 40.11 has 3 chain subtasks).
- New operator runs `connector init` → registers passkey + recovery → all six derived keys provisioned without typing or copying secret material.
- Settlement transactions on EVM, Solana, Mina signed with derived keys; confirm on-chain.
- Migration test: existing seed-phrase operator converts to passkey-PRF; old keys remain valid in overlap window.
- Recovery drill: device-lost simulation; second passkey unlocks all derivations.
- FIDO MDS3 cache populated and weekly-refreshed; AAGUID validation green.
- Operator docs updated for: registration flow, recovery model, migration from seed-phrase.

## Estimated Total Effort

12 stories (40.11 expands to 3 chain subtasks). Estimate range: 3–4 sprints (6–8 weeks at 2-week cadence) for a single dedicated engineer; 2–3 sprints with two engineers (one client-side WebAuthn UX, one server-side derivation + chain wiring).

## Test design

Separate doc `test-design-epic-40.md` (TBD). Chrome DevTools Protocol `WebAuthn.addVirtualAuthenticator` for ceremonies in CI per research §3.
