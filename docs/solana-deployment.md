# Solana Payment Channel Program -- Devnet Deployment & Operations Guide

This guide covers deploying the Solana payment channel program to devnet, configuring the `SolanaPaymentChannelProvider` in the connector, and operating payment channels in a test environment.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Deployment](#deployment)
  - [Build the Program](#build-the-program)
  - [Deploy to Devnet](#deploy-to-devnet)
  - [Deployment Cost Estimates](#deployment-cost-estimates)
  - [Verify Deployment](#verify-deployment)
- [Configuration](#configuration)
  - [SolanaProviderConfig Fields](#solanaproviderconfig-fields)
  - [Connector YAML Configuration Example](#connector-yaml-configuration-example)
  - [Per-Peer Chain Reference](#per-peer-chain-reference)
- [Deposit Management](#deposit-management)
  - [Opening a Channel](#opening-a-channel)
  - [Funding a Channel Vault](#funding-a-channel-vault)
  - [Verifying Deposits On-Chain](#verifying-deposits-on-chain)
- [Upgrade Runbook](#upgrade-runbook)
  - [Building a New Binary](#building-a-new-binary)
  - [Deploying an Upgrade](#deploying-an-upgrade)
  - [Upgrade Authority Management](#upgrade-authority-management)
  - [Rollback Process](#rollback-process)
- [Monitoring Guide](#monitoring-guide)
  - [Channel Health Monitoring](#channel-health-monitoring)
  - [Stuck Channel Detection](#stuck-channel-detection)
  - [RPC-Based Monitoring](#rpc-based-monitoring)
  - [SDK-Based Monitoring](#sdk-based-monitoring)
- [Rent Economics](#rent-economics)
- [Devnet Endpoints Reference](#devnet-endpoints-reference)

---

## Prerequisites

Before deploying the Solana payment channel program, ensure the following are in place:

1. **Solana CLI >= 3.1.12** -- install from <https://docs.solanalabs.com/cli/install>

   ```bash
   solana --version
   ```

2. **Rust toolchain with BPF target** -- required for `cargo build-sbf`

   ```bash
   rustup show
   ```

3. **Funded deployer keypair** -- generate and fund on devnet:

   ```bash
   # Generate a new keypair (if needed)
   solana-keygen new -o ~/.config/solana/deployer.json

   # Airdrop devnet SOL (rate-limited to ~5 SOL/hr)
   solana airdrop 5 --url devnet --keypair ~/.config/solana/deployer.json
   ```

4. **Program source** -- the Rust program at `packages/solana-program/` must compile:
   ```bash
   cd packages/solana-program && cargo build-sbf
   ```

---

## Deployment

### Build the Program

```bash
# Using Makefile
make solana-build

# Or directly
cd packages/solana-program && cargo build-sbf
```

This produces the compiled BPF binary at `packages/solana-program/target/deploy/payment_channel.so` (~95KB).

### Deploy to Devnet

**Using the Makefile target:**

```bash
make solana-deploy-devnet DEPLOYER_KEYPAIR=~/.config/solana/deployer.json
```

**Using the deploy script directly (with upgrade authority transfer):**

```bash
./tools/solana/deploy.sh \
  --network devnet \
  --keypair ~/.config/solana/deployer.json \
  --upgrade-authority authority.json
```

**Upgrading an existing deployment:**

```bash
./tools/solana/deploy.sh \
  --network devnet \
  --keypair ~/.config/solana/deployer.json \
  --program-id <EXISTING_PROGRAM_PUBKEY>
```

The deploy script (`tools/solana/deploy.sh`) performs the following steps:

1. Validates arguments and checks Solana CLI installation
2. Checks deployer balance
3. Requires explicit "yes" confirmation for mainnet-beta
4. Builds the program via `cargo build-sbf`
5. Deploys via `solana program deploy` with `--output json`
6. Optionally transfers upgrade authority (if `--upgrade-authority` is provided)
7. Saves program ID and metadata to `tools/solana/program-id.json`
8. Verifies deployment via `solana program show`

### Deployment Cost Estimates

| Item                         | Approximate Cost    | Notes                                                |
| ---------------------------- | ------------------- | ---------------------------------------------------- |
| Program account rent         | ~0.21--0.42 SOL     | Refundable rent-exempt deposit for ~95KB binary      |
| Channel PDA rent             | ~0.00203 SOL        | Per channel account (~256 bytes)                     |
| Token vault rent             | ~0.00204 SOL        | Per vault account (~165 bytes for SPL Token account) |
| **Total initial deployment** | **~0.21--0.42 SOL** | Program rent only; channels created later            |

On devnet, SOL is free via airdrop:

```bash
solana airdrop 5 --url devnet
```

The airdrop is rate-limited to approximately 5 SOL per hour.

### Verify Deployment

After deployment, verify the program is on-chain:

```bash
solana program show <PROGRAM_ID> --url devnet
```

The program ID is recorded in `tools/solana/program-id.json` with the following schema:

```json
{
  "programId": "<base58-encoded program address>",
  "network": "devnet",
  "rpcUrl": "https://api.devnet.solana.com",
  "deployedAt": "2026-03-26T00:00:00Z",
  "deployerPubkey": "<deployer public key>",
  "binarySize": 95000
}
```

---

## Configuration

### SolanaProviderConfig Fields

The `SolanaProviderConfig` interface defines how the connector connects to the Solana payment channel program:

| Field       | Type       | Required | Description                                                                      |
| ----------- | ---------- | -------- | -------------------------------------------------------------------------------- |
| `chainType` | `'solana'` | Yes      | Discriminator for the Solana provider                                            |
| `rpcUrl`    | `string`   | Yes      | Solana cluster RPC endpoint (HTTP). Example: `https://api.devnet.solana.com`     |
| `wsUrl`     | `string`   | No       | WebSocket endpoint for account subscriptions. Derived from `rpcUrl` if omitted   |
| `programId` | `string`   | Yes      | Base58-encoded deployed program address (from `tools/solana/program-id.json`)    |
| `keyId`     | `string`   | Yes      | Key identifier for Ed25519 signing operations (references key management config) |
| `cluster`   | `string`   | No       | Solana cluster name: `'mainnet-beta'`, `'devnet'`, or `'testnet'`                |

### Connector YAML Configuration Example

Add a Solana provider to the connector's `chainProviders` array:

```yaml
nodeId: my-connector
btpServerPort: 3000

chainProviders:
  - chainType: solana
    chainId: 'solana:devnet'
    rpcUrl: 'https://api.devnet.solana.com'
    wsUrl: 'wss://api.devnet.solana.com'
    programId: '<DEPLOYED_PROGRAM_ID>' # From tools/solana/program-id.json
    keyId: 'solana-operator-key'
    cluster: 'devnet'

peers:
  - id: peer-solana
    url: wss://peer-solana:3001
    authToken: secret-solana
    chain: 'solana:devnet' # References chainProviders[].chainId

  - id: peer-evm
    url: wss://peer-evm:3002
    authToken: secret-evm
    chain: 'evm:8453' # EVM peer unchanged
```

### Per-Peer Chain Reference

Each peer's `chain` field references a registered provider's `chainId`. For Solana peers, set `chain` to the same value as the Solana provider's `chainId` (e.g., `"solana:devnet"`). This enables the `ChainProviderRegistry` to route settlement operations to the correct provider.

---

## Deposit Management

### Opening a Channel

Channels are opened programmatically through the `SolanaPaymentChannelProvider.openChannel()` method or directly via the Solana program. The channel state is stored in a Program Derived Address (PDA):

```
PDA seeds = [b"channel", participant_a, participant_b, token_mint]
```

Participants are sorted lexicographically to ensure deterministic PDA derivation regardless of who initiates the channel.

### Funding a Channel Vault

After opening a channel, fund the associated token vault:

1. **Identify the channel PDA** -- derived from the two participants' public keys and the token mint
2. **Transfer tokens** -- use the `deposit()` method on the SDK or provider:

   ```typescript
   // Using the SolanaPaymentChannelProvider
   await provider.deposit(channelId, amount.toString());
   ```

3. **Verify the deposit** -- check the on-chain channel state:

   ```bash
   solana account <CHANNEL_PDA> --url devnet --output json
   ```

### Verifying Deposits On-Chain

Use the Solana CLI to inspect channel state:

```bash
# Fetch raw account data
solana account <CHANNEL_PDA> --url devnet --output json

# Check the token vault balance
spl-token balance --address <VAULT_ACCOUNT> --url devnet
```

Or use the SDK programmatically:

```typescript
const state = await sdk.getChannelState(channelPDA);
logger.info(
  { depositA: state.depositA.toString(), depositB: state.depositB.toString() },
  'Channel deposits'
);
```

---

## Upgrade Runbook

### Building a New Binary

```bash
# Pull latest source changes
git pull origin epic-33

# Build the updated program
make solana-build
# Or: cd packages/solana-program && cargo build-sbf
```

Verify the binary at `packages/solana-program/target/deploy/payment_channel.so`.

### Deploying an Upgrade

To upgrade an existing program deployment, use the `--program-id` flag:

```bash
./tools/solana/deploy.sh \
  --network devnet \
  --keypair ~/.config/solana/deployer.json \
  --program-id <EXISTING_PROGRAM_PUBKEY>
```

Or via the Makefile:

```bash
make solana-deploy-devnet \
  DEPLOYER_KEYPAIR=~/.config/solana/deployer.json \
  PROGRAM_ID=<EXISTING_PROGRAM_PUBKEY>
```

The deployer keypair must match the current upgrade authority for the program.

### Upgrade Authority Management

**Initial state:** After first deployment, the upgrade authority defaults to the deployer keypair.

**Transfer authority to a designated keypair:**

```bash
# Option 1: During deployment
./tools/solana/deploy.sh \
  --network devnet \
  --keypair deployer.json \
  --upgrade-authority authority.json

# Option 2: Post-deployment
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <AUTHORITY_PUBKEY> \
  --keypair deployer.json \
  --url https://api.devnet.solana.com
```

**Verify the current upgrade authority:**

```bash
solana program show <PROGRAM_ID> --url devnet
```

**Make the program immutable (IRREVERSIBLE):**

```bash
solana program set-upgrade-authority <PROGRAM_ID> \
  --final \
  --keypair <CURRENT_AUTHORITY_KEYPAIR> \
  --url https://api.devnet.solana.com
```

> **WARNING:** The `--final` flag is irreversible. Once set, the program can never be upgraded again. Do not use this on devnet unless you intentionally want to freeze the program. For production (mainnet-beta), consider multi-sig upgrade authority via Squads Protocol before making the program immutable.

### Rollback Process

If an upgrade causes issues:

1. **Rebuild the previous version:**

   ```bash
   git checkout <PREVIOUS_COMMIT>
   cd packages/solana-program && cargo build-sbf
   ```

2. **Redeploy the previous binary:**

   ```bash
   ./tools/solana/deploy.sh \
     --network devnet \
     --keypair deployer.json \
     --program-id <PROGRAM_ID>
   ```

3. **Verify rollback:**
   ```bash
   solana program show <PROGRAM_ID> --url devnet
   ```

> **Note:** Rollback is only possible if the program is still upgradeable (not marked `--final`).

---

## Monitoring Guide

### Channel Health Monitoring

Monitor the health of payment channels by tracking state transitions and detecting anomalies.

**Channel states:**

| State   | Value | Description                                        |
| ------- | ----- | -------------------------------------------------- |
| Opened  | 0     | Channel is active and accepting deposits/claims    |
| Closed  | 1     | Channel close initiated; challenge period running  |
| Settled | 2     | Channel settled; funds distributed to participants |

### Stuck Channel Detection

A "stuck channel" is one in the `Closed` state that has passed its challenge period (`close_timestamp + challenge_duration`) but has not transitioned to `Settled`. This indicates the settlement transaction was not submitted.

**Detection logic:**

```
if channel.state == Closed
   AND current_time > channel.close_timestamp + channel.challenge_duration
then ALERT: stuck channel detected
```

**Alert threshold:** challenge_duration + 5 minutes grace period.

### RPC-Based Monitoring

```bash
# Check program deployment status
solana program show <PROGRAM_ID> --url devnet

# Fetch channel account data
solana account <CHANNEL_PDA> --url devnet --output json

# Check deployer/operator balance
solana balance <OPERATOR_PUBKEY> --url devnet
```

### SDK-Based Monitoring

Use the `SolanaPaymentChannelSDK` to subscribe to real-time channel state changes:

```typescript
import { SolanaPaymentChannelSDK } from './settlement/solana-payment-channel-sdk';

// Subscribe to channel state changes via onAccountChange
const subscription = sdk.subscribeToChannel(channelPDA, (state) => {
  logger.info({ channelPDA, state: state.state }, 'Channel state changed');

  if (state.state === 'closed') {
    const deadline = state.closeTimestamp + state.challengeDuration;
    if (BigInt(Math.floor(Date.now() / 1000)) > deadline) {
      logger.warn({ channelPDA, deadline: deadline.toString() }, 'Stuck channel detected');
    }
  }
});
```

**Periodic polling alternative:**

```typescript
// Poll channel state every 30 seconds
setInterval(async () => {
  const state = await sdk.getChannelState(channelPDA);
  if (state.state === 'closed') {
    const deadline = state.closeTimestamp + state.challengeDuration;
    if (BigInt(Math.floor(Date.now() / 1000)) > deadline) {
      logger.warn({ channelPDA }, 'Stuck channel -- needs settlement');
    }
  }
}, 30_000);
```

---

## Rent Economics

Solana uses rent-exempt deposits for on-chain accounts. All rent is refundable when the account is closed.

| Account Type      | Size       | Approximate Rent | Notes                                |
| ----------------- | ---------- | ---------------- | ------------------------------------ |
| Program account   | ~95KB      | ~0.21--0.42 SOL  | One-time deployment cost             |
| Channel PDA       | ~256 bytes | ~0.00203 SOL     | Per channel                          |
| Token vault (SPL) | ~165 bytes | ~0.00204 SOL     | Per vault (associated token account) |

**Rent reclamation:**

- Channel PDA rent is reclaimable when the channel is settled (state transitions to `Settled` and the account is closed)
- Token vault rent is reclaimable when the vault is closed after settlement
- Program account rent is reclaimable if the program is closed (requires upgrade authority; closing removes the program permanently)

---

## Devnet Endpoints Reference

| Resource  | URL                                                             |
| --------- | --------------------------------------------------------------- |
| JSON-RPC  | `https://api.devnet.solana.com`                                 |
| WebSocket | `wss://api.devnet.solana.com`                                   |
| Faucet    | `solana airdrop <amount> --url devnet` (rate-limited ~5 SOL/hr) |
| Explorer  | `https://explorer.solana.com/?cluster=devnet`                   |

### Channel State Account Layout

For reference, the on-chain channel state account has the following layout:

```
participant_a:        Pubkey (32 bytes)
participant_b:        Pubkey (32 bytes)
token_mint:           Pubkey (32 bytes)
deposit_a:            u64
deposit_b:            u64
transferred_amount_a: u64 (cumulative A->B)
transferred_amount_b: u64 (cumulative B->A)
nonce_a:              u64
nonce_b:              u64
state:                u8 (0=Opened, 1=Closed, 2=Settled)
close_timestamp:      i64
challenge_duration:   u64 (seconds)
bump:                 u8 (PDA bump seed)
```

PDA derivation: `seeds = [b"channel", participant_a, participant_b, token_mint]` (participants sorted lexicographically).
