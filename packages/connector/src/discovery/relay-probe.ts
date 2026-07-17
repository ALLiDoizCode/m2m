/**
 * Minimal kind:10032 relay probe for bootstrap sample-and-verify
 * (toon-meta#153).
 *
 * Answers ONE question: "can I connect to this relay WS URL and fetch at
 * least one valid kind:10032 event — or an EOSE — within the timeout?" This
 * is deliberately NOT a route-learning consumer: a concurrent branch builds
 * the real kind:10032 READ client, and `BootstrapService` only depends on the
 * `RelayProbeFn` seam so the two can share an implementation later.
 *
 * Protocol (NIP-01): open the WebSocket, send
 * `["REQ", <subId>, {"kinds":[10032], "limit":1}]`, then
 *  - an `EVENT` for our sub whose payload is a signature-valid kind:10032
 *    event → verified (`detail: 'event'`);
 *  - an `EOSE` for our sub → verified (`detail: 'eose'`) — an empty but
 *    protocol-conformant relay is still a usable bootstrap relay;
 *  - error / close / timeout → failed.
 *
 * @module discovery/relay-probe
 */

import WebSocket from 'ws';
import { verifyEvent, type NostrEvent } from 'nostr-tools';
import type { Logger } from 'pino';
import { ILP_PEER_INFO_KIND } from './ilp-peer-info-event';
import type { RelayProbeFn, RelayProbeResult } from './bootstrap-service';

/** Subscription id used by the probe REQ (namespaced to avoid collisions). */
export const BOOTSTRAP_PROBE_SUB_ID = 'toon-bootstrap-probe';

/**
 * Create the production `RelayProbeFn`: one short-lived WebSocket per probe,
 * closed as soon as the verdict is known. Never rejects — every failure mode
 * resolves `{ ok: false }`.
 */
export function createKind10032RelayProbe(logger: Logger): RelayProbeFn {
  const probeLogger = logger.child({ component: 'Kind10032RelayProbe' });

  return (relayUrl: string, timeoutMs: number): Promise<RelayProbeResult> =>
    new Promise<RelayProbeResult>((resolve) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(relayUrl, { handshakeTimeout: timeoutMs });
      } catch (err) {
        resolve({ ok: false, detail: errMsg(err) });
        return;
      }

      let settled = false;
      const settle = (result: RelayProbeResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Best-effort close; the verdict is already decided.
        }
        resolve(result);
      };

      const timer = setTimeout(() => settle({ ok: false, detail: 'timeout' }), timeoutMs);
      timer.unref?.();

      socket.on('open', () => {
        socket.send(
          JSON.stringify(['REQ', BOOTSTRAP_PROBE_SUB_ID, { kinds: [ILP_PEER_INFO_KIND], limit: 1 }])
        );
      });

      socket.on('message', (data: WebSocket.RawData) => {
        let message: unknown;
        try {
          message = JSON.parse(String(data));
        } catch {
          return; // Not JSON — ignore and keep waiting until the timeout.
        }
        if (!Array.isArray(message) || message[1] !== BOOTSTRAP_PROBE_SUB_ID) {
          return;
        }
        if (message[0] === 'EVENT') {
          if (isValidPeerInfoEvent(message[2])) {
            settle({ ok: true, detail: 'event' });
          } else {
            probeLogger.debug(
              { event: 'bootstrap_probe_invalid_event', relayUrl },
              'Relay probe received an invalid kind:10032 event; waiting for EOSE'
            );
          }
        } else if (message[0] === 'EOSE') {
          settle({ ok: true, detail: 'eose' });
        }
      });

      socket.on('error', (err: Error) => settle({ ok: false, detail: err.message }));
      socket.on('close', () => settle({ ok: false, detail: 'closed' }));
    });
}

/** Structural + signature check for a kind:10032 event payload. */
function isValidPeerInfoEvent(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') {
    return false;
  }
  const event = raw as Partial<NostrEvent>;
  if (event.kind !== ILP_PEER_INFO_KIND) {
    return false;
  }
  try {
    return verifyEvent(event as NostrEvent);
  } catch {
    return false;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
