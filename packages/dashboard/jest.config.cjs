/** @type {import('jest').Config} */
module.exports = {
  projects: [
    // Frontend tests (React components, hooks)
    {
      displayName: 'dashboard-frontend',
      preset: 'ts-jest',
      testEnvironment: 'jsdom',
      roots: ['<rootDir>/src'],
      testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
      collectCoverageFrom: [
        'src/**/*.{ts,tsx}',
        '!src/**/*.d.ts',
        '!src/**/*.test.{ts,tsx}',
        '!src/**/__mocks__/**',
        '!src/main.tsx',
        '!src/setupTests.ts',
      ],
      moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
      transform: {
        '^.+\\.(ts|tsx)$': [
          'ts-jest',
          {
            tsconfig: {
              jsx: 'react-jsx',
              esModuleInterop: true,
              module: 'esnext',
              moduleResolution: 'bundler',
            },
          },
        ],
      },
      moduleNameMapper: {
        '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
        '^react-cytoscapejs$': '<rootDir>/src/__mocks__/react-cytoscapejs.tsx',
        '^react-virtuoso$': '<rootDir>/src/__mocks__/react-virtuoso.tsx',
        '^@/(.*)$': '<rootDir>/src/$1',
      },
      setupFilesAfterEnv: ['<rootDir>/src/setupTests.ts'],
    },
    // Backend tests (Node.js server)
    {
      displayName: 'dashboard-backend',
      preset: 'ts-jest',
      testEnvironment: 'node',
      roots: ['<rootDir>/server'],
      testMatch: ['<rootDir>/server/**/*.test.ts'],
      collectCoverageFrom: [
        'server/**/*.ts',
        '!server/**/*.d.ts',
        '!server/**/*.test.ts',
      ],
      moduleFileExtensions: ['ts', 'js', 'json'],
      transform: {
        '^.+\\.ts$': [
          'ts-jest',
          {
            tsconfig: '<rootDir>/tsconfig.server.json',
            useESM: true,
          },
        ],
      },
      extensionsToTreatAsEsm: ['.ts'],
      moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
      },
    },
  ],
  coverageThreshold: {
    global: {
      branches: 45,
      functions: 50,
      lines: 60,
      statements: 60,
    },
  },
};
