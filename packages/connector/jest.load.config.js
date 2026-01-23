/** @type {import('jest').Config} */
const baseConfig = require('./jest.config');

module.exports = {
  ...baseConfig,
  displayName: 'load-test',
  testTimeout: 90000000, // 25 hours (24h test + 1h buffer)
  testMatch: ['**/test/acceptance/load-test*.test.ts'],
  // Load tests should run sequentially
  maxWorkers: 1,
  // Don't apply coverage thresholds to load tests
  coverageThreshold: undefined,
  // Disable verbose output for long-running tests
  verbose: false,
};
