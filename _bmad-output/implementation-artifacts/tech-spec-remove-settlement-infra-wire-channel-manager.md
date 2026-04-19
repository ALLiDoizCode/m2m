---
title: 'Remove settlementInfra, wire ChannelManager to chainProviders'
slug: 'remove-settlement-infra-wire-channel-manager'
created: '2026-04-19'
status: 'implementation-complete'
stepsCompleted: [1, 2, 3, 4]
tech_stack: ['TypeScript 5.3.3', 'ethers 6.16.0', 'Zod 3.25.76', 'Jest 29.7.0', 'Pino 8.21.0']
files_to_modify:
  - 'packages/connector/src/settlement/provider/payment-channel-provider.ts'
  - 'packages/connector/src/config/types.ts'
  - 'packages/connector/src/config/config-loader.ts'
  - 'packages/connector/src/core/connector-node.ts'
  - 'packages/connector/src/lib.ts'
  - 'packages/connector/src/config/chain-provider-config.test.ts'
  - 'packages/connector/test/unit/config-driven-settlement.test.ts'
  - '_bmad-output/project-context.md'
code_patterns:
  - 'chainProviders config array with ChainProviderConfigEntry = ProviderConfig & { chainId: string }'
  - 'ChainProviderRegistry for provider lookup by chainId'
  - 'KeyManager(config: KeyManagerConfig, logger) with backend: env and evmPrivateKey field'
  - 'PaymentChannelSDK(provider, keyManager, keyId, registryAddress, logger)'
  - 'ChannelManager constructor takes registryAddress, rpcUrl, privateKey, tokenAddressMap, etc.'
  - 'EVMPaymentChannelProvider(sdk, chainId, tokenAddress, logger)'
  - 'Graceful degradation: try/catch around settlement init, log error, continue without _channelManager'
test_patterns:
  - 'Jest with ts-jest preset, testEnvironment: node'
  - 'Mock logger via pino({ level: silent }) with jest.spyOn'
  - 'Factory functions for test data (createMockLogger, createTestPeer)'
  - 'jest.clearAllMocks() in beforeEach'
  - 'Private field access: (instance as any)._field'
---

# Tech-Spec: Remove settlementInfra, wire ChannelManager to chainProviders

**Created:** 2026-04-19

## Overview

### Problem Statement

`ConnectorNode.openChannel()` throws `"Settlement infrastructure not enabled"` when the connector is configured with `chainProviders` but without `settlementInfra`. The root cause is that `_channelManager` (and its dependency `KeyManager`) is only initialized inside the `settlementInfra` code path in `connector-node.ts` (~line 546). The `chainProviders` config surface was added (types accept it, multi-chain provider registration works), but `_channelManager` initialization was never wired to derive its inputs from `chainProviders`. This blocks all SDK E2E tests that use `openChannel()` with `chainProviders` only.

### Solution

Remove the `settlementInfra` config surface entirely (not deprecate -- remove). Derive `KeyManager` and `ChannelManager` initialization inputs from `chainProviders[evm]`. Add `tokenAddress` to the EVM `ChainProviderConfig` type. Treat `keyId` as the raw private key input to KeyManager (matching current usage). Add startup validation that throws a descriptive error if the removed `settlementInfra` config is detected.

### Scope

**In Scope:**
- Remove `settlementInfra` from config types (`types.ts`), config loader (`config-loader.ts`), and validation
- Move KeyManager initialization out of the `settlementInfra` gate to derive from `chainProviders[evm]`
- Add `tokenAddress` field to EVM chain provider config type
- Add startup guard: throw descriptive error if `settlementInfra` is present in config
- Add startup warning when removed env vars (`BASE_L2_RPC_URL`, `SETTLEMENT_ENABLED`, etc.) are detected
- Preserve graceful degradation (KeyManager/ChannelManager init failure is non-fatal)
- Update all tests referencing `settlementInfra`
- Remove `SettlementInfraConfig` export from `lib.ts`
- Update `project-context.md` to reflect removal (not deprecation)

**Out of Scope:**
- KMS/HSM key resolution (`keyId` remains raw key for now)
- Solana/Mina ChannelManager wiring (separate concern)
- TOON Protocol downstream test fixes (separate repo)

## Context for Development

### Codebase Patterns

