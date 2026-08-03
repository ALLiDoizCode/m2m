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

// ─── HTTP write-ingress mode ────────────────────────────────────────────────

function fakeFetch(
  status: number,
  body = ''
): { fetchFn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    } as Response;
  }) as typeof fetch;
  return { fetchFn, calls };
}

test('publishToRelay: http URL posts { event } to the /write ingress and resolves ok on 200', async () => {
  const { fetchFn, calls } = fakeFetch(200);
  const result = await publishToRelay(EVENT, 'http://relay:3100', {
    timeoutMs: 1000,
    logger,
    fetchFn,
  });
  assert.deepEqual(result, { relay: 'http://relay:3100', ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://relay:3100/write');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { event: EVENT });
});

test('publishToRelay: http URL already ending in /write is not double-suffixed', async () => {
  const { fetchFn, calls } = fakeFetch(200);
  await publishToRelay(EVENT, 'http://relay:3100/write', { timeoutMs: 1000, logger, fetchFn });
  assert.equal(calls[0].url, 'http://relay:3100/write');
});

test('publishToRelay: http ingress non-2xx resolves not-ok with status detail, never throws', async () => {
  const { fetchFn } = fakeFetch(422, '{"error":"Invalid event signature"}');
  const result = await publishToRelay(EVENT, 'http://relay:3100', {
    timeoutMs: 1000,
    logger,
    fetchFn,
  });
  assert.equal(result.ok, false);
  assert.match(result.detail ?? '', /HTTP 422/);
});

test('publishToRelay: http ingress network error resolves not-ok, never throws', async () => {
  const fetchFn = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  const result = await publishToRelay(EVENT, 'http://relay:3100', {
    timeoutMs: 1000,
    logger,
    fetchFn,
  });
  assert.equal(result.ok, false);
  assert.match(result.detail ?? '', /ECONNREFUSED/);
});
