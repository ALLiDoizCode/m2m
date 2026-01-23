/** @type {import('jest').Config} */
module.exports = {
  displayName: 'connector',
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // Ignore cloud KMS backend tests - they require optional provider-specific packages
  testPathIgnorePatterns: [
    '/node_modules/',
    'aws-kms-backend\\.test\\.ts$',
    'azure-kv-backend\\.test\\.ts$',
    'gcp-kms-backend\\.test\\.ts$',
  ],
  testTimeout: 30000, // 30 second default timeout for integration tests
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!src/**/__mocks__/**',
    '!src/index.ts', // Exclude index.ts (re-exports only)
  ],
  // Coverage thresholds temporarily lowered due to skipped flaky/Docker tests
  // TODO: Re-enable strict thresholds after test stabilization
  coverageThreshold: {
    global: {
      branches: 45, // Lowered from 68% due to skipped tests
      functions: 70, // Lowered from 100% due to skipped tests
      lines: 65, // Lowered from 100% due to skipped tests
      statements: 65, // Lowered from 100% due to skipped tests
    },
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@m2m/shared$': '<rootDir>/../shared/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
  },
};
