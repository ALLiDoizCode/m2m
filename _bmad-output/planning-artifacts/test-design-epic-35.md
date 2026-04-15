---
stepsCompleted:
  - risk-assessment
  - strategy-per-story
  - cross-story-integration
  - regression-analysis
  - test-data-requirements
lastSaved: '2026-04-13'
revision: v1
epicRef: epic-35-ator-overlay-transport.md
inputDocuments:
  - _bmad-output/planning-artifacts/epic-35-ator-overlay-transport.md
  - _bmad-output/planning-artifacts/ator-protocol-integration-handoff.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/project-context.md
  - _bmad-output/planning-artifacts/test-design-epic-34.md
---

# Test Design: Epic 35 -- ATOR Overlay Transport for Privacy-Enabled Peering

**Date:** 2026-04-13
**Author:** Jonathan (generated with Claude)
**Status:** Draft v1

---

## Executive Summary

**Scope:** Risk-based test plan for Epic 35, covering 7 stories (35.1--35.7) that deliver an optional SOCKS5-based transport layer enabling TOON connectors to peer through ATOR (Anyone Protocol) `.anon` hidden services. The epic introduces a `TransportProvider` interface with two implementations (`DirectTransportProvider` and `SocksTransportProvider`), Zod-validated config schema extension, BTP WebSocket agent injection, optional managed `anon` binary lifecycle, and comprehensive tests plus documentation.

**Epic Type:** Brownfield extension. Transport is orthogonal to the settlement layer (Epics 32--34). The dominant constraints are: (1) DNS leak prevention via `socks5h://` scheme enforcement, (2) fail-closed behavior -- SOCKS proxy failure must never silently fall back to direct connections, (3) WebSocket `agent` injection into the existing `ws` library without breaking current BTP behavior, and (4) `.anon` address logging restrictions for operational security.

**Architecture Constraint:** Unit tests mock SOCKS5 proxy behavior. Integration tests use a local SOCKS5 proxy server (in-process or `ssh -D` style mock, no Docker dependency). The `@anyone-protocol/anyone-client` SDK is mocked in unit tests; managed client integration tests are optional/nightly since they require the `anon` binary. All existing BTP, settlement, and ILP tests must pass unchanged (zero regression).

**Risk Summary:**

- Total risks identified: 14
- Critical (score >= 8): 3
- High (score 5--7): 5
- Medium (score 3--4): 4
- Low (score 1--2): 2

**Coverage Summary:**

- Unit test scenarios: 48
- Integration test scenarios: 12
- Regression scenarios: 8
- Security-focused scenarios: 10
- Estimated effort: 8--12 dev days

---

## 1. Key Risks and Mitigating Tests

### Risk Matrix

| ID   | Risk                                                                    | Likelihood | Impact   | Score | Category    | Mitigating Tests                        |
| ---- | ----------------------------------------------------------------------- | ---------- | -------- | ----- | ----------- | --------------------------------------- |
| R-01 | **DNS leak via `socks5://` instead of `socks5h://`**                    | Medium     | Critical | 9     | SECURITY    | T-35.2-05, T-35.3-04, T-35.6-SEC-01    |
| R-02 | **Silent fallback to direct when SOCKS proxy unavailable**              | Medium     | Critical | 9     | SECURITY    | T-35.2-03, T-35.4-05, T-35.6-SEC-02    |
| R-03 | **BTP WebSocket agent injection breaks existing connections**           | Medium     | Critical | 8     | REGRESSION  | T-35.4-01, T-REG-01 through T-REG-08   |
| R-04 | **SOCKS proxy failure mid-session drops connections silently**          | Medium     | High     | 7     | RELIABILITY | T-35.2-04, T-35.6-INT-03               |
| R-05 | **`.anon` addresses leaked in INFO-level logs**                         | Medium     | High     | 7     | PRIVACY     | T-35.6-SEC-05                           |
| R-06 | **ConnectorNode lifecycle fails to start/stop transport provider**      | Medium     | High     | 6     | LIFECYCLE   | T-35.4-02, T-35.4-03, T-35.6-INT-01    |
| R-07 | **Config absent/default breaks existing deployments**                   | Low        | High     | 6     | REGRESSION  | T-35.3-01, T-REG-01, T-REG-02          |
| R-08 | **Health endpoint does not report transport provider status**           | Medium     | Medium   | 5     | OPS         | T-35.4-04, T-35.6-INT-02               |
| R-09 | **`anyone-client` SDK crash leaves orphan `anon` process**             | Medium     | Medium   | 5     | RELIABILITY | T-35.5-03, T-35.5-04                   |
| R-10 | **ILP PREPARE timeout too short for ATOR latency**                      | Medium     | Medium   | 5     | PERF        | T-35.6-INT-04                           |
| R-11 | **Managed `anon` binary not available on test platform**               | Low        | Medium   | 4     | COMPAT      | T-35.5-05                               |
| R-12 | **SocksProxyAgent constructor options incompatible with `ws`**         | Low        | Medium   | 4     | COMPAT      | T-35.2-01, T-35.6-INT-05               |
| R-13 | **Hidden service key rotation breaks peer connectivity**               | Low        | Low      | 2     | OPS         | T-35.7-DOC (documentation coverage)     |
| R-14 | **Multiple transport providers configured simultaneously**              | Low        | Low      | 2     | CONFIG      | T-35.3-06                               |

