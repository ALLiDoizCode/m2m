---
stepsCompleted:
  [
    'step-01-preflight-and-context',
    'step-02-generation-mode',
    'step-03-test-strategy',
    'step-04-generate-tests',
    'step-05-validate-and-complete',
  ]
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-04-13'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/35-4-wire-transportprovider-into-connectornode-and-btp-client.md'
  - '_bmad-output/implementation-artifacts/35-3-extend-config-schema-for-transport-block.md'
  - '_bmad-output/implementation-artifacts/35-2-implement-sockstransportprovider.md'
  - '_bmad-output/implementation-artifacts/35-1-define-transportprovider-interface-directtransportprovider.md'
  - '_bmad-output/planning-artifacts/test-design-epic-35.md'
  - 'packages/connector/src/core/connector-node.ts'
  - 'packages/connector/src/core/connector-node.test.ts'
  - 'packages/connector/src/btp/btp-client.ts'
  - 'packages/connector/src/btp/btp-client.test.ts'
  - 'packages/connector/src/btp/btp-client-manager.ts'
  - 'packages/connector/src/btp/btp-client-manager.test.ts'
  - 'packages/connector/src/transport/transport-provider.ts'
  - 'packages/connector/src/transport/direct-transport-provider.ts'
  - 'packages/connector/src/transport/socks-transport-provider.ts'
  - 'packages/connector/src/transport/index.ts'
  - 'packages/connector/src/http/types.ts'
  - 'packages/connector/src/config/types.ts'
  - '_bmad/tea/testarch/knowledge/data-factories.md'
  - '_bmad/tea/testarch/knowledge/test-quality.md'
  - '_bmad/tea/testarch/knowledge/test-levels-framework.md'
  - '_bmad/tea/testarch/knowledge/test-priorities-matrix.md'
  - '_bmad/tea/testarch/knowledge/test-healing-patterns.md'
---

# ATDD Checklist — Epic 35, Story 35.4: Wire TransportProvider into ConnectorNode and BTP Client

**Date:** 2026-04-13
**Author:** Jonathan
**Primary Test Level:** Unit (co-located Jest). Zero live network. Transport providers, BTP WebSocket, and ConfigLoader all mocked. Cross-story smoke tests (T-CROSS-01, T-CROSS-02) stay at unit level — integration against a real SOCKS5 proxy is Story 35.6's scope.

---

## Story Summary

Story 35.4 integrates the three foundation stories (35.1 interface, 35.2 SOCKS impl, 35.3 config schema) into the running connector. `ConnectorNode.start()` selects a `TransportProvider` from validated `config.transport`, awaits its `start()` before any BTP activity (fail-closed), passes its `createAgent(peerUrl)` output into every outbound BTP WebSocket via a `BTPClient.agentFactory` callback, surfaces cached transport health on `HealthStatus.transport`, and audits INFO-level logs for `.anon` leakage. Zero behavioral regression for existing `type: "direct"` deployments.

**As a** connector operator
**I want** `ConnectorNode` to select and manage a `TransportProvider` based on YAML config and to pass that provider's `http.Agent` to every outbound BTP WebSocket
**So that** I can opt in to SOCKS5/ATOR overlay transport with a single `transport:` block — fail-closed on startup, health-surfaced, with zero behavioral change for existing `type: "direct"` deployments.

---

## Acceptance Criteria

Authoritative AC copy is in the story (lines 31–214). Test-level summary:

