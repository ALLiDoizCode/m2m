# Story 35.2: Implement SocksTransportProvider

Status: done

<!-- Note: Validation is optional. Run story validation for quality check before dev-story. -->

## Story

As a connector operator,
I want a `SocksTransportProvider` that routes outbound BTP WebSocket connections through a SOCKS5 proxy (e.g., ATOR/Tor),
so that my connector can peer through `.anon` hidden services without exposing its real IP, while guaranteeing fail-closed behavior (never silently falls back to direct) and DNS-leak prevention (`socks5h://` only).

**Epic:** 35 -- ATOR Overlay Transport for Privacy-Enabled Peering
**Priority:** P0 (foundational -- stories 35.4, 35.5, 35.6 all depend on this)
**Estimated effort:** 3 points (~1-2 dev days)
**Dependencies:** Story 35.1 (TransportProvider interface + DirectTransportProvider) -- done

## Acceptance Criteria

### AC 1: `createAgent(peerUrl)` returns a `SocksProxyAgent` configured with the `socks5h://` proxy URL (T-35.2-01)

```gherkin
Scenario: createAgent returns a SocksProxyAgent configured with the configured socks5h:// proxy
  Given a SocksTransportProvider constructed with socksProxy "socks5h://127.0.0.1:9050"
  When createAgent("wss://peer.anon/btp") is called
  Then the returned value is an instance of SocksProxyAgent
  And the agent's proxy URL is "socks5h://127.0.0.1:9050"
  And the agent is compatible with the `ws` WebSocket library's `agent` option
```

### AC 2: `getExternalUrl()` returns the configured `.anon` hidden service URL (T-35.2-02)

```gherkin
Scenario: getExternalUrl returns the configured hidden service URL
  Given a SocksTransportProvider constructed with externalUrl "wss://testabcdef123456.anon/btp"
  When getExternalUrl() is called
  Then "wss://testabcdef123456.anon/btp" is returned
```

### AC 3: Constructor rejects `socks5://` scheme (DNS leak prevention, defense-in-depth) (T-35.2-05, T-35.6-SEC-03)

```gherkin
Scenario: Constructor rejects proxy URL without the 'h' suffix
  Given a socksProxy value of "socks5://127.0.0.1:9050" (no 'h')
  When new SocksTransportProvider({ socksProxy, externalUrl }) is invoked
  Then the constructor throws an Error
  And the error message requires "socks5h://" scheme
  And the error message explains DNS leak prevention as the reason
```

```gherkin
Scenario: Constructor rejects any scheme other than socks5h
  Given a socksProxy value such as "http://127.0.0.1:9050" or "socks4://127.0.0.1:9050"
  When the constructor runs
  Then an Error is thrown requiring the socks5h:// scheme
```

### AC 4: `start()` throws when SOCKS5 proxy is unreachable -- FAIL CLOSED (T-35.2-03, T-35.6-SEC-02)

```gherkin
Scenario: Startup connectivity probe fails when proxy is down
  Given a SocksTransportProvider configured with an unreachable SOCKS5 proxy address
  When start() is called
  Then start() rejects with an Error
  And the error message indicates SOCKS5 proxy connectivity failure
  And the error message includes the proxy host:port
  And no silent fallback to direct connections occurs
```

### AC 5: `start()` resolves when SOCKS5 proxy is reachable (T-35.2-09)

```gherkin
Scenario: Startup succeeds when proxy is reachable
  Given a SocksTransportProvider configured with a reachable SOCKS5 proxy address
  When start() is called
  Then start() resolves without error
  And an INFO log is emitted (without the .anon externalUrl in structured fields)
```

### AC 6: `healthCheck()` returns true when proxy is reachable, false when unreachable (T-35.2-04, T-35.2-07)

```gherkin
Scenario: healthCheck reports healthy when proxy is up
  Given a SocksTransportProvider with a reachable SOCKS5 proxy
  When healthCheck() is called
  Then it resolves to true

Scenario: healthCheck reports unhealthy when proxy is down
  Given a SocksTransportProvider whose SOCKS5 proxy has become unreachable after start
  When healthCheck() is called
  Then it resolves to false
  And it does NOT throw (health checks must be non-throwing)
```

### AC 7: `stop()` is a safe no-op when not managed (T-35.2-08)

```gherkin
Scenario: stop() is a clean no-op in non-managed mode
  Given a SocksTransportProvider constructed without a managed anon client (default)
  When stop() is called
  Then it resolves immediately without error
  And no proxy lifecycle operation is performed (external proxy, not managed here)
```

### AC 8: `SocksTransportProvider` implements the `TransportProvider` interface (T-35.2-10)