### Risk Detail: Top 5

**R-01: DNS Leak via `socks5://` Instead of `socks5h://`** (Score 9)
The `socks5h://` scheme instructs the SOCKS proxy to perform DNS resolution remotely. Without the `h`, DNS queries for `.anon` addresses are resolved locally, which (a) fails because the local resolver cannot resolve `.anon` TLD, and (b) leaks the target `.anon` address to the local DNS resolver, defeating the privacy guarantee. This is the single most important security invariant in the epic. Mitigation: Zod config validation rejects `socks5://` with a descriptive error at config load time (Story 35.3). The `SocksTransportProvider` constructor also validates the scheme as defense-in-depth (Story 35.2). A dedicated security test verifies DNS leak prevention end-to-end (Story 35.6).

**R-02: Silent Fallback to Direct When SOCKS Proxy Unavailable** (Score 9)
If the SOCKS proxy is down and the connector silently falls back to a direct TCP connection, the operator believes they have privacy protection when they do not. This is an opsec violation. The transport layer must fail closed -- reject the connection with an explicit error. Mitigation: `SocksTransportProvider.start()` validates proxy connectivity and throws on failure (T-35.2-03). `ConnectorNode` propagates this as a startup failure (T-35.4-05). Integration tests verify that no direct connection is established when the proxy is configured but unavailable (T-35.6-SEC-02).

**R-03: BTP WebSocket Agent Injection Breaks Existing Connections** (Score 8)
Story 35.4 modifies the BTP client to pass `{ agent }` to the `ws` WebSocket constructor. If this changes the default behavior when `agent` is `undefined` (which `DirectTransportProvider.createAgent()` returns), existing direct connections could break. This is the highest regression risk. Mitigation: `DirectTransportProvider` returns `undefined` from `createAgent()`, and the BTP client only passes the `agent` option when non-undefined. All existing BTP tests must pass without modification (T-REG-01 through T-REG-08).

**R-04: SOCKS Proxy Failure Mid-Session** (Score 7)
If the SOCKS proxy goes down after successful startup, existing BTP WebSocket connections will eventually fail at the socket level. The health check must detect this and report it. Mitigation: `healthCheck()` probes the proxy periodically (T-35.2-04). The connector health endpoint includes transport status (T-35.4-04). Integration tests verify error propagation when the proxy drops mid-session (T-35.6-INT-03).

**R-05: `.anon` Addresses Leaked in INFO-Level Logs** (Score 7)
`.anon` hidden service addresses are sensitive -- they reveal the operator's presence on the overlay network. If logged at INFO level (the default production level), they are exposed in log aggregation systems. Mitigation: A dedicated test scans all transport module log calls and verifies that `.anon` addresses only appear at DEBUG or TRACE level (T-35.6-SEC-05).

