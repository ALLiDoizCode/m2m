# Bringing the faucet box up on its own Linode

Operator runbook for [connector#898](https://github.com/toon-protocol/connector/issues/898), part
of [toon-meta#310](https://github.com/toon-protocol/toon-meta/issues/310) (retire the devnet
apex). The owner decision (2026-08-07 ~21:00Z, specified in toon-meta `docs/two-node-architecture.md`
§4 — that doc lives in toon-meta, not this repo) moves the faucet off box 1 onto its own Linode,
with **no connector on it**, dispensing **USDC only**. Modeled on
[`relay-box-bringup.md`](relay-box-bringup.md)'s "Who does what" table format — the same class of
move (a service moving to a new box) was done for the relay app.

## What is already done, repo-side

- `infra/linode-faucet/` — `docker-compose.faucet.yml` (the `faucet` service built from
  `packages/faucet/Dockerfile` with the repo root as build context, plus `nginx` + `certbot`, no
  connector service anywhere in the file), `bootstrap.sh`, `firewall.sh`, `init-letsencrypt.sh`,
  `nginx/node.conf.template` + committed `nginx/conf.d/node.conf`, `.env.example`.
- `packages/faucet/src/index.js` — USDC only (§4.6): `POST /api/request` (local-anvil EVM),
  `POST /api/solana/request` (native SOL) and `POST /api/mina/request` (native MINA) are removed
  from the service entirely (404, not merely 503-when-unconfigured), and `/api/info`'s capability
  map and `packages/faucet/public/index.html`'s web UI stop advertising them. The surviving
  USDC-only routes (`/api/solana/usdc-request`, `/api/mina/usdc-request`,
  `/api/base-sepolia/request`) keep their request/response shapes, as do `GET /health` and
  `GET /api/info` — only `/api/info`'s `chains` map changes (the `evm` leg is gone and the
  `solana`/`mina` legs now advertise their `usdc-request` route).
  `BASE_SEPOLIA_ETH_AMOUNT` is pinned to `'0'` in `docker-compose.faucet.yml` (the code's own
  default — this box does not carry box 1's override to `0.001`, which went with the apex's own
  compose file, connector#872).
- `infra/devnet-manage.sh` — `NODE_LABELS`/`NODE_TYPES`/`NODE_PASSWORDS` know a `faucet` key; a
  targeted `faucet` case provisions the Linode (mirrors the `relay`/`store` cases, minus a
  `deploy_*_node` call — see "Who does what" below for why); a separate `faucet-cutover` case
  repoints the DNS record once the box has cleared the gates below.
- `infra/linode-faucet/generate-solana-treasury.sh` / `generate-mina-treasury.sh` (issue #919) —
  step 4's fresh-key generation, scripted and reviewed rather than ad hoc. Neither ever prints a
  private key; the Solana one also airdrops devnet SOL for tx fees (public, permissionless).
  Executing them still needs a human on the box (see "Who does what" below) — what moved repo-side
  is the tool, not the act of running it.

## What this runbook does not yet cover

The **live cutover** — repointing `faucet.devnet.toonprotocol.dev` at this box and retiring box 1's
copy — is toon-meta#313's job (destroying box 1), which this issue explicitly gates: "the faucet
lives on the apex today, so #898 is a precondition of the teardown, not a step of it." toon-meta#313's
current step 3 names the **relay** box as the DNS cutover target; amending it to name this box
instead is operator work in that repo, out of this document's scope.

## Who does what

| Step                            |       Repo-side (PR, reviewable)        |        Human-only (SSH, key material, funds)         |
| ------------------------------- | :-------------------------------------: | :--------------------------------------------------: |
| 1. Provision                    |     ✅ `./devnet-manage.sh faucet`      |             runs it, holds the API token             |
| 2. DNS (initial — not yet live) |                                         |               nothing yet — see step 8               |
| 3. Certs                        |        ✅ `init-letsencrypt.sh`         |                 runs it, on the box                  |
| 4. Key generation (§4.4)        | ✅ `generate-{solana,mina}-treasury.sh` |   runs them, on THIS box — never copied from box 1   |
| 5. Funding                      |                                         |         ✅ devnet faucet / a human transfer          |
| 6. Standalone verification      |     ✅ `bootstrap.sh`, curl checks      |             runs them, reads the output              |
| 7. Mint-authority transfer      |                                         | ✅ transfer or fund fresh, before box 1 is destroyed |
| 8. DNS cutover (§6.2 step 9)    | ✅ `./devnet-manage.sh faucet-cutover`  |          runs it, only once gate (c) passes          |
| 9. Rollback                     |        ✅ one `update_dns` call         |      repoints back at box 1, no restart needed       |

Steps 1, 4, 5 and 7 need SSH, key material or funds this environment does not have — same posture
every other infra-touching ticket in this repo's history records when it applies
(`relay-box-bringup.md`'s own table).

## Preconditions

- `infra/linode-faucet/` config, compose file and scripts exist and are reviewed (this issue).
- Box 1's `faucet` service (`infra/linode-node/docker-compose.node.yml`) keeps serving and is
  untouched by this change — nothing here strips it. It is removed only as part of connector#872's
  apex teardown, and only after step 8 below. Note that it is _built from this repo_, so the next
  `./devnet-manage.sh redeploy` retires box 1's three native-token routes too — that is §4.6
  applied to the service itself, not to this box, and it is why box 1 must not be redeployed at a
  moment when someone still depends on those legs.
  **Since satisfied:** step 8 ran, and connector#872 then destroyed box 1 and deleted that compose
  file along with the rest of `infra/linode-node/`. Read this bullet as the ordering constraint it
  was, not as a live precondition.
- A funded devnet faucet / on-chain path exists to fund THIS box's fresh keys (§4.4) — there is no
  legacy identity to reproduce here, every key is new material.

## Order — provision through cutover, in order

1. **Provision.** `./devnet-manage.sh faucet` creates the Linode (label `faucet`,
   `g6-standard-2`, matching the other three boxes' type). Repo-side; no DNS change yet.

2. **DNS — not yet.** Deliberately absent from step 1: `faucet.devnet.toonprotocol.dev` keeps
   resolving to box 1 until step 8 below. Flipping it before the new box is live, funded and
   proven serving would prescribe the outage this ordering exists to prevent (mirrors the relay
   box's own adopted-identity cutover reasoning, [connector#905](https://github.com/toon-protocol/connector/pull/905)).

3. **Certs.** `cd infra/linode-faucet && cp .env.example .env && $EDITOR .env` (set `DOMAIN`,
   `LETSENCRYPT_EMAIL`, and `LETSENCRYPT_STAGING=1` until DNS is confirmed reachable at this box's
   IP by other means — a direct curl by IP with `Host:` header, since the public name still points
   elsewhere), then `./bootstrap.sh`. It hardens the box first — firewall to 22/80/443 only, then
   key-only sshd (`infra/harden-box.sh`), ahead of everything that can fail, and it refuses to
   finish quietly if that did not take — pulls the `nginx`/
   `certbot` base images, builds the faucet image, renders `nginx/conf.d/node.conf` from the
   template for `${DOMAIN}`, starts the compose stack, and runs `init-letsencrypt.sh`. Because the
   public name does not point here yet, the issuance attempt this step makes will fail ACME's
   HTTP-01 challenge — expected; it falls back to the self-signed cert and logs a warning. Re-run
   `init-letsencrypt.sh` after step 8 flips DNS.

4. **Key generation (§4.4).** Three secrets, all fresh material generated ON THIS BOX, never
   copied from box 1:
   - `BASE_SEPOLIA_FAUCET_KEY` — a fresh EVM `0x…` private key, funded with a little Base Sepolia
     ETH for gas (the mock USDC mint itself is ungated).
   - A fresh Solana keypair written to `/root/keys/solana-usdc-treasury.json` (the path
     `docker-compose.faucet.yml` bind-mounts read-only) — this is a **file**, not an env var.
     `./generate-solana-treasury.sh` (this directory) generates it in that exact spot and
     airdrops devnet SOL for tx fees in one step; the private key is never printed, only the
     resulting public key. USDC funding (step 5) is a separate, human step it does not attempt.
   - `MINA_USDC_TREASURY_KEY` — a fresh base58 Mina private key.
     `./generate-mina-treasury.sh` (this directory) generates it and appends
     `MINA_USDC_TREASURY_KEY=…` to a target `.env` file directly, again without ever printing the
     key. It uses `mina-signer` (already a faucet dependency), not `o1js` — key generation needs
     no zkApp circuit, so this avoids the faucet's own lazy ~3-minute circuit compile.

   Both scripts refuse to overwrite an existing key/env line, so a re-run against a box that
   already has a treasury is a safe no-op error, not a silent second key. Neither one's tooling is
   installed by `bootstrap.sh` (it installs docker, git, jq, gettext-base, openssl, ufw, curl,
   iptables and nothing else), so install each by hand on the box first.

   `generate-solana-treasury.sh` needs `solana` and `solana-keygen`. Install **v3.1.12** — not
   `stable`, and not whatever a package manager offers:

   ```sh
   sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.12/install)"
   export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
   ```

   That version is a choice, not a default. This repository installs exactly two Solana CLIs and
   `crates/connector-settlement-solana/tests/solana_cli_pins.rs` records both with their reasons;
   a case in that file fails the build if this line names a third. v3.1.12 is the one a human
   following a runbook here installs — `docs/solana-deployment.md`'s prerequisites and
   `devbox.json`'s `init_hook` already put exactly it on a person's PATH. The other pin, v2.1.21,
   is held to the 2.1 line by two things that do not exist on this box: `solana-test-validator`'s
   io_uring requirement and the workspace's `=2.1.0` crate pins. This box runs no validator and
   compiles no Rust — the faucet service itself reaches Solana through `@solana/web3.js` and
   `@solana/spl-token` inside its container and never shells out to the CLI, so the CLI is a
   bringup tool only and nothing here needs it again after step 4.

   `generate-mina-treasury.sh` needs `node` plus this repo's `node_modules` (`npm ci` at the repo
   root — that is where `mina-signer` resolves from).

   Each script checks for its binaries up front and exits with a clear error rather than
   half-doing the work. A `.env` copied from `.env.example` already carries an _empty_
   `MINA_USDC_TREASURY_KEY=` line — which is why the overwrite check only trips on a non-empty
   one — so delete that empty line after running the script and leave exactly one definition.

   Write `BASE_SEPOLIA_FAUCET_KEY` / `MINA_USDC_TREASURY_KEY` (+ `MINA_USDC_TOKEN` /
   `MINA_USDC_ADMIN_CONTRACT`, the deployed USDC token's addresses) into this box's `.env` and
   restart the `faucet` service (`docker compose -f infra/linode-faucet/docker-compose.faucet.yml
up -d --build faucet`) to pick them up. Record how each key was generated somewhere off this
   box — there is no legacy identity to fall back to if it is lost.

   `MINA_USDC_TOKEN` / `MINA_USDC_ADMIN_CONTRACT` are **not secrets** — they identify the shared,
   already-deployed devnet USDC token, the same one box 1 (the apex) carries and every other devnet
   consumer (the relay/store boxes, `packages/mina-usdc-faucet-web`) already targets. Reuse the
   values verbatim; only the treasury _key_ must be fresh (issue #919, which records these here
   before toon-meta#313 destroys the apex and they become unrecoverable from it):

   ```
   MINA_USDC_TOKEN=B62qqN1Pu3kF2KGmqLA8EwpqfWrnFTVZJGDSDHQuQRoVt5BCFjhNz3d
   MINA_USDC_ADMIN_CONTRACT=B62qpeGPgEhz6Vbd9E11PoTzz2EZZCJjqhwALxJ2BnkdozFm2rZtmRB
   ```

   Cross-checked against `packages/mina-usdc-faucet-web/README.md`'s "Live token (devnet)" table
   (canonical as of 2026-07-19) and against the truncated values issue #919 itself quotes off the
   apex — both agree. `packages/faucet/src/mina-usdc.mjs` doc: the admin contract is
   `RateLimitedUsdcAdmin`, mint is **permissionless** (capped 1,000 USDC/address/~24h) and requires
   no admin key at all — so the fresh treasury key needs no authority transfer from the apex, only
   ~1.2 devnet MINA of its own for proving-tx fees (see step 5). `infra/mina/usdc-token.json`'s
   `B62qnZnmV3jAD…` token is a **stale, pre-2026-07-19 identity** — do not use it here.

   The Solana USDC mint needs no equivalent recording: `SOLANA_USDC_MINT` already defaults (in
   `docker-compose.faucet.yml`) to `xyc5J8MgKFiEN13PnfftdXxUzYH34FEvw1LCrFwN7in`, the same public
   Solana-devnet mock-USDC mint recorded in `packages/solana-program/deployments/devnet-public.md`
   and used fleet-wide — it is not apex-specific and needs no separate extraction before #313.

   No Mina endpoint needs setting: `MINA_GRAPHQL_URL` defaults to the public Mina devnet
   (`api.minascan.io`), the same node the faucet code defaults to. `.env.example` carries it
   commented out as an override only — do not point it at `mina.$DOMAIN`, the self-hosted
   lightnet box deleted 2026-07-19.

5. **Funding.** Fund the Base Sepolia EVM address (a little ETH for gas — the mock USDC mint is
   ungated) and the Solana treasury (USDC on the public Solana devnet; SOL only for tx fees — this
   box airdrops no SOL, §4.6). SOL is a public, permissionless devnet airdrop —
   `generate-solana-treasury.sh` (step 4) already does that airdrop as part of key generation, so
   SOL needs nothing further here. The USDC transfer is not permissionless:
   `xyc5J8MgKFiEN13PnfftdXxUzYH34FEvw1LCrFwN7in`'s mint authority is the deployer key recorded in
   `packages/solana-program/deployments/devnet-public.md` ("Keypairs used for this deploy live
   outside the repo"), so funding this box's fresh treasury needs whoever holds that key to mint or
   transfer to it. `infra/solana/fund-solana.sh` does **not** reach this mint — it signs with the
   committed `infra/solana/usdc-authority.json`, which is the authority for the _local-validator_
   mint `H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H` (deleted per `infra/linode/README.md`) — a
   different key for a different, no-longer-live mint. The Mina USDC leg self-mints its own
   replenishment on-chain (rate-limited, ≤1,000 USDC/~24h — see `packages/faucet/src/mina-usdc.mjs`),
   so it needs no privileged funding step, only ~1.2 devnet MINA of its own for tx fees (the public
   `faucet.minaprotocol.com`, same as any other devnet account). That MINA faucet has no
   unauthenticated API to automate this against — confirmed live (2026-08-14): a plain HTTPS
   request to `faucet.minaprotocol.com` returns Vercel's bot-detection "Security Checkpoint" page,
   not MINA, matching `infra/mina/provision-mina.sh`'s own conclusion ("We can't auto-fund these on
   public devnet"). Funding this key is a human, browser-driven step; `generate-mina-treasury.sh`
   (step 4) prints the address to paste in.

6. **Standalone verification.** With `./bootstrap.sh` already run in step 3:

   ```sh
   # Pre-cutover the public name still resolves to box 1, so pin it to THIS box's IP.
   # -k because port 80 only 301s to https and the cert here is still the self-signed seed.
   curl -ksf --resolve faucet.devnet.toonprotocol.dev:443:<box IP> https://faucet.devnet.toonprotocol.dev/health
   curl -sf https://faucet.devnet.toonprotocol.dev/api/info   # once a real cert issues, post-cutover
   ```

   and that each configured leg's `POST` route succeeds: `/api/base-sepolia/request`,
   `/api/solana/usdc-request`, `/api/mina/usdc-request`. Confirm the retired legs answer **404**,
   not 503: `POST /api/request`, `POST /api/solana/request`, `POST /api/mina/request`.

7. **Mint-authority transfer.** Before box 1 is destroyed (toon-meta#313), either transfer minting/
   treasury authority to this box's fresh keys or fund this box's keys directly from box 1's — a
   live, human step, ordered here because toon-meta#310 §4.4/§6 requires it to happen before the
   old box's keys become unreachable.

8. **DNS cutover.** Once gate (c) below passes: `./devnet-manage.sh faucet-cutover` repoints
   `faucet.devnet.toonprotocol.dev` at this box. Re-run `init-letsencrypt.sh` afterward if step 3's
   first issuance fell back to the self-signed cert. Stop box 1's `faucet` service only after this
   box has served real traffic under the new record — do not stop both at once.

9. **Rollback.** `./devnet-manage.sh dns` (or a direct `update_dns "faucet.devnet" "<box 1 IP>"`)
   repoints the record back at box 1. No restart needed on either box — box 1's `faucet` service
   is untouched by this runbook and keeps running until connector#872's teardown.

## Gates — in order, and do not reorder (c)

- **(a) Standalone up.** The faucet container is healthy, and `GET /health` / `GET /api/info`
  answer through this box's own nginx.
- **(b) Retired legs are gone.** `POST /api/request`, `POST /api/solana/request` and
  `POST /api/mina/request` 404 — proving the removal is unconditional, not merely
  "disabled because unconfigured" (which would 503).
- **(c) Each configured USDC leg drips end to end.** A real `POST` against every leg this box's
  `.env` configures succeeds and the drip lands on-chain. **This is the gate to stop the cutover
  on if it fails** — DNS should not move to a box that cannot actually dispense funds.
- **(d) Cert renewal survives.** `certbot renew --dry-run` succeeds on this box's own lineage
  after step 8 — its own independent lineage (§4.3), not a SAN shared with anything else.

If (c) cannot be demonstrated, stay on step 7 and do not run step 8.

## Rollback

Covered as step 9 above: repoint `faucet.devnet` back at box 1 and, if the mint authority was
transferred in step 7, transfer or fund it back. Box 1's own `faucet` service needs no restart —
it was never stopped by this runbook.