```gherkin
Scenario: SocksTransportProvider satisfies the TransportProvider contract
  Given the SocksTransportProvider class
  When it is assigned to a TransportProvider typed variable
  Then TypeScript compilation succeeds
  And all five interface methods are present: createAgent, getExternalUrl, start, stop, healthCheck
```

### AC 9: `createAgent()` succeeds even when the proxy is down (T-35.2-11, T-35.2-06)

```gherkin
Scenario: Agent creation is synchronous and does not probe the network
  Given a SocksTransportProvider whose SOCKS5 proxy is currently unreachable
  When createAgent("wss://peer.anon/btp") is called
  Then a SocksProxyAgent is returned without throwing
  And the actual failure surfaces only when the socket connect is attempted (via `ws`)

Scenario: createAgent returns a fresh agent per call
  Given a SocksTransportProvider
  When createAgent() is called twice with the same peerUrl
  Then two distinct agent instances are returned (not shared)
  And this matches how `ws` expects per-connection agents
```

### AC 10: `.anon` addresses MUST NOT appear in structured INFO/WARN/ERROR/FATAL log fields (T-35.6-SEC-05)

```gherkin
Scenario: .anon hidden service addresses are not logged at INFO or above
  Given a SocksTransportProvider with externalUrl "wss://testabcdef123456.anon/btp"
  When the provider's lifecycle methods (start, healthCheck, stop) execute normally and on error
  Then no log call at level INFO, WARN, ERROR, or FATAL contains the substring ".anon"
  And DEBUG/TRACE level logs MAY contain .anon addresses (developer diagnostic only)
```

### AC 11: Zero regression -- existing tests pass (T-REG-01..08)

```gherkin
Scenario: No behavioral change to the existing connector code
  Given the new transport/socks-transport-provider.ts with its test file
  When `make test` (or `npm run test:unit`) is run
  Then all existing tests pass unchanged (0 regressions)
  And no existing file outside packages/connector/src/transport/ is modified in this story
  And the connector package still builds, lints, and formats cleanly
```

## Tasks / Subtasks