---

## 2. Test Strategy Per Story

### Story 35.1: Define TransportProvider Interface + DirectTransportProvider

**Test Level:** TypeScript unit
**Risk Focus:** R-03 (regression), R-07 (default behavior)

| ID        | Scenario                                                                                        | Type       | Priority |
| --------- | ----------------------------------------------------------------------------------------------- | ---------- | -------- |
| T-35.1-01 | `TransportProvider` interface compiles with all required methods (`createAgent`, `getExternalUrl`, `start`, `stop`, `healthCheck`) | Type check | P0 |
| T-35.1-02 | `DirectTransportProvider.createAgent()` returns `undefined` for any peer URL                     | Unit       | P0       |
| T-35.1-03 | `DirectTransportProvider.getExternalUrl()` returns the configured public URL                     | Unit       | P0       |
| T-35.1-04 | `DirectTransportProvider.healthCheck()` returns `true`                                           | Unit       | P0       |
| T-35.1-05 | `DirectTransportProvider.start()` resolves without error                                         | Unit       | P0       |
| T-35.1-06 | `DirectTransportProvider.stop()` resolves without error                                          | Unit       | P0       |
| T-35.1-07 | `DirectTransportProvider` implements `TransportProvider` interface (TypeScript compiles)          | Type check | P0       |

**Approach:** Pure unit tests with no dependencies. `DirectTransportProvider` is a thin wrapper -- tests verify the contract, not complex logic. The interface type check ensures future implementations must satisfy the contract.

**Test File:** `packages/connector/src/transport/direct-transport-provider.test.ts`

---

### Story 35.2: Implement SocksTransportProvider

**Test Level:** TypeScript unit (mocked `socks-proxy-agent`, mocked SOCKS proxy)
**Risk Focus:** R-01 (DNS leak), R-02 (fail-closed), R-04 (proxy failure), R-12 (ws compat)

| ID        | Scenario                                                                                        | Type     | Priority |
| --------- | ----------------------------------------------------------------------------------------------- | -------- | -------- |
| T-35.2-01 | `createAgent()` returns a `SocksProxyAgent` configured with the `socks5h://` proxy URL          | Unit     | P0       |
| T-35.2-02 | `getExternalUrl()` returns the configured `.anon` hidden service URL                            | Unit     | P0       |
| T-35.2-03 | `start()` throws error when SOCKS5 proxy at configured address is unreachable                   | Unit     | P0       |
| T-35.2-04 | `healthCheck()` returns `false` when SOCKS5 proxy is unreachable after successful start         | Unit     | P0       |
| T-35.2-05 | Constructor rejects proxy URL with `socks5://` scheme (without `h`), requires `socks5h://`      | Unit     | P0       |
| T-35.2-06 | `createAgent()` returns a new agent instance per call (not shared across peers)                  | Unit     | P0       |
| T-35.2-07 | `healthCheck()` returns `true` when proxy is reachable                                          | Unit     | P0       |
| T-35.2-08 | `stop()` resolves cleanly (no-op when not managed)                                              | Unit     | P0       |
| T-35.2-09 | `start()` succeeds when proxy is reachable                                                      | Unit     | P0       |
| T-35.2-10 | `SocksTransportProvider` implements `TransportProvider` interface (TypeScript compiles)           | Type check | P0    |
| T-35.2-11 | `createAgent()` works when proxy is down (agent creation succeeds; failure at socket level)      | Unit     | P1       |

**Approach:** Mock `socks-proxy-agent` to verify constructor arguments without network I/O. Mock the SOCKS5 proxy connectivity check (TCP connect to proxy port) to simulate reachable/unreachable states. The DNS leak test (T-35.2-05) validates the scheme at the provider level as defense-in-depth alongside config validation.

**Test File:** `packages/connector/src/transport/socks-transport-provider.test.ts`

---

### Story 35.3: Extend Config Schema for Transport Block

**Test Level:** TypeScript unit (Zod schema validation)
**Risk Focus:** R-01 (DNS leak), R-07 (default behavior), R-14 (invalid config)

