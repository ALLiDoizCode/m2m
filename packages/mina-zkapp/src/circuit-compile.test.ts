/**
 * Circuit-compile regression guard (issue #352) — every shipped zkApp circuit
 * must compile against the repo's single pinned o1js, in BOTH module
 * modalities we ship, and the PaymentChannel verification key must not drift.
 *
 * Why this exists: `UsdcChannelToken.compile()` had ZERO real coverage (every
 * USDC suite runs `proofsEnabled: false`, which never compiles), so the
 * duplicate-o1js-instance seam in the deploy tool's module graph — o1js is a
 * dual CJS/ESM package with per-instance `Snarky` bindings, and the ESM-only
 * `mina-fungible-token` drags the second copy in — only surfaced in the field,
 * as `TypeError: Cannot read properties of undefined (reading 'run')` at
 * `assertBooleanCompatible` inside `UsdcChannelToken.compile()`. The circuit
 * itself was never broken: it compiles clean on the pinned o1js when exactly
 * one instance loads. See issue #352 for the full trace.
 *
 * Two layers:
 *
 *  1. In-process (this jest/ts-jest CJS world, where `mina-fungible-token` is
 *     transformed to CJS so o1js is single-instance): compile `PaymentChannel`
 *     and pin its verification-key hash. Already-deployed PaymentChannel zkApps
 *     (devnet-box lightnet, deployed 2026-06-23, and public devnet) and the
 *     claim verifier depend on this key: if a change here is intentional it
 *     requires a coordinated redeploy + verifier rollout, NOT just updating the
 *     constant below.
 *
 *  2. Child-process, pure ESM — the EXACT modality the fixed deploy tool
 *     (tools/mina/deploy-usdc-token.mts) uses: build `dist-esm/` and compile
 *     `FungibleTokenAdmin` + `UsdcChannelToken` + `PaymentChannel` from it in
 *     one node process. This is the regression test for #352: a reintroduced
 *     dual-instance seam or a gadget-API drift in a floated o1js fails HERE,
 *     in CI, instead of in a deploy tool in the field. The PaymentChannel vk
 *     hash from the ESM build must equal the pinned (CJS-compiled) one —
 *     compilation is deterministic across module systems.
 *
 * Slow (~minutes: real proof-system compilation). CI runs mina-zkapp tests
 * serially with an 8 GB heap (.github/workflows/ci.yml "serial isolation"
 * step), which this suite is designed for. Compiles use the default o1js
 * filesystem cache, so repeated local runs are much faster than the first.
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

import { PaymentChannel } from './PaymentChannel';
import { RateLimitedUsdcAdmin } from './usdc-rate-limited-admin';
import { PermissionlessRateLimitedUsdcAdmin } from './usdc-permissionless-admin';

// Real compilation is slow; give each layer ample room (CI machines vary).
const COMPILE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The PaymentChannel verification-key hash of the o1js resolution the deployed
 * zkApps were built with (o1js 2.14.0 — pinned in package.json by #352; the
 * lockfile has resolved 2.14.0 unchanged since the first Mina zkApp commit,
 * which covers the 2026-06-23 lightnet deploy). Recomputed deterministically by
 * `PaymentChannel.compile()` on that resolution.
 *
 * If this assertion ever fails, an o1js/dependency change has altered the
 * PaymentChannel circuit — which ORPHANS already-deployed channel zkApps.
 * Do not update this constant to make CI green; that is a deliberate
 * redeploy-everything + verifier-rollout decision.
 */
const DEPLOYED_PAYMENT_CHANNEL_VK_HASH =
  '10198644144187455994960502319403624595373157040521352299817898965424059011097';

/**
 * The RateLimitedUsdcAdmin verification-key hash deployed with the
 * rate-limited public-devnet USDC token (o1js 2.14.0 resolution). Every
 * permissionless mint proves `canMint` against this key on-chain — if it
 * drifts, mints on the deployed token stop verifying. As with the
 * PaymentChannel pin above: do not update this constant to make CI green;
 * that is a deliberate redeploy decision.
 */
const DEPLOYED_RATE_LIMITED_ADMIN_VK_HASH =
  '15646924668446182536665832553975716875665619363054690992558188740688863581713';

/**
 * The PermissionlessRateLimitedUsdcAdmin verification-key hash deployed with the
 * PERMISSIONLESS public-devnet USDC token (o1js 2.14.0 resolution) — the
 * permissionless-mint redeploy that supersedes the recipient-signed
 * RateLimitedUsdcAdmin token. Every permissionless mint proves `canMint` against
 * this key on-chain — if it drifts, mints on the deployed token stop verifying.
 * As with the pins above: do not update this constant to make CI green; that is
 * a deliberate redeploy decision.
 */
