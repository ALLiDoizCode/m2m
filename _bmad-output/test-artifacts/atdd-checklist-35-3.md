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
  - '_bmad-output/implementation-artifacts/35-3-extend-config-schema-for-transport-block.md'
  - '_bmad-output/implementation-artifacts/35-2-implement-sockstransportprovider.md'
  - '_bmad-output/implementation-artifacts/35-1-define-transportprovider-interface-directtransportprovider.md'
  - 'packages/connector/src/config/config-loader.ts'
  - 'packages/connector/src/config/types.ts'
  - 'packages/connector/src/config/index.ts'
  - 'packages/connector/src/config/chain-provider-config.test.ts'
  - 'packages/connector/src/config/key-manager-config.test.ts'
  - 'packages/connector/src/lib.ts'
  - 'packages/connector/test/fixtures/configs/valid-config.yaml'
  - 'packages/connector/jest.config.js'
  - 'packages/connector/package.json'
  - '_bmad/tea/testarch/knowledge/data-factories.md'
  - '_bmad/tea/testarch/knowledge/test-quality.md'
  - '_bmad/tea/testarch/knowledge/test-healing-patterns.md'
  - '_bmad/tea/testarch/knowledge/test-levels-framework.md'
---

# ATDD Checklist - Epic 35, Story 3: Extend Config Schema for Transport Block

**Date:** 2026-04-13
**Author:** Jonathan
**Primary Test Level:** Unit (co-located Jest, pure config validation -- no I/O beyond temp-file YAML round-trip)

---

## Story Summary

Story 35.3 extends the connector's YAML config schema with an optional `transport` block that selects between `direct` (default) and `socks5` transports. The validator must:

- Default to `{ type: 'direct' }` when absent (zero behavioral change for existing deployments).
- Normalize valid `socks5` blocks (socksProxy, externalUrl, managed defaulting to `false`).
- Reject `socks5://` (and any non-`socks5h://` scheme) with a DNS-leak rationale.
- Reject missing required fields, wrong types, unknown `type` values, and non-object shapes.
- Tolerate (and strip) SOCKS-only fields under `type: 'direct'` so operators can flip the switch.
- Export `TransportConfig` as a discriminated union from the config barrel and the package barrel (for Story 35.4 wiring).

**As a** connector operator
**I want** an optional `transport` block with strict validation
**So that** I can opt in to SOCKS5/ATOR overlay transport while keeping existing direct deployments working

---

## Acceptance Criteria

1. **AC 1** -- Absent `transport` block defaults to `{ type: 'direct' }` (T-35.3-01)
2. **AC 2** -- Valid `socks5` transport block validates and round-trips (T-35.3-02)
3. **AC 3** -- `type: 'socks5'` without `socksProxy` fails validation (T-35.3-03)
4. **AC 4** -- `type: 'socks5'` without `externalUrl` fails validation (T-35.3-04)
5. **AC 5** -- `socks5://` (no `h`) rejected with DNS-leak rationale (T-35.3-05, T-35.6-SEC-03)
6. **AC 6** -- Invalid `type` value rejected (T-35.3-06)
7. **AC 7** -- Wrong shape / field types rejected (T-35.3-07)
8. **AC 8** -- `type: 'direct'` with extra SOCKS-only fields tolerated and ignored (T-35.3-08)
9. **AC 9** -- `ConnectorConfig.transport` is a discriminated union; `TransportConfig` exported (T-35.3-09)
10. **AC 10** -- Zero regression: existing YAML fixtures normalize to `{ type: 'direct' }` (T-REG-01..N)

---

## Test Strategy

**Primary level:** Unit tests, co-located at `packages/connector/src/config/transport-config.test.ts`, matching the style of `chain-provider-config.test.ts` and `key-manager-config.test.ts`.

**Rationale** (test-levels-framework.md):

- `ConfigLoader.validateConfig` is a pure, deterministic function. Unit tests exercise the full validation matrix without any integration harness.
- The one `loadConfig(filePath)` path that touches the filesystem is covered by (a) reusing the existing `valid-config.yaml` fixture for regression, and (b) a single temp-file YAML round-trip to prove the YAML -> object -> validation chain is wired end to end.
- No E2E testing is needed. Runtime wiring into `ConnectorNode` (where transport selection actually occurs) is Story 35.4's territory.

