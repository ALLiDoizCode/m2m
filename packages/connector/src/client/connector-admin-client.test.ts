/**
 * Tests for ConnectorAdminClient, driven against the real admin router mounted
 * on an ephemeral HTTP server (no fetch mocking — the client's own fetch path
 * is exercised end-to-end over the loopback interface).
 */

import express, { Express } from 'express';
import type { Server } from 'http';
import { createAdminRouter, AdminAPIConfig } from '../http/admin-api';
import type { Logger } from 'pino';
import type { RoutingTable } from '../routing/routing-table';
import type { BTPClientManager } from '../btp/btp-client-manager';
import { ConnectorAdminClient, ConnectorAdminError } from './connector-admin-client';

describe('ConnectorAdminClient', () => {
  let server: Server;
  let baseUrl: string;
  let mockRoutingTable: jest.Mocked<RoutingTable>;
  let mockBTPClientManager: jest.Mocked<BTPClientManager>;
  let client: ConnectorAdminClient;

  beforeEach(async () => {
    mockRoutingTable = {
      addRoute: jest.fn(),
      removeRoute: jest.fn(),
      getAllRoutes: jest.fn().mockReturnValue([]),
    } as unknown as jest.Mocked<RoutingTable>;

    mockBTPClientManager = {
      addPeer: jest.fn().mockResolvedValue(undefined),
      removePeer: jest.fn().mockResolvedValue(undefined),
      getPeerIds: jest.fn().mockReturnValue([]),
      getPeerStatus: jest.fn().mockReturnValue(new Map()),
      isConnected: jest.fn().mockReturnValue(true),
      getPeerTransport: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<BTPClientManager>;

    const mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
      fatal: jest.fn(),
      trace: jest.fn(),
      level: 'info',
    } as unknown as jest.Mocked<Logger>;

    const config: AdminAPIConfig = {
      routingTable: mockRoutingTable,
      btpClientManager: mockBTPClientManager,
      logger: mockLogger,
      nodeId: 'test-node',
      apiKey: 'secret-key',
    };

    const app: Express = express();
    app.use('/admin', await createAdminRouter(config));

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    client = new ConnectorAdminClient({ baseUrl, apiKey: 'secret-key' });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('lists routes through the typed client', async () => {
    mockRoutingTable.getAllRoutes.mockReturnValue([
      { prefix: 'g.connector.relay', nextHop: 'relay', priority: 0 },
    ]);
    const result = (await client.listRoutes()) as { routes: Array<{ prefix: string }> };
    expect(result.routes).toEqual([{ prefix: 'g.connector.relay', nextHop: 'relay', priority: 0 }]);
  });

  it('adds a route through the typed client', async () => {
    await client.addRoute({ prefix: 'g.connector.swap', nextHop: 'swap', priority: 3 });
    expect(mockRoutingTable.addRoute).toHaveBeenCalledWith('g.connector.swap', 'swap', 3);
  });

  it('removes a peer through the typed client', async () => {
    mockBTPClientManager.getPeerIds.mockReturnValue(['relay']);
    await client.removePeer('relay');
    expect(mockBTPClientManager.removePeer).toHaveBeenCalledWith('relay');
  });

  it('throws ConnectorAdminError with status + body on a 4xx', async () => {
    await expect(client.addRoute({ prefix: 'bad prefix', nextHop: 'x' })).rejects.toMatchObject({
      name: 'ConnectorAdminError',
      status: 400,
    });
  });

  it('rejects when the API key is missing (401/403)', async () => {
    const noKeyClient = new ConnectorAdminClient({ baseUrl });
    let caught: unknown;
    try {
      await noKeyClient.listRoutes();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConnectorAdminError);
    expect([401, 403]).toContain((caught as ConnectorAdminError).status);
  });
});
