# Mina Payment Channel zkApp -- Devnet Deployment & Operations Guide

This guide covers deploying the Mina payment channel zkApp to devnet, configuring the `MinaPaymentChannelProvider` in the connector, proof generation benchmarks, the ZK-private settlement model, and operating payment channels in a test environment.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Deployment](#deployment)
  - [Build the zkApp](#build-the-zkapp)
  - [Deploy to Devnet](#deploy-to-devnet)
  - [Deployment Cost Estimates](#deployment-cost-estimates)
  - [Verify Deployment](#verify-deployment)
- [Configuration](#configuration)
  - [MinaProviderConfig Fields](#minaproviderconfig-fields)
  - [Connector YAML Configuration Example](#connector-yaml-configuration-example)
  - [Per-Peer Chain Reference](#per-peer-chain-reference)
- [Privacy Model](#privacy-model)
  - [On-Chain Privacy (zk-SNARKs)](#on-chain-privacy-zk-snarks)
  - [Transport Privacy (NIP-59)](#transport-privacy-nip-59)
  - [Combined Dual-Privacy Model](#combined-dual-privacy-model)
  - [Privacy Limitations](#privacy-limitations)
- [Performance Benchmarks](#performance-benchmarks)
  - [Proof Generation Times](#proof-generation-times)
  - [Hardware Recommendations](#hardware-recommendations)
  - [Proof Generation Tuning](#proof-generation-tuning)
- [Operational Requirements](#operational-requirements)
  - [Archive Node](#archive-node)
  - [Block Times and Finality](#block-times-and-finality)
  - [Channel Lifecycle Operations](#channel-lifecycle-operations)
  - [Throughput Limits](#throughput-limits)
- [Troubleshooting](#troubleshooting)
- [Local Development with Lightnet](#local-development-with-lightnet)
- [Devnet Endpoints Reference](#devnet-endpoints-reference)
- [Makefile Targets](#makefile-targets)

---

## Prerequisites

Before deploying the Mina payment channel zkApp, ensure the following are in place:

1. **Node.js >= 22.11.0** -- required by the connector monorepo

   ```bash
   node --version
   ```

2. **o1js installed** -- the Mina zkApp framework is installed as a workspace dependency

   ```bash
   npm install   # from monorepo root
   npm ls o1js   # verify o1js version
   ```

3. **Funded Mina devnet account** -- obtain devnet MINA from the faucet:
   - Faucet: <https://faucet.minaprotocol.com/?network=devnet>
   - You need at least 2 MINA for zkApp deployment (1 MINA account creation fee + transaction fees)

4. **Build order** -- shared types must build before the zkApp:

   ```bash
   npm run build --workspace=packages/shared       # First: shared type definitions
   npm run build --workspace=packages/mina-zkapp    # Second: zkApp compilation
   ```

   The deploy script imports from `packages/mina-zkapp/dist/`, so the zkApp must be built before deployment.

---

## Deployment

### Build the zkApp

```bash
# Using Makefile
make mina-build

# Or directly
npm run build --workspace=packages/mina-zkapp
```

This compiles the `PaymentChannel` zkApp TypeScript source to JavaScript in `packages/mina-zkapp/dist/`.

### Deploy to Devnet

**Using the Makefile target:**

```bash
make mina-deploy-devnet DEPLOYER_KEY=<base58-private-key>
```

**Using the deploy script directly:**

```bash
npx ts-node tools/mina/deploy-zkapp.ts \
  --network https://api.minascan.io/node/devnet/v1/graphql \
  --deployer-key <base58-private-key>
```

**Using environment variable for the deployer key (recommended for security):**

```bash
export MINA_DEPLOYER_KEY=<base58-private-key>
npx ts-node tools/mina/deploy-zkapp.ts \
  --network https://api.minascan.io/node/devnet/v1/graphql
```

The deployer key can be passed via `--deployer-key` CLI argument or the `MINA_DEPLOYER_KEY` environment variable. The environment variable approach is recommended because CLI arguments are visible via `ps`.

**Security notes:**

- The deploy script **rejects non-HTTPS network URLs** to protect transaction data in transit.
- The zkApp private key is output to **stderr** (not stdout), so it can be securely redirected: `2>zkapp-key.txt`.

The deploy script (`tools/mina/deploy-zkapp.ts`) performs the following steps:

1. Parse args (`--network`, `--deployer-key` or `MINA_DEPLOYER_KEY` env var)
2. Enforce HTTPS on the network URL
3. Connect to the Mina network via `Mina.Network()`
4. Compile `PaymentChannel.compile()` -- outputs compilation time and verification key hash
5. Generate a random zkApp keypair
6. Deploy the zkApp via `Mina.transaction()` + `prove()` + `sign()` + `send()`
7. Wait for transaction inclusion
8. Output: zkApp address (stdout), verification key hash (stdout), zkApp private key (stderr)

### Deployment Cost Estimates

| Item                         | Approximate Cost | Notes                                       |
| ---------------------------- | ---------------- | ------------------------------------------- |
| zkApp account creation fee   | 1 MINA           | One-time fee for creating the zkApp account |
| Transaction fee              | ~0.01 MINA       | Per transaction                             |
| **Total initial deployment** | **~1.01 MINA**   | Account creation + deploy transaction       |

On devnet, MINA is free via the faucet: <https://faucet.minaprotocol.com/?network=devnet>

### Verify Deployment

After deployment, verify the zkApp is on-chain by querying the Mina GraphQL API:

```bash
curl -s -X POST https://api.minascan.io/node/devnet/v1/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ account(publicKey: \"<ZKAPP_ADDRESS>\") { zkapp { verificationKey { hash } } } }"}' \
  | jq .
```

Verify that:

- The account exists (non-null response)
- The `verificationKey.hash` matches the hash output by the deploy script during compilation
- The zkApp state fields are initialized (`channelState = UNINITIALIZED`)

---

## Configuration

### MinaProviderConfig Fields

The `MinaProviderConfig` interface defines how the connector connects to the Mina payment channel zkApp:

| Field          | Type     | Required | Description                                                                    |
| -------------- | -------- | -------- | ------------------------------------------------------------------------------ |
| `chainType`    | `'mina'` | Yes      | Discriminator for the Mina provider                                            |
| `graphqlUrl`   | `string` | Yes      | Mina GraphQL endpoint (e.g., `https://api.minascan.io/node/devnet/v1/graphql`) |
| `zkAppAddress` | `string` | Yes      | Base58-encoded deployed zkApp address (B62... format)                          |
| `keyId`        | `string` | No\*     | Raw **base58 Pallas private key** (see "Settlement key contract" below)        |
| `tokenId`      | `string` | No       | Mina token ID (defaults to native MINA if omitted)                             |
| `network`      | `string` | No       | Network name for chainId namespacing: `'devnet'` or `'mainnet'`                |

\* `keyId` is required to sign claims; if omitted, the connector falls back to the `MINA_PRIVATE_KEY` environment variable.

### Settlement key (`keyId`) contract

The Mina `keyId` follows the same contract as the EVM/Solana `keyId`: it holds the **raw private key**, not a key-management identifier.

- **Format:** a **base58-encoded Pallas private key** (the `EKE...` string produced by `PrivateKey.toBase58()` / the lightnet accounts manager's `sk` field). The connector passes it verbatim to the Mina SDK, which parses it when constructing the signer.
- **Environment fallback:** when `keyId` is omitted, the connector reads the key from the `MINA_PRIVATE_KEY` environment variable. If neither resolves, settlement bootstrap throws a descriptive error.

#### Standalone Mina-only nodes (claim-driven redemption)

A node configured with **only** a Mina `chainProvider` (no EVM entry) is fully supported. On startup it boots the settlement stack — `ChainProviderRegistry`, `SettlementExecutor`, `ClaimReceiver`, and `SettlementMonitor` — and registers a `mina:<network>` provider. The EVM `PaymentChannelSDK` and `ChannelManager` stay `null`.

Non-EVM settlement is **claim-driven redemption**: the connector redeems verified claims against zkApp channels **opened out-of-band**. It does **not** open Mina channels on demand. Operators open and deposit into channels themselves; the connector submits `claimFromChannel` transactions when a peer's credit balance crosses the settlement threshold.

### Dual-party Mina claims

A Mina claim's balance commitment is `Poseidon(balanceA, balanceB, salt)`. The connector's claim message (`MinaClaimMessage`) and the provider's `claimFromChannel` accept the following dual-party fields:

| Field               | Maps to           | Meaning                                           |
| ------------------- | ----------------- | ------------------------------------------------- |
| `transferredAmount` | `balanceA`        | Participant A's balance in the commitment         |
| `balanceB`          | `balanceB`        | Participant B's balance in the commitment         |
| `salt`              | `salt`            | Blinding factor that preserves commitment privacy |
| `proof`             | participant A sig | Participant A's signature/authorization           |
| `signatureB`        | participant B sig | Participant B's distinct signature/authorization  |

**Unidirectional vs. dual-party:** for a true two-party settlement (e.g. a bidirectional swap) supply a **distinct** `signatureB`, a real `balanceB`, and a **non-zero** `salt`. When `balanceB`/`signatureB` are **omitted**, the provider falls back to a **single-signature unidirectional** claim (`balanceB = 0`, `salt = 0`, `signatureB = signatureA`) and logs a warning. The per-packet claim producer emits unidirectional claims (it populates `transferredAmount` only); dual-party fields are threaded through when a caller supplies them.

### Connector YAML Configuration Example

Add a Mina provider to the connector's `chainProviders` array:

```yaml
nodeId: my-connector
btpServerPort: 3000

chainProviders:
  - chainType: mina
    chainId: 'mina:devnet'
    graphqlUrl: 'https://api.minascan.io/node/devnet/v1/graphql'
    zkAppAddress: '<DEPLOYED_ZKAPP_ADDRESS>'
    keyId: '<base58 Pallas private key, EKE...>' # raw key; or set MINA_PRIVATE_KEY
    tokenId: 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf'
    network: 'devnet'

peers:
  - id: peer-mina
    url: wss://peer-mina:3001
    authToken: secret-mina
    chain: 'mina:devnet' # References chainProviders[].chainId

  - id: peer-evm
    url: wss://peer-evm:3002
    authToken: secret-evm
    chain: 'evm:8453' # EVM peer unchanged
```

### Minimal Mina-only configuration

A standalone Mina-only node needs only the Mina `chainProvider`:

```yaml
nodeId: mina-node
btpServerPort: 3000
environment: development
deploymentMode: standalone

chainProviders:
  - chainType: mina
    chainId: 'mina:devnet'
    graphqlUrl: 'https://api.minascan.io/node/devnet/v1/graphql'
    zkAppAddress: '<DEPLOYED_ZKAPP_ADDRESS>'
    keyId: '<base58 Pallas private key, EKE...>' # or set MINA_PRIVATE_KEY
    network: 'devnet'

peers: [] # accepts inbound BTP; redeems claims against out-of-band channels
routes: []
```

### Per-Peer Chain Reference

Each peer's `chain` field references a registered provider's `chainId`. For Mina peers, set `chain` to the same value as the Mina provider's `chainId` (e.g., `"mina:devnet"`). This enables the `ChainProviderRegistry` to route settlement operations to the correct provider.

---

## Privacy Model

The Mina payment channel uses a **dual-privacy model** combining on-chain zk-SNARK proofs with optional transport-layer encryption to achieve end-to-end privacy for payment channel settlements.

### On-Chain Privacy (zk-SNARKs)

Individual channel balances are hidden behind Poseidon commitment hashes. The zkApp stores only a balance commitment on-chain:

```
balanceCommitment = Poseidon(balanceA, balanceB, salt)
```

**What is hidden on-chain (private inputs to the zk-SNARK):**

- Individual balances (`balanceA`, `balanceB`)
- Salt used for the commitment
- Transfer amounts per claim

**What is visible on-chain (public state fields):**

| Field               | Description                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `channelHash`       | `Poseidon(participantA.x, participantB.x, nonce)` -- identifies the participants                                                |
| `depositTotal`      | Total deposited amount (public for deposit verification)                                                                        |
| `channelState`      | Lifecycle state: `UNINITIALIZED`, `OPEN`, `CLOSING`, or `SETTLED`                                                               |
| `nonceField`        | Monotonically increasing claim counter                                                                                          |
| `closedAtSlot`      | Block slot when close was initiated                                                                                             |
| `settlementTimeout` | Challenge period duration in blocks                                                                                             |
| `tokenId_`          | Which token is used in the channel (named `tokenId_` in the zkApp to avoid collision with the built-in o1js `tokenId` property) |

On-chain observers can see _that_ a channel exists, _who_ the participants are, and _how much_ was deposited in total, but they **cannot** determine how the funds are distributed between participants or how much was transferred in each claim.

### Transport Privacy (NIP-59)

Claim messages sent between peers via BTP can optionally use NIP-59-inspired three-layer wrapping for transport privacy:

1. **Rumor** -- the unsigned claim content (innermost layer)
2. **Seal** -- the claim encrypted to the peer's public key (middle layer)
3. **Gift Wrap** -- signed with an ephemeral key (outermost layer)

BTP intermediaries see only encrypted bytes and an ephemeral public key. They cannot determine the claim content, the sender's identity, or correlate messages by timing.

### Combined Dual-Privacy Model

When both mechanisms are active:

- **On-chain observers** see commitment hashes but not balances or transfer amounts (zk-SNARK privacy)
- **Transport intermediaries** see encrypted bytes but not claim content or sender identity (NIP-59 privacy)
- **Only the channel participants** know the actual balances, transfer amounts, and settlement details

This provides end-to-end privacy where neither on-chain observers nor transport intermediaries can determine payment amounts.

### Privacy Limitations

The following information is **not** protected by the privacy model:

- **Timing analysis:** Transaction timestamps reveal when channels are opened, closed, and settled. Block inclusion timing may correlate with off-chain activity.
- **Participant metadata:** The `channelHash` reveals _who_ is transacting with _whom_ (participant public keys are inputs to the hash).
- **Deposit total:** The `depositTotal` field is public, revealing the total channel capacity.
- **Transaction graph analysis:** The pattern of channel openings and closings across participants can reveal network topology and payment flow patterns.
- **NIP-59 is optional:** Transport privacy requires both peers to support NIP-59 wrapping. Without it, claim messages are sent in plaintext over BTP.

---

## Performance Benchmarks

### Proof Generation Times

zk-SNARK proof generation runs client-side (not on-chain) and is CPU-intensive. The following benchmarks are estimates based on o1js proof generation characteristics:

| Operation          | Time (M1/M2 Mac) | Time (x86 Server) | Memory  | Notes                |
| ------------------ | ---------------- | ----------------- | ------- | -------------------- |
| Circuit compile    | 30--60s          | 45--90s           | ~2 GB   | One-time at startup  |
| `claimFromChannel` | 30--60s          | 45--90s           | ~1.5 GB | Per claim settlement |
| `initiateClose`    | 20--40s          | 30--60s           | ~1.5 GB | Per channel close    |
| `settle`           | 10--20s          | 15--30s           | ~1 GB   | Per channel settle   |

> **Note:** These are estimates based on o1js benchmarks for circuits of similar complexity. Actual times vary with hardware and circuit size. Measure on your target hardware before production deployment.

### Hardware Recommendations

| Tier        | CPU      | RAM   | Storage | Notes                                        |
| ----------- | -------- | ----- | ------- | -------------------------------------------- |
| Minimum     | 4 cores  | 4 GB  | SSD     | Proof generation will be slow but functional |
| Recommended | 8+ cores | 8+ GB | SSD     | Comfortable proof generation times           |

- **ARM (Apple M1/M2/M3)** shows approximately 30% faster proof generation than equivalent x86 hardware.
- Proof generation is **CPU-bound** -- more cores and faster clock speeds directly reduce proof times.
- Ensure sufficient RAM -- proof generation can consume up to 2 GB during circuit compilation.

### Proof Generation Tuning

- **Pre-compile circuit at startup:** Call `compileContract()` during provider initialization to avoid compilation delay on the first transaction. This is a one-time cost of 30--90s.
- **Settlement threshold tuning:** Batch on-chain settlements to reduce proof generation frequency. The connector's threshold-based settlement means most claims are accumulated off-chain; only periodic on-chain settlements require proof generation.
- **Development mode:** Use `proofsEnabled: false` for development and unit testing. This skips proof generation entirely, giving instant execution. Use `proofsEnabled: true` for integration testing and production to generate real zk-SNARK proofs.

---

## Operational Requirements

### Archive Node

An archive node is required for event retrieval (`getChannelEvents`). For devnet, use the public endpoint:

```
https://api.minascan.io/node/devnet/v1/graphql
```

If the archive node is unavailable, the provider falls back to direct account state polling via `getChannelState()`.

### Block Times and Finality

| Metric                 | Value             | Notes                                 |
| ---------------------- | ----------------- | ------------------------------------- |
| Block time             | ~3 minutes        | Per block on Mina                     |
| Probabilistic finality | ~45 minutes       | ~15 confirmations for high confidence |
| Challenge period       | Minimum 30 blocks | ~90 minutes for channel disputes      |

### Channel Lifecycle Operations

| Operation   | Description                                                                       | On-Chain? |
| ----------- | --------------------------------------------------------------------------------- | --------- |
| **Open**    | Create a new payment channel between two participants                             | Yes       |
| **Deposit** | Fund the channel with MINA tokens                                                 | Yes       |
| **Claim**   | Submit a balance proof to update the off-chain state (most frequent operation)    | No\*      |
| **Close**   | Initiate channel close; starts the challenge period                               | Yes       |
| **Settle**  | Finalize the channel after the challenge period; distribute funds to participants | Yes       |

\*Claims are the primary settlement mechanism and happen off-chain via BTP. Only periodic on-chain settlements (threshold-based) require proof generation.

### Throughput Limits

- **Maximum 24 zkApp transactions per block** -- this is a Mina protocol-level limit.
- Off-chain claims via BTP are not constrained by this limit and can happen at any frequency.
- Proof generation is asynchronous and non-blocking.

---

## Troubleshooting

### Proof Compilation Failure

**Symptom:** `PaymentChannel.compile()` fails or hangs.

**Resolution:**

- Verify o1js version matches the project requirement: `npm ls o1js`
- Ensure sufficient RAM (at least 4 GB free)
- Check that `packages/mina-zkapp` has been built: `npm run build --workspace=packages/mina-zkapp`

### Transaction Rejected

**Symptom:** Deployment or channel transaction fails with a rejection error.

**Resolution:**

- Check deployer account balance on devnet (need at least 1 MINA for account creation)
- Verify the account nonce is correct (stale nonce from a previous failed transaction)
- If upgrading, ensure the verification key matches the compiled circuit

### Slow Proof Generation

**Symptom:** Proof generation takes significantly longer than expected.

**Resolution:**

- Check hardware meets minimum requirements (4 cores, 4 GB RAM)
- For development/testing, use `proofsEnabled: false` to skip proof generation
- Pre-compile the circuit at startup to amortize compilation cost

### Archive Node Unavailable

**Symptom:** `getChannelEvents()` fails or returns empty results.

**Resolution:**

- Verify the GraphQL endpoint is reachable: `curl -s https://api.minascan.io/node/devnet/v1/graphql`
- Fall back to account state polling via `getChannelState()` for direct state reads
- Check if the archive node is temporarily down (Minascan status page)

---

## Local Development with Lightnet

For local development without connecting to devnet, you can use the Mina lightnet Docker image:

```bash
docker run --rm -it \
  -p 3085:3085 \
  -p 8181:8181 \
  -p 8282:8282 \
  -p 5433:5432 \
  o1labs/mina-local-network:o1js-main
```

| Service            | Port | Description                      |
| ------------------ | ---- | -------------------------------- |
| GraphQL            | 3085 | Mina node GraphQL endpoint       |
| Accounts Manager   | 8181 | Pre-funded test accounts         |
| Explorer           | 8282 | Block explorer UI                |
| Archive PostgreSQL | 5433 | Archive node database (remapped) |

**Notes:**

- Startup time: 1--3 minutes to reach SYNCED status
- Requires 4--8 GB RAM
- Use `http://localhost:3085/graphql` as the GraphQL endpoint for the connector config. Note: the deploy script (`tools/mina/deploy-zkapp.ts`) enforces HTTPS unconditionally, so for lightnet deployments either set the `graphqlUrl` in the connector YAML config (which does not enforce HTTPS) and deploy using the o1js `Mina.LocalBlockchain()` API directly, or temporarily bypass the HTTPS check in a local copy of the deploy script
- Pre-funded accounts are available via the accounts manager at `http://localhost:8181`

> **Note:** There are no `mina-up` / `mina-down` / `mina-logs` Makefile targets, and the
> repository's `docker-compose.yml` carries no Mina profile. They existed briefly and were
> removed: [ADR 0002](adr/0002-drop-mina-from-the-rust-connector.md) drops Mina from the Rust
> connector, so a local Mina node has no connector to serve — the `mina-lightnet` service was
> dialled by nothing in this repository, and the faucet's Mina leg points at **public devnet**
> rather than at it. Use `docker run` directly, as above, for zkApp work against a local network.

---

## Devnet Endpoints Reference

| Resource | URL                                               |
| -------- | ------------------------------------------------- |
| GraphQL  | `https://api.minascan.io/node/devnet/v1/graphql`  |
| Faucet   | `https://faucet.minaprotocol.com/?network=devnet` |
| Explorer | `https://minascan.io/devnet`                      |

### Lightnet (Local Development)

| Resource         | URL                             |
| ---------------- | ------------------------------- |
| GraphQL          | `http://localhost:3085/graphql` |
| Accounts Manager | `http://localhost:8181`         |
| Explorer         | `http://localhost:8282`         |

---

## Makefile Targets

| Target                    | Command                                         | Description                     |
| ------------------------- | ----------------------------------------------- | ------------------------------- |
| `make mina-build`         | `npm run build --workspace=packages/mina-zkapp` | Build the Mina zkApp            |
| `make mina-test`          | `npm run test --workspace=packages/mina-zkapp`  | Run Mina zkApp tests            |
| `make mina-deploy-devnet` | Runs deploy script with `DEPLOYER_KEY`          | Deploy the zkApp to Mina devnet |

**Prerequisites for deployment:**

1. `npm install` (from monorepo root -- installs o1js)
2. `npm run build --workspace=packages/shared` (shared type definitions)
3. `npm run build --workspace=packages/mina-zkapp` (zkApp compilation)
4. Funded Mina devnet account (via faucet)

**Usage:**

```bash
# Build
make mina-build

# Test
make mina-test

# Deploy (DEPLOYER_KEY is required)
make mina-deploy-devnet DEPLOYER_KEY=<base58-private-key>
```
