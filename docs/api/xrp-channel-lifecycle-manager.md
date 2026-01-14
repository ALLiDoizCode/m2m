# XRPChannelLifecycleManager API Reference

## Overview

The `XRPChannelLifecycleManager` class manages automatic XRP payment channel lifecycle operations. It handles channel opening, funding, idle detection, and expiration-based closure to optimize XRP settlement efficiency.

**Key Features:**

- Automatic channel opening when first settlement needed
- Automatic funding when balance falls below threshold
- Idle channel detection and automatic closure
- Expiration-based closure (CancelAfter handling)
- Periodic lifecycle checks (hourly)

**Module:** `@m2m/connector/settlement/xrp-channel-lifecycle`

## Lifecycle State Machine

```
┌────────────────────────────────────────────────────────────┐
│                  Channel Lifecycle                         │
└────────────────────────────────────────────────────────────┘

  getOrCreateChannel()
         │
         ▼
    ┌────────┐
    │  OPEN  │ ◄──────────────────┐
    └───┬────┘                     │
        │                          │
        ├─► updateChannelActivity()│
        │                          │
        ├─► needsFunding() ?       │
        │   └─► fundChannel() ─────┘
        │
        ├─► Idle > threshold ?
        │   └─► closeChannel('idle')
        │
        ├─► Approaching CancelAfter ?
        │   └─► closeChannel('expiration')
        │
        ▼
   ┌─────────┐
   │ CLOSING │ ──► Settlement delay period
   └─────────┘
        │
        ▼
   ┌────────┐
   │ CLOSED │
   └────────┘
```

## Types

### XRPChannelLifecycleConfig

```typescript
interface XRPChannelLifecycleConfig {
  /** Enable automatic XRP channel lifecycle management */
  enabled: boolean;

  /** Initial channel amount in XRP drops (1 XRP = 1,000,000 drops) */
  initialChannelAmount: string;

  /** Default settlement delay in seconds (minimum 3600 for production) */
  defaultSettleDelay: number;

  /** Idle channel threshold in seconds (close after no claims for X hours) */
  idleChannelThreshold: number;

  /** Minimum balance threshold (0.0 - 1.0). Fund when remaining < threshold * amount */
  minBalanceThreshold: number;

  /** Optional: Auto-expire channels after this many seconds (CancelAfter field) */
  cancelAfter?: number;

  /** Peer ID for channel management (used for telemetry and logging) */
  peerId?: string;
}
```

### XRPChannelTrackingState

```typescript
interface XRPChannelTrackingState {
  /** Channel ID (64-character hex string, transaction hash) */
  channelId: string;

  /** Peer ID associated with this channel */
  peerId: string;

  /** XRP Ledger destination address (r-address) */
  destination: string;

  /** Total XRP amount in channel (drops) */
  amount: string;

  /** Current channel balance (XRP claimed so far, in drops) */
  balance: string;

  /** Settlement delay in seconds */
  settleDelay: number;

  /** Channel status */
  status: 'open' | 'closing' | 'closed';

  /** Timestamp of last claim activity (milliseconds since epoch) */
  lastActivityAt: number;

  /** Optional: CancelAfter timestamp (channel auto-expires after this time) */
  cancelAfter?: number;
}
```

## Constructor

### `new XRPChannelLifecycleManager(config, xrpChannelSDK, logger)`

Creates a new XRPChannelLifecycleManager instance.

**Parameters:**

- `config` **XRPChannelLifecycleConfig** - Lifecycle configuration
- `xrpChannelSDK` **XRPChannelSDK** - XRP Channel SDK instance for channel operations
- `logger` **Logger** - Pino logger instance

**Example:**

```typescript
import { XRPChannelLifecycleManager } from '@m2m/connector';

const config: XRPChannelLifecycleConfig = {
  enabled: true,
  initialChannelAmount: '10000000000', // 10,000 XRP
  defaultSettleDelay: 86400, // 24 hours
  idleChannelThreshold: 86400, // Close after 24 hours idle
  minBalanceThreshold: 0.3, // Fund when < 30% remaining
  cancelAfter: 2592000, // Auto-expire after 30 days
  peerId: 'peer-alice',
};

const lifecycleManager = new XRPChannelLifecycleManager(config, xrpChannelSDK, logger);
```

## Methods

### `start(): Promise<void>`

Starts the lifecycle manager. Begins periodic idle channel detection and expiration checks (every 1 hour).

**Returns:** `Promise<void>`

**Example:**

```typescript
await lifecycleManager.start();
logger.info('XRP channel lifecycle manager started');
```

---

### `stop(): void`

Stops the lifecycle manager. Clears idle check timer and releases resources.

**Returns:** `void`

**Example:**

```typescript
lifecycleManager.stop();
logger.info('XRP channel lifecycle manager stopped');
```

---

### `getOrCreateChannel(peerId, destination): Promise<string>`

Gets an existing open XRP channel for the peer, or creates a new channel if none exists. This method should be called by UnifiedSettlementExecutor when XRP settlement is required.

