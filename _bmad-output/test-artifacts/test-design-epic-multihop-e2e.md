---
stepsCompleted:
  - step-01-detect-mode
  - step-02-load-context
  - step-03-risk-and-testability
  - step-04-coverage-plan
  - step-05-generate-output
lastStep: step-05-generate-output
lastSaved: '2026-03-11'
revision: 'v2-no-mocks'
revisionNote: 'Aligned with architecture: integration tests use real Anvil, no mocks'
inputDocuments:
  - packages/connector/src/core/packet-handler.ts
  - packages/connector/src/settlement/settlement-executor.ts
  - packages/connector/src/settlement/settlement-monitor.ts
  - packages/connector/src/settlement/per-packet-claim-service.ts
  - packages/connector/src/settlement/account-manager.ts
  - packages/connector/src/settlement/channel-manager.ts
  - packages/connector/src/settlement/claim-receiver.ts
  - packages/connector/src/settlement/claim-sender.ts
  - packages/connector/src/test-utils/index.ts
  - packages/connector/src/test-utils/mock-factories.ts
  - packages/connector/src/config/types.ts
---

# Test Design: Multi-Hop E2E Integration Test (5-Peer Settlement Lifecycle)

**Date:** 2026-03-11
**Author:** Jonathan
**Status:** Draft (v2 — no mocks, real Anvil)

---

## Executive Summary

**Scope:** Full test design for a comprehensive 5-peer multi-hop E2E integration test covering the complete ILP packet lifecycle, balance tracking, per-packet claims, and settlement triggers across a linear chain topology.

**Architecture Constraint:** Integration tests use real Anvil blockchain — no mocks. Real contracts, real signatures, real channel operations.

**Risk Summary:**

- Total risks identified: 11
- High-priority risks (>=6): 5 (R-005 elevated to 9 due to Anvil RPC overhead)
- Critical categories: TECH (BTP race conditions), PERF (real EVM latency), DATA (balance drift)

**Coverage Summary:**

- P0 scenarios: 6 (~18-24 hours)
- P1 scenarios: 7 (~14-21 hours) — added self-describing claim on-chain verification
- P2 scenarios: 5 (~5-10 hours)
- P3 scenarios: 2 (~2-4 hours)
- **Total effort**: ~39-59 hours (~5-8 days)

---

## Not in Scope

| Item                             | Reasoning                                                                                        | Mitigation                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **TigerBeetle backend**          | InMemoryLedgerClient used instead. TigerBeetle requires separate Docker service                  | InMemoryLedgerClient implements same interface; TigerBeetle-specific tests are separate |
| **Explorer UI / HTTP Admin API** | UI and admin API are separate concerns not part of packet flow E2E                               | Covered by existing unit tests and future UI tests                                      |
| **Multi-chain settlement**       | Single chain (Anvil, chainId 31337) only. Multi-chain adds complexity without covering core flow | Future test when multi-chain is implemented                                             |

## In Scope (Architecture Alignment)

Per the architecture: **"Integration tests run against real infrastructure — never mocks."**

| Item                                   | How                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| **Real Anvil blockchain**              | `make anvil-up` starts Anvil + Faucet via docker-compose                           |
| **Real smart contracts**               | `DeployLocal.s.sol` deploys TokenNetworkRegistry, TokenNetwork, MockERC20 to Anvil |
| **Real PaymentChannelSDK**             | Each peer gets a real SDK instance connected to `http://localhost:8545`            |
| **Real EIP-712 signatures**            | Claims signed with real private keys, verified on-chain                            |
| **Real channel operations**            | Open, deposit, claim, close via real Solidity contracts                            |
| **Real token balances**                | MockERC20 funded via faucet service (port 3500)                                    |
| **Self-describing claim verification** | Dynamic on-chain channel state lookup for unknown channels                         |

---

## Test Topology

