---
stepsCompleted: ['step-01-preflight-and-context', 'step-02-generation-mode', 'step-03-test-strategy', 'step-04-generate-tests', 'step-05-validate-and-complete']
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-04-13'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/35-2-implement-sockstransportprovider.md'
  - '_bmad-output/implementation-artifacts/35-1-define-transportprovider-interface-directtransportprovider.md'
  - 'packages/connector/src/transport/transport-provider.ts'
  - 'packages/connector/src/transport/direct-transport-provider.ts'
  - 'packages/connector/src/transport/direct-transport-provider.test.ts'
  - 'packages/connector/src/transport/index.ts'
  - 'packages/connector/jest.config.js'
  - 'packages/connector/package.json'
  - '_bmad/tea/testarch/knowledge/data-factories.md'
  - '_bmad/tea/testarch/knowledge/test-quality.md'
  - '_bmad/tea/testarch/knowledge/test-healing-patterns.md'
  - '_bmad/tea/testarch/knowledge/test-levels-framework.md'
---

# ATDD Checklist - Epic 35, Story 2: Implement SocksTransportProvider

**Date:** 2026-04-13
**Author:** Jonathan
**Primary Test Level:** Unit (co-located Jest + real ephemeral TCP listener for probe verification)

---

## Story Summary

Story 35.2 delivers the second `TransportProvider` implementation -- `SocksTransportProvider` -- which routes outbound BTP WebSocket connections through a SOCKS5 proxy (ATOR/Tor). The provider is fail-closed on startup, enforces `socks5h://` to prevent DNS leaks, never logs `.anon` hidden-service addresses at INFO+, and returns a fresh `SocksProxyAgent` per call. Wiring into `ConnectorNode` is deliberately deferred to Story 35.4.

**As a** connector operator
**I want** a `SocksTransportProvider` that proxies outbound BTP WebSockets through SOCKS5 with DNS-leak prevention and fail-closed startup
**So that** my connector can peer through `.anon` hidden services without exposing its real IP and without silent fallback to direct

---

## Acceptance Criteria

1. **AC 1** -- `createAgent(peerUrl)` returns a `SocksProxyAgent` configured with `socks5h://` proxy URL (T-35.2-01)
2. **AC 2** -- `getExternalUrl()` returns the configured `.anon` hidden service URL (T-35.2-02)
3. **AC 3** -- Constructor rejects `socks5://` and any non-`socks5h://` scheme with a descriptive DNS-leak error (T-35.2-05, T-35.6-SEC-03)
4. **AC 4** -- `start()` throws FAIL-CLOSED when SOCKS5 proxy is unreachable, error includes host:port, no silent fallback (T-35.2-03, T-35.6-SEC-02)
5. **AC 5** -- `start()` resolves when SOCKS5 proxy is reachable (T-35.2-09)
6. **AC 6** -- `healthCheck()` returns `true` when proxy reachable, `false` when unreachable, NEVER throws (T-35.2-04, T-35.2-07)
7. **AC 7** -- `stop()` is a safe no-op when not managed (T-35.2-08)
8. **AC 8** -- `SocksTransportProvider` implements the `TransportProvider` interface (T-35.2-10)
9. **AC 9** -- `createAgent()` succeeds even when proxy is down; returns a fresh agent per call (T-35.2-11, T-35.2-06)
10. **AC 10** -- `.anon` addresses MUST NOT appear in structured INFO/WARN/ERROR/FATAL log fields (T-35.6-SEC-05, provider-level seed)
11. **AC 11** -- Zero regression: existing tests pass, build/lint/format clean (T-REG-01..08)

---

## Test Strategy

**Primary level:** Unit tests, co-located with the implementation at `packages/connector/src/transport/socks-transport-provider.test.ts`, matching the Story 35.1 convention (`direct-transport-provider.test.ts`).

**Rationale** (test-levels-framework.md):

- The provider is a small, deterministic class with no external state apart from TCP probes to a proxy. Unit tests with a real ephemeral TCP listener on `127.0.0.1` deliver real coverage of the fail-closed probe behavior without infrastructure dependencies.
- Integration tests through a real local SOCKS5 proxy (BTP peering) are explicitly scoped to Story 35.6.
- End-to-end ATOR network tests are deferred to integration/acceptance layers.

**Framework:** Jest 29.7 + ts-jest (project default). Run via `npm run test:unit` or `make test`.

**Determinism and isolation** (test-quality.md):