const DEPLOYED_PERMISSIONLESS_ADMIN_VK_HASH =
  '24054879512104605220650652318050994093349025874736442573804562558001657468018';

const PKG_ROOT = path.resolve(__dirname, '..');

describe('circuit compile guard (#352)', () => {
  it(
    'PaymentChannel compiles in-process and keeps the deployed verification key',
    async () => {
      const start = Date.now();
      const { verificationKey } = await PaymentChannel.compile();
      // eslint-disable-next-line no-console
      console.log(
        `PaymentChannel.compile() ok in ${((Date.now() - start) / 1000).toFixed(1)}s` +
          ` — vk hash ${verificationKey.hash.toString()}`
      );
      expect(verificationKey.hash.toString()).toBe(DEPLOYED_PAYMENT_CHANNEL_VK_HASH);
    },
    COMPILE_TIMEOUT_MS
  );

  it(
    'RateLimitedUsdcAdmin compiles in-process and keeps the deployed verification key',
    async () => {
      const start = Date.now();
      const { verificationKey } = await RateLimitedUsdcAdmin.compile();
      // eslint-disable-next-line no-console
      console.log(
        `RateLimitedUsdcAdmin.compile() ok in ${((Date.now() - start) / 1000).toFixed(1)}s` +
          ` — vk hash ${verificationKey.hash.toString()}`
      );
      expect(verificationKey.hash.toString()).toBe(DEPLOYED_RATE_LIMITED_ADMIN_VK_HASH);
    },
    COMPILE_TIMEOUT_MS
  );

  it(
    'PermissionlessRateLimitedUsdcAdmin compiles in-process and keeps the deployed verification key',
    async () => {
      const start = Date.now();
      const { verificationKey } = await PermissionlessRateLimitedUsdcAdmin.compile();
      // eslint-disable-next-line no-console
      console.log(
        `PermissionlessRateLimitedUsdcAdmin.compile() ok in ${((Date.now() - start) / 1000).toFixed(1)}s` +
          ` — vk hash ${verificationKey.hash.toString()}`
      );
      expect(verificationKey.hash.toString()).toBe(DEPLOYED_PERMISSIONLESS_ADMIN_VK_HASH);
    },
    COMPILE_TIMEOUT_MS
  );

  it(
    'every shipped circuit compiles in one pure-ESM process (the deploy-tool modality)',
    () => {
      // Build the pure-ESM lib the deploy CLIs import (idempotent, ~seconds).
      execFileSync(process.execPath, [path.join(PKG_ROOT, 'scripts', 'build-esm.mjs')], {
        cwd: PKG_ROOT,
        stdio: 'pipe',
      });

      // Compile all three circuits from dist-esm in ONE child node process —
      // exactly one (ESM) o1js instance, like tools/mina/deploy-usdc-token.mts.
      const stdout = execFileSync(
        process.execPath,
        [path.join(PKG_ROOT, 'scripts', 'compile-circuits.mjs')],
        { cwd: PKG_ROOT, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }
      );
      // eslint-disable-next-line no-console
      console.log(stdout);

      const vkHashes = new Map<string, string>();
      for (const line of stdout.split('\n')) {
        const m = /^(\w+)\.compile\(\) ok in [\d.]+s — vk hash (\d+)$/.exec(line.trim());
        if (m) vkHashes.set(m[1], m[2]);
      }
      expect([...vkHashes.keys()].sort()).toEqual([
        'FungibleTokenAdmin',
        'PaymentChannel',
        'PermissionlessRateLimitedUsdcAdmin',
        'RateLimitedUsdcAdmin',
        'UsdcChannelToken',
      ]);
      // Deterministic across module systems: the ESM build must produce the
      // SAME vks as the in-process CJS compiles above.
      expect(vkHashes.get('PaymentChannel')).toBe(DEPLOYED_PAYMENT_CHANNEL_VK_HASH);
      expect(vkHashes.get('RateLimitedUsdcAdmin')).toBe(DEPLOYED_RATE_LIMITED_ADMIN_VK_HASH);
      expect(vkHashes.get('PermissionlessRateLimitedUsdcAdmin')).toBe(
        DEPLOYED_PERMISSIONLESS_ADMIN_VK_HASH
      );
    },
    COMPILE_TIMEOUT_MS
  );
});
