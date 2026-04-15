/**
 * Direct Transport Provider
 *
 * Default transport implementation using standard Node.js networking (no proxy).
 * Returns `undefined` from `createAgent()` so the `ws` library uses its
 * built-in connection behavior.
 *
 * Epic 35 Story 35.1
 *
 * @module direct-transport-provider
 */

import type http from 'http';
import type { TransportProvider } from './transport-provider';

/**
 * Direct transport provider -- uses default Node.js networking with no proxy.
 *
 * This is the default transport when no overlay network is configured.
 * All methods are trivial: `createAgent()` returns `undefined` so the `ws`
 * library uses its built-in connection behavior, lifecycle methods are no-ops,
 * and health is always reported as `true`.
 */
export class DirectTransportProvider implements TransportProvider {
  private readonly _externalUrl: string;

  /**
   * @param externalUrl - The externally reachable WebSocket URL for this node
   * @throws {Error} If externalUrl is empty
   */
  constructor(externalUrl: string) {
    if (!externalUrl) {
      throw new Error('DirectTransportProvider: externalUrl must not be empty');
    }
    this._externalUrl = externalUrl;
  }

  /** @returns Always `undefined` -- use the default Node.js HTTP agent */
  createAgent(_peerUrl: string): http.Agent | undefined {
    return undefined;
  }

  /** @returns The constructor-provided external URL */
  getExternalUrl(): string {
    return this._externalUrl;
  }

  /** @returns Resolves immediately (no-op for direct connections) */
  async start(): Promise<void> {
    // No-op for direct connections
  }

  /** @returns Resolves immediately (no-op for direct connections) */
  async stop(): Promise<void> {
    // No-op for direct connections
  }

  /** @returns Always resolves to `true` -- direct connections are always healthy */
  async healthCheck(): Promise<boolean> {
    return true;
  }
}
