---
project_name: 'connector'
user_name: 'Jonathan'
date: '2026-04-14'
sections_completed:
  [
    'technology_stack',
    'project_structure',
    'chain_abstraction',
    'solana_payment_channel',
    'mina_payment_channel',
    'transport_privacy',
    'ator_overlay_transport',
    'language_rules',
    'framework_rules',
    'testing_rules',
    'code_quality',
    'workflow_rules',
    'critical_rules',
  ]
status: 'complete'
rule_count: 124
optimized_for_llm: true
---

# Project Context for AI Agents

_This file contains critical rules and patterns that AI agents must follow when implementing code in this project. Focus on unobvious details that agents might otherwise miss._

---

## Technology Stack & Versions

- **Language:** TypeScript 5.3.3 (strict mode enabled, ES2022 target, CommonJS modules)
- **Runtime:** Node.js >= 22.11.0
- **Monorepo:** npm workspaces (`packages/connector`, `packages/shared`, `packages/contracts`, `packages/faucet`, `packages/mina-zkapp`) + Rust crate (`packages/solana-program`)
- **Blockchain (EVM):** ethers 6.16.0 (EVM settlement via chain-agnostic provider abstraction)
- **Blockchain (Solana):** @solana/kit 3.0.3, @solana-program/token 0.6.0 (Solana settlement via `SolanaPaymentChannelProvider`)
- **Solana Program:** Rust/solana-program 2.1.0, spl-token 6.0.0 (on-chain payment channel -- `packages/solana-program/`)
- **Blockchain (Mina):** o1js 2.2.0 (Mina settlement via `MinaPaymentChannelProvider` with zk-SNARK proofs)
- **Mina zkApp:** o1js SmartContract (`packages/mina-zkapp/`) -- Poseidon commitments, zero-knowledge balance proofs
- **Transport:** ws 8.16.0 (BTP over WebSocket, RFC-0023)
- **Transport Privacy:** NIP-59-inspired three-layer encryption (ChaCha20-Poly1305, secp256k1 ECDH, HKDF-SHA256) via @noble/ciphers 1.3.0, @noble/curves 1.9.0, @noble/hashes 1.8.0
- **HTTP:** Express 4.18.x (admin API, health checks, explorer)
- **Logging:** Pino 8.21.0 (structured JSON)
- **Validation:** Zod 3.25.76 (config schemas)
- **Persistence:** better-sqlite3 11.8.1 (claims DB), TigerBeetle 0.16.68 (accounting, optional)
- **Testing (TypeScript):** Jest 29.7.0 + ts-jest 29.1.2
- **Testing (Rust):** solana-program-test 2.1.0 + tokio (BPF integration tests)
- **Testing (Solana TS):** solana-bankrun 0.4.0 (devDependency for TypeScript-side Solana integration tests)
- **Linting:** ESLint 8.56.0 + @typescript-eslint 6.21.0
- **Formatting:** Prettier 3.2.5 (single quotes, trailing commas, 100 char width, LF endings)
- **Git Hooks:** Husky 9.1.7 + lint-staged (pre-commit: eslint --fix + prettier)
- **Releases:** semantic-release 24.2.0 (conventional commits)
- **Contracts (EVM):** Solidity (Foundry/Anvil -- TokenNetwork.sol, TokenNetworkRegistry.sol)
- **Local Dev Infra:** Docker Compose with profiles (`evm`: Anvil + Token Faucet, `solana`: Solana test validator + program auto-deploy, `mina`: Mina lightnet with accounts manager + archive node)
- **Deployment (Solana):** `cargo build-sbf` + Solana CLI for devnet/mainnet deployment (`tools/solana/deploy.sh`)
- **Deployment (Mina):** `npx ts-node tools/mina/deploy-zkapp.ts` for devnet deployment (`make mina-deploy-devnet DEPLOYER_KEY=<key>`)
- **Optional AI:** @ai-sdk/anthropic, @ai-sdk/openai, ai (optional dependencies for agent features)

## Project Structure