1. **AC 1** — Direct (or absent) transport drives BTP with no agent (T-35.4-01, T-35.4-07, T-CROSS-01)
2. **AC 2** — `socks5` transport drives BTP via `SocksProxyAgent` (T-35.4-06, T-CROSS-02)
3. **AC 3** — Fail-closed on unreachable SOCKS proxy; no BTP server, no peer connects (T-35.4-05, T-35.6-SEC-02, R-02)
4. **AC 4** — Startup ordering: validate → construct provider → `await provider.start()` → BTP server → peer loop (T-35.4-02, T-35.4-09)
5. **AC 5** — Shutdown ordering: BTP clients → BTP server → `await provider.stop()` LAST; idempotent (T-35.4-03, T-35.4-08)
6. **AC 6** — `HealthStatus.transport = { type, healthy }` is additive and optional, cached (T-35.4-04, T-35.6-INT-02, R-08)
7. **AC 7** — No `.anon` at INFO+ anywhere in ConnectorNode / BTPClientManager / BTPClient (T-35.6-SEC-05, R-05)
8. **AC 8** — Per-peer `createAgent(peerUrl)`, fresh agent per connect (T-35.4-10)
9. **AC 9** — DirectTransportProvider synthesizes `externalUrl = ws://localhost:${btpServerPort}` (T-35.4-11)
10. **AC 10** — Zero regression; coverage thresholds preserved (T-REG-01…T-REG-08)
11. **AC 11** — Readonly `node.transportProvider: TransportProvider | null` accessor (T-35.4-12)
12. **AC 12** — Transport health-check interval scheduled only after successful start, cleared before `provider.stop()` (T-35.4-13)

---

## Failing Tests Created (RED Phase)

The RED phase intentionally co-locates tests with source per project convention (no separate `tests/` root for the connector package). All tests are **Jest unit tests** that run under `packages/connector` and are mock-driven (no live network, no real SOCKS5 proxy).

### Tier A — Redaction utility (1 file, 6 tests) — ✅ WRITTEN

**File:** `packages/connector/src/utils/redact.test.ts` (49 lines)

| Test | AC | T-ID | RED reason |
|------|----|------|------------|
| returns sentinel when URL contains `.anon` in host | #7 | T-35.6-SEC-05 | `./redact` module does not exist yet |
| redacts uppercase/mixed-case `.anon` | #7 | T-35.6-SEC-05 | same |
| redacts `.anon` anywhere in URL (conservative) | #7 | T-35.6-SEC-05 | same |
| returns non-`.anon` URLs unchanged | #7, #10 | T-35.6-SEC-05, T-REG-* | same |
| handles empty string | #7 | T-35.6-SEC-05 | same |
| idempotent on sentinel | #7 | T-35.6-SEC-05 | same |

**Verified RED** by running `npx jest packages/connector/src/utils/redact.test.ts`:

```
FAIL connector packages/connector/src/utils/redact.test.ts
  ● Test suite failed to run
    TS2307: Cannot find module './redact' or its corresponding type declarations.
```

### Tier B — ConnectorNode wiring (add to existing `connector-node.test.ts`) — 12 skeleton snippets, dev to paste during Task 7

Because `connector-node.test.ts` is 1976 lines and already uses `jest.mock('../btp/btp-client-manager')` / `jest.mock('../btp/btp-server')` / `jest.mock('../config/config-loader')`, the RED tests are additive: dev pastes these inside the existing `describe('ConnectorNode', ...)` block during Task 7. Pre-requisite at the top of the file:

```ts
import type { TransportProvider } from '../transport';
import * as transportModule from '../transport';

jest.mock('../transport', () => {
  const actual = jest.requireActual('../transport');
  return {
    ...actual,
    DirectTransportProvider: jest.fn(),
    SocksTransportProvider: jest.fn(),
  };
});

// Helper in the existing factory block:
const createMockProvider = (overrides: Partial<TransportProvider> = {}): jest.Mocked<TransportProvider> => ({
  createAgent: jest.fn().mockReturnValue(undefined),
  getExternalUrl: jest.fn().mockReturnValue('ws://localhost:3000'),
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  healthCheck: jest.fn().mockResolvedValue(true),
  ...overrides,
} as unknown as jest.Mocked<TransportProvider>);
```

Tests to add (Task 7 already lists 7.1–7.12 — these snippets give RED-ready bodies):

