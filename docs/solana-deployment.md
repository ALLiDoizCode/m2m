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
- [Mainnet Deployment Runbook](#mainnet-deployment-runbook)
  - [Decisions to Record Before You Run the Deploy Command](#decisions-to-record-before-you-run-the-deploy-command)
  - [Flags and Environment Variables](#flags-and-environment-variables)
  - [The Deploy Command](#the-deploy-command)
  - [Expected Output](#expected-output)
  - [Post-Deploy Verification](#post-deploy-verification)
  - [What This Runbook Does Not Cover](#what-this-runbook-does-not-cover)
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
   cd packages/solana-program && cargo build-sbf --tools-version v1.52
   ```

---

## Deployment

### Build the Program

```bash
# Using Makefile
make solana-build

# Or directly
cd packages/solana-program && cargo build-sbf --tools-version v1.52
```

This produces the compiled BPF binary at `target/deploy/payment_channel.so` (size varies by build -- ~109KB for the current source; see [Deployment Cost Estimates](#deployment-cost-estimates) for the rent this implies) -- `packages/solana-program` is a member of the repository's root Cargo workspace, so build output lands in the workspace-root `target/`, not a per-crate one.

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
4. Builds the program via `cargo build-sbf --tools-version v1.52` (the pinned line every artifact statement is made about)
5. Deploys via `solana program deploy` with `--output json`
6. Optionally transfers upgrade authority (if `--upgrade-authority` is provided)
7. Saves program ID and metadata to `tools/solana/program-id.json`
8. Verifies deployment via `solana program show`

### Deployment Cost Estimates

Program account rent is a rent-exempt deposit sized to the deployed binary -- it is not a fixed
number, and should be recomputed whenever the binary size changes rather than re-guessed.
Solana's rent-exemption formula:

```
rent_lamports = (binary_bytes + 45-byte ProgramData header + 128-byte loader overhead) x 6,960
```

`6,960` lamports/byte is the 2-year rent-exemption rate (`3,480` lamports/byte-year, times two).

This reconciles exactly against our own measured public-devnet deploy
(`packages/solana-program/deployments/devnet-public.md`): its 105,128-byte binary cost

```
(105,128 + 45 + 128) x 6,960 = 732,894,960 lamports  (~0.733 SOL)
```

-- matching the `~0.733 SOL` recorded there for the same deploy.

`packages/solana-program/src` has since grown past that deploy (issue #581's claim/settlement
validation). Per the deployment record's provenance amendment, the current source builds to a
**109,401-byte** binary, which implies:

```
(109,401 + 45 + 128) x 6,960 = 762,635,040 lamports  (~0.76 SOL)
```

| Item                         | Approximate Cost | Notes                                                                                               |
| ---------------------------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| Program account rent         | ~0.76 SOL        | Rent-exempt deposit for the current ~109KB binary; recompute from the formula above if size changes |
| Channel PDA rent             | ~0.00203 SOL     | Per channel account (~256 bytes)                                                                    |
| Token vault rent             | ~0.00204 SOL     | Per vault account (~165 bytes for SPL Token account)                                                |
| **Total initial deployment** | **~0.76 SOL**    | Program rent only; channels created later                                                           |

**Upgrade headroom:** `solana program deploy` sizes the `ProgramData` account's `max_len` to
exactly the deployed binary -- there is no free headroom for a later upgrade to grow into. A
devnet deploy that allocates exactly the binary size (as ours did) means upgrading to a larger
binary requires `solana program extend <PROGRAM_ID> <ADDITIONAL_BYTES>` first, which charges rent
only on the size delta, not the full account.

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

The program ID is recorded in `tools/solana/program-id.json` with the following schema
(a mainnet-beta deploy writes the same schema to `tools/solana/program-id.mainnet.json`, a
separate file so neither record can clobber the other -- see the
[Mainnet Deployment Runbook](#mainnet-deployment-runbook)):

```json
{
  "programId": "<base58-encoded program address>",
  "network": "devnet",
  "rpcUrl": "https://api.devnet.solana.com",
  "deployedAt": "2026-03-26T00:00:00Z",
  "deployerPubkey": "<deployer public key>",
  "binarySize": 95000,
  "tokenMint": null,
  "maxLen": null
}
```

`tokenMint` and `maxLen` are `null` unless set: on devnet only when `--token-mint` /
`--max-len` are passed explicitly, on mainnet-beta `tokenMint` always (it defaults to
Circle's USDC mint) and `maxLen` on an initial deploy (it defaults to the binary size plus
headroom; an upgrade reuses the existing account's `max_len` and records `null`).

---

## Configuration

### SolanaProviderConfig Fields

The `SolanaProviderConfig` interface defines how the connector connects to the Solana payment channel program:

| Field       | Type       | Required | Description                                                                    |
| ----------- | ---------- | -------- | ------------------------------------------------------------------------------ |
| `chainType` | `'solana'` | Yes      | Discriminator for the Solana provider                                          |
| `rpcUrl`    | `string`   | Yes      | Solana cluster RPC endpoint (HTTP). Example: `https://api.devnet.solana.com`   |
| `wsUrl`     | `string`   | No       | WebSocket endpoint for account subscriptions. Derived from `rpcUrl` if omitted |
| `programId` | `string`   | Yes      | Base58-encoded deployed program address (from `tools/solana/program-id.json`)  |
| `keyId`     | `string`   | Yes\*    | Raw **base58 ed25519 secret key** (see "Settlement key contract" below)        |
| `cluster`   | `string`   | No       | Solana cluster name: `'mainnet-beta'`, `'devnet'`, or `'testnet'`              |
| `tokenMint` | `string`   | No       | Base58 SPL token mint address for the payment-channel token                    |

\* `keyId` is required unless the `SOLANA_PRIVATE_KEY` environment variable is set (see below).

### Settlement key (`keyId`) contract

The Solana `keyId` follows the same contract as the EVM `keyId`: it holds the **raw private key**, not a key-management identifier.

- **Format:** a base58-encoded **64-byte ed25519 secret key** (the full keypair, `seed || public_key`). A base58-encoded **32-byte private-key seed** is also accepted and expanded to a full keypair.
- **Environment fallback:** when `keyId` is omitted, the connector reads the key from the `SOLANA_PRIVATE_KEY` environment variable. If neither resolves, settlement bootstrap throws a descriptive error.
- **No file paths / no KMS reference:** unlike some Solana tooling, the connector does **not** read `~/.config/solana/id.json`-style keypair files here. Pass the decoded base58 string (e.g. `bs58.encode(Uint8Array.from(require('./id.json')))`).

#### Standalone Solana-only nodes (claim-driven redemption)

A node configured with **only** a Solana `chainProvider` (no EVM entry) is fully supported. On startup it boots the settlement stack — `ChainProviderRegistry`, `SettlementExecutor`, `ClaimReceiver`, and `SettlementMonitor` — and registers a `solana:<cluster>` provider. The EVM `PaymentChannelSDK` and `ChannelManager` stay `null`.

Non-EVM settlement is **claim-driven redemption**: the connector redeems verified claims against channels that were **opened out-of-band**. It does **not** open Solana channels on demand. Operators are responsible for opening and depositing into channels (see "Deposit Management"); the connector's role is to submit `claimFromChannel` transactions when a peer's credit balance crosses the settlement threshold.

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
    keyId: '<base58 ed25519 secret key>' # raw key; or set SOLANA_PRIVATE_KEY
    cluster: 'devnet'
    tokenMint: '<SPL_TOKEN_MINT>' # optional; defaults to the node settlement token

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

### Minimal Solana-only configuration

A standalone Solana-only node needs only the Solana `chainProvider`:

```yaml
nodeId: solana-node
btpServerPort: 3000
environment: development
deploymentMode: standalone

chainProviders:
  - chainType: solana
    chainId: 'solana:devnet'
    rpcUrl: 'https://api.devnet.solana.com'
    programId: '<DEPLOYED_PROGRAM_ID>'
    keyId: '<base58 ed25519 secret key>' # or set SOLANA_PRIVATE_KEY
    cluster: 'devnet'
    tokenMint: '<SPL_TOKEN_MINT>'

peers: [] # accepts inbound BTP; redeems claims against out-of-band channels
routes: []
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
# Or: cd packages/solana-program && cargo build-sbf --tools-version v1.52
```

Verify the binary at `target/deploy/payment_channel.so` (workspace-root `target/`, per the note above).

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
   cd packages/solana-program && cargo build-sbf --tools-version v1.52
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

## Mainnet Deployment Runbook

Everything above this section describes devnet, which every existing default in
`tools/solana/deploy.sh` still targets unchanged. This section is the mainnet-shaped
deploy path added by
[toon-protocol/connector#954](https://github.com/toon-protocol/connector/issues/954),
which is the no-broadcast majority of
[#834](https://github.com/toon-protocol/connector/issues/834) split out because steps
1 to 3 there -- the deploy path, the reproducibility check, and this runbook -- "move
no funds and touch no key," unlike step 4, the actual broadcast. **The broadcast
itself stays human-only on #834** -- nothing in this section is agent-triggered, and
running the command below against real mainnet-beta is a deliberate human action, not
something this repository or its CI ever does on its own.

Unlike Base mainnet (`packages/contracts/script/DeployMainnet.s.sol`), the
payment-channel program takes **no token address at deploy time at all** -- it is
mint-agnostic per channel: each channel names its own SPL mint when it is opened
later (`InitializeChannel`'s accounts, not the program's deploy). So "binding" Circle's
USDC mint here is a **recorded convention**, not an on-chain constraint the way
`TokenNetwork`'s constructor argument is on EVM: `--token-mint` (below) is written into
`tools/solana/program-id.mainnet.json` for operators to read, and nothing in
`tools/solana/deploy.sh` enforces it against any channel opened later. What mainnet
does forbid, structurally rather than by convention, is **creating** a mint from this
path: `deploy.sh` contains no `spl-token create-token`/`initialize_mint` call at all
(verify with `grep -i create-token tools/solana/deploy.sh` -- there is nothing to
find), and `infra/solana/create-usdc-mint.sh` (the devnet mock-USDC tool, driven by a
keypair committed to this repo) refuses outright when its RPC URL looks
mainnet-shaped.

Similarly: the Solana program enforces **no on-chain deposit or lifetime cap** --
unlike `TokenNetwork`'s `maxChannelDeposit`/`maxChannelLifetime` constructor
arguments, `Deposit` accepts any amount and `InitializeChannel` takes only a
`challenge_duration` (the close-challenge window, not a channel lifetime ceiling; see
`packages/solana-program/src/instruction.rs`). There is no deploy-time flag that could
cap either, because the deployed program has no such check to configure. The
conservative-default decision an EVM mainnet deploy makes once at deploy time is, on
Solana, an operator/connector-side decision made per channel (`challenge_duration`
at `InitializeChannel`) -- record it the same way you record the two decisions below,
but it is not a `deploy.sh` flag.

### Decisions to Record Before You Run the Deploy Command

`tools/solana/deploy.sh` will not run against `--network mainnet-beta` until both of
these are answered -- not defaulted into silently, and not something the script
decides for you.

1. **Upgrade authority custody.** After first deploy, the upgrade authority is
   whichever keypair you name. Live authority means the program stays fixable if a
   bug surfaces, but every counterparty can ask who holds it and what their key
   hygiene is; `--final` (see [Upgrade Authority
   Management](#upgrade-authority-management) above) means nothing to rug but nothing
   to fix, ever. This is an owner decision, not a default -- decide it, then pass:
   - `--upgrade-authority-decision deployer` -- the deployer keypair you already
     passed via `--keypair` keeps upgrade authority.
   - `--upgrade-authority-decision transfer --upgrade-authority <path>` -- upgrade
     authority moves to a different keypair as part of this same deploy.

   The decision and the flags must agree, both ways: `transfer` without
   `--upgrade-authority` is refused, and `deployer` **with** `--upgrade-authority` is
   refused too -- the script will not record one decision and act out the other.

   `--final` is deliberately **not** an option on `deploy.sh`, on any network: it is
   irreversible, so it stays the separate, explicit follow-up step documented in
   [Upgrade Authority Management](#upgrade-authority-management), run only once
   whoever holds authority has decided to freeze the program for good.

2. **`max_len` headroom.** The devnet deploy allocated `max_len` at exactly the
   binary size with no headroom (see [Deployment Cost
   Estimates](#deployment-cost-estimates)), so a later, larger binary needs
   `solana program extend` first. On a mainnet-beta **initial** deploy (no
   `--program-id`) with no explicit `--max-len`, `deploy.sh` allocates **+25%
   headroom over the built binary's size** automatically and prints exactly how many
   bytes and how much rent that costs before deploying. For the current ~109,416-byte
   binary this is `~27,354` bytes of headroom (`max_len` `~136,770`), costing
   `~190,383,840` lamports (`~0.19 SOL`) in additional rent-exempt deposit --
   **refundable** (see [Rent Economics](#rent-economics)), but real SOL escrowed
   upfront, which is why it is computed and printed rather than silently assumed. The
   trade-off: paying that ~0.19 SOL now avoids a separate `solana program extend`
   call later (roughly 0.14 SOL for a 105KB→125KB, 20KB delta -- see #834's own
   cost note) the next time the binary grows past `max_len`. Override with an
   explicit `--max-len <bytes>` if 25% is not the headroom you want; recompute the
   rent it implies with the formula in [Deployment Cost
   Estimates](#deployment-cost-estimates).

### Flags and Environment Variables

| Flag                           | Env fallback                 | Required on mainnet-beta                 | Default                                                                     |
| ------------------------------ | ---------------------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| `--network mainnet-beta`       | --                           | yes                                      | --                                                                          |
| `--keypair <path>`             | --                           | yes                                      | -- (must be funded; see [Cost](#deployment-cost-estimates) for how much)    |
| `--upgrade-authority-decision` | `UPGRADE_AUTHORITY_DECISION` | yes                                      | -- (refuses to run unset; `deployer` or `transfer`)                         |
| `--upgrade-authority <path>`   | --                           | only if the decision above is `transfer` | -- (deployer keypair retains authority)                                     |
| `--token-mint <pubkey>`        | `TOKEN_MINT`                 | no                                       | Circle's native USDC mint, `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`   |
| `--max-len <bytes>`            | `MAX_LEN`                    | no                                       | binary size + 25% headroom (initial deploys only; see above)                |
| `--program-id <pubkey>`        | --                           | no                                       | -- (omit for an initial deploy; set to upgrade an existing mainnet program) |

### The Deploy Command

The remaining human step, once both decisions above are recorded, is one command:

```bash
./tools/solana/deploy.sh \
  --network mainnet-beta \
  --keypair ~/.config/solana/mainnet-deployer.json \
  --upgrade-authority-decision transfer \
  --upgrade-authority ~/.config/solana/mainnet-authority.json
```

(Substitute `--upgrade-authority-decision deployer` with no `--upgrade-authority` if
the deployer keypair itself is the recorded choice. `--token-mint` and `--max-len`
only need to be passed explicitly if you are deliberately overriding either default
above.)

### Expected Output

Illustrative -- exact byte counts and pubkeys will differ per build/deploy:

```
No --token-mint given; defaulting to Circle's native USDC mint on Solana mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
============================================
Solana Payment Channel Program — Deployment
============================================

Network:            mainnet-beta
RPC URL:            https://api.mainnet-beta.solana.com
Deployer keypair:   /home/you/.config/solana/mainnet-deployer.json
Upgrade authority:  /home/you/.config/solana/mainnet-authority.json
Deployment type:    initial (new program)
Token mint:         EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (recorded only -- see header comment)
Authority decision: transfer

...
WARNING: You are about to deploy to MAINNET-BETA.
This will cost real SOL and the program will be publicly accessible.

Are you sure you want to continue? (yes/no): yes

Building program...
Build complete: .../target/deploy/payment_channel.so

Program binary size: 109416 bytes

No --max-len given; allocating +25% upgrade headroom:
  max_len:        136770 bytes (109416 binary + 27354 headroom)
  extra rent:     190383840 lamports for the headroom alone (refundable; see
                  docs/solana-deployment.md's rent-exemption formula)

Deploying to mainnet-beta...
...
Program deployed successfully!
Program ID: <PROGRAM_PUBKEY>

Setting upgrade authority to: <AUTHORITY_PUBKEY>
Upgrade authority set to: <AUTHORITY_PUBKEY>

Program ID saved to: tools/solana/program-id.mainnet.json

Verifying deployment...
<solana program show output>
```

### Post-Deploy Verification

```bash
solana program show <PROGRAM_ID> --url https://api.mainnet-beta.solana.com
```

confirms the program is executable, owned by `BPFLoaderUpgradeab1e...`, and shows the
upgrade authority you recorded above (or no authority at all, once and only once a
deliberate, separate `--final` step has been run). `tools/solana/program-id.mainnet.json`
records the program id, the token mint this deploy expects channels to settle in, the
binary size, and the `max_len` allocated -- keep it, and consider committing a
deployment record under `packages/solana-program/deployments/` mirroring
`devnet-public.md`'s format once the broadcast has happened.

### What This Runbook Does Not Cover

Per #954's own scope (and #834's, which stays open for exactly this): the actual
broadcast, a funded mainnet deployer keypair, and any transaction. Nothing above
performs any of those -- the command in [The Deploy Command](#the-deploy-command) is
the human-only step #834 remains gated on.

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

| Account Type      | Size                                                                                 | Approximate Rent | Notes                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------- |
| Program account   | ~109KB (current source; see [Deployment Cost Estimates](#deployment-cost-estimates)) | ~0.76 SOL        | One-time deployment cost; recompute via `(bytes + 45 + 128) * 6,960 lamports` if binary size changes |
| Channel PDA       | ~256 bytes                                                                           | ~0.00203 SOL     | Per channel                                                                                          |
| Token vault (SPL) | ~165 bytes                                                                           | ~0.00204 SOL     | Per vault (associated token account)                                                                 |

**Rent reclamation:**

- Channel PDA rent is reclaimable when the channel is settled (state transitions to `Settled` and the account is closed)
- Token vault rent is reclaimable when the vault is closed after settlement
- Program account rent is reclaimable if the program is closed (requires upgrade authority; closing removes the program permanently)
- Program account rent is NOT automatically increased on upgrade: the `ProgramData` account's
  `max_len` is fixed at first deploy, so growing the binary past that size requires
  `solana program extend` (rent charged on the size delta only) before the upgrade will fit

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