```
connector/                          # Monorepo root
├── packages/
│   ├── connector/                  # Main ILP connector package (@toon-protocol/connector)
│   │   ├── src/
│   │   │   ├── btp/                # BTP transport (client, server, message parser, claim types)
│   │   │   ├── cli/                # CLI onboarding wizard (commander + inquirer)
│   │   │   ├── config/             # YAML config loading, Zod validation, environment validation
│   │   │   ├── core/               # ConnectorNode, PacketHandler, PaymentHandler, LocalDeliveryClient
│   │   │   ├── discovery/          # Peer discovery service
│   │   │   ├── encoding/           # OER parser for ILP packets
│   │   │   ├── facilitator/        # SPSP client
│   │   │   ├── http/               # Admin API, health server, ILP send handler
│   │   │   ├── routing/            # Routing table, packet processor, worker pool
│   │   │   ├── security/           # Key management (HSM/KMS), rate limiting, audit, fraud detection
│   │   │   ├── settlement/         # Settlement layer (accounts, claims, channels, providers)
│   │   │   │   ├── provider/       # Chain abstraction layer (Epics 32-34)
│   │   │   │   ├── privacy/        # NIP-59 claim wrapping (Epic 34)
│   │   │   │   ├── solana-payment-channel-sdk.ts  # Solana SDK wrapper (Epic 33)
│   │   │   │   ├── mina-payment-channel-sdk.ts    # Mina SDK wrapper (Epic 34)
│   │   │   │   └── ...             # EVM SDK, claim services, channel manager, etc.
│   │   │   ├── test-utils/         # Mock factories, isolated test environment
│   │   │   ├── transport/          # TransportProvider (Direct TCP) + ILP-over-HTTP egress
│   │   │   ├── utils/              # Logger, connection pool, EVM RPC pool, optional-require
│   │   │   └── wallet/             # Treasury wallet, seed management, wallet security
│   │   └── test/
│   │       ├── acceptance/         # Acceptance tests (run separately)
│   │       ├── fixtures/           # Test fixtures
│   │       ├── helpers/            # Test helpers
│   │       ├── integration/        # Integration tests (multi-hop, claim validation, Solana E2E, Mina E2E)
│   │       ├── stability/          # Stability tests
│   │       └── unit/               # Unit tests
│   ├── shared/                     # Shared types package (@toon-protocol/shared)
│   │   └── src/
│   │       ├── encoding/           # Shared encoding utilities
│   │       └── types/              # ILP types, payment channel types, routing types
│   ├── contracts/                  # Solidity smart contracts (Foundry)
│   │   └── src/                    # TokenNetwork.sol, TokenNetworkRegistry.sol
│   ├── solana-program/             # Solana payment channel program (Rust/BPF) -- Epic 33
│   │   ├── src/                    # lib.rs, processor.rs, state.rs, instruction.rs, error.rs
│   │   └── tests/                  # integration.rs, lifecycle.rs, claims.rs, security.rs, performance.rs
│   ├── mina-zkapp/                 # Mina payment channel zkApp (o1js SmartContract) -- Epic 34
│   │   ├── src/
│   │   │   ├── PaymentChannel.ts   # SmartContract with 8 on-chain Field state elements
│   │   │   ├── constants.ts        # CHANNEL_STATE enum, ASSERT_MESSAGES, MAX_SAFE_AMOUNT
│   │   │   ├── index.ts            # Barrel exports
│   │   │   └── test-helpers.ts     # Test utilities for o1js circuit testing
│   │   └── dist/                   # Compiled output
│   └── faucet/                     # Token faucet service (Docker)
├── infra/
│   └── solana/                     # Solana Docker entrypoint (entrypoint.sh)
├── tools/
│   ├── send-packet/                # ILP packet sending utility
│   ├── fund-peers/                 # Peer funding utility
│   ├── solana/                     # Solana deployment tooling (deploy.sh)
│   └── mina/                       # Mina deployment tooling (deploy-zkapp.ts)
├── docs/
│   ├── solana-deployment.md        # Solana devnet deployment & operations guide (Epic 33)
│   ├── mina-deployment.md          # Mina devnet deployment, privacy model & operations guide (Epic 34)
│   └── ...                         # Architecture docs, operator guides, stories
├── docker-compose.yml              # Multi-profile local dev (evm, solana, mina)
├── Dockerfile                      # Multi-stage Docker build (node:22-alpine)
└── Makefile                        # Development workflow commands (incl. Solana + Mina targets)
```

## Chain Abstraction Layer (Epic 32)

Epic 32 introduced a chain-agnostic settlement architecture enabling multi-chain payment channel support. Key components in `packages/connector/src/settlement/provider/`:

### PaymentChannelProvider Interface (`payment-channel-provider.ts`)

- Chain-agnostic interface that all blockchain-specific providers must implement
- Defines `chainType` (`'evm'`, `'solana'`, `'mina'`) and `chainId` (e.g., `'evm:8453'`, `'mina:devnet'`)
- Unified API for: `openChannel`, `deposit`, `claimFromChannel`, `closeChannel`, `settleChannel`, `signBalanceProof`, `verifyBalanceProof`, `getChannelState`, `subscribeToEvents`
- Discriminated union `ProviderConfig` with per-chain config subtypes (`EVMProviderConfig`, `SolanaProviderConfig`, `MinaProviderConfig`)
- Chain-agnostic types: `ProviderChannelState`, `ProviderEvent`, `ProviderEventSubscription`, `BalanceProofParams`, `VerifyBalanceProofParams`

### ChainProviderRegistry (`chain-provider-registry.ts`)

- Manages `PaymentChannelProvider` instances keyed by `chainId`
- Dynamic registration/deregistration of providers
- Peer-based lookup via `getProviderForPeer(peerConfig)` using the peer's `chain` field
- Factory-based initialization via `ChainProviderRegistry.fromConfig(configs, factories)`
- Custom error: `ChainProviderAlreadyRegisteredError`

### EVMPaymentChannelProvider (`evm-payment-channel-provider.ts`)

- Concrete EVM implementation wrapping the existing `PaymentChannelSDK`
- Adapts provider-level params (string amounts) to SDK-level params (bigint amounts)
- EVM-specific `getSigningContext()` method (not on interface -- use `instanceof` to access)
- Factory function `createEVMProviderFactory(sdk, logger)` for registry integration
- Handles EIP-712 signing context, event forwarding with channel filtering

### Refactored Settlement Services (Stories 32.4-32.6)

- **PerPacketClaimService** -- delegates signing to chain-appropriate provider via `ChainProviderRegistry`
- **SettlementExecutor** -- resolves chain-specific provider for each peer via registry
- **ClaimReceiver** -- dispatches claim verification to correct provider based on blockchain discriminator field

### Configuration (Story 32.7)

- New `chainProviders` array in `ConnectorConfig` for multi-chain provider configuration
- `ChainProviderConfigEntry` = `ProviderConfig & { chainId: string }`
- Per-peer `chain` field on `PeerConfig` references a registered provider's `chainId`
- `settlementInfra` config removed; `chainProviders[evm]` is the only config path for EVM settlement
- Zod-based validation: rejects unknown chainType, duplicate chainId, peer referencing unregistered chain

### Integration Tests (Story 32.8)

