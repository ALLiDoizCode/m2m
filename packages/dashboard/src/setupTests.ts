// Jest setup file for React Testing Library
import '@testing-library/jest-dom';

// Setup WebSocket mock globally
import { MockWebSocket } from './__mocks__/WebSocket';
(globalThis as typeof globalThis).WebSocket = MockWebSocket as unknown as typeof WebSocket;

// Mock import.meta for Vite environment variables in tests
// @ts-expect-error - import.meta doesn't exist in Jest/Node environment
globalThis.import = {
  meta: {
    env: {
      VITE_TELEMETRY_WS_URL: 'ws://localhost:9000',
    },
  },
};