```
                    LINEAR CHAIN TOPOLOGY (5 PEERS)

  Peer1 ───BTP───> Peer2 ───BTP───> Peer3 ───BTP───> Peer4 ───BTP───> Peer5
  :8101            :8102            :8103            :8104            :8105

  ILP: test.peer1  ILP: test.peer2  ILP: test.peer3  ILP: test.peer4  ILP: test.peer5

  Routes:
  Peer1: test.peer2.* → peer2, test.peer3.* → peer2, test.peer4.* → peer2, test.peer5.* → peer2
  Peer2: test.peer1.* → peer1, test.peer3.* → peer3, test.peer4.* → peer3, test.peer5.* → peer3
  Peer3: test.peer1.* → peer2, test.peer2.* → peer2, test.peer4.* → peer4, test.peer5.* → peer4
  Peer4: test.peer1.* → peer3, test.peer2.* → peer3, test.peer3.* → peer3, test.peer5.* → peer5
  Peer5: test.peer1.* → peer4, test.peer2.* → peer4, test.peer3.* → peer4, test.peer4.* → peer4

  Settlement Config (all peers):
  - InMemoryLedgerClient (no TigerBeetle)
  - connectorFeePercentage: 0.1%
  - settlementThreshold: 5000n
  - pollingInterval: 100ms (fast for testing)
  - Per-packet claims enabled (real PaymentChannelSDK against Anvil)

  EVM Infrastructure (Docker):
  - Anvil: localhost:8545 (chainId 31337, deterministic accounts)
  - Faucet: localhost:3500 (100 ETH + 10,000 USDC per drip)
  - Contracts: TokenNetworkRegistry, TokenNetwork, MockERC20 (deployed by DeployLocal.s.sol)

  Anvil Accounts (deterministic private keys):
  - Account 0 (deployer):  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
  - Account 1 (faucet):    0x70997970C51812dc3A010C7d01b50e0d17dc79C8
  - Account 2 (Peer1):     0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
  - Account 3 (Peer2):     0x90F79bf6EB2c4f870365E785982E1f101E93b906
  - Account 4 (Peer3):     0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
  - Account 5 (Peer4):     0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
  - Account 6 (Peer5):     0x976EA74026E726554dB657fA54763abd0C3a0aa9
```

### Configuration Strategy

Each ConnectorNode is instantiated with a programmatic `ConnectorConfig` object using config-driven settlement (no process.env mutation):

```typescript
// Anvil deterministic addresses (from DeployLocal.s.sol)
const ANVIL_RPC_URL = 'http://localhost:8545';
const REGISTRY_ADDRESS = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const TOKEN_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

// Anvil deterministic private keys (accounts 2-6 for Peers 1-5)
const PEER_KEYS = [
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // Account 2
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // Account 3
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // Account 4
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', // Account 5
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e', // Account 6
];

// Example: Peer2 config (middle connector)
const peer2Config: ConnectorConfig = {
  nodeId: 'peer2',
  ilpAddress: 'test.peer2',
  btpServerPort: 8102,
  environment: 'development',
  peers: [
    {
      id: 'peer1',
      url: 'ws://localhost:8101',
      authToken: 'test-token-1-2',
      evmAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    },
    {
      id: 'peer3',
      url: 'ws://localhost:8103',
      authToken: 'test-token-2-3',
      evmAddress: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
    },
  ],
  routes: [
    { prefix: 'test.peer1', nextHop: 'peer1' },
    { prefix: 'test.peer3', nextHop: 'peer3' },
    { prefix: 'test.peer4', nextHop: 'peer3' },
    { prefix: 'test.peer5', nextHop: 'peer3' },
  ],
  settlementInfra: {
    enabled: true,
    privateKey: PEER_KEYS[1], // Account 3 (Peer2)
    rpcUrl: ANVIL_RPC_URL,
    registryAddress: REGISTRY_ADDRESS,
    tokenAddress: TOKEN_ADDRESS,
    threshold: '5000',
    pollingIntervalMs: 100, // Fast for testing
    settlementTimeoutSecs: 3600, // 1 hour for test
    initialDepositMultiplier: 2,
    ledgerSnapshotPath: './data/ledger-peer2.json',
  },
};
```

### Startup Sequence (R-001 + R-004 Mitigation)

Infrastructure and connector startup in dependency order:

