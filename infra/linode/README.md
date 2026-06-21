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

| Service                     | From                            | Public endpoint                                            | Notes                                                                                                                           |
| --------------------------- | ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Anvil (EVM, chain-id 31337) | base compose `anvil`            | `https://evm-rpc.<DOMAIN>`                                 | auto-deploys Mock USDC `0x5FbDB2…` + `TokenNetworkRegistry` via `DeployLocal.s.sol`                                             |
| Faucet                      | base compose `faucet`           | `https://faucet.<DOMAIN>`                                  | `GET /health`, `GET /api/info`, `POST /api/request {address}` → 100 ETH + 10k USDC. **EVM only.**                               |
| Solana test validator       | base compose `solana-validator` | `https://solana-rpc.<DOMAIN>` + `wss://solana-ws.<DOMAIN>` | auto-deploys the payment-channel program; `devnet.sh mint` creates a deterministic mock-USDC SPL mint (`H8HSreUF…`, 6 decimals) |
| Mina (public devnet)        | nginx passthrough               | `https://mina.<DOMAIN>/graphql`                            | **proxy only** — no Mina node here (lightnet is too heavy); state is the public devnet's                                        |
| nginx + certbot             | this overlay                    | 80/443                                                     | the only public surface                                                                                                         |

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

## Reset semantics

Chain state is **ephemeral and deterministic**. `redeploy` (and any container
restart) reverts Anvil and `--reset`s the validator, so Mock USDC always returns
to `0x5FbDB2…` and the Solana program to its fixed id. Never park anything of
value here — all keys (Anvil account #0, etc.) are public.

## Security

- Public ports are **22 / 80 / 443 only**. The raw chain/faucet ports
  (8545/8899/8900/3500) are published on the host by the base compose but
  **blocked from the internet** by `firewall.sh` via `DOCKER-USER` iptables rules
  (Docker bypasses `ufw`, so this is mandatory — `ufw` alone won't close them).
- nginx rate-limits the RPC/faucet/WS vhosts per-IP.
- The Mina vhost proxies **only** `/graphql` to `api.minascan.io`.

## USDC across chains

| Chain  | Token                 | Decimals    | Status                                                             |
| ------ | --------------------- | ----------- | ------------------------------------------------------------------ |
| EVM    | MockERC20 `0x5FbDB2…` | **6**       | ✅ TokenNetwork EIP-712 settlement                                 |
| Solana | SPL mint `H8HSreUF…`  | **6**       | ✅ program is SPL-aware; mint + faucet via `devnet.sh`             |
| Mina   | token zkApp           | 6 (planned) | 🚧 zkApp settles native MINA today; USDC token support in progress |

**Decimals:** USDC is 6-decimal on every chain, so a claim's base-unit amount
means the same thing everywhere — no cross-chain normalization required.

## Known gaps / follow-ups

- **Mina USDC.** The Mina zkApp currently settles native MINA; a token-owner zkApp
  - token-aware deposit/settle is being added so Mina can settle USDC too.
- **No block explorer.** Otterscan (what Akash advertised) needs Erigon's `ots_*`
  RPC namespace, which Anvil doesn't implement, so it's intentionally omitted
  rather than shipped broken.
- **Mina node is read-through only.** We proxy the public Mina devnet; we don't
  host a node.