| ID        | Scenario                                                                                        | Type | Priority |
| --------- | ----------------------------------------------------------------------------------------------- | ---- | -------- |
| T-35.3-01 | Config with no `transport` block defaults to `{ type: "direct" }` -- no validation errors       | Unit | P0       |
| T-35.3-02 | Config with `transport.type: "socks5"`, valid `socksProxy` and `externalUrl` passes validation  | Unit | P0       |
| T-35.3-03 | Config with `transport.type: "socks5"` and missing `socksProxy` fails Zod validation            | Unit | P0       |
| T-35.3-04 | Config with `socksProxy: "socks5://127.0.0.1:9050"` (no `h`) fails with descriptive error message requiring `socks5h://` | Unit | P0 |
| T-35.3-05 | Config with `transport.type: "socks5"` and missing `externalUrl` fails validation               | Unit | P0       |
| T-35.3-06 | Config with `transport.type: "direct"` does not require `socksProxy` or `externalUrl`           | Unit | P0       |
| T-35.3-07 | Config with `transport.managed: true` and valid SOCKS5 config passes validation                  | Unit | P0       |
| T-35.3-08 | Config with `transport.managed: true` but `type: "direct"` fails or is ignored                  | Unit | P1       |
| T-35.3-09 | Config with invalid `transport.type` (e.g., `"tor"`) fails Zod validation                       | Unit | P1       |
| T-35.3-10 | Config with `externalUrl` not starting with `ws://` or `wss://` fails validation                | Unit | P1       |
| T-35.3-11 | `transport.managed` defaults to `false` when absent                                             | Unit | P0       |

**Approach:** Direct Zod schema unit tests -- parse config objects and assert success/failure with specific error messages. Config file loading is tested via the existing `ConfigLoader` paths. The DNS leak validation (T-35.3-04) is the primary defense -- the error message must explicitly explain why `socks5h://` is required.

**Test File:** Extend existing config test file or create `packages/connector/src/config/transport-config.test.ts`

---

### Story 35.4: Wire TransportProvider into ConnectorNode and BTP Client

**Test Level:** TypeScript unit + integration
**Risk Focus:** R-02 (fail-closed), R-03 (regression), R-06 (lifecycle), R-08 (health)

| ID        | Scenario                                                                                        | Type        | Priority |
| --------- | ----------------------------------------------------------------------------------------------- | ----------- | -------- |
| T-35.4-01 | Connector with `type: "direct"` config creates `DirectTransportProvider` and BTP connections use default agents (undefined) | Unit | P0 |
| T-35.4-02 | Transport provider `start()` is called during connector startup, after config validation         | Unit        | P0       |
| T-35.4-03 | Transport provider `stop()` is called during connector shutdown                                  | Unit        | P0       |
| T-35.4-04 | Health endpoint response includes `transport.healthy` field from provider `healthCheck()`        | Unit        | P0       |
| T-35.4-05 | Connector with `type: "socks5"` fails to start when SOCKS proxy is unreachable -- no fallback   | Unit        | P0       |
| T-35.4-06 | BTP WebSocket client passes `SocksProxyAgent` from provider when `type: "socks5"`               | Unit        | P0       |
| T-35.4-07 | BTP WebSocket client passes no agent (or undefined) when `type: "direct"`                       | Unit        | P0       |
| T-35.4-08 | Connector shutdown order: BTP connections closed before transport provider stopped               | Unit        | P1       |
| T-35.4-09 | Connector startup order: transport provider started before BTP connections established           | Unit        | P1       |
| T-35.4-10 | Multiple peers each get their own agent instance from `createAgent(peerUrl)`                     | Unit        | P1       |

**Approach:** Unit tests mock the `TransportProvider` interface and verify lifecycle call ordering on `ConnectorNode`. BTP client tests mock the `ws` WebSocket constructor to verify that the `agent` option is passed correctly. Integration tests (in Story 35.6) verify the full stack.