```
Phase 0: EVM Infrastructure (prerequisite — before test file runs)
  0a. make anvil-up                          # Start Anvil + deploy contracts + start faucet
  0b. Wait for Anvil health (RPC responds)
  0c. Wait for faucet health (GET /health)

Phase 1: Account Funding (beforeAll)
  1a. Fund Peer accounts 2-6 via faucet      # POST /api/request for each address
      → Each receives 100 ETH + 10,000 USDC
  1b. Verify token balances on-chain          # ethers.Contract.balanceOf() for each account

Phase 2: Connector Startup (reverse order — R-001)
  2a. Start Peer5 (no outbound peers)
  2b. Start Peer4 (connects to Peer5)
  2c. Start Peer3 (connects to Peer4)
  2d. Start Peer2 (connects to Peer3)
  2e. Start Peer1 (connects to Peer2)
  2f. Wait for all BTP connections established (waitForCondition polling)
  2g. Verify routing tables populated at all peers

Phase 3: Channel Setup (after BTP connections established)
  3a. Each peer's ChannelManager opens channels to adjacent peers on-demand
      (triggered automatically by first packet or explicitly via ensureChannelExists)
  3b. Channels auto-deposit tokens (initialDepositMultiplier × threshold)
  3c. Wait for channel opened state on-chain (waitForCondition)

Phase 4: Readiness Gate
  4a. All 4 BTP connections alive
  4b. All 8 payment channels opened (4 peer pairs × 2 directions)
  4c. All channels funded with sufficient token deposits
  4d. Routing tables complete at all 5 peers
```

---

## Risk Assessment

### High-Priority Risks (Score >= 6)

| Risk ID | Category | Description                                                                                         | Prob | Impact | Score | Mitigation                                                                                                                                                       | Owner | Timeline     |
| ------- | -------- | --------------------------------------------------------------------------------------------------- | ---- | ------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------ |
| R-001   | TECH     | BTP connection race conditions: 5 connectors connecting simultaneously may cause handshake failures | 3    | 3      | **9** | Sequential startup (Peer5→Peer1). `waitForCondition()` to poll `btpClientManager.isConnected()` for each peer                                                    | Dev   | Pre-impl     |
| R-002   | TECH     | Settlement threshold timing: polling-based detection may miss triggers or fire duplicates           | 2    | 3      | **6** | Set pollingInterval=100ms. Verify state machine prevents duplicates. Use `waitForCondition()` to observe SETTLEMENT_REQUIRED events                              | Dev   | Test design  |
| R-003   | DATA     | Balance drift across hops: BigInt fee rounding across 4 hops may cause assertion failures           | 3    | 2      | **6** | Pre-calculate exact expected balances using BigInt arithmetic. Fee cascade: `amount - (amount * 10n / 10000n)` per hop                                           | Dev   | Test impl    |
| R-004   | TECH     | Real EVM infrastructure dependency chain (Anvil + contracts + faucet + channels + deposits)         | 2    | 3      | **6** | `make anvil-up` prerequisite. Phased startup (fund → start → open channels → verify). Gate test with `EVM_INTEGRATION=true`. Health checks before test execution | Dev   | Architecture |
| R-005   | PERF     | Test execution time: 5 ConnectorNode instances + Anvil RPC calls may exceed 30s Jest timeout        | 3    | 3      | **9** | Set Jest timeout to 180s for this test file. Channel open + deposit adds ~2-5s per peer pair. Parallelize funding. Consider 3-peer smoke variant                 | Dev   | Test config  |

### Medium-Priority Risks (Score 3-5)

| Risk ID | Category | Description                                                 | Prob | Impact | Score | Mitigation                                              |
| ------- | -------- | ----------------------------------------------------------- | ---- | ------ | ----- | ------------------------------------------------------- |
| R-006   | TECH     | Routing table convergence: missing routes cause F02 rejects | 2    | 2      | **4** | Static routes in config. Verify before sending packets  |
| R-007   | OPS      | Port exhaustion on CI: 10+ ports per test run               | 2    | 2      | **4** | IsolatedTestEnv port allocation with random base offset |
| R-008   | DATA     | InMemoryLedgerClient state leak between test cases          | 2    | 2      | **4** | Fresh ledger client per test. Proper `stop()` cleanup   |
| R-009   | BUS      | Reject scenario coverage gaps (F01, F02, R00, T00, T04)     | 1    | 3      | **3** | Explicit test cases for each reject code                |

### Low-Priority Risks (Score 1-2)

| Risk ID | Category | Description                                             | Prob | Impact | Score | Action                                                       |
| ------- | -------- | ------------------------------------------------------- | ---- | ------ | ----- | ------------------------------------------------------------ |
| R-010   | OPS      | Anvil nonce/state issues between test runs if not reset | 1    | 2      | **2** | Fresh Anvil per CI run. `anvil-down && anvil-up` in CI setup |
| R-011   | TECH     | BTP keepalive interference during long test runs        | 1    | 1      | **1** | Monitor                                                      |

---

## Entry Criteria

