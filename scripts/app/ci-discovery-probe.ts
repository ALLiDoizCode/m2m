/**
 * kind:10032 self-announce discovery probe — verifies the connector's
 * `selfAnnounce` feature is LIVE on the devnet relay read WS.
 *
 * Companion to `ci-acceptance-probe.ts` (paid round-trip). This one is the
 * acceptance check for toon-protocol/relay#37 + toon-protocol/store#22 and the
 * final step of the rollout tracked in toon-protocol/toon-meta#69: a client
 * holding only the genesis seed must be able to discover the publish AND store
 * routes out of band. It asserts that BOTH apex (`g.proxy.relay`) and store box
 * (`g.proxy.store`) publish a FRESH, unexpired `kind:10032` `IlpPeerInfo`
 * carrying route hints in content.
 *
 * Why `created_at` recency rather than only the NIP-40 `expiration`: this devnet
 * relay does NOT drop expired events (store#22 found a live-but-expired
 * announcement), so mere presence proves nothing. A `created_at` within the TTL
 * window proves the refresh loop is actually running *and* — since
 * `expiration = created_at + ttl` — that the event is unexpired. We still check
 * the explicit `expiration` tag too when the payload decodes structurally.
 *
 * Encoding robustness: the relay serves `["EVENT",<sub>,<payload>]` where
 * <payload> has historically been a raw object, a JSON string, a DOUBLE-JSON
 * string, or a TOON-encoded text string (see
 * `test/integration/paid-roundtrip-client.ts` "EVENT[2] is a TOON-encoded
 * STRING"). We decode through a cascade and fall back to substring/regex
 * matching on the raw text so a single encoding change can't silently flip the
 * probe to a false PASS or FAIL.
 *
 * Invocation (mirrors ci-acceptance-probe.ts):
 *
 *   DOMAIN=devnet.toonprotocol.dev \
 *     npx ts-node --project packages/connector/tsconfig.json \
 *     scripts/app/ci-discovery-probe.ts
 *
 * Env:
 *   DOMAIN          (required unless RELAY_WS_URL is supplied)
 *   RELAY_WS_URL    default wss://relay-ws.${DOMAIN}
 *   APEX_ILP        default g.proxy.relay   (the publish route the apex announces)
 *   STORE_ILP       default g.proxy.store   (the store route the store box announces)
 *   TTL_SECS        default 600             (refreshIntervalSecs * 2; the freshness window)
 *   READ_TIMEOUT_MS default 8000            (WS read budget before giving up)
 *
 * @module ci-discovery-probe
 */

/* eslint-disable no-console */

import WebSocket from 'ws';

const ANNOUNCE_KIND = 10032;

interface ProbeStep {
  name: string;
  ok: boolean;
  detail?: string;
}

interface ResolvedConfig {
  relayWsUrl: string;
  apexIlp: string;
  storeIlp: string;
  ttlSecs: number;
  readTimeoutMs: number;
}

function resolveConfig(): ResolvedConfig {
  const domain = process.env.DOMAIN;
  const relayWsUrl =
    process.env.RELAY_WS_URL ??
    (domain
      ? `wss://relay-ws.${domain}`
      : (() => {
          throw new Error(
            'Missing RELAY_WS_URL: set DOMAIN (→ wss://relay-ws.${DOMAIN}) or supply it.'
          );
        })());

  return {
    relayWsUrl,
    apexIlp: process.env.APEX_ILP ?? 'g.proxy.relay',
    storeIlp: process.env.STORE_ILP ?? 'g.proxy.store',
    ttlSecs: Number(process.env.TTL_SECS ?? '600'),
    readTimeoutMs: Number(process.env.READ_TIMEOUT_MS ?? '8000'),
  };
}

