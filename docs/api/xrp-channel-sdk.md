# XRPChannelSDK API Reference

## Overview

The `XRPChannelSDK` class provides a high-level API for XRP payment channel management. It consolidates XRPLClient, PaymentChannelManager, and ClaimSigner into a unified interface with automatic state caching and telemetry integration.

**Key Features:**

- Channel lifecycle operations (open, fund, close)
- Off-chain claim signing and verification
- On-ledger claim submission
- Local channel state caching with auto-refresh (30s interval)
- Telemetry event emission for dashboard integration

**Module:** `@m2m/connector/settlement/xrp-channel-sdk`

## Constructor

### `new XRPChannelSDK(xrplClient, channelManager, claimSigner, logger, telemetryEmitter?)`

Creates a new XRPChannelSDK instance.

**Parameters:**

- `xrplClient` **XRPLClient** - XRPL client for ledger interactions
- `channelManager` **PaymentChannelManager** - Payment channel manager (database + channel ops)
- `claimSigner` **ClaimSigner** - Claim signer for off-chain signatures
- `logger` **Logger** - Pino logger instance
- `telemetryEmitter?` **TelemetryEmitter** - Optional telemetry emitter for dashboard integration

**Example:**

```typescript
import { XRPChannelSDK } from '@m2m/connector';

const sdk = new XRPChannelSDK(
  xrplClient,
  channelManager,
  claimSigner,
  logger,
  telemetryEmitter // Optional
);
```

## Methods

### `openChannel(destination, amount, settleDelay, peerId?): Promise<string>`

Opens a new XRP payment channel with the specified destination address.

**Parameters:**

- `destination` **string** - Peer's XRP Ledger r-address
- `amount` **string** - Total XRP in channel (drops as string, 1 XRP = 1,000,000 drops)
- `settleDelay` **number** - Settlement delay in seconds (minimum 3600 for production)
- `peerId?` **string** - Optional peer identifier for telemetry events

**Returns:** `Promise<string>` - Channel ID (64-character hex string)

**Throws:**

- `XRPLError` - If transaction fails or account has insufficient funds

**Example:**

```typescript
const channelId = await sdk.openChannel(
  'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN', // Destination
  '10000000000', // 10,000 XRP in drops
  86400, // 24 hour settle delay
  'peer-alice' // Peer ID for telemetry
);

console.log('Channel opened:', channelId);
```

**Events Emitted:**

- `XRP_CHANNEL_OPENED` - Emitted when channel is successfully created

---

### `fundChannel(channelId, additionalAmount): Promise<void>`

Funds an existing channel with additional XRP.

**Parameters:**

- `channelId` **string** - Channel ID to fund (64-character hex)
- `additionalAmount` **string** - Additional XRP to deposit (drops)

**Returns:** `Promise<void>`

**Throws:**

- `XRPLError` - If channel not found or transaction fails

**Example:**

```typescript
await sdk.fundChannel(
  channelId,
  '5000000000' // Add 5,000 XRP
);

console.log('Channel funded');
```

---

### `signClaim(channelId, amount): Promise<XRPClaim>`

Signs a claim for off-chain settlement. Generates ed25519 signature and stores claim in database.

**Parameters:**

- `channelId` **string** - Channel ID to claim from
- `amount` **string** - Cumulative XRP to claim (drops)

**Returns:** `Promise<XRPClaim>` - XRPClaim object with signature

**XRPClaim Structure:**

```typescript
interface XRPClaim {
  channelId: string; // 64-char hex
  amount: string; // XRP drops (cumulative)
  signature: string; // 128-char hex (ed25519 signature)
  publicKey: string; // 66-char hex (starts with 'ED')
}
```

**Throws:**

- `Error` - If claim amount is not greater than previous claim (monotonic increase required)

**Example:**

```typescript
const claim = await sdk.signClaim(
  channelId,
  '5000000000' // Cumulative 5,000 XRP claimed
);

// Send claim to peer via BTP or other transport
console.log('Claim signature:', claim.signature);
```

---

### `verifyClaim(claim): Promise<boolean>`

Verifies the ed25519 signature of an XRP claim.

**Parameters:**

- `claim` **XRPClaim** - XRPClaim object to verify

**Returns:** `Promise<boolean>` - `true` if claim signature is valid

**Example:**

```typescript
const isValid = await sdk.verifyClaim(claim);

if (!isValid) {
  throw new Error('Invalid claim signature');
}
```

---

### `submitClaim(claim, peerId?): Promise<void>`

Submits a verified claim to the XRP Ledger to redeem XRP. Updates channel balance in database and cache.

**Parameters:**

- `claim` **XRPClaim** - XRPClaim object to submit
- `peerId?` **string** - Optional peer identifier for telemetry

**Returns:** `Promise<void>`

**Throws:**

- `Error` - If claim signature verification fails
- `XRPLError` - If transaction submission fails (invalid signature, channel not found, etc.)

**Example:**

```typescript
// Receive claim from peer
const claim = receivedClaim;

// Verify before submitting
if (await sdk.verifyClaim(claim)) {
  await sdk.submitClaim(claim, 'peer-alice');
  console.log('Claim submitted successfully');
}
```

**Events Emitted:**

- `XRP_CHANNEL_CLAIMED` - Emitted when claim is successfully submitted

---

### `closeChannel(channelId, peerId?): Promise<void>`

