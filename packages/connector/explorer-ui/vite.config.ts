/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(() => {
  const agentPort = process.env.AGENT_PORT;
  const targetPort = agentPort || '3001';
  const target = `http://localhost:${targetPort}`;
  const wsTarget = `ws://localhost:${targetPort}`;

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      outDir: '../dist/explorer-ui',
      emptyOutDir: true,
    },
    server: {
      proxy: {
        '/api': target,
        '/ws': {
          target: wsTarget,
          ws: true,
        },
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
    },
  };
});