- `provider/integration.test.ts` (1120 lines) -- full chain abstraction layer integration tests
- `config/chain-provider-config.test.ts` -- configuration schema validation tests
- Tests cover: multi-chain registration, peer lookup, factory initialization, EVM provider adapter, event forwarding

## Solana Payment Channel (Epic 33)

Epic 33 added full Solana payment channel support -- an on-chain Rust program, a TypeScript SDK, a chain-abstraction provider, claim message types, and devnet deployment tooling.

### On-Chain Program (`packages/solana-program/`)

- **Language:** Rust (edition 2021), compiled to BPF via `cargo build-sbf`
- **Framework:** Native `solana-program` 2.1.0 (not Anchor) with `spl-token` 6.0.0
- **Crate name:** `payment-channel` (cdylib + lib)
- **Architecture:** `lib.rs` (entrypoint) -> `processor.rs` (instruction dispatch) -> `state.rs` (account schemas) -> `instruction.rs` (discriminators) -> `error.rs` (custom errors)
- **Instructions:** `OpenChannel`, `Deposit`, `SubmitClaim` (Ed25519 balance proofs), `InitiateClose`, `Settle`, `ForceClose`
- **Channel accounts:** PDA-based (`["channel", sender, receiver, mint]`), stores cumulative transferred amounts, nonces, close timestamps
- **Signing:** Ed25519 signatures over `(channel_pda ++ nonce_le ++ amount_le)` -- verified on-chain via `ed25519_dalek`
- **Tests (Rust):** 5 test files (~5,800 lines) using `solana-program-test` + `tokio`:
  - `integration.rs` -- full lifecycle, open/deposit/claim/close/settle
  - `lifecycle.rs` -- state transitions, edge cases, timeout handling
  - `claims.rs` -- balance proof verification, nonce ordering, replay prevention
  - `security.rs` -- unauthorized access, invalid signatures, account spoofing
  - `performance.rs` -- compute unit budgets, concurrent channels
- **Build/test:** `make solana-build` / `make solana-test` (or `cargo build-sbf` / `cargo test-sbf`)
- **Deploy:** `make solana-deploy-devnet DEPLOYER_KEYPAIR=path/to/keypair.json` (uses `tools/solana/deploy.sh`)

### SolanaPaymentChannelSDK (`settlement/solana-payment-channel-sdk.ts`)

- TypeScript wrapper (~1,220 lines) around the on-chain program using `@solana/kit` v3
- Methods: `openChannel`, `deposit`, `submitClaim`, `initiateClose`, `settle`, `forceClose`, `getChannelState`, `deriveChannelPDA`
- Constructs raw `Instruction` objects with correct account metas and serialized data
- Ed25519 signing via `@solana/kit` `signBytes()` for balance proofs
- ATA (Associated Token Account) derivation via `@solana-program/token` `findAssociatedTokenPda()`
- Unit tests (~1,190 lines) in `solana-payment-channel-sdk.test.ts`

### SolanaPaymentChannelProvider (`settlement/provider/solana-payment-channel-provider.ts`)

- Implements `PaymentChannelProvider` interface (chain abstraction layer)
- `chainType: 'solana'`, `chainId: 'solana:{cluster}'` (e.g., `'solana:devnet'`)
- Delegates to `SolanaPaymentChannelSDK` -- adapts string amounts to bigint, base64 signatures to Uint8Array
- Factory function `createSolanaProviderFactory(logger)` for `ChainProviderRegistry` integration
- Event subscription via state-diffing (polls channel state, emits `ProviderEvent` on changes)
- Unit tests (~1,180 lines) in `solana-payment-channel-provider.test.ts`

### Solana Claim Messages (`btp/btp-claim-types.ts`)

- `SolanaClaimMessage` extends `BaseClaimMessage` with `blockchain: 'solana'`
- Fields: `programId` (base58), `channelAccount` (base58 PDA), `nonce`, `transferredAmount`, `signature` (base64 Ed25519), `signerPublicKey` (base58), optional `cluster`
- Type guard `isSolanaClaim()` and validator `validateSolanaClaim()` with base58 format checks
- Discriminated union: `BTPClaimMessage = EVMClaimMessage | SolanaClaimMessage | MinaClaimMessage`

### Mixed-Chain Routing Tests (`provider/mixed-chain-routing.test.ts`)

- Validates `ChainProviderRegistry` routes claims to correct provider based on blockchain discriminator
- Tests EVM + Solana + Mina peers coexisting: Peer A on EVM, Peer B on Solana, Peer C on Mina
- EVM regression: EVM settlement works identically alongside Solana and Mina providers

### Solana Integration Tests (`test/integration/solana-*.ts`)

- `solana-provider.test.ts` (~1,010 lines) -- E2E provider tests with mock SDK
- `solana-config.test.ts` (~290 lines) -- Solana config schema validation
- `solana-deployment.test.ts` (~740 lines) -- deployment verification tests
- `solana-subscription.test.ts` (~350 lines) -- event subscription tests

### Devnet Deployment Documentation (`docs/solana-deployment.md`)

- Prerequisites (Solana CLI, Rust toolchain, funded deployer keypair)
- Build and deploy commands, cost estimates
- Connector YAML configuration for Solana providers
- Upgrade runbook (binary rebuild, deploy upgrade, authority management, rollback)
- Monitoring guide (channel health, stuck channel detection, RPC and SDK-based monitoring)
- Rent economics reference

## Mina Payment Channel (Epic 34)

Epic 34 added full Mina protocol payment channel support -- an o1js SmartContract zkApp, a TypeScript SDK with dynamic o1js imports, a chain-abstraction provider, Mina-specific claim message types, NIP-59 transport privacy, and devnet deployment tooling.

### On-Chain zkApp (`packages/mina-zkapp/`)

