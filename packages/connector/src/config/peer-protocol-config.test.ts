/**
 * Config validation for the per-peer packet protocol (Epic 38, Story 38.1).
 *
 * Verifies {@link ConfigLoader.validatePeers}:
 * - accepts a valid `peerProtocol: 'ilp-http'` peer (httpUrl present, ws:// check skipped),
 * - rejects an `ilp-http` peer with no/invalid httpUrl,
 * - rejects an invalid peerProtocol enum,
 * - keeps the ws:// requirement for default/btp peers (backward compatible).
 *
 * Mock-free: writes real YAML to a temp dir and loads it through the public API.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigLoader, ConfigurationError } from './config-loader';

const writeConfig = (yaml: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-proto-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, yaml);
  return file;
};

const base = (peersBlock: string): string =>
  `nodeId: t\nbtpServerPort: 3000\nenvironment: development\n${peersBlock}\nroutes: []\n`;

describe('ConfigLoader — per-peer packet protocol (Epic 38)', () => {
  it('accepts an ilp-http peer with httpUrl (no ws:// url required)', () => {
    const file = writeConfig(
      base(
        `peers:\n  - id: httppeer\n    authToken: tok\n    peerProtocol: ilp-http\n    httpUrl: https://peer.example.com:3000\n`
      )
    );
    const config = ConfigLoader.loadConfig(file);
    const peer = config.peers.find((p) => p.id === 'httppeer')!;
    expect(peer.peerProtocol).toBe('ilp-http');
    expect(peer.httpUrl).toBe('https://peer.example.com:3000');
  });

  it('accepts an optional httpPath / httpTimeoutMs', () => {
    const file = writeConfig(
      base(
        `peers:\n  - id: hp\n    authToken: tok\n    peerProtocol: ilp-http\n    httpUrl: http://h:1\n    httpPath: /ilp/v1/packet\n    httpTimeoutMs: 5000\n`
      )
    );
    const config = ConfigLoader.loadConfig(file);
    const peer = config.peers.find((p) => p.id === 'hp')!;
    expect(peer.httpPath).toBe('/ilp/v1/packet');
    expect(peer.httpTimeoutMs).toBe(5000);
  });

  it('rejects an ilp-http peer with no httpUrl', () => {
    const file = writeConfig(
      base(`peers:\n  - id: hp\n    authToken: tok\n    peerProtocol: ilp-http\n`)
    );
    expect(() => ConfigLoader.loadConfig(file)).toThrow(ConfigurationError);
    expect(() => ConfigLoader.loadConfig(file)).toThrow(/requires httpUrl/);
  });

  it('rejects an ilp-http peer with a non-http httpUrl', () => {
    const file = writeConfig(
      base(
        `peers:\n  - id: hp\n    authToken: tok\n    peerProtocol: ilp-http\n    httpUrl: ws://nope:1\n`
      )
    );
    expect(() => ConfigLoader.loadConfig(file)).toThrow(/Must start with http/);
  });

  it('rejects an invalid peerProtocol enum', () => {
    const file = writeConfig(
      base(`peers:\n  - id: hp\n    url: ws://h:1\n    authToken: tok\n    peerProtocol: grpc\n`)
    );
    expect(() => ConfigLoader.loadConfig(file)).toThrow(/invalid peerProtocol/);
  });

  it('still enforces ws:// for default (btp) peers', () => {
    const file = writeConfig(
      base(`peers:\n  - id: btppeer\n    url: http://wrong:1\n    authToken: tok\n`)
    );
    expect(() => ConfigLoader.loadConfig(file)).toThrow(/Invalid WebSocket URL/);
  });

  it('a default peer (no peerProtocol) loads unchanged', () => {
    const file = writeConfig(
      base(`peers:\n  - id: btppeer\n    url: ws://h:3001\n    authToken: tok\n`)
    );
    const config = ConfigLoader.loadConfig(file);
    expect(config.peers[0]!.peerProtocol).toBeUndefined();
  });
});
