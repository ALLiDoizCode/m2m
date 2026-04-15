# Story 35.3: Extend Config Schema for Transport Block

Status: done

<!-- Note: Validation is optional. Run story validation for quality check before dev-story. -->

## Story

As a connector operator,
I want an optional `transport` block in the connector's YAML config that selects between `direct` and `socks5` transports,
so that I can opt-in to SOCKS5/ATOR overlay transport (with DNS-leak prevention and fail-closed defaults) while existing deployments stay on direct TCP with zero behavioral change.

**Epic:** 35 -- ATOR Overlay Transport for Privacy-Enabled Peering
**Priority:** P0 (blocks story 35.4 which wires the provider into `ConnectorNode` from config)
**Estimated effort:** 2 points (~half a day)
**Dependencies:** Story 35.1 (TransportProvider interface + DirectTransportProvider) -- done. Independent of Story 35.2 at the config-schema level (the schema describes both transports; the SOCKS runtime provider is in 35.2 and already merged).

## Acceptance Criteria

### AC 1: Absent `transport` block defaults to `{ type: "direct" }` (T-35.3-01)

```gherkin
Scenario: No transport block in YAML
  Given a connector YAML config that does not include a "transport" key
  When ConfigLoader.validateConfig is invoked (directly, or transitively via loadConfig)
  Then validation succeeds
  And the resulting ConnectorConfig.transport equals { type: "direct" }
  And no warning or error is logged about transport configuration
```

Note: `ConfigLoader.loadConfig(filePath)` parses YAML and delegates to `validateConfig`. Both code paths must yield identical normalization; tests may exercise either.

### AC 2: Valid `socks5` transport block validates and round-trips (T-35.3-02)

```gherkin
Scenario: Minimal valid socks5 transport block
  Given a YAML config containing:
    transport:
      type: "socks5"
      socksProxy: "socks5h://127.0.0.1:9050"
      externalUrl: "wss://abc123def456abcdef.anon/btp"
  When validateConfig runs
  Then validation succeeds
  And ConnectorConfig.transport equals {
      type: "socks5",
      socksProxy: "socks5h://127.0.0.1:9050",
      externalUrl: "wss://abc123def456abcdef.anon/btp",
      managed: false
    }
```

```gherkin
Scenario: managed flag passes through when explicitly set
  Given a socks5 transport block with managed: true
  When validateConfig runs
  Then ConnectorConfig.transport.managed is true
```

### AC 3: `type: "socks5"` without `socksProxy` fails validation (T-35.3-03)

```gherkin
Scenario: Missing socksProxy for SOCKS5 transport
  Given transport.type is "socks5" and socksProxy is absent (or empty/whitespace)
  When validateConfig runs
  Then a ConfigurationError is thrown
  And the error message names the missing field "transport.socksProxy"
  And the error message indicates it is required when transport.type is "socks5"
```

### AC 4: `type: "socks5"` without `externalUrl` fails validation (T-35.3-04)

```gherkin
Scenario: Missing externalUrl for SOCKS5 transport
  Given transport.type is "socks5" and externalUrl is absent (or empty/whitespace)
  When validateConfig runs
  Then a ConfigurationError is thrown
  And the error message names the missing field "transport.externalUrl"
  And the error message indicates it is required when transport.type is "socks5"
```

### AC 5: `socks5://` (no `h`) is rejected with DNS-leak rationale (T-35.3-05, T-35.6-SEC-03)

```gherkin
Scenario: socksProxy uses socks5:// instead of socks5h://
  Given transport.type is "socks5" and socksProxy is "socks5://127.0.0.1:9050"
  When validateConfig runs
  Then a ConfigurationError is thrown
  And the error message requires the "socks5h://" scheme
  And the error message explains DNS leak prevention as the reason
```

```gherkin
Scenario: Any non-socks5h scheme is rejected
  Given transport.type is "socks5" and socksProxy is any of
    "http://127.0.0.1:9050",
    "socks4://127.0.0.1:9050",
    "socks://127.0.0.1:9050",
    "127.0.0.1:9050"
  When validateConfig runs
  Then a ConfigurationError is thrown citing the required "socks5h://" scheme
```

### AC 6: Invalid `type` value is rejected (T-35.3-06)

```gherkin
Scenario: Unknown transport.type
  Given transport.type is a string other than "direct" or "socks5" (e.g., "tor", "foo")
  When validateConfig runs
  Then a ConfigurationError is thrown listing the valid values: direct, socks5
```

### AC 7: Wrong shape/types in `transport` block are rejected (T-35.3-07)

```gherkin
Scenario: transport field is not an object
  Given transport is a string, array, or null
  When validateConfig runs
  Then a ConfigurationError is thrown indicating transport must be an object

Scenario: sub-field has wrong type
  Given transport.socksProxy is a number, or transport.externalUrl is a boolean,
    or transport.managed is a string
  When validateConfig runs
  Then a ConfigurationError is thrown naming the offending field and expected type
```

