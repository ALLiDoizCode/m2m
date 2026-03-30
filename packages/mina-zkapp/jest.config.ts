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
  },
  // o1js is ESM-native; allow transformation
  transformIgnorePatterns: ['node_modules/(?!o1js/)'],
};
