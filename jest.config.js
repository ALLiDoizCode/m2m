/** @type {import('jest').Config} */
module.exports = {
  projects: [
    '<rootDir>/packages/connector',
    '<rootDir>/packages/shared',
    '<rootDir>/packages/mina-zkapp',
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/__mocks__/**',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'lcov', 'html'],
};
