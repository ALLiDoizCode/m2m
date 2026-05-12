/**
 * Integration tests for per-peer transport selection
 * (per-peer-transport tech spec, Task 11 / AC-4, AC-8, AC-12).
 *
 * Real `ConnectorNode`, real `ConfigLoader`, real local WS echo helper,
 * real in-process SOCKS5 proxy (helpers/socks5-contract-fixture.ts). **No
 * mocks** (AC-7).
 *
 * Covers three independent test cases:
 *   1. SDK Error path on `ConnectorNode.registerPeer({ transport: 'socks5' })`
 *      against a direct-global connector.
 *   2. YAML round-trip — `transport: 'direct'` on a peer flows through
 *      ConfigLoader → ConnectorConfig.peers[i].transport → the runtime
 *      `Peer` literal at `connector-node.ts:1244` (AC-8 / F13).
 *   3. ConfigLoader rejection — YAML with `transport: 'socks5'` on a
 *      direct-global connector throws `ConfigurationError` (AC-12).
 */

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { WebSocketServer } from 'ws';
import pino from 'pino';

import { ConnectorNode } from '../../src/core/connector-node';
import { ConfigLoader, ConfigurationError } from '../../src/config/config-loader';
import { startSocks5Proxy, type RunningProxy } from '../helpers/socks5-contract-fixture';
import { BTPMessageType, type BTPMessage, type BTPData } from '../../src/btp/btp-types';
import { parseBTPMessage, serializeBTPMessage } from '../../src/btp/btp-message-parser';
import type { Logger } from '../../src/utils/logger';

jest.setTimeout(45_000);

function silentLogger(): Logger {
  return pino({ level: 'silent' }) as unknown as Logger;
}

/**
 * Local WS auth-echo sink — accepts BTPClient AUTH and replies with a
 * matching RESPONSE so `BTPClient.connect()` resolves. Sufficient to
 * exercise the "connected: true" assertion path without a real BTPServer.
 */
async function startWsAuthSink(): Promise<{
  url: string;
  port: number;
  close: () => Promise<void>;
}> {
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws) => {
    ws.on('message', (data: Buffer) => {
      try {
        const msg = parseBTPMessage(data);
        const reply: BTPMessage = {
          type: BTPMessageType.RESPONSE,
          requestId: msg.requestId,
          data: { protocolData: [] } as BTPData,
        };
        ws.send(serializeBTPMessage(reply));
      } catch {
        /* swallow */
      }
    });
    ws.on('error', () => {
      /* swallow */
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => httpServer.close(() => resolve()));
      }),
  };
}

async function pickFreePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

