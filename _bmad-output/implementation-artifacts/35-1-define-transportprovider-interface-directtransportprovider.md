# Story 35.1: Define TransportProvider Interface + DirectTransportProvider

Status: done

## Story

As a connector operator,
I want the connector to have a pluggable transport abstraction layer,
so that outbound BTP connections can be routed through different transports (direct TCP or SOCKS5/ATOR overlay) without changing the ILP/BTP protocol logic.

**Epic:** 35 -- ATOR Overlay Transport for Privacy-Enabled Peering
**Priority:** P0 (foundational interface -- all other Epic 35 stories depend on this)
**Estimated effort:** 3 points (~1-2 dev days)
**Dependencies:** None (first story in the epic; transport layer is orthogonal to settlement Epics 32-34)

## Acceptance Criteria

### AC 1: TransportProvider Interface Compiles With All Required Methods

```gherkin
Scenario: TransportProvider interface enforces the full method contract
  Given the TransportProvider interface is defined in transport-provider.ts
  When a class implements TransportProvider
  Then it must provide: createAgent, getExternalUrl, start, stop, healthCheck
  And createAgent returns http.Agent | undefined
  And getExternalUrl returns string
  And start/stop return Promise<void>
  And healthCheck returns Promise<boolean>
```

### AC 2: DirectTransportProvider.createAgent() Returns undefined

```gherkin
Scenario: createAgent returns undefined for any peer URL
  Given a DirectTransportProvider instance
  When createAgent() is called with any peer URL string
  Then undefined is returned (instructs ws library to use default Node.js HTTP agent)
```

### AC 3: DirectTransportProvider.healthCheck() Returns true

```gherkin
Scenario: healthCheck always reports healthy for direct connections
  Given a DirectTransportProvider instance
  When healthCheck() is called
  Then it resolves to true (direct connections are always "healthy")
```

### AC 4: DirectTransportProvider.start() and stop() Are No-Ops

```gherkin
Scenario: Lifecycle methods resolve immediately
  Given a DirectTransportProvider instance
  When start() is called
  Then it resolves immediately without error
  When stop() is called
  Then it resolves immediately without error
```

### AC 5: DirectTransportProvider.getExternalUrl() Returns Configured URL

```gherkin
Scenario: getExternalUrl returns the constructor-provided URL
  Given a DirectTransportProvider constructed with "ws://mynode:3000/btp"
  When getExternalUrl() is called
  Then "ws://mynode:3000/btp" is returned
```

### AC 6: Zero Regression -- All Existing Tests Pass

```gherkin
Scenario: No behavioral change to existing connector code
  Given the new transport directory with DirectTransportProvider
  When the existing test suite is run (make test)
  Then all tests pass with zero behavioral change
  And no existing files are modified in this story
```

## Tasks / Subtasks

