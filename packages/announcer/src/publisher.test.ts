import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { publishToRelay, publishToRelays } from './publisher';
import type { WebSocketLike } from './publisher';
import type { NostrEvent } from 'nostr-tools';

const logger = pino({ level: 'silent' });

const EVENT = {
  id: 'abc123',
  pubkey: 'p1',
  created_at: 1000,
  kind: 10032,
  tags: [],
  content: '{}',
  sig: 'sig1',
} as NostrEvent;

/** A fake WebSocket the test drives by hand: `open()`/`message()`/`error()`/`close()`. */
function fakeSocket(): {
  socket: WebSocketLike;
  sent: string[];
  open(): void;
  message(data: string): void;
  error(): void;
  forceClose(): void;
} {
  const sent: string[] = [];
  const socket: WebSocketLike = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data: string) {
      sent.push(data);
    },
    close() {
      // no-op; tests call forceClose() to simulate the remote closing.
    },
  };
  return {
    socket,
    sent,
    open: () => socket.onopen?.(),
    message: (data: string) => socket.onmessage?.({ data }),
    error: () => socket.onerror?.(undefined),
    forceClose: () => socket.onclose?.(),
  };
}

test('publishToRelay: sends ["EVENT", event] on open and resolves ok on a matching OK true', async () => {
  const fake = fakeSocket();
  const resultPromise = publishToRelay(EVENT, 'wss://relay.example', {
    timeoutMs: 1000,
    logger,
    webSocketFactory: () => fake.socket,
  });

  fake.open();
  assert.deepEqual(JSON.parse(fake.sent[0]), ['EVENT', EVENT]);
  fake.message(JSON.stringify(['OK', EVENT.id, true, '']));

  const result = await resultPromise;
  assert.deepEqual(result, { relay: 'wss://relay.example', ok: true, detail: '' });
});

test('publishToRelay: resolves not-ok on a matching OK false, carrying the relay message', async () => {
  const fake = fakeSocket();
  const resultPromise = publishToRelay(EVENT, 'wss://relay.example', {
    timeoutMs: 1000,
    logger,
    webSocketFactory: () => fake.socket,
  });
  fake.open();
  fake.message(JSON.stringify(['OK', EVENT.id, false, 'rate-limited']));
  const result = await resultPromise;
  assert.deepEqual(result, { relay: 'wss://relay.example', ok: false, detail: 'rate-limited' });
});

test('publishToRelay: ignores OK frames for a different event id', async () => {
  const fake = fakeSocket();
  const resultPromise = publishToRelay(EVENT, 'wss://relay.example', {
    timeoutMs: 50,
    logger,
    webSocketFactory: () => fake.socket,
  });
  fake.open();
  fake.message(JSON.stringify(['OK', 'someone-elses-id', true, '']));
  const result = await resultPromise; // times out, since the relevant OK never arrives
  assert.equal(result.ok, false);
  assert.match(result.detail ?? '', /timeout/);
});

test('publishToRelay: ignores non-JSON frames without crashing', async () => {
  const fake = fakeSocket();
  const resultPromise = publishToRelay(EVENT, 'wss://relay.example', {
    timeoutMs: 1000,
    logger,
    webSocketFactory: () => fake.socket,
  });
  fake.open();
  fake.message('not json at all');
  fake.message(JSON.stringify(['OK', EVENT.id, true, '']));
  const result = await resultPromise;
  assert.equal(result.ok, true);
});

test('publishToRelay: resolves not-ok on a socket error', async () => {
  const fake = fakeSocket();
  const resultPromise = publishToRelay(EVENT, 'wss://relay.example', {
    timeoutMs: 1000,
    logger,
    webSocketFactory: () => fake.socket,
  });
  fake.open();
  fake.error();
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'relay socket error');
});

test('publishToRelay: resolves not-ok if the socket closes before an OK arrives', async () => {
  const fake = fakeSocket();
  const resultPromise = publishToRelay(EVENT, 'wss://relay.example', {
    timeoutMs: 1000,
    logger,
    webSocketFactory: () => fake.socket,
  });
  fake.open();
  fake.forceClose();
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'relay closed before OK');
});

test('publishToRelay: resolves not-ok (never throws) if constructing the socket itself throws', async () => {
  const result = await publishToRelay(EVENT, 'wss://relay.example', {
    timeoutMs: 1000,
    logger,
    webSocketFactory: () => {
      throw new Error('DNS failure');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'DNS failure');
});

test('publishToRelays: publishes to every relay in parallel and returns per-relay outcomes', async () => {
  const fakeA = fakeSocket();
  const fakeB = fakeSocket();
  let call = 0;
  const resultsPromise = publishToRelays(EVENT, ['wss://a', 'wss://b'], {
    timeoutMs: 1000,
    logger,
    webSocketFactory: () => (call++ === 0 ? fakeA.socket : fakeB.socket),
  });

  fakeA.open();
  fakeA.message(JSON.stringify(['OK', EVENT.id, true, '']));
  fakeB.open();
  fakeB.message(JSON.stringify(['OK', EVENT.id, false, 'nope']));

  const results = await resultsPromise;
  assert.deepEqual(results, [
    { relay: 'wss://a', ok: true, detail: '' },
    { relay: 'wss://b', ok: false, detail: 'nope' },
  ]);
});

test('publishToRelays: returns an empty array (never throws) with no relays configured', async () => {
  const results = await publishToRelays(EVENT, [], { timeoutMs: 1000, logger });
  assert.deepEqual(results, []);
});