/** A kind:10032 frame, decoded as far as the relay's encoding allows. */
interface Announcement {
  raw: string; // the EVENT[2] payload as text (always available for substring fallback)
  ilpAddress?: string; // top-level IlpPeerInfo.ilpAddress (only when structurally decoded)
  routes?: { publish?: string; store?: string }; // content route hints (structural)
  createdAt?: number; // event created_at (structural OR regex-recovered)
  expiration?: number; // NIP-40 expiration tag (structural OR regex-recovered)
  structured: boolean; // true if we recovered a real event object
}

/** Try object → JSON → double-JSON; return the event object or null (TOON text). */
function tryDecodeEvent(payload: unknown): Record<string, unknown> | null {
  if (payload && typeof payload === 'object') return payload as Record<string, unknown>;
  let cur: unknown = payload;
  for (let i = 0; i < 2 && typeof cur === 'string'; i++) {
    try {
      cur = JSON.parse(cur);
    } catch {
      return null;
    }
  }
  return cur && typeof cur === 'object' ? (cur as Record<string, unknown>) : null;
}

/** Pull the first 10-digit unix timestamp following `label` from raw text. */
function regexUnix(raw: string, label: string): number | undefined {
  const m = raw.match(new RegExp(`${label}["':\\s,]+([0-9]{10})`));
  return m ? Number(m[1]) : undefined;
}

function toAnnouncement(payload: unknown): Announcement {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const ev = tryDecodeEvent(payload);
  if (!ev) {
    // TOON text — recover what we can by regex.
    return {
      raw,
      createdAt: regexUnix(raw, 'created_at'),
      expiration: regexUnix(raw, 'expiration'),
      structured: false,
    };
  }
  // Structured event. content is a JSON IlpPeerInfo blob; tags carry expiration.
  let ilpAddress: string | undefined;
  let routes: { publish?: string; store?: string } | undefined;
  try {
    const info = JSON.parse(String(ev.content ?? '{}')) as {
      ilpAddress?: string;
      routes?: { publish?: string; store?: string };
    };
    ilpAddress = info.ilpAddress;
    routes = info.routes;
  } catch {
    /* content not JSON — leave structural fields undefined, raw still matched */
  }
  const tags = Array.isArray(ev.tags) ? (ev.tags as unknown[][]) : [];
  const expTag = tags.find((t) => Array.isArray(t) && t[0] === 'expiration');
  return {
    raw,
    ilpAddress,
    routes,
    createdAt: typeof ev.created_at === 'number' ? ev.created_at : regexUnix(raw, 'created_at'),
    expiration: expTag ? Number(expTag[1]) : regexUnix(raw, 'expiration'),
    structured: true,
  };
}

/** Open the read WS, REQ kind:10032, collect EVENTs until EOSE (+ grace) or timeout. */
function fetchAnnouncements(relayWsUrl: string, timeoutMs: number): Promise<Announcement[]> {
  return new Promise((resolve, reject) => {
    const out: Announcement[] = [];
    const subId = 'disc-probe';
    const ws = new WebSocket(relayWsUrl);
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(out);
    };
    const hardTimer = setTimeout(finish, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', subId, { kinds: [ANNOUNCE_KIND] }]));
    });
    ws.on('message', (data: WebSocket.RawData) => {
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return; // not a JSON control frame; ignore
      }
      if (!Array.isArray(frame)) return;
      const [type, , payload] = frame as [string, string, unknown];
      if (type === 'EVENT') {
        out.push(toAnnouncement(payload));
      } else if (type === 'EOSE') {
        // Got the stored set; give late frames a brief grace, then finish.
        setTimeout(finish, 250);
      }
    });
    ws.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/** Find the freshest announcement for a given ILP address. */
