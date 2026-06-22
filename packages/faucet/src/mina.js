// ---------------------------------------------------------------------------
// Mina faucet route
// ---------------------------------------------------------------------------
// The TOON devnet uses the PUBLIC Mina devnet (we only proxy reads at
// mina.devnet.toonprotocol.dev/graphql); there is no self-hosted Mina chain to
// drip from. So funding goes through the public Mina faucet.
//
// Investigation (2026-06, confirmed against the live endpoints — see the PR
// description):
//   * `GET  https://faucet.minaprotocol.com/api/v1/challenge` returns a
//     sum-to-100 ZK challenge `{ challenge, challengeId, expiresAt }`.
//   * `POST https://faucet.minaprotocol.com/api/v1/faucet` with only
//     `{ network, address }` returns `400 { "status": "challenge-required" }`.
//   * A valid request must additionally carry `challengeId`, `userAnswer`, and
//     a compiled-o1js ZK `proof` (the `sumToOneHundred` circuit). This is the
//     anti-bot "captcha": producing it requires compiling an o1js circuit
//     (~30-60s) and proving in-process.
//
// Per the task scope ("do NOT build a Mina treasury-drip / heavyweight o1js
// path in this pass unless trivial"), we DO NOT bundle o1js + the proving
// circuit here. The route returns a helpful link to the public faucet
// pre-filled with the address, and documents the proxy as the follow-up.
//
// FOLLOW-UP (tracked for a later pass): bundle o1js in the faucet image, fetch
// the challenge, compile/cache the `sumToOneHundred` circuit, prove
// `userAnswer = 100 - challenge`, and POST the full body to actually proxy the
// drip. See o1js src/lib/mina/v1/mina.ts `faucet()` for the exact shape.

const MINA_NETWORK = process.env.MINA_NETWORK || 'devnet';
const MINA_FAUCET_URL = process.env.MINA_FAUCET_URL || 'https://faucet.minaprotocol.com';
const MINA_READ_GRAPHQL =
  process.env.MINA_READ_GRAPHQL || 'https://mina.devnet.toonprotocol.dev/graphql';

// Mina B62 public keys are base58check, 55 chars, prefixed "B62q".
export function isValidMinaAddress(address) {
  return typeof address === 'string' && /^B62q[1-9A-HJ-NP-Za-km-z]{48,55}$/.test(address);
}

export function minaInfo() {
  return {
    network: MINA_NETWORK,
    chain: 'public-devnet',
    drip: false, // we link out; no treasury drip in this pass
    faucetUrl: MINA_FAUCET_URL,
    readGraphql: MINA_READ_GRAPHQL,
    note:
      'Mina is the PUBLIC devnet (TOON proxies reads only). The public faucet ' +
      'requires a ZK challenge proof (captcha), so this route links out instead ' +
      'of auto-dripping. Proxying the ZK challenge is a documented follow-up.',
  };
}

// Returns the JSON body for POST /api/mina/request. Always 200 with a clear
// `funded: false` + a ready-to-click link; honest about the path used.
export function handleMinaRequest(address) {
  const link = `${MINA_FAUCET_URL}/?address=${encodeURIComponent(address)}`;
  return {
    success: true,
    funded: false,
    path: 'link', // not 'proxy' — see mina.js header for why
    network: MINA_NETWORK,
    address,
    faucetUrl: link,
    readGraphql: MINA_READ_GRAPHQL,
    message:
      'Mina uses the PUBLIC devnet. The public faucet requires a ZK-challenge ' +
      'proof (captcha) that cannot be proxied without compiling an o1js circuit ' +
      'in-process, so request your devnet MINA from the link below. ' +
      'Auto-proxying the ZK challenge is a tracked follow-up.',
  };
}
