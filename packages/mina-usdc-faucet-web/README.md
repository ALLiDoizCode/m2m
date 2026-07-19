# Mina Devnet USDC Faucet (browser dApp)

A one-screen web app that mints **mock USDC on Mina devnet** to any address the
user types. It connects the **Auro wallet**, builds + proves the mint transaction
**in the browser** (o1js in a web worker), and hands the proven transaction to
Auro for the fee-payer signature + broadcast. The recipient never signs — this is
the _permissionless_ token gated by `PermissionlessRateLimitedUsdcAdmin`, which
enforces a **1000-USDC-per-address-per-~24h** cap inside the proof + the ledger.

Live token (devnet):

|                |                                                           |
| -------------- | --------------------------------------------------------- |
| token          | `B62qnZnmV3jADwYCpofKdbS23Z6vP89w7TC6rsXw9ejR53YfTwmKLsa` |
| admin contract | `B62qk3RsLgL38Vk7nDzGT3XHBjtzN9W9zz4A6WS2a6DhBMac9N8NKDs` |
| decimals       | 6 · daily cap 1000 USDC / recipient / 480-slot window     |
| node           | `https://api.minascan.io/node/devnet/v1/graphql`          |

## How it works

1. **`src/prover.worker.ts`** — the o1js prover, off the main thread. Sets
   `FungibleToken.AdminContract = PermissionlessRateLimitedUsdcAdmin`, compiles
   both circuits (once per session), then reproduces the CLI `buildMintTx`
   exactly: `Mina.transaction({ sender: feePayer, fee }, () => { fundNewAccount?;
token.mint(recipient, amount) })` → `tx.prove()`. Returns the proven
   `tx.toJSON()`; the fee payer (Auro) signs later.
2. **`src/wallet.ts`** — Auro (`window.mina`): `requestAccounts`, `requestNetwork`
   (devnet check), `sendTransaction` (fee-payer sign + broadcast).
3. **`src/allowance.ts`** — reads the recipient's mint-receipt account under the
   admin's derived token id via GraphQL and unpacks the balance
   (`windowStart·2^32 + mintedInWindow`) to show "X / 1000 remaining".
4. **`src/main.ts`** — vanilla-TS UI + progress states (compile → prove → sign →
   submitted).

## The one non-obvious build detail

o1js's `@method`/`@state` decorators are lowered correctly by **tsc** but **not by
esbuild** (Vite's transformer): esbuild's `experimentalDecorators` output makes
o1js throw `Cannot read properties of undefined (reading 'map')` at class
decoration. So the vendored contract classes in `src/zkapp/*.ts` are precompiled
to plain JS by tsc (`scripts/build-zkapp.mjs` → `src/zkapp-compiled/`, run via
`predev`/`prebuild`), and the worker imports the compiled JS. Vite then only ever
bundles already-lowered JS. `o1js` + `mina-fungible-token` are pinned to the exact
versions the on-chain verification key was compiled with (`2.14.0` / `1.1.0`) — a
different version produces a different vk and the mint is rejected.

Cross-origin isolation (needed for o1js's `SharedArrayBuffer` threads) is provided
by `public/coi-serviceworker.js` in production (GitHub Pages can't set COOP/COEP
headers) and by dev/preview server headers locally.

## Develop / build

```bash
npm install
npm run dev       # http://localhost:5173  (needs Auro on devnet)
npm run build     # → dist/  (static, relative-path assets; deploy anywhere https)
```

## Verified

- **Headless end-to-end** against the live token (throwaway funded fee payer,
  fresh non-signing recipient): tx `5JudHJJNkWEqQHnP2yrHNFwXCW7xrVkHKbVEAPQYMjL9G7HFW5ky`,
  recipient balance +1000 USDC, receipt decoded to 1000/1000.
- **In-browser** (headless Chromium, this exact worker): compile ≈40s, prove
  ≈140s, valid proven tx produced — confirming browser proving is practical.
