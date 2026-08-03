import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { fetchIdentity, fetchGreeting, parseGreetingHeader } from './edge-client';

const logger = pino({ level: 'silent' });

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

test('fetchIdentity: parses a well-formed GET /ilp/identity response', async () => {
  const fetchImpl = (async () =>
    jsonResponse(200, {
      keyId: 'k1',
      publicKey: '0x04' + 'ab'.repeat(64),
    })) as unknown as typeof fetch;

  const identity = await fetchIdentity({
    baseUrl: 'http://edge:4000',
    timeoutMs: 1000,
    logger,
    fetchImpl,
  });
  assert.deepEqual(identity, { keyId: 'k1', publicKey: '0x04' + 'ab'.repeat(64) });
});

test('fetchIdentity: returns null (not throw) on a non-200 response', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  const identity = await fetchIdentity({
    baseUrl: 'http://edge:4000',
    timeoutMs: 1000,
    logger,
    fetchImpl,
  });
  assert.equal(identity, null);
});

test('fetchIdentity: returns null on a malformed body', async () => {
  const fetchImpl = (async () => jsonResponse(200, { keyId: 123 })) as unknown as typeof fetch;
  const identity = await fetchIdentity({
    baseUrl: 'http://edge:4000',
    timeoutMs: 1000,
    logger,
    fetchImpl,
  });
  assert.equal(identity, null);
});

test('fetchIdentity: returns null (not throw) when the fetch itself rejects', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const identity = await fetchIdentity({
    baseUrl: 'http://edge:4000',
    timeoutMs: 1000,
    logger,
    fetchImpl,
  });
  assert.equal(identity, null);
});

const EVM_GREETING = {
  x402Version: 2,
  resource: { url: 'g.toon.relay' },
  accepts: [
    {
      scheme: 'toon-channel',
      network: 'g.toon.relay',
      amount: '1000',
      payTo: 'g.toon.relay',
      maxTimeoutSeconds: 60,
      httpEndpoint: '/ilp',
      extra: {
        ilpAddress: 'g.toon.relay',
        endpoint: '/ilp',
        price: '1000',
        settlement: {
          chain: 'evm:84532',
          settlementAddress: '0xSettlement',
          tokenNetworkRegistry: '0xRegistry',
          tokenNetwork: '0xTokenNetwork',
          tokenAddress: '0xToken',
          decimals: 6,
        },
        settlements: [
          {
            chain: 'evm:84532',
            settlementAddress: '0xSettlement',
            tokenNetworkRegistry: '0xRegistry',
            tokenNetwork: '0xTokenNetwork',
            tokenAddress: '0xToken',
            decimals: 6,
          },
          {
            chain: 'solana',
            settlementAddress: 'SolSettlement111',
            programId: 'ProgramId1111',
            tokenAddress: 'MintAddress111',
            decimals: 6,
          },
        ],
      },
    },
  ],
};

function base64Header(json: unknown): string {
  return Buffer.from(JSON.stringify(json), 'utf8').toString('base64');
}

test('parseGreetingHeader: decodes a well-formed payment-required header into a RouteGreeting', () => {
  const greeting = parseGreetingHeader(base64Header(EVM_GREETING), 'g.toon.relay', logger);
  assert.ok(greeting);
  assert.equal(greeting?.destination, 'g.toon.relay');
  assert.equal(greeting?.price, '1000');
  assert.equal(greeting?.httpEndpoint, '/ilp');
  assert.equal(greeting?.settlement?.chain, 'evm:84532');
  assert.equal(greeting?.settlements.length, 2);
});

test('parseGreetingHeader: returns null on malformed base64', () => {
  assert.equal(parseGreetingHeader('%%%not-base64%%%', 'g.toon.relay', logger), null);
});

test('parseGreetingHeader: returns null when accepts/extra is missing', () => {
  assert.equal(parseGreetingHeader(base64Header({ accepts: [] }), 'g.toon.relay', logger), null);
});

test('fetchGreeting: triggers a POST /ilp and decodes the 402 payment-required header', async () => {
  let capturedRequest: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    capturedRequest = { url: String(url), init };
    return new Response(null, {
      status: 402,
      headers: { 'payment-required': base64Header(EVM_GREETING) },
    });
  }) as unknown as typeof fetch;

  const greeting = await fetchGreeting('g.toon.relay', {
    baseUrl: 'http://edge:4000',
    timeoutMs: 1000,
    logger,
    fetchImpl,
  });

  assert.ok(greeting);
  assert.equal(greeting?.price, '1000');
  assert.ok(capturedRequest);
  assert.equal(capturedRequest!.url, 'http://edge:4000/ilp');
  assert.equal(capturedRequest!.init.method, 'POST');
  // Body is an OER-encoded PREPARE (binary), not JSON.
  assert.ok(
    Buffer.isBuffer(capturedRequest!.init.body) || capturedRequest!.init.body instanceof Buffer
  );
});

test('fetchGreeting: returns null when the edge answers something other than 402 (unpriced/unmatched route)', async () => {
  const fetchImpl = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
  const greeting = await fetchGreeting('g.toon.unknown', {
    baseUrl: 'http://edge:4000',
    timeoutMs: 1000,
    logger,
    fetchImpl,
  });
  assert.equal(greeting, null);
});

test('fetchGreeting: returns null (not throw) when the fetch rejects', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const greeting = await fetchGreeting('g.toon.relay', {
    baseUrl: 'http://edge:4000',
    timeoutMs: 1000,
    logger,
    fetchImpl,
  });
  assert.equal(greeting, null);
});
