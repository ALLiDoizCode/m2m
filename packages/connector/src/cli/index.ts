#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * M2M Connector CLI
 *
 * Command-line interface for the M2M ILP Connector.
 * Provides commands for setup, starting the connector, and health checks.
 */

import { Command } from 'commander';
import { runOnboarding } from './onboarding-wizard';
import type { HealthCheckResponse } from './types';

const program = new Command();

program
  .name('m2m-connector')
  .description('M2M ILP Connector CLI - Production deployment and management tool')
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
 * Start command - Start the connector
 */
program
  .command('start')
  .description('Start the connector with existing configuration')
  .option('-c, --config <path>', 'Path to configuration file', 'config.yaml')
  .action(async (options: { config: string }) => {
    console.log(`Starting connector with config: ${options.config}`);
    console.log('');
    console.log('For production deployment, use Docker Compose:');
    console.log('  docker-compose -f docker-compose-production.yml up -d');
    console.log('');
    console.log('For development, run directly:');
    console.log('  npm run start --workspace=packages/connector');
    console.log('');
  });

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
          const line = lines[i].trim();
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

// Parse command line arguments
program.parse();