**Framework:** Jest 29.7 + ts-jest (project default). Run via `npm run test:unit` in `packages/connector` or `make test` at repo root.

**Determinism & isolation** (test-quality.md):

- No shared state between tests; each test builds its own raw config via a `baseRawConfig()` helper.
- The temp-file YAML round-trip writes to a file in `__dirname` and `unlinkSync`s it in a `finally` block -- deterministic cleanup even on assertion failure.
- No mocks. The tests exercise the real `ConfigLoader.validateConfig`, the real `js-yaml` loader, and the real fixture files.
- No `jest.fn()` -- not needed; this is pure validation logic.

---

## Failing Tests Created (RED Phase)

### Unit Tests (~35 tests across 9 describe blocks)

**File:** `packages/connector/src/config/transport-config.test.ts` (~575 lines)

Verified RED by running `npx jest --testPathPattern='transport-config' --no-coverage` -- suite fails at TypeScript compile with:

- `TS2305: Module '"./types"' has no exported member 'TransportConfig'.`
- `TS2339: Property 'transport' does not exist on type 'ConnectorConfig'.` (10 sites)
- `TS2366: Function lacks ending return statement ...` (discriminated-union narrowing test -- compiles only once the union is added to `types.ts`)

All three failures are expected RED markers.

#### absent block defaults to direct (3 tests) -- AC 1

- `returns transport: { type: "direct" } when YAML omits the transport key (T-35.3-01)`
- `applies the default even when validateConfig receives a transport: undefined key explicitly`
- `does not require a transport key when loading via ConfigLoader.loadConfig from YAML` (uses `test/fixtures/configs/valid-config.yaml`)

#### valid socks5 block (3 tests) -- AC 2

- `normalizes a minimal socks5 block with managed defaulted to false (T-35.3-02)`
- `passes through managed: true when explicitly set`
- `round-trips via YAML -> loadConfig (not just validateConfig)` -- temp-file round-trip

#### socks5 requires socksProxy (3 tests) -- AC 3

- `throws ConfigurationError naming transport.socksProxy when absent (T-35.3-03)`
- `throws when socksProxy is an empty string`
- `throws when socksProxy is whitespace-only`

#### socks5 requires externalUrl (3 tests) -- AC 4

- `throws ConfigurationError naming transport.externalUrl when absent (T-35.3-04)`
- `throws when externalUrl is empty string`
- `throws when externalUrl is whitespace-only`

#### socks5h:// scheme enforcement (4 tests) -- AC 5, T-35.6-SEC-03

- `rejects socks5:// (missing the "h") with a DNS-leak explanation (T-35.3-05)`
- `rejects non-socks5h scheme` (parametrized over `http://`, `socks4://`, `socks://`, bare `host:port`, mixed-case `socks5H://`)
- `does NOT include the full .anon hidden-service value when the rejected proxy URL contains .anon` -- redaction check
- `plain IP/host in a rejected socks5:// URL may appear in the error (no redaction needed)` -- affirms redaction is targeted

#### unknown type rejected (1 parametrized, 5 cases) -- AC 6

- `throws ConfigurationError listing valid values for type = <badType>` over `tor`, `foo`, `DIRECT`, `Socks5`, empty string

#### shape + field type validation (8 tests) -- AC 7

- `throws when transport is a <string|array|null|number|boolean> (not an object)` -- 5 parametrized cases
- `throws when socksProxy is a number`
- `throws when externalUrl is a boolean`
- `throws when managed is a string`

#### direct with extra fields (2 tests) -- AC 8

- `strips SOCKS-only fields when type is direct and returns { type: "direct" } (T-35.3-08)`
- `accepts direct as the default when type is omitted but transport is present`

#### TransportConfig discriminated union (4 tests) -- AC 9

- `compiles as a discriminated union on 'type' (compile-time narrowing)` -- exhaustive `switch(t.type)` proves discriminated union
- `is re-exported from the config barrel (packages/connector/src/config)` -- import-time check
- `is re-exported from the package barrel (packages/connector/src/lib)` -- import-time check
- `validateConfig always populates transport (never returns it unset)`

#### existing YAML fixtures default to direct (1 parametrized, 7 cases) -- AC 10

