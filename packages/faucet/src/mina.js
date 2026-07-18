// ---------------------------------------------------------------------------
// Mina faucet — native-MINA treasury drip
// ---------------------------------------------------------------------------
// The TOON devnet uses the PUBLIC Mina devnet (we only proxy reads at
// mina.devnet.toonprotocol.dev/graphql); there is no self-hosted Mina chain.
// So instead of link-fallback-to-the-public-faucet, we drip NATIVE MINA from a
// funded devnet treasury account (Mina HD index 2).
//
// Native payments do NOT need o1js / circuit proving — `mina-signer` signs the
// payment client-side from the treasury's base58 private key (a Schnorr sig
// over the Pasta curve), so this is lightweight enough for the 2 GB devnet box.
// We then submit the signed payment to the public devnet via the `sendPayment`
// GraphQL mutation. (zkApp commands WOULD need proving — but a plain payment
// does not.)
//
// GraphQL shapes were introspected against the live public devnet endpoint
// (api.minascan.io/node/devnet/v1/graphql) — see the PR description:
//   * SendPaymentInput  = { from, to, amount, fee, nonce, memo?, validUntil? }
//       — amount/fee are UInt64 STRINGS in nanomina (1 MINA = 1e9 nanomina).
//   * SignatureInput     = { field, scalar } | { rawSignature }
//       — mina-signer's `signPayment(...).signature` is exactly { field, scalar }.
//   * sendPayment(signature: SignatureInput, input: SendPaymentInput!)
//       returns { payment { hash id } } (a UserCommand).
//
// Graceful degradation: if MINA_FAUCET_KEY is unset the route answers a 503
// with the old public-faucet link as the documented fallback, so an
// unconfigured (e.g. EVM-only) deploy still boots and still points users at a
// way to get MINA.

import Client from 'mina-signer';

// nanomina per MINA (Mina's UInt64 on-chain unit).
const NANO = 1_000_000_000n;

// Optional: if MINA_TREASURY_ADDRESS is set, the faucet asserts the provided
// key derives that exact public address (fail-loud guard against misconfiguration).
// Leave unset to accept any valid funded key (e.g. lightnet genesis accounts,
// which the provisioning acquires fresh on each reset — their address is not
// known ahead of time, so a hardcoded treasury would break the lightnet drip).
// Read LAZILY (inside createMinaFaucet) rather than at module load, so the
// guard actually sees the env the factory is called under — and so the tests
// can exercise it.
const expectedTreasury = () => process.env.MINA_TREASURY_ADDRESS || null;

const MINA_NETWORK = process.env.MINA_NETWORK || 'devnet';
const MINA_GRAPHQL_URL =
  process.env.MINA_GRAPHQL_URL || 'https://api.minascan.io/node/devnet/v1/graphql';
const MINA_PUBLIC_FAUCET_URL = process.env.MINA_FAUCET_URL || 'https://faucet.minaprotocol.com';
const MINA_DRIP_AMOUNT = process.env.MINA_DRIP_AMOUNT || '5'; // MINA per drip
const MINA_FEE = process.env.MINA_FEE || '0.1'; // MINA fee

// Mina B62 public keys are base58check, "B62q"-prefixed.
export function isValidMinaAddress(address) {
  return typeof address === 'string' && /^B62q[1-9A-HJ-NP-Za-km-z]{48,55}$/.test(address);
}

// Convert a decimal MINA string ("5", "0.1", "5.25") to a nanomina BigInt
// without floating point (so 0.1 MINA is exactly 100_000_000 nanomina).
function minaToNano(value) {
  const [whole, frac = ''] = String(value).trim().split('.');
  const fracPadded = (frac + '000000000').slice(0, 9);
  return BigInt(whole || '0') * NANO + BigInt(fracPadded || '0');
}

