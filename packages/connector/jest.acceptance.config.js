/** @type {import('jest').Config} */
const baseConfig = require('./jest.config');

module.exports = {
  ...baseConfig,
  displayName: 'acceptance',
  testTimeout: 300000, // 5 minutes per test for acceptance tests
  testMatch: ['**/test/acceptance/**/*.test.ts'],
  // Remove test/acceptance/ from ignore patterns so acceptance tests can run
  testPathIgnorePatterns: baseConfig.testPathIgnorePatterns.filter(
    (p) => !p.includes('test/acceptance')
  ),
  // Acceptance tests may have longer setup/teardown
  setupFilesAfterEnv: [],
  // Don't apply coverage thresholds to acceptance tests
  coverageThreshold: undefined,
};
