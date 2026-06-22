#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Connector CLI
 *
 * Command-line interface for the ILP Connector. "Set up a connector as easily as
 * nginx, add an app as easily as an nginx server block." A thin shell over the
 * admin API for app/route management, plus an in-process standalone boot (`up`).
 *
 * Commands: setup, up (alias: start), app add|ls, route add|ls, health, validate.
 */

import { Command } from 'commander';
import { runOnboarding } from './onboarding-wizard';
import type { HealthCheckResponse } from './types';
import { buildAppCommand } from './commands/app';
import { buildRouteCommand } from './commands/route';
import { buildUpCommand } from './commands/up';

const program = new Command();

program
  .name('connector')
  .description('ILP Connector CLI - standalone setup and add-an-app management tool')
  .version('0.1.0');

/**
 * Setup command - Run the onboarding wizard
 */
program
  .command('setup')
  .description('Run the interactive onboarding wizard to configure your connector')
  .option('-o, --output <path>', 'Output path for the .env file', '.env')
  .action(async (options: { output: string }) => {
    try {
      await runOnboarding(options.output);
    } catch (error) {
      console.error('Setup failed:', (error as Error).message);
      process.exit(1);
    }
  });

/**
 * up command - Boot a standalone connector in-process (alias: start).
 * Reuses main.ts's startConnectorMode boot path (config load → ConnectorNode
 * start → SIGTERM/SIGINT graceful shutdown).
 */
const upCommand = buildUpCommand();
upCommand.aliases(['start']);
program.addCommand(upCommand);

/**
 * app command group - manage locally terminated apps ("server blocks").
 */
program.addCommand(buildAppCommand());

/**
 * route command group - manage the generic routing table.
 */
program.addCommand(buildRouteCommand());

/**
 * Health command - Check connector health status
 */
program
  .command('health')
  .description('Check the health status of a running connector')
  .option('-u, --url <url>', 'Health endpoint URL', 'http://localhost:8080/health')
  .action(async (options: { url: string }) => {
    try {
      console.log(`Checking health at: ${options.url}\n`);

      const response = await fetch(options.url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        console.log(`Status: UNHEALTHY (HTTP ${response.status})`);
        process.exit(1);
      }

      const health = (await response.json()) as HealthCheckResponse;

      console.log(`Status: ${health.status.toUpperCase()}`);

      if (health.version) {
        console.log(`Version: ${health.version}`);
      }

      if (health.uptime !== undefined) {
        const uptimeMinutes = Math.floor(health.uptime / 60);
        console.log(`Uptime: ${uptimeMinutes} minutes`);
      }

      if (health.dependencies) {
        console.log('\nDependencies:');
        for (const [name, dep] of Object.entries(health.dependencies)) {
          const latency = dep.latencyMs ? ` (${dep.latencyMs}ms)` : '';
          console.log(`  ${name}: ${dep.status}${latency}`);
        }
      }

      // Exit with appropriate code
      if (health.status === 'unhealthy') {
        process.exit(1);
      } else if (health.status === 'degraded') {
        process.exit(2);
      }
    } catch (error) {
      const err = error as Error;
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        console.log('Status: UNREACHABLE (timeout)');
      } else if (err.message?.includes('ECONNREFUSED')) {
        console.log('Status: UNREACHABLE (connection refused)');
        console.log('\nIs the connector running? Start with:');
        console.log('  docker-compose -f docker-compose-production.yml up -d');
      } else {
        console.log(`Status: ERROR (${err.message})`);
      }
      process.exit(1);
    }
  });

/**
 * Validate command - Validate configuration file
 */
program
  .command('validate')
  .description('Validate a configuration file')
  .argument('<file>', 'Path to the configuration file to validate')
  .action(async (file: string) => {
    try {
      // Check if file exists
      const fs = await import('fs/promises');
      await fs.access(file);

      // Try to read and parse
      const content = await fs.readFile(file, 'utf8');

      if (file.endsWith('.env')) {
        // Validate .env file
        const lines = content.split('\n');
        let errors = 0;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]?.trim() ?? '';
          if (line && !line.startsWith('#') && !line.includes('=')) {
            console.log(`Line ${i + 1}: Invalid format (missing =)`);
            errors++;
          }
        }

        if (errors === 0) {
          console.log('Configuration file is valid.');
        } else {
          console.log(`\nFound ${errors} error(s).`);
          process.exit(1);
        }
      } else if (file.endsWith('.yaml') || file.endsWith('.yml')) {
        // Validate YAML file
        const yaml = await import('js-yaml');
        yaml.load(content);
        console.log('Configuration file is valid YAML.');
      } else {
        console.log('Unknown file type. Supported: .env, .yaml, .yml');
        process.exit(1);
      }
    } catch (error) {
      const err = error as Error & { code?: string };
      if (err.code === 'ENOENT') {
        console.log(`File not found: ${file}`);
      } else {
        console.log(`Validation failed: ${err.message}`);
      }
      process.exit(1);
    }
  });

program.addHelpText(
  'after',
  `
Examples:
  # Boot a standalone connector from a config file
  $ connector up -c ./standalone.yaml

  # Add an app (nginx-style server block): terminate g.node.greet to a local upstream
  $ connector app add greet --upstream http://127.0.0.1:8080 --route g.node.greet \\
      --price 1000 --chains base,solana,mina

  # List terminated apps and generic routes
  $ connector app ls --json
  $ connector route ls

  # Add a transit route to a peer
  $ connector route add g.alice --next-hop alice-peer --priority 10

  # Check a running connector's health
  $ connector health -u http://localhost:8080/health

Networked commands (app, route) default to admin API http://localhost:8081 and
read the API key from --api-key or the ADMIN_API_KEY environment variable.
`
);

// Parse command line arguments
program.parse();
