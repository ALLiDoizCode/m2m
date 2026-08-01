/**
 * Publishes a signed kind:10032 event directly to a set of relay WebSocket
 * URLs — NIP-01's plain `["EVENT", <event>]` publish, awaiting `["OK", id,
 * true|false, message]`.
 *
 * This is deliberately simpler than the retired connector's publish path
 * (`discovery/self-announce-publish.ts`), which routed the write through the
 * connector's OWN ILP pipe so a REMOTE `announceTo` paid from the
 * connector's settlement channel. This sidecar is not a connector and holds
 * no channel — per the issue's re-scope, v1 only needs the LOCAL-relay case,
 * which was always free (a direct WS publish, no ILP packet involved). If a
 * future revision needs to reach a remote relay that requires payment, that
 * is a new capability, not a mode this module should silently grow.
 *
 * Uses the platform `WebSocket` global (stable in Node >=22, this package's
 * minimum) rather than adding a `ws` dependency; `WebSocketLike` narrows to
 * exactly what's used, so tests can inject a fake without pulling in a real
 * socket implementation.
 *
 * @module publisher
 */

import type { Logger } from 'pino';
import type { NostrEvent } from 'nostr-tools';

/** The subset of the WHATWG `WebSocket` interface this module drives. */
export interface WebSocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** Outcome of publishing to one relay. */
export interface RelayPublishResult {
  relay: string;
  ok: boolean;
  detail?: string;
}

export interface PublishOptions {
  timeoutMs: number;
  logger: Logger;
  /** Injectable for tests; defaults to the platform `WebSocket`. */
  webSocketFactory?: WebSocketFactory;
}

const defaultFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

/** Publish `event` to a single relay, resolving once `OK`/error/timeout settles it. Never throws. */
export function publishToRelay(
  event: NostrEvent,
  relayUrl: string,
  opts: PublishOptions
): Promise<RelayPublishResult> {
  const makeSocket = opts.webSocketFactory ?? defaultFactory;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: RelayPublishResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed/never opened — fine.
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      settle({ relay: relayUrl, ok: false, detail: 'timeout waiting for relay OK' });
    }, opts.timeoutMs);
    timer.unref?.();

    let ws: WebSocketLike;
    try {
      ws = makeSocket(relayUrl);
    } catch (err) {
      clearTimeout(timer);
      resolve({ relay: relayUrl, ok: false, detail: errMsg(err) });
      return;
    }

    ws.onopen = (): void => {
      try {
        ws.send(JSON.stringify(['EVENT', event]));
      } catch (err) {
        settle({ relay: relayUrl, ok: false, detail: errMsg(err) });
      }
    };

    ws.onmessage = (msg: { data: unknown }): void => {
      try {
        const parsed: unknown = JSON.parse(String(msg.data));
        if (!Array.isArray(parsed) || parsed[0] !== 'OK' || parsed[1] !== event.id) return;
        const ok = parsed[2] === true;
        settle({
          relay: relayUrl,
          ok,
          detail: typeof parsed[3] === 'string' ? parsed[3] : undefined,
        });
      } catch {
        // Non-JSON / unrelated frame — ignore and keep waiting up to the timeout.
      }
    };

    ws.onerror = (): void => {
      settle({ relay: relayUrl, ok: false, detail: 'relay socket error' });
    };

    ws.onclose = (): void => {
      settle({ relay: relayUrl, ok: false, detail: 'relay closed before OK' });
    };
  });
}

/** Publish `event` to every relay in `relayUrls`, in parallel. Never throws. */
export async function publishToRelays(
  event: NostrEvent,
  relayUrls: string[],
  opts: PublishOptions
): Promise<RelayPublishResult[]> {
  if (relayUrls.length === 0) {
    opts.logger.warn(
      { event: 'announce_no_relays' },
      'No relay URLs configured; nothing to publish to'
    );
    return [];
  }
  return Promise.all(relayUrls.map((url) => publishToRelay(event, url, opts)));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
