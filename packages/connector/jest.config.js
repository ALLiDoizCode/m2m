/** @type {import('jest').Config} */
module.exports = {
  displayName: 'connector',
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // Ignore cloud KMS backend tests - they require optional provider-specific packages
  // Ignore integration tests with missing type dependencies (future features)
  // Ignore acceptance tests (run separately)
  testPathIgnorePatterns: [
    '/node_modules/',
    'wallet-disaster-recovery\.test\.ts$',
    'agent-wallet-integration\.doc\.test\.ts$',
    'tigerbeetle-5peer-deployment\.test\.ts$',
    'test/acceptance/', // Acceptance tests (run separately)
    'test/unit/performance/', // Unit performance tests (timing-sensitive)
    // mina-deployment.test.ts runs via Jest (Story 34.9)
  ],
  testTimeout: 30000, // 30 second default timeout for integration tests
  maxWorkers: 2, // Reduce parallelism to avoid stack overflow with large mock test files
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!src/**/*.coverage.test.ts',
    '!src/**/__mocks__/**',
    '!src/index.ts', // Exclude index.ts (re-exports only)
    '!src/test-utils/**', // Exclude test utilities (not production code)
    '!src/main.ts', // Exclude entry point (orchestration only)
    '!src/cli/*.ts', // Exclude CLI tooling (interactive prompts, hard to unit test)
    '!src/wallet/wallet-db-schema.ts', // Pure SQL schema definitions
    '!src/security/rate-limit-config.ts', // Pure configuration schema
    '!src/routing/packet-worker.ts', // Placeholder/TODO
  ],
  // Coverage thresholds — staged approach to 90%
  // Current: 91.8% statements / 84.3% branches / 87.2% functions / 91.8% lines (connector package)
  // Achieved: packet-handler.ts, peer-discovery-service.ts, settlement-executor.ts at 100%
  // Admin-api.ts at 90.1% branches (3 unreachable dead-code spots remain)
  // connector-node.ts at 80.6% branches (large orchestration file, 2,530 lines)
  // Phase 2 target: 90% across all metrics
  coverageThreshold: {
    global: {
      branches: 82,
      functions: 85,
      lines: 90,
      statements: 90,
    },
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@toon-protocol/shared$': '<rootDir>/../shared/src/index.ts',
    '^@toon-protocol/mina-zkapp$': '<rootDir>/../mina-zkapp/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
    '^.+\\.m?js$': 'babel-jest',
  },
  // Allow transformation of ESM-only packages
  transformIgnorePatterns: ['node_modules/(?!(@toon-format|@libsql)/)'],
};
