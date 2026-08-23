# `infra/linode/` — the retired self-hosted chain box

> **There is no box here any more.** This directory holds exactly one live
> artifact: [`endpoints.json`](./endpoints.json), the public-chain devnet
> endpoint record. Everything that provisioned a machine has been deleted.

## What was here, and why it went

`infra/linode/` provisioned the **self-hosted chain box** — an anvil EVM node
(chain-id 31337), a `solana-test-validator`, the multichain faucet, an
nginx→Mina passthrough, and nginx + Let's Encrypt TLS in front of them, served
at `evm-rpc.` / `solana-rpc.` / `solana-ws.` / `faucet.` / `mina.<DOMAIN>`. It
was never a connector box: `infra/linode-relay/` and `infra/linode-store/`
provision the two machines that actually serve devnet, and `infra/linode-faucet/`
provisions the faucet.

That box was deleted in the public-chain cutover — commit `44b15bdc`,
2026-07-19, "docs: public-chain cutover — retire self-hosted devnet chain
endpoints (#374)". Devnet settles on **public chains** now: Base Sepolia
(`evm:84532`), public Solana devnet and public Mina devnet. The subdomains it
answered on are gone; `*.devnet.toonprotocol.dev` is a wildcard A-record to the
registrar's parking host, so `evm-rpc.` and `mina.` return a 301 to
`toonprotocol.dev` and fail TLS.

The provisioning outlived the box, and ran zero times after it. Its scripts
(`bootstrap.sh`, `devnet.sh`, `firewall.sh`, `init-letsencrypt.sh`),
its compose overlay, its `.env.example` and its four nginx templates, together
with their sole caller `.github/workflows/devnet-deploy.yml`, were deleted.
`devnet-deploy.yml` was `workflow_dispatch`-only behind the reviewer-gated
`devnet` GitHub Environment and last ran **2026-06-23**, four weeks _before_ the
cutover. Its `destroy` action deleted a Linode by label (`toon-devnet`), which
is a live footgun to leave dispatchable against a label that should no longer
resolve. Git history has all of it if a self-hosted chain box is ever wanted
again; recreating it from this directory would not be a restoration.

Two deterministic mock tokens belonged to that box and **do not exist on any
live chain**: the anvil `MockERC20` USDC `0x5FbDB2315678afecb367f032d93F642f64180aa3`
(with `TokenNetworkRegistry` `0xe7f1725E…`) and the Solana mock USDC SPL mint
`H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H`. Both addresses are still correct
for the **local** disposable chains (`docker-compose.yml`, `local/`), which
reproduce them from genesis on every run — that is a different thing at the same
address, and `infra/solana/usdc-authority.json` is the authority for the local
mint only.

## What survives: `endpoints.json`

[`endpoints.json`](./endpoints.json) is **live and hand-maintained**. It records
the public devnet's chain endpoints, token addresses and program ids, and is the
canonical answer to "what does a TOON node point at on devnet". It is read at
runtime by `infra/mina/provision-mina.sh` (via `jq`, for the Mina USDC token and
admin-contract addresses) and cited as the source of truth by
`docs/usdc-cross-chain-settlement.md`, `docs/operators/peer-channel-migration.md`,
`tools/mina/deploy-usdc-token.mts`, `infra/mina/fund-mina-usdc.sh` and
`packages/mina-zkapp/src/usdc-faucet.ts`.

Nothing generates it any more — `devnet.sh endpoints`, which used to, is gone
with the box. **Edit it by hand** when a devnet address changes; a new Mina USDC
deploy prints the values to pin (`tools/mina/deploy-usdc-token.mts`).

## Where the live devnet is documented

| Thing                                          | Where                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Devnet endpoints, tokens, program ids          | [`endpoints.json`](./endpoints.json)                                          |
| The two connector boxes                        | `infra/linode-relay/`, `infra/linode-store/`                                  |
| The faucet box                                 | `infra/linode-faucet/`, `docs/operators/faucet-box-bringup.md`                |
| Fleet lifecycle (provision / deploy / destroy) | `infra/devnet-manage.sh`                                                      |
| Fleet CI                                       | `.github/workflows/fleet-ops.yml`, `fleet-health.yml`, `promote-to-fleet.yml` |
| Disposable local chains                        | `docker-compose.yml`, `local/`, `local/README.md`                             |