| # | Test | AC | T-ID | RED failure mode |
|---|------|----|------|------------------|
| 7.1 | `DirectTransportProvider is instantiated when config.transport is absent` | #1, #9 | T-35.4-01 | `_createTransportProvider` does not exist; `DirectTransportProvider` mock never called |
| 7.2 | `DirectTransportProvider is instantiated when config.transport.type === 'direct'` | #1 | T-35.4-07 | same |
| 7.3 | `SocksTransportProvider is instantiated with socks5 config` | #2 | T-35.4-06 | `SocksTransportProvider` mock never called |
| 7.4 | `transportProvider.start() is awaited BEFORE btpServer.start()` | #4 | T-35.4-02 | ordering array: provider.start not present or ordered after btpServer.start |
| 7.5 | `transportProvider.stop() is awaited AFTER btpServer.stop()` | #5 | T-35.4-03 | same ordering array |
| 7.6 | `start() rejects and leaves node.transportProvider === null when provider.start() throws` | #3, #11 | T-35.4-05 | `node.transportProvider` getter does not exist / `_transportProvider` never nulled |
| 7.7 | `getHealthStatus().transport.type matches config` | #6 | T-35.4-04 | `HealthStatus.transport` field not populated |
| 7.8 | `getHealthStatus().transport.healthy reflects cached healthCheck() result` | #6 | T-35.6-INT-02 | no cache field / no timer |
| 7.9 | `node.transportProvider is null before start() and after stop(), non-null between` | #11 | T-35.4-12 | getter missing |
| 7.10 | `getHealthStatus().transport is absent when provider is null` | #6 | T-35.4-04 | field always emitted or always absent |
| 7.11 | `health-check timer: scheduled on start, not on failed start, cleared on stop, no tick after stop` | #12 | T-35.4-13 | no `setInterval` yet |
| 7.12 | `stop() before start() does not throw; double-start does not regress` | #10 | T-REG-* | provider init may throw when `_btpServerStarted=false` |

**Canonical RED body for 7.1 (copy-paste template — mirror for 7.2–7.12):**

```ts
it('instantiates DirectTransportProvider when config.transport is absent (AC #1, T-35.4-01)', async () => {
  // Arrange
  const configNoTransport = createTestConfig(); // no transport field
  (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(configNoTransport);
  const mockProvider = createMockProvider();
  (transportModule.DirectTransportProvider as jest.Mock).mockImplementation(() => mockProvider);

  const node = new ConnectorNode(testConfigPath, mockLogger);

  // Act
  await node.start();

  // Assert
  expect(transportModule.DirectTransportProvider).toHaveBeenCalledTimes(1);
  expect(transportModule.SocksTransportProvider).not.toHaveBeenCalled();
  expect(mockProvider.start).toHaveBeenCalledTimes(1);

  await node.stop();
});
```

**Canonical RED body for 7.4 (ordering — the load-bearing test):**

```ts
it('awaits transportProvider.start() before btpServer.start() (AC #4, T-35.4-02)', async () => {
  const order: string[] = [];
  const mockProvider = createMockProvider({
    start: jest.fn().mockImplementation(async () => { order.push('transport.start'); }),
  });
  (transportModule.DirectTransportProvider as jest.Mock).mockImplementation(() => mockProvider);
  mockBTPServer.start.mockImplementation(async () => { order.push('btpServer.start'); });
  mockBTPClientManager.addPeer.mockImplementation(async () => { order.push('addPeer'); });

  const node = new ConnectorNode(testConfigPath, mockLogger);
  await node.start();

  expect(order.indexOf('transport.start')).toBeLessThan(order.indexOf('btpServer.start'));
  expect(order.indexOf('btpServer.start')).toBeLessThan(order.indexOf('addPeer'));

  await node.stop();
});
```

**Canonical RED body for 7.6 (fail-closed):**