**Parameters:**

- `peerId` **string** - Peer identifier
- `destination` **string** - XRP Ledger destination address (r-address)

**Returns:** `Promise<string>` - Channel ID (64-character hex string)

**Example:**

```typescript
const channelId = await lifecycleManager.getOrCreateChannel(
  'peer-alice',
  'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY'
);

console.log('Using channel:', channelId);
```

---

### `updateChannelActivity(peerId, claimAmount): void`

Updates the activity timestamp for a channel after successful claim submission. Prevents the channel from being detected as idle.

**Parameters:**

- `peerId` **string** - Peer identifier
- `claimAmount` **string** - Amount claimed (drops, cumulative)

**Returns:** `void`

**Example:**

```typescript
// After submitting a claim
await sdk.submitClaim(claim, peerId);

// Update activity timestamp
lifecycleManager.updateChannelActivity(peerId, claim.amount);
```

---

### `needsFunding(peerId): boolean`

Checks if a channel needs funding based on the minimum balance threshold.

**Formula:** `remainingBalance < minBalanceThreshold * amount`

**Parameters:**

- `peerId` **string** - Peer identifier

**Returns:** `boolean` - `true` if channel needs funding

**Example:**

```typescript
if (lifecycleManager.needsFunding('peer-alice')) {
  await lifecycleManager.fundChannel('peer-alice', '5000000000');
}
```

---

### `fundChannel(peerId, additionalAmount): Promise<void>`

Funds an existing open channel with additional XRP.

**Parameters:**

- `peerId` **string** - Peer identifier
- `additionalAmount` **string** - XRP drops to add to channel

**Returns:** `Promise<void>`

**Throws:**

- `Error` - If peer not found or channel is not open

**Example:**

```typescript
await lifecycleManager.fundChannel(
  'peer-alice',
  '5000000000' // Add 5,000 XRP
);

console.log('Channel funded successfully');
```

---

### `closeChannel(peerId, reason): Promise<void>`

Closes an XRP channel cooperatively via SDK. Updates tracked status to 'closing'.

**Parameters:**

- `peerId` **string** - Peer identifier
- `reason` **'idle' | 'expiration' | 'manual'** - Closure reason

**Returns:** `Promise<void>`

**Example:**

```typescript
// Manual closure
await lifecycleManager.closeChannel('peer-alice', 'manual');

// Automatic idle closure (triggered internally)
// await lifecycleManager.closeChannel(peerId, 'idle');

// Automatic expiration closure (triggered internally)
// await lifecycleManager.closeChannel(peerId, 'expiration');
```

---

### `getChannelForPeer(peerId): XRPChannelTrackingState | null`

Returns the tracked channel state for a peer, or `null` if no channel exists.

**Parameters:**

- `peerId` **string** - Peer identifier

**Returns:** `XRPChannelTrackingState | null` - Channel tracking state or null

**Example:**

```typescript
const channel = lifecycleManager.getChannelForPeer('peer-alice');

if (channel) {
  console.log('Channel ID:', channel.channelId);
  console.log('Status:', channel.status);
  console.log('Amount:', channel.amount, 'drops');
  console.log('Balance:', channel.balance, 'drops');
  console.log('Last activity:', new Date(channel.lastActivityAt));
}
```

## Automatic Lifecycle Events

The lifecycle manager performs automatic checks every 1 hour:

### Idle Channel Detection

**Trigger:** Channel has no activity for longer than `idleChannelThreshold`

**Action:** Closes channel with reason `'idle'`

**Example:**

```typescript
// Configuration: idleChannelThreshold = 86400 (24 hours)

// Channel created at 2025-01-01 00:00:00
const channelId = await lifecycleManager.getOrCreateChannel('peer-alice', 'rXXX...');

// No claims submitted for 25 hours

// Lifecycle manager detects idle channel at next check (01:00:00)
// Automatically closes channel:
// await lifecycleManager.closeChannel('peer-alice', 'idle');
```

### Expiration Handling

**Trigger:** Channel has `cancelAfter` timestamp and is within 1 hour of expiration

**Action:** Closes channel with reason `'expiration'`

**Example:**

```typescript
// Configuration: cancelAfter = 2592000 (30 days)

// Channel created with CancelAfter = NOW + 30 days

// After 29 days, 23 hours elapsed
// Lifecycle manager detects expiration approaching
// Automatically closes channel 1 hour before expiration:
// await lifecycleManager.closeChannel('peer-alice', 'expiration');
```

### Funding Checks

**Trigger:** Channel balance falls below `minBalanceThreshold * amount`

**Action:** User code should check `needsFunding()` and call `fundChannel()` if needed

**Example:**

```typescript
// Configuration: minBalanceThreshold = 0.3 (30%)

// Channel: amount = 10,000 XRP, balance = 7,500 XRP (claimed)
// Remaining = 2,500 XRP (25% of total)

if (lifecycleManager.needsFunding('peer-alice')) {
  // 25% < 30%, needs funding
  await lifecycleManager.fundChannel('peer-alice', '5000000000'); // Add 5,000 XRP
}
```

