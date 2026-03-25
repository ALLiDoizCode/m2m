# Coding Standards

## TypeScript Rules

- Strict mode is fully enabled: `noUncheckedIndexedAccess`, `noImplicitAny`, `strictNullChecks`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`
- Array/object index access returns `T | undefined` -- always handle the `undefined` case
- Unused parameters must be prefixed with `_`
- No `any` type: `@typescript-eslint/no-explicit-any: "error"`
- Named exports only, no default exports
- Use `import type` for type-only imports
- Target ES2022: top-level await, `Array.at()`, `Object.hasOwn()` are available

## File and Naming Conventions

- File naming: kebab-case (`settlement-monitor.ts`)
- Class naming: PascalCase (`SettlementMonitor`)
- Interface naming: PascalCase without `I` prefix (`PeerConfig`, not `IPeerConfig`)
- Private fields: `private readonly _fieldName`
- Constants: `UPPER_SNAKE_CASE`

## Formatting

- Prettier enforced: single quotes, trailing commas (es5), 100 char width, 2-space indent, LF endings
- Pre-commit hooks run ESLint and Prettier via lint-staged

## Testing Standards

- Test files co-located with source: `module-name.test.ts` next to `module-name.ts`
- Integration tests in `test/integration/`, acceptance tests in `test/acceptance/`
- Jest with ts-jest preset, `testEnvironment: 'node'`
- Mock logger with `pino({ level: 'silent' })` and `jest.spyOn`
- Factory functions for test data: `createMockLogger()`, `createTestPeer()`
- `jest.clearAllMocks()` in `beforeEach`
- Coverage thresholds: branches 60%, functions 75%, lines 70%, statements 70%

## Logging

- Pino structured logging: `logger.info({ event: 'name', key: value }, 'message')`
- Child loggers: `logger.child({ component: 'name' })`
- Never log private keys, mnemonics, or secrets