Closes a channel cooperatively. Channel enters 'closing' status with settlement delay. After settlement delay expires, channel finalizes and is removed from ledger.

**Parameters:**

- `channelId` **string** - Channel ID to close
- `peerId?` **string** - Optional peer identifier for telemetry

**Returns:** `Promise<void>`

**Throws:**

- `XRPLError` - If transaction submission fails

**Example:**

```typescript
await sdk.closeChannel(channelId, 'peer-alice');
console.log('Channel closure initiated (settling after delay)');
```

**Events Emitted:**

- `XRP_CHANNEL_CLOSED` - Emitted when channel closure is initiated

---

### `getChannelState(channelId): Promise<XRPChannelState>`

Queries the ledger for current channel state and updates local cache.

**Parameters:**

- `channelId` **string** - Channel ID to query

**Returns:** `Promise<XRPChannelState>` - Current channel state

**XRPChannelState Structure:**

```typescript
interface XRPChannelState {
  channelId: string; // 64-char hex
  account: string; // Source account (r-address)
  destination: string; // Destination account (r-address)
  amount: string; // Total XRP in channel (drops)
  balance: string; // XRP claimed so far (drops)
  settleDelay: number; // Settlement delay in seconds
  publicKey: string; // ed25519 public key (66-char hex)
  cancelAfter?: number; // Optional: auto-expiration timestamp
  expiration?: number; // Optional: close request timestamp
  status: 'open' | 'closing' | 'closed';
}
```

**Throws:**

- `XRPLError` - If channel not found on ledger

**Example:**

```typescript
const state = await sdk.getChannelState(channelId);

console.log('Channel ID:', state.channelId);
console.log('Amount:', state.amount, 'drops');
console.log('Balance:', state.balance, 'drops');
console.log('Remaining:', BigInt(state.amount) - BigInt(state.balance), 'drops');
console.log('Status:', state.status);
```

---

### `getMyChannels(): Promise<string[]>`

Queries the ledger for all payment channels where the current account is the source.

**Returns:** `Promise<string[]>` - Array of channel IDs

**Example:**

```typescript
const channels = await sdk.getMyChannels();
console.log('Found', channels.length, 'channels');

for (const channelId of channels) {
  const state = await sdk.getChannelState(channelId);
  console.log('Channel:', channelId, 'Status:', state.status);
}
```

---

### `startAutoRefresh(): void`

Starts automatic channel state refresh. Polls the ledger for channel state changes every 30 seconds and updates local cache.

**Returns:** `void`

**Example:**

```typescript
// Start auto-refresh to keep cache synchronized
sdk.startAutoRefresh();
```

---

### `stopAutoRefresh(): void`

Stops automatic channel state refresh. Must be called before SDK disposal to avoid memory leaks.

**Returns:** `void`

**Example:**

```typescript
// Cleanup when SDK is no longer needed
sdk.stopAutoRefresh();
```

## Usage Example

### Complete Workflow

```typescript
import { XRPChannelSDK } from '@m2m/connector';
import pino from 'pino';

const logger = pino();

// Initialize SDK
const sdk = new XRPChannelSDK(xrplClient, channelManager, claimSigner, logger, telemetryEmitter);

// Start auto-refresh
sdk.startAutoRefresh();

try {
  // 1. Open channel
  const channelId = await sdk.openChannel(
    'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY',
    '10000000000', // 10,000 XRP
    86400, // 24 hours
    'peer-alice'
  );

  // 2. Sign claim off-chain
  const claim = await sdk.signClaim(channelId, '5000000000');

  // 3. Send claim to peer (off-chain delivery via BTP)
  sendClaimToPeer(peer, claim);

  // 4. Receive claim from peer and verify
  const receivedClaim = await receiveClaimFromPeer(peer);
  const isValid = await sdk.verifyClaim(receivedClaim);

  if (isValid) {
    // 5. Submit claim to ledger
    await sdk.submitClaim(receivedClaim, 'peer-alice');
  }

  // 6. Close channel cooperatively
  await sdk.closeChannel(channelId, 'peer-alice');
} finally {
  // Cleanup
  sdk.stopAutoRefresh();
}
```

## Error Handling

```typescript
import { XRPLError, XRPLErrorCode } from '@m2m/connector';

try {
  await sdk.submitClaim(claim, peerId);
} catch (error) {
  if (error instanceof XRPLError) {
    switch (error.code) {
      case XRPLErrorCode.INVALID_CHANNEL_SIGNATURE:
        logger.error('Claim signature verification failed');
        break;
      case XRPLErrorCode.CHANNEL_AMOUNT_EXCEEDED:
        logger.error('Claim amount exceeds channel balance');
        break;
      case XRPLErrorCode.CHANNEL_NOT_FOUND:
        logger.error('Payment channel does not exist');
        break;
      case XRPLErrorCode.TRANSACTION_FAILED:
        logger.error('Transaction submission failed');
        break;
      default:
        logger.error({ error }, 'Unknown XRPL error');
    }
  } else {
    logger.error({ error }, 'Unexpected error');
  }
}
```

## See Also

- [XRP Payment Channels Setup Guide](../guides/xrp-payment-channels-setup.md)
- [Unified Settlement Executor API Reference](./unified-settlement-executor.md)
- [XRP Channel Lifecycle Manager API Reference](./xrp-channel-lifecycle-manager.md)
- [XRP Ledger Payment Channels Documentation](https://xrpl.org/payment-channels.html)
