/**
 * Shared TCP port-readiness probe (Epic 35 / Story 35.5).
 *
 * Extracted from `SocksTransportProvider._probeProxy` so that
 * `ManagedAnonClient.start()` can reuse the same TCP probe without duplicating
 * the connect/timeout/cleanup dance.
 *
 * The probe performs a raw TCP connect only -- it does NOT perform a SOCKS5
 * handshake. That is intentional: a full handshake would require choosing an
 * arbitrary target and could itself leak metadata. The probe merely verifies
 * that the port is listening.
 *
 * @module transport/probe-tcp-port
 */

import net from 'net';

/**
 * Attempt a single TCP connect to `host:port` and resolve on success.
 *
 * @param host - Target host (typically `127.0.0.1`).
 * @param port - Target port.
 * @param timeoutMs - Max time to wait for connect, in milliseconds.
 * @returns Resolves when the TCP connect succeeds; rejects on error or timeout.
 */
export function probeTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const cleanup = (): void => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    });

    socket.once('timeout', () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`probe timed out after ${timeoutMs}ms`));
    });

    socket.once('error', (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
  });
}

/**
 * Poll a TCP port until a connect succeeds or the overall deadline elapses.
 *
 * Used by `ManagedAnonClient.start()` to wait for the `anon` binary's SOCKS
 * port to start accepting connections.
 *
 * @param host - Target host.
 * @param port - Target port.
 * @param overallTimeoutMs - Overall deadline budget.
 * @param perProbeTimeoutMs - Per-attempt connect timeout (default 250ms).
 * @param pollIntervalMs - Delay between attempts (default 100ms).
 * @returns Resolves on first successful connect; rejects on deadline.
 */
export async function waitForTcpPort(
  host: string,
  port: number,
  overallTimeoutMs: number,
  perProbeTimeoutMs = 250,
  pollIntervalMs = 100
): Promise<void> {
  const deadline = Date.now() + overallTimeoutMs;
  let lastErr: Error | undefined;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const probeTimeout = Math.min(perProbeTimeoutMs, Math.max(1, remaining));
    try {
      await probeTcpPort(host, port, probeTimeout);
      return;
    } catch (err) {
      lastErr = err as Error;
    }
    // Sleep briefly before retrying (unless deadline already passed).
    if (Date.now() + pollIntervalMs >= deadline) break;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `TCP port ${host}:${port} did not become ready within ${overallTimeoutMs}ms timeout` +
      (lastErr ? ` (last error: ${lastErr.message})` : '')
  );
}
