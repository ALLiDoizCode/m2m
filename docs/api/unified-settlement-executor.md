# UnifiedSettlementExecutor API Reference

## Overview

The `UnifiedSettlementExecutor` class orchestrates dual-chain settlement routing between EVM and XRP ledgers. It listens for `SETTLEMENT_REQUIRED` events from SettlementMonitor and routes settlements to the appropriate method based on peer configuration and token type.

**Key Features:**

- Automatic settlement routing (EVM vs XRP)
- Peer-based settlement preference configuration
- Token type detection and routing
- Integration with TigerBeetle accounting layer
- Event-driven architecture

**Module:** `@m2m/connector/settlement/unified-settlement-executor`

## Settlement Routing Logic

```
┌─────────────────────────────────────────────────────────────┐
│           Settlement Required Event                          │
│  { peerId, balance, tokenId }                               │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │  Get Peer Config     │
        └──────────┬───────────┘
                   │
         ┌─────────▼──────────┐
         │  tokenId === 'XRP'?│
         └─────┬──────────┬───┘
               │          │
          Yes  │          │  No (ERC20)
               │          │
               ▼          ▼
    ┌──────────────┐  ┌──────────────┐
    │ XRP Settlement│  │EVM Settlement│
    │ (PaymentChannel│  │(PaymentChannel│
    │  Manager)     │  │  SDK)        │
    └──────────────┘  └──────────────┘
```

## Types

### PeerConfig

```typescript
interface PeerConfig {
  /** Peer identifier */
  peerId: string;

  /** ILP address of peer */
  ilpAddress: string;

  /** Settlement preference: 'evm' | 'xrp' | 'both' */
  settlementPreference: 'evm' | 'xrp' | 'both';

  /** Supported settlement tokens (ordered by preference) */
  settlementTokens: string[]; // e.g., ['XRP', 'USDC', 'DAI']

  /** EVM address (required if settlementPreference includes 'evm') */
  evmAddress?: string;

  /** XRP Ledger address (required if settlementPreference includes 'xrp') */
  xrpAddress?: string;

  /** Settlement threshold (in base units) */
  settlementThreshold: bigint;

  /** Settlement interval (milliseconds) */
  settlementInterval: number;
}
```

### UnifiedSettlementExecutorConfig

```typescript
interface UnifiedSettlementExecutorConfig {
  /** Map of peer IDs to peer configurations */
  peers: Map<string, PeerConfig>;
}
```

### SettlementRequiredEvent

```typescript
interface SettlementRequiredEvent {
  /** Peer identifier */
  peerId: string;

  /** Balance to settle (string for bigint) */
  balance: string;

  /** Token identifier ('XRP' or ERC20 contract address) */
  tokenId: string;
}
```

## Constructor

### `new UnifiedSettlementExecutor(config, evmChannelSDK, xrpChannelManager, xrpClaimSigner, settlementMonitor, accountManager, logger)`

Creates a new UnifiedSettlementExecutor instance.

**Parameters:**

- `config` **UnifiedSettlementExecutorConfig** - Unified settlement configuration with peer preferences
- `evmChannelSDK` **PaymentChannelSDK** - PaymentChannelSDK for EVM settlements (Epic 8)
- `xrpChannelManager` **PaymentChannelManager** - PaymentChannelManager for XRP settlements (Epic 9)
- `xrpClaimSigner` **ClaimSigner** - ClaimSigner for XRP claim generation
- `settlementMonitor` **SettlementMonitor** - Settlement monitor emitting SETTLEMENT_REQUIRED events
- `accountManager` **AccountManager** - TigerBeetle account manager for balance updates
- `logger` **Logger** - Pino logger instance

**Example:**

```typescript
import { UnifiedSettlementExecutor } from '@m2m/connector';

const config: UnifiedSettlementExecutorConfig = {
  peers: new Map([
    [
      'peer-alice',
      {
        peerId: 'peer-alice',
        ilpAddress: 'g.alice.connector',
        settlementPreference: 'both',
        settlementTokens: ['XRP', 'USDC'],
        evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0',
        xrpAddress: 'rLHzPsX6oXkzU9rFkRaYT8yBqJcQwPgHWN',
        settlementThreshold: 1000000000n,
        settlementInterval: 3600000,
      },
    ],
  ]),
};

const executor = new UnifiedSettlementExecutor(
  config,
  evmChannelSDK,
  xrpChannelManager,
  xrpClaimSigner,
  settlementMonitor,
  accountManager,
  logger
);
```

## Methods

### `start(): void`

Starts the settlement executor. Registers listener for `SETTLEMENT_REQUIRED` events from SettlementMonitor. Settlement routing begins after this method is called.

**Returns:** `void`

**Example:**

```typescript
executor.start();
logger.info('UnifiedSettlementExecutor started');
```

---

### `stop(): void`

Stops the settlement executor. Unregisters event listener and stops settlement processing. Ensures proper cleanup of event handlers.

**Returns:** `void`

**Example:**

```typescript
executor.stop();
logger.info('UnifiedSettlementExecutor stopped');
```

## Settlement Routing Rules

The executor applies the following routing logic:

### XRP Settlement

Triggered when:

- `tokenId === 'XRP'`
- Peer's `settlementPreference` is `'xrp'` or `'both'`
- Peer has `xrpAddress` configured

**Actions:**