**Test Files:**
- Extend `packages/connector/src/core/connector-node.test.ts` (T-35.4-01 through T-35.4-05, T-35.4-08, T-35.4-09)
- Extend `packages/connector/src/btp/btp-client.test.ts` (T-35.4-06, T-35.4-07, T-35.4-10)

---

### Story 35.5: Managed ATOR Client Lifecycle

**Test Level:** TypeScript unit (mocked `@anyone-protocol/anyone-client` SDK)
**Risk Focus:** R-09 (orphan process), R-11 (platform compat)

| ID        | Scenario                                                                                        | Type | Priority |
| --------- | ----------------------------------------------------------------------------------------------- | ---- | -------- |
| T-35.5-01 | `start()` launches `anon` binary via SDK and waits for SOCKS5 proxy to become available         | Unit | P0       |
| T-35.5-02 | `stop()` shuts down the `anon` binary cleanly via SDK                                           | Unit | P0       |
| T-35.5-03 | `healthCheck()` returns `false` when `anon` binary has crashed                                  | Unit | P0       |
| T-35.5-04 | `stop()` cleans up stale process on shutdown even if `anon` is unresponsive                     | Unit | P0       |
| T-35.5-05 | `start()` throws descriptive error if `anon` binary is not found on the system                  | Unit | P0       |
| T-35.5-06 | `start()` with timeout -- throws if SOCKS proxy does not become available within deadline        | Unit | P1       |
| T-35.5-07 | Managed client is only instantiated when `transport.managed: true`                              | Unit | P0       |
| T-35.5-08 | Non-managed config (`managed: false` or absent) creates no managed client                       | Unit | P0       |
| T-35.5-09 | Hidden service configuration is passed to SDK correctly                                         | Unit | P1       |

**Approach:** Mock the `@anyone-protocol/anyone-client` SDK entirely. Tests verify that SDK methods are called with correct arguments and that lifecycle events (start, stop, crash) are handled. The `anon` binary is never actually executed in unit tests. Platform-specific binary availability (T-35.5-05) tests the error path when the SDK cannot locate the binary.

**Test File:** `packages/connector/src/transport/managed-anon-client.test.ts`

---

### Story 35.6: Unit and Integration Tests

**Test Level:** Integration (local SOCKS5 proxy)
**Risk Focus:** R-01 (DNS leak), R-02 (fail-closed), R-04 (mid-session failure), R-05 (log leak), R-10 (latency)

#### Security Tests

| ID              | Scenario                                                                                  | Type        | Priority |
| --------------- | ----------------------------------------------------------------------------------------- | ----------- | -------- |
| T-35.6-SEC-01   | End-to-end: WebSocket connection through SOCKS5 proxy uses remote DNS resolution          | Integration | P0       |
| T-35.6-SEC-02   | End-to-end: SOCKS proxy down, connector rejects connection -- no direct TCP fallback      | Integration | P0       |
| T-35.6-SEC-03   | `socks5://` rejected at every layer (config, provider constructor, agent creation)        | Unit        | P0       |
| T-35.6-SEC-04   | Agent created by `SocksTransportProvider` includes `socks5h://` in proxy config           | Unit        | P0       |
| T-35.6-SEC-05   | No `.anon` address appears in any log output at INFO level or above                       | Unit        | P0       |

#### Integration Tests

| ID              | Scenario                                                                                  | Type        | Priority |
| --------------- | ----------------------------------------------------------------------------------------- | ----------- | -------- |
| T-35.6-INT-01   | Full connector lifecycle: start with SOCKS transport -> peer via BTP -> shut down cleanly | Integration | P0       |
| T-35.6-INT-02   | Health endpoint reports `transport.healthy: true` when SOCKS proxy is reachable            | Integration | P0       |
| T-35.6-INT-03   | SOCKS proxy drops mid-session: BTP connections error, health reports `false`               | Integration | P0       |
| T-35.6-INT-04   | ILP PREPARE/FULFILL exchanged through SOCKS5 proxy between two connectors                 | Integration | P0       |
| T-35.6-INT-05   | `ws` WebSocket connection established through `SocksProxyAgent` to local WS server        | Integration | P0       |
| T-35.6-INT-06   | Two connectors configured with `type: "direct"` peer normally (baseline verification)     | Integration | P0       |
| T-35.6-INT-07   | Mixed topology: one connector SOCKS, one connector direct -- peering works when proxy routes to direct endpoint | Integration | P1 |

