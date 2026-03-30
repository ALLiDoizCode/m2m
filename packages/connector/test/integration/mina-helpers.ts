/**
 * Mina Lightnet E2E Test Helpers
 *
 * Provides readiness checks and account management for Mina lightnet
 * integration tests. Follows the pattern established by `multi-hop-helpers.ts`
 * for Anvil infrastructure.
 *
 * Prerequisites:
 *   make mina-up   # Start Mina lightnet via Docker
 *
 * @packageDocumentation
 */

// ============================================================================
// Mina Lightnet Constants
// ============================================================================

/** Mina lightnet GraphQL endpoint */
export const MINA_GRAPHQL_URL = 'http://localhost:3085/graphql';

/** Mina lightnet accounts manager endpoint */
export const MINA_ACCOUNTS_MANAGER_URL = 'http://localhost:8181';

/** Default readiness timeout (Mina takes 1-3 minutes to sync) */
export const MINA_READY_TIMEOUT_MS = 180_000;

/** Polling interval for readiness checks (slower than Anvil due to Mina startup time) */
export const MINA_POLL_INTERVAL_MS = 2_000;

// ============================================================================
// Types
// ============================================================================

/** Funded account acquired from the Mina lightnet accounts manager */
export interface MinaFundedAccount {
  /** Public key (B62 prefix) */
  publicKey: string;
  /** Private key (EKE prefix) */
  privateKey: string;
  /** Account balance in MINA */
  balance: string;
}

// ============================================================================
// Readiness Helpers
// ============================================================================

/**
 * Wait for the Mina lightnet to be fully ready.
 *
 * Polls both the accounts manager (non-mutating endpoint) and the GraphQL
 * endpoint until both respond successfully. This ensures the Mina daemon
 * has reached SYNCED status and the accounts manager is operational.
 *
 * @param timeoutMs - Maximum time to wait (default: 180s)
 * @param intervalMs - Polling interval (default: 2s)
 * @throws Error if the lightnet is not ready within the timeout
 */
export async function waitForMinaReady(
  timeoutMs: number = MINA_READY_TIMEOUT_MS,
  intervalMs: number = MINA_POLL_INTERVAL_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  let accountsManagerReady = false;
  let graphqlReady = false;

  // Poll until both endpoints are ready
  while (Date.now() < deadline) {
    // Check accounts manager (non-mutating endpoint)
    if (!accountsManagerReady) {
      try {
        const response = await fetch(`${MINA_ACCOUNTS_MANAGER_URL}/list-acquired-accounts`);
        if (response.ok) {
          accountsManagerReady = true;
        }
      } catch {
        // Not ready yet
      }
    }

    // Check GraphQL endpoint with introspection query
    if (!graphqlReady) {
      try {
        const response = await fetch(MINA_GRAPHQL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: '{ __schema { queryType { name } } }',
          }),
        });
        if (response.ok) {
          const data = (await response.json()) as {
            data?: { __schema?: { queryType?: { name?: string } } };
          };
          if (data?.data?.__schema?.queryType?.name) {
            graphqlReady = true;
          }
        }
      } catch {
        // Not ready yet
      }
    }

    if (accountsManagerReady && graphqlReady) {
      return;
    }

    await sleep(intervalMs);
  }

  const status = [];
  if (!accountsManagerReady) {
    status.push(`accounts manager (${MINA_ACCOUNTS_MANAGER_URL}) not responding`);
  }
  if (!graphqlReady) {
    status.push(`GraphQL endpoint (${MINA_GRAPHQL_URL}) not responding`);
  }

  throw new Error(
    `Mina lightnet not ready after ${timeoutMs}ms: ${status.join(', ')}. ` +
      'Ensure the lightnet is running via `make mina-up` and has had sufficient time to sync (1-3 minutes).'
  );
}

// ============================================================================
// Account Management Helpers
// ============================================================================

/**
 * Acquire a funded account from the Mina lightnet accounts manager.
 *
 * IMPORTANT: This endpoint is mutating -- it locks the account from the pool.
 * Always call `releaseFundedAccount()` in `afterAll` to return it.
 *
 * @returns Funded account with publicKey (B62...), privateKey (EKE...), and balance
 * @throws Error if the accounts manager is not available or no accounts remain
 */
export async function acquireFundedAccount(): Promise<MinaFundedAccount> {
  const response = await fetch(`${MINA_ACCOUNTS_MANAGER_URL}/acquire-account`);

  if (!response.ok) {
    throw new Error(
      `Failed to acquire funded account from Mina lightnet: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as { pk?: string; sk?: string; balance?: string };

  if (!data.pk || !data.sk) {
    throw new Error(
      `Unexpected response from accounts manager: missing pk or sk fields. Got: ${JSON.stringify(data)}`
    );
  }

  return {
    publicKey: data.pk,
    privateKey: data.sk,
    balance: data.balance ?? '0',
  };
}

/**
 * Release a funded account back to the Mina lightnet accounts manager pool.
 *
 * Should be called in `afterAll` for every account acquired via `acquireFundedAccount()`.
 *
 * @param publicKey - The B62-prefixed public key to release
 */
export async function releaseFundedAccount(publicKey: string): Promise<void> {
  const response = await fetch(`${MINA_ACCOUNTS_MANAGER_URL}/release-account`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pk: publicKey }),
  });

  if (!response.ok) {
    // Log but don't throw -- best-effort cleanup
    const text = await response.text().catch(() => 'unknown');
    // eslint-disable-next-line no-console
    console.warn(`Failed to release Mina account ${publicKey}: ${response.status} ${text}`);
  }
}

// ============================================================================
// Utility
// ============================================================================

/**
 * Sleep for the specified number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
