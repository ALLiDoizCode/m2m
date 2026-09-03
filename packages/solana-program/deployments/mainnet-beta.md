# Solana Payment-Channel: Mainnet-Beta Deployment Record

**Cluster:** Solana **mainnet-beta**, `https://api.mainnet-beta.solana.com`. Real SOL, real
funds. This is not devnet and not a local `solana-test-validator`.

**Deployed:** 2026-08-14

This is the first deployment of the payment-channel program to Solana mainnet-beta, closing the
deploy half of [#834](https://github.com/toon-protocol/connector/issues/834). It was performed
by hand per the "Mainnet Deployment Runbook" in `docs/solana-deployment.md`, which
[#954](https://github.com/toon-protocol/connector/issues/954) added. Mirrors the format of
`devnet-public.md`.

Unlike the devnet record, **no mint was created and no treasury exists**. Mainnet channels
settle in Circle's native USDC. `deploy.sh` has no mint-creation path on any network, and
`infra/solana/create-usdc-mint.sh` refuses a mainnet-shaped RPC URL outright.

## On-chain addresses

| Item                    | Value                                                     |
| ----------------------- | --------------------------------------------------------- |
| Program ID              | `8e7BhzydH1EqL486tw6Lp99BXviH3i5JN8qNpMSNmHj3`            |
| ProgramData account     | `29MT16eh1GCdL4JWrJHjyTWu5ZMn217h25ojCvFpx2wc`            |
| Owner (loader)          | `BPFLoaderUpgradeab1e11111111111111111111111`             |
| Upgrade authority       | `DaYDFYeCFr6FFyZLGywZV1FPhfbyeuTW65EZ22meEqAi` (deployer) |
| Circle USDC mint (6 dp) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`            |
| Deployer / fee-payer    | `DaYDFYeCFr6FFyZLGywZV1FPhfbyeuTW65EZ22meEqAi`            |

The USDC mint is a **recorded convention, not an on-chain constraint.** The program takes no
mint at deploy time and is mint-agnostic per channel: each channel names its own SPL mint at
`InitializeChannel`. `deploy.sh` writes the mint into `tools/solana/program-id.mainnet.json`
for operators to read and enforces nothing about it afterwards.

Upgrade authority is the deployer keypair, per the decision recorded on #834 before the
broadcast. That decision was forced rather than chosen: `deploy.sh` derives its
`--upgrade-authority` target with `solana-keygen pubkey <path>`, so the flag requires a keypair
file, and handing authority to a key held by someone else cannot happen during the deploy
itself. Moving it later takes a bare pubkey and one transaction signed by the current authority
alone.

Program IDs are **non-deterministic per deploy** (a fresh program keypair is generated), so this
id is unrelated to the devnet id `2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip`.

## Binary

- Source: `packages/solana-program/` (native Rust, non-Anchor).
- Built with `cargo build-sbf --tools-version v1.52`, the pin `deploy.sh` and CI both use.
- Build host: `aarch64-apple-darwin`, solana-cli **3.1.12** (matching CI's `v3.1.12` pin).
- `payment_channel.so` size: **109,416 bytes**.
- `sha256`: `57619b3068d2e51cc34a47cd3e76a0736e5c7a58b450cbbc72b5b352a44e529e`

### Reproducibility, verified against chain

The deployed bytecode was pulled back down and compared to the local artifact:

```
solana program dump 8e7BhzydH1EqL486tw6Lp99BXviH3i5JN8qNpMSNmHj3 onchain.so --url https://api.mainnet-beta.solana.com
head -c 109416 onchain.so | shasum -a 256
```

which yields `57619b3068d2e51cc34a47cd3e76a0736e5c7a58b450cbbc72b5b352a44e529e`, identical to the
local build. The dump is `max_len` bytes and zero-padded past the binary, hence the truncation.

An arm64 macOS build of this source produces the byte-identical size to CI's ubuntu build. Worth
recording because it was not a given: this file's own devnet predecessor notes a Docker build of
the same source at 112,513 bytes against 109,401 elsewhere.

## Program account sizing and rent

| Item                             | Value                                     |
| -------------------------------- | ----------------------------------------- |
| Binary size                      | 109,416 bytes                             |
| Upgrade headroom allocated (25%) | 27,354 bytes                              |
| `max_len` / on-chain data length | **136,770 bytes**                         |
| Rent-exempt deposit              | **953,123,280 lamports (0.95312328 SOL)** |

Reconciles exactly against the rent formula in `docs/solana-deployment.md`:
`(136,770 + 45 + 128) x 6,960 = 953,123,280`.

The headroom is the `deploy.sh` default for a mainnet initial deploy with no explicit
`--max-len`, taken deliberately: the Solana lifecycle still lacks close, coop-close and rescue,
so the binary is certain to grow, and `solana program extend` later costs more than the headroom
does now.

**Rent is a refundable deposit, not a burn.** It is reclaimable by closing the program, which
requires upgrade authority.

## Cost

| Item                                 | SOL            |
| ------------------------------------ | -------------- |
| Deployer funded                      | 1.3998         |
| Remaining after deploy               | 0.44497028     |
| Total moved                          | 0.95482972     |
| Of which refundable rent deposit     | 0.95312328     |
| **Irrecoverable (transaction fees)** | **0.00170644** |

## Transaction signatures

| Action | Signature                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------- |
| Deploy | `2yXbkgQ2ZC3iuuNneqpqsCakF7C1HefBQEnWDWjaZRhQC4HYYy4AaAcEyuCzojtnSpkdgPAcV7D9pipWDGMKck1b` (slot 439316400) |

## Verification

```
solana program show 8e7BhzydH1EqL486tw6Lp99BXviH3i5JN8qNpMSNmHj3 --url https://api.mainnet-beta.solana.com
```

Confirms `executable`, owner `BPFLoaderUpgradeab1e...`, data length 136,770, and the upgrade
authority above.

## What this deployment does not yet mean

- **No channel has been opened against this program.** Nothing has settled on Solana mainnet.
- **No node is configured to use it yet.** `[settlement.solana]` on every node still points at
  devnet.
- **Soak has not started.** Per toon-meta's soak criteria a family's clock cannot begin until
  every lifecycle path has one live observation, and no channel has been closed on any chain.