**Approach:** Integration tests spin up a local SOCKS5 proxy server in-process (using a library like `socks` or a minimal TCP relay). Two connector instances are configured to peer through the proxy. Tests verify BTP handshake and ILP packet exchange. The `.anon` log audit test (T-35.6-SEC-05) captures transport module log output via a custom pino transport and scans for `.anon` patterns at INFO level. No Docker required.

**Test Files:**
- `packages/connector/test/integration/transport-socks5.test.ts` (T-35.6-INT-01 through T-35.6-INT-07)
- `packages/connector/src/transport/transport-security.test.ts` (T-35.6-SEC-01 through T-35.6-SEC-05)

---

### Story 35.7: Documentation

**Test Level:** Documentation review (manual, non-automated)
**Risk Focus:** R-13 (key rotation), R-10 (timeout guidance)

| ID              | Scenario                                                                                  | Type          | Priority |
| --------------- | ----------------------------------------------------------------------------------------- | ------------- | -------- |
| T-35.7-DOC-01   | Deployment guide covers ATOR transport setup from scratch                                 | Doc review    | P1       |
| T-35.7-DOC-02   | Config reference documents all `transport` block fields with examples                     | Doc review    | P1       |
| T-35.7-DOC-03   | Privacy model explains three-layer stack (ATOR + ILP + NIP-59)                            | Doc review    | P1       |
| T-35.7-DOC-04   | Performance guide includes recommended ILP timeout values for ATOR peers                  | Doc review    | P1       |
| T-35.7-DOC-05   | Troubleshooting section covers DNS leak detection and proxy failure diagnostics            | Doc review    | P1       |
| T-35.7-DOC-06   | Hidden service key persistence documented (prevents address rotation)                     | Doc review    | P1       |

**Approach:** Documentation review is manual. Acceptance criteria are verified by reading the documentation and confirming completeness. No automated tests for documentation content.

---

## 3. Cross-Story Integration Tests

These tests verify behavior that spans multiple stories and cannot be tested in isolation.

| ID          | Stories Covered | Scenario                                                                              | Type        | Priority |
| ----------- | --------------- | ------------------------------------------------------------------------------------- | ----------- | -------- |
| T-CROSS-01  | 35.1, 35.4      | `ConnectorNode` with default config creates `DirectTransportProvider`, starts, and stops cleanly | Integration | P0 |
| T-CROSS-02  | 35.2, 35.3, 35.4 | `ConnectorNode` with valid SOCKS5 config creates `SocksTransportProvider`, passes agent to BTP client | Integration | P0 |
| T-CROSS-03  | 35.2, 35.4      | BTP WebSocket connects through SOCKS proxy, exchanges BTP AUTH + ILP packets          | Integration | P0       |
| T-CROSS-04  | 35.3, 35.4      | Invalid config (`socks5://`) rejected before `ConnectorNode.start()` attempts connection | Integration | P0 |
| T-CROSS-05  | 35.2, 35.5      | Managed ATOR client starts, SOCKS proxy becomes available, `SocksTransportProvider` starts successfully | Integration | P1 |
| T-CROSS-06  | 35.1, 35.2, 35.4 | Switching from `direct` to `socks5` config and restarting connector changes transport behavior | Integration | P1 |

---

## 4. Regression Analysis

### Regression Risk Assessment

Epic 35 modifies two critical existing components:
1. **BTP client** (`btp-client.ts`) -- adds optional `agent` parameter to WebSocket constructor
2. **ConnectorNode** (`connector-node.ts`) -- adds transport provider lifecycle hooks

Both modifications must be backward-compatible. The transport layer is opt-in with `type: "direct"` as the default.

### Regression Test Matrix