function pickFor(anns: Announcement[], ilp: string): Announcement | undefined {
  // Structured match on the announcement's OWN ilpAddress is exact; otherwise
  // fall back to: the raw text mentions this ilp AND (for store/relay
  // disambiguation) is not better explained by the other. We keep it simple —
  // exact structural match first, then any raw mention — and pick freshest.
  const exact = anns.filter((a) => a.ilpAddress === ilp);
  const pool = exact.length ? exact : anns.filter((a) => a.raw.includes(ilp));
  if (!pool.length) return undefined;
  return pool.reduce((best, a) => ((a.createdAt ?? 0) > (best.createdAt ?? 0) ? a : best));
}

function checkOne(
  label: string,
  ann: Announcement | undefined,
  ilp: string,
  cfg: ResolvedConfig,
  nowSecs: number,
  steps: ProbeStep[]
): void {
  if (!ann) {
    steps.push({
      name: `${label}: ${ilp} announcement present`,
      ok: false,
      detail: 'no kind:10032 found',
    });
    return;
  }
  steps.push({
    name: `${label}: ${ilp} announcement present`,
    ok: true,
    detail: ann.structured ? 'structurally decoded' : 'matched raw (TOON text)',
  });

  // Route hints: content must carry BOTH publish + store so a genesis-only
  // client can route either way without hardcoding destinations.
  const hasPublish = ann.routes?.publish === cfg.apexIlp || ann.raw.includes(cfg.apexIlp);
  const hasStore = ann.routes?.store === cfg.storeIlp || ann.raw.includes(cfg.storeIlp);
  steps.push({
    name: `${label}: carries route hints {publish,store}`,
    ok: hasPublish && hasStore,
    detail: `publish=${hasPublish} store=${hasStore}`,
  });

  // Freshness: created_at within the TTL window (proves the refresh loop is live
  // and, since expiration = created_at + ttl, that it's unexpired). When the
  // explicit expiration is recoverable, assert it's in the future too.
  const age = ann.createdAt !== undefined ? nowSecs - ann.createdAt : undefined;
  const freshByAge = age !== undefined && age >= 0 && age < cfg.ttlSecs;
  const freshByExp = ann.expiration !== undefined ? ann.expiration > nowSecs : undefined;
  const ok = freshByAge && freshByExp !== false;
  const detailParts = [
    age !== undefined ? `age=${age}s/<${cfg.ttlSecs}s` : 'age=?(created_at not recoverable)',
    freshByExp === undefined ? 'exp=?' : `exp=${freshByExp ? 'future' : 'PAST'}`,
  ];
  steps.push({
    name: `${label}: fresh / unexpired`,
    ok: Boolean(ok),
    detail: detailParts.join(' '),
  });
}

function printSteps(steps: ProbeStep[]): boolean {
  let allOk = true;
  for (const s of steps) {
    const tag = s.ok ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
    if (!s.ok) allOk = false;
  }
  return allOk;
}

async function main(): Promise<void> {
  const cfg = resolveConfig();
  console.log('[discovery probe] verifying kind:10032 self-announce on the read WS:');
  console.log(`  relay read WS : ${cfg.relayWsUrl}`);
  console.log(`  apex ILP      : ${cfg.apexIlp}`);
  console.log(`  store ILP     : ${cfg.storeIlp}`);
  console.log(`  TTL window    : ${cfg.ttlSecs}s`);

  const anns = await fetchAnnouncements(cfg.relayWsUrl, cfg.readTimeoutMs);
  const nowSecs = Math.floor(Date.now() / 1000);
  const steps: ProbeStep[] = [
    {
      name: `read WS: received kind:10032 events`,
      ok: anns.length > 0,
      detail: `count=${anns.length}`,
    },
  ];

  checkOne('apex', pickFor(anns, cfg.apexIlp), cfg.apexIlp, cfg, nowSecs, steps);
  checkOne('store', pickFor(anns, cfg.storeIlp), cfg.storeIlp, cfg, nowSecs, steps);

  console.log('');
  const allOk = printSteps(steps);
  console.log(`\n[discovery probe] OVERALL: ${allOk ? 'PASS' : 'FAIL'}`);
  if (!allOk) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('[discovery probe] FATAL:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