- [x] ConnectorNode accepts `ConnectorConfig` object in constructor
- [x] InMemoryLedgerClient available as TigerBeetle replacement
- [x] IsolatedTestEnv provides port allocation
- [x] PerPacketClaimService exists with testable interface
- [x] SettlementMonitor exposes `getSettlementState()` and `getAllSettlementStates()`
- [x] AccountManager exposes `getAccountBalance()` for balance assertions
- [x] Config-driven settlement (`settlementInfra` field) available (Story 29.1)
- [x] Anvil Docker infrastructure with Faucet available (`make anvil-up`)
- [x] DeployLocal.s.sol deploys TokenNetworkRegistry + TokenNetwork + MockERC20
- [x] PaymentChannelSDK supports real Anvil RPC connection
- [ ] Test helper: `createMultiHopTestNetwork(peerCount)` factory implemented

## Exit Criteria

- [ ] All P0 tests passing (100%)
- [ ] All P1 tests passing (>=95%)
- [ ] No open high-priority / high-severity bugs
- [ ] Balance assertions verified with exact BigInt equality across all 5 peers
- [ ] Settlement triggers verified at 3+ peers independently
- [ ] Both Fulfill and Reject packet paths verified end-to-end
- [ ] Test completes in < 180s on CI (includes Anvil RPC overhead)

---

## Test Coverage Plan

> **Note:** P0/P1/P2/P3 = priority classification based on risk and business impact, NOT execution timing. See Execution Strategy for when tests run.

### P0 (Critical)

**Criteria**: Blocks core packet flow + High risk (>=6) + No workaround

| ID    | Scenario                             | Test Level | Risk Link | Description                                                                                            | Notes             |
| ----- | ------------------------------------ | ---------- | --------- | ------------------------------------------------------------------------------------------------------ | ----------------- |
| T-001 | Fulfill: 5-hop packet delivery       | E2E        | R-001     | Send ILP Prepare from Peer1 to `test.peer5.receiver`. Verify ILPFulfillPacket returns through all hops | Core happy path   |
| T-002 | Balance verification after fulfill   | E2E        | R-003     | Query `getAccountBalance()` at each peer after T-001. Verify debit/credit entries match fee cascade    | Balance integrity |
| T-003 | Reject: destination rejects          | E2E        | R-009     | Configure Peer5 `localDeliveryHandler` to return F99 reject. Verify propagates to Peer1                | Error path        |
| T-004 | Settlement trigger via threshold     | E2E        | R-002     | Send packets to exceed Peer2 threshold (5000n). Verify `SETTLEMENT_REQUIRED` event fires               | Settlement core   |
| T-005 | Multi-peer settlement triggers       | E2E        | R-002     | Send enough packets to trigger settlements at Peer2, Peer3, Peer4. Verify each completes independently | Multi-settlement  |
| T-006 | Balance correctness after settlement | E2E        | R-003     | After T-005, verify credit balances reduced by settlement amounts at all settled peers                 | Post-settlement   |

**Total P0**: 6 tests, ~18-24 hours

### P1 (High)

**Criteria**: Important features + Medium risk (3-4) + Common workflows

| ID    | Scenario                                      | Test Level | Risk Link | Description                                                                                                                                                                                  | Notes                                        |
| ----- | --------------------------------------------- | ---------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| T-007 | Fee cascade across 4 hops                     | E2E        | R-003     | Send 10000n from Peer1. Verify amount at each hop: 10000→9990→9980→9970                                                                                                                      | BigInt arithmetic                            |
| T-008 | Per-packet claim generation with real EIP-712 | E2E        | R-004     | Verify each forwarding peer generates claim with real EIP-712 signature, monotonic nonce, correct cumulative amount, and self-describing fields (chainId, tokenNetworkAddress, tokenAddress) | Claim integrity — real on-chain verification |
| T-009 | Credit limit rejection (T04)                  | E2E        | R-009     | Set low credit limit on Peer3. Exceed it. Verify T04_INSUFFICIENT_LIQUIDITY                                                                                                                  | Enforcement                                  |
| T-010 | Unreachable destination (F02)                 | E2E        | R-006     | Send to `test.nonexistent.address`. Verify F02_UNREACHABLE from first unrouteable hop                                                                                                        | Routing                                      |
| T-011 | Settlement state machine lifecycle            | E2E        | R-002     | Verify IDLE → PENDING → IN_PROGRESS → IDLE at each settling peer                                                                                                                             | State machine                                |
| T-012 | Claim accumulation (10 packets)               | E2E        | R-004     | Send 10 packets. Verify `getLatestClaim()` shows nonce=10 and cumulative = sum of forwarded amounts. Verify claims are redeemable on-chain via `claimFromChannel()`                          | Accumulation + on-chain redeemable           |

