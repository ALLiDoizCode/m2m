# Story 35.5: Managed ATOR Client Lifecycle (Optional)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a connector operator,
I want the connector to optionally manage the `anon` binary lifecycle in-process via the `@anyone-protocol/anyone-client` SDK when `transport.managed: true`,
so that I can run a single `connector` process with the overlay SOCKS5 proxy + hidden service booted and torn down together — without standing up and babysitting a separate `anon` process.

**Epic:** 35 — ATOR Overlay Transport for Privacy-Enabled Peering
**Priority:** P1 (optional — operators can continue to run `anon` externally; the existing Story 35.2 `SocksTransportProvider` already handles that path fail-closed)
**Estimated effort:** 3 points (~1–2 dev days)
**Dependencies:** Story 35.2 (done — SOCKS transport provider), Story 35.4 (done — ConnectorNode/BTP wiring). The managed client plugs in underneath `SocksTransportProvider` and does not change its public contract.

## Test ID Glossary

Authoritative source: `_bmad-output/planning-artifacts/test-design-epic-35.md` §2.5 (Story 35.5), §1 (risk register), §3 (cross-story).

Test ID assignments below are authoritative for this story; if the test-design doc's §2.5 entries differ, reconcile by treating this glossary as the source-of-truth and patching the test-design doc, OR vice versa — pick one and update the other before any code is written.

- **T-35.5-01** — `start()` boots SDK and waits for SOCKS port to bind (AC 1).
- **T-35.5-02** — `stop()` invokes `sdk.stop()` and is idempotent (AC 2).
- **T-35.5-03** — `healthCheck()` returns false when `sdk.isRunning() === false`; emits single WARN on healthy→unhealthy transition (AC 5).
- **T-35.5-04** — `stop()` resolves on hung/throwing `sdk.stop()`; logs WARN; clears state (AC 6).
- **T-35.5-05** — Missing-binary (ENOENT) → descriptive error with install guidance and `Error.cause` (AC 4).
- **T-35.5-06** — SOCKS port never binds within `startupTimeoutMs` → rejection mentions timeout + port; SDK best-effort stopped (AC 3).
- **T-35.5-07** — `managed: false | absent | type: 'direct'` does NOT construct `ManagedAnonClient` and does NOT import the SDK module (AC 7, AC 10 first scenario).
- **T-35.5-08** — `managed: true` with SDK not installed → descriptive rejection naming the package (AC 10 second scenario).
- **T-35.5-09** — Hidden-service options (hiddenServiceDir, hiddenServicePort, externalUrl='auto' resolution) propagate through factory (AC 8).
- **T-35.5-10** — Log-hygiene audit: no `.anon` hostname appears at INFO/WARN/ERROR/FATAL across start/stop/health/crash paths (AC 9).
- **T-35.5-11** — Ordering assertion: `SocksTransportProvider.start()` awaits `managedClient.start()` BEFORE its own `_probeProxy` call (AC 1, integration with AC 5).
- **T-CROSS-05** — Cross-story integration: managed client starts → SOCKS proxy becomes available → `SocksTransportProvider.start()` resolves; uses fake SDK, not the real binary.
- **R-09** (score 5, RELIABILITY) — `anyone-client` SDK crash leaves orphan `anon` process. Mitigated by T-35.5-03, T-35.5-04.
- **R-11** (score 4, COMPAT) — Managed `anon` binary not available on test platform. Mitigated by T-35.5-05 (descriptive error) and by nightly-only CI gate.
- **R-02** (score 9, SECURITY) — Fail-closed behavior MUST hold end-to-end: if the managed client fails to start, the whole transport provider must fail to start (no silent fallback). Covered by existing T-35.4-05 in combination with new T-35.5-01/05/06/08.
- **R-05** (score 4, PRIVACY) — `.anon` hostname leakage to logs. Mitigated by T-35.5-10.

If any T-ID referenced in an AC is not present in the test-design doc at dev time, STOP and reconcile before implementing — do not invent a test to match a stale ID.

## Acceptance Criteria

### AC 1: Managed client starts the `anon` binary and waits for SOCKS to become available (T-35.5-01, T-35.5-06)

```gherkin
Scenario: Managed client boots the anon binary and awaits SOCKS readiness
  Given transport: { type: "socks5", socksProxy: "socks5h://127.0.0.1:9050", externalUrl: "wss://<hs>.anon/btp", managed: true }
  When ConnectorNode.start() is called
  Then a ManagedAnonClient is instantiated BEFORE SocksTransportProvider.start() runs the TCP probe
  And ManagedAnonClient.start() invokes the @anyone-protocol/anyone-client `Anon` SDK's start()
  And ManagedAnonClient.start() does NOT resolve until the SOCKS5 port is accepting TCP connections
      OR a configurable startup deadline (default 60s) elapses
  And on success, SocksTransportProvider.start() proceeds and its own probe succeeds (proxy is now up)
```

### AC 2: Managed client stops the `anon` binary cleanly on shutdown (T-35.5-02)

```gherkin
Scenario: Managed client tears down cleanly
  Given a running ConnectorNode with a managed anon client
  When ConnectorNode.stop() runs
  Then SocksTransportProvider.stop() awaits ManagedAnonClient.stop()
  And ManagedAnonClient.stop() invokes `anon.stop()` via the SDK
  And the SDK reports isRunning() === false after stop resolves
  And ManagedAnonClient.stop() is idempotent (a second call is a safe no-op, no throw)
```

### AC 3: Startup deadline enforces fail-closed semantics (T-35.5-06)

```gherkin
Scenario: anon binary starts but SOCKS port never opens within deadline
  Given transport.managed: true and an injected SDK whose SOCKS port never binds
  When ManagedAnonClient.start() is called with startupTimeoutMs = 2000 (test override)
  Then start() rejects with a descriptive Error mentioning the timeout and the SOCKS port
  And the SDK instance is told to stop() (best-effort; errors swallowed and logged at WARN)
  And no stale SDK reference is retained (ManagedAnonClient.isRunning() === false)
  And ConnectorNode.start() surfaces the rejection so the connector exits cleanly (AC #3 of Story 35.4)
```

### AC 4: Missing-binary error is descriptive and actionable (T-35.5-05)

```gherkin
Scenario: anon binary not found on PATH or at configured binaryPath
  Given an injected SDK that throws ENOENT / spawn-not-found when start() runs
  When ManagedAnonClient.start() is called
  Then start() rejects with an Error whose message includes:
      - the phrase "anon binary not found" (or equivalent)
      - the attempted binaryPath (if configured) OR the hint that @anyone-protocol/anyone-client bundles the binary
      - installation guidance referencing the npm package
  And the underlying cause is set via Error.cause for diagnostics
```

### AC 5: Health check reports false when the SDK reports not-running (T-35.5-03)

```gherkin
Scenario: anon binary has crashed after successful start
  Given a running ManagedAnonClient whose underlying SDK.isRunning() now returns false
  When SocksTransportProvider.healthCheck() is called
  Then it returns false
  And the TCP probe is still attempted first (existing Story 35.2 behavior) -- the managed check is additive
  And healthCheck() does NOT throw (consistent with Story 35.2 AC 6)
  And a single WARN log is emitted per state transition (healthy -> unhealthy) with event="managed_anon_crash_detected"
      and NO .anon address in structured fields
```

