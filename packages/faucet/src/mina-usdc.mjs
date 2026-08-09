// ---------------------------------------------------------------------------
// Mina USDC faucet — treasury SELF-MINT + TRANSFER drip (o1js zk-proving)
// ---------------------------------------------------------------------------
// The public-devnet USDC token is gated by `RateLimitedUsdcAdmin`
// (packages/mina-zkapp/src/usdc-rate-limited-admin.ts): mints are
// PERMISSIONLESS but capped at 1,000 USDC per address per ~24h window, and a
// mint requires the RECIPIENT's signature (the mint-receipt AU) — so the
// faucet CANNOT mint to its users by design (nobody can mint at a stranger,
// which also protects users' own daily allowances from griefing). The old
// admin-mint flow this module used to implement does not work against this
// token — the admin key holds pause/upgrade rights only.
//
// What the faucet does instead (see packages/mina-zkapp/src/usdc-faucet.ts,
// which owns the orchestration + its LocalBlockchain unit tests):
//   1. TREASURY SELF-MINT (lazy top-up): when the treasury's USDC balance is
//      below the low-water mark, it self-mints its remaining window allowance
//      to ITSELF (the treasury key signs its own receipt). Ceiling: 1,000
//      USDC per ~24h — the honest replenishment limit of this design.
//   2. TRANSFER drip: the user gets a plain token transfer from the treasury
//      — transfers are NOT capped by the admin contract, so drips keep
//      working from balance even when the day's mint window is exhausted.
//      First-time recipients get their 1-MINA token-account creation fee paid
//      by the treasury (AccountUpdate.fundNewAccount).
// A per-address off-chain cooldown (src/drip-limiter.js, applied by the
// routes in index.js) keeps one address from draining the daily treasury
// allowance.
//
// Anyone can BYPASS the faucet: hold ~1.2 devnet MINA (0.1 fee + 2× 1-MINA
// account creation on the first mint) and run tools/mina/self-mint-usdc.mts
// for your own 1,000 USDC/day. The faucet is a convenience for zero-MINA
// users. That hint is surfaced in responses as `selfMintHint`.
//
// ── Why this module is a pure-ESM `.mjs` importing a COMPILED ESM build ───────
// o1js is a DUAL package: an ESM `import` resolves `o1js/dist/node/index.js`
// while a CJS `require` resolves `o1js/dist/node/index.cjs` — DIFFERENT module
// instances. The proving path MUST keep o1js as a SINGLE instance: the
// compiled circuit cache and `FungibleToken._provers` live as per-instance
// static state, and a proof generated against one instance is meaningless to
// another. So we import the mina-zkapp package's parallel ESM build
// (`dist-esm/`, produced by `packages/mina-zkapp/scripts/build-esm.mjs` at
// image-build time) — never its CJS `dist/` and never the `.ts` sources.
//
// Graceful degradation: when MINA_USDC_TREASURY_KEY / MINA_USDC_TOKEN /
// MINA_USDC_ADMIN_CONTRACT are unset, `createMinaUsdcDripper()` returns null
// and the route keeps dripping native MINA only (mirrors createSolanaFaucet /
// createMinaFaucet). Fail-loud ONLY on a structurally invalid treasury key.

import { Mina, PrivateKey, PublicKey, TokenId, fetchAccount } from 'o1js';

// Compiled ESM build of the repo's mina-zkapp classes (see header). The
// Dockerfile builds `packages/mina-zkapp/dist-esm/` and the image lays it out
// so this relative path resolves at runtime (../../mina-zkapp/dist-esm/*).
import { UsdcChannelToken } from '../../mina-zkapp/dist-esm/usdc-channel-token.js';
import {
  DAILY_MINT_CAP_USDC,
  RateLimitedUsdcAdmin,
} from '../../mina-zkapp/dist-esm/usdc-rate-limited-admin.js';
import { dripUsdcFromTreasury } from '../../mina-zkapp/dist-esm/usdc-faucet.js';

const MINA_GRAPHQL_URL =
  process.env.MINA_GRAPHQL_URL || 'https://api.minascan.io/node/devnet/v1/graphql';

