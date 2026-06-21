/**
 * ConnectorAdminClient — typed wrapper over the connector admin HTTP API.
 *
 * The admin endpoints (`/admin/peers`, `/admin/routes`, …) are the operator
 * control plane for runtime peer/route management. Until now every consumer
 * (integration tests, the townhouse CLI/MCP) hand-rolled `fetch` calls against
 * them. This client centralizes the URL shapes, the `X-Api-Key` header, and the
 * request/response types so those consumers share one tested surface.
 *
 * Transport-agnostic: pass any `fetch`-compatible function (defaults to the
 * global `fetch`), so it works in Node 18+, the browser, and test harnesses.
 *
 * @module client/connector-admin-client
 */

import type { PeerRelation } from '../config/types';

/** Minimal `fetch` shape this client depends on. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<{
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface ConnectorAdminClientOptions {
  /** Base URL of the admin API, e.g. `http://connector:8081`. Trailing slash optional. */
  baseUrl: string;
  /** Optional admin API key, sent as the `X-Api-Key` header when set. */
  apiKey?: string;
  /** Optional `fetch` implementation (defaults to the global `fetch`). */
  fetch?: FetchLike;
}

/** Route descriptor accepted when registering a peer or adding a route. */
export interface AdminRouteInput {
  prefix: string;
  priority?: number;
}

/** Body for {@link ConnectorAdminClient.registerPeer}. */
export interface RegisterPeerInput {
  id: string;
  url: string;
  authToken: string;
  relation?: PeerRelation;
  transport?: 'direct' | 'socks5';
  routes?: AdminRouteInput[];
  settlement?: Record<string, unknown>;
}

/** Error thrown when an admin request returns a non-2xx status. */
export class ConnectorAdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message);
    this.name = 'ConnectorAdminError';
  }
}

export class ConnectorAdminClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: ConnectorAdminClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    const resolved = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!resolved) {
      throw new Error('No fetch implementation available; pass one via options.fetch');
    }
    this.fetchImpl = resolved;
  }

  /** Register (or idempotently re-register) a peer. `POST /admin/peers`. */
  registerPeer(input: RegisterPeerInput): Promise<unknown> {
    return this.send('POST', '/admin/peers', input);
  }

  /** Remove a peer (and, by default, its routes). `DELETE /admin/peers/:id`. */
  removePeer(peerId: string, removeRoutes = true): Promise<unknown> {
    const query = removeRoutes ? '' : '?removeRoutes=false';
    return this.send('DELETE', `/admin/peers/${encodeURIComponent(peerId)}${query}`);
  }

  /** List all registered peers. `GET /admin/peers`. */
  listPeers(): Promise<unknown> {
    return this.send('GET', '/admin/peers');
  }

  /** Add or update a route. `POST /admin/routes`. */
  addRoute(route: { prefix: string; nextHop: string; priority?: number }): Promise<unknown> {
    return this.send('POST', '/admin/routes', route);
  }

  /** Remove a route by prefix. `DELETE /admin/routes/:prefix`. */
  removeRoute(prefix: string): Promise<unknown> {
    return this.send('DELETE', `/admin/routes/${encodeURIComponent(prefix)}`);
  }

  /** List all routes. `GET /admin/routes`. */
  listRoutes(): Promise<unknown> {
    return this.send('GET', '/admin/routes');
  }

  /**
   * Declaratively reconcile the full peer/route set. `PUT /admin/desired-state`.
   * The connector converges to exactly the given peers and routes (removing
   * anything not listed, preserving its own local routes). Idempotent.
   */
  setDesiredState(state: {
    peers?: RegisterPeerInput[];
    routes?: Array<{ prefix: string; nextHop: string; priority?: number }>;
  }): Promise<unknown> {
    return this.send('PUT', '/admin/desired-state', state);
  }

  private async send(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (this.apiKey) {
      headers['X-Api-Key'] = this.apiKey;
    }

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const parsed = await this.parseBody(res);
    if (!res.ok) {
      const message =
        (parsed && typeof parsed === 'object' && 'message' in parsed
          ? String((parsed as { message: unknown }).message)
          : undefined) ?? `Admin request failed: ${method} ${path} → ${res.status}`;
      throw new ConnectorAdminError(message, res.status, parsed);
    }
    return parsed;
  }

  private async parseBody(res: {
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      try {
        return await res.text();
      } catch {
        return undefined;
      }
    }
  }
}