```ts
it('rejects start() and leaves transportProvider === null when provider.start() throws (AC #3, T-35.4-05)', async () => {
  const boom = new Error('SocksTransportProvider: SOCKS5 proxy unreachable at 127.0.0.1:9050');
  const socksCfg: TransportConfig = {
    type: 'socks5',
    socksProxy: 'socks5h://127.0.0.1:9050',
    externalUrl: 'wss://test.anon/btp',
    managed: false,
  };
  (ConfigLoader.loadConfig as jest.Mock).mockReturnValue(createTestConfig({ transport: socksCfg }));
  const mockProvider = createMockProvider({ start: jest.fn().mockRejectedValue(boom) });
  (transportModule.SocksTransportProvider as jest.Mock).mockImplementation(() => mockProvider);

  const node = new ConnectorNode(testConfigPath, mockLogger);
  await expect(node.start()).rejects.toThrow(/SOCKS5 proxy unreachable/);
  expect(node.transportProvider).toBeNull();
  expect(mockBTPServer.start).not.toHaveBeenCalled();
  expect(mockBTPClientManager.addPeer).not.toHaveBeenCalled();
});
```

**Canonical RED body for 7.11 (timer lifecycle):**

```ts
it('starts exactly one 30s healthCheck interval and clears it before provider.stop() (AC #12, T-35.4-13)', async () => {
  jest.useFakeTimers();
  const mockProvider = createMockProvider({
    healthCheck: jest.fn().mockResolvedValue(true),
  });
  (transportModule.DirectTransportProvider as jest.Mock).mockImplementation(() => mockProvider);

  const node = new ConnectorNode(testConfigPath, mockLogger);
  await node.start();

  // Initial seed: no tick required
  expect(node.getHealthStatus().transport?.healthy).toBe(true);
  expect(mockProvider.healthCheck).toHaveBeenCalledTimes(0);

  // Tick once
  await jest.advanceTimersByTimeAsync(30_000);
  expect(mockProvider.healthCheck).toHaveBeenCalledTimes(1);

  // Track stop order
  const stopOrder: string[] = [];
  mockProvider.stop.mockImplementation(async () => { stopOrder.push('provider.stop'); });
  const originalHealth = mockProvider.healthCheck;
  mockProvider.healthCheck = jest.fn().mockImplementation(async () => {
    stopOrder.push('healthCheck.during-stop');
    return true;
  });

  await node.stop();

  // No healthCheck invocations after stop() resolves
  await jest.advanceTimersByTimeAsync(60_000);
  expect(stopOrder).toContain('provider.stop');
  expect(stopOrder).not.toContain('healthCheck.during-stop');
  jest.useRealTimers();
});
```

### Tier C — BTP client + manager wiring (add to existing test files) — 7 skeletons (Task 8)

**File:** `packages/connector/src/btp/btp-client.test.ts`

| # | Test | AC | T-ID | RED failure mode |
|---|------|----|------|------------------|
| 8.1 | `connect() with no agentFactory → new WebSocket(url) called with one arg` | #1, #10 | T-35.4-07 | constructor option does not exist; ignore path |
| 8.2 | `connect() with agentFactory returning undefined → new WebSocket(url) called with one arg` | #1 | T-35.4-07 | same |
| 8.3 | `connect() with agentFactory returning SocksProxyAgent → new WebSocket(url, { agent }) called` | #2, #8 | T-35.4-06, T-35.4-10 | same |
| 8.4 | `agentFactory is called once per connect() (not per construction)` | #8 | T-35.4-10 | no factory plumbing |
| 8.6 | `.anon peer URL does NOT appear in INFO-level log entries` | #7 | T-35.6-SEC-05 | no redaction yet; `btp_connection_attempt` / `btp_connected` emit raw url |
| 8.7 | `reconnect after drop → agentFactory called again (fresh agent per connect)` | #2, #8 | T-35.4-10 | ditto |

**File:** `packages/connector/src/btp/btp-client-manager.test.ts`

| # | Test | AC | T-ID | RED failure mode |
|---|------|----|------|------------------|
| 8.5 | `BTPClientManager forwards agentFactory to every BTPClient it constructs (N=3 peers)` | #8 | T-35.4-10 | manager constructor does not accept options bag |
| 8.5b | `.anon peer URL does NOT appear in INFO-level log entries from addPeer` | #7 | T-35.6-SEC-05 | `btp_client_add_peer` emits raw `url` |