describe('Per-peer transport — integration (Task 11)', () => {
  describe('Case 1 — SDK Error path on registerPeer({ transport: socks5 }) (AC-4)', () => {
    let node: ConnectorNode;
    let btpPort: number;
    let adminPort: number;
    let healthPort: number;

    beforeAll(async () => {
      btpPort = await pickFreePort();
      adminPort = await pickFreePort();
      healthPort = await pickFreePort();

      node = new ConnectorNode(
        {
          nodeId: 'sdk-error-node',
          btpServerPort: btpPort,
          healthCheckPort: healthPort,
          logLevel: 'warn',
          environment: 'development',
          adminApi: { enabled: true, port: adminPort, host: '127.0.0.1' },
          peers: [],
          routes: [],
          transport: { type: 'direct' },
        },
        silentLogger()
      );
      await node.start();
    });

    afterAll(async () => {
      await node?.stop().catch(() => undefined);
    });

    it('rejects with Error whose message matches the documented string and the peer is NOT registered', async () => {
      await expect(
        node.registerPeer({
          id: 'rejected-peer',
          url: `ws://127.0.0.1:${btpPort + 1}`,
          authToken: '',
          transport: 'socks5',
        })
      ).rejects.toThrow(/^transport: 'socks5' requires connector-level transport\.type 'socks5'$/);

      // Cross-surface invariant: the admin GET /peers does NOT list it.
      const res = await fetch(`http://127.0.0.1:${adminPort}/admin/peers`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        peers: Array<{ id: string }>;
      };
      expect(body.peers.find((p) => p.id === 'rejected-peer')).toBeUndefined();
    });
  });

  describe('Case 2 — YAML round-trip honors transport: direct on a socks5-global connector (AC-8, F13)', () => {
    let proxy: RunningProxy;
    let sink: Awaited<ReturnType<typeof startWsAuthSink>>;
    let tmpDir: string;
    let configPath: string;
    let node: ConnectorNode | undefined;
    let adminPort: number;

    beforeAll(async () => {
      proxy = await startSocks5Proxy();
      sink = await startWsAuthSink();

      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'per-peer-yaml-'));

      const btpPort = await pickFreePort();
      adminPort = await pickFreePort();
      const healthPort = await pickFreePort();

      // socks5h:// is the required scheme (DNS-via-proxy, no .anon leaks).
      const yaml = [
        `nodeId: yaml-roundtrip-node`,
        `btpServerPort: ${btpPort}`,
        `healthCheckPort: ${healthPort}`,
        `logLevel: warn`,
        `adminApi:`,
        `  enabled: true`,
        `  port: ${adminPort}`,
        `  host: 127.0.0.1`,
        `transport:`,
        `  type: socks5`,
        `  socksProxy: socks5h://127.0.0.1:${proxy.port}`,
        `  externalUrl: ws://127.0.0.1:${btpPort}`,
        `  managed: false`,
        `peers:`,
        `  - id: direct-sibling`,
        `    url: ${sink.url}`,
        `    authToken: ''`,
        `    transport: direct`,
        `routes: []`,
        ``,
      ].join('\n');
      configPath = path.join(tmpDir, 'connector.yaml');
      await fs.promises.writeFile(configPath, yaml);
    });

    afterAll(async () => {
      await node?.stop().catch(() => undefined);
      await sink?.close().catch(() => undefined);
      await proxy?.stop().catch(() => undefined);
      if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    it('ConfigLoader.loadConfig() preserves peer.transport === direct on the returned config', async () => {
      const config = ConfigLoader.loadConfig(configPath);
      expect(config.peers).toHaveLength(1);
      expect(config.peers[0]!.transport).toBe('direct');
      expect(config.transport?.type).toBe('socks5');
    });

    it('ConnectorNode.start() with the YAML config dials the direct-override peer via WS (no SOCKS5 dial)', async () => {
      const config = ConfigLoader.loadConfig(configPath);
      node = new ConnectorNode(config, silentLogger());
      await node.start();

      // Poll GET /admin/peers until the direct-sibling peer reports connected.
      const deadline = Date.now() + 10_000;
      let lastBody: unknown = null;
      while (Date.now() < deadline) {
        const res = await fetch(`http://127.0.0.1:${adminPort}/admin/peers`);
        if (res.ok) {
          const body = (await res.json()) as {
            peers: Array<{
              id: string;
              connected: boolean;
              transport?: 'direct' | 'socks5';
            }>;
          };
          lastBody = body;
          const entry = body.peers.find((p) => p.id === 'direct-sibling');
          if (entry?.connected) {
            expect(entry.transport).toBe('direct');
            // The SOCKS5 proxy must NOT have observed any CONNECT for the
            // direct-sibling peer (proves no SOCKS5 dial happened).
            expect(proxy.connects).toHaveLength(0);
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(
        `direct-sibling peer did not reach connected:true within 10s; last admin response: ${JSON.stringify(lastBody)}`
      );
    });
  });

  describe('Case 3 — ConfigLoader rejects peer.transport: socks5 on a direct-global connector (AC-12)', () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'per-peer-yaml-bad-'));
    });

    afterAll(async () => {
      if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    it('throws ConfigurationError with the documented message', async () => {
      const badYaml = [
        `nodeId: bad-yaml-node`,
        `btpServerPort: 12345`,
        `logLevel: warn`,
        `transport:`,
        `  type: direct`,
        `peers:`,
        `  - id: bad-peer`,
        `    url: ws://127.0.0.1:12346`,
        `    authToken: ''`,
        `    transport: socks5`,
        `routes: []`,
        ``,
      ].join('\n');
      const badPath = path.join(tmpDir, 'bad.yaml');
      await fs.promises.writeFile(badPath, badYaml);

      expect(() => ConfigLoader.loadConfig(badPath)).toThrow(ConfigurationError);
      expect(() => ConfigLoader.loadConfig(badPath)).toThrow(
        /peer 'bad-peer': transport: 'socks5' requires connector-level transport\.type 'socks5'/
      );
    });

    it('also rejects an invalid enum value', async () => {
      const badYaml = [
        `nodeId: bad-yaml-node-2`,
        `btpServerPort: 12347`,
        `logLevel: warn`,
        `transport:`,
        `  type: direct`,
        `peers:`,
        `  - id: bad-peer-enum`,
        `    url: ws://127.0.0.1:12348`,
        `    authToken: ''`,
        `    transport: tor`,
        `routes: []`,
        ``,
      ].join('\n');
      const badPath = path.join(tmpDir, 'bad-enum.yaml');
      await fs.promises.writeFile(badPath, badYaml);

      expect(() => ConfigLoader.loadConfig(badPath)).toThrow(
        /peer 'bad-peer-enum': invalid transport value 'tor' \(must be 'direct' or 'socks5'\)/
      );
    });
  });
});
