# XRP Payment Channels Setup Guide

This guide explains how to set up and use XRP Ledger payment channels with the M2M connector for settlement operations.

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Local Development Setup](#local-development-setup)
4. [XRP Ledger Account Creation](#xrp-ledger-account-creation)
5. [Environment Configuration](#environment-configuration)
6. [Using XRPLClient](#using-xrplclient)
7. [Payment Channel Operations](#payment-channel-operations)
8. [Error Handling](#error-handling)
9. [Security Best Practices](#security-best-practices)
10. [Troubleshooting](#troubleshooting)

## Overview

XRP Ledger payment channels provide a high-throughput, low-latency settlement mechanism for ILP connectors. This implementation uses the [xrpl.js](https://js.xrpl.org/) library wrapped in a custom `XRPLClient` class.

**Key Features:**

- Automatic connection management with exponential backoff
- Comprehensive error handling and logging
- Support for local rippled (development) and mainnet (production)
- Type-safe operations with TypeScript

## Prerequisites

- Node.js 20.11.0 LTS or higher
- Docker and Docker Compose (for local rippled)
- XRP Ledger account with funded balance
- Basic understanding of XRP Ledger concepts (accounts, transactions, payment channels)

## Local Development Setup

### Starting Local Rippled

The M2M project includes a local rippled instance for development (from Epic 7):

```bash
# Start rippled in standalone mode
docker-compose -f docker-compose-dev.yml up rippled

# Check rippled is running
curl -X POST http://localhost:5005 \\
  -H 'Content-Type: application/json' \\
  -d '{"method": "server_info"}'
```

**Local Rippled Details:**

- WebSocket URL: `ws://localhost:6006`
- JSON-RPC URL: `http://localhost:5005`
- Mode: Standalone (instant finality, no consensus delay)
- Genesis account pre-funded with XRP

### Verifying Rippled Connection

```typescript
import { XRPLClient, XRPLClientConfig } from '@m2m/connector';
import pino from 'pino';

const config: XRPLClientConfig = {
  wssUrl: 'ws://localhost:6006',
  accountSecret: 'YOUR_ACCOUNT_SECRET',
  accountAddress: 'YOUR_ACCOUNT_ADDRESS',
};

const logger = pino();
const client = new XRPLClient(config, logger);

await client.connect();
console.log('Connected:', client.isConnected());
await client.disconnect();
```

## XRP Ledger Account Creation

### Using xrpl.js CLI

```bash
# Install xrpl.js globally
npm install -g xrpl

# Generate new wallet
node -e "const xrpl = require('xrpl'); const wallet = xrpl.Wallet.generate(); console.log('Address:', wallet.address); console.log('Secret:', wallet.seed);"
```

**Output Example:**

```
Address: rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW
Secret: sEdVxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Funding Your Account

**Testnet (for testing):**
Visit the [XRP Ledger Testnet Faucet](https://xrpl.org/xrp-testnet-faucet.html) and enter your address to receive test XRP.

**Mainnet (production):**
Transfer XRP from an exchange or another wallet. Minimum 10 XRP required for account reserve.

## Environment Configuration

### Environment Variables

Add the following to `packages/connector/.env`:

```bash
# XRP Ledger Configuration
XRPL_WSS_URL=ws://localhost:6006              # Local development
# XRPL_WSS_URL=wss://s.altnet.rippletest.net:51233  # Testnet
# XRPL_WSS_URL=wss://xrplcluster.com                # Mainnet

XRPL_ACCOUNT_SECRET=sEdVxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  # Your account secret
XRPL_ACCOUNT_ADDRESS=rN7n7otQDd6FczFgLdlqtyMVrn3HMfXEEW  # Your account address
```

### Configuration Options

```typescript
interface XRPLClientConfig {
  wssUrl: string; // WebSocket URL for rippled
  accountSecret: string; // Account secret (never hardcode!)
  accountAddress: string; // Account address (r-address)
  connectionTimeoutMs?: number; // Default: 10000ms
  autoReconnect?: boolean; // Default: true
  maxReconnectAttempts?: number; // Default: 5
}
```

## Using XRPLClient

### Basic Operations

```typescript
import { XRPLClient, XRPLClientConfig } from '@m2m/connector';
import pino from 'pino';

const config: XRPLClientConfig = {
  wssUrl: process.env.XRPL_WSS_URL!,
  accountSecret: process.env.XRPL_ACCOUNT_SECRET!,
  accountAddress: process.env.XRPL_ACCOUNT_ADDRESS!,
};

const logger = pino();
const client = new XRPLClient(config, logger);

// Connect to rippled
await client.connect();

// Query account information
const accountInfo = await client.getAccountInfo(config.accountAddress);
console.log('Balance:', accountInfo.balance, 'drops'); // 1 XRP = 1,000,000 drops
console.log('Sequence:', accountInfo.sequence);

// Submit a payment transaction
const paymentTx = {
  TransactionType: 'Payment',
  Account: config.accountAddress,
  Destination: 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY',
  Amount: '1000000', // 1 XRP in drops
};

const result = await client.submitAndWait(paymentTx);
console.log('Transaction hash:', result.hash);
console.log('Ledger index:', result.ledgerIndex);

// Disconnect when done
await client.disconnect();
```

## Payment Channel Operations

### Using PaymentChannelManager (Story 9.2)

The `PaymentChannelManager` class provides a high-level interface for managing XRP payment channels:

#### Creating a Payment Channel

```typescript
import { PaymentChannelManager } from '@m2m/connector';
import { XRPLClient } from '@m2m/connector';
import Database from 'better-sqlite3';
import pino from 'pino';

// Initialize dependencies
const logger = pino();
const config = {
  wssUrl: process.env.XRPL_WSS_URL!,
  accountSecret: process.env.XRPL_ACCOUNT_SECRET!,
  accountAddress: process.env.XRPL_ACCOUNT_ADDRESS!,
};

const xrplClient = new XRPLClient(config, logger);
await xrplClient.connect();

const db = new Database('./connector.db');
const manager = new PaymentChannelManager(xrplClient, db, logger);

// Create a payment channel
const destination = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY'; // Peer's XRP address
const amount = '1000000000'; // 1,000 XRP in drops
const settleDelay = 86400; // 24 hours in seconds

const channelId = await manager.createChannel(destination, amount, settleDelay);
console.log('Channel created:', channelId);

// Channel metadata automatically stored in database
```

#### Funding an Existing Channel

```typescript
// Add more XRP to an existing channel
const channelId = '0xABC123...'; // Channel ID from createChannel
const additionalAmount = '500000000'; // 500 XRP in drops

await manager.fundChannel(channelId, additionalAmount);
console.log('Channel funded with additional', additionalAmount, 'drops');
```

#### Querying Channel State

```typescript
// Get current channel state from ledger
const channelState = await manager.getChannelState(channelId);

console.log('Channel ID:', channelState.channelId);
console.log('Source account:', channelState.account);
console.log('Destination account:', channelState.destination);
console.log('Total amount:', channelState.amount, 'drops');
console.log('Amount claimed:', channelState.balance, 'drops');
console.log('Remaining:', BigInt(channelState.amount) - BigInt(channelState.balance), 'drops');
console.log('Settle delay:', channelState.settleDelay, 'seconds');
console.log('Status:', channelState.status); // 'open', 'closing', or 'closed'
```

#### Getting All Channels for a Peer

```typescript
// Query all channels to a specific peer
const peerAddress = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
const channelIds = await manager.getChannelsForPeer(peerAddress);

console.log('Channels to peer:', channelIds);
// Output: ['0xABC123...', '0xDEF456...']
```

### Off-Chain Claim Signing and Verification (Story 9.3)

The `ClaimSigner` class provides cryptographic operations for signing and verifying XRP payment channel claims off-chain:

#### Signing a Claim

```typescript
import { ClaimSigner } from '@m2m/connector';
import Database from 'better-sqlite3';
import pino from 'pino';

// Initialize ClaimSigner
const logger = pino();
const db = new Database('./connector.db');

// Optional: Use deterministic keypair from environment
// If XRPL_CLAIM_SIGNER_SEED is not set, a random keypair is generated
const seed = process.env.XRPL_CLAIM_SIGNER_SEED;
const signer = new ClaimSigner(db, logger, seed);

// Get public key (use this when creating the payment channel)
const publicKey = signer.getPublicKey();
console.log('Public key:', publicKey);
// Output: ED1234567890ABCDEF... (66 hex characters)

// Sign a claim
const channelId = '0xABC123...'; // Channel ID from PaymentChannelCreate
const amount = '5000000000'; // 5,000 XRP in drops (cumulative amount)

const signature = await signer.signClaim(channelId, amount);
console.log('Signature:', signature);
// Output: 6DD3BC7B59E3B923... (128 hex characters)

// Claim is automatically stored in database for dispute resolution
```

#### Verifying a Claim

```typescript
// Verify a claim signature (typically done by the channel recipient)
const isValid = await signer.verifyClaim(channelId, amount, signature, publicKey);

console.log('Claim valid:', isValid); // true or false

// Optional: Verify claim doesn't exceed channel balance
const channelAmount = '10000000000'; // Channel has 10,000 XRP
const isValidWithBalance = await signer.verifyClaim(
  channelId,
  amount,
  signature,
  publicKey,
  channelAmount
);

console.log('Claim valid and within balance:', isValidWithBalance);
```

#### Retrieving Latest Claim

```typescript
// Get the most recent claim for a channel
const latestClaim = await signer.getLatestClaim(channelId);

if (latestClaim) {
  console.log('Latest claim:');
  console.log('  Channel ID:', latestClaim.channelId);
  console.log('  Amount:', latestClaim.amount, 'drops');
  console.log('  Signature:', latestClaim.signature);
  console.log('  Public key:', latestClaim.publicKey);
  console.log('  Created at:', latestClaim.createdAt);
} else {
  console.log('No claims exist for this channel');
}
```

#### Claim Message Format

Claims follow the XRP Ledger specification for payment channel claims:

```
Bytes 0-3:   Prefix "CLM\0" (0x434C4D00 in hex)
Bytes 4-35:  Channel ID (32 bytes, from transaction hash)
Bytes 36-43: Amount (8 bytes, uint64 big-endian, XRP drops)
```

The `ClaimSigner` automatically constructs this message format using `xrpl.js` functions (`signPaymentChannelClaim` and `verifyPaymentChannelClaim`).

#### Monotonic Claim Amounts

Claims must have strictly increasing amounts to prevent replay attacks:

```typescript
// Create first claim
await signer.signClaim(channelId, '1000000000'); // 1,000 XRP - OK

// Create second claim (higher amount)
await signer.signClaim(channelId, '2000000000'); // 2,000 XRP - OK

// Try to create claim with lower amount
try {
  await signer.signClaim(channelId, '1500000000'); // 1,500 XRP - FAIL
} catch (error) {
  console.error('Error:', error.message);
  // Output: Claim amount must be greater than previous claim: 1500000000 <= 2000000000
}
```

#### Environment Variables

**XRPL_CLAIM_SIGNER_SEED** (optional):

- Purpose: Deterministic ed25519 keypair for ClaimSigner
- Format: XRP Ledger seed format (e.g., `sEdV...`)
- Default: Random keypair generated via `Wallet.generate()` if not provided
- Use cases:
  - Testing with reproducible keys
  - Production key management with deterministic recovery

**Example `.env`:**

```bash
XRPL_CLAIM_SIGNER_SEED=sEdTM1uX8pu2do5XvTnutH6HsouMaM2
```

#### Database Schema for Claims

ClaimSigner stores signed claims in SQLite for dispute resolution:

```sql
CREATE TABLE xrp_claims (
  claim_id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,              -- References xrp_channels.channel_id
  amount TEXT NOT NULL,                  -- XRP in drops (string for bigint)
  signature TEXT NOT NULL,               -- Hex-encoded ed25519 signature
  public_key TEXT NOT NULL,              -- ed25519 public key (66 hex chars)
  created_at INTEGER NOT NULL,           -- Unix timestamp
  FOREIGN KEY (channel_id) REFERENCES xrp_channels(channel_id)
);

-- Index for channel lookup (get latest claim for channel)
CREATE INDEX idx_xrp_claims_channel
  ON xrp_claims(channel_id, created_at DESC);

-- Unique constraint: prevent duplicate claims with same amount
CREATE UNIQUE INDEX idx_xrp_claims_unique
  ON xrp_claims(channel_id, amount);
```

### Claim Submission and Settlement (Story 9.4)

The `XRPLClient` and `PaymentChannelManager` support submitting signed claims to the XRP Ledger for settlement:

#### Submitting a Claim (Partial Claim)

```typescript
import { XRPLClient, PaymentChannelManager, ClaimSigner } from '@m2m/connector';
import Database from 'better-sqlite3';
import pino from 'pino';

// Initialize components
const logger = pino();
const config = {
  wssUrl: process.env.XRPL_WSS_URL!,
  accountSecret: process.env.XRPL_ACCOUNT_SECRET!,
  accountAddress: process.env.XRPL_ACCOUNT_ADDRESS!,
};

const xrplClient = new XRPLClient(config, logger);
await xrplClient.connect();

const db = new Database('./connector.db');
const manager = new PaymentChannelManager(xrplClient, db, logger);
const signer = new ClaimSigner(db, logger);

// Scenario: Receive a signed claim from peer and submit to ledger

// 1. Create payment channel (channel creator)
const destination = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
const channelAmount = '10000000000'; // 10,000 XRP
const settleDelay = 86400; // 24 hours

const channelId = await manager.createChannel(destination, channelAmount, settleDelay);
console.log('Channel created:', channelId);

// 2. Sign claim (channel creator signs claim authorizing peer to redeem XRP)
const claimAmount = '5000000000'; // 5,000 XRP (partial claim)
const signature = await signer.signClaim(channelId, claimAmount);
const publicKey = signer.getPublicKey();

// 3. Peer receives claim off-chain and submits to ledger
// Note: Peer must switch to their wallet to submit the claim
const result = await xrplClient.submitClaim(channelId, claimAmount, signature, publicKey);

console.log('Claim submitted:', result.hash);
console.log('Ledger index:', result.ledgerIndex);

// 4. Verify XRP transferred
const channelState = await manager.getChannelState(channelId);
console.log('Channel balance (claimed):', channelState.balance, 'drops'); // 5,000 XRP
console.log('Channel status:', channelState.status); // 'open' (partial claim)
console.log('Remaining balance:', BigInt(channelState.amount) - BigInt(channelState.balance)); // 5,000 XRP
```

#### Submitting a Final Claim (Close Channel)

```typescript
// Submit final claim and close the channel

// 1. Sign final claim (full remaining balance)
const finalAmount = channelAmount; // Full 10,000 XRP
const finalSignature = await signer.signClaim(channelId, finalAmount);

// 2. Submit claim with close flag
const result = await xrplClient.submitClaim(
  channelId,
  finalAmount,
  finalSignature,
  publicKey,
  true // closeAfterClaim flag
);

console.log('Final claim submitted:', result.hash);

// Channel enters "closing" state
// After settleDelay seconds, channel will be fully closed and removed from ledger
```

#### Using PaymentChannelManager for Claim Submission

```typescript
// High-level wrapper around XRPLClient.submitClaim()
// Automatically updates channel balance in database

const result = await manager.submitClaim(channelId, claimAmount, signature, publicKey);

console.log('Claim submitted and database updated:', result.hash);

// Channel balance in database automatically synchronized with on-ledger state
const channelState = await manager.getChannelState(channelId);
console.log('Updated balance:', channelState.balance);
```

#### Cooperative Channel Closure

```typescript
// Close channel without submitting a claim
// Useful when no XRP needs to be redeemed

await manager.closeChannel(channelId);
console.log('Channel closure initiated');

// Channel enters "closing" state
// After settleDelay period, channel finalizes and closes
```

#### Cancelling Channel Closure

```typescript
// Abort closure during settlement delay period

// 1. Initiate closure
await xrplClient.closeChannel(channelId);
console.log('Channel closure initiated');

// 2. Cancel closure before settlement delay expires
const result = await xrplClient.cancelChannelClose(channelId);
console.log('Channel closure cancelled:', result.hash);

// Channel returns to "open" state
```

#### Channel Lifecycle State Machine

```
┌──────────┐
│   Open   │ ◄──→ signClaim() off-chain (cooperative settlement)
└────┬─────┘
     │ closeChannel() or submitClaim(..., true)
     ▼
┌──────────┐
│ Closing  │ ──→ Settlement delay period (e.g., 24 hours)
└────┬─────┘      cancelChannelClose() can abort during this period
     │ SettleDelay elapsed
     ▼
┌──────────┐
│  Closed  │ ──→ Channel removed from ledger, final balances distributed
└──────────┘

States:
- Open: Channel active, can process claims and transfers
- Closing: Close initiated, waiting for settlement delay
- Closed: Channel finalized and removed from ledger
```

#### Claim Submission Workflow

```
Channel Creator (Source)                     Channel Recipient (Destination)
        │                                              │
        ├─1. Create channel ───────────────────────►  │
        │   PaymentChannelCreate transaction          │
        │                                              │
        ├─2. Sign claim off-chain ──────────────────► │
        │   signClaim(channelId, amount)              │
        │   Send signature to peer                    │
        │                                              │
        │                                              ├─3. Verify signature
        │                                              │   verifyClaim()
        │                                              │
        │                                              ├─4. Submit claim to ledger
        │                                              │   submitClaim(channelId, amount, signature, publicKey)
        │                                              │   PaymentChannelClaim transaction
        │                                              │
        │◄──────────────────────────────────────────┬ │
        │   XRP transferred from channel to peer    │
        │                                              │
        ├─5. Verify XRP transfer                      │
        │   getChannelState(channelId)                │
        │   Check balance updated                     │
```

#### Error Handling for Claim Submission

```typescript
import { XRPLError, XRPLErrorCode } from '@m2m/connector';

try {
  await xrplClient.submitClaim(channelId, amount, signature, publicKey);
} catch (error) {
  if (error instanceof XRPLError) {
    switch (error.code) {
      case XRPLErrorCode.INVALID_CHANNEL_SIGNATURE:
        console.error('Claim signature verification failed');
        // Signature invalid or public key mismatch
        break;
      case XRPLErrorCode.CHANNEL_AMOUNT_EXCEEDED:
        console.error('Claim amount exceeds channel balance');
        // Attempting to claim more than channel holds
        break;
      case XRPLErrorCode.CHANNEL_NOT_FOUND:
        console.error('Payment channel does not exist');
        // Channel ID invalid or channel already closed
        break;
      case XRPLErrorCode.TRANSACTION_FAILED:
        console.error('Transaction submission failed');
        // Network error or insufficient fees
        break;
      default:
        console.error('Unknown error:', error.message);
    }
  }
}
```

### Database Schema

The PaymentChannelManager stores channel metadata in SQLite:

```sql
CREATE TABLE xrp_channels (
  channel_id TEXT PRIMARY KEY,        -- Transaction hash (channel ID)
  account TEXT NOT NULL,              -- Source account (us)
  destination TEXT NOT NULL,          -- Destination account (peer)
  amount TEXT NOT NULL,               -- Total XRP in channel (drops)
  balance TEXT NOT NULL DEFAULT '0',  -- XRP claimed (drops)
  settle_delay INTEGER NOT NULL,      -- Settlement delay in seconds
  public_key TEXT NOT NULL,           -- ed25519 public key
  cancel_after INTEGER,               -- Optional: auto-expiration
  expiration INTEGER,                 -- Optional: close request time
  status TEXT NOT NULL DEFAULT 'open', -- Channel status
  created_at INTEGER NOT NULL,        -- Unix timestamp
  updated_at INTEGER NOT NULL DEFAULT 0
);
```

### Low-Level XRPLClient Operations

If you need direct control over transactions:

```typescript
const channelTx = {
  TransactionType: 'PaymentChannelCreate',
  Account: config.accountAddress,
  Destination: 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY',
  Amount: '100000000', // 100 XRP channel capacity
  SettleDelay: 86400, // 24 hours settlement delay
  PublicKey: 'ED...', // Your ed25519 public key for claim signatures
};

const result = await xrplClient.submitAndWait(channelTx);
const channelId = result.hash;
console.log('Channel created:', channelId);
```

## Error Handling

### Error Codes

```typescript
import { XRPLError, XRPLErrorCode } from '@m2m/connector';

try {
  await client.connect();
} catch (error) {
  if (error instanceof XRPLError) {
    switch (error.code) {
      case XRPLErrorCode.CONNECTION_FAILED:
        console.error('Cannot connect to rippled');
        break;
      case XRPLErrorCode.ACCOUNT_NOT_FOUND:
        console.error('Account does not exist on ledger');
        break;
      case XRPLErrorCode.INSUFFICIENT_FUNDS:
        console.error('Account balance too low');
        break;
      case XRPLErrorCode.TRANSACTION_FAILED:
        console.error('Transaction submission failed');
        break;
      default:
        console.error('Unknown error:', error.message);
    }
  }
}
```

### Automatic Reconnection

XRPLClient automatically reconnects on disconnection with exponential backoff:

```typescript
const config: XRPLClientConfig = {
  wssUrl: 'ws://localhost:6006',
  accountSecret: '...',
  accountAddress: '...',
  autoReconnect: true,
  maxReconnectAttempts: 5,
};

// Client will automatically reconnect if WebSocket drops
```

## Security Best Practices

### Secret Management

**NEVER hardcode secrets in source code:**

```typescript
// ❌ BAD - Secret hardcoded
const config = {
  accountSecret: 'sEdVxxxxx...', // NEVER do this!
};

// ✅ GOOD - Secret from environment variable
const config = {
  accountSecret: process.env.XRPL_ACCOUNT_SECRET!,
};
```

### Environment Files

**NEVER commit `.env` files with real secrets:**

```bash
# .gitignore
.env
.env.local
.env.production
```

**Use `.env.example` for templates:**

```bash
# .env.example (safe to commit)
XRPL_ACCOUNT_SECRET=sEdVxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Production Deployment

- Use secrets management services (AWS Secrets Manager, HashiCorp Vault)
- Rotate secrets regularly
- Use separate accounts for development, testing, and production
- Monitor account balances and set up alerts

## Troubleshooting

### Connection Issues

**Problem:** `CONNECTION_FAILED` error

**Solutions:**

- Verify rippled is running: `docker ps | grep rippled`
- Check WebSocket URL is correct
- Ensure firewall allows WebSocket connections
- Check rippled logs: `docker logs rippled`

### Account Not Found

**Problem:** `ACCOUNT_NOT_FOUND` error

**Solutions:**

- Verify account address is correct
- Ensure account is funded (minimum 10 XRP reserve)
- Check you're connected to the correct network (local/testnet/mainnet)

### Insufficient Funds

**Problem:** `INSUFFICIENT_FUNDS` error

**Solutions:**

- Check account balance: `client.getAccountInfo(address)`
- Account must maintain minimum 10 XRP reserve
- Each owned object (channel, escrow) requires additional 2 XRP reserve

### Transaction Failures

**Problem:** Transaction submitted but failed

**Solutions:**

- Check transaction result codes in `result.result.meta`
- Verify account sequence number is correct
- Ensure sufficient XRP for transaction fees (~0.00001 XRP)
- Check destination account exists (for Payment transactions)

### Integration Test Failures

**Problem:** Integration tests fail

**Solutions:**

- Ensure rippled is running: `docker-compose -f docker-compose-dev.yml up rippled`
- Verify test account is funded
- Check environment variables are set correctly
- Review test logs for specific error codes

### Claim Signature Verification Errors

**Problem:** `verifyClaim()` returns `false`

**Solutions:**

- Verify the channel ID is exactly 64 hex characters
- Ensure the signature is exactly 128 hex characters
- Check the public key starts with 'ED' and is 66 hex characters total
- Confirm the amount matches exactly what was signed (including drops precision)
- Ensure you're using the same public key that signed the claim
- Check claim amount doesn't exceed channel balance (if channelAmount parameter provided)

**Problem:** Monotonic claim amount error

**Solutions:**

- Query the latest claim first: `signer.getLatestClaim(channelId)`
- Ensure new claim amount is strictly greater than previous claim
- Remember: claims are cumulative (e.g., 1000 → 1500 → 2000 drops, not separate amounts)

### Claim Submission Errors

**Problem:** `INVALID_CHANNEL_SIGNATURE` error during submitClaim()

**Solutions:**

- Verify signature format is exactly 128 hex characters
- Ensure public key matches the one used when creating the channel
- Confirm the claim was signed with the correct channel ID
- Check amount in drops matches exactly what was signed
- Use `verifyClaim()` to test signature validity before submission

**Problem:** Claim submission fails with `CHANNEL_NOT_FOUND`

**Solutions:**

- Verify channel ID is valid (64 hex characters)
- Check channel exists: `manager.getChannelState(channelId)`
- Ensure channel hasn't already been closed
- Confirm you're connected to the correct network (local/testnet/mainnet)

**Problem:** Channel closure cannot be cancelled

**Solutions:**

- Verify settlement delay hasn't expired yet
- Check channel is in "closing" state (not "closed")
- Ensure you're using the correct channel ID
- Confirm you have sufficient XRP for transaction fees

## Additional Resources

- [XRP Ledger Documentation](https://xrpl.org/)
- [xrpl.js Documentation](https://js.xrpl.org/)
- [Payment Channels Tutorial](https://xrpl.org/payment-channels.html)
- [Transaction Types Reference](https://xrpl.org/transaction-types.html)
- [Error Codes](https://xrpl.org/tec-codes.html)

### Dual-Settlement Configuration (Story 9.5)

The M2M connector supports **dual-settlement**: routing settlements to either EVM payment channels or XRP payment channels based on peer configuration and token type.

#### UnifiedSettlementExecutor Overview

The `UnifiedSettlementExecutor` class orchestrates settlement routing:

- **EVM Settlement:** Routes ERC20 token settlements to PaymentChannelSDK (Epic 8)
- **XRP Settlement:** Routes XRP token settlements to PaymentChannelManager (Epic 9)
- **Automatic Routing:** Selects settlement method based on peer preferences

#### Peer Configuration

Configure peers with settlement preferences:

```typescript
import { UnifiedSettlementExecutor, PeerConfig } from '@m2m/connector';

const peerConfig: PeerConfig = {
  peerId: 'peer-alice',
  ilpAddress: 'g.alice.connector',

  // Settlement preference: 'evm' | 'xrp' | 'both'
  settlementPreference: 'both', // Support both EVM and XRP

  // Supported token list (ordered by preference)
  settlementTokens: ['XRP', 'USDC', 'DAI'],

  // EVM address (required if settlementPreference includes 'evm')
  evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0',

  // XRP Ledger address (required if settlementPreference includes 'xrp')
  xrpAddress: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',

  // Settlement thresholds
  settlementThreshold: 1000000000n, // 1000 XRP in drops
  settlementInterval: 3600000, // 1 hour in milliseconds
};
```

#### Settlement Routing Logic

```typescript
// Settlement routing based on token type

// XRP token + peer supports XRP → XRP settlement via PaymentChannelManager
if (
  tokenId === 'XRP' &&
  (peer.settlementPreference === 'xrp' || peer.settlementPreference === 'both')
) {
  await settleViaXRP(peerId, amount, peer.xrpAddress);
}

// ERC20 token + peer supports EVM → EVM settlement via PaymentChannelSDK
else if (
  tokenId !== 'XRP' &&
  (peer.settlementPreference === 'evm' || peer.settlementPreference === 'both')
) {
  await settleViaEVM(peerId, amount, tokenAddress, peer.evmAddress);
}

// Incompatible combination → Error
else {
  throw new Error(`No compatible settlement method for peer ${peerId} with token ${tokenId}`);
}
```

#### Example: Dual-Settlement Configuration

```typescript
// Initialize UnifiedSettlementExecutor
const config: UnifiedSettlementExecutorConfig = {
  peers: new Map([
    // Peer 1: XRP-only settlement
    [
      'peer-xrp-only',
      {
        peerId: 'peer-xrp-only',
        ilpAddress: 'g.peer1.connector',
        settlementPreference: 'xrp',
        settlementTokens: ['XRP'],
        xrpAddress: 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY',
        settlementThreshold: 500000000n, // 500 XRP
        settlementInterval: 3600000,
      },
    ],

    // Peer 2: EVM-only settlement
    [
      'peer-evm-only',
      {
        peerId: 'peer-evm-only',
        ilpAddress: 'g.peer2.connector',
        settlementPreference: 'evm',
        settlementTokens: ['USDC', 'DAI'],
        evmAddress: '0x123...',
        settlementThreshold: 1000000000n, // 1000 USDC
        settlementInterval: 3600000,
      },
    ],

    // Peer 3: Dual settlement support
    [
      'peer-dual',
      {
        peerId: 'peer-dual',
        ilpAddress: 'g.peer3.connector',
        settlementPreference: 'both',
        settlementTokens: ['XRP', 'USDC', 'DAI'], // Prefer XRP first
        evmAddress: '0x456...',
        xrpAddress: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
        settlementThreshold: 1000000000n,
        settlementInterval: 3600000,
      },
    ],
  ]),
};

const executor = new UnifiedSettlementExecutor(
  config,
  evmChannelSDK, // PaymentChannelSDK instance
  xrpChannelManager, // PaymentChannelManager instance
  xrpClaimSigner, // ClaimSigner instance
  settlementMonitor, // SettlementMonitor instance
  accountManager, // AccountManager instance
  logger
);

executor.start();
```

### XRP Channel SDK Usage (Story 9.6)

The `XRPChannelSDK` provides a high-level API for XRP payment channel management, consolidating XRPLClient, PaymentChannelManager, and ClaimSigner into a unified interface.

#### SDK Initialization

```typescript
import { XRPChannelSDK } from '@m2m/connector';

const sdk = new XRPChannelSDK(
  xrplClient, // XRPLClient instance
  channelManager, // PaymentChannelManager instance
  claimSigner, // ClaimSigner instance
  logger, // Pino logger
  telemetryEmitter // Optional: TelemetryEmitter for dashboard integration
);

// Start automatic channel refresh (polls ledger every 30s)
sdk.startAutoRefresh();
```

#### SDK Methods

**Open Channel:**

```typescript
// Open new XRP payment channel with peer
const channelId = await sdk.openChannel(
  'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY', // Destination address
  '10000000000', // 10,000 XRP in drops
  86400, // 24 hour settle delay
  'peer-alice' // Optional: peer ID for telemetry
);
```

**Sign Claim:**

```typescript
// Sign claim for off-chain settlement
const claim = await sdk.signClaim(
  channelId,
  '5000000000' // Cumulative 5,000 XRP claimed
);

// Claim object structure:
// {
//   channelId: string,
//   amount: string,
//   signature: string (128 hex chars),
//   publicKey: string (66 hex chars, starts with 'ED')
// }
```

**Verify Claim:**

```typescript
// Verify claim signature before submission
const isValid = await sdk.verifyClaim(claim);
if (!isValid) {
  throw new Error('Invalid claim signature');
}
```

**Submit Claim:**

```typescript
// Submit verified claim to ledger (redeems XRP)
await sdk.submitClaim(claim, 'peer-alice');
```

**Close Channel:**

```typescript
// Close channel cooperatively (enters settling period)
await sdk.closeChannel(channelId, 'peer-alice');
```

**Query Channel State:**

```typescript
// Get current channel state from ledger
const state = await sdk.getChannelState(channelId);

console.log('Channel ID:', state.channelId);
console.log('Account:', state.account);
console.log('Destination:', state.destination);
console.log('Amount:', state.amount, 'drops');
console.log('Balance:', state.balance, 'drops');
console.log('Remaining:', BigInt(state.amount) - BigInt(state.balance), 'drops');
console.log('Status:', state.status); // 'open', 'closing', or 'closed'
```

**Get All Channels:**

```typescript
// Query all channels for current account
const channelIds = await sdk.getMyChannels();
console.log('Found', channelIds.length, 'channels');
```

#### SDK Cleanup

```typescript
// Stop automatic refresh before disposal
sdk.stopAutoRefresh();
```

### Dashboard XRP Visualization (Story 9.7)

The M2M dashboard displays XRP payment channel activity with dedicated telemetry events and UI components.

#### Telemetry Events

The connector emits three XRP-specific telemetry events:

**XRP_CHANNEL_OPENED:**

```typescript
telemetryEmitter.emitXRPChannelOpened(channelState, peerId);
// Payload: { channelId, destination, amount, settleDelay, peerId }
```

**XRP_CHANNEL_CLAIMED:**

```typescript
telemetryEmitter.emitXRPChannelClaimed(channelId, claimAmount, remainingBalance, peerId);
// Payload: { channelId, claimAmount, remainingBalance, peerId }
```

**XRP_CHANNEL_CLOSED:**

```typescript
telemetryEmitter.emitXRPChannelClosed(channelId, finalBalance, reason, peerId);
// Payload: { channelId, finalBalance, reason ('cooperative' | 'unilateral'), peerId }
```

#### Dashboard UI Features

The dashboard displays XRP channels with:

- **Settlement Filter:** Filter channels by settlement type (EVM, XRP, or All)
- **XRP Badges:** Orange badges indicating XRP settlement
- **XRP Tooltips:** Hover tooltips showing XRP-specific details (drops, settle delay)
- **Channel Timeline:** Visual timeline of XRP channel lifecycle events

Access the dashboard at `http://localhost:3000` when running locally.

### Automated Lifecycle Management (Story 9.8)

The `XRPChannelLifecycleManager` automates XRP payment channel lifecycle management:

- **Automatic Channel Opening:** Creates channels when first settlement needed
- **Automatic Funding:** Adds XRP when channel balance falls below threshold
- **Idle Channel Detection:** Closes channels with no activity for configured duration
- **Expiration Handling:** Closes channels approaching CancelAfter timestamp

#### Lifecycle Configuration

```typescript
import { XRPChannelLifecycleManager, XRPChannelLifecycleConfig } from '@m2m/connector';

const config: XRPChannelLifecycleConfig = {
  enabled: true, // Enable lifecycle management
  initialChannelAmount: '10000000000', // 10,000 XRP initial channel amount
  defaultSettleDelay: 86400, // 24 hour settle delay
  idleChannelThreshold: 86400, // Close after 24 hours idle
  minBalanceThreshold: 0.3, // Fund when < 30% balance remaining
  cancelAfter: 2592000, // Auto-expire after 30 days
  peerId: 'peer-alice', // Peer ID for telemetry
};

const lifecycleManager = new XRPChannelLifecycleManager(
  config,
  xrpChannelSDK, // XRPChannelSDK instance
  logger
);

// Start lifecycle management
await lifecycleManager.start();
```

#### Lifecycle Methods

**Get or Create Channel:**

```typescript
// Gets existing channel or creates new one
const channelId = await lifecycleManager.getOrCreateChannel(
  'peer-alice',
  'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY' // Destination address
);
```

**Update Channel Activity:**

```typescript
// Update activity timestamp after claim submission (prevents idle closure)
lifecycleManager.updateChannelActivity('peer-alice', '5000000000');
```

**Check Funding Status:**

```typescript
// Check if channel needs funding
if (lifecycleManager.needsFunding('peer-alice')) {
  await lifecycleManager.fundChannel('peer-alice', '5000000000'); // Add 5,000 XRP
}
```

**Close Channel:**

```typescript
// Manually close channel
await lifecycleManager.closeChannel(
  'peer-alice',
  'manual' // Reason: 'idle' | 'expiration' | 'manual'
);
```

**Query Channel State:**

```typescript
// Get tracked channel state for peer
const channel = lifecycleManager.getChannelForPeer('peer-alice');
if (channel) {
  console.log('Channel ID:', channel.channelId);
  console.log('Status:', channel.status);
  console.log('Last activity:', new Date(channel.lastActivityAt));
}
```

#### Automatic Lifecycle Events

The lifecycle manager automatically:

1. **Idle Detection:** Every 1 hour, checks all channels for activity
2. **Auto-Closure:** Closes channels idle longer than `idleChannelThreshold`
3. **Expiration Handling:** Closes channels 1 hour before CancelAfter expiration
4. **Funding Checks:** Monitors channel balances and funds when below threshold

#### Cleanup

```typescript
// Stop lifecycle manager before shutdown
lifecycleManager.stop();
```

### Integration Testing (Story 9.9)

The M2M connector includes comprehensive integration tests for XRP settlement. Tests validate the complete XRP payment channel workflow against a local rippled instance.

#### Running Integration Tests

```bash
# Start local rippled
docker-compose -f docker-compose-dev.yml up rippled

# Run XRP integration tests
npm test --workspace=packages/connector -- xrp-settlement.test.ts

# Run specific test suites
npm test --workspace=packages/connector -- xrp-channel-lifecycle.test.ts
npm test --workspace=packages/connector -- xrp-channel-manager.test.ts
npm test --workspace=packages/connector -- xrp-claim-signer.test.ts
```

#### Test Coverage

Integration tests cover:

- **Happy Path:** Full channel lifecycle (open → claim → close)
- **Cooperative Closure:** Channel closure with settlement delay
- **Unilateral Closure:** Channel closure via claim submission
- **Dual-Settlement:** Routing between EVM and XRP based on token type
- **Error Handling:** Invalid signatures, insufficient funds, channel not found
- **Performance:** Claim signing (<10ms), verification (<5ms), channel creation (<10s)

#### Test Helpers

Use test helpers for XRP integration tests:

```typescript
import { XRPTestHelpers } from '@m2m/connector/test/helpers';

// Create funded test account
const testAccount = await XRPTestHelpers.createTestAccount(xrplClient, '100000000');

// Wait for ledger confirmation
await XRPTestHelpers.waitForLedgerConfirmation(xrplClient, txHash);

// Collect telemetry events
const events = XRPTestHelpers.collectTelemetryEvents(telemetryEmitter);
```

## Production Deployment

For production deployment guidance, see:

- [Production XRP Deployment Checklist](../deployment/production-xrp-checklist.md)
- [XRP Channel SDK API Reference](../api/xrp-channel-sdk.md)
- [Unified Settlement Executor API Reference](../api/unified-settlement-executor.md)

## Next Steps

- **Epic 9 Story 9.1 (✅ Complete):** XRPLClient integration with local rippled
- **Epic 9 Story 9.2 (✅ Complete):** PaymentChannelManager for channel creation and funding
- **Epic 9 Story 9.3 (✅ Complete):** ClaimSigner for off-chain claim signature generation and verification
- **Epic 9 Story 9.4 (✅ Complete):** XRP payment channel claim submission and settlement
- **Epic 9 Story 9.5 (✅ Complete):** Unified settlement executor supporting both EVM and XRP
- **Epic 9 Story 9.6 (✅ Complete):** XRP Channel SDK for high-level channel management
- **Epic 9 Story 9.7 (✅ Complete):** Dashboard XRP payment channel visualization
- **Epic 9 Story 9.8 (✅ Complete):** Automated XRP channel lifecycle management
- **Epic 9 Story 9.9 (✅ Complete):** XRP settlement integration testing and QA
- **Epic 9 Story 9.10 (In Progress):** XRP payment channel documentation and production deployment