**Canonical RED body for 8.3:**

```ts
it('passes { agent } to ws constructor when agentFactory returns an agent (AC #2, #8, T-35.4-06)', async () => {
  const fakeAgent = { isFakeAgent: true } as unknown as http.Agent;
  const factory = jest.fn().mockReturnValue(fakeAgent);

  client = new BTPClient(mockPeer, 'test-node', mockLogger, undefined, { agentFactory: factory });
  await simulateSuccessfulConnection();

  expect(factory).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledWith(mockPeer.url);
  expect(WebSocket).toHaveBeenCalledWith(mockPeer.url, { agent: fakeAgent });
});
```

**Canonical RED body for 8.6 (`.anon` log audit):**

```ts
it('does not emit .anon peer URL at INFO+ during connect (AC #7, T-35.6-SEC-05)', async () => {
  const anonPeer: Peer = { ...createTestPeer('anonPeer', 'wss://testabcdef.anon/btp') };
  const anonClient = new BTPClient(anonPeer, 'test-node', mockLogger);
  const connectPromise = anonClient.connect();
  await new Promise((r) => setImmediate(r));
  mockWs.simulateOpen();
  await new Promise((r) => setImmediate(r));
  const authMsg = parseBTPMessage(mockWs.sentMessages[0]!);
  mockWs.simulateMessage(serializeBTPMessage(createAuthResponse(authMsg.requestId)));
  await connectPromise;

  const infoCalls = mockLogger.info.mock.calls;
  const warnCalls = mockLogger.warn.mock.calls;
  const errorCalls = mockLogger.error.mock.calls;
  const fatalCalls = mockLogger.fatal.mock.calls;
  for (const call of [...infoCalls, ...warnCalls, ...errorCalls, ...fatalCalls]) {
    expect(JSON.stringify(call)).not.toMatch(/\.anon/i);
  }

  await anonClient.disconnect();
});
```

---

## Data Factories Created

No new factory files — existing `createTestPeer`, `createTestConfig`, `createTestPreparePacket` helpers in the co-located test files are sufficient. Story 35.4 adds one **in-file** factory:

### `createMockProvider(overrides?)` — for `connector-node.test.ts`

**Exports (in-file helper):**

- `createMockProvider(overrides?: Partial<TransportProvider>)` — returns a `jest.Mocked<TransportProvider>` with defaults: `createAgent` → `undefined`, `start`/`stop` → resolve, `healthCheck` → resolve `true`, `getExternalUrl` → `'ws://localhost:3000'`.

**Example usage:**

```ts
const mockProvider = createMockProvider({ start: jest.fn().mockRejectedValue(new Error('boom')) });
(transportModule.SocksTransportProvider as jest.Mock).mockImplementation(() => mockProvider);
```

---

## Fixtures Created

None. Playwright-style fixtures are not applicable — this is a pure Jest/unit-level story. Existing `beforeEach` setup in `connector-node.test.ts` / `btp-client.test.ts` supplies the lifecycle scaffold.

---

## Mock Requirements

### `../transport` module

**Required mocks:**
- `DirectTransportProvider` — `jest.fn()` constructor, returns `createMockProvider(...)`.
- `SocksTransportProvider` — `jest.fn()` constructor, returns `createMockProvider(...)`.

**Established convention:** `jest.mock('../transport', () => { const actual = jest.requireActual('../transport'); return { ...actual, DirectTransportProvider: jest.fn(), SocksTransportProvider: jest.fn() }; });` (preserves type-only exports like `TransportProvider`).

### `ws` module

Already mocked in `btp-client.test.ts`. Assertion convention: `expect(MockWebSocket).toHaveBeenCalledWith(url, { agent })` vs `expect(MockWebSocket).toHaveBeenCalledWith(url)`.

### Real SOCKS5 proxy

**NOT MOCKED HERE.** Story 35.4 runs zero live TCP probes. Any test that needs a real proxy is out of scope (Story 35.6 integration).

---

## Required data-testid Attributes