| T-020 | Self-describing claim on-chain verification | E2E | R-004 | Verify ClaimReceiver at each hop performs dynamic on-chain channel verification for unknown channels using self-describing fields, then caches result | Epic 31 core path |

**Total P1**: 7 tests, ~14-21 hours

### P2 (Medium)

**Criteria**: Secondary features + Low risk + Edge cases

| ID    | Scenario                       | Test Level | Risk Link | Description                                                              | Notes       |
| ----- | ------------------------------ | ---------- | --------- | ------------------------------------------------------------------------ | ----------- |
| T-013 | Expired packet rejection (R00) | E2E        | -         | Packet with `expiresAt` = now + 2s. Exhausted by hop 3-4                 | Timing edge |
| T-014 | Invalid packet rejection (F01) | Unit       | -         | 16-byte executionCondition → F01_INVALID_PACKET                          | Validation  |
| T-015 | Routing table verification     | E2E        | R-006     | Query each peer's routing table before sending. Verify correct next-hops | Pre-check   |
| T-016 | Zero-amount packet             | E2E        | -         | Send 0n amount. No settlement, no claims, packet still forwarded         | Edge case   |
| T-017 | BTP health after burst         | E2E        | R-001     | After 50+ packets, verify all BTP connections alive                      | Stability   |

**Total P2**: 5 tests, ~5-10 hours

### P3 (Low)

**Criteria**: Nice-to-have + Exploratory

| ID    | Scenario                  | Test Level | Risk Link | Description                                                        | Notes          |
| ----- | ------------------------- | ---------- | --------- | ------------------------------------------------------------------ | -------------- |
| T-018 | Concurrent packet sending | E2E        | R-005     | Send 10 packets via `Promise.all()`. All complete without deadlock | Concurrency    |
| T-019 | Bi-directional flow       | E2E        | -         | Send Peer1→Peer5 AND Peer5→Peer1. Both work, balances correct      | Bi-directional |

**Total P3**: 2 tests, ~2-4 hours

---

## Execution Strategy

**Philosophy:** Integration tests require Docker (Anvil + Faucet). Gate with `EVM_INTEGRATION=true` env var.

| Tier         | What Runs                                                        | Est. Duration | Trigger                  | Requires                                 |
| ------------ | ---------------------------------------------------------------- | ------------- | ------------------------ | ---------------------------------------- |
| **Every PR** | All P0 + P1 + P2 tests (T-001 through T-020)                     | ~3-5 min      | PR open / push to branch | `make anvil-up` + `EVM_INTEGRATION=true` |
| **Nightly**  | Full regression including P3 (T-018, T-019) + concurrency stress | ~8 min        | Scheduled                | Same                                     |

**CI Setup:**

```bash
make anvil-up                             # Start Anvil + deploy contracts + faucet
EVM_INTEGRATION=true npm run test:integration  # Run integration suite
make anvil-down                           # Teardown
```

All 20 functional tests should complete in under 10 minutes including Anvil RPC overhead.

---

## Resource Estimates

### Test Development Effort

| Priority  | Count  | Hours/Test | Total Hours | Notes                                                    |
| --------- | ------ | ---------- | ----------- | -------------------------------------------------------- |
| P0        | 6      | 3-4h       | ~18-24h     | Complex multi-node setup, real EVM channel orchestration |
| P1        | 7      | 2-3h       | ~14-21h     | Builds on P0 harness, includes real claim verification   |
| P2        | 5      | 1-2h       | ~5-10h      | Simpler scenarios using existing harness                 |
| P3        | 2      | 1-2h       | ~2-4h       | Stretch goals                                            |
| **Total** | **20** | **-**      | **~39-59h** | **~5-8 dev days**                                        |

### Prerequisites

**Test Data:**

- `createMultiHopTestNetwork(count)` factory — spins up N ConnectorNode instances with real `settlementInfra` config, Anvil-connected PaymentChannelSDKs, routes, ports
- `fundPeerAccounts(addresses)` helper — calls faucet for each peer address, verifies on-chain token balances
- `waitForChannelsReady(network)` helper — polls on-chain channel state until all peer-pair channels are opened and funded

**Tooling:**

