# Solana Payment-Channel — Public Devnet Deployment Record

**Cluster:** Solana **public devnet** — `https://api.devnet.solana.com` (real devnet, NOT the
self-hosted local `solana-test-validator`). Devnet SOL only; no mainnet, no real funds.

**Deployed:** 2026-07-18

This deployment replaces the self-hosted local-validator Solana settlement target for the
devnet connector nodes. The connector settles `solana:devnet` channels against this program
using the mock-USDC SPL mint below.

## On-chain addresses

| Item | Value |
| --- | --- |
| Program ID | `2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip` |
| ProgramData account | `omq3fmopaCbHHr4tT2UJyU46NztSCeA76UYQWDbprJ9` |
| Upgrade authority | `AEPoA5xTTJY9SR8c5CfsemFGC5TmxQBe6Xf6wewEtnYa` (deployer) |
| Mock USDC mint (6 dp) | `xyc5J8MgKFiEN13PnfftdXxUzYH34FEvw1LCrFwN7in` |
| Mint authority | `AEPoA5xTTJY9SR8c5CfsemFGC5TmxQBe6Xf6wewEtnYa` (deployer) |
| Treasury ATA (deployer) | `9JvfXPAVox3EvYHV1CNTHeZ3h7yFkWgHuRey58JtwYBL` |
| Treasury supply | 100,000,000 USDC (100000000000000 base units, 6 dp) |
| Deployer / fee-payer | `AEPoA5xTTJY9SR8c5CfsemFGC5TmxQBe6Xf6wewEtnYa` |

> Note: the program ID is **non-deterministic per `cargo build-sbf`** (a fresh program keypair
> was generated for this public-devnet deploy), so it differs from the local-validator id.

## Binary

- Source: `packages/solana-program/` (native Rust, non-Anchor), built with `cargo build-sbf`.
- `payment_channel.so` size: **105,128 bytes**.
- Program account data length on-chain: 105,128 bytes; `executable: true`.

## Transaction signatures

| Action | Signature |
| --- | --- |
| Program deploy | `p9qhAfyghEi59xvYfHU9Gvbnaf49cYWsAtinbwoJR4YfxppAeQyJRj1Y7u1ePiCFiDAZtd6j2y7NtgguX1FXcEX` |
| Create USDC mint | `5ujTr7fyUfPgoQrNYcXNXtmPj5RozAJxQKj21iqZsPUu9ETfMnBujvELre4kdnCYyAn4omAwGio4oHaj3tR9rTBz` |
| Create treasury ATA | `4xMPwBikFHLVpF71YceJs6dRximSKvDxs9NdLAdqACeMX14N5qWEPGpTLUSDDAp2SgueLeJLMgGG558Tb1UeCxG5` |
| Mint 100M USDC → treasury | `4mf3BcqmpPegyZUechWHn6SnoTmYtcAxqHKS4EKW5Ts9d1MMv9nuU4VFGq9ZaQX5cVxmxpRrLGMFx8RGMW6PbKQv` |

## Explorer links (cluster=devnet)

- Program: <https://explorer.solana.com/address/2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip?cluster=devnet>
- Mock USDC mint: <https://explorer.solana.com/address/xyc5J8MgKFiEN13PnfftdXxUzYH34FEvw1LCrFwN7in?cluster=devnet>
- Deploy tx: <https://explorer.solana.com/tx/p9qhAfyghEi59xvYfHU9Gvbnaf49cYWsAtinbwoJR4YfxppAeQyJRj1Y7u1ePiCFiDAZtd6j2y7NtgguX1FXcEX?cluster=devnet>

## Cost

- Program rent (held in ProgramData account): ~0.733 SOL for the 105 KB binary.
- Total deploy + mint spend: ~0.74 SOL (deployer went 2.0 → 1.2619 SOL).

## Verification

```console
$ solana program show 2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip --url https://api.devnet.solana.com
Program Id: 2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip
Owner: BPFLoaderUpgradeab1e11111111111111111111111
ProgramData Address: omq3fmopaCbHHr4tT2UJyU46NztSCeA76UYQWDbprJ9
Authority: AEPoA5xTTJY9SR8c5CfsemFGC5TmxQBe6Xf6wewEtnYa
Data Length: 105128 (0x19aa8) bytes

$ spl-token supply xyc5J8MgKFiEN13PnfftdXxUzYH34FEvw1LCrFwN7in --url https://api.devnet.solana.com
100000000
```

## Connector chainProvider config (`solana:devnet`)

Matches the `infra/linode-node/connector.yaml` box format. `keyId` is overwritten from the
node's `TOON_MNEMONIC` at boot; `SOLANA_PRIVATE_KEY` env may also supply the raw key.

```yaml
  - chainType: solana
    chainId: solana:devnet
    rpcUrl: https://api.devnet.solana.com
    wsUrl: wss://api.devnet.solana.com
    programId: '2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip'
    tokenMint: 'xyc5J8MgKFiEN13PnfftdXxUzYH34FEvw1LCrFwN7in'
    keyId: 'placeholder-overwritten-by-mnemonic'
    cluster: devnet
    settlementOptions:
      threshold: '5000'
      pollingIntervalMs: 100
      settlementTimeoutSecs: 3600
      initialDepositMultiplier: 2
      ledgerSnapshotPath: /app/data/ledger-solana.json
```

## Reproduce / redeploy

Keypairs used for this deploy live outside the repo (scratchpad, not committed). To redeploy
or upgrade:

```bash
cd packages/solana-program && cargo build-sbf
solana program deploy target/deploy/payment_channel.so \
  --program-id <program-keypair.json> \
  --upgrade-authority <deployer.json> \
  --url https://api.devnet.solana.com
# mock USDC:
spl-token --url https://api.devnet.solana.com create-token --decimals 6 <mint-keypair.json>
spl-token --url https://api.devnet.solana.com create-account <MINT>
spl-token --url https://api.devnet.solana.com mint <MINT> 100000000
```
