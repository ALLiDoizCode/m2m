# Multi-chain paid round-trip against the live devnet

End-to-end proof that a **client → connector(terminator) → relay(app)** paid HTTP
write settles on-chain across **EVM, Solana, and Mina**, then the written Nostr
event is read back from the relay's free-read WebSocket.

Each run: open/deposit an on-chain payment channel toward the terminator → sign a
per-packet balance-proof claim → `POST /ilp` (an ILP PREPARE carrying an HTTP
`POST /write` envelope) with the claim header → assert ILP **FULFILL** → assert
the event is stored (WS read-back) → assert an **unpaid** POST gets x402 **402**.

The transport (envelope, PREPARE, claim header, WS read) is **chain-agnostic** and
lives in `../../packages/connector/test/integration/paid-roundtrip-client.ts`
(exports `signEphemeralKind1Event`, `buildStoreWriteEnvelope`,
`verifyEventStoredViaWs`). Only the **channel-open + claim** differ per chain.

## Topology

A standalone connector runs as a paid reverse proxy ("terminator") in front of an
oblivious relay. Bring it up with the multichain config here:

```bash
docker network create e2e-net
# relay (oblivious app): WS read on :7100, store /write internal-only
docker run -d --name e2e-relay --network e2e-net \
  -e TOON_OBLIVIOUS_MODE=true -e TOON_BLS_PORT=3100 -e TOON_RELAY_PORT=7100 \
  -e TOON_CHAIN=none -e TOON_DEV_MODE=false -e TOON_MNEMONIC="<relay seed>" \
  -p 127.0.0.1:7100:7100 ghcr.io/toon-protocol/relay:latest
# connector (terminator): /ilp on :3000; derives per-chain settlement keys from TOON_MNEMONIC
docker run -d --name e2e-connector --network e2e-net \
  -e CONFIG_FILE=/app/config/connector-multichain.yaml \
  -e TOON_MNEMONIC="<connector seed>" -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  -v "$PWD/connector-multichain.yaml:/app/config/connector-multichain.yaml:ro" \
  -p 127.0.0.1:3000:3000 ghcr.io/toon-protocol/connector:<version>
```

`connector-multichain.yaml` registers `evm` + `solana` + `mina` chainProviders and
one terminated route (`g.terminator.relay` → the relay's `/write`) that settles on
all three. The terminator's per-chain settlement addresses must match the keys
derived from its `TOON_MNEMONIC` (mnemonic signing mode).

## Run

Fund the client wallet on the target chain first (devnet faucet). Then:

```bash
cd ../../packages/connector   # for node_modules / dist resolution

# EVM — env-driven; the EVM client channel is opened by the embedded node
NODE_TLS_REJECT_UNAUTHORIZED=0 DEVNET_CHAIN=evm \
  DEVNET_TERMINATOR_ADDR=0x... DEVNET_CLIENT_KEY=0x... DEVNET_CLIENT_ADDR=0x... \
  TERMINATOR_ILP_URL=http://127.0.0.1:3000/ilp EVM_RPC_URL=https://evm-rpc.<devnet> \
  FAUCET_URL=https://faucet.<devnet> RELAY_WS_URL=ws://127.0.0.1:7100 \
  npx ts-node --project packages/connector/tsconfig.json \
  ../../scripts/devnet-roundtrip/devnet-run.ts

# Solana — opens the channel directly via SolanaPaymentChannelSDK (the embedded
# node's ChannelManager is EVM-only), hand-builds the SolanaClaimMessage.
NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_PATH=$PWD/node_modules \
  SOL_CLIENT_PRIV=<funded base58 keypair> \
  node ../../scripts/devnet-roundtrip/solana-roundtrip.cjs

# Mina — needs a pre-deployed client↔terminator USDC PaymentChannel zkApp + the
# client funded with USDC; signs the o1js Schnorr claim via esm-deploy/sign-claim.mts.
cd ../../scripts/devnet-roundtrip/esm-deploy && npm i   # one-time (o1js, ts-node)
cd -
NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_PATH=$PWD/node_modules \
  MINA_CLIENT_PRIV=<funded EK... key> \
  node ../../scripts/devnet-roundtrip/mina-roundtrip.cjs
```

## Env vars

| Var                                                                   | Used by       | Meaning                                                                                              |
| --------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `DEVNET_CHAIN`                                                        | devnet-run.ts | `evm` (default) or `solana`                                                                          |
| `DEVNET_CLIENT_KEY` / `DEVNET_CLIENT_ADDR` / `DEVNET_TERMINATOR_ADDR` | EVM           | client key+addr, terminator settlement addr                                                          |
| `SOL_CLIENT_PRIV`                                                     | solana        | funded Solana keypair (base58) — **required**                                                        |
| `MINA_CLIENT_PRIV`                                                    | mina          | funded Mina key (`EK…`) — **required**                                                               |
| `DEVNET_SOLANA_RPC` / `DEVNET_SOLANA_WS`                              | solana        | RPC + the **separate** PubSub WS host (`solana-ws.*`, not `solana-rpc.*` — see connector #236)       |
| `MINA_GRAPHQL` / `MINA_CHANNEL` / `MINA_TOKEN_ID` / `MINA_ESM_DIR`    | mina          | GraphQL (use `api.minascan.io`, not the `mina.*` proxy), channel zkApp, USDC tokenId, ESM helper dir |
| `MINA_PREPARE_EXPIRY_MS`                                              | mina          | PREPARE expiry window (ms); default `300000` — covers the ~60s first-claim on-chain verify (#237)    |
| `TERMINATOR_ILP_URL` / `RELAY_WS_URL`                                 | all           | terminator `/ilp` + relay WS                                                                         |

## Caveats

- **The deployed-address defaults in the `.cjs` scripts (program id, zkApp,
  mints, tokenId) are devnet-specific** and change on each devnet provision —
  override via env or update the constants. The Solana program id is
  non-deterministic (regenerated per `cargo build-sbf`).
- **No private keys are committed** — `SOL_CLIENT_PRIV` / `MINA_CLIENT_PRIV` are
  required at runtime and must be funded devnet throwaway keys.
- Mina is slow (~3-min devnet slots); the first claim per channel triggers a full
  on-chain verify (~60s) that exceeds the 60s PREPARE expiry the EVM/Solana
  harnesses use (connector #237). `mina-roundtrip.cjs` therefore signs its PREPAREs
  with a 300s expiry (`PREPARE_EXPIRY_MS`, override via `MINA_PREPARE_EXPIRY_MS`) so
  the first claim round-trips cleanly; subsequent claims hit the ~0.6s fast path.
  The channel-deploy/USDC-mint setup helpers are one-time and devnet-specific (kept
  out of this dir).