- **Framework:** o1js 2.2.0 SmartContract (zero-knowledge proofs, Poseidon hashing)
- **Package:** `@toon-protocol/mina-zkapp` (private workspace package)
- **Contract:** `PaymentChannel` class using exactly 8 on-chain `Field` state elements (Mina protocol maximum)
- **State fields:** `channelHash`, `balanceCommitment`, `nonceField`, `channelState`, `depositTotal`, `closedAtSlot`, `settlementTimeout`, `tokenId_`
- **Methods:** `initializeChannel`, `deposit`, `initiateClose`, `settle`, `claimFromChannel`
- **Channel state enum:** `UNINITIALIZED=0`, `OPEN=1`, `CLOSING=2`, `SETTLED=3` (Field values)
- **Privacy model:** Balance commitments use `Poseidon.hash([balanceA, balanceB, salt])` -- actual balances are private circuit witnesses, never visible on-chain
- **Claim verification (Story 34.2):** `claimFromChannel` enforces 6 invariants: commitment validity, conservation (balanceA + balanceB == depositTotal), non-negativity, monotonic nonce, participant binding (channelHash), dual-party signature authorization
- **Overflow protection:** `MAX_SAFE_AMOUNT = 2^64 - 1` bounds all amounts and nonces to prevent Field modular arithmetic wraparound
- **Channel identity:** `channelHash = Poseidon.hash([participantA.x, participantB.x, nonce])` -- verified in both `claimFromChannel` and `settle`
- **tsconfig:** `experimentalDecorators: true`, `emitDecoratorMetadata: true`, `useDefineForClassFields: false` (required by o1js `@state` and `@method` decorators)
- **Tests (zkApp):** 6 test files (~3,190 lines):
  - `payment-channel.test.ts` (~905 lines) -- core lifecycle tests
  - `payment-channel-claims.test.ts` (~1,177 lines) -- claim verification invariants
  - `payment-channel-proofs.test.ts` (~329 lines) -- zk-SNARK proof generation
  - `payment-channel-privacy.test.ts` (~156 lines) -- privacy model validation
  - `payment-channel-lifecycle.test.ts` (~259 lines) -- state transition edge cases
  - `payment-channel-security.test.ts` (~364 lines) -- security attack vectors
- **Build/test:** `make mina-build` / `make mina-test` (or `npm run build/test --workspace=packages/mina-zkapp`)

### MinaPaymentChannelSDK (`settlement/mina-payment-channel-sdk.ts`)

- TypeScript wrapper (~1,094 lines) over the Mina zkApp using dynamic `import()` for o1js and `@toon-protocol/mina-zkapp`
- **Dynamic imports:** o1js is loaded at runtime (not at import time) -- if o1js is not installed, a `MinaChannelError` (code 9999) is thrown on first use, not on module import
- Methods: `openChannel`, `deposit`, `claimFromChannel`, `closeChannel`, `settleChannel`, `signBalanceProof`, `verifyBalanceProof`, `getChannelState`, `subscribeToChannel`, `compileContract`, `getSignerPublicKey`
- Custom error class: `MinaChannelError` with numeric `code` and string `errorName` for programmatic error handling
- Error codes: `COMPILE_FAILED=1001`, `TRANSACTION_FAILED=1002`, `PROOF_GENERATION_FAILED=1003`, `INVALID_CHANNEL_STATE=1004`, `ACCOUNT_NOT_FOUND=1005`, `INVALID_PROOF=1006`, `ARCHIVE_NODE_ERROR=1007`, `INVALID_PARAMETERS=1008`, `O1JS_NOT_AVAILABLE=9999`
- Unit tests (~1,891 lines) in `mina-payment-channel-sdk.test.ts`
- ATDD tests (~967 lines) in `mina-payment-channel-sdk.atdd.test.ts`

### MinaPaymentChannelProvider (`settlement/provider/mina-payment-channel-provider.ts`)

- Implements `PaymentChannelProvider` interface (chain abstraction layer)
- `chainType: 'mina'`, `chainId: 'mina:{network}'` (e.g., `'mina:devnet'`)
- Delegates to `MinaPaymentChannelSDK` -- adapts string amounts to bigint via `safeBigInt()`
- Uses Poseidon commitments (not EIP-712 or Ed25519) for balance proofs
- Channel IDs are zkApp addresses (base58-encoded public keys, B62 prefix)
- Event subscription via interval-based polling with state-diffing (same pattern as Solana provider)
- Pre-compiles zkApp circuit during construction (fire-and-forget via `void this._preCompile()`)
- Mina-specific `getMinaContext()` method (not on interface -- use `instanceof MinaPaymentChannelProvider` to access)
- Factory function `createMinaProviderFactory(logger, signerKey)` for `ChainProviderRegistry` integration
- Warns and ignores EVM-specific fields (`lockedAmount`, `locksRoot`) when present
- Unit tests (~1,598 lines) in `mina-payment-channel-provider.test.ts`

### MinaProviderConfig (`settlement/provider/payment-channel-provider.ts`)

- Config subtype: `chainType: 'mina'`, `graphqlUrl`, `zkAppAddress`, optional `keyId`, `tokenId`, `network`
- Added to `ProviderConfig` discriminated union alongside EVM and Solana configs
- Amounts are in nanomina, serialized as strings for bigint precision

### Mina Claim Messages (`btp/btp-claim-types.ts`)

- `MinaClaimMessage` extends `BaseClaimMessage` with `blockchain: 'mina'`
- Fields: `zkAppAddress` (base58, B62 prefix), `tokenId`, `balanceCommitment` (Poseidon hash), `nonce`, `proof` (base64 zk-SNARK), `salt`, optional `network`
- Type guard `isMinaClaim()` and validator `validateMinaClaim()` with B62 address format checks
- `ClaimSender.sendMinaClaim()` constructs and sends Mina-specific claims
- `ClaimReceiver` dispatches Mina claims to `MinaPaymentChannelProvider` for proof verification

