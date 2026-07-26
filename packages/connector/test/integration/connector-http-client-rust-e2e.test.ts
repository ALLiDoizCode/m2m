/**
 * ConnectorHttpClient vs. a real Rust connector (issue #456)
 *
 * Spawns the actual compiled `connector` binary (`crates/connector-bin`,
 * the same Cargo workspace this repo builds via `cargo build --workspace`)
 * and drives it over the network with {@link ConnectorHttpClient} — no fake
 * server, no mocked packet handler. Fulfils the acceptance criterion "the
 * client is verified against a running Rust connector rather than a fake."
 *
 * Prerequisites:
 *   cargo build -p connector-bin
 *   (produces target/debug/connector; this suite skips itself if that
 *   binary is not present, matching the gating precedent set by
 *   `solana-provider.test.ts` for packages/solana-program's cargo build-sbf
 *   artifact.)
 *
 * @packageDocumentation
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import { spawn, type ChildProcessByStdio } from 'child_process';
import type { AddressInfo } from 'net';
import type { Readable } from 'stream';
import { PacketType, ILPErrorCode } from '@toon-protocol/shared';
import { ConnectorHttpClient } from '../../src/client/connector-http-client';

// connector-bin is a member of the root Cargo workspace, so build output
// lands in the workspace-root target/, not a per-crate one.
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../..');
const CONNECTOR_BIN = path.resolve(WORKSPACE_ROOT, 'target/debug/connector');
const CONNECTOR_BIN_EXISTS = fs.existsSync(CONNECTOR_BIN);
const describeRustConnector = CONNECTOR_BIN_EXISTS ? describe : describe.skip;

jest.setTimeout(30_000);

/** Starts a plain HTTP "app" behind the terminated route: echoes the
 * PREPARE's opaque data back and, when `fulfillment` is given, claims it via
 * the `TOON-Fulfillment` response header (connector-runtime's app_client.rs
 * contract) so the Rust connector's condition-verification gate accepts it. */
function startTestApp(fulfillment: Buffer): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.setHeader('TOON-Fulfillment', fulfillment.toString('hex'));
        res.writeHead(200);
        res.end(Buffer.concat([Buffer.from('app said: '), Buffer.concat(chunks)]));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/** Spawns the compiled connector binary with a config that routes
 * `g.example.app` to `appUrl`, and resolves once it logs the listen
 * address it actually bound (`client_edge_addr = "127.0.0.1:0"` picks a
 * free port), mirroring connector-bin's own black-box test harness
 * (`crates/connector-bin/tests/refuses_to_start.rs`). */
function spawnConnector(
  appUrl: string
): Promise<{ child: ChildProcessByStdio<null, Readable, Readable>; baseUrl: string }> {
  const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'connector-e2e-')), 'signer.key');
  fs.writeFileSync(keyFile, crypto.randomBytes(32));

  const configFile = path.join(path.dirname(keyFile), 'connector.toml');
  fs.writeFileSync(
    configFile,
    `
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "${keyFile}"

[[routes]]
prefix = "g.example.app"
handler_url = "${appUrl}"
`
  );

  const child = spawn(CONNECTOR_BIN, [configFile], { stdio: ['ignore', 'pipe', 'pipe'] });

  return new Promise((resolve, reject) => {
    let buffered = '';
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      for (const line of lines) {
        if (!line.includes('connector listening')) continue;
        try {
          const parsed = JSON.parse(line) as { fields?: { addr?: string } };
          const addr = parsed.fields?.addr;
          if (addr) {
            child.stdout.off('data', onData);
            resolve({ child, baseUrl: `http://${addr}` });
            return;
          }
        } catch {
          // Not a complete JSON line yet — keep buffering.
        }
      }
    };
    child.stdout.on('data', onData);
    child.on('exit', (code) => reject(new Error(`connector exited early with code ${code}`)));
  });
}

describeRustConnector('ConnectorHttpClient against a real Rust connector', () => {
  let appServer: http.Server;
  let connectorChild: ChildProcessByStdio<null, Readable, Readable>;

  afterEach(async () => {
    connectorChild?.kill();
    if (appServer) {
      await new Promise<void>((resolve) => appServer.close(() => resolve()));
    }
  });

  it('delivers a PREPARE to the app and returns a real, condition-verified FULFILL', async () => {
    const fulfillment = Buffer.alloc(32, 7);
    const executionCondition = crypto.createHash('sha256').update(fulfillment).digest();

    const app = await startTestApp(fulfillment);
    appServer = app.server;
    const connector = await spawnConnector(app.url);
    connectorChild = connector.child;

    const client = new ConnectorHttpClient({ baseUrl: connector.baseUrl });
    const result = await client.sendPacket({
      destination: 'g.example.app',
      amount: 100n,
      expiresAt: new Date(Date.now() + 60_000),
      data: Buffer.from('hello from ConnectorHttpClient'),
      executionCondition,
    });

    expect(result.type).toBe(PacketType.FULFILL);
    if (result.type === PacketType.FULFILL) {
      expect(Buffer.from(result.fulfillment ?? []).equals(fulfillment)).toBe(true);
      expect(result.data.toString()).toBe('app said: hello from ConnectorHttpClient');
    }
  });

  it('receives a real F02 REJECT for an unrouted destination', async () => {
    const app = await startTestApp(Buffer.alloc(32));
    appServer = app.server;
    const connector = await spawnConnector(app.url);
    connectorChild = connector.child;

    // A valid, non-expired execution condition is required to clear the
    // connector's eligibility gate (F01/R00) before route selection ever
    // runs (issue #417) — this test wants to reach the F02 "no route" path
    // specifically, not fail earlier on a missing condition.
    const executionCondition = crypto.createHash('sha256').update(Buffer.alloc(32)).digest();

    const client = new ConnectorHttpClient({ baseUrl: connector.baseUrl });
    const result = await client.sendPacket({
      destination: 'g.nowhere.to.be.found',
      amount: 1n,
      expiresAt: new Date(Date.now() + 60_000),
      executionCondition,
    });

    expect(result.type).toBe(PacketType.REJECT);
    if (result.type === PacketType.REJECT) {
      expect(result.code).toBe(ILPErrorCode.F02_UNREACHABLE);
    }
  });
});