- Ephemeral TCP listeners bind to `127.0.0.1:0`; Node assigns a free port; we close the listener after the test (or, for unreachable-port tests, close it _before_ the probe to acquire a known-closed port).
- No shared state between tests; each creates its own provider instance.
- `pino({ level: 'silent' })` + `jest.spyOn` for logger assertions -- no plain `jest.fn()` objects (project convention).

---

## Failing Tests Created (RED Phase)

### Unit Tests (22 tests across 9 describe blocks)

**File:** `packages/connector/src/transport/socks-transport-provider.test.ts` (~330 lines)

Verified RED by running `npx jest --testPathPattern='socks-transport-provider'` -- suite fails at TypeScript compile with `TS2307: Cannot find module 'socks-proxy-agent'` and `TS2307: Cannot find module './socks-transport-provider'`. Both failures are expected RED markers: the dependency (Task 1) and the implementation (Task 2) do not yet exist.

#### constructor scheme validation (8 tests) -- AC 3

- **Test:** `rejects socks5:// (missing the "h" suffix -- DNS-leak prevention) (T-35.2-05)`
  - **Status:** RED -- SocksTransportProvider class does not exist yet
  - **Verifies:** Constructor throws when proxy URL is `socks5://`, error message requires `socks5h://`

- **Test:** `includes a DNS-leak explanation in the error message (T-35.2-05)`
  - **Status:** RED -- class missing
  - **Verifies:** Error message mentions DNS leak (case-insensitive)

- **Test:** `rejects http:// proxy URLs (T-35.6-SEC-03)`
  - **Status:** RED
  - **Verifies:** Non-SOCKS schemes rejected with descriptive error

- **Test:** `rejects socks4:// proxy URLs (T-35.6-SEC-03)`
  - **Status:** RED
  - **Verifies:** Only `socks5h://` accepted; `socks4://` also blocked

- **Test:** `rejects an empty socksProxy value`
  - **Status:** RED
  - **Verifies:** Empty string rejected in constructor

- **Test:** `rejects a non-URL string`
  - **Status:** RED
  - **Verifies:** Malformed proxy values rejected

- **Test:** `rejects an empty externalUrl`
  - **Status:** RED
  - **Verifies:** externalUrl validation matches DirectTransportProvider pattern

- **Test:** `accepts socks5h:// with valid host:port`
  - **Status:** RED
  - **Verifies:** Happy path constructor does not throw

- **Test:** `constructor error message does NOT contain the .anon external URL`
  - **Status:** RED
  - **Verifies:** Defense-in-depth against `.anon` leakage even in error paths

#### createAgent() (4 tests) -- AC 1, AC 9

- **Test:** `returns a SocksProxyAgent instance (T-35.2-01)`
  - **Status:** RED
  - **Verifies:** Return value is a `SocksProxyAgent` (not merely any `http.Agent`)

- **Test:** `configures the returned agent with the socks5h:// proxy URL (T-35.2-01)`
  - **Status:** RED
  - **Verifies:** Agent's `proxy` field reflects `127.0.0.1:9050`

- **Test:** `returns a fresh agent per call (T-35.2-06)`
  - **Status:** RED
  - **Verifies:** No shared cached agent -- two successive calls return distinct instances

- **Test:** `does NOT throw when the proxy is unreachable (lazy connect) (T-35.2-11)`
  - **Status:** RED
  - **Verifies:** createAgent is synchronous; no network probe; defers failure to `ws` socket connect

#### getExternalUrl() (1 test) -- AC 2

- **Test:** `returns the configured .anon external URL (T-35.2-02)`
  - **Status:** RED
  - **Verifies:** Round-trip of the stored externalUrl

#### start() (3 tests) -- AC 4, AC 5

- **Test:** `resolves when the proxy TCP port is reachable (T-35.2-09)`
  - **Status:** RED
  - **Verifies:** Uses ephemeral listener on 127.0.0.1 with dynamic port; probe succeeds and `start()` resolves

- **Test:** `throws when the SOCKS5 proxy is unreachable -- FAIL CLOSED (T-35.2-03)`
  - **Status:** RED
  - **Verifies:** Closed-port probe throws; error message contains "SOCKS5"

- **Test:** `error message includes proxy host:port (T-35.6-SEC-02)`
  - **Status:** RED
  - **Verifies:** Operator diagnosability -- host:port surfaces in fail-closed error

#### healthCheck() (2 tests) -- AC 6

- **Test:** `resolves to true when the proxy is reachable (T-35.2-07)`
  - **Status:** RED
  - **Verifies:** Healthy probe returns `true`

