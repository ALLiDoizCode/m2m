# TOON devnet on Linode

A self-hosted, public **devnet** for TOON's supported chains, so peers can point a
TOON node/SDK at one stable set of endpoints instead of juggling rate-limited
public faucets and devnets that reset out from under them. **Replaces the old
Akash devnet.**

This is a thin **deployment overlay** on connector's existing
[`docker-compose.yml`](../../docker-compose.yml) — it does not re-implement the
chains, it just runs the `evm` + `solana` profiles on a box we control and puts
nginx + Let's Encrypt TLS in front of them.

## What runs

| Service                     | From                            | Public endpoint                                            | Notes                                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anvil (EVM, chain-id 31337) | base compose `anvil`            | `https://evm-rpc.<DOMAIN>`                                 | auto-deploys Mock USDC `0x5FbDB2…` + `TokenNetworkRegistry` via `DeployLocal.s.sol`                                                                                                                                                                                           |
| Faucet                      | base compose `faucet`           | `https://faucet.<DOMAIN>`                                  | `GET /health`, `GET /api/info`; `POST /api/request` → 100 ETH + 10k USDC (EVM); `POST /api/solana/request` → SOL + USDC; `POST /api/mina/request` → native MINA **+ USDC** (admin-mint). Drips native + USDC on **all three** chains (Mina USDC needs `MINA_USDC_ADMIN_KEY`). |
| Solana test validator       | base compose `solana-validator` | `https://solana-rpc.<DOMAIN>` + `wss://solana-ws.<DOMAIN>` | auto-deploys the payment-channel program; `devnet.sh mint` creates a deterministic mock-USDC SPL mint (`H8HSreUF…`, 6 decimals)                                                                                                                                               |
| Mina (public devnet)        | nginx passthrough               | `https://mina.<DOMAIN>/graphql`                            | **proxy only** — no Mina node here (lightnet is too heavy); state is the public devnet's. USDC token zkApp (6-dp) deployed once to public devnet; fund peers with `devnet.sh fund-mina <b58>`                                                                                 |
| nginx + certbot             | this overlay                    | 80/443                                                     | the only public surface                                                                                                                                                                                                                                                       |

> **Chains-only.** This box deploys blockchain infrastructure only. The
> payment-proxy / connector edge and the oblivious relay deploy **separately**
> (the `deploy/relay-edge/` + `deploy/pay-edge/` bundles on their own box, each
> with its own TLS) — they are no longer co-deployed here.

## Quick start (fresh Ubuntu/Debian Linode, as root)

```bash
git clone https://github.com/toon-protocol/connector.git
cd connector/infra/linode
cp .env.example .env && $EDITOR .env      # set DOMAIN, LETSENCRYPT_EMAIL, PUBLIC_IFACE
# Create DNS A-records → this box's IP for: evm-rpc / solana-rpc / solana-ws / faucet / mina .<DOMAIN>
./bootstrap.sh
```

`bootstrap.sh` installs Docker, firewalls the box, builds the Solana program,
renders the nginx config, starts the chains, issues TLS certs, and writes
`endpoints.json`. Re-run it any time to pick up updates. Leave
`LETSENCRYPT_STAGING=1` until DNS + the proxy verify, then set it to `0` and
re-run `./init-letsencrypt.sh` for trusted certs.

## Day-to-day

```bash
./devnet.sh status      # probe every backend + public URL
./devnet.sh redeploy    # wipe + restart chains (addresses reproduce deterministically)
./devnet.sh logs anvil  # follow logs
./devnet.sh endpoints   # regenerate endpoints.json
./devnet.sh down        # stop (keeps volumes + certs)
```

## Pointing a TOON node at the devnet

Consume [`endpoints.json`](./endpoints.json), or set env / `chainRpcUrls` directly:

```ts
chainRpcUrls: {
  'evm:anvil:31337': 'https://evm-rpc.<DOMAIN>',
  'solana:devnet':   'https://solana-rpc.<DOMAIN>',
  'mina:devnet':     'https://mina.<DOMAIN>/graphql',
}
```

Fund an **EVM** address: `curl -X POST https://faucet.<DOMAIN>/api/request -H 'content-type: application/json' -d '{"address":"0x…"}'` → 100 ETH + 10k USDC.

Fund a **Solana** address: `./devnet.sh fund-sol <pubkey> [usdc] [sol]` → airdrops SOL + transfers mock USDC from the treasury (auto-creates the recipient ATA). The mock-USDC SPL mint is `H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H` (6 decimals); the payment-channel program is already SPL-aware, so channels settle in it directly.

