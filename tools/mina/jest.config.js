/**
 * Jest config for the Mina USDC devnet tooling smoke tests (ticket #193).
 *
 * Mirrors packages/mina-zkapp/jest.config.ts: the audited `mina-fungible-token`
 * lib ships ESM (.js with `export`), so it MUST be compiled to CJS (not ignored)
 * so it shares ONE o1js instance with the test — otherwise o1js throws
 * "Must call Mina.setActiveInstance first" from a duplicate module copy.
 *
 * Run from the connector root:
 *   npx jest --config tools/mina/jest.config.js
 *
 * @type {import('jest').Config}
 */
module.exports = {
  displayName: 'mina-usdc-tools',
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: __dirname,
  roots: [__dirname],
  testMatch: ['**/*.test.ts'],
  testTimeout: 120000, // compile() + LocalBlockchain deploy can be slow
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'CommonJS',
          target: 'ES2022',
          esModuleInterop: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          useDefineForClassFields: false,
          strict: false,
          isolatedModules: true,
        },
      },
    ],
    '^.+\\.js$': [
      'ts-jest',
      {
        tsconfig: {
          allowJs: true,
          checkJs: false,
          module: 'CommonJS',
          target: 'ES2022',
          esModuleInterop: true,
          isolatedModules: true,
        },
      },
    ],
  },
  transformIgnorePatterns: ['node_modules/(?!mina-fungible-token/)'],
};