- Jest with 180s timeout for multi-hop test files
- InMemoryLedgerClient for each connector (no TigerBeetle Docker dependency)
- SQLite (better-sqlite3) for PerPacketClaimService claim persistence
- ethers.js JsonRpcProvider for on-chain assertions

**Environment:**

- Docker: Anvil + Faucet running via `make anvil-up`
- Ports: Anvil (8545), Faucet (3500), 10+ BTP ports (allocated via IsolatedTestEnv)
- Gate: `EVM_INTEGRATION=true` environment variable
- Contracts: TokenNetworkRegistry, TokenNetwork, MockERC20 deployed by DeployLocal.s.sol

---

## Quality Gate Criteria

### Pass/Fail Thresholds

- **P0 pass rate**: 100% (no exceptions)
- **P1 pass rate**: >=95% (waivers required for failures)
- **P2/P3 pass rate**: >=90% (informational)
- **High-risk mitigations**: 100% complete or approved waivers

### Coverage Targets

- **Critical paths (fulfill + reject)**: 100%
- **Settlement lifecycle**: 100%
- **Balance assertions**: Exact BigInt equality
- **Error code coverage**: F01, F02, R00, T00, T04, F99

### Non-Negotiable Requirements

- [ ] All P0 tests pass
- [ ] No high-risk (>=6) items unmitigated
- [ ] Balance assertions use exact BigInt comparison (no floating-point tolerance)
- [ ] Test completes in < 180s on CI (includes Anvil RPC overhead)
- [ ] No orphaned WebSocket connections after test cleanup

---

## Mitigation Plans

### R-001: BTP Connection Race Conditions (Score: 9)

**Mitigation Strategy:** Sequential connector startup in reverse topology order (Peer5 → Peer1). After each connector starts, poll `btpClientManager.isConnected(peerId)` for all configured peers with `waitForCondition()` before starting the next connector. Global readiness check before any test sends packets.

**Owner:** Dev
**Timeline:** Pre-implementation (test harness setup)
**Status:** Planned
**Verification:** All 4 BTP connections established before first packet send. Log verification of handshake completion.

### R-003: Balance Drift from Fee Cascade (Score: 6)

**Mitigation Strategy:** Pre-calculate all expected balances using exact BigInt arithmetic. The fee formula is: `fee = (amount * 10n) / 10000n` (0.1% = 10 basis points). For a 10000n packet across 4 hops:

- Hop 1 (Peer1→Peer2): fee=10n, forwarded=9990n
- Hop 2 (Peer2→Peer3): fee=9n, forwarded=9981n
- Hop 3 (Peer3→Peer4): fee=9n, forwarded=9972n
- Hop 4 (Peer4→Peer5): local delivery, no fee

Expected balances after 1 packet:

- Peer1: debit to Peer2 = 10000n
- Peer2: credit from Peer1 = 10000n, debit to Peer3 = 9990n
- Peer3: credit from Peer2 = 9990n, debit to Peer4 = 9981n
- Peer4: credit from Peer3 = 9981n, debit to Peer5 = 9972n (or local delivery)
- Peer5: credit from Peer4 = 9972n

**Owner:** Dev
**Timeline:** Test implementation
**Status:** Planned
**Verification:** `expect(balance.debitBalance).toBe(expectedDebit)` with exact BigInt values.

### R-004: Real EVM Infrastructure Dependency Chain (Score: 6)

**Mitigation Strategy:** Use real Anvil blockchain with deterministic accounts. Per architecture: **"Integration tests run against real infrastructure — never mocks."**

The dependency chain is:

1. Anvil running with deployed contracts (prerequisite via `make anvil-up`)
2. Faucet funds each peer account with ETH + USDC tokens
3. ConnectorNode `settlementInfra` config points to `http://localhost:8545`
4. Real PaymentChannelSDK connects via ethers.js JsonRpcProvider
5. ChannelManager opens real payment channels on-chain
6. PerPacketClaimService generates claims with real EIP-712 signatures
7. ClaimReceiver verifies claims against real on-chain channel state

Phased startup ensures each layer is ready before the next:

- Phase 1: Fund accounts → verify on-chain balances
- Phase 2: Start connectors → verify BTP connections
- Phase 3: Open channels → verify on-chain channel state
- Phase 4: Readiness gate → all preconditions met

**Owner:** Dev
**Timeline:** Architecture decision (pre-implementation)
**Status:** Planned
**Verification:** All peer-pair channels show `state === 'opened'` on-chain before test execution begins.