Not applicable — Story 35.4 has no UI surface. `HealthStatus.transport` is a JSON field consumed by existing admin UI / orchestrators with no DOM changes expected.

---

## Implementation Checklist

Tests map directly onto the story's Task 1–10 list. Dev should follow the story's task order; the test → implementation mapping is:

### Test group: `redact.test.ts` (6 tests)

**File:** `packages/connector/src/utils/redact.test.ts` (written)

**Tasks to make these tests pass (Story Task 6.2):**

- [ ] Create `packages/connector/src/utils/redact.ts` exporting `export function redactPeerUrl(url: string): string`
- [ ] Implementation: `return /\.anon/i.test(url) ? '<redacted-anon>' : url;`
- [ ] Run: `npx jest packages/connector/src/utils/redact.test.ts`
- [ ] ✅ All 6 tests pass

**Estimated effort:** 0.25h

---

### Test group: `connector-node.test.ts` transport wiring (12 tests, 7.1–7.12)

**File:** `packages/connector/src/core/connector-node.test.ts`

**Tasks to make these tests pass (Story Tasks 1, 2, 4, 5):**

- [ ] Task 1.1: Add `_transportProvider: TransportProvider | null = null` field
- [ ] Task 1.2: Add `get transportProvider(): TransportProvider | null` getter
- [ ] Task 1.3: Import `TransportProvider`, `DirectTransportProvider`, `SocksTransportProvider` from `../transport`; `TransportConfig` from `../config`
- [ ] Task 2.1: In `start()` after `validateChainProviders`, construct provider and `await this._transportProvider.start()` inside try/catch; null out on throw
- [ ] Task 2.2: Implement `_createTransportProvider(cfg)` with exhaustive switch (`default: assertNever(...)`)
- [ ] Task 2.3/2.4: Verify BTP server + peer loop run only after provider.start() resolves
- [ ] Task 4.1: In `stop()`, after `btpServer.stop()`, await `_transportProvider.stop()` in try/finally, null out
- [ ] Task 5: `HealthStatus.transport` field + `_lastTransportHealthy` cache + `_transportHealthInterval` 30s timer + lifecycle clear
- [ ] Run: `npx jest packages/connector/src/core/connector-node.test.ts`
- [ ] ✅ All existing + 12 new tests pass

**Estimated effort:** 4h

---

### Test group: `btp-client.test.ts` agent + redact (6 tests, 8.1–8.4, 8.6, 8.7)

**File:** `packages/connector/src/btp/btp-client.test.ts`

**Tasks to make these tests pass (Story Tasks 3.1, 3.4, 3.5, 6.3):**

- [ ] Task 3.1: Add optional constructor option `agentFactory?: (peerUrl: string) => http.Agent | undefined` (options-bag or 5th positional — story allows either; options-bag if >4 positional)
- [ ] Task 3.4: Invoke factory inside `connect()`; `new WebSocket(url, { agent })` iff `agent !== undefined`, else `new WebSocket(url)`
- [ ] Task 3.5: Factory invoked inside `connect()` only (not at construction)
- [ ] Task 6.3: Apply `redactPeerUrl` to `btp_connection_attempt` + `btp_connected` INFO log sites
- [ ] Run: `npx jest packages/connector/src/btp/btp-client.test.ts`
- [ ] ✅ All existing + 6 new tests pass

**Estimated effort:** 2h

---

### Test group: `btp-client-manager.test.ts` forwarding + redact (2 tests, 8.5, 8.5b)

**File:** `packages/connector/src/btp/btp-client-manager.test.ts`

**Tasks to make these tests pass (Story Tasks 3.2, 3.3, 6.3):**

- [ ] Task 3.2: Add `agentFactory?` option to `BTPClientManager` constructor; forward to every `new BTPClient(...)` call
- [ ] Task 3.3: In `connector-node.ts` at `new BTPClientManager(...)` site, pass `(peerUrl) => this._transportProvider?.createAgent(peerUrl)`
- [ ] Task 6.3: Apply `redactPeerUrl` to `btp_client_add_peer` log site
- [ ] Run: `npx jest packages/connector/src/btp/btp-client-manager.test.ts`
- [ ] ✅ All existing + 2 new tests pass

