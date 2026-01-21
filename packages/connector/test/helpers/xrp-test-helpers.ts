/**
 * Test Helper Functions for XRP Settlement Integration Tests
 *
 * Provides utilities for:
 * - Checking rippled health
 * - Creating and funding test XRP accounts
 * - Waiting for XRP channel creation/confirmation
 * - Querying channel state on-ledger
 * - Collecting telemetry events from dashboard
 * - Waiting for TigerBeetle balance updates
 */

import { Client, Wallet, Payment } from 'xrpl';
import { WebSocket } from 'ws';
import { TelemetryEvent } from '@m2m/shared';

/**
 * Check rippled health before running tests
 *
 * @param wssUrl - WebSocket URL for rippled (e.g., 'ws://localhost:6006')
 * @returns true if rippled is available and responsive
 */
export async function checkRippledHealth(wssUrl: string): Promise<boolean> {
  try {
    const client = new Client(wssUrl);
    await client.connect();
    const serverInfo = await client.request({ command: 'server_info' });
    await client.disconnect();

    // Check if server is in full state (ready to process transactions)
    return (
      serverInfo.result?.info?.server_state === 'full' ||
      serverInfo.result?.info?.server_state === 'proposing'
    );
  } catch (error) {
    return false;
  }
}

/**
 * Create and fund a test XRP account
 *
 * @param client - Connected XRPL client
 * @param options - Funding options
 * @returns XRP address of created account
 */
export async function createTestXRPAccount(
  client: Client,
  options?: {
    fundAmount?: string; // Amount in drops
  }
): Promise<Wallet> {
  // Generate new wallet
  const wallet = Wallet.generate();

  // Fund account from genesis account (local rippled only)
  // Genesis seed for standalone rippled: snoPBrXtMeMyMHUVTgbuqAfg1SUTb
  const genesisWallet = Wallet.fromSeed('snoPBrXtMeMyMHUVTgbuqAfg1SUTb');

  const fundTx: Payment = {
    TransactionType: 'Payment',
    Account: genesisWallet.address,
    Destination: wallet.address,
    Amount: options?.fundAmount ?? '100000000000', // Default: 100,000 XRP
  };

  try {
    await client.submitAndWait(fundTx, { wallet: genesisWallet });
  } catch (error) {
    throw new Error(`Failed to fund test account: ${error}`);
  }

  return wallet;
}

/**
 * Wait for XRP channel creation on-ledger
 *
 * @param client - Connected XRPL client
 * @param sourceAccount - Channel source account address
 * @param destination - Channel destination account address
 * @param options - Timeout options
 * @returns Channel ID (64-char hex string)
 */
export async function waitForXRPChannelCreation(
  client: Client,
  sourceAccount: string,
  destination: string,
  options?: { timeout?: number }
): Promise<string> {
  const timeout = options?.timeout ?? 10000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const channels = await client.request({
        command: 'account_channels',
        account: sourceAccount,
      });

      const channel = channels.result.channels?.find(
        (c: { destination_account: string }) => c.destination_account === destination
      );

      if (channel) {
        return channel.channel_id;
      }
    } catch (error) {
      // Continue polling if request fails
    }

    await new Promise((resolve) => setTimeout(resolve, 500)); // Poll every 500ms
  }

  throw new Error(`XRP channel not created within ${timeout}ms`);
}

/**
 * Wait for ledger confirmation of transaction
 *
 * @param client - Connected XRPL client
 * @param txHash - Transaction hash to wait for
 * @param options - Timeout options
 */
export async function waitForLedgerConfirmation(
  client: Client,
  txHash: string,
  options?: { timeout?: number }
): Promise<void> {
  const timeout = options?.timeout ?? 10000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const tx = await client.request({
        command: 'tx',
        transaction: txHash,
      });

      if (tx.result.validated) {
        return;
      }
    } catch (error) {
      // Continue polling if transaction not found yet
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Transaction ${txHash} not confirmed within ${timeout}ms`);
}

/**
 * Query channel state on-ledger
 *
 * @param client - Connected XRPL client
 * @param channelId - Channel ID to query
 * @returns Channel ledger entry
 */
export async function queryChannelOnLedger(
  client: Client,
  channelId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  try {
    const ledgerEntry = await client.request({
      command: 'ledger_entry',
      payment_channel: channelId,
    });

    if (!ledgerEntry.result.node) {
      throw new Error(`Channel ${channelId} not found on ledger`);
    }

    return ledgerEntry.result.node;
  } catch (error) {
    throw new Error(`Failed to query channel ${channelId}: ${error}`);
  }
}

/**
 * Wait for TigerBeetle balance to reach expected amount
 *
 * @param getBalanceFn - Function to get current balance
 * @param expectedBalance - Expected balance value
 * @param options - Timeout options
 */
export async function waitForBalance(
  getBalanceFn: () => Promise<number>,
  expectedBalance: number,
  options?: { timeout?: number }
): Promise<void> {
  const timeout = options?.timeout ?? 10000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const balance = await getBalanceFn();

    if (balance >= expectedBalance) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Balance ${expectedBalance} not reached within ${timeout}ms`);
}

