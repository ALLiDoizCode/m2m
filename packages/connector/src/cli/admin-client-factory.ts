/* eslint-disable no-console */
/**
 * Shared helpers for the networked CLI commands (`app`, `route`).
 *
 * Builds a {@link ConnectorAdminClient} from the common global options
 * (`-u/--url`, `--api-key`) and centralizes the error/exit-code convention so
 * each command stays a thin shell over the admin API. The admin API default
 * base is `http://localhost:8081` (NOTE: the admin port is 8081, distinct from
 * the 8080 health port the `health` command targets).
 *
 * @module cli/admin-client-factory
 */

import { ConnectorAdminClient, ConnectorAdminError } from '../client/connector-admin-client';

/** Options shared by every networked command. */
export interface AdminCommonOptions {
  /** Admin API base URL. */
  url: string;
  /** Admin API key; falls back to the `ADMIN_API_KEY` env var when unset. */
  apiKey?: string;
}

/** Default admin API base URL (admin port 8081, not the 8080 health port). */
export const DEFAULT_ADMIN_URL = 'http://localhost:8081';

/**
 * Construct a {@link ConnectorAdminClient} from the resolved global options.
 * The API key resolves from `--api-key`, then the `ADMIN_API_KEY` env var.
 */
export function makeAdminClient(opts: AdminCommonOptions): ConnectorAdminClient {
  const apiKey = opts.apiKey ?? process.env.ADMIN_API_KEY;
  return new ConnectorAdminClient({
    baseUrl: opts.url || DEFAULT_ADMIN_URL,
    apiKey: apiKey && apiKey.length > 0 ? apiKey : undefined,
  });
}

/**
 * Run a networked command body, mapping failures to the CLI's exit-code
 * convention: a {@link ConnectorAdminError} (or any thrown error) prints a
 * plain-ASCII `Error: <message>` to stderr and exits with code 1.
 */
export async function runAdmin(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ConnectorAdminError) {
      console.error(`Error: ${error.message} (HTTP ${error.status})`);
    } else {
      console.error(`Error: ${(error as Error).message}`);
    }
    process.exit(1);
  }
}

/**
 * Print a payload as pretty JSON (used by `--json` on read commands) — the raw
 * admin response, unmodified.
 */
export function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}
