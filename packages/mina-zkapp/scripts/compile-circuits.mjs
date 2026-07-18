// Compile every shipped zkApp circuit from the pure-ESM `dist-esm/` build in
// ONE node process — exactly one (ESM) o1js instance, the same modality the
// deploy CLIs (tools/mina/deploy-usdc-token.mts, fund-usdc.mts) and the
// lightnet deployer (tools/mina/deploy-lightnet-zkapps.mjs) run in.
//
// Regression surface for issue #352: o1js is a dual CJS/ESM package with
// per-instance `Snarky` bindings; a module graph that loads BOTH builds dies in
// `compile()` with `TypeError: Cannot read properties of undefined (reading
// 'run')`. This script fails loudly in CI if that seam (or a gadget-API drift
// in a floated o1js) ever comes back.
//
// Prints one parseable line per circuit:
//   <Name>.compile() ok in <seconds>s — vk hash <decimal>
//
// Run from packages/mina-zkapp (after `npm run build:esm`):
//   node scripts/compile-circuits.mjs

import { PaymentChannel } from '../dist-esm/PaymentChannel.js';
import { FungibleTokenAdmin } from '../dist-esm/usdc-token.js';
import { UsdcChannelToken } from '../dist-esm/usdc-channel-token.js';
import { RateLimitedUsdcAdmin } from '../dist-esm/usdc-rate-limited-admin.js';
import { PermissionlessRateLimitedUsdcAdmin } from '../dist-esm/usdc-permissionless-admin.js';

const circuits = [
  ['PaymentChannel', PaymentChannel],
  ['FungibleTokenAdmin', FungibleTokenAdmin],
  ['UsdcChannelToken', UsdcChannelToken],
  ['RateLimitedUsdcAdmin', RateLimitedUsdcAdmin],
  ['PermissionlessRateLimitedUsdcAdmin', PermissionlessRateLimitedUsdcAdmin],
];

for (const [name, contract] of circuits) {
  const t0 = Date.now();
  const { verificationKey } = await contract.compile();
  console.log(
    `${name}.compile() ok in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      ` — vk hash ${verificationKey.hash.toString()}`
  );
}
