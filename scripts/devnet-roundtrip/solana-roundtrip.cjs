/**
 * SOLANA paid round-trip through the already-running local terminator (e2e-connector).
 *
 * Approach A (direct connector Solana SDK). Mirrors the EVM `runPaidRoundTrip` POST,
 * but the chain-specific part is producing a Solana payment-channel claim:
 *   1. Open + deposit a Solana payment channel (client -> terminator) on the live devnet.
 *   2. Sign a Solana balance-proof (Ed25519 over PDA||nonce_LE||transferred_LE).
 *   3. Build a SolanaClaimMessage JSON in the exact shape PerPacketClaimService emits.
 *   4. POST a paid ILP PREPARE (carrying a POST /write envelope w/ a signed Nostr
 *      kind:1 event) to the terminator's /ilp edge with the claim header.
 *   5. Assert FULFILL (type 13); read the event back from the relay free-read WS.
 *   6. Sanity-check: an UNPAID POST gets a REJECT / x402.
 *
 * Run from the connector package so module resolution works:
 *   cd <connector-repo>/packages/connector
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_PATH=<connector-repo>/node_modules \
 *     node <thisfile>
 */
'use strict';

const http = require('http');
const { URL } = require('url');
const WebSocket = require('ws');
const { finalizeEvent, generateSecretKey } = require('nostr-tools');
const { serializePacket, deserializePacket, PacketType } = require('@toon-protocol/shared');

const CONNECTOR =
  process.env.CONNECTOR_PKG || require('path').resolve(__dirname, '../../packages/connector');
const { SolanaPaymentChannelSDK } = require(CONNECTOR + '/dist/settlement/solana-payment-channel-sdk.js');
const { resolveSolanaSigner } = require(CONNECTOR + '/dist/settlement/provider/signer-resolution.js');
const {
  address,
  getBase58Encoder,
  createSolanaRpcSubscriptions,
  sendAndConfirmTransactionFactory,
} = require('@solana/kit');
const { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync } = require('@solana-program/token');

// ── Live devnet + terminator constants ──────────────────────────────────────
const RPC = process.env.DEVNET_SOLANA_RPC || 'https://solana-rpc.97-107-135-110.sslip.io';
// The hosted devnet serves the Solana PubSub WebSocket on a SEPARATE host
// (solana-ws.*) — NOT rpcUrl with the scheme swapped. The SDK's internal
// deriveWsUrl(rpcUrl) would wrongly target wss://solana-rpc.* (405). Override.
const RPC_WS = process.env.DEVNET_SOLANA_WS || 'wss://solana-ws.97-107-135-110.sslip.io';
const PROGRAM = '7CLmNaK9z6QgUWQpCFdeUTqfwXeZH5ssohAKtyXKY4Hp';
const MINT = 'H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
// Funded devnet client keypair (base58). Required via env -- never commit a key.
const CLIENT_SOL_KEY = process.env.SOL_CLIENT_PRIV;
if (!CLIENT_SOL_KEY) throw new Error('set SOL_CLIENT_PRIV to a funded devnet Solana keypair (base58)');
const CLIENT_ADDR = 'HpHXY4wXdYJxyVTouE6Y9XpQHp5L5xtzYPuSFt4zp1WA';
const TERMINATOR_SOL_ADDR = '4hb7gurrpDCTdvACxxeB6dNJGC4Ybnk26jH7BUmU8x9c';

const TERMINATOR_ILP_URL = process.env.TERMINATOR_ILP_URL || 'http://127.0.0.1:3000/ilp';
const RELAY_WS_URL = process.env.RELAY_WS_URL || 'ws://127.0.0.1:7100';
const RELAY_STORE_DESTINATION = 'g.terminator.relay.store';
const TERMINATOR_PEER_ID = 'terminator';

const PRICE = 1000n; // route price in connector-multichain.yaml
const DEPOSIT = process.env.DEVNET_INITIAL_DEPOSIT || '100000000'; // 100 USDC (6dp)
const CHALLENGE_SECS = 3600n;