- [x] Task 1: Add `socks-proxy-agent` dependency (AC: #1, #9)
  - [x] 1.1: Add `socks-proxy-agent` (pin to `^8.x` -- latest stable compatible with Node >= 22) to `packages/connector/package.json` dependencies
  - [x] 1.2: Run `npm install` at repo root to update `package-lock.json`
  - [x] 1.3: Verify `socks-proxy-agent` version in `node_modules` and confirm TypeScript types are included
  - [x] 1.4: Do NOT add `@anyone-protocol/anyone-client` (that is Story 35.5)

- [x] Task 2: Create `SocksTransportProvider` class (AC: #1, #2, #3, #4, #5, #6, #7, #8, #9, #10)
  - [x] 2.1: Create `packages/connector/src/transport/socks-transport-provider.ts`
  - [x] 2.2: Define `SocksTransportProviderOptions` interface with fields: `socksProxy: string`, `externalUrl: string`, `logger: pino.Logger`
  - [x] 2.3: Implement constructor:
    - Validate `socksProxy` starts with `socks5h://` -- throw `Error` with descriptive message citing DNS leak prevention and requiring `socks5h://`. Message should NOT include the `.anon` externalUrl.
    - Validate `externalUrl` is non-empty
    - Store fields in `private readonly` properties (`_socksProxy`, `_externalUrl`, `_logger`)
    - Do NOT pre-create a shared `SocksProxyAgent` here -- `createAgent()` builds a fresh instance per call (see 2.4 and AC #9)
    - Create child logger via `logger.child({ component: 'socks-transport-provider' })`
  - [x] 2.4: `createAgent(peerUrl: string): http.Agent`
    - Return a **new** `SocksProxyAgent(this._socksProxy)` per call (AC #9 -- fresh agent per call, matches Story 35.1 contract which returns per-peer agents)
    - Do NOT probe the network; this is synchronous and must not throw for a down proxy
    - Do NOT log the peerUrl at INFO (may contain `.anon`) -- DEBUG only
  - [x] 2.5: `getExternalUrl(): string` -- returns stored externalUrl
  - [x] 2.6: `async start(): Promise<void>`
    - Parse proxy URL; extract host + port
    - Probe TCP connectivity via `net.createConnection({ host, port })` with a short timeout (~2000ms)
    - On failure: throw `Error('SocksTransportProvider: SOCKS5 proxy unreachable at ${host}:${port}')` -- FAIL CLOSED
    - On success: close the probe socket, store a private `_started = true` flag
    - Log `logger.info({ event: 'socks_transport_started', proxyHost: host, proxyPort: port }, 'SOCKS5 transport started')` -- DO NOT include externalUrl here
  - [x] 2.7: `async stop(): Promise<void>`
    - No-op in non-managed mode; clear `_started = false`
    - Log `logger.info({ event: 'socks_transport_stopped' }, 'SOCKS5 transport stopped')`
  - [x] 2.8: `async healthCheck(): Promise<boolean>`
    - Probe TCP connectivity to proxy host:port with short timeout (~1000ms)
    - Return `true` on success, `false` on failure (NEVER throw)
    - Do not log at INFO when proxy is healthy (avoid noise); log at DEBUG
    - On failure: `logger.warn({ event: 'socks_transport_health_failed', proxyHost, proxyPort }, 'SOCKS5 proxy health check failed')` -- NO externalUrl

- [x] Task 3: Add TCP probe helper (AC: #4, #5, #6)
  - [x] 3.1: Create an internal private method `_probeProxy(timeoutMs: number): Promise<void>` inside the class (or a helper function in the same file)
  - [x] 3.2: Use `net.createConnection({ host, port })` from Node's `net` module; set `setTimeout(timeoutMs)`; resolve on `connect`; reject on `error` / `timeout`; always `destroy()` the socket after
  - [x] 3.3: This probe is for connectivity only -- do NOT attempt SOCKS5 handshake (the probe verifies the proxy port is listening, not its SOCKS semantics)

- [x] Task 4: Update transport barrel exports (AC: #8)
  - [x] 4.1: Update `packages/connector/src/transport/index.ts` to re-export `SocksTransportProvider` (class) and `SocksTransportProviderOptions` (type)
  - [x] 4.2: Keep existing `TransportProvider` and `DirectTransportProvider` exports

- [x] Task 5: Write unit tests (AC: #1-#10)
  - [x] 5.1: Create `packages/connector/src/transport/socks-transport-provider.test.ts`
  - [x] 5.2: Use `pino({ level: 'silent' })` with `jest.spyOn` on methods (project convention). Mock `.child()` to return the same logger instance.
  - [x] 5.3: Test constructor rejects `socks5://` with descriptive error (T-35.2-05)
  - [x] 5.4: Test constructor rejects other schemes (`http://`, `socks4://`, empty, `"not a url"`)
  - [x] 5.5: Test constructor accepts `socks5h://` with valid host:port
  - [x] 5.6: Test `createAgent()` returns a `SocksProxyAgent` instance (T-35.2-01)
    - Assert the returned agent is an instance of `SocksProxyAgent` (use `import { SocksProxyAgent } from 'socks-proxy-agent'`)
    - Assert the agent's `proxy` property reflects `socks5h://127.0.0.1:9050`
  - [x] 5.7: Test `createAgent()` returns a new instance per call (T-35.2-06)
  - [x] 5.8: Test `createAgent()` does not throw when proxy is down (T-35.2-11) -- just check no throw; actual network I/O does not happen
  - [x] 5.9: Test `getExternalUrl()` returns configured URL (T-35.2-02)
  - [x] 5.10: Test `start()` resolves when probe succeeds (T-35.2-09)
    - Use a real TCP server on `127.0.0.1` with a dynamic port (via `net.createServer().listen(0)`) to simulate a reachable proxy. Close it after test.
  - [x] 5.11: Test `start()` throws when proxy is unreachable (T-35.2-03)
    - Use a port that is definitely closed (e.g., bind a server, get its port, close it, then use that port)
    - Assert error message contains "SOCKS5 proxy unreachable" and host:port
  - [x] 5.12: Test `healthCheck()` returns true when proxy reachable (T-35.2-07) -- same approach as 5.10
  - [x] 5.13: Test `healthCheck()` returns false (does NOT throw) when proxy unreachable (T-35.2-04)
  - [x] 5.14: Test `stop()` resolves without error (T-35.2-08)
  - [x] 5.15: Test TypeScript interface compliance (T-35.2-10)
    - `const _check: TransportProvider = new SocksTransportProvider({ socksProxy: 'socks5h://127.0.0.1:9050', externalUrl: 'wss://test.anon/btp', logger })`
  - [x] 5.16: Test `.anon` log audit (T-35.6-SEC-05) **IN THIS STORY** (portion applicable to this provider)
    - Spy on `logger.info`, `logger.warn`, `logger.error`, `logger.fatal`
    - Exercise constructor, `start()` (both success and failure paths), `createAgent(.anonUrl)`, `healthCheck()` (both paths), `stop()`
    - For every spied call, inspect the first argument (structured fields) and the second argument (message string); assert that JSON-stringified call arguments do not contain the substring `".anon"`
    - DEBUG-level audits are NOT checked (DEBUG may contain `.anon`)
  - [x] 5.17: Ensure test file is wrapped with `describe('SocksTransportProvider (Story 35.2)', ...)` per codebase convention

- [x] Task 6: Verify zero regression and code quality (AC: #11)
  - [x] 6.1: Run `npm run build` -- compiles cleanly from `packages/shared` through `packages/connector`
  - [x] 6.2: Run `make test` (or `npm run test:unit`) -- all existing + new tests pass
  - [x] 6.3: Run `make lint` -- no ESLint errors (including no `console.log`, no `any`, no unused vars)
  - [x] 6.4: Run `npm run format:check` -- Prettier clean
  - [x] 6.5: Confirm no files outside `packages/connector/src/transport/` and `packages/connector/package.json` are modified in this story

## Dev Notes

### Architecture Context

Story 35.2 adds the second implementation of the `TransportProvider` interface defined in Story 35.1. `SocksTransportProvider` routes all outbound BTP WebSocket connections through a SOCKS5 proxy. The actual wiring into `ConnectorNode` and the BTP client happens in Story 35.4 -- this story only delivers the provider class, its unit tests, and the `socks-proxy-agent` dependency.

**Separation of concerns:** This story does NOT manage the `anon` binary lifecycle (Story 35.5) and does NOT modify config schemas (Story 35.3) or `ConnectorNode` (Story 35.4). It assumes an externally running SOCKS5 proxy (e.g., system Tor or `anon` started manually).

### Critical Security Invariants (MUST NOT VIOLATE)

These are the load-bearing safety rules from `_bmad-output/project-context.md#Critical Rules` and `epic-35#Critical Implementation Rules`:

| Invariant | How this story enforces it |
|---|---|
| **`socks5h://` scheme required** (DNS leak prevention) | Constructor rejects any other scheme with descriptive error. Defense-in-depth alongside config validation in Story 35.3. |
| **Fail closed, never fail open** | `start()` probes the proxy and throws on failure. No silent fallback logic anywhere in this class. |
| **Never log `.anon` at INFO+** | All `logger.info/warn/error/fatal` calls use only `proxyHost`, `proxyPort`, and other non-sensitive fields. `externalUrl` is stored but NOT logged at INFO+. `peerUrl` passed to `createAgent()` is NOT logged at INFO+. |
| **Fresh agent per call** | `createAgent()` returns a new `SocksProxyAgent` each invocation so per-connection state does not leak between peers. |

### TCP Probe Approach

The `start()` and `healthCheck()` methods probe the SOCKS5 proxy via a raw TCP connect. We do NOT perform a full SOCKS5 handshake because:

1. The probe only needs to verify the proxy process is listening on the configured port.
2. A full SOCKS5 handshake would require choosing a target host, which introduces complexity and could itself leak metadata.
3. If the port is open but SOCKS5 negotiation fails, the real WebSocket connect will surface the error with correct semantics -- the fail-closed contract still holds.

**Timeout:** 2000ms for `start()` (one-shot startup validation), 1000ms for `healthCheck()` (called periodically; must be snappy).

### Expected `SocksProxyAgent` API (socks-proxy-agent v8+)

```typescript
import { SocksProxyAgent } from 'socks-proxy-agent';

const agent = new SocksProxyAgent('socks5h://127.0.0.1:9050');
// agent is an http.Agent subclass
// Pass directly to `ws` constructor: new WebSocket(url, { agent })
```

- The package exports a named `SocksProxyAgent` class (NOT default export).
- The constructor accepts a URL string or a URL object. String form is simplest.
- `socks-proxy-agent` v8+ is the current major; check `npm view socks-proxy-agent version` before pinning. Use `^8.x` or the latest stable major.
- TypeScript types ship with the package -- no `@types/socks-proxy-agent` needed.

### Constructor Input Shape

```typescript
export interface SocksTransportProviderOptions {
  /** SOCKS5 proxy URL. Must start with "socks5h://". DNS leak prevention. */
  socksProxy: string;
  /** This node's externally reachable URL for inbound peering (typically ws://<hidden>.anon/btp). */
  externalUrl: string;
  /** Pino logger -- a child logger with component="socks-transport-provider" will be created internally. */
  logger: pino.Logger;
}
```

Rationale for options object (vs positional args): matches `SolanaPaymentChannelProvider` / `MinaPaymentChannelProvider` constructor patterns in the codebase. Named params improve readability when more fields are added in Story 35.4 (e.g., probe timeouts).

### Log Audit Test (T-35.6-SEC-05 partial)

Epic 35 assigns the full `.anon`-logging audit to Story 35.6 as an integration test, but we seed the audit here at the provider level because the transport provider is where the risk lives. Concretely:

```typescript
const calls: string[] = [];
const spyInfo = jest.spyOn(logger, 'info').mockImplementation((...args) => calls.push(JSON.stringify(args)));
// ... same for warn, error, fatal
// exercise provider
// assert:
expect(calls.every((c) => !c.includes('.anon'))).toBe(true);
```

### DirectTransportProvider Consistency

Follow the conventions already established by `DirectTransportProvider`:

- `private readonly _fieldName` (underscore prefix, `readonly`)
- Input validation in constructor with explicit error messages
- `async` keyword on all lifecycle methods (even no-ops), to match interface signature and match codebase style
- JSDoc `@param` / `@returns` tags on every public method (project-context requirement)

### Project Structure Notes

- New file: `packages/connector/src/transport/socks-transport-provider.ts`
- New test: `packages/connector/src/transport/socks-transport-provider.test.ts`
- Barrel update: `packages/connector/src/transport/index.ts`
- `package.json` update: add `socks-proxy-agent` dependency in `packages/connector/package.json`
- Do NOT add to `packages/connector/src/lib.ts` yet -- wiring happens in Story 35.4

### Existing Code Patterns to Follow

- **Interface naming:** no `I` prefix
- **Logger construction:** `this._logger = logger.child({ component: 'socks-transport-provider' })`
- **Pino format:** `logger.info({ event: 'snake_case_name', structuredField: value }, 'Human-readable message')` -- fields FIRST, message SECOND
- **Error messages:** prefix with class name (e.g., `'SocksTransportProvider: SOCKS5 proxy unreachable at 127.0.0.1:9050'`)
- **Test style:** Jest `describe/it`, co-located test file, top-level `describe('ClassName (Story 35.2)', ...)` wrapper
- **Mock logger:** `pino({ level: 'silent' })` with `jest.spyOn` -- NEVER plain `jest.fn()` objects

### What NOT to Do

- Do NOT modify `ConnectorNode` -- that is Story 35.4
- Do NOT modify `BTPClient` / `btp-client.ts` -- that is Story 35.4
- Do NOT add `@anyone-protocol/anyone-client` -- that is Story 35.5
- Do NOT add or modify Zod config schemas -- that is Story 35.3
- Do NOT export from `packages/connector/src/lib.ts` -- that happens in Story 35.4 integration
- Do NOT silently fall back to direct if proxy is down -- this is the cardinal sin of Epic 35
- Do NOT perform a SOCKS5 handshake in the probe -- a TCP connect is sufficient
- Do NOT cache one global `SocksProxyAgent` shared across peers -- return a fresh instance per `createAgent()` call
- Do NOT use `console.log` -- use the injected Pino logger
- Do NOT store or log the peer URL at INFO (peer URLs can be `.anon` addresses)

### Testing Standards

- **Framework:** Jest 29.7.0 + ts-jest
- **Coverage thresholds:** branches 60%, functions 75%, lines 70%, statements 70%
- **Test file location:** Co-located at `packages/connector/src/transport/socks-transport-provider.test.ts`
- **Run tests with:** `npm run test:unit` or `make test`
- **Test IDs from test design:** T-35.2-01 through T-35.2-11, plus T-35.6-SEC-03/04/05 (partial, at provider level)
- **Integration tests** (BTP peering through a real local SOCKS5 proxy) are Story 35.6 -- not in scope here

### Cross-Story Context

- **Story 35.1** (done) -- defined the `TransportProvider` interface; this story delivers its second implementation
- **Story 35.3** (planned) -- Zod config schema that feeds into this provider's constructor options (`socksProxy`, `externalUrl`, `managed`)
- **Story 35.4** (planned) -- `ConnectorNode` will instantiate `SocksTransportProvider` when config `type === 'socks5'` and pass `provider.createAgent(peerUrl)` to the `ws` WebSocket constructor (currently at `btp-client.ts:161`)
- **Story 35.5** (planned) -- optional managed `anon` binary lifecycle; if delivered, `stop()` in this class would need to coordinate shutdown but the current no-op is correct for the MVP (external proxy model)
- **Story 35.6** (planned) -- integration tests that verify the full stack: config load -> provider instantiate -> BTP connect through local SOCKS5 mock -> ILP packet exchange

### Latest Tech Information

- **`socks-proxy-agent`:** current stable major is `v8` (since 2024). v8 exports a named `SocksProxyAgent` class compatible with Node.js `http.Agent` and accepts a URL string directly. v8 shipped ESM-first; CommonJS interop works via standard `import { SocksProxyAgent } from 'socks-proxy-agent'`. Node >= 22 (project minimum) supports this cleanly. Verify the exact version with `npm view socks-proxy-agent version` before pinning (confirmed `v8` or later as of 2026-04).
- **Node.js `net` module:** `net.createConnection({ host, port })` is the standard approach for TCP probes; `setTimeout()` + `once('timeout')` + `destroy()` pattern is idiomatic. Works identically on Node 22 and 24.

### References

- [Source: _bmad-output/planning-artifacts/epic-35-ator-overlay-transport.md#Story 35.2]
- [Source: _bmad-output/planning-artifacts/test-design-epic-35.md#Story 35.2] -- test IDs T-35.2-01 through T-35.2-11
- [Source: _bmad-output/planning-artifacts/test-design-epic-35.md#Security Test Focus Areas] -- DNS leak prevention, fail-closed, `.anon` log audit
- [Source: _bmad-output/project-context.md#ATOR Overlay Transport (Epic 35 — Planned)] -- critical rules
- [Source: _bmad-output/implementation-artifacts/35-1-define-transportprovider-interface-directtransportprovider.md] -- interface contract + style conventions this story must match
- [Source: packages/connector/src/transport/transport-provider.ts] -- interface that `SocksTransportProvider` must implement
- [Source: packages/connector/src/transport/direct-transport-provider.ts] -- reference implementation style (private readonly fields, input validation, async no-ops)
- [Source: packages/connector/src/btp/btp-client.ts:161] -- `new WebSocket(this._peer.url)` call site where Story 35.4 will inject `{ agent: provider.createAgent(url) }`
- [Source: packages/connector/src/settlement/provider/payment-channel-provider.ts] -- options-object constructor pattern to mirror

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context) — claude-opus-4-6[1m]

### Debug Log References

- Unit test suite: `npx jest src/transport/socks-transport-provider.test.ts` → 23/23 pass
- Full connector unit tests: `npm run test:unit` → 2458 pass, 44 skipped, 0 failures (no regressions)
- Build: `npm run build` clean (shared → mina-zkapp → connector → workspaces)
- Lint: `npm run lint` 0 errors (1 pre-existing warning in ATDD-seeded test for unrelated inline arrow return type)
- Format: `npm run format:check` clean after Prettier pass

### Completion Notes List

- **Task 1 (dependency):** Added `socks-proxy-agent: ^8.0.5` to `packages/connector/package.json`. Chose 8.x per story spec (Node >= 22 compatible); npm registry v10 exists but story explicitly pins to ^8.x. Ran `npm install` to update the lockfile. Types ship with the package — no `@types` package needed.
- **Task 2 (provider class):** Created `SocksTransportProvider` implementing the `TransportProvider` interface. Constructor validates (a) `socksProxy` presence, (b) `socks5h://` scheme (DNS-leak message), (c) URL parseability via swap to `http://` (since `new URL('socks5h://...')` omits host), (d) valid host + port range 1-65535, (e) non-empty `externalUrl`. Fields stored as `private readonly _socksProxy`, `_externalUrl`, `_logger`, `_proxyHost`, `_proxyPort`. `createAgent(peerUrl)` returns a fresh `SocksProxyAgent(this._socksProxy)` every call (no shared state) and only emits DEBUG logs (peerUrl may be `.anon`). `start()` performs a 2000 ms raw TCP probe and throws `SocksTransportProvider: SOCKS5 proxy unreachable at host:port (…)` on failure — FAIL CLOSED. `stop()` is a logged no-op. `healthCheck()` uses a 1000 ms probe and returns `false` instead of throwing on failure. All INFO/WARN logs carry only `proxyHost`/`proxyPort` — never `.anon` externalUrl or peerUrl.
- **Task 3 (TCP probe helper):** Implemented `_probeProxy(timeoutMs)` as a private instance method using Node `net.createConnection` + `setTimeout` + `once('connect' | 'timeout' | 'error')`. Always cleans up listeners and destroys the socket. Does not perform a SOCKS5 handshake (connectivity probe only, per story direction).
- **Task 4 (barrel exports):** Updated `packages/connector/src/transport/index.ts` to re-export `SocksTransportProvider` (class) and `SocksTransportProviderOptions` (type) alongside the existing `TransportProvider` and `DirectTransportProvider`.
- **Task 5 (tests):** The ATDD RED-phase test file at `packages/connector/src/transport/socks-transport-provider.test.ts` was pre-seeded for this story; kept as-is. All 23 cases now pass against the new provider, covering T-35.2-01..11 and T-35.6-SEC-02/03/05 (.anon log audit at provider level).
- **Task 6 (verification):** Build, lint, format, and `test:unit` all green. No files modified outside `packages/connector/src/transport/` and `packages/connector/package.json` + lockfile.

### File List

- `packages/connector/package.json` (modified — added `socks-proxy-agent` dependency)
- `package-lock.json` (modified — auto-updated by `npm install`)
- `packages/connector/src/transport/socks-transport-provider.ts` (new)
- `packages/connector/src/transport/socks-transport-provider.test.ts` (new — ATDD seed file, kept verbatim, all tests green)
- `packages/connector/src/transport/index.ts` (modified — added `SocksTransportProvider` exports)

### Change Log

| Date       | Version | Description                                                              | Author   |
| ---------- | ------- | ------------------------------------------------------------------------ | -------- |
| 2026-04-13 | 0.1     | Story drafted from Epic 35 spec and test design                          | SM       |
| 2026-04-13 | 0.2     | Adversarial review: clarified constructor (no pre-created shared agent)  | SM       |
| 2026-04-13 | 1.0     | Dev story complete — implemented `SocksTransportProvider` with socks5h-only validation, fail-closed startup probe, per-call fresh agents, `.anon`-safe logging. All 23 unit tests pass; zero regressions across the 2458-test unit suite. | Dev (Opus 4.6) |

## Code Review Record

### Review Pass #1

- **Date:** 2026-04-13
- **Reviewer Model:** Claude Opus 4.6 (1M context) — claude-opus-4-6[1m]
- **Outcome:** Approved with minor fixes (no blocking issues)
- **Issue Counts by Severity:**
  - Critical: 0
  - High: 0
  - Medium: 0
  - Low: 2 found / 1 fixed
- **Notes:**
  - **L2 (fixed):** Added `@returns` JSDoc tags on `start()` and `stop()` in `packages/connector/src/transport/socks-transport-provider.ts` to match the project-context requirement that all public methods carry `@param`/`@returns` tags.
  - **L1 (acknowledged, not fixed — task drift):** Suggestion to introduce a `_started` boolean flag tracking lifecycle state was acknowledged but not implemented. There is no acceptance criterion requiring the flag, nothing in the provider currently reads it, and adding it would produce an unused TypeScript variable (TS6133) under the project's `noUnusedLocals` settings. Deferred to a future story if a lifecycle consumer materializes.
- **Action Items:** None — no new Tasks/Subtasks added; L1 acknowledged as drift, L2 already applied in-place.

### Review Pass #2

- **Date:** 2026-04-13
- **Reviewer Model:** Claude Opus 4.6 (1M context) — claude-opus-4-6[1m]
- **Mode:** yolo — automatically fix all critical/high/medium/low issues
- **Outcome:** Approved — no actionable issues found; Status remains `review` pending Pass #3
- **Issue Counts by Severity:**
  - Critical: 0
  - High: 0
  - Medium: 0
  - Low: 2 found / 0 fixed (both cosmetic observations — see notes)
- **Scope of Pass #2:** Adversarial re-review of `packages/connector/src/transport/socks-transport-provider.ts`, its test, the transport barrel, and story claims vs. git reality. Deliberately hunted for issues Pass #1 might have missed: TCP probe race conditions, `socket.setTimeout` semantics on unconnected sockets, IPv6 handling, URL parsing edge cases, promise-executor error paths, log-audit completeness (including `fatal` path), `createAgent` input validation, and dependency pinning.
- **AC Coverage:** All 11 ACs verified against implementation + tests. 23/23 provider unit tests green; full unit suite green (no regressions).
- **Git vs Story File List:** Matches. Only unstaged changes at review start were Pass #1's `@returns` additions and the story doc itself — both expected.
- **Notes (observations NOT fixed):**
  - **L1 (defensible — not fixed):** `stop()` emits an INFO `socks_transport_stopped` log even when `start()` was never called. This is mildly noisy but not incorrect — BTP/connector shutdown may call `stop()` on partially-constructed providers, and an always-logged stop is a reasonable lifecycle signal. Adding guard state would re-open the `_started` flag question that Pass #1 already correctly deferred (TS `noUnusedLocals` + no consumer).
  - **L2 (defensible — not fixed):** The `start()` failure message format `SocksTransportProvider: SOCKS5 proxy unreachable at host:port (<inner>)` includes the inner probe error (e.g., `connect ECONNREFUSED`). This is mildly redundant with the "unreachable" wording but aids debugging without leaking sensitive data (host:port is already in the prefix; inner message is a standard Node errno). Tests explicitly assert the prefix format.
- **Verified non-issues (pass #2 hunted, found clean):**
  - `socket.setTimeout(timeoutMs)` on an unconnected socket: Node fires 'timeout' after `timeoutMs` of inactivity including the pre-connect phase, so the probe honors the bound. Safe.
  - `net.createConnection` synchronous error path: Node emits `error` asynchronously via `process.nextTick`, so listener registration order is safe.
  - Promise executor exception path: standard `new Promise((resolve,reject) => ...)` auto-rejects on throw; no leak.
  - IPv6 host parsing: `new URL('http://[::1]:9050')` yields hostname `::1` (bracket-stripped), which `net.createConnection({ host, port })` accepts.
  - `removeAllListeners()` + `destroy()` ordering in `cleanup`: no post-settle emission races given the `settled` guard.
  - Log audit: `child()` is mocked to return the same logger so spies on `info/warn/error/fatal` capture everything; `fatal` is defensively covered even though no code path emits it.
  - Dependency pinning: `socks-proxy-agent: ^8.0.5` — matches story spec, Node >= 22 compatible.
- **Action Items:** None. Leaving Status as `review` pending Code Review Pass #3.

### Review Pass #3 (Final)

- **Date:** 2026-04-13
- **Reviewer Model:** Claude Opus 4.6 (1M context) — claude-opus-4-6[1m]
- **Mode:** yolo — automatically fix all critical/high/medium/low issues
- **Scope:** Final (third of three) adversarial pass. OWASP Top 10 sweep, authn/authz review, injection-risk review, plus re-hunt for anything Pass #1 and Pass #2 might have missed.
- **Tooling:** `mcp__plugin_semgrep_semgrep__semgrep_scan` across `socks-transport-provider.ts`, `socks-transport-provider.test.ts`, and `transport/index.ts` — **0 findings**.
- **Outcome:** Approved — zero actionable issues. Per task instructions, Status remains `review` (artifact verify step will transition to `done`).
- **Issue Counts by Severity:**
  - Critical: 0 found / 0 fixed
  - High: 0 found / 0 fixed
  - Medium: 0 found / 0 fixed
  - Low: 0 found / 0 fixed
- **OWASP Top 10 review:**
  - A01 Broken Access Control — N/A (provider has no access-controlled surfaces).
  - A02 Cryptographic/Privacy Failures — `socks5h://`-only enforcement guards against local DNS leakage; validated in constructor with descriptive error. Clean.
  - A03 Injection — No SQL/command/log-injection surfaces. `peerUrl` is only passed to `SocksProxyAgent` (URL-parsed by the library) and to Pino structured logging at DEBUG (pino escapes JSON, not concatenated). Error strings use template literals driven by parsed, validated config. Clean.
  - A04 Insecure Design — Fail-closed start() is explicit; no silent fallback path anywhere in the class. Clean.
  - A05 Security Misconfiguration — Constructor validates scheme, host, and port range (1–65535); rejects `socks5://`, `http://`, `socks4://`, empty, and non-URL strings. Clean.
  - A06 Vulnerable/Outdated Components — `socks-proxy-agent: ^8.0.5` is the current stable major; types ship in-package; Node 22+ compatible. Clean.
  - A07 Identification & Authentication — Not an auth surface; SOCKS auth (if any) is delegated to the upstream library. Clean.
  - A08 Software/Data Integrity — N/A.
  - A09 Logging & Monitoring Failures — `.anon`-log audit (AC #10) covers happy + sad + constructor-error paths and spies info/warn/error/fatal. DEBUG exemption is per spec. Clean.
  - A10 SSRF — `socksProxy` is operator-controlled config, not user input; no user-controllable URL reaches `net.createConnection`. Clean.
- **Injection-risk deep dive:** No shell/subprocess/SQL/OS calls. Error messages and log fields are typed primitives (`string`, `number`). `peerUrl` is inert in `createAgent` (not embedded in the agent itself). Clean.
- **Authz/authn deep dive:** No authn/authz decisions are made by this class. Trust boundary is entirely at the config layer (Story 35.3) and at the OS-level proxy, which is the correct seam.
- **Fresh adversarial hunts (all negative):**
  - **Scheme bypass via parse-swap:** The `socks5h://` → `http://` replacement is applied only AFTER `startsWith('socks5h://')` check, and the original `socksProxy` string (with `socks5h://`) is what `SocksProxyAgent` receives. No bypass possible.
  - **Port boundary:** `port <= 0 || port > 65535` correctly rejects 0, negatives, and overflow; `NaN` (absent port) is also rejected via `!Number.isFinite(port)`.
  - **`createAgent(peerUrl)` parameter usage:** `peerUrl` is intentionally not used to construct the agent (fresh agent per AC #9 uses the shared `socksProxy` only). This matches Story 35.1 contract and is covered by T-35.2-01 and T-35.2-06.
  - **Error message leakage:** `start()` error includes the inner probe error (e.g., `connect ECONNREFUSED`) but never leaks the `.anon` externalUrl or peerUrl. Host:port is already non-sensitive operator config.
  - **Probe socket lifecycle:** `settled` guard + `removeAllListeners()` + `destroy()` — no post-settle emission races (re-verified from Pass #2).
  - **DEBUG-level `.anon` policy:** Matches AC #10 and epic-level security test design exactly.
- **AC Coverage:** All 11 ACs pass — 23/23 unit tests green (`npx jest socks-transport-provider.test.ts`).
- **Git vs Story File List:** Matches. Uncommitted changes at review start are the Pass #1 `@returns` JSDoc additions and the story doc itself — expected.
- **Fixed in Pass #3:** None (nothing actionable to fix).
- **Action Items:** None. Status left at `review` per task instructions; artifact verify step owns the `done` transition.
