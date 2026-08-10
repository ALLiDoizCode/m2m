import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config';

const VALID_HEX = 'a'.repeat(64);

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ANNOUNCER_IDENTITY_SECRET_KEY_HEX: VALID_HEX,
    ANNOUNCER_RELAY_URLS: 'wss://relay.devnet.toonprotocol.dev',
    ...overrides,
  };
}

test('loadConfig: applies documented defaults when nothing else is set', () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.rustEdgeUrl, 'http://connector-rust:4000');
  assert.equal(config.ilpAddress, 'g.toon');
  assert.deepEqual(config.ilpAddresses, ['g.toon']);
  assert.equal(config.httpEndpoint, 'https://proxy.devnet.toonprotocol.dev/rust/ilp');
  assert.equal(config.btpEndpoint, 'wss://proxy.devnet.toonprotocol.dev/rust/ilp/btp');
  assert.equal(config.assetCode, 'USDC');
  assert.equal(config.assetScale, 6);
  assert.equal(config.solanaChainId, 'solana:devnet');
  assert.equal(config.refreshIntervalSecs, 300);
  assert.equal(config.ttlSeconds, 600); // 2x refresh, matching the retired TS service's convention
  assert.equal(config.healthPort, 8090);
  // No .relay/.store addresses configured -> route hints fall back to the primary address.
  assert.equal(config.routePublish, 'g.toon');
  assert.equal(config.routeStore, 'g.toon');
});

test('loadConfig: resolves the secret key from the hex env var', () => {
  const config = loadConfig(baseEnv());
  assert.equal(Buffer.from(config.secretKey).toString('hex'), VALID_HEX);
});

test('loadConfig: resolves the secret key from a file when the file var is set instead', () => {
  const dir = mkdtempSync(join(tmpdir(), 'announcer-test-'));
  const keyFile = join(dir, 'announce.key');
  writeFileSync(keyFile, `${VALID_HEX}\n`); // trailing newline, like a real key file
  const config = loadConfig(
    baseEnv({
      ANNOUNCER_IDENTITY_SECRET_KEY_HEX: undefined,
      ANNOUNCER_IDENTITY_SECRET_KEY_FILE: keyFile,
    })
  );
  assert.equal(Buffer.from(config.secretKey).toString('hex'), VALID_HEX);
});

test('loadConfig: throws when neither secret key source is configured', () => {
  assert.throws(
    () => loadConfig(baseEnv({ ANNOUNCER_IDENTITY_SECRET_KEY_HEX: undefined })),
    /No announce identity configured/
  );
});

test('loadConfig: throws when both secret key sources are configured (ambiguous)', () => {
  assert.throws(
    () => loadConfig(baseEnv({ ANNOUNCER_IDENTITY_SECRET_KEY_FILE: '/dev/null' })),
    /exactly one of/
  );
});

test('loadConfig: throws on a malformed hex secret key', () => {
  assert.throws(
    () => loadConfig(baseEnv({ ANNOUNCER_IDENTITY_SECRET_KEY_HEX: 'not-hex' })),
    /64 hex chars/
  );
});

test('loadConfig: derives publish/store route hints from .relay/.store suffixes', () => {
  const config = loadConfig(
    baseEnv({ ANNOUNCER_ILP_ADDRESSES: 'g.toon,g.toon.relay,g.toon.ario,g.toon.store' })
  );
  assert.equal(config.routePublish, 'g.toon.relay');
  assert.equal(config.routeStore, 'g.toon.store');
  assert.deepEqual(config.ilpAddresses, ['g.toon', 'g.toon.relay', 'g.toon.ario', 'g.toon.store']);
});

test('loadConfig: falls back to .ario when no .store address is present', () => {
  const config = loadConfig(
    baseEnv({ ANNOUNCER_ILP_ADDRESSES: 'g.toon,g.toon.relay,g.toon.ario' })
  );
  assert.equal(config.routeStore, 'g.toon.ario');
});

test('loadConfig: explicit ANNOUNCER_ROUTE_PUBLISH/STORE override the derived hints', () => {
  const config = loadConfig(
    baseEnv({
      ANNOUNCER_ILP_ADDRESSES: 'g.toon,g.toon.relay,g.toon.store',
      ANNOUNCER_ROUTE_PUBLISH: 'g.toon.custom-relay',
      ANNOUNCER_ROUTE_STORE: 'g.toon.custom-store',
    })
  );
  assert.equal(config.routePublish, 'g.toon.custom-relay');
  assert.equal(config.routeStore, 'g.toon.custom-store');
});

test('loadConfig: probeRoutes defaults to ilpAddresses when unset', () => {
  const config = loadConfig(baseEnv({ ANNOUNCER_ILP_ADDRESSES: 'g.toon,g.toon.relay' }));
  assert.deepEqual(config.probeRoutes, ['g.toon', 'g.toon.relay']);
});

