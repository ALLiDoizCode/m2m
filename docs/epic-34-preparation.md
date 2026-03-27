# Epic 34 Preparation Notes

Resolved action items from the Epic 33 retrospective and preparation tasks for Epic 34 (Mina Protocol Payment Channel Provider).

---

## Resolved Retro Action Items

### Item 1: Docker-gated Solana tests in CI (RESOLVED)

Added to `.github/workflows/ci.yml`:

- **`solana-integration` job**: Runs T-33.7-05 and T-33.7-10 with `SOLANA_INTEGRATION=true` against a `solana-test-validator` Docker service. Triggers on push to `main` (after the `test` job passes).
- **`solana-program` job**: Runs `cargo test-sbf` for the Rust on-chain program tests. Runs on all PRs and pushes (required gate).

### Item 2: Manual devnet smoke test (DOCUMENTED)

Story 33.8 Task 5 (manual devnet smoke test) requires a funded devnet keypair and manual operator execution. This cannot be automated in CI.

**Decision**: This is a manual-only gate. The deployment process is fully documented in `docs/solana-deployment.md`. The automated CI pipeline covers:

- Rust program tests via `cargo test-sbf` (new `solana-program` CI job)
- TypeScript integration tests via bankrun (existing `test` CI job)
- Docker-gated subscription tests (new `solana-integration` CI job)

The manual devnet smoke test should be executed by an operator with a funded keypair before any mainnet deployment. It is not a blocker for Epic 34 development.

### Item 3: Test count reporting stabilization (RESOLVED)

Environment-gated tests already use `describe.skip` when their gate condition is not met (e.g., `SOLANA_INTEGRATION !== 'true'`, `.so` file not present). Jest reports these as skipped in `--verbose` mode.

**Decision**: The existing gating pattern is correct. The test count variance (2,374 vs 2,425 vs 2,436) is expected behavior -- different environments have different gates active. No code change needed. The CI summary now reports both standard and integration test counts separately via the new `solana-integration` job.

### Item 4: `tokenMint` added to `SolanaProviderConfig` (RESOLVED)

Added `tokenMint?: string` as an optional field on `SolanaProviderConfig` in `payment-channel-provider.ts`. The `createSolanaProviderFactory()` now reads `config.tokenMint` when present, falling back to the closure parameter. This makes token mint configuration expressible in YAML:

```yaml
chainProviders:
  - chainType: solana
    chainId: solana:devnet
    rpcUrl: https://api.devnet.solana.com
    programId: PayChan111111111111111111111111111111111111
    keyId: solana-treasury-key
    tokenMint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v # USDC on devnet
```

The field is optional for backward compatibility -- existing configs that pass `tokenMint` via the factory closure continue to work unchanged.

### Item 5: Story-create validation churn (DECISION DOCUMENTED)

**Decision**: Formally deprioritize. The average 7.5 issues per story validation has been consistent across Epics 32 and 33. The validation step catches real issues (incorrect acceptance criteria, missing test IDs, inconsistent references) and the cost of fixing them is low compared to the cost of shipping incorrect stories. The template is working as designed -- the validation step is the quality gate, not a sign of template failure.

If this becomes a bottleneck in Epic 34 (which has 9 stories vs 8), revisit by adding automated pre-validation checks to the story creation workflow.

---

## Epic 34 Preparation: Mina Protocol

### Item 6: Mina development environment setup

**Prerequisites for Story 34.1:**

```bash
# Install o1js (Mina's TypeScript ZK framework)
npm install o1js

# Install Mina CLI (for local network)
# See: https://docs.minaprotocol.com/zkapps/getting-started

# Start lightnet (local Mina network for development)
# lightnet provides a local Mina daemon + archive node
npx zk lightnet start

# Verify lightnet is running
npx zk lightnet status
```

**Key differences from Solana/EVM development:**

- **Compilation model**: zkApps compile to ZK circuits (provable programs), not bytecode. Circuit compilation is slow (30-120s) compared to Solana BPF builds.
- **Proof generation**: Each state transition requires generating a ZK proof locally before submitting to the network. Proof generation takes 10-60s depending on circuit complexity.
- **State model**: Mina zkApps have 8 on-chain state fields (each a Field element, ~254 bits). Complex state requires Merkle tree patterns or off-chain storage.
- **Testing**: Use `LocalBlockchain` from o1js for unit tests (no network needed). `lightnet` for integration tests.

**npm workspace integration:**

- Add `o1js` as a devDependency in `packages/connector/package.json`
- zkApp source goes in `packages/mina-program/` (mirroring `packages/solana-program/`)
- Add `make mina-build` and `make mina-test` targets to Makefile

### Item 7: NIP-59 claim wrapping research

**Context**: Story 34.6 describes NIP-59-inspired claim wrapping for transport privacy. NIP-59 (from Nostr) defines "gift wrapping" -- encrypting a message inside a disposable outer envelope so that the receiver cannot determine the sender from the transport layer.

**Potential impact on zkApp circuit design (Stories 34.1-34.3):**

The claim wrapping in Story 34.6 operates at the **BTP transport layer**, not the **on-chain layer**. It wraps `BTPClaimMessage` objects before sending them over WebSocket. The zkApp circuit does not need to verify wrapped claims -- it only sees unwrapped claim data (balance proofs).