### Mina Integration Tests (`test/integration/mina-*.ts`)

- `mina-provider.test.ts` (~830 lines) -- E2E provider tests with mock SDK
- `mina-config.test.ts` (~337 lines) -- Mina config schema validation
- `mina-deployment.test.ts` (~949 lines) -- deployment verification tests
- `mina-nip59.test.ts` (~191 lines) -- NIP-59 privacy integration tests
- `mina-lightnet.test.ts` (~208 lines) -- local lightnet infrastructure tests
- `mina-proofs.test.ts` (~77 lines) -- proof generation integration tests
- `mina-helpers.ts` (~194 lines) -- shared test utilities

### Devnet Deployment Documentation (`docs/mina-deployment.md`)

- Prerequisites (Node.js, o1js, funded Mina devnet account)
- Build and deploy commands, cost estimates (2 MINA minimum)
- Connector YAML configuration for Mina providers
- Privacy model documentation (on-chain zk-SNARKs + transport NIP-59)
- Performance benchmarks (proof generation: 30-120s)
- Archive node requirements, block time/finality characteristics
- Local development with lightnet (Docker)
- Makefile targets: `make mina-build`, `make mina-test`, `make mina-deploy-devnet`

## Transport Privacy -- NIP-59 Claim Wrapping (Epic 34 Story 34.6)

### NIP59ClaimWrapper (`settlement/privacy/nip59-claim-wrapper.ts`)

- **Chain-agnostic** -- wraps any `BTPClaimMessage` (EVM, Solana, Mina) in three encryption layers
- **Three-layer model** inspired by Nostr NIP-59 Gift Wrap protocol:
  - **Inner (Rumor):** unsigned claim payload (deniable)
  - **Middle (Seal):** encrypted to peer using ChaCha20-Poly1305, signed by sender (secp256k1)
  - **Outer (Gift Wrap):** encrypted with ephemeral one-time key, randomized timestamp (+/-48h)
- **Cryptography:** ChaCha20-Poly1305 (via `@noble/ciphers`), secp256k1 ECDH + HKDF-SHA256 (via `@noble/curves`, `@noble/hashes`)
- **Configuration toggle:** `nip59Enabled: boolean` -- when false, `wrapClaim()` returns null (passthrough)
- **BTP protocol:** wrapped claims use protocol name `claim-wrapped` with content type `APPLICATION_OCTET_STREAM` (0)
- **Custom error:** `NIP59WrapError` -- never includes decrypted claim content in error messages
- **Output type:** `WrappedClaim` with `ephemeralPublicKey` (hex), `encryptedPayload` (base64), randomized `timestamp`, `version: '1.0'`
- Unit tests (~851 lines) in `nip59-claim-wrapper.test.ts`

## Critical Implementation Rules

### TypeScript Rules