test('loadConfig: an explicit ANNOUNCER_PROBE_ROUTES overrides the default', () => {
  const config = loadConfig(
    baseEnv({
      ANNOUNCER_ILP_ADDRESSES: 'g.toon,g.toon.relay',
      ANNOUNCER_PROBE_ROUTES: 'g.toon.relay',
    })
  );
  assert.deepEqual(config.probeRoutes, ['g.toon.relay']);
});

test('loadConfig: relayPublicUrl defaults to the first ANNOUNCER_RELAY_URLS entry', () => {
  const config = loadConfig(baseEnv({ ANNOUNCER_RELAY_URLS: 'wss://a,wss://b' }));
  assert.equal(config.relayPublicUrl, 'wss://a');
  assert.deepEqual(config.relayUrls, ['wss://a', 'wss://b']);
});

test('loadConfig: relayPublicUrl never falls back to an http(s) publish entry', () => {
  // http entries are the relay's PRIVATE write ingress — advertising one as
  // the free-read relayUrl would leak an internal, unreachable endpoint.
  const internalOnly = loadConfig(baseEnv({ ANNOUNCER_RELAY_URLS: 'http://relay:3100' }));
  assert.equal(internalOnly.relayPublicUrl, undefined);

  const mixed = loadConfig(
    baseEnv({ ANNOUNCER_RELAY_URLS: 'http://relay:3100,wss://public.example' })
  );
  assert.equal(mixed.relayPublicUrl, 'wss://public.example');

  const explicit = loadConfig(
    baseEnv({
      ANNOUNCER_RELAY_URLS: 'http://relay:3100',
      ANNOUNCER_RELAY_PUBLIC_URL: 'wss://public.example',
    })
  );
  assert.equal(explicit.relayPublicUrl, 'wss://public.example');
});

test('loadConfig: an explicit ANNOUNCER_TTL_SECS overrides the 2x-refresh default', () => {
  const config = loadConfig(
    baseEnv({ ANNOUNCER_REFRESH_INTERVAL_SECS: '60', ANNOUNCER_TTL_SECS: '90' })
  );
  assert.equal(config.refreshIntervalSecs, 60);
  assert.equal(config.ttlSeconds, 90);
});

test('loadConfig: rejects a non-positive refresh interval', () => {
  assert.throws(
    () => loadConfig(baseEnv({ ANNOUNCER_REFRESH_INTERVAL_SECS: '0' })),
    /positive number/
  );
});

test('loadConfig: notice is undefined when no ANNOUNCER_NOTICE_* var is set — the common case', () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.notice, undefined);
});

test('loadConfig: a fully configured notice is carried through, defaulting severity to info', () => {
  const config = loadConfig(
    baseEnv({
      ANNOUNCER_NOTICE_ID: 'maintenance-2026-08',
      ANNOUNCER_NOTICE_SUMMARY: 'Scheduled maintenance this weekend',
      ANNOUNCER_NOTICE_URL: 'https://example.com/notices/maintenance-2026-08',
    })
  );
  assert.deepEqual(config.notice, {
    id: 'maintenance-2026-08',
    severity: 'info',
    summary: 'Scheduled maintenance this weekend',
    url: 'https://example.com/notices/maintenance-2026-08',
  });
});

test('loadConfig: an explicit ANNOUNCER_NOTICE_SEVERITY overrides the info default', () => {
  const config = loadConfig(
    baseEnv({
      ANNOUNCER_NOTICE_ID: 'fee-change-2026-08',
      ANNOUNCER_NOTICE_SEVERITY: 'action-required',
      ANNOUNCER_NOTICE_SUMMARY: 'Route prices are changing',
      ANNOUNCER_NOTICE_URL: 'https://example.com/notices/fee-change',
    })
  );
  assert.equal(config.notice?.severity, 'action-required');
});

test('loadConfig: throws when notice config is only partially set', () => {
  assert.throws(
    () => loadConfig(baseEnv({ ANNOUNCER_NOTICE_ID: 'only-an-id' })),
    /ANNOUNCER_NOTICE_ID, ANNOUNCER_NOTICE_SUMMARY and ANNOUNCER_NOTICE_URL must all be set together/
  );
  assert.throws(
    () =>
      loadConfig(
        baseEnv({
          ANNOUNCER_NOTICE_ID: 'partial',
          ANNOUNCER_NOTICE_SUMMARY: 'missing the url',
        })
      ),
    /must all be set together/
  );
});

test('loadConfig: throws on an unrecognized ANNOUNCER_NOTICE_SEVERITY rather than announcing a bad value', () => {
  assert.throws(
    () =>
      loadConfig(
        baseEnv({
          ANNOUNCER_NOTICE_ID: 'bad-severity',
          ANNOUNCER_NOTICE_SEVERITY: 'urgent',
          ANNOUNCER_NOTICE_SUMMARY: 'summary',
          ANNOUNCER_NOTICE_URL: 'https://example.com/n',
        })
      ),
    /ANNOUNCER_NOTICE_SEVERITY must be "info" or "action-required"/
  );
});