- Settlement services use `ChainProviderRegistry` to resolve the correct `PaymentChannelProvider` per peer
- KeyManager (`packages/connector/src/security/key-manager.ts`) constructor takes `KeyManagerConfig` with `backend: 'env'`, `nodeId: string`, `evmPrivateKey?: string`; currently initialized at line 565-572 inside the `settlementInfra` gate
- PaymentChannelSDK constructor: `(ethers.JsonRpcProvider, keyManager, keyId: string, registryAddress: string, logger)`
- EVMPaymentChannelProvider constructor: `(sdk, chainId, tokenAddress: string, logger)`
- ChannelManager constructor takes a config object with `registryAddress`, `rpcUrl`, `privateKey`, `tokenAddressMap`, plus `paymentChannelSDK`, `settlementExecutor`, `logger`
- Graceful degradation: lines 1107-1114 wrap settlement init in try/catch; on error, connector continues without `_channelManager`
- `chainProviders` is already partially processed: line ~854 finds the EVM entry's `chainId`; the `ChainProviderRegistry` is built at line ~860
- Config validation uses Zod schemas in `config-loader.ts`
- `EVMProviderConfig` (in `payment-channel-provider.ts` lines 236-245) currently has: `chainType`, `rpcUrl`, `registryAddress`, `keyId` -- no `tokenAddress`
- `SettlementInfraConfig` (lines 822-892 in `types.ts`) has 11 optional fields including `enabled`, `tokenAddress`, `privateKey`, `threshold`, `pollingIntervalMs`, `settlementTimeoutSecs`, `initialDepositMultiplier`, `ledgerSnapshotPath`, `ledgerPersistIntervalMs`
- **`validateChainProviders()` function is in `types.ts` (L1881-1939), NOT in `config-loader.ts`** -- it references `config.settlementInfra` at L1886 and includes deprecation warning logic
- **`REQUIRED_FIELDS_BY_CHAIN_TYPE` is in `types.ts` (~L1851)** -- currently lists `evm: ['rpcUrl', 'registryAddress', 'keyId']`; does NOT include `tokenAddress`

### Anchor Points (Exact Line References)

| Location | Lines | What's There | What Changes |
| ---- | ----- | ------------ | ------------ |
| `types.ts` L354 | `settlementInfra?: SettlementInfraConfig` on ConnectorConfig | Remove field |
| `types.ts` L822-892 | `SettlementInfraConfig` interface (11 fields) | Delete entire interface |
| `types.ts` ~L1851 | `REQUIRED_FIELDS_BY_CHAIN_TYPE` -- evm: `['rpcUrl', 'registryAddress', 'keyId']` | Add `'tokenAddress'` to EVM required fields |
| `types.ts` L1881-1939 | `validateChainProviders()` -- references `config.settlementInfra` at L1886 | Remove `settlementInfra` reference and deprecation logic |
| `config-loader.ts` L25 | Import `SettlementInfraConfig` | Remove import |
| `config-loader.ts` L196 | Pass-through `settlementInfra` in `validateConfig()` | Remove; add migration guard |
| `connector-node.ts` L545-561 | Settlement gate: extract 5 vars from `settlementInfra` | Replace with `chainProviders[evm]` extraction |
| `connector-node.ts` L565-572 | KeyManager init with `treasuryPrivateKey` | Use `evmProvider.keyId` instead |
| `connector-node.ts` L577-589 | PaymentChannelSDK init | Use `evmProvider.rpcUrl`, `evmProvider.registryAddress` |
| `connector-node.ts` ~L646 | Comment referencing `settlementInfra` fallbacks | Remove stale comment |
| `connector-node.ts` L713-717 | `settlementTimeoutSecs`, `initialDepositMultiplier` | Source from `evmProvider.settlementOptions` or defaults |
| `connector-node.ts` L825-826 | `threshold` from settlementInfra | Source from `evmProvider.settlementOptions` or defaults |
| `connector-node.ts` L850-866 | ChainProviderRegistry + EVMPaymentChannelProvider | Pass `tokenAddress` from provider config |
| `connector-node.ts` L947-964 | ChannelManager constructor | Derive args from `chainProviders[evm]` |
| `connector-node.ts` L1823-1829 | Ledger snapshot path/interval | Source from `evmProvider.settlementOptions` or defaults |
| `connector-node.ts` L2334 | `openChannel()` guard | Update error message only |
| `payment-channel-provider.ts` L236-245 | `EVMProviderConfig` interface | Add `tokenAddress` + optional `settlementOptions` |
| `lib.ts` L71 | Export `SettlementInfraConfig` | Remove export |