- **Test:** `resolves to false (does NOT throw) when the proxy is unreachable (T-35.2-04)`
  - **Status:** RED
  - **Verifies:** Health checks are non-throwing; returns `false` for unreachable proxy

#### stop() (2 tests) -- AC 7

- **Test:** `resolves immediately without error when never started (T-35.2-08)`
  - **Status:** RED
  - **Verifies:** No-op in non-managed mode -- safe to call without `start()`

- **Test:** `is safe after a successful start()`
  - **Status:** RED
  - **Verifies:** Start/stop lifecycle is idempotent and safe

#### TransportProvider interface compliance (1 test) -- AC 8

- **Test:** `satisfies the TransportProvider interface at compile time and runtime (T-35.2-10)`
  - **Status:** RED
  - **Verifies:** Typescript compile-time contract + runtime method presence (`createAgent`, `getExternalUrl`, `start`, `stop`, `healthCheck`)

#### .anon log audit at INFO/WARN/ERROR/FATAL (1 test) -- AC 10

- **Test:** `never emits ".anon" at INFO/WARN/ERROR/FATAL across full lifecycle (T-35.6-SEC-05)`
  - **Status:** RED
  - **Verifies:** Exercises constructor (happy + sad), `createAgent` with `.anon` peer, `start` success + failure, `healthCheck` both branches, `stop`. Spies on `logger.info/warn/error/fatal`, serializes args with `JSON.stringify`, asserts substring `".anon"` absent from every call. DEBUG/TRACE levels intentionally excluded (developer diagnostics may contain `.anon`).

### API / E2E / Component tests

Not applicable for this story. SocksTransportProvider is a library-level component; end-to-end peering through real SOCKS5 is Story 35.6.

---

## Data Factories Created

None. The test file uses a small local helper `makeOpts()` that produces a valid `SocksTransportProviderOptions` with sensible defaults and overrides. This follows the lightweight factory pattern used in `direct-transport-provider.test.ts` without introducing a separate factory module.

---

## Fixtures Created

None as files. The test file includes two co-located test helpers:

- `startEphemeralListener()` -- binds a `net.Server` to `127.0.0.1:0`, returns `{ port, close() }`. Simulates a reachable SOCKS5 proxy at the TCP layer (no SOCKS5 handshake -- the provider only probes TCP connectivity).
- `getClosedPort()` -- binds and immediately closes a listener to acquire a guaranteed-closed port for fail-closed tests.

These are unit-test scope and belong with the test file.

---

## Mock Requirements

None at the HTTP layer. The only boundary the tests touch is the Node `net` module, which is exercised with real ephemeral listeners rather than mocks. The `socks-proxy-agent` library is instantiated directly (not mocked) so tests also verify real API compatibility -- critical because v8 API shape must match the provider's expectations.

**Logger spies** (not mocks): `pino({ level: 'silent' })` + `jest.spyOn(logger, 'info' | 'warn' | 'error' | 'fatal' | 'child')`. Stubbing `.child()` to return the same logger instance is required because Pino child loggers are new objects; without this, spies on the root logger miss calls made by the child.

---

## Required data-testid Attributes

Not applicable (no UI in this story).

---

## Implementation Checklist

Each failing test maps to concrete tasks that will make it pass. Ordering mirrors the dependency chain in the story Tasks section.

### Task A: Add `socks-proxy-agent` dependency

**Makes pass:** All tests (blocks TS compile today)

- [ ] Add `"socks-proxy-agent": "^8"` to `packages/connector/package.json` dependencies
- [ ] Run `npm install` at repo root
- [ ] Confirm `packages/connector/node_modules/socks-proxy-agent` exists with TypeScript types
- [ ] Run tests: `npx jest --testPathPattern='socks-transport-provider'`
- [ ] After dependency is added, tests still fail -- but now on `Cannot find module './socks-transport-provider'` (expected; next task fixes this)

**Estimated effort:** 0.25 hours

---

### Task B: Create `SocksTransportProvider` class

**Makes pass:** constructor validation tests, createAgent tests, getExternalUrl, TransportProvider interface compliance, stop() tests