- `loads <fixture> and normalizes transport to { type: "direct" }` over `valid-config.yaml`, `test-connector-a.yaml`, `test-connector-b.yaml`, `test-connector-c.yaml`, `with-comments.yaml`, `empty-peers-routes.yaml`, `optional-fields.yaml`

### API / E2E / Component tests

Not applicable. This story is schema-only; the transport runtime lives in Story 35.2 (SOCKS provider already merged) and the wiring lives in Story 35.4. E2E/integration coverage for SOCKS peering is Story 35.6.

---

## Data Factories Created

One co-located helper inside the test file (consistent with `chain-provider-config.test.ts` style):

- `baseRawConfig()` -- returns a minimal valid raw config object (nodeId, ports, empty peers/routes). Used as the base for every test; tests spread it and layer on `transport:` overrides.
- `tryValidate(overrides)` -- wraps `ConfigLoader.validateConfig` in a try/catch and returns a discriminated union `{ ok: true, config } | { ok: false, error }`. Avoids `expect().toThrow` in every negative test and keeps the error-object assertion explicit (required by "error is instanceof ConfigurationError" contract).

No separate factory module. Lightweight, in-file helpers follow the data-factories.md guidance for small test surfaces.

---

## Fixtures Created

None. The existing fixtures under `packages/connector/test/fixtures/configs/` are reused for the regression sweep (AC 10). One ephemeral temp file is written + `unlinkSync`'d inside the socks5 round-trip test to exercise `ConfigLoader.loadConfig(filePath)` end-to-end.

---

## Mock Requirements

None. The tests run the real validator against real YAML through the real js-yaml parser. No HTTP, no process-env manipulation (the environment-validator path already has its own tests), no logger spies.

---

## Required data-testid Attributes

Not applicable (no UI in this story).

---

## Implementation Checklist

Each failing test maps to concrete tasks. Ordering mirrors the story Tasks section.

### Task 1: Define `TransportConfig` type + `ConnectorConfig.transport?`

**Makes pass:** AC 9 discriminated-union test, unblocks compile for every other test

- [ ] In `packages/connector/src/config/types.ts`, add:
      `export type TransportConfig = { type: 'direct' } | { type: 'socks5'; socksProxy: string; externalUrl: string; managed: boolean };`
- [ ] Add `transport?: TransportConfig` to `ConnectorConfig` with TSDoc block referencing Epic 35 / Story 35.3, noting always-populated post-validation, warning about `socks5h://` for DNS-leak prevention, and including the YAML example from the story.
- [ ] Add `export type { TransportConfig } from './types';` to `packages/connector/src/config/index.ts`.
- [ ] Append `TransportConfig` to the `export type { ConnectorConfig, ... } from './config/types';` block in `packages/connector/src/lib.ts`.
- [ ] Run tests: `npx jest --testPathPattern='transport-config'`
- [ ] Verify the suite now compiles (failures shift from TS errors to runtime "transport is undefined" failures -- expected until Task 2).

**Estimated effort:** 0.25 hours

---

### Task 2: `ConfigLoader.validateTransport` + wiring

**Makes pass:** AC 1 (defaults), AC 6 (unknown type), AC 7 (shape), AC 8 (direct + extras)

- [ ] Add `private static validateTransport(raw: unknown): TransportConfig` in `config-loader.ts`:
  - `raw === undefined` -> return `{ type: 'direct' }`.
  - `raw` not a plain object (array, null, string, number, boolean) -> throw `ConfigurationError('transport must be an object')`.
  - `type` defaults to `'direct'` when absent; reject any value not in `['direct', 'socks5']` with a message listing valid values.
  - `type === 'direct'` -> return `{ type: 'direct' }` unconditionally (AC 8).
  - `type === 'socks5'` -> delegate to `validateSocks5Transport` (Task 3).
- [ ] In `validateConfig`, call `this.validateTransport(rawConfig.transport)` and assign the result to `connectorConfig.transport` (replacing any cast-through of `rawConfig.transport`). Place alongside existing `validate*` calls (e.g., after `validatePorts`).
- [ ] Run tests.
- [ ] Verify AC 1/6/7/8 tests pass; AC 2/3/4/5 still fail until Task 3.

**Estimated effort:** 0.5 hours

---

### Task 3: `validateSocks5Transport`

**Makes pass:** AC 2 (happy path), AC 3 (missing socksProxy), AC 4 (missing externalUrl), AC 5 (scheme enforcement + redaction), remaining AC 7 field-type tests