async function minaGraphql(query, variables) {
  const res = await fetch(MINA_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Mina GraphQL HTTP ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  if (body.errors && body.errors.length) {
    throw new Error(`Mina GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  return body.data;
}

// The unconfigured-deploy response: a documented 503 + the public-faucet link
// so users still have a path to devnet MINA. Used by the route below and
// mirrored into /api/info.
export function minaFallbackLink(address) {
  return `${MINA_PUBLIC_FAUCET_URL}/?address=${encodeURIComponent(address || '')}`;
}

// Returns a faucet object, or null if Mina drip is not configured for this
// deploy (MINA_FAUCET_KEY unset). Mirrors createSolanaFaucet's shape.
//
// Throws (fail-loud) only when a key IS configured but is the WRONG key — that
// is operator misconfiguration we must not paper over.
export function createMinaFaucet() {
  const key = process.env.MINA_FAUCET_KEY;
  if (!key) {
    console.log('ℹ️  Mina drip disabled: MINA_FAUCET_KEY not set (route will 503 + link out).');
    return null;
  }

  const client = new Client({ network: 'testnet' }); // Mina devnet == 'testnet' network id

  // Derive + verify the treasury public key WITHOUT ever logging the key.
  let derived;
  try {
    derived = client.derivePublicKey(key);
  } catch {
    // Don't echo the key or the raw error (which may embed it).
    throw new Error('MINA_FAUCET_KEY is not a valid base58 Mina private key.');
  }
  const expected = expectedTreasury();
  if (expected && derived !== expected) {
    throw new Error(
      `MINA_FAUCET_KEY derives ${derived} but MINA_TREASURY_ADDRESS is set to ${expected}. ` +
        'Set MINA_FAUCET_KEY to the correct treasury private key, or unset MINA_TREASURY_ADDRESS.'
    );
  }

  const amountNano = minaToNano(MINA_DRIP_AMOUNT);
  const feeNano = minaToNano(MINA_FEE);

  console.log('✅ Mina drip enabled (native-MINA treasury payment via mina-signer)');
  console.log(`   Treasury:   ${derived}`);
  console.log(`   GraphQL:    ${MINA_GRAPHQL_URL}`);
  console.log(`   Per drip:   ${MINA_DRIP_AMOUNT} MINA (fee ${MINA_FEE} MINA)`);

  return {
    treasury: derived,
    graphqlUrl: MINA_GRAPHQL_URL,
    dripAmount: MINA_DRIP_AMOUNT,
    fee: MINA_FEE,

    isValidAddress: isValidMinaAddress,

    async drip(recipient) {
      // 1. Read the treasury's current nonce + liquid balance.
      const data = await minaGraphql(
        `query Treasury($pk: PublicKey!) {
          account(publicKey: $pk) { nonce balance { liquid } }
        }`,
        { pk: derived }
      );
      const account = data.account;
      if (!account || account.nonce == null) {
        throw new Error(`Treasury ${derived} not found on ${MINA_GRAPHQL_URL} (uninitialized?).`);
      }

      // 2. Insufficient-balance guard (liquid is nanomina string).
      const liquid = BigInt(account.balance?.liquid ?? '0');
      const needed = amountNano + feeNano;
      if (liquid < needed) {
        const err = new Error(
          `Mina treasury underfunded: have ${liquid} nanomina, need ${needed} ` +
            `(${MINA_DRIP_AMOUNT} MINA + ${MINA_FEE} fee). Top up ${derived}.`
        );
        err.code = 'INSUFFICIENT_FUNDS';
        throw err;
      }

      // 3. Build + sign the native payment with mina-signer (no proving).
      const payment = {
        from: derived,
        to: recipient,
        amount: amountNano.toString(),
        fee: feeNano.toString(),
        nonce: String(account.nonce),
      };
      const signed = client.signPayment(payment, key);

      // Self-check the signature before we burn a nonce on the network.
      if (!client.verifyPayment(signed)) {
        throw new Error('mina-signer produced a signature that failed self-verification.');
      }

      // 4. Submit via the sendPayment mutation. signed.data carries the exact
      //    SendPaymentInput fields; signed.signature is { field, scalar }.
      const result = await minaGraphql(
        `mutation Send($input: SendPaymentInput!, $signature: SignatureInput!) {
          sendPayment(input: $input, signature: $signature) {
            payment { hash id }
          }
        }`,
        {
          input: {
            from: signed.data.from,
            to: signed.data.to,
            amount: signed.data.amount,
            fee: signed.data.fee,
            nonce: signed.data.nonce,
          },
          signature: { field: signed.signature.field, scalar: signed.signature.scalar },
        }
      );

      const hash = result?.sendPayment?.payment?.hash ?? null;
      const id = result?.sendPayment?.payment?.id ?? null;
      console.log(`  📤 Sent ${MINA_DRIP_AMOUNT} MINA to ${recipient}: ${hash}`);

      return {
        hash,
        id,
        amount: MINA_DRIP_AMOUNT,
        fee: MINA_FEE,
        nonce: payment.nonce,
        treasury: derived,
      };
    },
  };
}

// Capability descriptor surfaced at /api/info. `faucet` is the live
// createMinaFaucet() (or null when unconfigured). `usdcInfo` is the optional
// fragment from `minaUsdcInfo(dripper)` (mina-usdc.mjs) describing the USDC
// drip capability (treasury self-mint + TRANSFER — the rate-limited token has
// no admin-mint): when the dripper is configured this advertises `drips.usdc`,
// the dedicated `usdcRoute`, and the `selfMint` bypass hint alongside the
// native-MINA drip; when it's null we still advertise the native drip and set
// `usdcDrip: false`.
export function minaInfo(faucet, usdcInfo = { usdcDrip: false }) {
  const usdcFragment = usdcInfo.usdcDrip
    ? {
        usdcDrip: true,
        usdcRoute: '/api/mina/usdc-request',
        usdcToken: usdcInfo.usdcToken,
        usdcTokenId: usdcInfo.usdcTokenId,
        usdcTreasury: usdcInfo.treasury,
        // The treasury replenishes by SELF-MINT, capped on-chain at this many
        // USDC per ~24h — the honest ceiling on total daily drips.
        usdcDailyTreasuryCap: usdcInfo.dailyTreasuryCapUsdc,
        usdcCooldownHours: usdcInfo.cooldownHours,
        // Anyone can bypass the faucet: the token's mint is permissionless
        // (rate-limited per address, recipient signs). See the note inside.
        selfMint: usdcInfo.selfMint,
      }
    : { usdcDrip: false };

  if (faucet) {
    return {
      enabled: true,
      route: '/api/mina/request',
      ready: true,
      network: MINA_NETWORK,
      chain: 'public-devnet',
      drip: true,
      mode: 'treasury-drip', // real native-MINA drip from a funded treasury
      treasury: faucet.treasury,
      drips: usdcInfo.usdcDrip
        ? { mina: faucet.dripAmount, usdc: usdcInfo.usdcAmount }
        : { mina: faucet.dripAmount },
      ...usdcFragment,
      graphqlUrl: faucet.graphqlUrl,
    };
  }
  return {
    enabled: false,
    route: '/api/mina/request',
    ready: false,
    network: MINA_NETWORK,
    chain: 'public-devnet',
    drip: false,
    ...usdcFragment,
    mode: 'link', // unconfigured: link out to the public faucet
    faucetUrl: MINA_PUBLIC_FAUCET_URL,
    note:
      'Mina drip is not configured on this host (MINA_FAUCET_KEY unset). ' +
      'Set it to the treasury base58 private key to enable native-MINA drips; ' +
      'until then the route 503s with a public-faucet link.',
  };
}