| ID       | Component                | Scenario                                                                    | Risk    | Priority |
| -------- | ------------------------ | --------------------------------------------------------------------------- | ------- | -------- |
| T-REG-01 | BTP client               | Existing BTP tests pass without modification (no `agent` in default config) | R-03    | P0       |
| T-REG-02 | ConnectorNode            | Existing connector startup/shutdown tests pass unchanged                    | R-03    | P0       |
| T-REG-03 | Config loader            | Existing configs without `transport` block load without errors              | R-07    | P0       |
| T-REG-04 | Health endpoint          | Existing health checks return expected format (transport field is additive) | R-08    | P0       |
| T-REG-05 | EVM settlement           | EVM payment channel tests pass unchanged                                    | R-03    | P0       |
| T-REG-06 | Solana settlement        | Solana payment channel tests pass unchanged                                 | R-03    | P0       |
| T-REG-07 | Mina settlement          | Mina payment channel tests pass unchanged                                   | R-03    | P0       |
| T-REG-08 | ILP packet forwarding    | ILP PREPARE/FULFILL/REJECT handling unchanged                               | R-03    | P0       |

**Approach:** Regression is verified by running the existing test suite (`npm test`) without modification. No new regression-specific test files needed -- the gate is that all existing tests pass. CI pipeline includes the full test suite on every PR.

---

## 5. Test Data Requirements

### Mock SOCKS5 Proxy

Integration tests require a local SOCKS5 proxy server. Options (in preference order):

1. **In-process SOCKS5 server** using the `socks` npm package or a minimal TCP relay (~50 lines). Starts on a random port, routes connections to localhost targets.
2. **`socksv5` npm package** -- lightweight SOCKS5 server for testing.

The mock proxy must support:
- `CONNECT` command (required for WebSocket upgrade)
- Remote DNS resolution (for `socks5h://` scheme testing)
- Controllable shutdown (for fail-closed testing)

### Test Configuration Objects

```typescript
// Direct transport config (default)
const directConfig = {
  transport: { type: 'direct' as const },
};

// SOCKS5 transport config
const socks5Config = {
  transport: {
    type: 'socks5' as const,
    socksProxy: 'socks5h://127.0.0.1:9050',
    externalUrl: 'ws://testabcdef123456.anon/btp',
    managed: false,
  },
};

// Invalid configs for negative testing
const dnsLeakConfig = {
  transport: {
    type: 'socks5' as const,
    socksProxy: 'socks5://127.0.0.1:9050', // missing 'h'
    externalUrl: 'ws://testabcdef123456.anon/btp',
  },
};

const missingProxyConfig = {
  transport: {
    type: 'socks5' as const,
    // socksProxy missing
    externalUrl: 'ws://testabcdef123456.anon/btp',
  },
};

const missingExternalUrlConfig = {
  transport: {
    type: 'socks5' as const,
    socksProxy: 'socks5h://127.0.0.1:9050',
    // externalUrl missing
  },
};
```

### Mock Logger for `.anon` Log Audit

```typescript
// Captures log calls by level for audit
function createAuditLogger() {
  const calls: Record<string, string[]> = {
    info: [],
    warn: [],
    error: [],
    fatal: [],
    debug: [],
    trace: [],
  };
  // ... pino mock that records calls by level
  // T-35.6-SEC-05 asserts: no entry in info/warn/error/fatal contains '.anon'
}
```

---

## 6. Test Environment and Infrastructure

### Dependencies (Test-Only)

| Package            | Purpose                                      | Required For         |
| ------------------ | -------------------------------------------- | -------------------- |
| `socks` or `socksv5` | In-process SOCKS5 server for integration tests | T-35.6-INT-*       |
| `jest`             | Test runner (existing)                        | All tests            |
| `ts-jest`          | TypeScript transform (existing)               | All tests            |
| `pino`             | Logger mock (existing pattern)                | T-35.6-SEC-05        |

### CI Pipeline Integration

