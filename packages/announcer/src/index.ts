/**
 * Entrypoint: load config from the environment, start the announce loop, and
 * serve a tiny `GET /health` for docker-compose's healthcheck (mirrors
 * `packages/faucet`'s convention).
 *
 * @module index
 */

import { createServer } from 'node:http';
import pino from 'pino';
import { loadConfig } from './config';
import { AnnouncerService } from './service';

function main(): void {
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const config = loadConfig();
  const service = new AnnouncerService({ config, logger });

  const server = createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      const healthy = service.running && (service.lastResult === null || service.lastResult.ok);
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          running: service.running,
          pubkey: service.announcePubkey,
          lastResult: service.lastResult,
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(config.healthPort, () => {
    logger.info(
      { event: 'health_server_listening', port: config.healthPort },
      'Health endpoint listening'
    );
  });

  service.start();

  const shutdown = (signal: string): void => {
    logger.info({ event: 'shutdown', signal }, 'Shutting down');
    service.stop();
    server.close(() => process.exit(0));
    // Do not let a stuck server.close() hang the container forever.
    setTimeout(() => process.exit(0), 5000).unref?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