1. Find or create XRP payment channel with peer
2. Sign claim for settlement amount
3. Send claim to peer off-chain (peer submits to ledger)
4. Update TigerBeetle accounts

**Implementation:**

```typescript
// Routes to PaymentChannelManager (Epic 9)
await xrpChannelManager.createChannel(destination, amount, settleDelay);
const signature = await xrpClaimSigner.signClaim(channelId, amount);
// Send signature to peer via BTP
```

### EVM Settlement

Triggered when:

- `tokenId !== 'XRP'` (ERC20 token address)
- Peer's `settlementPreference` is `'evm'` or `'both'`
- Peer has `evmAddress` configured

**Actions:**

1. Open new EVM payment channel with peer
2. Deposit settlement amount to channel
3. Update TigerBeetle accounts

**Implementation:**

```typescript
// Routes to PaymentChannelSDK (Epic 8)
await evmChannelSDK.openChannel(peerAddress, tokenAddress, settlementTimeout, depositAmount);
```

### Error Cases

The executor throws an error when:

- **No peer configuration found:** Peer ID not in config map
- **Incompatible XRP settlement:** XRP token but peer doesn't support XRP (`settlementPreference === 'evm'`)
- **Incompatible EVM settlement:** ERC20 token but peer doesn't support EVM (`settlementPreference === 'xrp'`)
- **Missing address:** Peer missing `evmAddress` for EVM or `xrpAddress` for XRP

## Usage Examples

### Example 1: Dual-Settlement Configuration

```typescript
import { UnifiedSettlementExecutor, PeerConfig } from '@m2m/connector';

// Configure peers with different settlement preferences
const config: UnifiedSettlementExecutorConfig = {
  peers: new Map([
    // Peer 1: XRP-only settlement
    [
      'peer-xrp',
      {
        peerId: 'peer-xrp',
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
      'peer-evm',
      {
        peerId: 'peer-evm',
        ilpAddress: 'g.peer2.connector',
        settlementPreference: 'evm',
        settlementTokens: ['USDC', 'DAI'],
        evmAddress: '0x123...',
        settlementThreshold: 1000000000n,
        settlementInterval: 3600000,
      },
    ],

    // Peer 3: Dual settlement support (prefer XRP)
    [
      'peer-dual',
      {
        peerId: 'peer-dual',
        ilpAddress: 'g.peer3.connector',
        settlementPreference: 'both',
        settlementTokens: ['XRP', 'USDC'], // XRP preferred first
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
  evmChannelSDK,
  xrpChannelManager,
  xrpClaimSigner,
  settlementMonitor,
  accountManager,
  logger
);

executor.start();
```

### Example 2: Settlement Event Flow

```typescript
// SettlementMonitor emits SETTLEMENT_REQUIRED event
settlementMonitor.emit('SETTLEMENT_REQUIRED', {
  peerId: 'peer-alice',
  balance: '5000000000', // 5,000 XRP in drops
  tokenId: 'XRP',
});

// UnifiedSettlementExecutor receives event and routes to XRP settlement
// (automatically handled when executor.start() has been called)

// Event handler internally:
// 1. Gets peer config
// 2. Validates peer supports XRP settlement
// 3. Creates/finds XRP channel
// 4. Signs claim
// 5. Sends claim to peer
// 6. Updates TigerBeetle accounts
```

### Example 3: Error Handling

```typescript
import { UnifiedSettlementExecutor } from '@m2m/connector';

const executor = new UnifiedSettlementExecutor(
  config,
  evmChannelSDK,
  xrpChannelManager,
  xrpClaimSigner,
  settlementMonitor,
  accountManager,
  logger
);

executor.start();

try {
  // Settlement event triggers routing logic
  settlementMonitor.emit('SETTLEMENT_REQUIRED', {
    peerId: 'unknown-peer',
    balance: '1000000',
    tokenId: 'XRP',
  });
} catch (error) {
  // Error: Peer configuration not found for peerId: unknown-peer
  logger.error({ error }, 'Settlement failed');
}
```

## Integration with SettlementMonitor

The UnifiedSettlementExecutor listens to the SettlementMonitor's `SETTLEMENT_REQUIRED` event:

```typescript
import { SettlementMonitor } from '@m2m/connector';

// SettlementMonitor emits events when settlement thresholds reached
const settlementMonitor = new SettlementMonitor(config, accountManager, logger);

settlementMonitor.on('SETTLEMENT_REQUIRED', (event) => {
  // UnifiedSettlementExecutor handles this event automatically
  logger.info({ event }, 'Settlement required');
});

// Start both components
settlementMonitor.start();
executor.start();
```

## Integration with TigerBeetle

After successful settlement, the executor updates TigerBeetle accounts:

```typescript
// After settlement completes (either EVM or XRP)
await accountManager.recordSettlement(peerId, tokenId, BigInt(balance));

// TigerBeetle accounts updated to reflect settled amount
```

## Cleanup

```typescript
// Stop executor before application shutdown
executor.stop();
settlementMonitor.stop();
```

## See Also

- [XRP Channel SDK API Reference](./xrp-channel-sdk.md)
- [XRP Channel Lifecycle Manager API Reference](./xrp-channel-lifecycle-manager.md)
- [XRP Payment Channels Setup Guide](../guides/xrp-payment-channels-setup.md)
- [Payment Channel SDK Documentation](../guides/payment-channels.md) (Epic 8)
