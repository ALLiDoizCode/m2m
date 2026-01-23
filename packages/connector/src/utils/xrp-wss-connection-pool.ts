import { Logger } from 'pino';
import { Client } from 'xrpl';
import { ConnectionPool, ConnectionFactory } from './connection-pool';

/**
 * XRP WebSocket ConnectionFactory implementation for xrpl.js Client
 */
class XRPWSSConnectionFactory implements ConnectionFactory<Client> {
  async create(endpoint: string): Promise<Client> {
    const client = new Client(endpoint);
    await client.connect();
    return client;
  }

  async disconnect(client: Client): Promise<void> {
    await client.disconnect();
  }

  async healthCheck(client: Client): Promise<boolean> {
    try {
      // Verify WebSocket connection is responsive by pinging
      await client.request({
        command: 'ping',
      });
      return true;
    } catch (error) {
      return false;
    }
  }
}

/**
 * XRPWSSConnectionPool manages a pool of xrpl.js Client WebSocket connections
 * for load balancing across multiple XRP Ledger nodes.
 */
export class XRPWSSConnectionPool extends ConnectionPool<Client> {
  /**
   * Create an XRP WebSocket connection pool
   * @param wssUrls - Array of WebSocket endpoint URLs (e.g., ["wss://xrplcluster.com", "wss://s1.ripple.com"])
   * @param poolSize - Number of connections to create (default: 5)
   * @param logger - Pino logger instance
   */
  constructor(wssUrls: string[], poolSize: number, logger: Logger) {
    const factory = new XRPWSSConnectionFactory();

    super(
      {
        poolSize,
        endpoints: wssUrls,
      },
      factory,
      logger
    );
  }

  /**
   * Get an xrpl.js Client from the pool
   * Uses round-robin selection to distribute load across available connections.
   * Automatically reconnects unhealthy connections.
   * @returns xrpl.Client instance or null if no healthy connections available
   */
  getClient(): Client | null {
    const connection = this.getConnection();
    return connection ? connection.client : null;
  }
}