| Gate         | Tests Included                                        | When              |
| ------------ | ----------------------------------------------------- | ----------------- |
| PR checks    | All unit tests (35.1--35.5) + security tests (35.6-SEC) | Every PR          |
| PR checks    | All integration tests (35.6-INT) except managed client  | Every PR          |
| PR checks    | Full regression suite (existing tests)                | Every PR          |
| Nightly      | Managed ATOR client tests (35.5, T-CROSS-05)          | Nightly (if `anon` binary available) |

### Coverage Thresholds

Per project standards: branches 60%, functions 75%, lines 70%, statements 70%. The transport module should meet or exceed these thresholds independently.

---

## 7. Test Execution Order

### Recommended Implementation Order

1. **Story 35.1** -- Interface + DirectTransportProvider (foundation, no dependencies)
2. **Story 35.3** -- Config schema (can be built in parallel with 35.1)
3. **Story 35.2** -- SocksTransportProvider (depends on 35.1 interface)
4. **Story 35.4** -- Wire into ConnectorNode + BTP client (depends on 35.1, 35.2, 35.3)
5. **Story 35.6** -- Comprehensive test suite (depends on 35.1--35.4)
6. **Story 35.5** -- Managed ATOR client (optional, depends on 35.2)
7. **Story 35.7** -- Documentation (depends on all above)

### Test Dependency Graph

```
T-35.1-* (DirectTransportProvider unit)
    │
    ├── T-35.3-* (Config validation unit)
    │       │
    ├── T-35.2-* (SocksTransportProvider unit)
    │       │
    │       ├── T-35.4-* (ConnectorNode + BTP wiring unit)
    │       │       │
    │       │       ├── T-35.6-INT-* (Integration tests)
    │       │       │
    │       │       └── T-CROSS-* (Cross-story integration)
    │       │
    │       └── T-35.5-* (Managed client unit)
    │
    └── T-REG-* (Regression -- runs independently against existing suite)
```

---

## 8. Security Test Focus Areas

Given the privacy-critical nature of this epic, security tests deserve special attention:

### DNS Leak Prevention (Defense in Depth)

Three independent layers prevent DNS leaks:

1. **Config validation** (Story 35.3): Zod schema rejects `socks5://` at config load time
2. **Provider constructor** (Story 35.2): `SocksTransportProvider` validates scheme in constructor
3. **Integration verification** (Story 35.6): End-to-end test confirms remote DNS resolution

All three layers are tested independently. An attacker or misconfiguration must bypass all three to cause a DNS leak.

### Fail-Closed Verification

Three scenarios verify fail-closed behavior:

1. **Startup failure** (T-35.2-03, T-35.4-05): Proxy unreachable at start -> hard error
2. **Mid-session failure** (T-35.6-INT-03): Proxy drops -> connections fail, health reports false
3. **No fallback** (T-35.6-SEC-02): Direct connection never established when SOCKS configured

### `.anon` Address Logging Audit

Test T-35.6-SEC-05 uses a capturing logger to verify that `.anon` addresses never appear in log output at INFO level or above. The test exercises all transport provider operations (start, createAgent, healthCheck, stop) with `.anon` URLs and asserts that only DEBUG/TRACE entries contain the address.

---

## 9. Open Questions for Testing

1. **Mock SOCKS5 server library choice:** Should we use `socks`, `socksv5`, or implement a minimal SOCKS5 server (~50 lines of TCP handling)? Recommendation: use `socksv5` for reliability, or a minimal implementation for zero test dependencies.

2. **Integration test timeout:** SOCKS5 proxy introduces latency. Should integration tests have extended timeouts (e.g., 30s instead of default 5s)? Recommendation: 30s timeout for SOCKS integration tests, matching existing integration test patterns.

3. **Managed client testing scope:** Story 35.5 tests require either a mock of the `@anyone-protocol/anyone-client` SDK or the actual `anon` binary. Unit tests should mock the SDK. Should we have any tests that use the real binary in nightly CI? Recommendation: nightly-only, skip if binary unavailable.

4. **`.anon` address in test assertions:** Test data includes `.anon` addresses (e.g., `ws://testabcdef123456.anon/btp`). These are test fixtures, not real addresses. Confirm that test log output at DEBUG level is acceptable and does not trigger the security audit test.