## Usage Examples

### Example 1: Basic Lifecycle Management

```typescript
import { XRPChannelLifecycleManager } from '@m2m/connector';

const config: XRPChannelLifecycleConfig = {
  enabled: true,
  initialChannelAmount: '10000000000', // 10,000 XRP
  defaultSettleDelay: 86400, // 24 hours
  idleChannelThreshold: 86400, // Close after 24 hours idle
  minBalanceThreshold: 0.3, // Fund when < 30% remaining
  cancelAfter: 2592000, // Auto-expire after 30 days
};

const lifecycleManager = new XRPChannelLifecycleManager(config, xrpChannelSDK, logger);

// Start lifecycle management
await lifecycleManager.start();

// Get or create channel for peer
const channelId = await lifecycleManager.getOrCreateChannel(
  'peer-alice',
  'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY'
);

// Use channel for settlement...
const claim = await xrpChannelSDK.signClaim(channelId, '1000000000');
await xrpChannelSDK.submitClaim(claim, 'peer-alice');

// Update activity after claim
lifecycleManager.updateChannelActivity('peer-alice', claim.amount);

// Check if channel needs funding
if (lifecycleManager.needsFunding('peer-alice')) {
  await lifecycleManager.fundChannel('peer-alice', '5000000000');
}

// Stop lifecycle manager before shutdown
lifecycleManager.stop();
```

### Example 2: Integration with UnifiedSettlementExecutor

```typescript
import {
  UnifiedSettlementExecutor,
  XRPChannelLifecycleManager,
  XRPChannelSDK,
} from '@m2m/connector';

// Initialize lifecycle manager
const lifecycleManager = new XRPChannelLifecycleManager(lifecycleConfig, xrpChannelSDK, logger);

await lifecycleManager.start();

// Unified settlement executor uses lifecycle manager for XRP channels
class UnifiedSettlementExecutorWithLifecycle extends UnifiedSettlementExecutor {
  private async settleViaXRP(peerId: string, amount: string, config: PeerConfig): Promise<void> {
    // Use lifecycle manager to get/create channel
    const channelId = await lifecycleManager.getOrCreateChannel(peerId, config.xrpAddress!);

    // Sign claim
    const signature = await this.xrpClaimSigner.signClaim(channelId, amount);

    // Send claim to peer (off-chain)
    // ...

    // Update activity after claim
    lifecycleManager.updateChannelActivity(peerId, amount);

    // Check if funding needed
    if (lifecycleManager.needsFunding(peerId)) {
      await lifecycleManager.fundChannel(peerId, this.config.initialChannelAmount);
    }
  }
}
```

### Example 3: Monitoring Channel State

```typescript
// Query channel state periodically
setInterval(() => {
  const channel = lifecycleManager.getChannelForPeer('peer-alice');

  if (channel) {
    const remaining = BigInt(channel.amount) - BigInt(channel.balance);
    const remainingXRP = Number(remaining) / 1_000_000;
    const idleTime = Date.now() - channel.lastActivityAt;
    const idleHours = idleTime / 3600000;

    logger.info(
      {
        channelId: channel.channelId,
        status: channel.status,
        remainingXRP,
        idleHours,
      },
      'XRP channel status'
    );

    // Alert if low balance
    if (lifecycleManager.needsFunding('peer-alice')) {
      logger.warn({ peerId: 'peer-alice' }, 'XRP channel needs funding');
    }
  }
}, 3600000); // Check every hour
```

## Configuration Best Practices

### Production Settings

```typescript
const productionConfig: XRPChannelLifecycleConfig = {
  enabled: true,
  initialChannelAmount: '10000000000', // 10,000 XRP (adjust based on traffic)
  defaultSettleDelay: 86400, // 24 hours (minimum 1 hour for production)
  idleChannelThreshold: 604800, // 7 days (longer for production)
  minBalanceThreshold: 0.3, // Fund when < 30% remaining
  cancelAfter: 2592000, // 30 days expiration
};
```

### Development Settings

```typescript
const devConfig: XRPChannelLifecycleConfig = {
  enabled: true,
  initialChannelAmount: '1000000000', // 1,000 XRP (smaller for testing)
  defaultSettleDelay: 3600, // 1 hour (minimum allowed)
  idleChannelThreshold: 3600, // 1 hour (fast closure for testing)
  minBalanceThreshold: 0.5, // Fund when < 50% remaining
  cancelAfter: 7200, // 2 hours expiration
};
```

## See Also

- [XRP Channel SDK API Reference](./xrp-channel-sdk.md)
- [Unified Settlement Executor API Reference](./unified-settlement-executor.md)
- [XRP Payment Channels Setup Guide](../guides/xrp-payment-channels-setup.md)
- [Production XRP Deployment Checklist](../deployment/production-xrp-checklist.md)