### AC 8: `type: "direct"` with extra SOCKS-only fields is tolerated and ignored (T-35.3-08)

```gherkin
Scenario: Direct transport with ignorable extra fields
  Given transport: { type: "direct", socksProxy: "socks5h://...", externalUrl: "..." }
  When validateConfig runs
  Then validation succeeds
  And ConnectorConfig.transport equals { type: "direct" }
    (the SOCKS-only fields are discarded, not surfaced, and do not cause errors)
```

Rationale: direct transport has no SOCKS fields; extras must not be treated as errors so operators can flip `type` between `direct` and `socks5` without deleting/restoring lines. The normalized config only exposes fields relevant to the chosen `type`.

### AC 9: `ConnectorConfig.transport` is typed as a discriminated union (T-35.3-09)

```gherkin
Scenario: TransportConfig type is exported and narrow
  Given the config types module
  When TransportConfig is imported in consuming code
  Then it is a discriminated union on `type`:
    - { type: "direct" }
    - { type: "socks5", socksProxy: string, externalUrl: string, managed: boolean }
  And `ConnectorConfig.transport` is declared optional (`transport?: TransportConfig`)
    for backward compatibility at the type level
  And validateConfig always populates it with a concrete TransportConfig value
    (never returns a ConnectorConfig with `transport` unset)
  And `TransportConfig` is exported from both `packages/connector/src/config/index.ts`
    and the package barrel `packages/connector/src/lib.ts` so external consumers
    (e.g., the Story 35.4 ConnectorNode wiring, integration tests) can import it.
```

Rationale for the optional-at-type / always-populated-at-runtime split: keeps the interface backward compatible with call sites that construct a partial `ConnectorConfig` literal in tests, while `validateConfig` (the only supported production entry point) guarantees the field is present. Story 35.4 may narrow the type to required in a follow-up if a cleaner refactor is warranted; do not do it in this story.

### AC 10: Zero regression -- existing configs and tests still pass (T-REG-01..N)

```gherkin
Scenario: Existing YAML fixtures load unchanged
  Given every existing YAML config fixture under packages/connector (and docs examples)
  When validateConfig runs against each
  Then validation succeeds with no new errors
  And transport defaults to { type: "direct" } for all of them
  And `make test` (and `npm run test:unit`) pass with 0 regressions
```

## Tasks / Subtasks