const log = (...a) => console.log('[sol-e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── pino-ish logger shim the SDK expects ────────────────────────────────────
function makeLogger() {
  const noop = () => {};
  const l = {
    info: (o, m) => log('SDK', m || '', o && o.event ? `(${o.event}${o.txSignature ? ' tx=' + o.txSignature : ''}${o.channelPDA ? ' pda=' + o.channelPDA : ''})` : ''),
    debug: noop, warn: (o, m) => log('SDK warn', m || '', o), error: (o, m) => log('SDK error', m || '', o),
    child: () => l,
  };
  return l;
}

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

// ── inner HTTP envelope the terminator reverse-proxies (POST /write {event}) ─
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
    const subId = 'sol-e2e';
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

// ── on-chain channel state via RPC (for evidence) ───────────────────────────
async function rpc(method, params) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function main() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') {
    log('WARN: NODE_TLS_REJECT_UNAUTHORIZED is not 0 — staging TLS may fail');
  }
  const logger = makeLogger();
  const results = [];

  // 0. Resolve client signer from base58 secret key (same path the node uses).
  const signer = await resolveSolanaSigner(CLIENT_SOL_KEY, logger);
  if (String(signer.address) !== CLIENT_ADDR) throw new Error(`signer addr mismatch: ${signer.address} != ${CLIENT_ADDR}`);
  log('client signer resolved:', signer.address);

  const sdk = new SolanaPaymentChannelSDK(RPC, PROGRAM, logger);
  // Repoint the SDK's RPC-subscription transport at the correct WS host and
  // rebuild its send-and-confirm factory so tx confirmation works (see RPC_WS).
  const patchedSubs = createSolanaRpcSubscriptions(RPC_WS);
  sdk._rpcSubscriptions = patchedSubs;
  sdk._sendAndConfirmTransaction = sendAndConfirmTransactionFactory({ rpc: sdk._rpc, rpcSubscriptions: patchedSubs });
  log('patched SDK RPC-subscriptions WS ->', RPC_WS);

  // 1. Derive the channel PDA (client <-> terminator, USDC mint).
  const { pda: channelPDA, bump } = SolanaPaymentChannelSDK.deriveChannelPDA(CLIENT_ADDR, TERMINATOR_SOL_ADDR, MINT, PROGRAM);
  const { pda: vaultPDA } = SolanaPaymentChannelSDK.deriveVaultPDA(channelPDA, PROGRAM);
  log('channelPDA', channelPDA, 'bump', bump, 'vaultPDA', vaultPDA);

  // 2. Open the channel on-chain if it does not yet exist (idempotent).
  let openTx = null;
  let alreadyOpen = false;
  try {
    const existing = await sdk.getChannelState(channelPDA);
    alreadyOpen = true;
    log('channel already exists on-chain, state =', existing.state, 'depositA', existing.depositA.toString(), 'depositB', existing.depositB.toString());
  } catch (e) {
    log('channel not found on-chain, opening:', e.message);
    const r = await sdk.openChannel(signer, CLIENT_ADDR, TERMINATOR_SOL_ADDR, MINT, CHALLENGE_SECS);
    openTx = r.txSignature;
    log('OPEN tx', openTx, 'pda', r.channelPDA);
  }
  results.push({ name: 'solana channel opened/exists on-chain', ok: true, detail: alreadyOpen ? 'pre-existing' : `openTx=${openTx}` });

  // 3. Ensure client USDC ATA exists, then deposit into the channel vault.
  const [clientAta] = await findAssociatedTokenPda({ owner: address(CLIENT_ADDR), mint: address(MINT), tokenProgram: address(TOKEN_PROGRAM) });
  log('client USDC ATA', clientAta);
  let depositTx = null;
  try {
    const st = await sdk.getChannelState(channelPDA);
    // depositA is the client's side (participant A == opener). Deposit if zero.
    const clientIsA = st.participantA === CLIENT_ADDR;
    const clientDeposit = clientIsA ? st.depositA : st.depositB;
    if (clientDeposit === 0n) {
      const d = await sdk.deposit(signer, channelPDA, String(clientAta), BigInt(DEPOSIT));
      depositTx = d.txSignature;
      log('DEPOSIT tx', depositTx, 'amount', DEPOSIT);
    } else {
      log('channel already funded on client side:', clientDeposit.toString());
    }
  } catch (e) {
    // If freshly opened, getChannelState should work; deposit unconditionally on error.
    log('deposit-precheck error, depositing anyway:', e.message);
    const d = await sdk.deposit(signer, channelPDA, String(clientAta), BigInt(DEPOSIT));
    depositTx = d.txSignature;
    log('DEPOSIT tx', depositTx, 'amount', DEPOSIT);
  }

  // Re-read on-chain state for evidence.
  const finalState = await sdk.getChannelState(channelPDA);
  log('on-chain channel state:', JSON.stringify({
    state: finalState.state, participantA: finalState.participantA, participantB: finalState.participantB,
    depositA: finalState.depositA.toString(), depositB: finalState.depositB.toString(),
    transferredA: finalState.transferredAmountA.toString(), nonceA: finalState.nonceA.toString(),
  }));
  results.push({ name: 'solana channel USDC deposited', ok: (finalState.depositA + finalState.depositB) > 0n,
    detail: `depositA=${finalState.depositA} depositB=${finalState.depositB} depositTx=${depositTx}` });

  // 4. Sign a Solana balance proof and build the SolanaClaimMessage JSON.
  //    transferredAmount is CUMULATIVE and nonce must be monotonic — derive both
  //    from the client's current on-chain side so repeat runs also produce a
  //    clean, redeemable claim (the per-packet FULFILL gate is signature-only,
  //    but the async claim-receiver rejects a replayed nonce as non-monotonic).
  const clientIsA = finalState.participantA === CLIENT_ADDR;
  const onChainNonce = clientIsA ? finalState.nonceA : finalState.nonceB;
  // The connector keeps an in-memory monotonic nonce guard per channel that
  // advances on every accepted claim and is NOT reset by on-chain state. So a
  // strictly-increasing nonce/cumulative across runs is required for the async
  // claim-receiver to accept (the per-packet FULFILL gate is signature-only and
  // would accept either way). Persist a local counter, floored at on-chain+1.
  const fs = require('fs');
  const counterFile = __dirname + '/.nonce-counter';
  let prev = 0;
  try { prev = parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10) || 0; } catch {}
  const nonce = Math.max(Number(onChainNonce) + 1, prev + 1);
  fs.writeFileSync(counterFile, String(nonce));
  const transferredAmount = PRICE * BigInt(nonce); // cumulative, strictly increasing with nonce
  const sigBytes = await SolanaPaymentChannelSDK.signBalanceProof(channelPDA, BigInt(nonce), transferredAmount, signer.keyPair);
  const signatureB64 = Buffer.from(sigBytes).toString('base64');
  const claim = {
    version: '1.0',
    blockchain: 'solana',
    messageId: `solana-${channelPDA.substring(0, 8)}-${nonce}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    senderId: 'sol-roundtrip-client',
    programId: PROGRAM,
    channelAccount: channelPDA,
    nonce,
    transferredAmount: transferredAmount.toString(),
    signature: signatureB64,
    signerPublicKey: CLIENT_ADDR,
    cluster: 'devnet',
  };
  log('built SolanaClaimMessage:', JSON.stringify(claim));

  // 5. POST the paid PREPARE + claim header. Assert FULFILL.
  const event = signEphemeralKind1Event(`solana paid round-trip ${new Date().toISOString()}`);
  const envelope = buildStoreWriteEnvelope(event);
  const prepare = {
    type: PacketType.PREPARE,
    destination: RELAY_STORE_DESTINATION,
    amount: PRICE,
    expiresAt: new Date(Date.now() + 60000),
    data: envelope,
  };
  const res = await postRaw(TERMINATOR_ILP_URL, serializePacket(prepare), {
    'ilp-peer-id': TERMINATOR_PEER_ID,
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

  // 6. WS read-back verification.
  let stored = false;
  if (isFulfill) {
    stored = await verifyEventStoredViaWs(RELAY_WS_URL, event.id);
    log('relay WS read-back:', stored ? `FOUND id ${event.id}` : `NOT FOUND id ${event.id}`);
    results.push({ name: 'relay stored the write (WS free-read, id substring match)', ok: stored, detail: stored ? `found id ${event.id}` : `id ${event.id} not seen before EOSE` });
  }

  // 7. Negative: UNPAID POST (no claim header) must NOT fulfill.
  const unpaidEnv = buildStoreWriteEnvelope(signEphemeralKind1Event(`unpaid ${new Date().toISOString()}`));
  const unpaidPrepare = { type: PacketType.PREPARE, destination: RELAY_STORE_DESTINATION, amount: PRICE, expiresAt: new Date(Date.now() + 60000), data: unpaidEnv };
  const ures = await postRaw(TERMINATOR_ILP_URL, serializePacket(unpaidPrepare), {});
  let notFulfilled, udetail;
  if (ures.status === 200) {
    notFulfilled = ures.body.length > 0 && ures.body[0] !== PacketType.FULFILL;
    udetail = `HTTP 200, ILP type ${ures.body[0]} (REJECT=${PacketType.REJECT})`;
  } else { notFulfilled = ures.status >= 400; udetail = `HTTP ${ures.status} (x402 greeting expected)`; }
  log('UNPAID POST /ilp ->', udetail);
  results.push({ name: 'UNPAID POST /ilp is NOT fulfilled (402/REJECT)', ok: notFulfilled, detail: udetail });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n==================== SOLANA ROUND-TRIP RESULTS ====================');
  let allOk = true;
  for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`); if (!r.ok) allOk = false; }
  console.log('===================================================================');
  console.log(JSON.stringify({
    green: allOk, channelPDA, vaultPDA, openTx, depositTx,
    onChain: { state: finalState.state, depositA: finalState.depositA.toString(), depositB: finalState.depositB.toString() },
    claimNonce: nonce, transferredAmount: transferredAmount.toString(),
  }, null, 2));
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error('[sol-e2e] FATAL:', e && e.stack ? e.stack : e); process.exit(2); });