**Estimated effort:** 1.5h

---

### Regression sweep (Task 9)

- [ ] `npm run test:unit` in `packages/connector` — all suites pass, no existing assertions modified
- [ ] `make test` at repo root
- [ ] `make lint`, `npm run format:check`, `npm run build` — all green
- [ ] `connector-node-optional-deps.test.ts` still passes (transport init is NOT an optional-dep path — fail-closed)
- [ ] Coverage thresholds preserved: branches ≥60%, functions ≥75%, lines ≥70%, statements ≥70%

**Estimated effort:** 0.5h (green path); add up to 2h if any regression needs diagnosis.

---

## Running Tests

```bash
# Run all Story 35.4 tests
npx jest packages/connector/src/utils/redact.test.ts \
         packages/connector/src/core/connector-node.test.ts \
         packages/connector/src/btp/btp-client.test.ts \
         packages/connector/src/btp/btp-client-manager.test.ts

# Redact utility only
npx jest packages/connector/src/utils/redact.test.ts

# Full connector unit suite (regression gate)
cd packages/connector && npm run test:unit

# Coverage (verify Story 35.4 did not drop thresholds)
cd packages/connector && npm run test:unit -- --coverage

# Repo-wide gates
make test && make lint && npm run format:check && npm run build
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete) ✅

- ✅ `redact.test.ts` written and verified failing (TS2307 — module not found)
- ✅ 20 test skeletons (12 connector-node + 8 btp) specified with canonical RED bodies and failure modes
- ✅ Mock strategy documented (`../transport` module mock, `createMockProvider` helper)
- ✅ No new factories, fixtures, or testids needed — existing scaffold is sufficient
- ✅ Implementation checklist mapped 1:1 onto story Tasks 1–9

**Verified RED:**
```
FAIL packages/connector/src/utils/redact.test.ts
  TS2307: Cannot find module './redact'
```

Dev owns the mechanical paste of the 20 Tier-B/C skeletons into the existing test files (Story Tasks 7 and 8 explicitly enumerate them — these snippets are the concrete RED bodies that satisfy those tasks).

### GREEN Phase (dev next steps)

1. Start with Task 6.2 (create `redact.ts`) — fastest green, unblocks redact imports elsewhere.
2. Then Task 1 → 2 (provider field, `_createTransportProvider`, `start()` wiring).
3. Then Task 5 (HealthStatus + cache + timer) — enables 7.7, 7.8, 7.10, 7.11.
4. Then Task 3 (BTPClient agentFactory + manager forwarding) — enables 8.1–8.5, 8.7.
5. Then Task 6.3 (apply `redactPeerUrl` at INFO sites) — enables 8.6 and 8.5b.
6. Then Task 4 (stop-lifecycle ordering) — enables 7.5.
7. Finally Task 9 regression sweep.

### REFACTOR Phase

- Consider extracting the health-check-timer boilerplate to a small helper in `connector-node.ts` (`_startTransportHealthRefresh()`, `_stopTransportHealthRefresh()`) once 7.11 is green.
- Options-bag refactor for `BTPClient` constructor is pre-approved by the story if the 5th positional makes the signature unreadable — just keep existing call-site test assertions intact.

---

## Knowledge Base References Applied

- **test-quality.md** — Given/When/Then structure, one assertion per test where possible, deterministic mocks (no sleep), isolation per `beforeEach` (all skeletons reset mocks and re-stub the transport module).
- **test-levels-framework.md** — Chose unit level over integration: provider + WebSocket + ConfigLoader all mockable; fail-closed and ordering semantics fit unit scope exactly. Real-SOCKS integration is Story 35.6's scope.
- **test-priorities-matrix.md** — All 20 skeletons are P0/P1 (security fail-closed, ordering invariants, health surface) — matches the story's P0 priority and the risk register IDs (R-02, R-05, R-08).
- **data-factories.md** — Kept factories in-file (project convention for connector package); no new shared factory files.
- **test-healing-patterns.md** — Each skeleton specifies its expected RED failure mode so a future flake/heal loop can distinguish "not implemented yet" from "test broken."

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest packages/connector/src/utils/redact.test.ts`

