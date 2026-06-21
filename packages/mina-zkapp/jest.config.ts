/** @type {import('jest').Config} */
export default {
  displayName: 'mina-zkapp',
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 60000, // o1js operations can be slow even with proofsEnabled: false
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
    // mina-fungible-token ships ESM (.js with `export`); compile it to CJS.
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
  // o1js ships a CJS build (loaded as-is); mina-fungible-token is ESM, so it must
  // NOT be ignored — it gets compiled to CJS by the .js transform above.
  transformIgnorePatterns: ['node_modules/(?!mina-fungible-token/)'],
};