// Whole USDC transferred per drip. The treasury can only replenish 1,000
// USDC/day (the self-mint cap), so the default 50 serves ~20 addresses/day.
const MINA_USDC_DRIP_AMOUNT = process.env.MINA_USDC_DRIP_AMOUNT || '50';

// Self-mint top-up trigger: when the treasury balance falls below this (whole
// USDC), the next drip first self-mints the remaining window allowance.
const MINA_USDC_LOW_WATER = process.env.MINA_USDC_LOW_WATER || '500';

// Per-address off-chain cooldown for the USDC leg (hours). Default 24h —
// aligned with the on-chain ~24h self-mint window, so one address can take at
// most one drip per treasury replenishment cycle.
const MINA_USDC_COOLDOWN_HOURS = process.env.MINA_USDC_COOLDOWN_HOURS || '24';

/**
 * zkApp tx fee (nanomina) per leg. A zkApp command on the public Mina devnet
 * is rejected "Insufficient fee" at the default fee floor `Mina.transaction`
 * would pick. 0.1 MINA is the well-worn devnet zkApp fee. Override with
 * MINA_TX_FEE (whole MINA). Mirrors usdc-deploy.ts MINT_FEE_NANOMINA.
 */
const TX_FEE_NANOMINA = (() => {
  const whole = process.env.MINA_TX_FEE;
  if (whole && Number.isFinite(Number(whole))) {
    const [w, f = ''] = String(whole).split('.');
    return BigInt(w || '0') * 1_000_000_000n + BigInt((f + '000000000').slice(0, 9) || '0');
  }
  return 100_000_000n; // 0.1 MINA
})();