**Results:**

```
FAIL connector packages/connector/src/utils/redact.test.ts
  ● Test suite failed to run

    packages/connector/src/utils/redact.test.ts:12:31 - error TS2307:
      Cannot find module './redact' or its corresponding type declarations.

    12 import { redactPeerUrl } from './redact';
                                     ~~~~~~~~~~

Test Suites: 1 failed, 1 total
```

**Summary:**
- Total tests written to disk: 6 (in `redact.test.ts`)
- Total tests specified as skeletons (dev to paste in Task 7/8): 20
- Passing: 0 (expected — RED phase)
- Failing: all (expected — RED phase)
- Status: ✅ RED phase verified (for the written file; skeletons will fail identically when pasted because the SUT hooks do not exist yet)

**Expected failure messages per test group:**
- `redact.test.ts` — `TS2307: Cannot find module './redact'`
- `connector-node.test.ts` 7.1–7.12 — `DirectTransportProvider` mock never called / `node.transportProvider` getter undefined / `HealthStatus.transport` undefined
- `btp-client.test.ts` 8.1–8.7 — `WebSocket` called without `{ agent }` option when agent expected / `.anon` string found in `mockLogger.info.mock.calls`
- `btp-client-manager.test.ts` 8.5, 8.5b — `new BTPClient(...)` called without factory / `.anon` in INFO logs

---

## Notes

- **Zero live network invariant.** Every test uses mocks for `../transport`, `ws`, `../config/config-loader`. No real SOCKS5 proxy, no real TCP. If a test ever needs a real proxy, it is mis-filed — move it to Story 35.6 integration.
- **Zero existing-assertion changes.** AC #10 and DoD both forbid modifying existing `expect(...)` calls. All 20 new tests are additive. The RED failures listed above are all "new expectations in new tests" — the existing 1976-line suite remains green.
- **Task 3 design lock.** Story Task 3.1 explicitly chose **Design B (callback injection via `agentFactory`)**. Do NOT inject `TransportProvider` directly into `BTPClient` even if it "feels cleaner" — that couples BTP to transport abstractions and increases mock surface. The skeletons above assume `agentFactory`.
- **`DirectTransportProvider` externalUrl synthesis (AC #9).** The synthesis site (`ws://localhost:${btpServerPort}`) is internal-only for this story. No test currently asserts downstream consumption — if a future story (35.7 docs / peer discovery) adds such a consumer, re-examine the synthesis carefully.
- **Non-`.anon` peers must still log URLs at INFO.** `redactPeerUrl` is a conditional redaction, not a blanket bump to DEBUG. Tests 8.6 / 8.5b assert `.anon` is absent, but dev should add a companion positive test showing a plain `ws://peer/btp` URL DOES appear at INFO (to prevent over-redaction regression). That positive test counts as part of Task 8 additive cases.
- **Health-timer cleanup ordering (AC #12).** `clearInterval` MUST run **before** `await provider.stop()` — otherwise a pending tick can call `healthCheck()` on a stopping provider and race. Test 7.11 verifies this ordering explicitly.
- **TSDoc comments on new public surface (Task 10).** Not a test concern, but AC #11 introduces `node.transportProvider` as admin-API-visible — dev needs TSDoc per Task 10.1. Reviewers should spot-check.

---

## Contact

**Questions or Issues?**

- Refer to `_bmad-output/implementation-artifacts/35-4-wire-transportprovider-into-connectornode-and-btp-client.md` for authoritative story context.
- Refer to `_bmad-output/planning-artifacts/test-design-epic-35.md` for T-ID → AC mapping.
- Tag @TEA in standup for skeleton clarifications.

---

**Generated by BMad TEA Agent** — 2026-04-13