- **Strict mode is fully enabled** -- `noUncheckedIndexedAccess`, `noImplicitAny`, `strictNullChecks`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns` are all enforced
- **Array/object index access returns `T | undefined`** -- always handle the `undefined` case when accessing by index or key
- **Unused parameters must be prefixed with `_`** -- ESLint rule `@typescript-eslint/no-unused-vars` with `argsIgnorePattern: "^_"`
- **No `any` type** -- `@typescript-eslint/no-explicit-any: "error"` is enforced
- **Explicit return types encouraged** -- `@typescript-eslint/explicit-function-return-type: "warn"` (expressions exempted)
- **No `console.log`** -- use Pino logger instead; ESLint `no-console: "error"` (only `console.warn` and `console.error` allowed)
- **Named exports only** -- no default exports; separate `export type {}` from runtime exports
- **Use `import type` for type-only imports** -- keeps runtime bundles clean
- **Cross-package imports:** use `@toon-protocol/shared` (mapped in Jest via `moduleNameMapper`)
- **Custom Error classes:** set `this.name`, call `Error.captureStackTrace`, use `instanceof` checks
- **Async cleanup:** prefix fire-and-forget async calls with `void` (e.g., `void shutdown('SIGTERM')`)
- **Target ES2022** -- can use top-level await, `Array.at()`, `Object.hasOwn()`, etc.

### Framework-Specific Rules

- **Pino logging format:** always `logger.info({ event: 'event_name', key: value }, 'Human-readable message')` -- structured fields FIRST, message string SECOND
- **Child loggers:** create via `logger.child({ component: 'component-name' })` for sub-components; inherit parent context (nodeId)
- **Sensitive data:** NEVER log private keys, mnemonics, seeds, or secrets -- Pino serializers auto-redact but don't rely on it; actively avoid passing sensitive data to log calls
- **Correlation IDs:** generate via `generateCorrelationId()` -> `pkt_{hex}` format; pass as `correlationId` field in log entries for packet tracking across hops
- **Config loading:** YAML config files validated with Zod schemas at startup; use `ConfigLoader` class pattern
- **BTP transport:** class-based with Node.js `EventEmitter` for lifecycle events (connected/disconnected/error); WebSocket-based (ws library)
- **Express usage:** minimal -- only for health checks (`GET /health`), admin API, and explorer static serving; NOT the primary transport layer
- **ethers.js:** all blockchain calls are async; use `PaymentChannelProvider` abstraction (via `ChainProviderRegistry`) -- never call contract methods directly from business logic
- **Class-based architecture:** major components are classes with constructor-based dependency injection; private fields use `private readonly` pattern
- **EventEmitter pattern:** BTP clients and services extend or compose EventEmitter for lifecycle and state change notifications
- **Chain provider pattern:** settlement services resolve providers via `ChainProviderRegistry.getProviderForPeer(peerConfig)` -- never hardcode chain-specific logic in service classes
- **Solana SDK pattern:** `SolanaPaymentChannelSDK` wraps on-chain program instructions using `@solana/kit` v3; constructs raw `Instruction` objects with explicit `AccountMeta` arrays -- never use Anchor client codegen
- **Solana addresses:** use `address()` from `@solana/kit` for base58 address creation; PDA derivation via `getProgramDerivedAddress()` with seed arrays
- **Solana signing:** Ed25519 signatures via `signBytes()` from `@solana/kit`; signature payload is `(channel_pda ++ nonce_le ++ amount_le)` -- must match on-chain verification exactly
- **Solana amounts:** `SolanaPaymentChannelProvider` converts string amounts to bigint via `safeBigInt()` -- same pattern as `EVMPaymentChannelProvider`
- **Mina SDK pattern:** `MinaPaymentChannelSDK` wraps zkApp interactions using dynamic `import()` for o1js; connector package does NOT import o1js directly -- all o1js usage is encapsulated in the SDK
- **Mina dynamic imports:** o1js is loaded lazily at runtime via `import('o1js')` -- if o1js is not installed, `MinaChannelError` (code 9999) is thrown on first SDK method call, not at module import time
- **Mina addresses:** zkApp addresses use base58 encoding with B62 prefix (55 characters); validate format before passing to SDK
- **Mina signing:** Poseidon commitments via `Poseidon.hash([balanceA, balanceB, salt])` for balance proofs; o1js `Signature.create()` for participant authorization; signature message format: `[newBalanceCommitment, newNonce, channelHash]`
- **Mina amounts:** Field elements are ~254-bit modular integers; amounts bounded to `MAX_SAFE_AMOUNT = 2^64 - 1` to prevent modular arithmetic wraparound
- **Mina provider pre-compilation:** `MinaPaymentChannelProvider` pre-compiles the zkApp circuit during construction (fire-and-forget); proof generation takes 30-120s and runs asynchronously
- **Mina chain-specific access:** use `instanceof MinaPaymentChannelProvider` to access `getMinaContext()` method (same pattern as EVM's `getSigningContext()`)
- **NIP-59 privacy pattern:** `NIP59ClaimWrapper` is chain-agnostic and wraps any `BTPClaimMessage`; when `nip59Enabled` is false, `wrapClaim()` returns null (callers must handle null for passthrough); never include decrypted claim content in error messages or logs
- **Transport provider pattern:** `ConnectorNode._createTransportProvider()` instantiates `DirectTransportProvider` (direct TCP is the only supported transport); never conditionally construct transports from other config fields
- **Transport lifecycle ordering:** in `ConnectorNode.start()`, construct the transport BEFORE outbound I/O, `await provider.start()` BEFORE settlement/BTP init, set `_transportProviderReady = true` AFTER success; in `stop()`, stop the transport LAST (after BTP clients drain). Rollback on start failure must clear `_transportProvider`, `_transportType`, and `_transportProviderReady`.
- **Transport health caching:** a 30s `setInterval` refreshes `_lastTransportHealthy` for the health endpoint; the interval is `.unref()`'d so it never blocks process exit; health endpoint reports `{ type, healthy }` and for `direct` always returns `healthy: true`

### Testing Rules

- **Test files co-located with source:** `module-name.test.ts` next to `module-name.ts` in `src/`; integration tests in `test/integration/`
- **Jest with ts-jest preset:** `testEnvironment: 'node'`, roots `['src', 'test']`, match `**/*.test.ts`
- **Mock logger:** use `pino({ level: 'silent' })` with `jest.spyOn` on methods -- NOT plain `jest.fn()` objects; mock `.child()` to return itself
- **Factory functions for test data:** `createMockLogger()`, `createMockAccountManager()`, `createTestPeer()` -- keep test setup DRY
- **Type-safe partial mocks:** cast with `as unknown as jest.Mocked<Type>` -- never use `any` directly for mock types
- **Private field access in tests:** use `(instance as any)._field` with `// eslint-disable-next-line @typescript-eslint/no-explicit-any`
- **`jest.clearAllMocks()` in `beforeEach`** -- always reset mock state between tests
- **Cleanup in `afterEach`:** stop running services/monitors to prevent test leaks
- **Story references:** include story IDs in describe blocks (e.g., `'Feature X (Story 6.4)'`)
- **`jest.mock()` at file top:** mock dependencies before imports are resolved
- **ILP amounts use `BigInt`:** test data uses `100000n` notation, not `Number`
- **Coverage thresholds:** branches 60%, functions 75%, lines 70%, statements 70%
- **Default timeout:** 30s for most tests; specific overrides for integration (60s for security)
- **Cross-package mapping:** `@toon-protocol/shared` mapped to source via `moduleNameMapper` in jest config
- **Specialized test scripts:** `test:settlement`, `test:btp`, `test:evm`, `test:embedded`, `test:integration`, `test:acceptance`, `test:performance`, `test:domain`, `test:epic`
- **Solana Rust tests:** run via `cargo test-sbf` in `packages/solana-program/` (or `make solana-test`); uses `solana-program-test` with `tokio` async runtime; tests run against a BPF VM -- not a live cluster
- **Solana TS tests:** integration tests in `test/integration/solana-*.ts`; unit tests co-located in `src/settlement/` alongside source files; `solana-bankrun` available as devDependency for local validator simulation
- **Mina zkApp tests:** run via `make mina-test` in `packages/mina-zkapp/`; o1js circuit tests require `experimentalDecorators` and `useDefineForClassFields: false` in tsconfig; test timeouts may need to be longer for proof generation (circuit compilation is slow)
- **Mina TS tests:** integration tests in `test/integration/mina-*.ts`; unit tests co-located in `src/settlement/`; ATDD tests in `mina-payment-channel-sdk.atdd.test.ts`
- **NIP-59 tests:** unit tests in `settlement/privacy/nip59-claim-wrapper.test.ts`; integration tests in `test/integration/mina-nip59.test.ts`; tests cover all three encryption layers (Rumor, Seal, Gift Wrap) and passthrough mode

### Code Quality & Style Rules

- **File naming:** kebab-case for all files (`settlement-monitor.ts`, `btp-client-manager.ts`)
- **Class naming:** PascalCase (`SettlementMonitor`, `BTPClientManager`)
- **Interface naming:** PascalCase without `I` prefix (`PeerConfig`, not `IPeerConfig`)
- **Private fields:** `private readonly _fieldName` pattern
- **Constants:** `UPPER_SNAKE_CASE` for module-level constants (e.g., `DEFAULT_LOG_LEVEL`)
- **Prettier enforced:** single quotes, trailing commas (es5), 100 char width, 2-space indent, LF endings
- **Source organization by domain:** `btp/`, `core/`, `settlement/`, `routing/`, `config/`, `security/`, `utils/`, `settlement/privacy/`, etc.
- **Public API in `lib.ts`:** all public exports consolidated in `packages/connector/src/lib.ts`; `index.ts` re-exports from `lib.ts`
- **JSDoc on public APIs:** use `@remarks`, `@example`, `@param`, `@returns` tags; include `@packageDocumentation` on module entry points
- **Test file doc comments:** describe test scope and what is being tested at the top of each test file
- **lint-staged pre-commit:** ESLint fix + Prettier on `.ts/.tsx`; Prettier only on `.js/.json/.md`
- **Barrel exports:** provider module uses `index.ts` barrel with explicit `export type` separation

### Development Workflow Rules

- **Branch naming:** `epic-{number}` for feature branches; `main` is production
- **Commit messages:** Conventional Commits format `{type}({scope}): {description}` -- types: `feat`, `fix`, `style`, `qa`, `docs`, `chore`, `security`, `test`; scope is epic number or feature area
- **Pre-commit hook:** lint-staged runs `eslint --fix` + `prettier --write` on staged `.ts/.tsx` files
- **Pre-push hook:** optimized -- runs lint/format/related unit tests only for changed source files; auto-skips for docs-only or config-only changes
- **Build order matters:** `packages/shared` MUST build before `packages/connector` and `packages/mina-zkapp` (shared provides type definitions); use `npm run build --workspace=packages/shared` first
- **CI gates (required to pass):** lint, format, tests (Node 22.11.0 + 22.x), TypeScript type check, build, EVM contract tests, Solana program tests (`cargo test-sbf`), Mina zkApp tests (`make mina-test`)
- **CI gates (advisory):** security audit (npm audit + Snyk), container scan (Trivy), performance benchmark
- **Docker deployment:** images pushed to GHCR on merge to main; multi-platform (amd64 + arm64); multi-stage build with node:22-alpine
- **Config via YAML:** connector topology defined in YAML config files; validated by Zod at startup
- **semantic-release:** version bumps and changelogs auto-generated from conventional commit messages
- **Makefile shortcuts:** `make build`, `make test`, `make test-unit`, `make lint`, `make clean`, `make anvil-up`, `make anvil-down`, `make anvil-logs`, `make solana-up`, `make solana-down`, `make solana-logs`, `make mina-up`, `make mina-down`, `make mina-logs`, `make infra-up`, `make infra-down`, `make solana-build`, `make solana-test`, `make solana-deploy-devnet`, `make mina-build`, `make mina-test`, `make mina-deploy-devnet`

### Critical Don't-Miss Rules

- **ILP amounts are `BigInt`** -- NEVER use `Number` for amounts; values can exceed `Number.MAX_SAFE_INTEGER`; use `100000n` literal notation
- **TigerBeetle is optional** -- it's a peer dependency with `optional: true`; code MUST handle its absence gracefully with fallback to in-memory or SQLite
- **BTP has two error types** -- `BTPConnectionError` (network) vs `BTPAuthenticationError` (auth); handle both separately in catch blocks
- **ILP packet expiry decrement** -- per RFC-0027, connectors MUST reduce packet expiry by safety margin (1s) before forwarding to prevent timeout cascades
- **Settlement is threshold-based** -- on-chain settlement triggers on balance or time thresholds, NOT per-packet; per-packet claims are signed and sent via BTP but accumulated off-chain
- **Self-describing claims (Epic 31)** -- claims carry chain/contract coordinates in BTP protocolData; receivers verify dynamically on-chain without pre-registration
- **Chain abstraction (Epic 32)** -- settlement services use `ChainProviderRegistry` to resolve the correct `PaymentChannelProvider` per peer; never import chain-specific code in service classes
- **Provider string amounts** -- `PaymentChannelProvider` interface uses string amounts for bigint precision; all providers (`EVM`, `Solana`, `Mina`) convert to bigint via `safeBigInt()` internally
- **`@toon-protocol/shared` import path** -- always `import { Type } from '@toon-protocol/shared'`; never import from dist or relative paths across packages
- **Buffer usage for binary data** -- ILP packets use `Buffer` (not `Uint8Array`) for `data`, `executionCondition`, `fulfillment` fields
- **PacketType enum values matter** -- `PREPARE=12`, `FULFILL=13`, `REJECT=14` per RFC-0027; don't use arbitrary values
- **Optional dependencies pattern** -- many packages are `optionalDependencies`; use dynamic `require()` with try-catch or the project's `optional-require` utility
- **YAML config is the source of truth** -- network topology, peers, routes, chain providers, and settlement config all come from YAML; never hardcode topology
- **ILP addresses are hierarchical** -- dot-separated format (e.g., `g.alice.wallet.USD`); validate with `isValidILPAddress()` from shared package
- **chainProviders is the only settlement config** -- `settlementInfra` has been removed; a migration guard throws if detected. `EVMProviderConfig` includes `tokenAddress` (required) and `settlementOptions` (optional). Per-peer `chain` field is optional (defaults to primary EVM provider when absent)
- **Solana PDA seeds matter** -- channel PDAs derived from `["channel", sender, receiver, mint]`; changing seed order or contents produces a different address and will fail on-chain validation
- **Solana signature payload** -- Ed25519 signatures sign `(channel_pda ++ nonce_le ++ amount_le)` as raw bytes; must match the on-chain `processor.rs` verification exactly -- any mismatch causes `InvalidSignature` error
- **Solana instruction discriminators** -- each instruction has a 1-byte discriminator (e.g., `OpenChannel=0`, `Deposit=1`); must match between `instruction.rs` (Rust) and `solana-payment-channel-sdk.ts` (TypeScript) -- desync causes `InvalidInstruction` error
- **Solana account ordering** -- on-chain instructions require accounts in a specific order with correct `is_signer`/`is_writable` flags; the TypeScript SDK constructs `AccountMeta[]` arrays that must match `processor.rs` exactly
- **Multi-chain claim routing** -- `BTPClaimMessage.blockchain` field is the discriminator; `ClaimReceiver` dispatches to the correct `PaymentChannelProvider` via registry -- never switch on blockchain type in business logic
- **Mina zkApp uses exactly 8 state fields** -- Mina protocol enforces a maximum of 8 `Field` elements per SmartContract; the `PaymentChannel` contract uses all 8 -- adding new state fields requires architectural changes
- **Mina `tokenId_` naming** -- the on-chain state field is named `tokenId_` (with trailing underscore) to avoid collision with the built-in `SmartContract.tokenId` property in o1js; always use `tokenId_` in zkApp code
- **Mina Field arithmetic is modular** -- Field elements are ~254-bit integers modulo the pasta prime; adding two large Fields can silently wrap around; always bound amounts and nonces to `MAX_SAFE_AMOUNT` (2^64 - 1) before arithmetic
- **Mina balance commitment format** -- `Poseidon.hash([balanceA, balanceB, salt])` with three Field inputs; changing the order or adding/removing inputs produces a different hash and breaks commitment verification
- **Mina channel hash format** -- `Poseidon.hash([participantA.x, participantB.x, nonce])` uses only the x-coordinate of participant public keys; do not use the full public key
- **Mina o1js decorators require special tsconfig** -- `experimentalDecorators: true`, `emitDecoratorMetadata: true`, `useDefineForClassFields: false` must all be set in `packages/mina-zkapp/tsconfig.json`; without `useDefineForClassFields: false`, the `@state` decorator silently fails
- **Mina proof generation is slow** -- zkApp proof compilation and generation takes 30-120s; the `MinaPaymentChannelProvider` pre-compiles during construction (fire-and-forget); never await proof generation synchronously in hot paths
- **Mina dynamic o1js import** -- the connector package NEVER imports o1js directly; all o1js interactions go through `MinaPaymentChannelSDK` which uses dynamic `import('o1js')` -- this ensures the connector can start without o1js installed (Mina is optional)
- **NIP-59 is chain-agnostic** -- `NIP59ClaimWrapper` wraps any `BTPClaimMessage` regardless of blockchain type; it hides the `blockchain` discriminator from BTP intermediaries inside the encrypted payload
- **NIP-59 timestamp randomization** -- wrapped claims have timestamps randomized within +/-48 hours of actual send time; never use the wrapped timestamp for ordering or freshness checks
- **NIP-59 ephemeral keys** -- each wrapped claim uses a fresh one-time secp256k1 keypair for the outer Gift Wrap layer; never reuse ephemeral keys across messages
- **NIP-59 passthrough mode** -- when `nip59Enabled` is false, `wrapClaim()` returns `null`; callers must check for null and send the claim in plaintext via the standard `payment-channel-claim` BTP protocol
- **Transport defaults are load-bearing** -- `ConfigLoader.validateTransport()` defaults missing `transport` blocks to `{ type: 'direct' }`; existing deployments without a `transport:` key get unchanged behavior. Adding a `transport:` block is an opt-in.
- **Transport provider starts before BTP clients, stops after** -- in `ConnectorNode.start()`, transport init runs BEFORE outbound I/O; in `stop()`, transport teardown runs LAST. Rollback on startup failure clears `_transportProvider`, `_transportType`, `_transportProviderReady` -- the public `transportProvider` getter reports `null` until ready.
- **Transport exhaustiveness guard** -- `_createTransportProvider` ends with a `const _exhaustive: never = cfg;` arm. Adding a new `TransportConfig.type` variant is a compile error at every switch site until all are updated -- exploit this for safe transport extensions.

---

## Usage Guidelines

**For AI Agents:**

- Read this file before implementing any code
- Follow ALL rules exactly as documented
- When in doubt, prefer the more restrictive option
- Update this file if new patterns emerge

**For Humans:**

- Keep this file lean and focused on agent needs
- Update when technology stack changes
- Review quarterly for outdated rules
- Remove rules that become obvious over time

Last Updated: 2026-04-14 (Epic 35 -- ATOR Overlay Transport for Privacy-Enabled Peering complete)