- [x] Task 1: Create TransportProvider interface (AC: #1)
  - [x] 1.1: Create `packages/connector/src/transport/transport-provider.ts` with interface definition
  - [x] 1.2: Use `import type http from 'http'` for the `http.Agent` return type (type-only import -- strict mode compliant)
  - [x] 1.3: Add JSDoc comments for each method explaining contract

- [x] Task 2: Implement DirectTransportProvider (AC: #2, #3, #4, #5)
  - [x] 2.1: Create `packages/connector/src/transport/direct-transport-provider.ts`
  - [x] 2.2: Constructor accepts `externalUrl: string` parameter
  - [x] 2.3: `createAgent()` returns `undefined`
  - [x] 2.4: `getExternalUrl()` returns the constructor-provided URL
  - [x] 2.5: `start()` / `stop()` are async no-ops
  - [x] 2.6: `healthCheck()` always returns `Promise<true>`

- [x] Task 3: Create barrel exports (AC: #1)
  - [x] 3.1: Create `packages/connector/src/transport/index.ts`
  - [x] 3.2: Re-export `TransportProvider` interface and `DirectTransportProvider` class

- [x] Task 4: Write unit tests (AC: #1-#5)
  - [x] 4.1: Create `packages/connector/src/transport/direct-transport-provider.test.ts`
  - [x] 4.2: Test `createAgent()` returns `undefined` for any URL (T-35.1-02)
  - [x] 4.3: Test `getExternalUrl()` returns configured URL (T-35.1-03)
  - [x] 4.4: Test `healthCheck()` returns `true` (T-35.1-04)
  - [x] 4.5: Test `start()` resolves without error (T-35.1-05)
  - [x] 4.6: Test `stop()` resolves without error (T-35.1-06)
  - [x] 4.7: Test TypeScript compilation -- `const _check: TransportProvider = new DirectTransportProvider('ws://test')` compiles without error (T-35.1-07)

- [x] Task 5: Verify zero regression (AC: #6)
  - [x] 5.1: Run `make test` -- all existing tests pass (165 tests, 0 failures)
  - [x] 5.2: Run `make lint` -- no linting errors
  - [x] 5.3: Run `npm run format:check` -- formatting passes

## Dev Notes

### Architecture Context

This story is the foundation for Epic 35 (ATOR Overlay Transport). The `TransportProvider` interface is a new abstraction layer that sits below BTP/WebSocket and above raw TCP. It enables the connector to route outbound connections through different transports (direct or SOCKS5 proxy) without changing any ILP or BTP logic.

**Key architectural principle:** Transport is orthogonal to settlement. The transport layer does not interact with the chain abstraction layer (Epic 32), Solana provider (Epic 33), or Mina provider (Epic 34). It only affects how BTP WebSocket connections are established.

### TransportProvider Interface Contract

```typescript
import type http from 'http';

export interface TransportProvider {
  /**
   * Create an HTTP agent for outbound WebSocket connections to a peer.
   * DirectTransportProvider returns undefined (use Node.js default agent).
   * SocksTransportProvider (Story 35.2) returns a SocksProxyAgent.
   *
   * The returned agent is passed to the `ws` WebSocket constructor's `agent` option.
   * When undefined, `ws` uses its default connection behavior.
   */
  createAgent(peerUrl: string): http.Agent | undefined;

  /**
   * Get this node's externally reachable URL for inbound peering.
   * For direct transport, this is the configured public URL (e.g., "ws://mynode:3000/btp").
   * For SOCKS5 transport, this is the .anon hidden service URL.
   */
  getExternalUrl(): string;

  /**
   * Initialize the transport provider. Called during connector startup.
   * DirectTransportProvider: no-op.
   * SocksTransportProvider: validates proxy connectivity.
   */
  start(): Promise<void>;

  /**
   * Shut down the transport provider. Called during connector shutdown.
   * DirectTransportProvider: no-op.
   * SocksTransportProvider: no-op (unless managed).
   */
  stop(): Promise<void>;

  /**
   * Check transport health. Used by the health endpoint.
   * DirectTransportProvider: always returns true.
   * SocksTransportProvider: probes SOCKS5 proxy connectivity.
   */
  healthCheck(): Promise<boolean>;
}
```

### DirectTransportProvider Implementation

`DirectTransportProvider` is intentionally trivial. It wraps the current "do nothing special" behavior behind the interface so that `ConnectorNode` (Story 35.4) can uniformly interact with any transport provider.

```typescript
import type http from 'http';

export class DirectTransportProvider implements TransportProvider {
  private readonly externalUrl: string;

  constructor(externalUrl: string) {
    this.externalUrl = externalUrl;
  }

  createAgent(_peerUrl: string): http.Agent | undefined {
    return undefined; // Use default Node.js agent
  }

  getExternalUrl(): string {
    return this.externalUrl;
  }

  async start(): Promise<void> {
    // No-op for direct connections
  }

  async stop(): Promise<void> {
    // No-op for direct connections
  }

  async healthCheck(): Promise<boolean> {
    return true; // Direct connections are always "healthy"
  }
}
```

### Project Structure Notes

- New directory: `packages/connector/src/transport/`
- This directory is already listed in the project structure (see `project-context.md`) as the intended location for Epic 35 transport code
- File naming follows existing codebase conventions: kebab-case filenames, `.test.ts` suffix for tests co-located with source
- Barrel export pattern matches other modules (e.g., `packages/connector/src/settlement/provider/index.ts`)

### Existing Code Patterns to Follow

- **Interface naming:** No `I` prefix (matches `PaymentChannelProvider` in `settlement/provider/payment-channel-provider.ts`)
- **Async methods:** Use `async` keyword even for no-ops (consistent with `PaymentChannelProvider.start()/stop()`)
- **Logger:** Not needed for DirectTransportProvider (no meaningful operations to log). SocksTransportProvider (Story 35.2) will need a Pino logger.
- **Test style:** Jest with `describe`/`it` blocks, matching existing test patterns in `src/btp/btp-client.test.ts` and `src/core/connector-node.test.ts`
- **TypeScript config:** Strict mode enabled, ES2022 target, CommonJS modules -- no special compiler flags needed for this story (no decorators)

### What NOT to Do

- Do NOT modify `ConnectorNode` in this story -- that happens in Story 35.4
- Do NOT modify BTP client in this story -- that happens in Story 35.4
- Do NOT add `socks-proxy-agent` or `@anyone-protocol/anyone-client` dependencies -- those are Story 35.2 and 35.5
- Do NOT modify config schemas -- that is Story 35.3
- Do NOT add the transport directory to `lib.ts` exports yet -- that happens when integration is wired up in Story 35.4
- Do NOT create files for SocksTransportProvider -- that is Story 35.2

### Testing Standards

- **Framework:** Jest 29.7.0 + ts-jest
- **Coverage thresholds:** branches 60%, functions 75%, lines 70%, statements 70%
- **Test file location:** Co-located at `packages/connector/src/transport/direct-transport-provider.test.ts`
- **Run tests with:** `npm run test:unit` or `make test`
- **Test IDs from test design:** T-35.1-01 through T-35.1-07 (see `_bmad-output/planning-artifacts/test-design-epic-35.md`)

### Cross-Story Context

- **Story 35.2** will add `SocksTransportProvider` implementing this same interface
- **Story 35.3** will add config schema validation for the `transport` block
- **Story 35.4** will wire `TransportProvider` into `ConnectorNode` and `BTPClient`
- The `createAgent()` return type `http.Agent | undefined` is critical -- when `undefined`, the `ws` library uses its default behavior (no agent). Story 35.4 will only pass the `agent` option to `ws` when non-undefined to preserve backward compatibility.

### References

- [Source: _bmad-output/planning-artifacts/epic-35-ator-overlay-transport.md#Story 35.1]
- [Source: _bmad-output/planning-artifacts/test-design-epic-35.md#Story 35.1]
- [Source: _bmad-output/project-context.md#Project Structure]
- [Source: packages/connector/src/btp/btp-client.ts] -- line 161: `this._ws = new WebSocket(this._peer.url)` -- this is where Story 35.4 will inject the agent
- [Source: packages/connector/src/core/connector-node.ts] -- ConnectorNode lifecycle where transport will be wired in Story 35.4
- [Source: packages/connector/src/settlement/provider/payment-channel-provider.ts] -- Interface pattern to follow (no `I` prefix, async lifecycle methods)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

None -- implementation was clean with no issues.

### Completion Notes List

- **Task 1**: Created `TransportProvider` interface in `transport-provider.ts` with all 5 required methods (`createAgent`, `getExternalUrl`, `start`, `stop`, `healthCheck`), type-only `http` import, and full JSDoc documentation.
- **Task 2**: Implemented `DirectTransportProvider` class with constructor accepting `externalUrl: string`, `createAgent()` returning `undefined`, `getExternalUrl()` returning the constructor URL, async no-op `start()`/`stop()`, and `healthCheck()` always resolving `true`.
- **Task 3**: Created barrel `index.ts` re-exporting `TransportProvider` (type) and `DirectTransportProvider` (class).
- **Task 4**: Created 12 unit tests covering all test IDs (T-35.1-01 through T-35.1-07), including interface compliance, mock implementation contract, multiple URL variations, repeated healthCheck calls, and start/stop lifecycle safety.
- **Task 5**: Verified zero regression -- 165 tests pass, lint clean, formatting clean.

### File List

- `packages/connector/src/transport/transport-provider.ts` -- created (TransportProvider interface)
- `packages/connector/src/transport/direct-transport-provider.ts` -- created (DirectTransportProvider class)
- `packages/connector/src/transport/index.ts` -- created (barrel exports)
- `packages/connector/src/transport/direct-transport-provider.test.ts` -- created (13 unit tests)

### Change Log

| Date       | Summary                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------- |
| 2026-04-13 | Story 35.1 validated complete: all 4 transport files in place, 12/12 tests pass, zero regression |
| 2026-04-13 | Code review pass #2: 0 critical, 0 high, 0 medium, 4 low issues found and fixed; 13/13 tests pass |

## Code Review Record

### Review Pass #1

| Field             | Value                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------- |
| **Date**          | 2026-04-13                                                                                    |
| **Reviewer Model**| Claude Opus 4.6 (1M context)                                                                  |
| **Issues Found**  | 0 critical, 0 high, 1 medium (private field naming convention), 4 low (missing JSDoc headers, barrel export style) |
| **All Fixed?**    | Yes -- all 5 issues resolved                                                                  |
| **Outcome**       | Pass                                                                                          |

### Review Pass #2

| Field             | Value                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------- |
| **Date**          | 2026-04-13                                                                                    |
| **Reviewer Model**| Claude Opus 4.6 (1M context)                                                                  |
| **Issues Found**  | 0 critical, 0 high, 0 medium, 4 low                                                          |
| **All Fixed?**    | Yes -- all 4 issues resolved                                                                  |
| **Outcome**       | Pass                                                                                          |

**Low Issues Found & Fixed:**

1. **Missing `@param`/`@returns` JSDoc tags on TransportProvider interface** -- project-context.md requires these on public APIs; added to all 5 methods.
2. **Missing `@param`/`@returns` JSDoc tags on DirectTransportProvider** -- added constructor `@param` and inline `@returns` on all methods to match interface documentation.
3. **No constructor input validation** -- `EVMPaymentChannelProvider` validates constructor args (throws on empty); added same guard to `DirectTransportProvider` with descriptive error message and corresponding test.
4. **Test file lacks top-level describe with story ID** -- codebase convention uses `describe('Feature (Story X.Y)', ...)` as wrapper; added `describe('DirectTransportProvider (Story 35.1)', ...)` wrapping all test groups.

### Review Pass #3

| Field             | Value                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------- |
| **Date**          | 2026-04-13                                                                                    |
| **Reviewer Model**| Claude Opus 4.6 (1M context)                                                                  |
| **Issues Found**  | 0 critical, 0 high, 0 medium, 0 low                                                          |
| **All Fixed?**    | N/A -- clean pass, no changes needed                                                          |
| **Outcome**       | Pass (final)                                                                                  |

**Notes:** Clean pass -- no issues found. Semgrep security scan reported only false positives (`ws://` in tests and JSDoc comments).