Fund a **Mina** address (native MINA **+ USDC**): `curl -X POST https://faucet.<DOMAIN>/api/mina/request -H 'content-type: application/json' -d '{"address":"B62…"}'` → drips **both** 5 MINA (gas) **and** 1000 USDC, matching the EVM (ETH+USDC) and Solana (SOL+USDC) faucets. Two independent legs:

- **Native MINA** — the faucet signs a native payment client-side with `mina-signer` (no o1js proving) and submits it via `sendPayment`. Needs the **`MINA_FAUCET_KEY`** secret (treasury base58 private key, HD index 2). The treasury is `B62qqEMaUpm1aZ5M2weUoGXQRGbF3j6VjEtaEdzfM1NAWmeHnywiC2P`; it **must be FUNDED** with native MINA (top up at `https://faucet.minaprotocol.com` if it runs dry — an unfunded treasury "succeeds" but transfers nothing). When unset, the route 503s with a public-faucet link.
- **USDC** — the faucet admin-mints the deployed `UsdcChannelToken` via o1js proving (`packages/faucet/src/mina-usdc.mjs`, reusing `tools/mina/fund-usdc.mts`'s mint path). Needs the **`MINA_USDC_ADMIN_KEY`** secret (the mint-authority base58 private key) — **MUST be FUNDED** (it pays each recipient's token-account creation fee on first mint, the #190 gotcha). The token + admin-contract ADDRESSES are public (resolved by `devnet.sh` from `infra/mina/usdc-token.json` or `endpoints.json`), so only the key is a secret. When unset, the route drips native MINA only and notes that USDC minting was skipped.

> The Mina USDC mint uses o1js zk-PROVING, which does **not** work on `node:22-alpine` (musl). The faucet image is therefore built on `node:22-bookworm-slim` (glibc) and bundles a single-instance o1js ESM build of the token classes. The first mint after boot compiles the circuits once (~6s); subsequent mints are warm.

Set both secrets once: `gh secret set MINA_FAUCET_KEY --repo toon-protocol/connector` and `gh secret set MINA_USDC_ADMIN_KEY --repo toon-protocol/connector`; the deploy workflow injects them into `infra/linode/.env`. Verify their funding (and that the token is live) any time with `./devnet.sh mina-provision`. To mint USDC from the box without going through the faucet HTTP route: `./devnet.sh fund-mina <b58> [usdc]`.

### Deploying the Mina USDC token (one-time, to public devnet)

The USDC token-owner zkApp (`mina-fungible-token`, 6 decimals) is deployed **once** to the public Mina devnet — we only proxy it, there's no node to bootstrap on `up`. From the connector root, with a **funded** deployer + admin authority (fund both at `https://faucet.minaprotocol.com` first):

```bash
export MINA_DEPLOYER_KEY=<base58 priv key, FUNDED>
export MINA_USDC_ADMIN_KEY=<base58 priv key, FUNDED>   # the mint authority
npm run build:esm --workspace=packages/mina-zkapp   # the CLI imports the pure-ESM build
npx tsx tools/mina/deploy-usdc-token.mts \
  --network https://api.minascan.io/node/devnet/v1/graphql \
  --out infra/mina/usdc-token.json
```

(The CLI is pure ESM run via `tsx` — o1js must load as a SINGLE module instance or `UsdcChannelToken.compile()` fails; see issue #352. `npx tsx tools/mina/deploy-usdc-token.mts --compile-only` dry-runs the circuit compile with no network/keys.)

It prints + persists `{ tokenAddress, tokenId, adminContractAddress, adminAuthority }` to `infra/mina/usdc-token.json`; `devnet.sh endpoints` then reads that file (via `jq`) to emit `mina.tokenAddress` / `mina.tokenId` into `endpoints.json`. Pin the same `tokenAddress`/`tokenId` into the committed sample `endpoints.json` (currently placeholders). Smoke-test the deploy + mint logic with `npm test --workspace=packages/mina-zkapp -- usdc-deploy` (the `usdc-deploy.test.ts` suite, which runs in CI).

## Reset semantics

Chain state is **ephemeral and deterministic**. `redeploy` (and any container
restart) reverts Anvil and `--reset`s the validator, so Mock USDC always returns
to `0x5FbDB2…` and the Solana program to its fixed id. Never park anything of
value here — all keys (Anvil account #0, etc.) are public.

## TLS certs: issued once, then reused (no rate-limit burn)

The CI redeploy (`.github/workflows/devnet-deploy.yml`) rebuilds the Linode in
place for fresh deterministic chains, which **wipes the disk** — including the
`linode_certbot_conf` (`/etc/letsencrypt`) Docker volume. Left unchecked that made
`init-letsencrypt.sh` **re-issue the cert every redeploy**, repeatedly hitting
Let's Encrypt's **5 duplicate certs / 7 days** limit and dropping the box to
self-signed. Two guards prevent that now:

1. **`init-letsencrypt.sh` skips issuance** whenever the volume already holds a
   valid cert for the domain — a real (non-self-signed) Let's Encrypt cert, not
   expiring within 30 days, covering all five SANs, in the requested staging mode.
   It just starts nginx with that cert; ongoing renewal is the certbot container's
   job (a no-op until <30 days to expiry). `--force-renewal` is gone.
2. **The workflow backs the cert volume up to Linode Object Storage** after each
   deploy and **restores it into the freshly-rebuilt box before bootstrap**, so the
   guard above finds the cert and reuses it. Set the `LINODE_OBJ_ACCESS_KEY` /
   `LINODE_OBJ_SECRET_KEY` repo secrets and the `obj_bucket` / `obj_region` inputs
   to enable it; without them a rebuild simply re-issues as before.

Run the workflow with **`reset: true`** to deliberately skip the restore and issue
a brand-new cert (spends one cert from the weekly budget — use sparingly). A plan
change recreates the box (new IP → new domain → new cert).

## Deploy / destroy (GitHub Actions)

`.github/workflows/devnet-deploy.yml` is `workflow_dispatch`-only and gated behind the
`devnet` GitHub Environment (configure required reviewers there). It deploys the
**chains only** — the connector/relay app edge is deployed separately. Inputs:

- `action: deploy | destroy` — `destroy` deletes the Linode by label (an idle VM bills
  forever, so tear it down when finished).
- `manage_dns: true` — create/refresh the chain subdomain A-records (`evm-rpc`,
  `solana-rpc`, `solana-ws`, `faucet`, `mina`) → the box IP automatically (skip it and
  the workflow just prints the records to create yourself). `dns_provider` picks which
  API to hit: `linode` (default, domain hosted on Linode Domains — uses the existing
  `LINODE_CLI_TOKEN`) or `porkbun` (domain hosted on Porkbun, e.g.
  `devnet.toonprotocol.dev` — needs the `PORKBUN_API_KEY` / `PORKBUN_SECRET` secrets).
  Both upsert the same subdomain set idempotently; with `sslip.io` (blank `domain`) no
  DNS is needed at all.

## Security

- Public ports are **22 / 80 / 443 only**. The raw chain/faucet ports
  (8545/8899/8900/3500) are published on the host by the base compose but **blocked from
  the internet** by `firewall.sh` via `DOCKER-USER` iptables rules (Docker bypasses
  `ufw`, so this is mandatory — `ufw` alone won't close them).
- nginx rate-limits the RPC/faucet/WS vhosts per-IP.
- The Mina vhost proxies **only** `/graphql` to `api.minascan.io`.

## USDC across chains

| Chain  | Token                 | Decimals | Status                                                                                                         |
| ------ | --------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| EVM    | MockERC20 `0x5FbDB2…` | **6**    | ✅ TokenNetwork EIP-712 settlement                                                                             |
| Solana | SPL mint `H8HSreUF…`  | **6**    | ✅ program is SPL-aware; mint + faucet via `devnet.sh`                                                         |
| Mina   | token zkApp           | **6**    | ✅ USDC `FungibleToken` (mina-fungible-token) deployed to public devnet; mint + fund via `devnet.sh fund-mina` |

**Decimals:** USDC is 6-decimal on every chain, so a claim's base-unit amount
means the same thing everywhere — no cross-chain normalization required.

## Known gaps / follow-ups

- **Mina USDC.** The USDC token-owner zkApp (6-dp, `mina-fungible-token`) is
  deployed to the public Mina devnet; the faucet now drips it (native MINA +
  admin-minted USDC) on `POST /api/mina/request` and `devnet.sh fund-mina` mints
  it from the box. The `PaymentChannel` zkApp now custodies this token (#191); the
  SDK/provider threading of the token into open/settle is the remaining follow-up.
- **Mina faucet/admin funding is operator-managed.** Unlike EVM (anvil pre-funds)
  and Solana (validator airdrop), the public Mina devnet has no self-hosted faucet,
  so the native-MINA treasury (`MINA_FAUCET_KEY`) and the USDC mint authority
  (`MINA_USDC_ADMIN_KEY`) must be topped up by hand at `faucet.minaprotocol.com`.
  `devnet.sh mina-provision` (run automatically on every `up`/`redeploy`) checks
  the token is live and warns when either account is underfunded.
- **No block explorer.** Otterscan (what Akash advertised) needs Erigon's `ots_*`
  RPC namespace, which Anvil doesn't implement, so it's intentionally omitted
  rather than shipped broken.
- **Mina node is read-through only.** We proxy the public Mina devnet; we don't
  host a node.