/**
 * Collect telemetry events from dashboard WebSocket
 *
 * @param dashboardUrl - Dashboard WebSocket URL (e.g., 'ws://localhost:8082')
 * @param options - Collection options
 * @returns Array of collected telemetry events
 */
export async function collectTelemetryEvents(
  dashboardUrl: string,
  options?: {
    timeout?: number;
    filter?: (event: TelemetryEvent) => boolean;
  }
): Promise<TelemetryEvent[]> {
  const timeout = options?.timeout ?? 5000;
  const events: TelemetryEvent[] = [];

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(dashboardUrl);

    ws.on('open', () => {
      // Connection opened successfully
    });

    ws.on('message', (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString()) as TelemetryEvent;
        if (!options?.filter || options.filter(event)) {
          events.push(event);
        }
      } catch (error) {
        // Ignore malformed events
      }
    });

    ws.on('error', (error) => {
      reject(new Error(`WebSocket error: ${error.message}`));
    });

    setTimeout(() => {
      ws.close();
      resolve(events);
    }, timeout);
  });
}

/**
 * Wait for specific telemetry event
 *
 * @param dashboardUrl - Dashboard WebSocket URL
 * @param eventType - Event type to wait for
 * @param options - Wait options
 * @returns Matching telemetry event
 */
export async function waitForTelemetryEvent(
  dashboardUrl: string,
  eventType: string,
  options?: {
    timeout?: number;
    filter?: (event: TelemetryEvent) => boolean;
  }
): Promise<TelemetryEvent> {
  const timeout = options?.timeout ?? 10000;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(dashboardUrl);
    const timeoutHandle = setTimeout(() => {
      ws.close();
      reject(new Error(`Event ${eventType} not received within ${timeout}ms`));
    }, timeout);

    ws.on('message', (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString()) as TelemetryEvent;
        if (event.type === eventType) {
          if (!options?.filter || options.filter(event)) {
            clearTimeout(timeoutHandle);
            ws.close();
            resolve(event);
          }
        }
      } catch (error) {
        // Ignore malformed events
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`WebSocket error: ${error.message}`));
    });
  });
}

/**
 * Find XRP channel between source and destination
 *
 * @param client - Connected XRPL client
 * @param sourceAccount - Source account address
 * @param destination - Destination account address
 * @returns Channel ID if found, undefined otherwise
 */
export async function findXRPChannel(
  client: Client,
  sourceAccount: string,
  destination: string
): Promise<string | undefined> {
  try {
    const channels = await client.request({
      command: 'account_channels',
      account: sourceAccount,
    });

    const channel = channels.result.channels?.find(
      (c: { destination_account: string; channel_id: string }) =>
        c.destination_account === destination
    );

    return channel?.channel_id;
  } catch (error) {
    return undefined;
  }
}

/**
 * Create test EVM account (placeholder for dual-settlement tests)
 * NOTE: This integrates with existing Anvil test infrastructure
 *
 * @returns EVM address
 */
export async function createTestEVMAccount(): Promise<string> {
  // Use Anvil test accounts (from Epic 7)
  // These are pre-funded accounts available in local Anvil
  const testAccounts = [
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  ];

  // Return a random test account for this test
  return testAccounts[Math.floor(Math.random() * testAccounts.length)]!;
}

/**
 * Wait for event with polling
 *
 * @param checkFn - Function that returns true when condition is met
 * @param options - Polling options
 */
export async function waitForCondition(
  checkFn: () => Promise<boolean>,
  options?: {
    timeout?: number;
    interval?: number;
    errorMessage?: string;
  }
): Promise<void> {
  const timeout = options?.timeout ?? 10000;
  const interval = options?.interval ?? 100;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await checkFn()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(options?.errorMessage ?? `Condition not met within ${timeout}ms`);
}