### Technical Decisions

1. **Remove, don't deprecate**: `settlementInfra` is removed entirely. A startup guard in `config-loader.ts` throws a descriptive migration error if `settlementInfra` key is detected in raw config.
2. **Option 3 (keyId as raw key)**: `keyId` on `chainProviders[evm]` is treated as the raw private key input to KeyManager. Matches current TOON Protocol usage.
3. **`tokenAddress` on EVMProviderConfig**: Required field. Also added to `REQUIRED_FIELDS_BY_CHAIN_TYPE` for runtime validation.
4. **Settlement tuning params**: `threshold`, `settlementTimeoutSecs`, `initialDepositMultiplier`, `pollingIntervalMs`, `ledgerSnapshotPath`, `ledgerPersistIntervalMs` move to optional `settlementOptions` sub-object on `EVMProviderConfig`.
5. **Graceful degradation preserved**: If `chainProviders[evm]` is present but KeyManager/ChannelManager init fails, log error and continue without `_channelManager`. If no `chainProviders[evm]` exists, skip settlement init entirely (no error).
6. **Env var fallbacks removed with warnings**: The `process.env` fallbacks are removed. A startup warning is logged if any legacy env vars are set, directing the user to use `chainProviders` instead.
7. **Presence of `chainProviders[evm]` = settlement enabled**: No `enabled` toggle on `EVMProviderConfig`. If you configure an EVM chain provider, settlement is active. To disable settlement, remove the EVM entry from `chainProviders`. This is simpler and avoids the confusing state of "configured but disabled."

## Implementation Plan

### Tasks

**IMPORTANT: Tasks 1-5 must be implemented together in a single commit. Task 2 (deleting `SettlementInfraConfig`) will cause compile errors in `connector-node.ts` that are only resolved by Task 4. Do not attempt incremental commits for Tasks 1-5.**

- [x] **Task 1: Extend `EVMProviderConfig` with `tokenAddress` and `settlementOptions`**
  - File: `packages/connector/src/settlement/provider/payment-channel-provider.ts`
  - Action: Add `tokenAddress: string` as a required field on `EVMProviderConfig` (L236-245). Add optional `settlementOptions?: { threshold?: string; settlementTimeoutSecs?: number; initialDepositMultiplier?: number; pollingIntervalMs?: number; ledgerSnapshotPath?: string; ledgerPersistIntervalMs?: number }` sub-object.
  - Notes: Lowest-level change -- everything else depends on this type being updated. `tokenAddress` is required because `EVMPaymentChannelProvider` needs it in its constructor.

- [x] **Task 2: Remove `SettlementInfraConfig` type, update `validateChainProviders` and `REQUIRED_FIELDS_BY_CHAIN_TYPE` in `types.ts`**
  - File: `packages/connector/src/config/types.ts`
  - Action:
    1. Delete the `SettlementInfraConfig` interface (L822-892).
    2. Remove the `settlementInfra?: SettlementInfraConfig` field from `ConnectorConfig` (L354) and its deprecation comment block (L340-353).
    3. Update `REQUIRED_FIELDS_BY_CHAIN_TYPE` (~L1851): add `'tokenAddress'` to EVM entry so it becomes `evm: ['rpcUrl', 'registryAddress', 'keyId', 'tokenAddress']`.
    4. Update `validateChainProviders()` (L1881-1939): remove the `config.settlementInfra` reference at L1886 and the entire deprecation warning block. Function should validate `chainProviders` structure without referencing `settlementInfra`.
  - Notes: **`validateChainProviders` is in THIS file (types.ts), not in config-loader.ts.** The `ChainProviderConfigEntry` type at L68 automatically picks up `tokenAddress` from Task 1 since `EVMProviderConfig` is part of the `ProviderConfig` union.