- [ ] Create `packages/connector/src/transport/socks-transport-provider.ts`
- [ ] Export `SocksTransportProviderOptions` interface: `{ socksProxy: string; externalUrl: string; logger: pino.Logger }`
- [ ] Constructor validates: `socksProxy.startsWith('socks5h://')` (throw with DNS-leak message), `externalUrl` non-empty, error message must NOT include externalUrl
- [ ] Store `_socksProxy`, `_externalUrl`, `_logger = logger.child({ component: 'socks-transport-provider' })`
- [ ] `createAgent(peerUrl)`: `return new SocksProxyAgent(this._socksProxy)` -- fresh instance per call, synchronous, no network probe, no INFO log of peerUrl
- [ ] `getExternalUrl()`: return `this._externalUrl`
- [ ] `async stop()`: clear `_started = false`, log at INFO with `{ event: 'socks_transport_stopped' }` (no externalUrl)
- [ ] Run tests: `npx jest --testPathPattern='socks-transport-provider'`
- [ ] Verify constructor, createAgent, getExternalUrl, stop, and interface-compliance tests now pass

**Estimated effort:** 1 hour

---

### Task C: Implement TCP probe helper + `start()` + `healthCheck()`

**Makes pass:** `start()` tests (2), `healthCheck()` tests (2), `createAgent does not throw when proxy down`

- [ ] Add private `_probeProxy(timeoutMs: number): Promise<void>` using `net.createConnection({ host, port })`, `setTimeout(timeoutMs)`, resolve on `'connect'`, reject on `'error' | 'timeout'`, always `destroy()` socket
- [ ] Parse proxy URL once via `new URL(this._socksProxy)` to extract host/port
- [ ] `async start()`: call `_probeProxy(2000)`. On failure, throw `Error('SocksTransportProvider: SOCKS5 proxy unreachable at ${host}:${port}')`. On success, set `_started = true` and log `{ event: 'socks_transport_started', proxyHost, proxyPort }` -- do NOT include externalUrl
- [ ] `async healthCheck()`: call `_probeProxy(1000)`. Return `true` on success, `false` on failure. NEVER throw. On failure only, log WARN with `{ event: 'socks_transport_health_failed', proxyHost, proxyPort }` -- no externalUrl
- [ ] Run tests
- [ ] Verify all start/healthCheck/createAgent-down tests pass

**Estimated effort:** 1 hour

---

### Task D: Log-audit compliance

**Makes pass:** `.anon log audit at INFO/WARN/ERROR/FATAL` test

- [ ] Confirm no `logger.info/warn/error/fatal` call in the module includes `externalUrl`, `peerUrl`, or any string that could contain `.anon`
- [ ] If DEBUG logs include `.anon`, keep them at DEBUG (not covered by audit)
- [ ] Run tests
- [ ] Verify audit test passes

**Estimated effort:** 0.25 hours (mostly code review)

---

### Task E: Barrel export

**Makes pass:** Supports wiring in Story 35.4 (no test-visible behavior in this story but required by AC 8 delivery checklist)

- [ ] Update `packages/connector/src/transport/index.ts` to add `export { SocksTransportProvider, type SocksTransportProviderOptions } from './socks-transport-provider';`
- [ ] Keep existing `TransportProvider` + `DirectTransportProvider` exports unchanged
- [ ] Run `npm run build` and verify clean compile

**Estimated effort:** 0.1 hours

---

### Task F: Zero-regression gate

**Makes pass:** AC 11

- [ ] `npm run build` clean
- [ ] `npm run test:unit` (or `make test`) -- all prior + new tests pass
- [ ] `make lint` clean (no `console.log`, no `any`, no unused vars)
- [ ] `npm run format:check` clean
- [ ] Confirm no files outside `packages/connector/src/transport/` and `packages/connector/package.json` changed
- [ ] Review diff against Story 35.1 style (private readonly fields, async on no-ops, JSDoc on all public methods, error-prefix naming)

**Estimated effort:** 0.5 hours

---

## Running Tests

