/**
 * Mina Helpers Unit Tests (Story 34.10)
 *
 * Tests the Mina lightnet helper functions without requiring a running
 * Mina lightnet instance. Covers timeout behavior, error handling,
 * and account management edge cases.
 *
 * Test IDs covered:
 * - T-34.10-15: waitForMinaReady() timeout with descriptive error
 *
 * @packageDocumentation
 */

import {
  waitForMinaReady,
  acquireFundedAccount,
  releaseFundedAccount,
  MINA_GRAPHQL_URL,
  MINA_ACCOUNTS_MANAGER_URL,
  MINA_READY_TIMEOUT_MS,
  MINA_POLL_INTERVAL_MS,
} from './mina-helpers';

// ---------------------------------------------------------------------------
// Constants Verification
// ---------------------------------------------------------------------------

describe('Mina helper constants (Story 34.10)', () => {
  it('should export GraphQL URL pointing to localhost:3085', () => {
    expect(MINA_GRAPHQL_URL).toBe('http://localhost:3085/graphql');
  });

  it('should export accounts manager URL pointing to localhost:8181', () => {
    expect(MINA_ACCOUNTS_MANAGER_URL).toBe('http://localhost:8181');
  });

  it('should have a 180-second ready timeout', () => {
    expect(MINA_READY_TIMEOUT_MS).toBe(180_000);
  });

  it('should have a 2-second polling interval', () => {
    expect(MINA_POLL_INTERVAL_MS).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// T-34.10-15: waitForMinaReady() Timeout Behavior
// ---------------------------------------------------------------------------

describe('[T-34.10-15] waitForMinaReady() timeout behavior (Story 34.10)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('should timeout with descriptive error when lightnet is not running', async () => {
    // Given: fetch always rejects (no lightnet running)
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    // When: waitForMinaReady is called with a very short timeout
    const promise = waitForMinaReady(100, 20);

    // Then: it should throw with a descriptive error message
    await expect(promise).rejects.toThrow(/Mina lightnet not ready after 100ms/);
    await expect(waitForMinaReady(100, 20)).rejects.toThrow(/make mina-up/);
  });

  it('should report accounts manager not responding when only GraphQL is unreachable', async () => {
    // Given: both endpoints fail
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    // When/Then
    await expect(waitForMinaReady(100, 20)).rejects.toThrow(/accounts manager.*not responding/);
  });

  it('should report GraphQL endpoint not responding when only it is unreachable', async () => {
    // Given: accounts manager responds OK, but GraphQL fails
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('8181')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }
      return Promise.reject(new Error('ECONNREFUSED'));
    });

    // When/Then
    await expect(waitForMinaReady(200, 20)).rejects.toThrow(/GraphQL endpoint.*not responding/);
  });

  it('should succeed when both endpoints respond correctly', async () => {
    // Given: both endpoints respond properly
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('8181')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }
      if (typeof url === 'string' && url.includes('3085')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: { __schema: { queryType: { name: 'Query' } } },
            }),
        });
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    // When/Then: should resolve without error
    await expect(waitForMinaReady(5_000, 20)).resolves.toBeUndefined();
  });

  it('should succeed after initial failures when endpoints eventually come up', async () => {
    // Given: endpoints fail first 2 calls then succeed
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation((url: string) => {
      callCount++;
      if (callCount <= 4) {
        return Promise.reject(new Error('ECONNREFUSED'));
      }
      if (typeof url === 'string' && url.includes('8181')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }
      if (typeof url === 'string' && url.includes('3085')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: { __schema: { queryType: { name: 'Query' } } },
            }),
        });
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    // When/Then: should eventually succeed
    await expect(waitForMinaReady(5_000, 20)).resolves.toBeUndefined();
  });

  it('should timeout when GraphQL returns invalid introspection result', async () => {
    // Given: accounts manager OK, GraphQL returns HTTP 200 but no valid schema
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('8181')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }
      if (typeof url === 'string' && url.includes('3085')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: null }),
        });
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    // When/Then: should timeout because GraphQL schema check fails
    await expect(waitForMinaReady(200, 20)).rejects.toThrow(/GraphQL endpoint.*not responding/);
  });
});

// ---------------------------------------------------------------------------
// acquireFundedAccount() Error Handling
// ---------------------------------------------------------------------------

describe('acquireFundedAccount() error handling (Story 34.10)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('should return account with publicKey, privateKey, and balance on success', async () => {
    // Given: accounts manager returns a valid funded account
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          pk: 'B62qTestPublicKey123',
          sk: 'EKETestPrivateKey456',
          balance: '1500',
        }),
    });

    // When
    const account = await acquireFundedAccount();

    // Then
    expect(account.publicKey).toBe('B62qTestPublicKey123');
    expect(account.privateKey).toBe('EKETestPrivateKey456');
    expect(account.balance).toBe('1500');
  });

  it('should throw when accounts manager returns non-OK response', async () => {
    // Given: accounts manager returns 503
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    // When/Then
    await expect(acquireFundedAccount()).rejects.toThrow(/Failed to acquire funded account.*503/);
  });

  it('should throw when response is missing pk field', async () => {
    // Given: accounts manager returns incomplete data
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sk: 'EKETest', balance: '1000' }),
    });

    // When/Then
    await expect(acquireFundedAccount()).rejects.toThrow(/missing pk or sk/);
  });

  it('should throw when response is missing sk field', async () => {
    // Given: accounts manager returns incomplete data
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ pk: 'B62qTest', balance: '1000' }),
    });

    // When/Then
    await expect(acquireFundedAccount()).rejects.toThrow(/missing pk or sk/);
  });

  it('should default balance to "0" when not provided', async () => {
    // Given: accounts manager returns data without balance
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ pk: 'B62qTest', sk: 'EKETest' }),
    });

    // When
    const account = await acquireFundedAccount();

    // Then
    expect(account.balance).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// releaseFundedAccount() Error Handling
// ---------------------------------------------------------------------------

describe('releaseFundedAccount() graceful degradation (Story 34.10)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('should not throw when release succeeds', async () => {
    // Given: release endpoint returns OK
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    // When/Then: should not throw
    await expect(releaseFundedAccount('B62qTestPublicKey')).resolves.toBeUndefined();
  });

  it('should not throw when release fails (graceful degradation)', async () => {
    // Given: release endpoint returns an error
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    // Capture console.warn
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    // When/Then: should NOT throw -- best-effort cleanup
    await expect(releaseFundedAccount('B62qTestPublicKey')).resolves.toBeUndefined();

    // Should have warned
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to release Mina account B62qTestPublicKey')
    );
  });

  it('should send PUT request with correct public key', async () => {
    // Given
    const mockFetch = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = mockFetch;

    // When
    await releaseFundedAccount('B62qSpecificKey');

    // Then: should have called fetch with correct URL, method, and body
    expect(mockFetch).toHaveBeenCalledWith(
      `${MINA_ACCOUNTS_MANAGER_URL}/release-account`,
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pk: 'B62qSpecificKey' }),
      })
    );
  });
});