- [x] **Task 3: Add migration guard, env var warnings, and remove `settlementInfra` from config loader**
  - File: `packages/connector/src/config/config-loader.ts`
  - Action:
    1. Remove the `SettlementInfraConfig` import (L25).
    2. Remove `settlementInfra` pass-through from `validateConfig()` (L196).
    3. Add migration guard at top of `validateConfig()`: if `'settlementInfra' in rawConfig`, throw `new Error('Configuration error: "settlementInfra" has been removed. Use "chainProviders" with an EVM entry instead. Configure chainProviders with chainType "evm", rpcUrl, registryAddress, keyId, and tokenAddress.')`.
    4. Add env var detection: after config validation, check if any of `BASE_L2_RPC_URL`, `SETTLEMENT_ENABLED`, `TOKEN_NETWORK_REGISTRY`, `M2M_TOKEN_ADDRESS`, `TREASURY_EVM_PRIVATE_KEY` are set in `process.env`. If so, log a warning: `'Detected legacy settlement env vars -- these are no longer used. Configure chainProviders with an EVM entry instead.'`.
  - Notes: Use `'settlementInfra' in rawConfig` (property-in check on raw object) rather than checking validated config.

- [x] **Task 4: Rewire `connector-node.ts` from `settlementInfra` to `chainProviders[evm]`**
  - File: `packages/connector/src/core/connector-node.ts`
  - Action:
    1. **Replace settlement gate (L545-561):** Find EVM chain provider: `const evmProvider = this._config.chainProviders?.find((p) => p.chainType === 'evm') as EVMProviderConfig & { chainId: string } | undefined;`. New gate: `if (evmProvider) { ... }`. No `enabled` toggle -- presence = enabled.
    2. **Derive variables:** `baseRpcUrl = evmProvider.rpcUrl`, `registryAddress = evmProvider.registryAddress`, `m2mTokenAddress = evmProvider.tokenAddress`, `treasuryPrivateKey = evmProvider.keyId`.
    3. **KeyManager init (L565-572):** Same structure, source changes to `evmProvider.keyId`.
    4. **PaymentChannelSDK init (L577-589):** Same structure, source changes to `evmProvider`.
    5. **Settlement tuning params (L713-717, L825-826, L1823-1829):** Replace `this._config.settlementInfra?.X` with `evmProvider.settlementOptions?.X`. Defaults: `settlementTimeoutSecs: 86400`, `threshold: '1000000'`, others: keep existing defaults.
    6. **Remove stale comment (~L646)** referencing `settlementInfra` fallbacks.
    7. **EVMPaymentChannelProvider init (L860-866):** Pass `evmProvider.tokenAddress`.
    8. **ChannelManager init (L947-964):** Derive args from `evmProvider`.
    9. **Remove all `process.env` fallbacks:** `BASE_L2_RPC_URL`, `SETTLEMENT_ENABLED`, `TOKEN_NETWORK_REGISTRY`, `M2M_TOKEN_ADDRESS`, `TREASURY_EVM_PRIVATE_KEY`, `SETTLEMENT_THRESHOLD`.
    10. **Preserve try/catch graceful degradation block** -- no changes to error handling.
    11. **Update `openChannel()` error message (L2334):** Change to `'No EVM chain provider configured -- openChannel requires a chainProviders entry with chainType: "evm"'`.
    12. **Grep for remaining `settlementInfra` references** and remove all (comments, stale code).
  - Notes: After this task, zero `settlementInfra` references should remain in this file.

- [x] **Task 5: Remove `SettlementInfraConfig` export from public API**
  - File: `packages/connector/src/lib.ts`
  - Action: Remove `SettlementInfraConfig` from exports (L71).

- [x] **Task 6: Update config tests**
  - File: `packages/connector/src/config/chain-provider-config.test.ts`
  - Action: Update all 20 `settlementInfra` references. Convert coexistence/deprecation tests to migration guard tests. Convert settlement config tests to `chainProviders[evm]` with `tokenAddress` and `settlementOptions`. Add test that `REQUIRED_FIELDS_BY_CHAIN_TYPE` now requires `tokenAddress` for EVM providers.
  - Notes: Preserve test coverage intent -- each removed assertion needs an equivalent for `chainProviders`.

- [x] **Task 7: Update settlement integration tests**
  - File: `packages/connector/test/unit/config-driven-settlement.test.ts`
  - Action: Convert ~16 `settlementInfra` refs to `chainProviders[evm]` config. Add new test cases:
    1. `chainProviders[evm]` with `tokenAddress` + `keyId` initializes `_channelManager`
    2. No `chainProviders[evm]` entry -> `_channelManager` null, `openChannel()` throws descriptive error
    3. `settlementInfra` in config -> throws migration error
    4. `settlementOptions` overrides applied correctly
    5. KeyManager init fails -> graceful degradation
    6. Legacy env vars set -> startup warning logged