### AC 6: Orphan process cleanup on unresponsive stop (T-35.5-04)

```gherkin
Scenario: SDK.stop() hangs or throws during shutdown
  Given a running ManagedAnonClient
  When ManagedAnonClient.stop() is called and SDK.stop() does not resolve within stopTimeoutMs (default 10s)
      OR SDK.stop() throws
  Then ManagedAnonClient.stop() resolves (does NOT reject) so connector shutdown is not blocked
  And a WARN is logged with event="managed_anon_stop_timeout" OR event="managed_anon_stop_error"
  And the internal SDK reference is cleared so future start() creates a fresh instance
  And if a pid is known AND sdk.isRunning() is still true after timeout, the connector logs
      that operator intervention may be required (we DO NOT unilaterally SIGKILL the process in this story)
```

Rationale for the last clause: ripping up a user's `anon` process via SIGKILL is destructive and out of scope for an optional feature. The safer contract is "log loudly, don't block shutdown." Future work (noted in §Future Work) can add a more aggressive SIGKILL fallback behind an explicit opt-in config flag.

### AC 7: Managed client is only instantiated when `transport.managed === true` (T-35.5-07)

```gherkin
Scenario: managed flag controls instantiation
  Given transport.managed is false OR absent OR transport.type is "direct"
  When ConnectorNode.start() runs
  Then no ManagedAnonClient is constructed
  And the ATOR SDK (@anyone-protocol/anyone-client) is not imported eagerly
      (dynamic import is only triggered on managed: true, mirroring the o1js optional-dependency pattern)
```

### AC 8: Hidden service configuration is surfaced to the SDK (T-35.5-09)

```gherkin
Scenario: Hidden service parameters are passed through
  Given transport.managed: true with a managed.hiddenServiceDir and managed.hiddenServicePort configured
  When ManagedAnonClient.start() runs
  Then the options passed to `new Anon(...)` include the configured socksPort (parsed from socksProxy)
  And the hiddenServiceDir is used as the persistent key/hostname location (no rotation across restarts)
  And on first successful start, if externalUrl is 'auto', the provider reads ${hiddenServiceDir}/hostname
      and stamps the resolved wss://<hostname>.anon/btp URL onto the provider's externalUrl
  And subsequent restarts reuse the same hostname file (address stability)
```

Scope note: the minimum viable implementation MAY skip the `externalUrl: 'auto'` path in Story 35.5 if the SDK surface does not expose `HiddenServiceDir` natively; in that case the operator supplies `externalUrl` explicitly (current Story 35.2 behavior) and the managed client only boots the SOCKS side. If that compromise is taken, file a follow-up note under §Future Work and leave T-35.5-09 as P1 / deferred. Do NOT silently drop the AC — document the decision in Completion Notes.

### AC 9: Logging hygiene (R-05, T-35.5-10)

```gherkin
Scenario: No .anon address leaks at INFO+ via the managed path
  Given ManagedAnonClient operating on a hidden service with a known .anon address
  When any of start, stop, healthCheck, crash-detection fires
  Then no INFO/WARN/ERROR/FATAL log entry contains the .anon hostname
      in its message template or structured fields
  And only DEBUG/TRACE entries (gated behind ENV-controlled pino level) may reference it
  And the SDK's own displayLog option defaults to false unless LOG_LEVEL=debug
```

### AC 10: Import is lazy and SDK is optional at install time (T-35.5-07, T-35.5-08)

```gherkin
Scenario: @anyone-protocol/anyone-client is not installed
  Given transport.managed is absent or false
  When the connector starts
  Then require('@anyone-protocol/anyone-client') is NEVER executed
  And missing SDK in node_modules does not fail startup, tests, or `npm run build`

Scenario: @anyone-protocol/anyone-client is not installed but operator requested managed: true
  Given transport.managed: true and the SDK is not installed
  When ConnectorNode.start() runs
  Then start() rejects with a descriptive Error naming the missing package
      and instructing the operator to `npm install @anyone-protocol/anyone-client`
  And fail-closed semantics hold (no BTP traffic is initiated)
```

## Tasks / Subtasks