### R-005: Test Execution Timeout with Real Anvil (Score: 9)

**Mitigation Strategy:** Real Anvil RPC calls add latency per operation (~50-200ms each). Channel open + deposit adds ~2-5s per peer pair. With 8 channels (4 pairs × 2 directions), setup could take 16-40s.

Mitigations:

- Set Jest timeout to 180s: `jest.setTimeout(180_000)`
- Parallelize account funding (all 5 faucet requests concurrent)
- Channels opened on-demand by ChannelManager (amortized over first packets)
- Consider splitting into:
  - `multi-hop-smoke.test.ts` (3 peers, P0 smoke, < 60s)
  - `multi-hop-settlement.test.ts` (5 peers, full P0+P1, < 180s)
- Set `--max-old-space-size=4096` for 5 ConnectorNode instances + ethers.js providers

**Owner:** Dev
**Timeline:** Test configuration
**Status:** Planned
**Verification:** CI pipeline completes P0+P1 suite in < 180s.

---

## Assumptions and Dependencies

### Assumptions

1. InMemoryLedgerClient behavior matches TigerBeetle for double-entry accounting semantics
2. Anvil deterministic accounts provide consistent, reproducible test state
3. Anvil RPC latency on localhost is < 200ms per call (acceptable for test)
4. BTP WebSocket connections on localhost are reliable (no network partitions in test)
5. Jest can handle 5 concurrent ConnectorNode instances + 5 ethers.js providers without memory pressure
6. SettlementMonitor polling at 100ms is fast enough to detect threshold crossings between packet bursts
7. DeployLocal.s.sol contract addresses are deterministic across Anvil restarts

### Dependencies

1. `ConnectorNode` constructor accepts `ConnectorConfig` object (Story 24.1) — **Available**
2. `InMemoryLedgerClient` implements same interface as TigerBeetle client (Story 28.1) — **Available**
3. `IsolatedTestEnv` provides port allocation (existing test-utils) — **Available**
4. `PerPacketClaimService` interface is stable (Epic 30-31) — **Available**
5. Docker (Anvil + Faucet) via `make anvil-up` — **Available**
6. Config-driven settlement via `settlementInfra` (Story 29.1) — **Available**
7. Self-describing claims with dynamic on-chain verification (Epic 31) — **Available**

### Risks to Plan

- **Risk**: InMemoryLedgerClient has subtle behavioral differences from TigerBeetle
  - **Impact**: Balance assertions pass in test but fail in production
  - **Contingency**: Run periodic TigerBeetle integration tests (separate Docker-based suite)

- **Risk**: Jest memory limits with 5 ConnectorNode instances + ethers.js providers
  - **Impact**: Test OOM on CI
  - **Contingency**: Set `--max-old-space-size=4096` in Jest config or reduce to 3-peer smoke test

- **Risk**: Anvil container health flaky on CI (Docker-in-Docker)
  - **Impact**: Test infrastructure unavailable, all tests skip
  - **Contingency**: CI retry logic + health check timeout of 30s before test start

---

## Interworking & Regression

| Service/Component         | Impact                           | Regression Scope                                                                    |
| ------------------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| **PacketHandler**         | Core forwarding logic under test | All existing packet-handler.test.ts and packet-handler-settlement.test.ts must pass |
| **AccountManager**        | Balance recording and queries    | account-manager.test.ts must pass                                                   |
| **SettlementExecutor**    | Settlement event handling        | settlement-executor.test.ts must pass                                               |
| **SettlementMonitor**     | Threshold detection              | settlement-monitor.test.ts must pass                                                |
| **PerPacketClaimService** | Claim generation                 | per-packet-claim-service.test.ts must pass                                          |
| **BTPClient/BTPServer**   | WebSocket communication          | btp-client.test.ts, btp-server.test.ts must pass                                    |
| **ClaimReceiver**         | Claim verification               | claim-receiver.test.ts must pass                                                    |
| **ChannelManager**        | Channel metadata                 | channel-manager.test.ts must pass                                                   |

---

## Test File Structure

```
packages/connector/test/integration/
  multi-hop-e2e.test.ts          # Main 5-peer E2E test (P0 + P1 + P2)
  multi-hop-helpers.ts           # createMultiHopTestNetwork(), funding, channel helpers
```

No mock files — all integration tests use real Anvil infrastructure per architecture policy.

### Key Test Helpers

