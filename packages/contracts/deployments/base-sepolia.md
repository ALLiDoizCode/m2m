# Base Sepolia deployment record (chainId 84532)

Public testnet deployment of the TOON payment-channel contracts + a 6-decimal
mock USDC, for the devnet nodes' EVM settlement to point at.

- **Network:** Base Sepolia (`chainId 84532`)
- **RPC:** https://sepolia.base.org
- **Deployed:** 2026-07-18
- **Script:** `packages/contracts/script/DeployTestnet.s.sol`
- **Explorer:** https://sepolia.basescan.org

## Deployed contracts

| Contract                                           | Address                                      | Explorer                                                                        |
| -------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| TokenNetworkRegistry                               | `0xcC9079adE929b168B54145f6d25262b64FAB9D5b` | https://sepolia.basescan.org/address/0xcC9079adE929b168B54145f6d25262b64FAB9D5b |
| Mock USDC ("USD Coin (mock)" / `USDC`, 6 decimals) | `0x49beE1Bca5d15Fb0963117923403F9498119a9Ce` | https://sepolia.basescan.org/address/0x49beE1Bca5d15Fb0963117923403F9498119a9Ce |
| TokenNetwork (USDC)                                | `0x1E95493fEF46707E034b4a1945f25a8C76A1823D` | https://sepolia.basescan.org/address/0x1E95493fEF46707E034b4a1945f25a8C76A1823D |

The TokenNetwork was created **through the registry** via
`registry.createTokenNetwork(usdc)`, so `registry.getTokenNetwork(usdc)` resolves
it — the connector needs only `registryAddress` + `tokenAddress` at runtime.
Verified on-chain: `getTokenNetwork(0x49beE1…) == 0x1E95493f…`.

## Transactions

| Step                              | Tx hash                                                              |
| --------------------------------- | -------------------------------------------------------------------- |
| Deploy TokenNetworkRegistry       | `0x3db004967999e24a51c61251534a1bd507e679d4db94cf71eb1a4b08de2f1e49` |
| Deploy Mock USDC (MockERC20)      | `0x60bf2264a0f543593e155732e194f50855a38e1d2d33b9ff3d21a426a0019b08` |
| registry.createTokenNetwork(USDC) | `0xb066cf35dd118d21ff269c60466b5bd5a922d56a4f38a968c6c012d2199046c5` |
| Mock USDC mint → deployer         | `0xf2855eea2a81157ffbd832cefd05528c62aeeac0945203661dd314a36a4c1ed5` |

## Deployer / distributor

- **Address:** `0x6bafedaF18FF62f0a63dd0148bafa163204627F6` (fresh, testnet-only)
- **USDC balance:** `101,000,000 USDC` (`101000000000000` base units) —
  1,000,000 from the MockERC20 constructor + 100,000,000 from the deploy-script mint.
  Held for distribution to node settlement identities / clients.
- The private key lives outside the repo (in the operator's key store); it is a
  throwaway Base Sepolia testnet key holding only mock funds.

## Connector chainProvider config (`evm:84532`)

Paste into `chainProviders:` in the node `connector.yaml`. `keyId` must be the
node's own EVM settlement key (e.g. derived from `TOON_MNEMONIC`); the value below
is a placeholder.

```yaml
- chainType: evm
  chainId: evm:84532
  rpcUrl: https://sepolia.base.org
  registryAddress: '0xcC9079adE929b168B54145f6d25262b64FAB9D5b'
  tokenAddress: '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce'
  keyId: 'placeholder-overwritten-by-mnemonic'
  settlementOptions:
    threshold: '5000'
    pollingIntervalMs: 100
    settlementTimeoutSecs: 3600
    initialDepositMultiplier: 2
    ledgerSnapshotPath: ./data/ledger-evm-base-sepolia.json
```

> Testnet only. No mainnet, no real funds.