**Design note**: The wrapping layer should be implemented as a BTP protocol extension, independent of the chain-specific provider. The `MinaClaimMessage` type (Story 34.7) should include a `wrappedClaim` optional field for the encrypted inner payload, but the zkApp circuit design in Stories 34.1-34.3 does not need to account for wrapping.

**Recommendation**: No circuit design impact. Proceed with Stories 34.1-34.3 independently of Story 34.6.

### Item 8: ZK-private claims design considerations (Story 34.2)

**o1js circuit constraints:**

- **Field arithmetic**: All values in a ZK circuit must be Field elements (integers mod p, where p is the Pasta curve order, ~254 bits). ILP amounts (BigInt) must fit within a single Field.
- **Comparison operations**: Comparing Field values (e.g., `newBalance > oldBalance`) requires range checks, which add ~256 constraints per comparison. Minimize comparisons in the circuit.
- **Hash operations**: Poseidon hash is native to o1js (~200 constraints). Keccak/SHA-256 are expensive (~30,000+ constraints). Use Poseidon for all in-circuit hashing.
- **Signature verification**: o1js supports Schnorr signatures natively on the Pasta curve. Ed25519 (used by Solana) and ECDSA (used by EVM) are expensive in-circuit (~tens of thousands of constraints).

**Proof generation performance:**

- Simple circuits (< 10,000 constraints): ~10-15s proof generation
- Medium circuits (10,000-50,000 constraints): ~30-60s proof generation
- Complex circuits (50,000+ constraints): 60s+ proof generation
- Target for payment channel claims: < 20,000 constraints for sub-30s proving

**Circuit design sketch for private claims:**

```
Public inputs: channelId (Field), commitmentHash (Field)
Private inputs: nonce (Field), amount (Field), signature (Signature)

Constraints:
1. Poseidon(channelId, nonce, amount) == commitmentHash  // commitment opens correctly
2. nonce > previousNonce                                   // nonce ordering
3. amount >= 0                                             // non-negative amount
4. Signature.verify(signerKey, [channelId, nonce, amount]) // valid signature
```

This allows on-chain verification that a valid claim exists without revealing the claim amount or nonce to observers.

### Item 9: Three-chain integration test scenario

**Test plan outline for EVM + Solana + Mina mixed-chain routing:**

```
Scenario: Three-chain claim routing via ChainProviderRegistry

Setup:
  - Registry with 3 providers: EVM (evm:8453), Solana (solana:devnet), Mina (mina:mainnet)
  - 3 peers: Peer-A (chain: evm:8453), Peer-B (chain: solana:devnet), Peer-C (chain: mina:mainnet)

Test cases:
  1. Claim routing: EVMClaimMessage routes to EVM provider
  2. Claim routing: SolanaClaimMessage routes to Solana provider
  3. Claim routing: MinaClaimMessage routes to Mina provider
  4. Peer lookup: getProviderForPeer returns correct provider per peer chain field
  5. Mixed settlement: Settle Peer-A (EVM), Peer-B (Solana), Peer-C (Mina) in sequence
  6. Registry lifecycle: Register all 3, deregister Mina, verify EVM+Solana still work
  7. Config-driven: ChainProviderRegistry.fromConfig() with all 3 chain types
  8. Error: Claim with unknown blockchain type rejected
  9. Error: Peer referencing deregistered chain returns undefined provider

Infrastructure:
  - Tests 1-9 use mock providers (no real blockchain needed)
  - Future: Docker-gated variant with real Anvil + solana-test-validator + lightnet
```

The test file should be placed at `packages/connector/test/integration/three-chain-routing.test.ts`, extending the existing `mixed-chain-routing.test.ts` pattern.

---

## Backlog Items (tracked, not blocking Epic 34)

### Item 10: ed25519-dalek v1.0.1 pin

`ed25519-dalek` is pinned to v1.0.1 in `packages/solana-program/Cargo.toml` for compatibility with `solana-program 2.1.0`. Monitor the Solana SDK releases for ed25519-dalek v2+ support. When available, update the pin and run `make solana-test` to verify.

**Tracking**: Check quarterly or when upgrading `solana-program` crate version.

### Item 11: npm audit vulnerabilities

Pre-existing transitive dependency vulnerabilities (not introduced by Epic 33):

- 1 critical: `fast-xml-parser` via `@aws-sdk` (optional dependency)
- 17 high: Various transitive deps in `express`, `@aws-sdk`

**Decision**: These are in optional/transitive dependencies and do not affect the core connector runtime. Triage when major dependency upgrades are planned. Run `npm audit` periodically and resolve when upstream fixes are available.

### Item 12: Large test file splitting

Candidates for splitting if they grow further:

- `packages/connector/test/integration/solana-provider.test.ts` (810 lines)
- `packages/solana-program/tests/lifecycle.rs` (~1,380 lines)

**Decision**: Not splitting now. Both files are cohesive (single test subject) and navigable. If either exceeds ~1,500 lines or gains distinct test categories, extract shared helpers into a `test-utils` module and split by test category.

---

_Generated: 2026-03-26 | Epic 33 retro resolution + Epic 34 preparation_