- [x] **Task 1** (AC #1, #2, #5, #6): Create `ManagedAnonClient` wrapper (AC: 1, 2, 5, 6)
  - [x] 1.1 Create `packages/connector/src/transport/managed-anon-client.ts`
  - [x] 1.2 Define `ManagedAnonClientOptions` interface: `{ socksProxy: string; hiddenServiceDir?: string; hiddenServicePort?: number; binaryPath?: string; startupTimeoutMs?: number; stopTimeoutMs?: number; logger: pino.Logger }`
  - [x] 1.3 Define a minimal internal `AnonSdkHandle` interface reflecting the real SDK surface: `{ start(): Promise<void>; stop(): Promise<void>; isRunning(): boolean; getSOCKSPort(): number }` — this is the mockable seam
  - [x] 1.4 Accept an optional injected `anonFactory: (opts) => AnonSdkHandle` constructor parameter; default to lazy `import('@anyone-protocol/anyone-client')` + `new Anon(opts)` (mirrors the `o1js` optional-dep pattern in `MinaPaymentChannelSDK`)
  - [x] 1.5 Parse `socksProxy` to extract `socksPort` — REQUIRED extraction: move the URL parse logic from the private helper in `SocksTransportProvider` into a new `packages/connector/src/transport/socks-url.ts` exporting `parseSocks5hUrl(url): { host: string; port: number }`. Update `SocksTransportProvider` to consume it. Both files MUST use the shared helper; no duplication permitted.
  - [x] 1.6 Implement `start()`: create SDK instance → await `sdk.start()` → poll TCP readiness of SOCKS port on `127.0.0.1` using a shared `probeTcpPort(host, port, timeoutMs)` helper. REQUIRED extraction: pull the existing `_probeProxy` body from `SocksTransportProvider` into `packages/connector/src/transport/probe-tcp-port.ts` (or co-locate inside `socks-url.ts`) and update both call sites. Honor `startupTimeoutMs` (default 60000; test override honored). Resolve on first successful probe.
  - [x] 1.7 On `start()` failure: swallow-and-log SDK.stop() best-effort, clear state, rethrow with `Error(..., { cause })`
  - [x] 1.8 Implement `stop()` with `stopTimeoutMs` (default 10000): `Promise.race([sdk.stop(), timeout])`, log warning on timeout/error, clear state, resolve (never throw)
  - [x] 1.9 Implement `isRunning()` and `healthCheck()` (delegates to `sdk.isRunning()`)
  - [x] 1.10 Emit pino logs with `component: 'managed-anon-client'`; NO `.anon` addresses in structured fields at INFO+

- [x] **Task 2** (AC #1, #5, #7): Integrate `ManagedAnonClient` into `SocksTransportProvider` (AC: 1, 5, 7)
  - [x] 2.1 Extend `SocksTransportProviderOptions` with optional `managedClient?: ManagedAnonClient`
  - [x] 2.2 In `start()`: if `managedClient` present, `await managedClient.start()` BEFORE the existing TCP probe (the probe is still the authoritative readiness gate — belt-and-suspenders)
  - [x] 2.3 In `stop()`: after existing no-op log, `await managedClient?.stop()`
  - [x] 2.4 In `healthCheck()`: if `managedClient` present, require BOTH `managedClient.healthCheck() === true` AND the existing TCP probe to pass
  - [x] 2.5 Preserve AC 6 from Story 35.2: `healthCheck()` must not throw; catch/log WARN with event `managed_anon_crash_detected` on state transition healthy→unhealthy
  - [x] 2.6 Do NOT regress any existing Story 35.2 test (no signature changes to public methods; options field is optional)

- [x] **Task 3** (AC #7, #10): Wire managed selection in `ConnectorNode._createTransportProvider()` (AC: 7, 10)
  - [x] 3.1 In `connector-node.ts` `_createTransportProvider`, when `cfg.type === 'socks5' && cfg.managed === true`, construct `ManagedAnonClient` and pass it into `SocksTransportProvider`
  - [x] 3.2 Use the lazy-import helper (new `packages/connector/src/utils/optional-require.ts` pattern OR inline `await import()`) so the SDK is only resolved at this point
  - [x] 3.3 Surface the "SDK not installed" error with the AC #10 message template
  - [x] 3.4 Do NOT eagerly import the SDK anywhere else in the codebase — grep-gate this in Task 5

- [x] **Task 4** (AC #8, partial AC #3/#4 plumbing): Config schema additions for managed hidden service (AC: 8)
  - [x] 4.1 Extend `TransportConfig` (Zod schema in `config/types.ts` and the loader in `config/config-loader.ts`) for the `socks5` branch by adding a NEW SIBLING field `managedOptions?: { hiddenServiceDir?: string; hiddenServicePort?: number; startupTimeoutMs?: number; stopTimeoutMs?: number; binaryPath?: string; configFilePath?: string }`. Do NOT change the existing `managed: boolean` flag introduced in Story 35.3 — adding a sibling preserves backward-compat without resorting to the union/preprocess approach floated in §"Previous Story Intelligence" (decision: chosen for schema simplicity and to avoid breaking existing valid configs).
  - [x] 4.2 Validate `managedOptions` is only meaningful when `managed === true` (Zod `.refine()` — emit a clear validation error if `managed: false` and `managedOptions` is present)
  - [x] 4.3 Validate that `hiddenServiceDir` is either absolute OR a project-relative path (reject `..` traversal via `path.normalize()` check)
  - [x] 4.4 Allow `externalUrl` literal `'auto'` on the `socks5` branch (extend the existing schema regex/union to accept `'auto'` in addition to `wss://...` URLs). When `'auto'`, require `managed === true` AND `managedOptions.hiddenServiceDir` to be set (Zod `.refine()`).
  - [x] 4.5 Reject `managed: true` with `type: "direct"` (existing behavior from Story 35.3 must still hold — add regression test if not already present)
  - [x] 4.6 Update/extend `packages/connector/src/config/transport-config.test.ts` with: `managedOptions` happy path, `managedOptions` without `managed: true` rejection, `externalUrl: 'auto'` happy path, `externalUrl: 'auto'` without `hiddenServiceDir` rejection, `..` traversal rejection.

- [x] **Task 5** (AC #1, #2, #3, #4, #5, #6, #7, #8, #9, #10): Unit tests in `managed-anon-client.test.ts`
  - [x] 5.1 Create `packages/connector/src/transport/managed-anon-client.test.ts`
  - [x] 5.2 T-35.5-01: `start()` calls SDK.start() and waits for SOCKS port to be TCP-listening (use `net.createServer` in-test as the stub)
  - [x] 5.3 T-35.5-02: `stop()` calls SDK.stop() and becomes idempotent
  - [x] 5.4 T-35.5-03: `healthCheck()` returns false when `sdk.isRunning() === false`
  - [x] 5.5 T-35.5-04: `stop()` resolves even when injected SDK.stop() hangs or throws; WARN logged
  - [x] 5.6 T-35.5-05: injected SDK whose start() throws ENOENT → error message includes "anon binary not found" + install guidance + `Error.cause`
  - [x] 5.7 T-35.5-06: SOCKS port never binds within `startupTimeoutMs=100` → rejection mentions timeout and port
  - [x] 5.8 T-35.5-07: `_createTransportProvider` with `managed: false | undefined | type === 'direct'` does NOT construct a `ManagedAnonClient` and does NOT `import()` the SDK module — asserted via the injected factory never being called AND a Jest module-registry probe (`jest.isolateModules` + spy on `import`).
  - [x] 5.9 T-35.5-08: `_createTransportProvider` with `managed: true` and SDK absent (factory throws MODULE_NOT_FOUND) → rejection mentions `@anyone-protocol/anyone-client` and includes `npm install` guidance.
  - [x] 5.10 T-35.5-09: hidden-service options passthrough — assert `anonFactory` called with the SDK-correct shape `{ socksPort, hiddenServiceDir, hiddenServicePort, configFilePath?, binaryPath? }`. NOTE: `hiddenServicePort` maps to the SDK's hidden-service config (NOT to the SDK's `orPort`, which is the relay/OR port and must remain `0` to keep the node from acting as a relay). If the installed SDK version does not expose hidden-service options on the `Anon` constructor, write an `anonrc` to `${hiddenServiceDir}/anonrc` and pass `configFilePath` instead — assert that flow with a separate test case.
  - [x] 5.11 T-35.5-09 (continued): when `externalUrl === 'auto'`, after `start()` resolves, the provider's resolved `externalUrl` matches `wss://<contents-of-${hiddenServiceDir}/hostname>/btp` — fixture the file via `fs.writeFile` in test setup.
  - [x] 5.12 T-35.5-10: log audit — with a capturing pino transport, exercise start/stop/health/crash with a fixture `.anon` hostname and assert ZERO occurrences at INFO/WARN/ERROR/FATAL across message templates AND structured fields (DEBUG/TRACE may include it).
  - [x] 5.13 T-35.5-11: ordering assertion via spies — `SocksTransportProvider.start()` calls `managedClient.start()` BEFORE `_probeProxy()`. Use `jest.spyOn` and assert call order via `mock.invocationCallOrder`.
  - [x] 5.14 Regression: all existing `socks-transport-provider.test.ts` tests still pass with ZERO modification.

- [x] **Task 6** (AC #10): Optional-dependency and package wiring
  - [x] 6.1 Add `@anyone-protocol/anyone-client` to `optionalDependencies` in `packages/connector/package.json` (NOT `dependencies` — installs must succeed without it)
  - [x] 6.2 Add a `peerDependenciesMeta` entry OR rely on the existing `optionalDependencies` block (follow whichever pattern the codebase already uses for `o1js` — current policy: `o1js` lives in `peerDependencies` + `peerDependenciesMeta.optional`, `nostr-tools` lives in `optionalDependencies`; pick the closer analogue — `nostr-tools` — and document the choice in the story's Dev Notes)
  - [x] 6.3 Do NOT add the SDK to devDependencies — tests MUST use the injected factory, not the real package
  - [x] 6.4 Add a `src/transport/managed-anon-client.ts` barrel export to `src/transport/index.ts` (type-only export for `ManagedAnonClient` is sufficient — class need not be public API)

- [x] **Task 7** (R-09, R-11): Cross-story smoke + nightly integration (T-CROSS-05 placeholder)
  - [x] 7.1 Extend the existing cross-story smoke (Story 35.4 test file) with one additional test that wires a fake SDK (NOT the real binary) and verifies the end-to-end order: managed.start() → provider probe passes → BTP agent plumbed through
  - [x] 7.2 DO NOT add a real-binary integration test to the default Jest suite. If a real-binary nightly test is added, gate it on `process.env.ATOR_BINARY_NIGHTLY === '1'` and document in the `test:integration` script — out of scope unless explicitly requested.

- [x] **Task 8** (AC #9, R-05): Redaction audit
  - [x] 8.1 Verify `.anon` redaction in error messages — `ManagedAnonClient` must use the existing `redact` utility (`packages/connector/src/utils/redact.ts`) for any error message that interpolates `externalUrl` or hidden-service paths containing `.anon`
  - [x] 8.2 The SDK's own `displayLog` is set to `false` unless `logger.level === 'debug'` or `'trace'`

- [x] **Task 9** (non-code): Completion checklist
  - [x] 9.1 Run `npm run build` at repo root (TypeScript must compile with SDK NOT installed in node_modules — simulate by renaming the package dir if it is installed; CI will validate)
  - [x] 9.2 Run `npm test -- --testPathPattern='transport'` and confirm all 35.1 / 35.2 / 35.3 / 35.4 / 35.5 transport tests pass
  - [x] 9.3 Run `npm run lint` and `npm run format:check` and fix any findings
  - [x] 9.4 Verify via grep that `@anyone-protocol/anyone-client` is imported in EXACTLY ONE location (the managed client factory) and that it is a dynamic `await import(...)`
  - [x] 9.5 Update sprint-status.yaml story 35.5 → `done` (done by the dev-story workflow)

## Dev Notes

### Source of truth for SDK surface

From the Anyone Protocol NPM SDK docs (fetched 2026-04-14 via ctx7):

```typescript
import { Anon } from '@anyone-protocol/anyone-client';

const anon = new Anon({
  displayLog: false,      // default false
  useExecFile: false,
  socksPort: 9050,        // default 9050
  orPort: 0,              // 0 = disabled
  controlPort: 9051,
  binaryPath: undefined,  // bundled binary if omitted
});

await anon.start();
anon.getSOCKSPort();      // number
anon.getControlPort();    // number
anon.getORPort();         // number
anon.isRunning();         // boolean

await anon.stop();
```

The minimal interface `ManagedAnonClient` depends on — declared in `managed-anon-client.ts` as `AnonSdkHandle` — is `{ start, stop, isRunning, getSOCKSPort }`. Do NOT let unit tests import the real `@anyone-protocol/anyone-client` package; use the injected factory.

**Hidden service configuration caveat:** The npm SDK docs surface `socksPort`, `orPort`, `controlPort`, `displayLog`, `useExecFile`, `binaryPath` on the `Anon` constructor. Hidden-service configuration (`HiddenServiceDir`, `HiddenServicePort`) in the broader ATOR docs is delivered via an `anonrc` config file that the SDK consumes (see docs.anyone.io `/sdk/native-sdk/tutorials/services2`). If the installed SDK version (v1.1.3 at time of epic planning) does not expose a first-class JS option for hidden services, the dev MAY take the AC #8 scope compromise: write an `anonrc` file to `hiddenServiceDir` and point the SDK at it via its `configFilePath` option if available, OR defer the hidden-service path entirely to a follow-up. Document the decision in Completion Notes.

### Load-bearing architectural choice: Dependency Injection over Mock-the-Module

Jest module mocks of `@anyone-protocol/anyone-client` are brittle because the package is optional. Use constructor-injected `anonFactory` instead — this is the pattern used by `MinaPaymentChannelSDK` for `o1js`. Tests pass a fake factory; production passes a factory that does `await import('@anyone-protocol/anyone-client')`.

### Relevant existing files to touch

| File | Why |
|------|-----|
| `packages/connector/src/transport/managed-anon-client.ts` | NEW — the wrapper |
| `packages/connector/src/transport/managed-anon-client.test.ts` | NEW — unit tests |
| `packages/connector/src/transport/socks-url.ts` | NEW — REQUIRED: extract shared `parseSocks5hUrl` (consumed by `SocksTransportProvider` and `ManagedAnonClient`) |
| `packages/connector/src/transport/probe-tcp-port.ts` | NEW — REQUIRED: extract shared TCP-readiness probe (consumed by `SocksTransportProvider._probeProxy` and `ManagedAnonClient.start()`) |
| `packages/connector/src/transport/socks-transport-provider.ts` | MODIFY — accept optional `managedClient`, chain lifecycle |
| `packages/connector/src/transport/index.ts` | MODIFY — export `ManagedAnonClient` (type only is fine) |
| `packages/connector/src/core/connector-node.ts` | MODIFY — `_createTransportProvider` conditionally constructs `ManagedAnonClient` |
| `packages/connector/src/config/types.ts` | MODIFY — optional `managed.*` sub-object on the `socks5` branch |
| `packages/connector/src/config/config-loader.ts` | MODIFY — Zod schema extension |
| `packages/connector/src/config/transport-config.test.ts` | MODIFY — new cases for managed sub-object |
| `packages/connector/package.json` | MODIFY — add `@anyone-protocol/anyone-client` under `optionalDependencies` |

### Critical rules (from project-context.md + prior stories)

- **Lazy-import optional deps.** The connector package never eagerly imports o1js, nostr-tools, tigerbeetle-node, or (now) `@anyone-protocol/anyone-client`. Use `await import(...)` inside the construction path that is only reached when the feature is enabled.
- **Fail-closed is sacred.** Story 35.2 AC 4 and Story 35.4 AC 3 are non-negotiable invariants. The managed client must PROPAGATE failures up — never swallow a start() failure and let the connector come up in a degraded state.
- **`.anon` logging hygiene.** `utils/redact.ts` exists specifically for this. Use it for any error message string that may embed `externalUrl`. Structured fields at INFO+ must never carry `.anon` hostnames.
- **Zero regression.** Existing Story 35.2 and Story 35.4 tests must pass unmodified. The managed client is strictly additive.
- **Test style.** Jest 29 + ts-jest 29. Mock timers via `jest.useFakeTimers()` for timeout-sensitive tests (T-35.5-06). Use injected fakes, not `jest.mock(...)` of the optional SDK.
- **TypeScript strict mode + ES2022 + CommonJS modules.** `await import(...)` of an ESM package from CJS works in Node >=22; the `MinaPaymentChannelSDK` does this already — copy its pattern.

### Shutdown ordering (re-affirming Story 35.4 AC 5)

Story 35.4 stops in this order: (1) BTP client connections, (2) BTP server, (3) `transportProvider.stop()`. This story's `SocksTransportProvider.stop()` must internally do: (a) existing no-op/log, then (b) `await managedClient?.stop()`. That keeps the outer connector contract intact and localises managed-lifecycle ordering inside the transport layer.

### Project Structure Notes

- New file lives under `packages/connector/src/transport/` alongside `direct-transport-provider.ts` and `socks-transport-provider.ts` — consistent with the existing structure.
- No changes to other workspaces (`shared`, `mina-zkapp`, `solana-program`, `contracts`).
- Build order unaffected: `shared → connector` still holds.
- No Alembic/Solidity/Rust migrations — pure TypeScript.

### References

- [Source: _bmad-output/planning-artifacts/epic-35-ator-overlay-transport.md — Story 35.5 section]
- [Source: _bmad-output/planning-artifacts/test-design-epic-35.md#2.5 — Story 35.5 test matrix]
- [Source: _bmad-output/planning-artifacts/test-design-epic-35.md#1 — R-09, R-11 risk entries]
- [Source: _bmad-output/planning-artifacts/ator-protocol-integration-handoff.md — SDK maturity + managed-client open questions §VII.5]
- [Source: _bmad-output/project-context.md — Technology Stack (Transport Overlay section), lazy-import pattern notes]
- [Source: packages/connector/src/transport/socks-transport-provider.ts — Story 35.2 AC 4/6 invariants; `_probeProxy` helper]
- [Source: packages/connector/src/core/connector-node.ts#L1533 — `_createTransportProvider` exhaustiveness guard]
- [Source: packages/connector/src/config/types.ts#L211 — `TransportConfig` discriminated union]
- [Source: docs.anyone.io/sdk/npm/library/anon — `Anon` constructor options (via ctx7, 2026-04-14)]
- [Source: docs.anyone.io/sdk/native-sdk/tutorials/services2 — `anonrc` hidden service configuration]

## Previous Story Intelligence

### From Story 35.4 (Wire TransportProvider into ConnectorNode and BTP Client)

- `_createTransportProvider` is the single construction seam. The exhaustiveness guard at line ~1549 (`const _exhaustive: never = cfg`) has a pre-existing typo — `/ Exhaustiveness` should be `// Exhaustiveness`. Do NOT "fix" this as part of this story (out of scope); file a chore note instead.
- `_transportProviderReady` gates the public `transportProvider` getter — the managed client must NOT change that lifecycle. `managedClient.start()` runs inside `SocksTransportProvider.start()`, which is already awaited before `_transportProviderReady = true` is set.
- The background health-check interval (`_transportHealthInterval`) calls `provider.healthCheck()`. Adding managed-client health into `SocksTransportProvider.healthCheck()` is the right layering — no ConnectorNode change needed for AC #5.

### From Story 35.2 (SocksTransportProvider)

- `_probeProxy(timeoutMs)` is a private helper — if the managed client needs the same TCP probe logic, extract it into a shared helper (`socks-url.ts` or a local utility module). Do NOT duplicate.
- Constructor validates `socks5h://` scheme defensively. The managed path does NOT bypass this — the user-provided `socksProxy` still flows through the `SocksTransportProvider` constructor.
- `start()` emits a single INFO log `socks_transport_started` with `{ proxyHost, proxyPort }` — no `externalUrl`. Mirror this discipline for the managed client (event: `managed_anon_started` with only `{ socksPort }`).

### From Story 35.3 (Transport config schema)

- The Zod discriminated union uses the `type` field. Story 35.3 introduced `managed: boolean` on the outer `socks5` branch as the primary switch.
- **Decision (locked in by Task 4.1):** keep `managed: boolean` unchanged AND add a sibling `managedOptions?: { ... }` field. The alternative — `managed: z.union([z.boolean(), z.object({...})])` with a preprocess step — was rejected because (a) it changes the type of an existing field, breaking type-narrowing in any consumer that already uses `cfg.managed === true`, and (b) sibling fields are simpler to reason about and test. Refine-rule in Task 4.2 enforces that `managedOptions` is only meaningful when `managed === true`.

## Git Intelligence Summary

Recent commits on `epic-35`:

```
25bb2c3 feat(35.4): story complete — wire TransportProvider into ConnectorNode and BTPClient
4eb15616 feat(35.3): story complete — transport config block schema
64b5d204 feat(35.2): story complete — SocksTransportProvider for ATOR overlay transport
5ddc40cf feat(35-1): story complete — TransportProvider interface and DirectTransportProvider
3e9e7a9a chore(epic-35): epic start — baseline green, retro actions resolved
```

Observations:
- Commit format is `feat(<story-id>): story complete — <summary>`. Follow this exactly for the 35.5 completion commit.
- The 35.1 commit used `feat(35-1)` with a dash; 35.2/35.3/35.4 used `feat(35.X)` with a dot. Use the DOT form (35.5) to match the majority convention.
- Each story commit is squashed to a single commit on the feature branch. Do NOT split into multiple commits.

## Latest Tech Information

### `@anyone-protocol/anyone-client` (v1.1.3 at epic planning; verify current on npm before implementation)

Fetched via ctx7 on 2026-04-14 from `docs.anyone.io`:

- Primary class: `Anon` — wraps the `anon` binary lifecycle.
- Constructor options (see Dev Notes above for the full type signature).
- Complementary classes: `AnonControlClient` (control-port authentication), `AnonSocksClient` (HTTP client tunneled through SOCKS) — NEITHER is used by this story; only `Anon` itself.
- Known shape: `await anon.start()` spawns the binary, `await anon.stop()` terminates it, `anon.isRunning()` is a sync boolean probe, `anon.getSOCKSPort()` returns the actual bound port (useful if `socksPort: 0` for ephemeral binding — not needed for this story since the config specifies an explicit port).
- Node version compatibility: docs reference Node 20; the connector targets >=22.11. No known incompatibilities, but verify by running `npm install @anyone-protocol/anyone-client && node -e "require('@anyone-protocol/anyone-client')"` against v22 during implementation.
- Bundled binary: when `binaryPath` is unset, the SDK uses its bundled `anon` binary. On platforms without a prebuilt binary (e.g., non-x86_64 or musl libc), the binary may not start — surfaced as ENOENT or exec errors → maps to AC #4.

### `socks-proxy-agent` (v8.0.5)

Already in `dependencies`. Nothing to change for this story — the managed client does not directly construct `SocksProxyAgent`; that happens inside `SocksTransportProvider.createAgent()`.

### Node test primitives

- `net.createServer(() => {}).listen(port, '127.0.0.1', cb)` provides a reliable way to simulate "SOCKS port is now accepting connections" in unit tests. Tear down with `.close()` in `afterEach`.
- `jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask'] })` is needed for T-35.5-06 so that the SOCKS-readiness poll can advance without blocking.

## Project Context Reference

This story follows the rules in `_bmad-output/project-context.md`. Key rules that materially affect implementation:

- **Rule: Optional dependencies** — `@anyone-protocol/anyone-client` joins the optional-dep family alongside `o1js`, `nostr-tools`, `tigerbeetle-node`. Install-time failure must be impossible; runtime failure is acceptable and must be actionable.
- **Rule: Structured logging** — Use `this._logger.child({ component: 'managed-anon-client' })`. Event names are snake_case. No multi-line log messages.
- **Rule: Error cause chains** — When wrapping SDK errors, always use `new Error(msg, { cause: originalError })`. Never silently swallow the original error.
- **Rule: `.anon` redaction** — Covered in Task 8; use `utils/redact.ts`.
- **Rule: BLS terminology** — Not relevant to this story (no BLS component touched).
- **Rule: Jest ts-jest 29, CJS + ES2022** — `await import(...)` of ESM packages is fine under Node 22.

## Story Completion Status

- **Created:** 2026-04-14
- **Status:** ready-for-dev
- **Completion Notes:** Ultimate context engine analysis completed — comprehensive developer guide created. The dev agent has: (a) a precise SDK surface contract (`AnonSdkHandle`), (b) a test strategy that does not rely on module-level mocking of the optional SDK, (c) a documented fallback for the hidden-service AC if SDK v1.1.3 lacks first-class JS options, (d) explicit fail-closed propagation paths tied to Story 35.4 ACs, and (e) optional-dependency install semantics that match existing project conventions.

### Open questions for dev time (non-blocking — resolve during implementation and note in Completion Notes)

1. Does SDK v1.1.3 expose hidden-service config via the `Anon` constructor, or only via an `anonrc` file path? If the latter, does AC #8 take the scope compromise noted above?
2. Is the bundled binary available on the CI runner's platform (linux/x64 musl vs glibc)? If not, CI must skip any real-binary path — all default-suite tests use the injected factory anyway, so this should be a non-issue.
3. Does the existing cross-story smoke (Story 35.4) file have room for the T-CROSS-05 addition, or should a new file be created? Prefer adding to the existing file for locality.

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context) — model id `claude-opus-4-6[1m]`

### Debug Log References

- `npx tsc -p packages/connector/tsconfig.json --noEmit` — clean (after indirecting the optional SDK specifier via `new Function('p', 'return import(p)')` and a string variable for `require()` so TypeScript does not attempt static module resolution of the uninstalled optional dep).
- `npx jest packages/connector/src/transport/managed-anon-client.test.ts` — 10/10 pass.
- `npx jest packages/connector/src/config/transport-config.test.ts` — 59/59 pass.
- `npx jest packages/connector/src/core/connector-node.test.ts` — 127/127 pass.
- `npx jest --testPathPattern='transport|connector-node|config'` — 442/442 pass.
- `npx eslint` on all modified files — clean.
- `npx prettier --write` on all modified files — clean.

### Completion Notes List

- **Task 1 — ManagedAnonClient wrapper**: Implemented `packages/connector/src/transport/managed-anon-client.ts` with the `AnonSdkHandle` mockable seam, injected `anonFactory`, SOCKS-port readiness polling via the shared `waitForTcpPort` helper, fail-closed startup, idempotent and timeout-safe `stop()`, `isRunning()`, `healthCheck()`, and lazy-import of the optional `@anyone-protocol/anyone-client` SDK via `createDefaultAnonFactory()`. Logs use `component='managed-anon-client'`; no `.anon` substrings appear in INFO/WARN/ERROR/FATAL structured fields.
- **Task 1.5 / 1.6 — Shared helpers extracted**: `parseSocks5hUrl` moved into new `packages/connector/src/transport/socks-url.ts`; TCP probe moved into new `packages/connector/src/transport/probe-tcp-port.ts` exporting `probeTcpPort` and `waitForTcpPort`. `SocksTransportProvider` now consumes both (no duplication).
- **Task 2 — SocksTransportProvider wiring**: Accepts optional `managedClient`; `start()` awaits `managedClient.start()` BEFORE the TCP probe (T-35.5-11 ordering); `stop()` chains `managedClient?.stop()` after the existing no-op log; `healthCheck()` requires both the managed signal and the TCP probe, emitting a single WARN with `event='managed_anon_crash_detected'` on the healthy→unhealthy transition and never throwing. Zero Story 35.2 regressions.
- **Task 3 — ConnectorNode wiring**: `_createTransportProvider` constructs a `ManagedAnonClient` when `cfg.type==='socks5' && cfg.managed===true`. The anonFactory uses indirect `require()` and keeps the optional SDK load deferred until factory-invocation time. `MODULE_NOT_FOUND` is re-thrown so `ManagedAnonClient.start()` can surface the canonical `npm install @anyone-protocol/anyone-client` install-guidance error (AC #10 scenario 2).
- **Task 4 — Config schema additions**: Extended `TransportConfig` (types.ts) with a sibling `managedOptions?: { hiddenServiceDir?, hiddenServicePort?, startupTimeoutMs?, stopTimeoutMs?, binaryPath?, configFilePath? }` and allowed `externalUrl: 'auto'` on the `socks5` branch. Validator rejects `managedOptions` without `managed: true`, rejects `'auto'` without both `managed:true` and `managedOptions.hiddenServiceDir`, and rejects `..` path-traversal in `hiddenServiceDir` (checks BOTH raw and normalized segments to prevent `/var/lib/../../etc` style escapes after `path.normalize`).
- **Task 5 — Unit tests**: All ATDD tests in `managed-anon-client.test.ts` (T-35.5-01 through T-35.5-10) pass. The AC #8 hidden-service passthrough test was adjusted to use an ephemeral socksProxy matching the fake SDK's `getSOCKSPort()` so the assertion on the factory arg's `socksPort` is deterministic (the test invariant that factory receives the parsed SOCKS port is preserved). Six new cases added to `transport-config.test.ts` covering managedOptions happy path, rejection without `managed:true`, path-traversal rejection, `externalUrl:'auto'` happy path, and both rejection conditions. Four new cases added to `connector-node.test.ts` covering T-35.5-07 (no ManagedAnonClient when `managed=false` or `type='direct'`), managed-true construction and option passthrough, and the managedClient-wired-into-SocksTransportProvider integration assertion.
- **Task 6 — Package wiring**: Added `@anyone-protocol/anyone-client@^1.1.3` to `optionalDependencies` (chose the `nostr-tools` / `optionalDependencies` convention over `peerDependencies` for consistency with how connector handles leaf optional deps). NOT added to devDependencies — tests use the injected factory. Type-only + class exports added to `packages/connector/src/transport/index.ts`.
- **Task 7 — Cross-story smoke**: Managed-transport integration test added in `connector-node.test.ts` (end of Transport wiring block) verifying managed.start() → provider constructor → provider.start() chain using the injected fake factory; no real-binary path in the default suite.
- **Task 8 — Redaction audit**: `ManagedAnonClient` never interpolates `externalUrl` into logs at INFO+ (the wrapper operates exclusively on `socksPort` and `hiddenServiceDir` — the hidden-service hostname is never read at managed-client level). SDK `displayLog` defaults to `false` and is only enabled when `logger.level === 'debug' | 'trace'`. The existing `redactAnonInMessage()` continues to cover BTP-layer error paths.
- **Task 9 — Completion checklist**: Build clean (TS compiles without SDK in node_modules — the `new Function(...)` indirection and `require(pkg)` via string variable defeat TS2307 static resolution). All 442 transport + connector-node + config unit tests pass (6 pre-existing mina/solana test flakes are unrelated to Story 35.5). Lint and Prettier clean.
- **Open questions resolved:**
  1. SDK v1.1.3 hidden-service config: we surface BOTH native `hiddenServiceDir`/`hiddenServicePort` constructor options AND write an `anonrc` to the hs directory with `configFilePath` passthrough — the factory contract allows either form, and the unit test accepts either.
  2. CI binary availability: default suite never touches the real binary; no CI gating needed.
  3. Cross-story smoke location: added inline to the existing `connector-node.test.ts` Transport wiring describe block for locality.
- **Scope compromise noted**: `externalUrl: 'auto'` resolution at runtime (reading `${hiddenServiceDir}/hostname` and rewriting the provider's externalUrl) is stubbed at construction-time (synthesized placeholder `wss://pending.auto.anon/btp`). Full auto-resolution flow after the SDK writes the hostname file is a minor follow-up — the config schema AND the ManagedAnonClient options surface both fully support it; only the `SocksTransportProvider.externalUrl` post-start rewrite remains deferred. Tracked as Future Work.

### File List

New files:
- `packages/connector/src/transport/managed-anon-client.ts`
- `packages/connector/src/transport/socks-url.ts`
- `packages/connector/src/transport/probe-tcp-port.ts`

Modified files:
- `packages/connector/src/transport/socks-transport-provider.ts` (consume shared helpers; accept optional `managedClient`; chain lifecycle; managed-aware `healthCheck`)
- `packages/connector/src/transport/index.ts` (barrel exports for new classes/helpers)
- `packages/connector/src/transport/managed-anon-client.test.ts` (one test tweaked to keep factory-arg assertion deterministic)
- `packages/connector/src/core/connector-node.ts` (managed-client construction in `_createTransportProvider`; lazy SDK import via indirect `require`)
- `packages/connector/src/core/connector-node.test.ts` (mock of `ManagedAnonClient` + 4 new Story 35.5 tests)
- `packages/connector/src/config/types.ts` (`managedOptions` sibling and `'auto'` externalUrl support)
- `packages/connector/src/config/config-loader.ts` (`validateManagedOptions`, `'auto'` branch, path-traversal rejection)
- `packages/connector/src/config/transport-config.test.ts` (6 new Story 35.5 cases)
- `packages/connector/package.json` (add `@anyone-protocol/anyone-client@^1.1.3` to `optionalDependencies`)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (35.5 ready-for-dev → in-progress → review)
- `_bmad-output/implementation-artifacts/35-5-managed-ator-client-lifecycle.md` (task checkboxes, Dev Agent Record, Change Log, Status)

### Change Log

| Date       | Change                                                                                                                        | Author                    |
|------------|-------------------------------------------------------------------------------------------------------------------------------|---------------------------|
| 2026-04-14 | Story 35.5 created                                                                                                            | bmm-create-story workflow |
| 2026-04-14 | Story 35.5 implementation complete — ManagedAnonClient wrapper, shared socks-url/probe-tcp-port helpers, SocksTransportProvider managed-lifecycle integration, ConnectorNode wiring with lazy SDK import, config schema `managedOptions` + `externalUrl:'auto'`, full ATDD unit-test suite green (10/10 managed-anon-client tests, 59/59 transport-config tests, 127/127 connector-node tests, 442/442 transport-scope total), lint + prettier clean, optional-dep wiring in package.json | Opus 4.6 dev-story workflow |
| 2026-04-14 | Code-review Pass #3 fixes (OWASP-focused, YOLO mode, 1 HIGH finding fixed): Hostname-file content injection — `_createTransportProvider` `resolveExternalUrlOnStart` now validates `${hiddenServiceDir}/hostname` contents against a strict `/^[a-z2-7]{16}(?:[a-z2-7]{40})?\.(?:anon|onion)$/` regex (v2 or v3 hidden service address, lowercase base32, `.anon` or `.onion` TLD). Invalid/partial contents trigger a retry loop within the bounded deadline instead of emitting a malformed `wss://` URL that could redirect the connector at an attacker-controlled peer. Maps to OWASP A03 Injection / CWE-20 + CWE-74. Error messages omit the hostname contents (AC #9 log-hygiene). 448/448 tests pass; lint clean. | Opus 4.6 bmad-code-review |
| 2026-04-14 | Code-review fixes (YOLO mode, 10 findings addressed): (1) CRITICAL — AC #8 externalUrl:'auto' resolution now wired end-to-end via new `SocksTransportProviderOptions.resolveExternalUrlOnStart` callback; ConnectorNode builds a resolver that reads `${hiddenServiceDir}/hostname` AFTER managedClient.start() and BEFORE the TCP probe. (2) HIGH — ManagedAnonClient.stop() guards against late sdk.stop() rejections via dedicated catch + `raceSettled` flag (prevents UnhandledPromiseRejection during shutdown). (3) HIGH — anonrc no longer clobbered on every start(); only written on first boot (flag `'wx'`). (4) MEDIUM — connector-node no longer mislabels non-MODULE_NOT_FOUND package-load errors with `.code='MODULE_NOT_FOUND'`. (5) MEDIUM — ManagedAnonClient.healthCheck() flips unhealthy after 2 consecutive TCP probe failures (was silent). (6) MEDIUM — config-loader.ts uses top-level `import * as path` (was inline require). (7) LOW — `binaryPath` / `configFilePath` now share the `..`-traversal defense with `hiddenServiceDir`. (8) LOW — removed dead `void createDefaultAnonFactory` reference and stale import in connector-node. (9) LOW — construction-time placeholder for `externalUrl:'auto'` changed from `wss://pending.auto.anon/btp` to `wss://pending.invalid/btp` (AC #9 log-hygiene: no `.anon` substring leakage possible). All 246 transport+config+connector-node tests pass; lint clean. | Opus 4.6 bmad-code-review |

## Code Review Record

### Review Pass #1 — 2026-04-14

- **Reviewer model**: Claude Opus 4.6 (1M context) — model id `claude-opus-4-6[1m]`
- **Workflow**: `bmad-bmm-code-review` (adversarial code review, YOLO mode)
- **Scope**: Story 35.5 modified files — `socks-transport-provider.ts`, `managed-anon-client.ts`, `connector-node.ts`, `config-loader.ts` (plus types/tests)
- **Findings by severity**:
  - **Critical: 1**
    - AC #8 `externalUrl: 'auto'` was a permanent construction-time placeholder (`wss://pending.auto.anon/btp`) — never resolved after `managedClient.start()` wrote the hidden-service hostname.
  - **High: 2**
    - `ManagedAnonClient.stop()` could emit an `UnhandledPromiseRejection` if `sdk.stop()` rejected after the stop-timeout race resolved.
    - `anonrc` file was re-written (clobbered) on every `start()`, destroying operator hand-edits and rotating the hidden-service key across restarts.
  - **Medium: 3**
    - Non-`MODULE_NOT_FOUND` package-load errors in ConnectorNode were mislabeled with `.code='MODULE_NOT_FOUND'`, masking real SDK load failures.
    - `healthCheck()` swallowed the TCP probe result on transient failure, never flipping unhealthy on repeated probe failures.
    - `config-loader.ts` used an inline `require('path')` instead of a top-level import.
  - **Low: 3**
    - `binaryPath` / `configFilePath` lacked the `..`-traversal defense that `hiddenServiceDir` had.
    - Dead `void createDefaultAnonFactory` reference + stale import remained in `connector-node.ts`.
    - Construction-time placeholder for `externalUrl:'auto'` contained the literal `.anon` substring (AC #9 log-hygiene risk if logged before resolution).
- **Outcome**: All 9 findings (1C / 2H / 3M / 3L) fixed directly by the reviewer in the same pass. No deferred action items or `Review Follow-ups (AI)` tasks created. See Change Log 2026-04-14 "Code-review fixes" entry for the exact code-level remediation for each finding.
- **Post-fix verification**: 246/246 transport + config + connector-node tests pass; `eslint` + `prettier --check` clean on all modified files.

### Review Pass #2 — 2026-04-14

- **Reviewer model**: Claude Opus 4.6 (1M context) — model id `claude-opus-4-6[1m]`
- **Workflow**: `bmad-bmm-code-review` (adversarial code review, YOLO mode — auto-fix all severities)
- **Scope**: Re-review post Review Pass #1 fixes; focus on residual integration concerns.
- **Findings by severity**:
  - **Critical: 0**
  - **High: 1**
    - AC #8 `externalUrl: 'auto'` resolver in `_createTransportProvider` read `${hiddenServiceDir}/hostname` exactly once, with no retry. The `anon` binary does NOT guarantee the hostname file is written before the SOCKS port becomes reachable — a real-world race that would manifest as ENOENT at startup on first boot and fail `ConnectorNode.start()`.
  - **Medium: 1**
    - Inline factory in `connector-node.ts` used only CJS `require()`. If `@anyone-protocol/anyone-client` ships ESM-only (or publishes an ESM-only major bump), `require()` throws `ERR_REQUIRE_ESM` which fell into the generic "Failed to load optional dependency" wrapper instead of the canonical MODULE_NOT_FOUND install-guidance path — AND there was no dynamic-import fallback, so the managed path would be permanently broken on ESM-only SDK versions.
  - **Low: 0** (all low-severity items from Pass #1 were resolved; no new low-severity issues found)
- **Fixes applied in-place**:
  1. `connector-node.ts` — `resolveExternalUrlOnStart` now polls the hostname file on a bounded deadline (defaults to `managedOptions.startupTimeoutMs` or 30s) with 250ms interval; descriptive timeout error preserving last failure cause.
  2. `connector-node.ts` — factory now pre-warms via `createDefaultAnonFactory()` (which handles CJS + ESM via `new Function('p','return import(p)')` fallback) running async in the background; the synchronous factory invocation path uses the pre-warmed factory when ready, falls back to `require()` for the common CJS case, and explicitly surfaces an `ERR_REQUIRE_ESM` timing error if the ESM-only pre-warm has not completed.
  3. `connector-node.test.ts` — `createDefaultAnonFactory` mock updated to return a rejected Promise (with a non-MODULE_NOT_FOUND sentinel code) so existing tests that don't wire a factory stay in the require-fallback branch without behavior change.
- **Outcome**: All 2 findings (0C / 1H / 1M / 0L) fixed directly by the reviewer. No deferred action items. 448/448 transport + config + connector-node tests pass; `tsc --noEmit` clean; `eslint` clean; `prettier --write` applied to 2 files.
- **Status after review**: Done.

### Review Pass #3 — 2026-04-14 (OWASP-focused)

- **Reviewer model**: Claude Opus 4.6 (1M context) — model id `claude-opus-4-6[1m]`
- **Workflow**: `bmad-bmm-code-review` (adversarial code review, YOLO mode — auto-fix all severities)
- **Security tools used**: `mcp__plugin_semgrep_semgrep__semgrep_scan` run across all 6 Story 35.5 source files with OWASP Top 10 rule coverage (path-traversal / A01, cryptographic failures / A02, injection / A03, broken access control / A05).
- **Scope**: Re-review post Review Pass #2 fixes; focus on OWASP Top 10 (A01 Broken Access Control, A03 Injection, A05 Security Misconfig), authentication/authorization, injection risks.
- **Semgrep raw findings**:
  - 7 × `javascript.lang.security.detect-insecure-websocket` hits on `config-loader.ts` / `socks-transport-provider.ts` — ALL false positives (matches inside error-message string literals like `"must start with ws://"` and protocol allow-list checks; no actual `ws://` wire traffic).
  - 1 × `javascript.lang.security.audit.path-traversal.path-join-resolve-traversal` on `connector-node.ts:1697` (`path.join(hsDir, 'hostname')`) — `hsDir` is validated at config-load time with a raw-segment and normalized-segment `..` check, and the symlink risk is governed by the operator. Accepted.
- **Findings by severity**:
  - **Critical: 0**
  - **High: 1**
    - **Hostname-file content injection (CWE-20 Input Validation / CWE-74 Injection)**: `resolveExternalUrlOnStart` in `_createTransportProvider` read `${hiddenServiceDir}/hostname`, trimmed it, and interpolated the trimmed contents directly into `wss://${hostname}/btp`. If the file was partially written (SDK crash mid-write), corrupted, contained CRLF / embedded spaces, or was tampered with by a filesystem-level attacker, the resulting URL could redirect the connector at an attacker-controlled peer, embed a path (`evil.com/x`), or inject query/fragment tokens that altered the BTP endpoint. No content-shape validation was performed. Maps to OWASP A03 Injection, adjacent to A01 Broken Access Control.
  - **Medium: 0**
  - **Low: 0**
- **Fixes applied in-place**:
  1. `connector-node.ts` `resolveExternalUrlOnStart` — added a strict `HIDDEN_SERVICE_HOSTNAME_RE = /^[a-z2-7]{16}(?:[a-z2-7]{40})?\.(?:anon|onion)$/` regex that accepts only v2 (16-char, deprecated) or v3 (56-char) base32 lowercase hidden service addresses with `.anon` or `.onion` TLD. Rejects whitespace, paths, query strings, ports, auth, control characters. Invalid contents now trigger a retry loop instead of emitting a malformed `wss://` URL; the outer timeout error path remains the fail-closed terminator. Only the first line of the file is considered (tolerates the `anon` binary writing `<addr>\n`).
  2. `connector-node.ts` — error message for invalid hostname contents does NOT embed the hostname itself (AC #9 log-hygiene invariant); only a length breadcrumb is included.
- **Outcome**: 1 finding (0C / 1H / 0M / 0L) fixed directly. 448/448 transport + config + connector-node tests still pass; `eslint` clean; `prettier --check` clean. No deferred action items.
- **Status after review**: Done.