// Mina B62 public keys are base58check, "B62q"-prefixed (same check as mina.js).
function isValidMinaAddress(address) {
  return typeof address === 'string' && /^B62q[1-9A-HJ-NP-Za-km-z]{48,55}$/.test(address);
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

/**
 * The "bypass the faucet" hint surfaced in responses and /api/info: the token
 * is permissionless-mint by design, so the faucet is only a convenience for
 * zero-MINA users.
 */
export function selfMintHint(tokenAddr, adminContractAddr) {
  return {
    dailyCapUsdc: String(DAILY_MINT_CAP_USDC),
    note:
      `Anyone can self-mint up to ${DAILY_MINT_CAP_USDC} USDC per ~24h directly (no faucet ` +
      'needed): hold ~1.2 devnet MINA for fees and run ' +
      `npx tsx tools/mina/self-mint-usdc.mts --token ${tokenAddr} --admin-contract ` +
      `${adminContractAddr} [--first-mint]  (github.com/toon-protocol/connector).`,
  };
}

// Returns a USDC dripper object, or null if the USDC leg is not configured for
// this deploy (MINA_USDC_TREASURY_KEY / MINA_USDC_TOKEN /
// MINA_USDC_ADMIN_CONTRACT unset). Mirrors createSolanaFaucet /
// createMinaFaucet's null-when-unconfigured shape so an unconfigured deploy
// still boots.
//
// Throws (fail-loud) only when a treasury key IS configured but is
// structurally not a valid base58 Mina private key — operator misconfiguration
// we must not paper over. (We never log the key.)
export function createMinaUsdcDripper() {
  // MINA_USDC_ADMIN_KEY is the LEGACY name from the admin-mint era. Under the
  // rate-limited token the admin key has no mint power — but the same funded
  // account makes a perfectly good treasury, so we accept the old name as a
  // fallback to keep existing deploys working.
  const treasuryKeyRaw = process.env.MINA_USDC_TREASURY_KEY || process.env.MINA_USDC_ADMIN_KEY;
  const tokenAddr = process.env.MINA_USDC_TOKEN;
  const adminContractAddr = process.env.MINA_USDC_ADMIN_CONTRACT;

  if (!treasuryKeyRaw || !tokenAddr || !adminContractAddr) {
    console.log(
      'ℹ️  Mina USDC drip disabled: set MINA_USDC_TREASURY_KEY + MINA_USDC_TOKEN + ' +
        'MINA_USDC_ADMIN_CONTRACT to enable (native MINA still drips).'
    );
    return null;
  }
  if (!process.env.MINA_USDC_TREASURY_KEY && process.env.MINA_USDC_ADMIN_KEY) {
    console.log(
      'ℹ️  Mina USDC: using legacy MINA_USDC_ADMIN_KEY as the treasury key. The rate-limited ' +
        'token has no admin-mint; this account now serves as the self-mint+transfer TREASURY ' +
        '(rename the env var to MINA_USDC_TREASURY_KEY).'
    );
  }
  if (process.env.MINA_USDC_AMOUNT) {
    console.log(
      'ℹ️  Mina USDC: MINA_USDC_AMOUNT is superseded (it sized the retired admin-mint). ' +
        `Per-drip transfer amount is MINA_USDC_DRIP_AMOUNT (${MINA_USDC_DRIP_AMOUNT} USDC).`
    );
  }

  // Parse the treasury private key WITHOUT echoing it (or the raw error, which
  // may embed it).
  let treasuryKey;
  try {
    treasuryKey = PrivateKey.fromBase58(treasuryKeyRaw);
  } catch {
    throw new Error(
      'MINA_USDC_TREASURY_KEY (or legacy MINA_USDC_ADMIN_KEY) is not a valid base58 Mina private key.'
    );
  }
  const treasuryPub = treasuryKey.toPublicKey();

  // Validate token / admin-contract addresses (fail-loud on a bad address).
  let tokenPubKey;
  let adminContractPubKey;
  try {
    tokenPubKey = PublicKey.fromBase58(tokenAddr);
    adminContractPubKey = PublicKey.fromBase58(adminContractAddr);
  } catch {
    throw new Error(
      'MINA_USDC_TOKEN / MINA_USDC_ADMIN_CONTRACT is not a valid base58 Mina address.'
    );
  }

  const dripUsdc = BigInt(MINA_USDC_DRIP_AMOUNT);
  const lowWaterUsdc = BigInt(MINA_USDC_LOW_WATER);
  const cooldownMs = Math.round(Number(MINA_USDC_COOLDOWN_HOURS) * 3_600_000);
  if (!(Number.isFinite(cooldownMs) && cooldownMs >= 0)) {
    throw new Error(`MINA_USDC_COOLDOWN_HOURS is not a valid number: ${MINA_USDC_COOLDOWN_HOURS}`);
  }

  // Bind the Mina network instance ONCE. The token instance + its tokenId are
  // derived once and reused; compilation is cached (see compileOnce below).
  const Network = Mina.Network({ mina: MINA_GRAPHQL_URL });
  Mina.setActiveInstance(Network);
  const token = new UsdcChannelToken(tokenPubKey);
  const usdcTokenId = token.deriveTokenId();
  // Decimal string for display / the /api/info capability descriptor.
  const tokenIdField = usdcTokenId.toString();
  // Receipt accounts live under the ADMIN CONTRACT's derived token id.
  const adminTokenId = TokenId.derive(adminContractPubKey);

  console.log('✅ Mina USDC drip enabled (treasury self-mint + transfer via o1js proving)');
  console.log(`   Treasury:       ${treasuryPub.toBase58()}`);
  console.log(`   Token:          ${tokenAddr}`);
  console.log(`   Admin contract: ${adminContractAddr} (rate-limited permissionless mint)`);
  console.log(`   Token id:       ${tokenIdField}`);
  console.log(
    `   Per drip:       ${MINA_USDC_DRIP_AMOUNT} USDC (transfer; low-water ${MINA_USDC_LOW_WATER})`
  );
  console.log(`   Replenishment:  self-mint ≤ ${DAILY_MINT_CAP_USDC} USDC per ~24h window`);
  console.log(`   Cooldown:       ${MINA_USDC_COOLDOWN_HOURS}h per address (off-chain)`);
  console.log(`   GraphQL:        ${MINA_GRAPHQL_URL}`);

  // Compile RateLimitedUsdcAdmin + UsdcChannelToken EXACTLY ONCE. Cached via
  // this promise so concurrent/repeat drips never recompile. The mint leg
  // proves against the rate-limited admin circuit; both legs prove against the
  // UsdcChannelToken subclass (its `compile()` override mirrors provers onto
  // the base FungibleToken so inherited mint/transfer prove).
  //
  // TIMING (issue #348): compilation takes ~6s on a dev machine but ~3 MINUTES
  // on the 2 GB devnet box — far longer than faucet clients wait. index.js
  // WARMS this cache in the background at boot via `compile()` below, and the
  // routes check `isWarm()` to avoid holding a drip response hostage to an
  // in-flight compile.
  let compilePromise = null;
  let warm = false;
  function compileOnce() {
    if (!compilePromise) {
      compilePromise = (async () => {
        console.log(
          '  ⏳ Compiling RateLimitedUsdcAdmin + UsdcChannelToken circuits ' +
            '(~6s on a dev machine, ~3min on the 2 GB devnet box)...'
        );
        const t0 = Date.now();
        await RateLimitedUsdcAdmin.compile();
        await UsdcChannelToken.compile();
        warm = true;
        console.log(
          `  ✅ Mina USDC circuits compiled in ${((Date.now() - t0) / 1000).toFixed(1)}s`
        );
      })().catch((err) => {
        // Reset so a transient compile failure can be retried on the next drip.
        compilePromise = null;
        throw err;
      });
    }
    return compilePromise;
  }

  return {
    treasury: treasuryPub.toBase58(),
    token: tokenAddr,
    adminContract: adminContractAddr,
    tokenId: tokenIdField,
    graphqlUrl: MINA_GRAPHQL_URL,
    usdcAmount: MINA_USDC_DRIP_AMOUNT,
    lowWater: MINA_USDC_LOW_WATER,
    cooldownMs,
    dailyCapUsdc: String(DAILY_MINT_CAP_USDC),
    selfMintHint: selfMintHint(tokenAddr, adminContractAddr),

    isValidAddress: isValidMinaAddress,

    // Eagerly warm the circuit cache — index.js calls this in the background at
    // boot so the first drip does not pay the ~3min on-box compile (issue #348).
    compile: compileOnce,

    // True once the circuits are compiled: a drip runs at "prove speed"
    // instead of compile+prove. The routes use this to decide whether to await
    // the drip or answer with usdc.pending / a 503-retry.
    isWarm: () => warm,

    /**
     * Serve one USDC drip to `recipientB58`: lazy treasury self-mint top-up
     * (when below the low-water mark and the ~24h window allows), then a plain
     * token TRANSFER of the per-drip amount. See usdc-faucet.ts for the
     * orchestration + its LocalBlockchain unit tests; this wrapper only does
     * the Network-mode plumbing (account-cache refresh, pool-aware nonce,
     * current-slot probe).
     *
     * Throws with `code = 'USDC_TREASURY_EMPTY'` when the treasury cannot
     * cover the drip (empty + window exhausted) — routes map that to a 503.
     */
    async drip(recipientB58) {
      await compileOnce();

      const recipient = PublicKey.fromBase58(recipientB58);

      // Refresh the o1js account cache before EVERY drip (issue #348): the
      // Mina.Network instance caches fetched accounts, so without this a
      // second drip would build against stale nonces/balances (observed live:
      // "Invalid_nonce"). Missing accounts are fine — a "missing" fetch result
      // is exactly what makes Mina.hasAccount answer false for the
      // account-creation decisions.
      await fetchAccount({ publicKey: treasuryPub });
      await fetchAccount({ publicKey: tokenPubKey });
      await fetchAccount({ publicKey: adminContractPubKey });
      await fetchAccount({ publicKey: treasuryPub, tokenId: usdcTokenId });
      await fetchAccount({ publicKey: treasuryPub, tokenId: adminTokenId });
      await fetchAccount({ publicKey: recipient, tokenId: usdcTokenId });

      // Fee-payer nonce: the ON-CHAIN nonce is not enough — proving takes ~70s
      // while blocks land slower, so a back-to-back drip's previous commands
      // are often still in the POOL when this one builds. The GraphQL
      // `inferredNonce` counts pooled commands, so consecutive drips queue
      // gaplessly. Best-effort: on probe failure fall back to o1js's cached
      // on-chain nonce (correct when the pool is empty).
      let baseNonce;
      try {
        const nonceData = await minaGraphql(
          `query TreasuryNonce($pk: PublicKey!) {
            account(publicKey: $pk) { inferredNonce }
          }`,
          { pk: treasuryPub.toBase58() }
        );
        const inferred = nonceData?.account?.inferredNonce;
        if (inferred != null) baseNonce = Number(inferred);
      } catch (nonceErr) {
        console.log(
          `  ⚠️  Could not probe treasury inferredNonce (${nonceErr.message}); ` +
            'using the fetched on-chain nonce.'
        );
      }

      // Current global slot (best-effort): lets the top-up credit a window
      // RESET (the daily replenishment case). On probe failure the allowance
      // math is conservative — it never builds a mint the circuit rejects.
      let currentSlot;
      try {
        const slotData = await minaGraphql(
          `query { bestChain(maxLength: 1) { protocolState { consensusState { slotSinceGenesis } } } }`
        );
        const slot = slotData?.bestChain?.[0]?.protocolState?.consensusState?.slotSinceGenesis;
        if (slot != null) currentSlot = BigInt(slot);
      } catch (slotErr) {
        console.log(
          `  ⚠️  Could not probe the current global slot (${slotErr.message}); ` +
            'top-up allowance math will be conservative (no window-reset credit).'
        );
      }

      const result = await dripUsdcFromTreasury({
        token,
        adminContract: adminContractPubKey,
        treasuryKey,
        recipient,
        dripUsdc,
        lowWaterUsdc,
        currentSlot,
        feeNanomina: TX_FEE_NANOMINA,
        baseNonce,
        // The transfer is pipelined at baseNonce+1 behind a pending mint —
        // EXCEPT when the mint is creating the treasury's very first token
        // account (once ever): then wait for inclusion so the transfer builds
        // against an existing sender account.
        onMintSent: async (pending, { createdTreasuryTokenAccount }) => {
          console.log(`  📤 Treasury self-mint submitted: ${pending.hash}`);
          if (createdTreasuryTokenAccount) {
            console.log(
              '  ⏳ First-ever treasury top-up: waiting for inclusion before the transfer leg...'
            );
            await pending.wait({ maxAttempts: 90, interval: 20_000 });
            await fetchAccount({ publicKey: treasuryPub, tokenId: usdcTokenId });
            await fetchAccount({ publicKey: treasuryPub, tokenId: adminTokenId });
          }
        },
      });

      if (result.mintedUsdc > 0n) {
        console.log(
          `  💰 Treasury self-minted ${result.mintedUsdc} USDC (window allowance): ${result.mintHash}`
        );
      } else if (result.mintSkipped) {
        console.log(`  ℹ️  Treasury top-up skipped: ${result.mintSkipped}`);
      }
      console.log(
        `  📤 Transferred ${result.transferredUsdc} USDC to ${recipientB58}: ${result.transferHash}` +
          (result.fundedRecipientAccount ? ' (funded new token account)' : '')
      );

      return {
        amount: String(result.transferredUsdc),
        transferHash: result.transferHash,
        fundedNewAccount: result.fundedRecipientAccount,
        ...(result.mintedUsdc > 0n
          ? { treasuryMint: { amount: String(result.mintedUsdc), hash: result.mintHash } }
          : {}),
        ...(result.mintSkipped ? { treasuryMintSkipped: result.mintSkipped } : {}),
        treasuryBalance: String(result.treasuryBalanceAfter),
        token: tokenAddr,
        tokenId: tokenIdField,
        selfMintHint: selfMintHint(tokenAddr, adminContractAddr),
      };
    },
  };
}

// Capability descriptor fragment surfaced via index.js's minaUsdcOnlyInfo (and
// still consumed by mina.js's now-unmounted minaInfo). `dripper` is
// the live createMinaUsdcDripper() (or null when unconfigured).
export function minaUsdcInfo(dripper) {
  if (!dripper) {
    return { usdcDrip: false };
  }
  return {
    usdcDrip: true,
    usdcAmount: String(dripper.usdcAmount),
    usdcToken: dripper.token,
    usdcTokenId: dripper.tokenId,
    treasury: dripper.treasury,
    dailyTreasuryCapUsdc: dripper.dailyCapUsdc,
    cooldownHours: String(dripper.cooldownMs / 3_600_000),
    selfMint: dripper.selfMintHint,
  };
}
