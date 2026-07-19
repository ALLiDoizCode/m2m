// Regression guard for the Mina zkApp WORKER-INIT bug (issue #368) — the
// CONNECTOR RUNTIME modality.
//
// The connector runtime is a CJS process. It loads the Mina proving stack the
// way packages/connector/src/settlement/mina-payment-channel-sdk.ts does: a
// GENUINE ESM dynamic import (via a `new Function` indirection that tsc's
// `module: commonjs` downleveling does not rewrite back to `require`) of o1js
// AND the mina-zkapp `dist-esm/` build — so o1js loads as ONE ESM instance
// across o1js + mina-zkapp + the ESM-only mina-fungible-token.
//
// Before the fix the connector did `require('@toon-protocol/mina-zkapp')` (CJS)
// while mina-fungible-token dragged in a SECOND (ESM) o1js instance; the two
// fought over the single `globalThis.startWorkers`, and `.compile()` died with
// `TypeError: workersReadyResolve is not a function` at node-backend.js — so
// on-chain settlement PROVING (claimFromChannel etc.) could never run. This
// script reproduces the connector's fixed load order from a CJS entrypoint and
// compiles both settlement circuits; if the dual-instance seam ever comes back
// (e.g. a loader reverts to a bare `require`/downleveled `import`, or dist-esm
// stops shipping) it fails HERE, in CI, instead of on a live node.
//
// Prints one parseable line per circuit (same format as compile-circuits.mjs):
//   <Name>.compile() ok in <seconds>s — vk hash <decimal>
//
// Run from packages/mina-zkapp (after `npm run build:esm`):
//   node scripts/compile-circuits-connector-runtime.cjs

'use strict';

// The EXACT indirection the connector SDK uses (esmDynamicImport): a genuine ESM
// dynamic import that survives CJS transpilation.
const esmDynamicImport = new Function('specifier', 'return import(specifier);');

async function main() {
  // Order mirrors the connector: o1js first (getO1js), then the dist-esm classes
  // (getPaymentChannelContract / getUsdcChannelTokenContract). Importing
  // usdc-channel-token.js pulls in the ESM-only mina-fungible-token — the exact
  // graph that produced the second o1js instance before the fix.
  await esmDynamicImport('o1js');
  const { PaymentChannel } = await esmDynamicImport(
    '@toon-protocol/mina-zkapp/dist-esm/PaymentChannel.js'
  );
  const { UsdcChannelToken } = await esmDynamicImport(
    '@toon-protocol/mina-zkapp/dist-esm/usdc-channel-token.js'
  );

  for (const [name, contract] of [
    ['PaymentChannel', PaymentChannel],
    ['UsdcChannelToken', UsdcChannelToken],
  ]) {
    const t0 = Date.now();
    const { verificationKey } = await contract.compile();
    console.log(
      `${name}.compile() ok in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
        ` — vk hash ${verificationKey.hash.toString()}`
    );
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
