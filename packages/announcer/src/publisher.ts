/**
 * Publishes a signed kind:10032 event to a set of relay URLs.
 *
 * Two URL schemes, matching the two ingress surfaces a TOON relay deploy
 * exposes:
 *
 * - `ws://` / `wss://` — NIP-01's plain `["EVENT", <event>]` publish,
 *   awaiting `["OK", id, true|false, message]`. NOTE: the production relay's
 *   public WS gate rejects ALL external writes (`restricted: writes require
 *   ILP payment` — events only enter through the payment terminator), so
 *   this scheme is only useful against relays that accept free WS writes.
 * - `http://` / `https://` — the relay's PRIVATE payment-oblivious write
 *   ingress (`POST /write` with `{ event }`, relay `launcher/handlers/
 *   write-handler.ts`): the surface the fronting connector itself delivers
 *   paid events to after terminating payment. Publishing here is the
 *   trusted-local free path — the sidecar sits on the same docker network
 *   the connector does, upstream of the payment boundary, exactly like the
 *   retired connector's LOCAL `announceTo` delivery (which was always free).
 *   `/write` is appended when the URL doesn't already end with it. These
 *   URLs are INTERNAL — set `ANNOUNCER_RELAY_PUBLIC_URL` so the advertised
 *   `relayUrl` stays a public WS endpoint.
 *
 * This is deliberately simpler than the retired connector's publish path
 * (`discovery/self-announce-publish.ts`), which routed the write through the
 * connector's OWN ILP pipe so a REMOTE `announceTo` paid from the
 * connector's settlement channel. This sidecar is not a connector and holds
 * no channel — per the issue's re-scope, v1 only needs the LOCAL-relay case,
 * which was always free. If a future revision needs to reach a remote relay
 * that requires payment, that is a new capability, not a mode this module
 * should silently grow.
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
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchFn?: typeof fetch;
}

const defaultFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

/**
 * Publish `event` to the relay's payment-oblivious HTTP write ingress
 * (`POST <url>[/write]` with `{ event }`). Never throws.
 */
async function publishToHttpIngress(
  event: NostrEvent,
  relayUrl: string,
  opts: PublishOptions
): Promise<RelayPublishResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const target = relayUrl.replace(/\/$/, '').endsWith('/write')
    ? relayUrl
    : `${relayUrl.replace(/\/$/, '')}/write`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetchFn(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
      signal: controller.signal,
    });
    if (res.ok) {
      return { relay: relayUrl, ok: true };
    }
    const text = await res.text().catch(() => '');
    return {
      relay: relayUrl,
      ok: false,
      detail: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
    };
  } catch (err) {
    return {
      relay: relayUrl,
      ok: false,
      detail: controller.signal.aborted ? 'timeout waiting for write ingress' : errMsg(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Publish `event` to a single relay, resolving once `OK`/error/timeout settles it. Never throws. */
export function publishToRelay(
  event: NostrEvent,
  relayUrl: string,
  opts: PublishOptions
): Promise<RelayPublishResult> {
  if (relayUrl.startsWith('http://') || relayUrl.startsWith('https://')) {
    return publishToHttpIngress(event, relayUrl, opts);
  }
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
