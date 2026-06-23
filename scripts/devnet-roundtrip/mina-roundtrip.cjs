/**
 * MINA paid round-trip through the already-running local connector (e2e-connector).
 *
 * The Mina analogue of the GREEN Solana round-trip. Transport (envelope, WS read-back,
 * PREPARE POST, claim header) is IDENTICAL to solana-roundtrip.cjs — the only
 * Mina-specific part is producing a MinaClaimMessage:
 *   1. Read the on-chain channelHash + nonce of the USDC PaymentChannel zkApp.
 *   2. Sign a Mina balance proof = signBalanceProof JSON: a Schnorr signature by the
 *      channel's participantA over [Poseidon(balanceA,balanceB,salt), nonce, channelHash].
 *      (helper: scratchpad/esm-deploy/sign-claim.mts, run under o1js ESM.)
 *   3. Build a MinaClaimMessage in the exact PerPacketClaimService shape; `proof` is
 *      base64(JSON of that signBalanceProof output) per the Issue #90 wire format.
 *   4. POST a paid ILP PREPARE (POST /write envelope w/ signed Nostr kind:1 event) to
 *      the connector's /ilp edge with the claim header. Assert FULFILL (type 13).
 *   5. Read the event back from the relay free-read WS.
 *   6. Negative: UNPAID POST must NOT fulfill (402 / REJECT).
 *
 * The connector's Mina FULFILL gate (InboundClaimValidator.verifyMinaClaim ->
 * MinaPaymentChannelProvider.verifyBalanceProof) is signature-only + channel-existence +
 * nonce-advance: it reads the on-chain channelHash & nonceField, verifies the claim's
 * `proof` signature against `signerPublicKey` over [commitment, nonce, channelHash], and
 * requires nonce > on-chain nonce. No in-circuit proving on the hot path.
 *
 * Run:
 *   cd <connector-repo>/packages/connector
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_PATH=<connector-repo>/node_modules \
 *     node /tmp/.../scratchpad/e2e/mina-roundtrip/mina-roundtrip.cjs
 */
'use strict';

const http = require('http');
const { URL } = require('url');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');
const { finalizeEvent, generateSecretKey } = require('nostr-tools');
const { serializePacket, deserializePacket, PacketType } = require('@toon-protocol/shared');

// ── Live devnet + connector constants ──────────────────────────────────────
const MINA_GRAPHQL = process.env.MINA_GRAPHQL || 'https://api.minascan.io/node/devnet/v1/graphql';
const CHANNEL = process.env.MINA_CHANNEL || 'B62qigQwEwBAsSZad4GhSun8CAwkh3GUbx2YN2TbUHU8tzVFcFTE95x';
const USDC_TOKEN_ID =
  process.env.MINA_TOKEN_ID ||
  '13770394610291091689442727083129874284486561081541786615444915557572882540748';
// participantA of the channel (the "client" side that signs the claim). Its private key
// signs the balance proof; the gate verifies it against the on-chain channelHash.
const CLIENT_MINA_PRIV = process.env.MINA_CLIENT_PRIV;
if (!CLIENT_MINA_PRIV) throw new Error('set MINA_CLIENT_PRIV to a funded devnet Mina key (EK..., base58)');

const ESM_DIR = process.env.MINA_ESM_DIR || require('path').resolve(__dirname, 'esm-deploy');

const CONNECTOR_ILP_URL = process.env.CONNECTOR_ILP_URL || 'http://127.0.0.1:3000/ilp';
const RELAY_WS_URL = process.env.RELAY_WS_URL || 'ws://127.0.0.1:7100';
const RELAY_STORE_DESTINATION = 'g.connector.relay.store';
const CONNECTOR_PEER_ID = 'connector';

const PRICE = 1000n; // route price in connector-multichain.yaml

// PREPARE expiry window (ms). Mina-specific: the FIRST claim against a freshly
// registered channel triggers a full on-chain channel verification against the
// GraphQL node (~60s on devnet); subsequent claims hit the ~0.6s fast path. A 60s
// window (the default used by the EVM/Solana harnesses) expires before that first
// round-trip completes → `R00 Packet has expired`, even though the claim itself
// validates and stores. Raise to 300s so the first Mina claim round-trips cleanly
// (connector #237). Override via MINA_PREPARE_EXPIRY_MS if devnet latency drifts.
const PREPARE_EXPIRY_MS = Number(process.env.MINA_PREPARE_EXPIRY_MS) || 300000;

const log = (...a) => console.log('[mina-e2e]', ...a);

// ── HTTP POST raw OER body ───────────────────────────────────────────────────
function postRaw(url, body, headers) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': body.length, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

// ── inner HTTP envelope the connector reverse-proxies (POST /write {event}) ─
// (verbatim from solana-roundtrip.cjs / the paid-roundtrip-client exports)
function buildHttpEnvelope(method, target, headers, bodyStr) {
  const CRLF = '\r\n';
  const head = [`${method} ${target} HTTP/1.1`, ...headers.map(([n, v]) => `${n}: ${v}`)].join(CRLF);
  return Buffer.concat([Buffer.from(head + CRLF + CRLF, 'latin1'), Buffer.from(bodyStr)]);
}
function signEphemeralKind1Event(content) {
  return finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content }, generateSecretKey());
}
function buildStoreWriteEnvelope(event) {
  return buildHttpEnvelope('POST', '/write', [['Host', 'relay'], ['Content-Type', 'application/json']], JSON.stringify({ event }));
}

