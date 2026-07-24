## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```

### Cast

```shell
$ cast <subcommand>
```

## Mainnet deploy runbook (Base, native USDC) -- HUMAN ONLY

`script/DeployMainnet.s.sol` deploys a `TokenNetworkRegistry` + a `TokenNetwork` bound to
**Circle's native USDC on Base mainnet** (chainId 8453,
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`). It compiles and is proven against a live
Base-mainnet fork in CI (`.github/workflows/contracts.yml`, `mainnet-fork-test` job,
`test/DeployMainnet.fork.t.sol`) with **no broadcast and no secrets** -- the fork test uses the
public `https://mainnet.base.org` RPC. Nothing in this repo ever runs `--broadcast` against Base
mainnet or holds a funded deployer key; the actual broadcast below is a manual, human-only step.

To run the fork test locally:

```shell
cd packages/contracts
forge build
forge test --match-path 'test/DeployMainnet.fork.t.sol' --fork-url https://mainnet.base.org -vvv
```

The `--fork-url` flag is required -- the suite does not self-fork via `vm.createSelectFork`
(combining that with a CLI `--fork-url` currently crashes `forge` on an upstream `op-revm` bug when
forking an OP-stack chain like Base: "Missing operator fee scalar for isthmus L1 Block").

### Why the registry is deployed but the TokenNetwork isn't registered in it

`TokenNetworkRegistry.createTokenNetwork(token)` hardcodes a 1,000,000 \* 10\*\*18 deposit cap and a
365-day lifetime -- correct for a mock 18-decimal token, wrong for 6-decimal USDC and wrong for the
conservative caps an initial mainnet soak needs. `DeployMainnetScript` therefore deploys the
`TokenNetwork` directly via `new TokenNetwork(usdc, maxChannelDeposit, maxChannelLifetime)` with the
env-defaulted caps below. The `TokenNetworkRegistry` is still deployed alongside it (for
architectural consistency with `DeployTestnet.s.sol` and any future registry-driven tooling), but
`registry.getTokenNetwork(usdc)` will return `address(0)` -- the mainnet `TokenNetwork` is
intentionally not registered there.

### Required environment variables

| Variable               | Required                   | Notes                                                                                                                                                                                                        |
| ---------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PRIVATE_KEY`          | Yes (for a real broadcast) | Funded Base-mainnet deployer key, without `0x` prefix. If unset, the script still runs but only _simulates_ -- nothing is broadcast, even with `--broadcast`.                                                |
| `USDC`                 | No                         | ERC20 token address to bind the `TokenNetwork` to. Defaults to native USDC on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Only override for a rehearsal against a different token.                   |
| `MAX_CHANNEL_DEPOSIT`  | No                         | Max deposit per participant per channel, in the token's smallest unit. Defaults to `1_000 * 10**6` (1,000 USDC -- **6 decimals, not 18**). Raise for a larger soak once the initial deployment is validated. |
| `MAX_CHANNEL_LIFETIME` | No                         | Max channel lifetime in seconds before force-close is allowed. Defaults to `30 days`.                                                                                                                        |
| `BASE_MAINNET_RPC_URL` | Yes                        | Base mainnet RPC endpoint (see `foundry.toml`'s `base_mainnet` alias and `.env.example`).                                                                                                                    |
| `ETHERSCAN_API_KEY`    | For `--verify`             | Basescan API key so the deployed contracts verify automatically.                                                                                                                                             |

### One-command broadcast

```shell
cd packages/contracts
PRIVATE_KEY=<funded-deployer-key-no-0x-prefix> \
  forge script script/DeployMainnet.s.sol \
    --rpc-url base_mainnet \
    --broadcast \
    --verify
```

Add `USDC=...`, `MAX_CHANNEL_DEPOSIT=...`, and/or `MAX_CHANNEL_LIFETIME=...` before the `forge
script` invocation to override any default. Before running for real, rehearse with the same command
minus `--broadcast` (or point `--rpc-url` at a fork) to confirm the console output looks right.

### Expected console output

```
PRIVATE_KEY not set -- running keyless simulation (no broadcast)   # only when PRIVATE_KEY is unset

=== DEPLOYMENT COMPLETE ===
BASE_MAINNET_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
BASE_MAINNET_REGISTRY_ADDRESS=0x...
BASE_MAINNET_TOKEN_NETWORK_ADDRESS=0x...

maxChannelDeposit: 1000000000
maxChannelLifetime: 2592000

NOTE: TokenNetwork was deployed directly (not via registry.createTokenNetwork) and is
NOT registered in TokenNetworkRegistry's mapping. See README.md runbook.
```

### After a real broadcast: promoting the address (cross-repo, human)

The `BASE_MAINNET_TOKEN_NETWORK_ADDRESS` printed above is what downstream config needs. This repo
does **not** consume it directly -- promotion happens in `toon-protocol/toon`:

1. Set `base-mainnet.tokenNetworkAddress` in `@toon-protocol/core`'s `chain-config.ts` to
   `BASE_MAINNET_TOKEN_NETWORK_ADDRESS`.
2. Set the `TOON_TOKEN_NETWORK` environment override (if used) to the same address for any deployed
   connector/faucet pointed at Base mainnet.
3. Confirm `network-profile.ts` now resolves `evm: 'configured'` for the mainnet tier.

This promotion step, and the broadcast above, are both **human-only** -- see issue `#388` and the
"Out of scope" section of issue `#405` for the full list of things this repo's automation must never
do (broadcast, generate/hold a private key, or edit the cross-repo preset).

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