- [ ] Implement `private static validateSocks5Transport(raw: Record<string, unknown>): Extract<TransportConfig, { type: 'socks5' }>`.
- [ ] `socksProxy`: must be string, non-empty after `.trim()`, must start with literal `socks5h://` (case-sensitive). Otherwise throw `ConfigurationError` with message mentioning:
  - `transport.socksProxy`
  - `socks5h://` scheme
  - "DNS leak" explanation
  - The offending value, REDACTED when it contains `.anon` (use helper `sanitizeForError` per story Dev Notes).
- [ ] `externalUrl`: must be string, non-empty after `.trim()`, must start with `ws://` or `wss://`. Otherwise throw `ConfigurationError('transport.externalUrl ...')`.
- [ ] `managed`: default `false` when absent; must be boolean when present, else throw `ConfigurationError('transport.managed must be a boolean')`.
- [ ] Missing required fields: throw `ConfigurationError('Missing required field: transport.<name>')` with a suffix noting `when transport.type is "socks5"`.
- [ ] Return `{ type: 'socks5', socksProxy, externalUrl, managed }`.
- [ ] Run tests.
- [ ] Verify all 35 tests pass.

**Estimated effort:** 1 hour

---

### Task 4: Regression sweep

**Makes pass:** AC 10

- [ ] Run the full connector unit suite: `cd packages/connector && npm run test:unit` (or `make test` at repo root).
- [ ] Confirm `config-loader.test.ts` / `chain-provider-config.test.ts` / `environment-validator.test.ts` / `key-manager-config.test.ts` unchanged results.
- [ ] Confirm the 7 fixture files in the regression test all normalize to `{ type: 'direct' }`.
- [ ] Run `npm run lint`, `npm run format:check`, `npm run build` at repo root. All green.

**Estimated effort:** 0.25 hours

---

### Task 5: TSDoc polish (non-functional)

**Makes pass:** story quality bar, not directly asserted by any test

- [ ] Include the YAML example from the story inside the `TransportConfig` TSDoc.
- [ ] Document the three critical rules: socks5h:// only, fail-closed (surfaced in 35.2 at runtime), never log `.anon` at INFO+.

**Estimated effort:** 0.1 hours

---

## Running Tests

```bash
# Run only the new transport-config tests
cd packages/connector && npx jest --testPathPattern='transport-config'

# Run all unit tests for the connector package
cd packages/connector && npm run test:unit

# Run full project test suite
make test

# Debug a single test
cd packages/connector && npx jest --testPathPattern='transport-config' -t 'DNS-leak'
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete)

- [x] 35 tests written across 9 describe blocks covering all 10 acceptance criteria.
- [x] Test file fails TypeScript compile with `TS2305: Module '"./types"' has no exported member 'TransportConfig'` and `TS2339: Property 'transport' does not exist on type 'ConnectorConfig'` -- expected, exactly what we want.
- [x] Uses discriminated-union narrowing test to enforce the correct type shape.
- [x] Covers defense-in-depth redaction of `.anon` in error messages.
- [x] Includes a YAML round-trip test to prove `loadConfig(filePath)` -> `validateConfig` wiring is end-to-end, not just in-memory.
- [x] Regression sweep over 7 existing YAML fixtures.

### GREEN Phase (DEV -- Next)

1. Add `TransportConfig` union + `ConnectorConfig.transport?` to `types.ts`, plus re-exports in `config/index.ts` and `lib.ts` (Task 1).
2. Add `validateTransport` and wire it into `validateConfig` (Task 2).
3. Add `validateSocks5Transport` with scheme + field-type checks and `.anon` redaction (Task 3).
4. Run `npx jest --testPathPattern='transport-config'` after each task; work down the failing list.
5. Run the full suite + lint + format + build for regression confirmation (Task 4).

### REFACTOR Phase

- Review `validateTransport` / `validateSocks5Transport` against the surrounding `validateRequiredFields` / `validatePeers` style (`Missing required field: <name>`, `Invalid type for <name>: expected <type>, got <actual>`).
- Confirm the `sanitizeForError` helper is not used on non-`.anon` values (targeted redaction only).
- Confirm the discriminated union narrows correctly in the `switch` consumer that Story 35.4 will add -- no `if (!('socksProxy' in t))` hacks.

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command:** `npx jest --testPathPattern='transport-config' --no-coverage`

**Result:**

```
FAIL connector src/config/transport-config.test.ts
  ● Test suite failed to run

    src/config/transport-config.test.ts:35:32 - error TS2305: Module '"./types"' has no
      exported member 'TransportConfig'.

    src/config/transport-config.test.ts:78:26 - error TS2339: Property 'transport' does not
      exist on type 'ConnectorConfig'.

    [... 10 additional TS2339 sites ...]

    src/config/transport-config.test.ts:490:43 - error TS2366: Function lacks ending return
      statement and return type does not include 'undefined'.