- [x] Task 1: Define `TransportConfig` types and export (AC: #1, #2, #9)
  - [x] 1.1: In `packages/connector/src/config/types.ts`, add a discriminated-union type:
    ```ts
    export type TransportConfig =
      | { type: 'direct' }
      | {
          type: 'socks5';
          socksProxy: string;   // must start with socks5h://
          externalUrl: string;  // e.g., wss://<hs>.anon/btp
          managed: boolean;     // default false
        };
    ```
  - [x] 1.2: Add `transport?: TransportConfig` to `ConnectorConfig` with a TSDoc block that:
    - References Epic 35 / Story 35.3
    - Notes that the field is always populated post-validation (defaults to `{ type: 'direct' }`)
    - Points to `docs/` for the deployment guide (Story 35.7 will add the doc; fine to forward-reference)
    - Warns that `socksProxy` MUST use `socks5h://` to prevent DNS leaks
  - [x] 1.3: Export `TransportConfig` from two places so downstream code (Story 35.4) can type the `ConnectorNode` wiring:
    - `packages/connector/src/config/index.ts` -- add `export type { TransportConfig } from './types';`. Note: this file currently only re-exports `ConfigLoader` and `ConfigurationError`; adding a type re-export is the minimal change.
    - `packages/connector/src/lib.ts` -- append `TransportConfig` to the existing `export type { ConnectorConfig, ... } from './config/types';` block (the package's public barrel). Without this, external consumers cannot import the type by name.

- [x] Task 2: Extend `ConfigLoader.validateConfig` to normalize the transport block (AC: #1, #2, #8)
  - [x] 2.1: In `packages/connector/src/config/config-loader.ts`, add a private static method `validateTransport(raw: unknown): TransportConfig`.
    - When `raw` is `undefined`, return `{ type: 'direct' }`.
    - When `raw` is not a plain object (string, array, null, number, boolean), throw `ConfigurationError('transport must be an object')`.
    - Read `type` -- default to `'direct'` when absent. Reject any value not in `['direct', 'socks5']`.
    - For `type: 'direct'` -- return `{ type: 'direct' }` unconditionally (ignore any extra fields; see AC #8).
    - For `type: 'socks5'` -- call a separate `validateSocks5Transport` helper (Task 3).
  - [x] 2.2: Wire the helper into `validateConfig` alongside the existing `validate*` calls (e.g., right after `validatePorts`) and assign the result to `connectorConfig.transport`.
  - [x] 2.3: Update the pass-through block in `validateConfig` so `transport` is the validated/normalized value, not `rawConfig.transport as unknown`.

- [x] Task 3: Validate `socks5` transport fields (AC: #3, #4, #5, #6, #7)
  - [x] 3.1: Implement `validateSocks5Transport(raw: Record<string, unknown>): Extract<TransportConfig, { type: 'socks5' }>`.
  - [x] 3.2: `socksProxy`:
    - Must be present, of type `string`, and non-empty after `.trim()`.
    - Must start with literal prefix `socks5h://` (case-sensitive). Any other scheme (`socks5://`, `http://`, `socks4://`, bare `host:port`, etc.) throws `ConfigurationError` with message:
      > `transport.socksProxy must use the "socks5h://" scheme to prevent DNS leaks (socks5h:// forces DNS resolution through the proxy; socks5:// resolves DNS locally and would expose .anon destinations). Got: "<value-redacted-if-anon>"`
    - If the offending value contains `.anon`, DO NOT include the full value in the error message -- log `<redacted>` (or the scheme portion only) to avoid leaking hidden service addresses to logs. Replicate the redaction treatment used in `socks-transport-provider.ts` (see Story 35.2 Task 6 for precedent).
  - [x] 3.3: `externalUrl`:
    - Must be present, of type `string`, non-empty after `.trim()`.
    - Do NOT validate it against a `ws://|wss://` regex here (.anon URLs may not match all existing peer-URL regexes and we want the schema to be liberal in what it accepts for externalUrl -- the strict regex only applies to `peers[].url`). A minimal check is: starts with `ws://` or `wss://`.
  - [x] 3.4: `managed`:
    - Optional; when absent default to `false`.
    - When present must be a boolean; otherwise throw `ConfigurationError('transport.managed must be a boolean')`.
  - [x] 3.5: Return the normalized object `{ type: 'socks5', socksProxy, externalUrl, managed }`.

- [x] Task 4: Unit tests for transport validation (AC: #1-#9)
  - [x] 4.1: Create `packages/connector/src/config/transport-config.test.ts` (sibling to the other config tests).
  - [x] 4.2: Test matrix (at minimum):
    - Absent block -> defaults to `{ type: 'direct' }`.
    - `type: 'direct'` with no other fields -> `{ type: 'direct' }`.
    - `type: 'direct'` with extraneous `socksProxy` + `externalUrl` -> normalized to `{ type: 'direct' }` and extras are stripped.
    - `type: 'socks5'` with valid `socks5h://` URL + valid `externalUrl` -> full object, `managed` defaults to `false`.
    - `type: 'socks5'` with `managed: true` -> preserved.
    - `type: 'socks5'` with `socks5://` (no h) -> throws; error mentions `socks5h://` and `DNS leak`.
    - `type: 'socks5'` with `http://...` / `socks4://...` / bare `host:port` -> throws.
    - `type: 'socks5'` missing `socksProxy` -> throws naming the field.
    - `type: 'socks5'` missing `externalUrl` -> throws naming the field.
    - `type: 'unknown-value'` -> throws listing valid values (`direct`, `socks5`).
    - `transport` is an array / string / null -> throws indicating must be an object.
    - `transport.socksProxy` is a number / `transport.managed` is a string -> throws naming field and expected type.
    - Error message containing `.anon` hidden service value is NOT present in the thrown message (redaction check).
  - [x] 4.3: For each failing case, assert the thrown error is an `instanceof ConfigurationError` (not a generic `Error`).

- [x] Task 5: Regression sweep (AC: #10)
  - [x] 5.1: Run the existing `config-loader.test.ts` / `chain-provider-config.test.ts` / `environment-validator.test.ts` suites -- no changes expected, they must pass unchanged.
  - [x] 5.2: Grep for existing YAML fixtures (`packages/connector/**/*.yaml`, `docs/**/*.yaml`, `examples/**/*.yaml`). For each, run through `ConfigLoader.validateConfig` (can be a single parametrized test at `transport-config.test.ts`) -- each must normalize with `transport: { type: 'direct' }`.
  - [x] 5.3: Run `npm run lint`, `npm run format:check`, `npm run build`, `npm run test:unit` inside `packages/connector` and at repo root. All green.

- [x] Task 6: TSDoc and example snippet in types (Non-functional, but required) (AC: #9)
  - [x] 6.1: Include a YAML example inside the `TransportConfig` TSDoc mirroring the epic:
    ```yaml
    transport:
      type: "socks5"
      socksProxy: "socks5h://127.0.0.1:9050"
      externalUrl: "wss://abc123.anon/btp"
      managed: false
    ```
  - [x] 6.2: Call out the three critical rules from `_bmad-output/planning-artifacts/epic-35-ator-overlay-transport.md#Critical Implementation Rules` relevant to config:
    - `socks5h://` only (DNS leak prevention)
    - Fail closed (surfaced at runtime in 35.2, not at schema level)
    - Never log `.anon` at INFO (redaction in validation errors)

## Dev Notes

### Scope boundary (read first)

This story is schema + validation only. It:

- **DOES** add `TransportConfig` types and validation in `packages/connector/src/config/`.
- **DOES NOT** instantiate providers, pass them anywhere, or touch `connector-node.ts`, BTP client, or health endpoints -- Story 35.4 does all wiring.
- **DOES NOT** add `@anyone-protocol/anyone-client` -- Story 35.5 manages the binary lifecycle.
- **DOES NOT** touch `socks-transport-provider.ts` from Story 35.2; that provider already performs defense-in-depth scheme validation at construction time and will continue to do so. Schema-level rejection is a *second* line of defense (it catches config errors before the provider is constructed, giving better error messages).

If you find yourself editing files outside `packages/connector/src/config/` (other than a barrel export), stop -- that work belongs to 35.4 or later.

### Why not Zod?

The epic planning document says "Zod-validated YAML config schema". The actual codebase uses a hand-rolled validator in `ConfigLoader` (see `config-loader.ts`, lines 388-598). **Do not introduce Zod in this story.** Matching the existing style keeps the diff surgical and avoids a larger refactor. A future epic can migrate the entire config to Zod uniformly; mixing approaches now is worse than a consistent hand-rolled validator.

### Existing patterns to follow

- Error class: `ConfigurationError` (already defined in `config-loader.ts`). Throw this, not `Error`.
- Error message format: match the surrounding code (line numbers approximate; grep the file if they have drifted). Examples:
  - `Missing required field: <name>` (see `validateRequiredFields`)
  - `Invalid type for <name>: expected <type>, got <actual>` (see `validateRequiredFields`)
  - `Invalid <something>: must be one of <valid>, got <got>` (see `loadEnvironment` and peer/route validation)
- Validator pattern: private static method `validateX(raw): X`, called from `validateConfig`.
- Pass-through in `validateConfig`: the function builds the `connectorConfig` object literal with all optional fields cast from `rawConfig`. Add `transport: this.validateTransport(rawConfig.transport)` inside that object literal (replacing any need for separate post-assignment). Confirmed in the current source, the object literal spans roughly lines 183-204 but grep for `const connectorConfig: ConnectorConfig` to find the exact location.

### `.anon` redaction in errors

Story 35.2 Task 6.4 established that `.anon` addresses must not appear in INFO/WARN/ERROR logs. Validation errors are *caught* by operators, not emitted at log level, but because errors frequently get logged by the outer runtime, redact the offending value in scheme errors. Safe pattern:

```ts
const sanitizeForError = (url: string): string =>
  url.includes('.anon') ? url.replace(/\/\/[^/]+/, '//<redacted>') : url;
```

Only redact when the value contains `.anon`; otherwise include the full value (most misconfig cases are `socks5://127.0.0.1:9050` which is safe to log).

### Discriminated union ergonomics

Downstream code (Story 35.4) will select a provider with:

```ts
switch (config.transport.type) {
  case 'direct':
    return new DirectTransportProvider(...);
  case 'socks5':
    return new SocksTransportProvider({
      socksProxy: config.transport.socksProxy,
      externalUrl: config.transport.externalUrl,
      logger,
    });
}
```

The discriminated union ensures TypeScript narrows correctly in each branch. Don't use a non-discriminated interface (`{ type: 'direct' | 'socks5'; socksProxy?: string; ... }`) -- it defeats the exhaustiveness check in 35.4.

### Project Structure Notes

Files to CREATE:

- `packages/connector/src/config/transport-config.test.ts` -- new unit-test file.

Files to MODIFY:

- `packages/connector/src/config/types.ts` -- add `TransportConfig` union type, add `transport?: TransportConfig` field on `ConnectorConfig`.
- `packages/connector/src/config/config-loader.ts` -- add `validateTransport` / `validateSocks5Transport` private static methods, wire into `validateConfig`, update the returned `connectorConfig` object.
- `packages/connector/src/config/index.ts` -- export `TransportConfig`.

Files NOT to touch in this story:

- `packages/connector/src/transport/*` -- already complete from 35.1/35.2.
- `packages/connector/src/core/connector-node.ts` -- Story 35.4 owns this wiring.
- `packages/connector/src/btp/*` -- Story 35.4.

### References

- Epic spec: `_bmad-output/planning-artifacts/epic-35-ator-overlay-transport.md` (Story 35.3 definition on lines 285-331; Config Schema Extension lines 160-178; Critical Implementation Rules lines 120-131).
- Prior story (interface contract): `_bmad-output/implementation-artifacts/35-1-define-transportprovider-interface-directtransportprovider.md` -- establishes the `TransportProvider` interface consumed by Story 35.4.
- Prior story (SOCKS provider): `_bmad-output/implementation-artifacts/35-2-implement-sockstransportprovider.md` -- the runtime enforcement of `socks5h://` lives here; schema validation in 35.3 is the earlier of two enforcement points.
- Existing validator patterns: `packages/connector/src/config/config-loader.ts` lines 159-210 (validateConfig), 388-441 (validateRequiredFields), 453-499 (validatePeers).
- Existing types: `packages/connector/src/config/types.ts` lines 209-455 (`ConnectorConfig` and its optional-block pattern, e.g., `nip59?`).

## Previous Story Intelligence (35.2)

- **Scheme validation lives in two places.** The provider constructor (Story 35.2, `socks-transport-provider.ts`) already throws on non-`socks5h://`. Schema-level validation (this story) is defense in depth -- operators get the error at config load instead of provider instantiation, with a clearer origin.
- **Per-call agent creation.** `SocksTransportProvider.createAgent` returns a *fresh* `SocksProxyAgent` per call. The schema does not need to know this, but future wiring (35.4) will rely on `TransportConfig.socksProxy` being a raw string passed through to the provider; do not "parse" or "canonicalize" it at schema level beyond the prefix check. Preserve the operator's literal input.
- **TCP-probe semantics.** 35.2 uses a short TCP probe (no SOCKS5 handshake) to verify the proxy port is listening. Schema validation does zero I/O -- this story must not touch the network.
- **Logger + redaction convention.** 35.2 logs proxyHost/proxyPort at INFO but never the `.anon` external URL. Replicate the redaction mindset in error messages from validation (see "`.anon` redaction in errors" above).
- **Test style.** 35.2 tests used `pino({ level: 'silent' })` with spies. This story's tests don't need a logger -- `ConfigLoader.validateConfig` is pure. Use Jest (the repo's test runner; see `packages/connector/package.json` `"test": "jest"` and `"test:unit"` script) with `describe`/`it`/`expect`. Follow the style of the sibling `config-loader.test.ts` and `chain-provider-config.test.ts` files.

## Git Intelligence

Recent commits on `epic-35` branch:

- `64b5d204 feat(35.2): story complete — SocksTransportProvider for ATOR overlay transport`
- `5ddc40cf feat(35-1): story complete — TransportProvider interface and DirectTransportProvider`
- `3e9e7a9a chore(epic-35): epic start — baseline green, retro actions resolved`

Convention to follow for this story's eventual commit:

- Prefix: `feat(35.3):` or `feat(epic-35):` (both patterns seen; prefer `feat(35.3):` to match 35.2 most recent precedent).
- Scope: config schema only; 35.1 and 35.2 are referenced, not modified.

## Latest Tech Information

No new npm dependencies added in this story. The existing config stack (`js-yaml`, hand-rolled validation) is sufficient. `@anyone-protocol/anyone-client` is deferred to Story 35.5; `socks-proxy-agent` was added in Story 35.2.

Node version: `>= 22.11.0` (project requirement). No new runtime features needed.

## Project Context Reference

See `_bmad-output/project-context.md` for:

- Coding standards (TypeScript strict, ESLint, Prettier).
- Testing rules (coverage thresholds: branches 60%, functions 75%, lines 70%, statements 70%).
- The "BLS" terminology rule (use "BLS", not "agent runtime") -- irrelevant to this story but applies globally.

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context) — model ID `claude-opus-4-6[1m]`.

### Debug Log References

- `npx jest src/config/transport-config.test.ts` → 43/43 pass.
- `npx jest src/config/` → 156/156 pass (existing config-loader, chain-provider-config, environment-validator suites unchanged).
- `npm run test:unit` (connector workspace) → 2501 pass, 44 skipped, 0 failures.
- `npm run lint` → clean across all workspaces.
- `npm run build` → tsc clean.
- `npm run format:check` → clean after `prettier --write` on modified files.
- Initial RED sweep exposed three test fixtures (`test-connector-{a,b,c}.yaml`) that use `PLACEHOLDER_PORT_*` tokens and are not directly loadable by `ConfigLoader.loadConfig`; removed them from the regression list and noted why in the test file.

### Completion Notes List

- **Task 1 (types + exports):** Added `TransportConfig` discriminated union to `packages/connector/src/config/types.ts` with TSDoc covering the YAML example, the `socks5h://` DNS-leak rule, fail-closed behavior (enforced at runtime in 35.2), and `.anon` redaction. Added `transport?: TransportConfig` to `ConnectorConfig` with a TSDoc block noting the post-validation invariant that the field is always populated. Re-exported `TransportConfig` from both `packages/connector/src/config/index.ts` (for in-package consumers) and `packages/connector/src/lib.ts` (for external consumers — Story 35.4 wiring + integration tests).
- **Task 2 (validateTransport wiring):** Added `private static validateTransport(raw: unknown): TransportConfig` to `ConfigLoader`. Wired it into `validateConfig` inside the `connectorConfig` object literal (replaces the raw pass-through). Handles `undefined` → `{ type: 'direct' }`, rejects non-objects (string/array/null/number/boolean) with a descriptive `transport must be an object` error, defaults missing `type` to `'direct'`, and dispatches to `validateSocks5Transport` for SOCKS5. For `type: 'direct'` it unconditionally returns `{ type: 'direct' }`, discarding any SOCKS-only extras (AC #8).
- **Task 3 (validateSocks5Transport):** Implements presence + type + non-empty (trimmed) checks for `socksProxy` and `externalUrl`, enforces the `socks5h://` scheme (case-sensitive) with a full DNS-leak rationale in the error message, validates `externalUrl` starts with `ws://`/`wss://` (liberal — doesn't reuse the strict peer-URL regex because `.anon` URLs may not satisfy it), and defaults `managed` to `false` while rejecting non-boolean values. Returns the fully-normalized object. Added `sanitizeProxyForError` helper that redacts `.anon` hosts before echoing them in error messages (Story 35.2 redaction convention).
- **Task 4 (unit tests):** The test file was already present from the RED phase; all 43 test cases now pass, covering every AC. No new tests added beyond what was spec'd; removed three fixtures from the regression list (see Debug Log) because they depend on placeholder substitution in integration tests.
- **Task 5 (regression sweep):** Existing `config-loader.test.ts`, `chain-provider-config.test.ts`, `environment-validator.test.ts`, `key-manager-config.test.ts` all still green. Full connector unit suite (2501 tests) passes. Lint, build, format-check all clean.
- **Task 6 (TSDoc + example):** YAML example and the three critical rules (`socks5h://`-only, fail-closed, never-log-`.anon`) documented in the `TransportConfig` TSDoc block.

### File List

**Modified:**

- `packages/connector/src/config/types.ts` — added `TransportConfig` discriminated union and `transport?: TransportConfig` on `ConnectorConfig`.
- `packages/connector/src/config/config-loader.ts` — imported `TransportConfig`, wired `this.validateTransport(rawConfig.transport)` into the returned `connectorConfig`, added `validateTransport`, `validateSocks5Transport`, and `sanitizeProxyForError` private static methods.
- `packages/connector/src/config/index.ts` — re-exported `TransportConfig`.
- `packages/connector/src/lib.ts` — appended `TransportConfig` to the public `export type { ... } from './config/types'` block.
- `packages/connector/src/config/transport-config.test.ts` — trimmed the regression-fixture list to exclude `test-connector-{a,b,c}.yaml` (placeholder-substituted at integration-test runtime, not directly loadable).

**Created:** None (test file already existed from RED phase).

**Deleted:** None.

## Code Review Record

### Review Pass #1 — 2026-04-13

- **Reviewer:** Claude Opus 4.6 (1M context) — model ID `claude-opus-4-6[1m]`.
- **Scope:** Adversarial code review of Story 35.3 implementation (config schema + validation for the `transport` block).
- **Findings by severity:** Critical=0, High=1, Medium=2, Low=2.
  - HIGH: `sanitizeProxyForError` bare-host `.anon` redaction bypass — values without `//` (e.g. `host.anon:port`) evaded the authority-replacement regex and leaked the hidden-service host into thrown error messages.
  - MEDIUM (1): `validateTransport` used `JSON.stringify(typeRaw)` for invalid-type errors, which could echo user-supplied nested objects back into the error text.
  - MEDIUM (2): `externalUrl` scheme-rejection error omitted the offending value and did not apply `.anon` redaction — inconsistent UX vs. `socksProxy` error path.
  - LOW (1): duplicate "transport" in the non-object error message.
  - LOW (2): `null` edge-case handling under the `typeof === 'object'` check.
- **Outcome:** All 5 findings fixed in the same YOLO pass. Two new regression tests added (bare-host `.anon` redaction path + externalUrl `.anon` redaction path). 50/50 transport tests pass; 163/163 config tests pass; lint, prettier, and tsc clean.
- **Status after pass:** story remains in `review` — two additional code review passes, a security scan, and a full regression sweep are still outstanding before the story can be marked `done`.

### Review Pass #2 — 2026-04-13

- **Reviewer:** Claude Opus 4.6 (1M context) — model ID `claude-opus-4-6[1m]`.
- **Scope:** Adversarial code review focusing on residual `.anon` leakage vectors and operator-credential-disclosure paths in error messages. Reviewed `packages/connector/src/config/config-loader.ts` (lines 615–780), `packages/connector/src/config/transport-config.test.ts`, and cross-referenced against story File List + uncommitted git diff.
- **Findings by severity:** Critical=0, High=0, Medium=2, Low=0.
  - MEDIUM (1): `sanitizeProxyForError` only redacted the URL authority via `//[^/]+`, leaking any `.anon` substring present in URL path/query segments (e.g., `http://safe-host/path/hidden-service.anon/btp` → `http://<redacted>/path/hidden-service.anon`). Remediation: when `.anon` is detected anywhere in the value, collapse everything after `scheme://` to `<redacted>` rather than preserving path.
  - MEDIUM (2): Error messages echoed embedded userinfo (`user:password@host`) verbatim when the URL lacked `.anon`. Operators sometimes paste fully-formed URLs with credentials into YAML; logging those verbatim is a credential-disclosure risk. Remediation: always apply a userinfo-redaction pass (`//user:pass@` → `//<redacted>@`) regardless of `.anon` presence.
- **Outcome:** Both findings fixed. Two new regression tests added:
  - Path-segment `.anon` redaction: rejected `socksProxy` with `.anon` in path must not leak the hidden-service substring.
  - Userinfo credential redaction: `socks5://alice:hunter2@127.0.0.1:9050` rejection must strip `alice:hunter2` from the error message.
- **Verification:** 52/52 transport tests pass (+2 new); 165/165 config tests pass; full connector unit suite `npm run test:unit` reports 2510 passing / 44 skipped / 0 failures; `tsc` and `eslint` clean.
- **Status after pass:** story remains in `review` — pass #3, security scan, and broader regression sweep outstanding before `done`.

### Review Pass #3 — 2026-04-13

- **Reviewer:** Claude Opus 4.6 (1M context) — model ID `claude-opus-4-6[1m]`.
- **Scope:** Third adversarial review pass + Semgrep security scan covering OWASP Top 10, injection vectors, authentication/authorization, and prototype-pollution risks. Files reviewed: `packages/connector/src/config/config-loader.ts` (validateTransport, validateSocks5Transport, sanitizeProxyForError), `packages/connector/src/config/types.ts` (TransportConfig union + ConnectorConfig.transport), `packages/connector/src/config/index.ts`, `packages/connector/src/config/transport-config.test.ts`. Ran `mcp__plugin_semgrep_semgrep__semgrep_scan` against all four files.
- **Findings by severity:** Critical=0, High=0, Medium=0, Low=0.
- **Adversarial analysis — considered and dismissed:**
  - Prototype pollution via crafted YAML (`__proto__`, `constructor`): `js-yaml.load` is safe-by-default and returns plain objects; property access via named keys (`rawTransport.type`, `.socksProxy`, etc.) does not trigger prototype walks that could be weaponized in this codepath.
  - Case-sensitivity of `socks5h://`: story explicitly requires case-sensitive rejection (defense in depth — the provider also enforces at construction time in Story 35.2).
  - CRLF/control-char injection into `externalUrl`: downstream URL parsing handles this; schema layer's job is prefix validation only per the story contract.
  - ANSI-escape injection via error message echo: consistent with the rest of the `ConfigLoader` codebase; out-of-scope for this story (would require a cross-cutting log-sanitizer refactor).
  - `managed: null` error message saying "got object": technically correct per `typeof`, consistent with codebase convention (e.g., `validateRequiredFields`).
  - Double-userinfo or path-embedded `@` bypassing the userinfo regex: a single-pass regex is sufficient because userinfo can only legally appear in the authority; `.anon` values are already wholesale-redacted.
- **Semgrep scan:** 16 findings returned, ALL reviewed and confirmed false positives for this story:
  - 15× `javascript.lang.security.detect-insecure-websocket` flagging `ws://` literal occurrences in TSDoc example blocks, error-message regex operands (e.g., `externalUrl.startsWith('ws://')`), and test-fixture strings. These are documentation/validation literals, not live WebSocket connections. The connector intentionally supports both `ws://` (dev/local) and `wss://` (production) in peer URLs; hardcoding `wss://`-only would break local dev.
  - 1× `path-traversal.path-join-resolve-traversal` in `transport-config.test.ts` line 691 — flags `path.resolve(__dirname, '../../test/fixtures/configs', fixtureName)` where `fixtureName` is iterated from a hardcoded array literal in the same file. No user input reaches the path.
- **Verification:** 52/52 transport tests pass; `npx jest src/config/transport-config.test.ts` green. No code changes required in this pass (prior passes #1 and #2 addressed all actionable findings).
- **Status after pass:** story remains in `review` — status transition is the verification step's responsibility, not this review's.

## Change Log

- 2026-04-13 (Claude Opus 4.6, code review pass #3 YOLO + security scan): Ran a third adversarial review pass plus a Semgrep security scan (OWASP Top 10, injection, auth, prototype pollution). Findings: 0 Critical / 0 High / 0 Medium / 0 Low. No code changes required — all actionable issues were already fixed in passes #1 and #2. Semgrep returned 16 findings, all confirmed false positives (15× `ws://` prefix literals in TSDoc examples / error-message validation operands / test fixtures — the connector intentionally supports both `ws://` and `wss://` peer URLs; 1× `path.resolve` with iterated-array fixture names, no user input). Adversarial vectors considered and dismissed: YAML prototype pollution (js-yaml safe-by-default), case-sensitivity of `socks5h://` (intentional per spec), CRLF/ANSI injection via error echo (cross-cutting, out-of-scope), double-userinfo regex bypass (single-pass regex sufficient; `.anon` values already wholesale-redacted). 52/52 transport tests remain green. Story Status and sprint-status.yaml explicitly left unchanged (verification step owns that transition).
- 2026-04-13 (Claude Opus 4.6, code review pass #2 YOLO): Addressed 2 MEDIUM findings from second adversarial review (0 Critical / 0 High / 2 Medium / 0 Low). MEDIUM (1): `sanitizeProxyForError` previously left `.anon` substrings in URL path/query segments exposed because the authority-replacement regex `//[^/]+` only matched the authority. Reworked the helper so any `.anon` anywhere in the value collapses to `scheme://<redacted>` (or bare `<redacted>` when no scheme). MEDIUM (2): error messages echoed embedded userinfo (`user:password@host`) verbatim when the URL lacked `.anon`, risking credential disclosure to logs. Added an unconditional userinfo-redaction pass (`//user:pass@` → `//<redacted>@`) regardless of `.anon` presence. Two new regression tests cover path-segment redaction and userinfo redaction. 52/52 transport tests pass; 165/165 config tests pass; full unit suite 2510 passing; lint, build, and prettier clean. Story Status and sprint-status.yaml explicitly left unchanged (pass #3 still outstanding).
- 2026-04-13 (Claude Opus 4.6, code review YOLO): Addressed 1 HIGH, 2 MEDIUM, 2 LOW findings from adversarial review. HIGH fix: `sanitizeProxyForError` had a redaction gap — a bare `host.anon:port` (no `//`) bypassed the authority-replacement regex and leaked the hidden-service host verbatim into thrown error messages. Added a no-`//` branch that collapses the value wholesale to `<redacted>`. MEDIUM fixes: (a) `validateTransport` previously used `JSON.stringify(typeRaw)` for invalid-type errors, which could echo nested user-supplied objects; switched to `String(typeRaw)`-equivalent rendering that emits `<object>`/`<array>` tokens for non-strings. (b) `externalUrl` scheme-rejection error now includes the offending value (sanitized via the same `.anon` redactor) for parity with the `socksProxy` error UX. LOW fixes: deduplicated "transport" in the non-object error message (`Invalid type for transport: expected object, got <t>`). Added two regression tests covering the bare-host `.anon` redaction path and the externalUrl `.anon` redaction path. 50/50 transport tests pass, 163/163 config tests pass, lint/prettier/tsc clean.
- 2026-04-13 (Claude Opus 4.6): Implemented Story 35.3 in YOLO mode. Added `TransportConfig` discriminated union type, schema validation for the optional `transport` block (defaults to `{ type: 'direct' }`), and SOCKS5-specific rules (required `socksProxy` with `socks5h://` scheme for DNS-leak prevention, required `externalUrl`, optional `managed` boolean). Redacts `.anon` hosts in scheme-violation error messages. Exported `TransportConfig` from config barrel and package barrel. All 2501 connector unit tests green; lint, build, and format checks clean. Zero runtime wiring changes (deferred to Story 35.4).

## Story Completion Status

- Status: done
- Notes: Schema + validation landed; all ACs pass. Runtime wiring into `ConnectorNode` remains for Story 35.4 as planned. Three code review passes complete: pass #1 fixed 5 findings (1 HIGH / 2 MEDIUM / 2 LOW) and added 2 regression tests; pass #2 fixed 2 additional MEDIUM findings (`.anon` path-segment leakage + userinfo credential leakage) and added 2 more regression tests; pass #3 (final) returned a clean 0 Critical / 0 High / 0 Medium / 0 Low result with Semgrep security scan (16 findings, all confirmed false positives). Cumulative across all 3 passes: 0C / 1H / 4M / 2L, all fixed. 52/52 transport tests pass, full connector unit suite at 2510 passing. Story marked `done`.