```bash
# Run only the new SocksTransportProvider tests
cd packages/connector && npx jest --testPathPattern='socks-transport-provider'

# Run all unit tests for the connector package (excludes integration/acceptance)
cd packages/connector && npm run test:unit

# Run full project test suite
make test

# Debug a single test
cd packages/connector && npx jest --testPathPattern='socks-transport-provider' -t 'FAIL CLOSED'
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

- [x] 22 failing tests written across 9 describe blocks
- [x] Test file fails at TS compile with `Cannot find module 'socks-proxy-agent'` and `Cannot find module './socks-transport-provider'` -- expected, exactly what we want
- [x] No `jest.fn()` logger stubs; uses `pino({ level: 'silent' })` + `jest.spyOn` (project convention)
- [x] Real ephemeral TCP listeners for probe verification (no boundary mocking)
- [x] Log-audit test exercises full lifecycle and asserts no `.anon` leakage at INFO+
- [x] Tests run and fail as expected; failure messages are clear and actionable

### GREEN Phase (DEV -- Next)

1. Add `socks-proxy-agent` to `packages/connector/package.json`, run `npm install`
2. Create `packages/connector/src/transport/socks-transport-provider.ts` per Task B above
3. Implement TCP probe + start + healthCheck per Task C
4. Update barrel export per Task E
5. Run `npx jest --testPathPattern='socks-transport-provider'` after each task; work down the failing list one block at a time

### REFACTOR Phase

- Review against `direct-transport-provider.ts` style (private readonly underscore-prefixed fields, JSDoc on all public methods, `@param` / `@returns`)
- Check that every INFO/WARN/ERROR/FATAL log call uses structured fields (no `.anon`, no peerUrl)
- Ensure probe helper is reusable (`start()` and `healthCheck()` both consume it with different timeouts)

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest --testPathPattern='socks-transport-provider' --no-coverage`

**Result:**

```
FAIL connector packages/connector/src/transport/socks-transport-provider.test.ts
  Test suite failed to run
    packages/connector/src/transport/socks-transport-provider.test.ts:29:33 - error TS2307:
      Cannot find module 'socks-proxy-agent' or its corresponding type declarations.
    packages/connector/src/transport/socks-transport-provider.test.ts:34:8 - error TS2307:
      Cannot find module './socks-transport-provider' or its corresponding type declarations.

Test Suites: 1 failed, 1 total
```

**Summary:**

- Total tests: 22 (0 running because TS compile blocks the suite)
- Passing: 0 (expected in RED)
- Failing: 22 (suite blocked on missing module -- expected; DEV work unblocks them)
- Status: RED phase verified

**Expected failure progression as GREEN tasks land:**

1. After Task A (`npm install socks-proxy-agent`): TS error on `./socks-transport-provider` import remains; suite still fails to compile. Expected.
2. After Task B (class skeleton + constructor + createAgent + getExternalUrl + stop): ~13 tests pass; `start`/`healthCheck`/`log audit` tests still fail on missing probe.
3. After Task C (probe + start + healthCheck): all 22 tests pass.
4. After Task D (log audit): audit test confirmed green (may already be green after Task B+C if structured logging is correct).

---

## Notes

- **Test level choice:** Unit with real TCP listeners rather than HTTP mocks. Mocking `net.createConnection` would test our mock, not our probe. Real ephemeral listeners give deterministic, fast (< 200 ms total), real coverage of the fail-closed contract.
- **Log audit is a partial T-35.6-SEC-05:** the integration-level audit lives in Story 35.6. Seeding it here at the provider level catches the most common regression risk (someone adds `externalUrl` to an INFO log later).
- **Typescript typing adjustment in log-audit test:** `jest.spyOn(logger, 'child')` needs a cast because pino's `Logger<never>` vs `Logger<string>` typing conflicts when stubbing `child()`. Cast: `(jest.spyOn(logger, 'child') as unknown as jest.Mock).mockReturnValue(logger)`.
- **SocksProxyAgent v8 API:** The `agent.proxy` field may surface either as a `URL` or as a `{ host, port }` shape depending on version. The `createAgent` test normalizes both via a union type and asserts host/port string equality.
- **Fresh agent per call:** This is a subtle but load-bearing contract -- matches how `ws` expects per-connection agents, and prevents per-peer state from leaking (especially important for overlay networks). The test uses `expect(a1).not.toBe(a2)` after two createAgent calls.
- **No silent fallback:** There is no fallback path in this class. If the proxy is down, `start()` throws. This test is asserted by `rejects.toThrow(/SOCKS5/i)`.

---

## Knowledge Base References Applied

This ATDD workflow consulted the following knowledge fragments:

- **data-factories.md** -- inline `makeOpts()` helper over file-based factories, matching Story 35.1 precedent and test-file-colocated style
- **test-quality.md** -- Given-When-Then structure, one assertion per test where practical, isolation via per-test ephemeral listeners, no shared state
- **test-healing-patterns.md** -- real TCP probe over mocked `net.createConnection` to eliminate mock drift; cast `jest.spyOn` return type for pino `.child()` to survive pino version bumps
- **test-levels-framework.md** -- unit level chosen for a pure-library class; integration (BTP peering through real local SOCKS5) explicitly deferred to Story 35.6

---

## Contact

Ask in team standup or ping Jonathan.

---

**Generated by BMad TEA Agent** - 2026-04-13