Test Suites: 1 failed, 1 total
Tests:       0 total
```

**Summary:**

- Total tests: 35 (0 running because TS compile blocks the suite)
- Passing: 0 (expected in RED)
- Failing: 35 (suite blocked on missing type member -- expected; DEV work unblocks them)
- Status: RED phase verified

**Expected failure progression as GREEN tasks land:**

1. After Task 1 (`TransportConfig` + `ConnectorConfig.transport?` + re-exports): suite compiles. Runtime failures shift to "expected `{ type: 'direct' }`, got `undefined`" across ~20 tests. AC 9 discriminated-union test passes immediately.
2. After Task 2 (`validateTransport` + wiring): AC 1, AC 6, AC 7 (shape), AC 8, AC 10 (regression sweep) all pass. AC 2/3/4/5 still fail ("Expected ConfigurationError, got success" or vice versa).
3. After Task 3 (`validateSocks5Transport` + redaction): all 35 tests pass.

---

## Notes

- **Why no Zod** -- the epic's planning doc mentions Zod, but the existing codebase uses a hand-rolled validator in `ConfigLoader`. The story explicitly defers a Zod migration. Tests match the hand-rolled contract: `ConfigurationError`, specific error-message substrings, field-name mentions in errors.
- **Test-level choice** -- Unit over integration. `ConfigLoader` is pure; there is no value in running a real connector to assert config-shape rejections. The temp-file round-trip covers the only stateful seam (`fs.readFileSync` + `yaml.load`).
- **Redaction is targeted** -- `.anon` values are redacted from error messages; plain IPs / `socks5://` scheme text are NOT redacted because they appear in most misconfiguration cases and operators need them for debugging. One test asserts redaction; another asserts absence of over-redaction.
- **Case-sensitive `socks5h://`** -- matches the story contract ("case-sensitive"). The `socks5H://` parametrized case in AC 5 is a regression guard against a well-meaning refactor to case-insensitive matching (which could let a typo through).
- **Discriminated-union enforcement** -- the `narrows` function in AC 9 compiles only if the union is a true discriminated union on `type`. A non-discriminated shape (`{ type: 'direct' | 'socks5'; socksProxy?: string; ... }`) would fail at `const proxy: string = t.socksProxy;` (possibly undefined). This is a compile-time contract, not a runtime one.
- **Regression fixtures** -- the 7 fixtures listed are the "valid" ones (not the `invalid-*.yaml` files that are supposed to fail for other reasons). Adding a transport check shouldn't break any of them; the test list is the guardrail.
- **YAML round-trip** -- the temp file uses `__dirname` for path stability under Jest's rootDir and unlinks on `finally` to prevent test-dir pollution even on failure.

---

## Knowledge Base References Applied

This ATDD workflow consulted the following knowledge fragments:

- **data-factories.md** -- inline `baseRawConfig()` + `tryValidate()` helpers over a separate factory module, matching the style of `chain-provider-config.test.ts` and `key-manager-config.test.ts`.
- **test-quality.md** -- Given-When-Then implicit via describe labels; one assertion cluster per test; isolation via per-test object construction; no shared mutable state.
- **test-healing-patterns.md** -- parametrized `it.each` for the scheme-rejection matrix keeps the test count honest when new schemes are considered; regression-sweep list is explicit and fails loudly when a fixture is removed (rather than silently passing).
- **test-levels-framework.md** -- unit level is the appropriate terminal level for pure config validation. Integration (SOCKS5 peering) is explicitly deferred to Story 35.6.

---

## Contact

Ask in team standup or ping Jonathan.

---

**Generated by BMad TEA Agent** - 2026-04-13
