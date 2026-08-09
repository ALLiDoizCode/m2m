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
  default — this box does not carry `infra/linode-node/docker-compose.node.yml`'s override to
  `0.001`).
- `infra/devnet-manage.sh` — `NODE_LABELS`/`NODE_TYPES`/`NODE_PASSWORDS` know a `faucet` key; a
  targeted `faucet` case provisions the Linode (mirrors the `relay`/`store` cases, minus a
  `deploy_*_node` call — see "Who does what" below for why); a separate `faucet-cutover` case
  repoints the DNS record once the box has cleared the gates below.

## What this runbook does not yet cover

The **live cutover** — repointing `faucet.devnet.toonprotocol.dev` at this box and retiring box 1's
copy — is toon-meta#313's job (destroying box 1), which this issue explicitly gates: "the faucet
lives on the apex today, so #898 is a precondition of the teardown, not a step of it." toon-meta#313's
current step 3 names the **relay** box as the DNS cutover target; amending it to name this box
instead is operator work in that repo, out of this document's scope.

## Who does what

| Step                            |       Repo-side (PR, reviewable)       |        Human-only (SSH, key material, funds)         |
| ------------------------------- | :------------------------------------: | :--------------------------------------------------: |
| 1. Provision                    |     ✅ `./devnet-manage.sh faucet`     |             runs it, holds the API token             |
| 2. DNS (initial — not yet live) |                                        |               nothing yet — see step 8               |
| 3. Certs                        |        ✅ `init-letsencrypt.sh`        |                 runs it, on the box                  |
| 4. Key generation (§4.4)        |                                        |    ✅ fresh on THIS box — never copied from box 1    |
| 5. Funding                      |                                        |         ✅ devnet faucet / a human transfer          |
| 6. Standalone verification      |     ✅ `bootstrap.sh`, curl checks     |             runs them, reads the output              |
| 7. Mint-authority transfer      |                                        | ✅ transfer or fund fresh, before box 1 is destroyed |
| 8. DNS cutover (§6.2 step 9)    | ✅ `./devnet-manage.sh faucet-cutover` |          runs it, only once gate (c) passes          |
| 9. Rollback                     |        ✅ one `update_dns` call        |      repoints back at box 1, no restart needed       |

Steps 1, 4, 5 and 7 need SSH, key material or funds this environment does not have — same posture
every other infra-touching ticket in this repo's history records when it applies
(`relay-box-bringup.md`'s own table, `docs/operators/rust-cutover-runbook.md`).

## Preconditions

- `infra/linode-faucet/` config, compose file and scripts exist and are reviewed (this issue).
- Box 1's `faucet` service (`infra/linode-node/docker-compose.node.yml`) keeps serving and is
  untouched by this change — nothing here strips it. It is removed only as part of connector#872's
  apex teardown, and only after step 8 below. Note that it is _built from this repo_, so the next
  `./devnet-manage.sh redeploy` retires box 1's three native-token routes too — that is §4.6
  applied to the service itself, not to this box, and it is why box 1 must not be redeployed at a
  moment when someone still depends on those legs.
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
   elsewhere), then `./bootstrap.sh`. It opens the firewall (22/80/443 only), pulls the `nginx`/
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
   - `MINA_USDC_TREASURY_KEY` — a fresh base58 Mina private key.

   Write `BASE_SEPOLIA_FAUCET_KEY` / `MINA_USDC_TREASURY_KEY` (+ `MINA_USDC_TOKEN` /
   `MINA_USDC_ADMIN_CONTRACT`, the deployed USDC token's addresses) into this box's `.env` and
   restart the `faucet` service (`docker compose -f infra/linode-faucet/docker-compose.faucet.yml
up -d --build faucet`) to pick them up. Record how each key was generated somewhere off this
   box — there is no legacy identity to fall back to if it is lost.

   No Mina endpoint needs setting: `MINA_GRAPHQL_URL` defaults to the public Mina devnet
   (`api.minascan.io`), the same node the faucet code defaults to. `.env.example` carries it
   commented out as an override only — do not point it at `mina.$DOMAIN`, the self-hosted
   lightnet box deleted 2026-07-19.

5. **Funding.** Fund the Base Sepolia EVM address (a little ETH for gas — the mock USDC mint is
   ungated) and the Solana treasury (USDC on the public Solana devnet; SOL only for tx fees — this
   box airdrops no SOL, §4.6). The Mina USDC leg self-mints its own replenishment on-chain (rate-
   limited, ≤1,000 USDC/~24h — see `packages/faucet/src/mina-usdc.mjs`), so it needs no separate
   funding step beyond the treasury key itself existing.

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
