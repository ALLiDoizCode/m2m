/**
 * Registry restart-survival integration test.
 *
 * Boots a real (routing-only, no chains) ConnectorNode, registers a runtime
 * peer + route through the programmatic API, stops it, then boots a SECOND node
 * with the same nodeId (hence the same `./data/registry-<nodeId>.db`) and
 * asserts the runtime peer/route were replayed from the persistent registry.
 *
 * This is the end-to-end proof of the Phase-1 persistence + boot-reconcile path
 * (`ConnectorNode._openRegistryStore` / `_reconcileRegistry`), replacing the old
 * "re-POST the relay route after a restart" RUNBOOK recovery. Infra-free: no
 * Docker, no chain containers — settlement is disabled so start() boots in
 * routing-only mode.
 *
 * @packageDocumentation
 */

import * as fs from 'fs';
import pino from 'pino';
import { ConnectorNode } from '../../src/core/connector-node';
import type { ConnectorConfig } from '../../src/config/types';

// Stable nodeId so both boots share the same registry DB file; uniqueness comes
// from cleaning the file before/after rather than from the id (keeps the ILP
// self-address — `g.<nodeId>` — clean).
const NODE_ID = 'restartregistry';
const REGISTRY_DB = `./data/registry-${NODE_ID}.db`;
const SELF_PREFIX = `g.${NODE_ID}`;

const silentLogger = pino({ level: 'silent' });
const basePort = 41000 + Math.floor(Math.random() * 8000);

function routingOnlyConfig(btpServerPort: number): ConnectorConfig {
  return {
    nodeId: NODE_ID,
    btpServerPort,
    healthCheckPort: btpServerPort + 1,
    logLevel: 'error',
    environment: 'development',
    peers: [],
    // A local self-route so the connector has an own-address subtree; this is
    // what relation↔route validation and the child auto-route key on.
    routes: [{ prefix: SELF_PREFIX, nextHop: NODE_ID, priority: 0 }],
    adminApi: { enabled: false },
  } as ConnectorConfig;
}

function rmRegistryDb(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${REGISTRY_DB}${suffix}`, { force: true });
    } catch {
      // ignore
    }
  }
}

describe('Registry restart survival (routing-only, in-process)', () => {
  jest.setTimeout(60_000);

  let nodeA: ConnectorNode | null = null;
  let nodeB: ConnectorNode | null = null;

  beforeAll(() => rmRegistryDb());

  afterAll(async () => {
    for (const node of [nodeA, nodeB]) {
      try {
        await node?.stop();
      } catch {
        // swallow to avoid masking assertions
      }
    }
    rmRegistryDb();
  });

  it('replays a runtime-added peer + route across a restart', async () => {
    // ── Boot A, register a runtime child peer (auto-derives g.<self>.relay) ──
    nodeA = new ConnectorNode(routingOnlyConfig(basePort), silentLogger);
    await nodeA.start();

    await nodeA.registerPeer({
      id: 'relay',
      // Points at a non-listening port; BTP connect retries in the background
      // and never resolves, which is fine — registration + persistence do not
      // depend on the connection succeeding.
      url: `ws://127.0.0.1:${basePort + 500}`,
      authToken: 'token',
      relation: 'child',
    });

    // Sanity: the route exists on A before restart.
    expect(nodeA.listRoutes().map((r) => r.prefix)).toContain(`${SELF_PREFIX}.relay`);

    await nodeA.stop();
    nodeA = null;

    // ── Boot B with the same nodeId → same registry DB → replay ──
    nodeB = new ConnectorNode(routingOnlyConfig(basePort + 2), silentLogger);
    await nodeB.start();

    const routes = nodeB.listRoutes();
    const relayRoute = routes.find((r) => r.prefix === `${SELF_PREFIX}.relay`);
    expect(relayRoute).toBeDefined();
    expect(relayRoute?.nextHop).toBe('relay');

    const peerIds = nodeB.listPeers().map((p) => p.id);
    expect(peerIds).toContain('relay');
  });
});
