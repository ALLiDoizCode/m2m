/* eslint-disable no-console */
/**
 * `connector up` — boot a standalone connector in-process from a config file.
 *
 * Foreground/blocking: starts a real {@link ConnectorNode} via the shared
 * {@link startConnectorMode} boot path exported from `main.ts` (config load →
 * ConnectorNode start → SIGTERM/SIGINT graceful shutdown). This does NOT
 * reimplement ConnectorNode startup — it is the same path the `connector`
 * process entrypoint uses, so behaviour (signal handling, graceful drain,
 * exit codes) is identical. No hub dependency: a bare standalone config (no
 * peers, settlement optional) boots fine.
 *
 * @module cli/commands/up
 */

import { Command } from 'commander';
import { startConnectorMode } from '../../main';
import { createLogger } from '../../utils/logger';

/** Build the `up` command. */
export function buildUpCommand(): Command {
  const up = new Command('up')
    .description('Boot a standalone connector in-process from a config file (foreground)')
    .option('-c, --config <path>', 'Path to the connector config (YAML)', 'config.yaml')
    .action(async (opts: { config: string }) => {
      const logLevel = process.env.LOG_LEVEL || 'info';
      const logger = createLogger('connector-cli-up', logLevel);
      console.log(`Starting connector with config: ${opts.config}`);
      // startConnectorMode installs SIGTERM/SIGINT handlers and starts the node.
      // It does not resolve on success — the process stays alive until a signal
      // triggers graceful shutdown (process.exit(0)).
      await startConnectorMode(opts.config, logger);
    });

  up.addHelpText(
    'after',
    `
Examples:
  # Boot a standalone connector (Ctrl-C / SIGTERM for graceful shutdown)
  $ connector up -c ./standalone.yaml

  # Use the default config.yaml in the current directory
  $ connector up
`
  );

  return up;
}
