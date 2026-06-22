#!/usr/bin/env node
/**
 * ILP Connector CLI/Process Entrypoint
 * Handles process lifecycle, signal handlers, and graceful shutdown
 * @packageDocumentation
 */

import { ConnectorNode, ConfigurationError, createLogger } from './lib';
import type { Logger } from 'pino';

// Export main function for testing
// `startConnectorMode` is the reusable in-process boot path (config load →
// ConnectorNode start → SIGTERM/SIGINT graceful shutdown). The `connector up`
// CLI command calls it directly instead of reimplementing ConnectorNode startup.
export { main, startConnectorMode };

/**
 * Main entry point
 * Initializes connector and handles startup
 */
async function main(): Promise<void> {
  // Get configuration file path from environment variable
  const configFile = process.env.CONFIG_FILE || './config.yaml';
  const logLevel = process.env.LOG_LEVEL || 'info';

  // Create temporary logger for startup (without telemetry)
  const logger = createLogger('connector-startup', logLevel);

  await startConnectorMode(configFile, logger);
}

/**
 * Start in standard connector mode
 */
async function startConnectorMode(configFile: string, logger: Logger): Promise<void> {
  // Create connector instance (configuration loaded inside constructor)
  let connectorNode: ConnectorNode;
  try {
    connectorNode = new ConnectorNode(configFile, logger);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      logger.error(
        {
          event: 'configuration_error',
          filePath: configFile,
          error: error.message,
        },
        'Configuration error'
      );
      console.error(`Configuration error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  /**
   * Graceful shutdown handler
   * Stops connector and exits process
   */
  async function shutdown(signal: string): Promise<void> {
    logger.info({ event: 'connector_shutdown_initiated', signal }, 'Shutdown signal received');
    try {
      await connectorNode.stop();
      logger.info({ event: 'connector_shutdown' }, 'Connector stopped');
      process.exit(0);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ event: 'connector_shutdown_failed', error: errorMessage }, 'Shutdown failed');
      process.exit(1);
    }
  }

  // Register signal handlers for graceful shutdown
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Handle uncaught exceptions
  process.on('uncaughtException', (error: Error) => {
    logger.error(
      {
        event: 'uncaught_exception',
        error: error.message,
        stack: error.stack,
      },
      'Uncaught exception'
    );
    void shutdown('uncaughtException');
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason: unknown) => {
    const errorMessage = reason instanceof Error ? reason.message : String(reason);
    logger.error(
      {
        event: 'unhandled_rejection',
        reason: errorMessage,
      },
      'Unhandled promise rejection'
    );
    void shutdown('unhandledRejection');
  });

  // Start connector
  try {
    await connectorNode.start();
    logger.info(
      {
        event: 'connector_started',
      },
      'Connector started successfully'
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      {
        event: 'connector_start_failed',
        error: errorMessage,
      },
      'Failed to start connector'
    );
    process.exit(1);
  }
}

// Run main entry point only when executed directly (not imported)
// Check if this file is the entry point (running as main script). We match on
// the `main.js`/`main.ts` entry filename rather than any path containing
// "connector" — the latter would spuriously fire when `startConnectorMode` is
// imported by the `connector` CLI bin (whose argv[1] path contains "connector").
const entry = process.argv[1] ?? '';
const isMainModule = require.main === module || /[/\\]main\.(js|ts)$/.test(entry);
if (isMainModule) {
  void main();
}