- [x] **Task 8: Update `project-context.md`**
  - File: `_bmad-output/project-context.md`
  - Action: Find and update all references to "Legacy `settlementInfra` field deprecated" and related text. Replace with documentation that `settlementInfra` has been removed and `chainProviders[evm]` is the only config path. Update `EVMProviderConfig` description to include `tokenAddress` and `settlementOptions`. Remove mentions of backward compatibility with `settlementInfra`.

### Acceptance Criteria

- [x] **AC 1:** Given `chainProviders` with an EVM entry containing `rpcUrl`, `registryAddress`, `tokenAddress`, and `keyId`, when `ConnectorNode.start()` is called, then `_channelManager` is initialized and `openChannel()` succeeds.
- [x] **AC 2:** Given no `chainProviders` array (or no EVM entry), when `ConnectorNode.start()` is called, then `_channelManager` remains null and `openChannel()` throws `'No EVM chain provider configured -- openChannel requires a chainProviders entry with chainType: "evm"'`.
- [x] **AC 3:** Given `settlementInfra` key present in config, when config validation runs, then it throws an error containing `"settlementInfra" has been removed. Use "chainProviders"`.
- [x] **AC 4:** Given `chainProviders[evm]` with `settlementOptions.threshold` and `settlementOptions.settlementTimeoutSecs`, when `ConnectorNode.start()` is called, then those values are used instead of defaults.
- [x] **AC 5:** Given `chainProviders[evm]` where KeyManager init fails, when `ConnectorNode.start()` is called, then error is logged, `_channelManager` remains null, connector continues routing ILP packets.
- [x] **AC 6:** Given the `EVMProviderConfig` type, it includes `tokenAddress: string` (required) and `settlementOptions?: { ... }` (optional).
- [x] **AC 7:** Given `lib.ts` exports, `SettlementInfraConfig` is no longer exported.
- [x] **AC 8:** Given tests in `chain-provider-config.test.ts` and `config-driven-settlement.test.ts`, all pass with `chainProviders`-based config (no `settlementInfra` references remain).
- [x] **AC 9:** Given `chainProviders[evm]` missing `tokenAddress`, when `validateChainProviders()` runs, then it rejects with a validation error indicating `tokenAddress` is required.
- [x] **AC 10:** Given legacy env vars (`BASE_L2_RPC_URL`, `SETTLEMENT_ENABLED`, etc.) are set, when connector starts without `chainProviders[evm]`, then a warning is logged indicating these env vars are no longer used.
- [x] **AC 11:** Given a grep of the source tree (excluding `node_modules` and test files), searching for `settlementInfra` returns zero matches.

## Additional Context

### Dependencies

- No new dependencies required
- Breaking change: users passing `settlementInfra` get a descriptive error directing them to `chainProviders`
- Breaking change: env var fallbacks removed -- startup warning logged if detected
- Breaking change: `SettlementInfraConfig` type export removed from `@toon-protocol/connector`
- Design decision: `chainProviders[evm]` presence = settlement enabled. No `enabled` toggle.

### Testing Strategy

**Unit Tests (update existing):**
- `chain-provider-config.test.ts` -- convert 20 refs; add migration guard + `tokenAddress` required field tests
- `config-driven-settlement.test.ts` -- convert ~16 refs to `chainProviders` path

**Unit Tests (new assertions):**
- `chainProviders[evm]` with full config initializes ChannelManager
- Missing `chainProviders[evm]` leaves `_channelManager` null
- `settlementInfra` in config throws migration error
- `REQUIRED_FIELDS_BY_CHAIN_TYPE` requires `tokenAddress` for EVM
- `settlementOptions` overrides applied correctly
- Graceful degradation when KeyManager init fails
- Legacy env var warning logged at startup

**Manual Verification:**
- `npm run build` succeeds
- `make test` passes
- `make lint` passes
- `grep -r 'settlementInfra' packages/connector/src/ --include='*.ts' | grep -v test | grep -v node_modules` returns zero results

### Notes

- Gap doc `docs/channelmanager-chainproviders-gap.md` is currently untracked -- commit before or alongside this change so migration error references a valid path
- 5 TOON Protocol SDK E2E tests blocked -- unblocked once their configs add `tokenAddress` to `chainProviders[evm]`
- `keyId` naming is aspirational (implies KMS lookup) but currently holds a raw private key -- known tech debt, out of scope
- `pollingIntervalMs` included in `settlementOptions` for completeness; verify at implementation time whether consumed in `connector-node.ts` or downstream services only