```typescript
// multi-hop-helpers.ts (conceptual)

// Anvil deterministic constants
const ANVIL_RPC_URL = 'http://localhost:8545';
const FAUCET_URL = 'http://localhost:3500';
const REGISTRY_ADDRESS = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const TOKEN_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

interface MultiHopTestNetwork {
  peers: ConnectorNode[];
  configs: ConnectorConfig[];
  provider: ethers.JsonRpcProvider; // Shared Anvil provider for assertions
  start(): Promise<void>; // Fund accounts → sequential startup → channel readiness
  stop(): Promise<void>; // Graceful shutdown in reverse order
  sendPacket(
    fromPeer: number,
    destination: string,
    amount: bigint
  ): Promise<ILPFulfillPacket | ILPRejectPacket>;
  getBalance(peerIndex: number, peerId: string, tokenId: string): Promise<PeerAccountBalance>;
  getAllBalances(): Promise<Map<string, PeerAccountBalance>>;
  waitForSettlement(peerIndex: number, peerId: string): Promise<void>;
  getSettlementStates(): Map<string, SettlementState>;
  getOnChainChannelState(channelId: string): Promise<ChannelState>; // Real on-chain query
  getOnChainTokenBalance(address: string): Promise<bigint>; // Real ERC-20 balance
}

function createMultiHopTestNetwork(
  peerCount: number,
  options?: {
    settlementThreshold?: bigint;
    connectorFeePercentage?: number;
    creditLimit?: bigint;
    pollingInterval?: number;
    rpcUrl?: string; // Default: ANVIL_RPC_URL
    registryAddress?: string; // Default: REGISTRY_ADDRESS
    tokenAddress?: string; // Default: TOKEN_ADDRESS
  }
): MultiHopTestNetwork;

// Fund peer accounts from faucet (100 ETH + 10,000 USDC each)
async function fundPeerAccounts(addresses: string[]): Promise<void>;

// Wait for Anvil + Faucet to be healthy
async function waitForAnvilReady(timeout?: number): Promise<void>;

function calculateExpectedFee(amount: bigint, feePercentage: number): bigint;
function calculateExpectedBalancesAfterPacket(
  amount: bigint,
  hopCount: number,
  feePercentage: number
): Map<string, { debit: bigint; credit: bigint }>;
```

---

## Follow-on Workflows (Manual)

- Run `TA` (Test Automation) to generate the actual test code from this design
- Run `RV` (Review Tests) after implementation to validate test quality
- Run `TR` (Trace Requirements) to map these scenarios to acceptance criteria

---

## Approval

**Test Design Approved By:**

- [ ] Product Manager: ****\_\_**** Date: ****\_\_****
- [ ] Tech Lead: ****\_\_**** Date: ****\_\_****
- [ ] QA Lead: ****\_\_**** Date: ****\_\_****

**Comments:**

---

## Appendix

### Knowledge Base References

- `risk-governance.md` - Risk classification framework
- `probability-impact.md` - Risk scoring methodology
- `test-levels-framework.md` - Test level selection
- `test-priorities-matrix.md` - P0-P3 prioritization

### Fee Cascade Reference Table

For a 10000n packet across 4 forwarding hops (0.1% fee per hop):

| Hop | From  | To    | Amount In | Fee            | Amount Out |
| --- | ----- | ----- | --------- | -------------- | ---------- |
| 1   | Peer1 | Peer2 | 10000n    | 10n            | 9990n      |
| 2   | Peer2 | Peer3 | 9990n     | 9n             | 9981n      |
| 3   | Peer3 | Peer4 | 9981n     | 9n             | 9972n      |
| 4   | Peer4 | Peer5 | 9972n     | local delivery | 9972n      |

### Settlement Trigger Calculation

With threshold=5000n and packet amount=10000n:

- After 1 packet: Peer2 credit from Peer1 = 10000n > 5000n threshold -> TRIGGER
- After 1 packet: Peer3 credit from Peer2 = 9990n > 5000n threshold -> TRIGGER
- After 1 packet: Peer4 credit from Peer3 = 9981n > 5000n threshold -> TRIGGER

All 3 intermediate forwarding peers trigger settlement after a single 10000n packet.

For smaller packets (e.g., 1000n), need 6 packets to trigger at Peer2 (6 \* 1000n = 6000n > 5000n).

---

**Generated by**: BMad TEA Agent - Test Architect Module
**Workflow**: `_bmad/tea/testarch/test-design`
**Version**: 5.0 (Step-File Architecture)
