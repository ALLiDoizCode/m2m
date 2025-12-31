/**
 * Dashboard Backend Entry Point
 * Starts the telemetry WebSocket server and HTTP server for static files
 * @packageDocumentation
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { TelemetryServer } from './telemetry-server.js';
import { logger } from './logger.js';

export const version = '0.1.0';

// Get server ports from environment variables or use defaults
const TELEMETRY_WS_PORT = parseInt(process.env.TELEMETRY_WS_PORT || '9000', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8080', 10);

// Create and start telemetry server
let telemetryServer: TelemetryServer | null = null;
let httpServer: any = null;

export async function main(): Promise<void> {
  try {
    // Start telemetry WebSocket server
    telemetryServer = new TelemetryServer(TELEMETRY_WS_PORT, logger);
    telemetryServer.start();

    // Start HTTP server for static files
    const app = express();

    // Get the directory path for static files
    // In production, static files are in dist/ and server is in dist/server/
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const staticDir = path.join(__dirname, '..');

    // Health check endpoint
    app.get('/health', (_req, res) => {
      res.status(200).json({ status: 'ok', version });
    });

    // Serve static files
    app.use(express.static(staticDir));

    // SPA fallback - serve index.html for all other routes
    app.get('*', (_req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });

    httpServer = app.listen(HTTP_PORT, () => {
      logger.info(`HTTP server listening on port ${HTTP_PORT}`);
    });

    logger.info('Dashboard backend started successfully');
  } catch (error) {
    logger.fatal('Failed to start dashboard backend', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler for SIGTERM and SIGINT signals
 */
function handleShutdown(signal: string): void {
  logger.info(`${signal} received, shutting down gracefully`);
  if (telemetryServer) {
    telemetryServer.stop();
  }
  if (httpServer) {
    httpServer.close(() => {
      logger.info('HTTP server closed');
    });
  }
  process.exit(0);
}

// Graceful shutdown handlers
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// Start server if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    logger.fatal('Unhandled error during startup', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    process.exit(1);
  });
}