// ── WS read verification (relay#24: EVENT[2] is a TOON STRING; substring id) ─
function verifyEventStoredViaWs(relayWsUrl, eventId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const subId = 'mina-e2e';
    let settled = false;
    const ws = new WebSocket(relayWsUrl);
    const finish = (found) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch {} resolve(found); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify(['REQ', subId, { kinds: [1] }])));
    ws.on('message', (data) => {
      let frame; try { frame = JSON.parse(data.toString()); } catch { return; }
      if (!Array.isArray(frame)) return;
      const [kind, sub, payload] = frame;
      if (sub !== subId) return;
      if (kind === 'EVENT' && typeof payload === 'string') { if (payload.includes(`id: ${eventId}`)) finish(true); }
      else if (kind === 'EOSE') setTimeout(() => finish(false), 1500);
    });
    ws.on('error', () => finish(false));
  });
}

// ── Mina GraphQL: read on-chain channel state ───────────────────────────────
async function minaAccount(pubkey) {
  const res = await fetch(MINA_GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `{ account(publicKey: "${pubkey}") { zkappState } }` }),
  });
  const j = await res.json();
  return j?.data?.account ?? null;
}

// ── produce the signBalanceProof JSON via the o1js ESM helper ───────────────
function signBalanceProof({ balanceA, balanceB, salt, nonce, channelHash }) {
  const out = execFileSync(
    'node',
    ['--loader', 'ts-node/esm', '--experimental-specifier-resolution=node', `${ESM_DIR}/sign-claim.mts`],
    {
      cwd: ESM_DIR,
      env: {
        ...process.env,
        SIGN_PRIV: CLIENT_MINA_PRIV,
        SIGN_BALANCE_A: String(balanceA),
        SIGN_BALANCE_B: String(balanceB),
        SIGN_SALT: String(salt),
        SIGN_NONCE: String(nonce),
        SIGN_CHANNEL_HASH: channelHash,
        TS_NODE_TRANSPILE_ONLY: '1',
        TS_NODE_COMPILER_OPTIONS:
          '{"experimentalDecorators":true,"emitDecoratorMetadata":true,"useDefineForClassFields":false,"target":"ES2022","module":"ESNext","allowImportingTsExtensions":true,"strict":false}',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1 << 20,
    }
  ).toString().trim();
  // The helper writes only the JSON to stdout (warnings go to stderr).
  return JSON.parse(out);
}

async function main() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') {
    log('WARN: NODE_TLS_REJECT_UNAUTHORIZED is not 0 — staging TLS may fail');
  }
  const results = [];

  // 1. Read the channel on-chain (channelHash=state[0], nonce=state[2], deposit=state[4], state=state[3], tokenId=state[7]).
  const acct = await minaAccount(CHANNEL);
  if (!acct || !acct.zkappState) throw new Error(`channel ${CHANNEL} not found on-chain`);
  const st = acct.zkappState;
  const channelHash = st[0];
  const onChainNonce = BigInt(st[2]);
  const depositTotal = BigInt(st[4]);
  const channelState = Number(st[3]);
  const tokenId = st[7];
  log('on-chain channel:', JSON.stringify({ CHANNEL, channelState, channelHash: channelHash.slice(0, 12) + '…', onChainNonce: onChainNonce.toString(), depositTotal: depositTotal.toString(), tokenId: tokenId.slice(0, 12) + '…' }));
  results.push({
    name: 'Mina USDC PaymentChannel exists on-chain (OPEN, USDC tokenId)',
    ok: channelState === 1 && tokenId === USDC_TOKEN_ID,
    detail: `state=${channelState} (1=OPEN) tokenId=${tokenId === USDC_TOKEN_ID ? 'USDC' : tokenId} deposit=${depositTotal}`,
  });

  // 2. Build + sign the claim. nonce must advance past on-chain nonce. Persist a local
  //    counter so repeat runs stay strictly increasing (mirrors solana-roundtrip).
  const fs = require('fs');
  const counterFile = __dirname + '/.nonce-counter';
  let prev = 0;
  try { prev = parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10) || 0; } catch {}
  const nonce = Math.max(Number(onChainNonce) + 1, prev + 1);
  fs.writeFileSync(counterFile, String(nonce));
  // Cumulative balanceA grows with nonce; balanceB=0; per-session random salt.
  const balanceA = PRICE * BigInt(nonce);
  const balanceB = 0n;
  const salt = BigInt('0x' + require('crypto').randomBytes(15).toString('hex'));
  log(`signing balance proof: nonce=${nonce} balanceA=${balanceA} salt=${salt}`);
  const sbp = signBalanceProof({ balanceA, balanceB, salt, nonce, channelHash });
  log('signBalanceProof ->', JSON.stringify({ commitment: sbp.commitment.slice(0, 12) + '…', signerPublicKey: sbp.signerPublicKey, nonce: sbp.nonce }));

  // proof wire format = base64(JSON) of the signBalanceProof output (Issue #90).
  const proofB64 = Buffer.from(JSON.stringify(sbp), 'utf8').toString('base64');
  const claim = {
    version: '1.0',
    blockchain: 'mina',
    messageId: `mina-${CHANNEL.substring(0, 8)}-${nonce}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    senderId: 'mina-roundtrip-client',
    zkAppAddress: CHANNEL,
    tokenId: USDC_TOKEN_ID,
    balanceCommitment: balanceA.toString(), // plaintext cumulative balanceA (PerPacketClaimService convention)
    nonce,
    proof: proofB64,
    salt: salt.toString(),
    transferredAmount: balanceA.toString(),
    signerPublicKey: sbp.signerPublicKey,
    network: 'devnet',
  };
  log('built MinaClaimMessage:', JSON.stringify({ ...claim, proof: '<base64>' }));

  // 3. POST the paid PREPARE + claim header. Assert FULFILL.
  const event = signEphemeralKind1Event(`mina paid round-trip ${new Date().toISOString()}`);
  const envelope = buildStoreWriteEnvelope(event);
  const prepare = {
    type: PacketType.PREPARE,
    destination: RELAY_STORE_DESTINATION,
    amount: PRICE,
    expiresAt: new Date(Date.now() + PREPARE_EXPIRY_MS),
    data: envelope,
  };
  const res = await postRaw(CONNECTOR_ILP_URL, serializePacket(prepare), {
    'ilp-peer-id': CONNECTOR_PEER_ID,
    'ilp-payment-channel-claim': Buffer.from(JSON.stringify(claim), 'utf8').toString('base64'),
  });
  let isFulfill = false, outcome = `HTTP ${res.status}`;
  if (res.status === 200 && res.body.length > 0) {
    try {
      const pkt = deserializePacket(res.body);
      isFulfill = pkt.type === PacketType.FULFILL;
      outcome = `HTTP 200, ILP type ${res.body[0]} (${pkt.type === PacketType.FULFILL ? 'FULFILL' : pkt.type === PacketType.REJECT ? 'REJECT' : pkt.type})`;
      if (pkt.type === PacketType.REJECT) outcome += ` code=${pkt.code} msg="${pkt.message}"`;
    } catch (e) { outcome = `HTTP 200 undeserializable: ${e.message}`; }
  } else if (res.body.length) {
    outcome += ` body="${res.body.toString('utf8').slice(0, 200)}"`;
  }
  log('paid POST /ilp ->', outcome);
  results.push({ name: 'paid POST /ilp round-trips to FULFILL', ok: isFulfill, detail: outcome });

  // 4. WS read-back verification.
  let stored = false;
  if (isFulfill) {
    stored = await verifyEventStoredViaWs(RELAY_WS_URL, event.id);
    log('relay WS read-back:', stored ? `FOUND id ${event.id}` : `NOT FOUND id ${event.id}`);
    results.push({ name: 'relay stored the write (WS free-read, id substring match)', ok: stored, detail: stored ? `found id ${event.id}` : `id ${event.id} not seen before EOSE` });
  }

  // 5. Negative: UNPAID POST (no claim header) must NOT fulfill.
  const unpaidEnv = buildStoreWriteEnvelope(signEphemeralKind1Event(`unpaid ${new Date().toISOString()}`));
  const unpaidPrepare = { type: PacketType.PREPARE, destination: RELAY_STORE_DESTINATION, amount: PRICE, expiresAt: new Date(Date.now() + PREPARE_EXPIRY_MS), data: unpaidEnv };
  const ures = await postRaw(CONNECTOR_ILP_URL, serializePacket(unpaidPrepare), {});
  let notFulfilled, udetail;
  if (ures.status === 200) {
    notFulfilled = ures.body.length > 0 && ures.body[0] !== PacketType.FULFILL;
    udetail = `HTTP 200, ILP type ${ures.body[0]} (REJECT=${PacketType.REJECT})`;
  } else { notFulfilled = ures.status >= 400; udetail = `HTTP ${ures.status} (x402 greeting expected)`; }
  log('UNPAID POST /ilp ->', udetail);
  results.push({ name: 'UNPAID POST /ilp is NOT fulfilled (402/REJECT)', ok: notFulfilled, detail: udetail });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n==================== MINA ROUND-TRIP RESULTS ====================');
  let allOk = true;
  for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`); if (!r.ok) allOk = false; }
  console.log('=================================================================');
  console.log(JSON.stringify({
    green: allOk, channel: CHANNEL, tokenId: USDC_TOKEN_ID,
    onChain: { channelState, depositTotal: depositTotal.toString(), onChainNonce: onChainNonce.toString() },
    claimNonce: nonce, balanceA: balanceA.toString(),
  }, null, 2));
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error('[mina-e2e] FATAL:', e && e.stack ? e.stack : e); process.exit(2); });
