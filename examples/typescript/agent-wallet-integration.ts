/**
 * Agent Wallet Integration Example - TypeScript
 *
 * Complete example showing how to integrate agent wallets into your application.
 * Covers wallet creation, funding, balance tracking, and payment channels.
 */

import { AgentWalletLifecycle } from '@m2m/connector/wallet/agent-wallet-lifecycle';
import { AgentBalanceTracker } from '@m2m/connector/wallet/agent-balance-tracker';
import { AgentChannelManager } from '@m2m/connector/wallet/agent-channel-manager';
import { WalletBackupManager } from '@m2m/connector/wallet/wallet-backup-manager';
import { pino } from 'pino';

const logger = pino({ level: 'info' });

/**
 * Example 1: Create and Initialize Agent Wallet
 */
async function createWalletExample(): Promise<unknown> {
  const lifecycle = new AgentWalletLifecycle();

  try {
    // Create new agent wallet
    const wallet = await lifecycle.createAgentWallet('agent-001');

    logger.info('Agent wallet created', {
      agentId: wallet.agentId,
      evmAddress: wallet.evmAddress,
      xrpAddress: wallet.xrpAddress,
      status: wallet.status,
    });

    // Wait for wallet to become active (funding complete)
    let currentWallet = wallet;
    while (currentWallet.status === 'pending') {
      logger.info('Waiting for wallet activation...', { agentId: wallet.agentId });
      await new Promise((resolve) => setTimeout(resolve, 5000));
      currentWallet = await lifecycle.getAgentWallet(wallet.agentId);
    }

    logger.info('Wallet is now active', { agentId: wallet.agentId });
    return wallet;
  } catch (error) {
    logger.error('Wallet creation failed', { error: error.message });
    throw error;
  }
}

/**
 * Example 2: Check Wallet Balances
 */
async function checkBalancesExample(agentId: string): Promise<unknown> {
  const balanceTracker = new AgentBalanceTracker();

  try {
    // Get all balances for agent
    const balances = await balanceTracker.getAllBalances(agentId);

    logger.info('Agent balances', {
      agentId,
      balanceCount: balances.length,
    });

    // Format and display balances
    balances.forEach((balance) => {
      const formatted = formatBalance(balance.balance, balance.decimals);
      logger.info(`${balance.chain.toUpperCase()} ${balance.token}: ${formatted}`, {
        raw: balance.balance.toString(),
        decimals: balance.decimals,
      });
    });

    return balances;
  } catch (error) {
    logger.error('Balance check failed', { agentId, error: error.message });
    throw error;
  }
}

/**
 * Example 3: Open Payment Channel and Send Payments
 */
async function paymentChannelExample(agentId: string, peerId: string): Promise<void> {
  const channelManager = new AgentChannelManager();

  try {
    // Open payment channel with 1000 USDC
    logger.info('Opening payment channel', { agentId, peerId });

    const channelId = await channelManager.openChannel(
      agentId,
      peerId,
      'evm',
      'USDC',
      BigInt(1000000000) // 1000 USDC (6 decimals)
    );

    logger.info('Payment channel opened', { channelId });

    // Send multiple micropayments
    for (let i = 1; i <= 10; i++) {
      await channelManager.sendPayment(
        agentId,
        channelId,
        BigInt(10000000) // 10 USDC per payment
      );

      logger.info('Payment sent', {
        paymentNumber: i,
        amount: '10 USDC',
        channelId,
      });
    }

    // Get channel details
    const channels = await channelManager.getAgentChannels(agentId);
    const channel = channels.find((c) => c.id === channelId);

    if (channel) {
      logger.info('Channel status', {
        channelId: channel.id,
        remainingBalance: formatBalance(channel.balance, 6),
        paymentsCount: channel.paymentsCount,
      });
    }

    // Close channel
    logger.info('Closing payment channel', { channelId });
    await channelManager.closeChannel(agentId, channelId);
    logger.info('Channel closed and settled', { channelId });
  } catch (error) {
    logger.error('Payment channel operation failed', { error: error.message });
    throw error;
  }
}

/**
 * Example 4: Create and Restore Backup
 */
async function backupExample(): Promise<unknown> {
  const backupManager = new WalletBackupManager();

  try {
    // Create full backup
    logger.info('Creating wallet backup...');
    const backup = await backupManager.createFullBackup('strong-password-123456789');

    logger.info('Backup created', {
      backupId: backup.id,
      walletCount: backup.wallets.length,
      timestamp: backup.createdAt,
    });

    // In production: Save backup to secure location
    // import { writeFile } from 'fs/promises';
    // await writeFile(`backup-${backup.id}.enc`, JSON.stringify(backup));

    // Restore backup (typically on new server)
    // logger.info('Restoring from backup...');
    // await backupManager.restoreFromBackup(backup, 'strong-password-123456789');
    // logger.info('Backup restored successfully');

    return backup;
  } catch (error) {
    logger.error('Backup operation failed', { error: error.message });
    throw error;
  }
}

/**
 * Example 5: Complete Agent Lifecycle
 */
async function completeLifecycleExample(): Promise<void> {
  const agentId = 'agent-example-001';
  const peerId = 'agent-example-002';

  try {
    logger.info('=== Starting Complete Agent Lifecycle Example ===');

    // Step 1: Create wallet
    logger.info('Step 1: Creating agent wallet...');
    await createWalletExample();

    // Step 2: Check balances
    logger.info('Step 2: Checking wallet balances...');
    await checkBalancesExample(agentId);

    // Step 3: Payment channel operations
    logger.info('Step 3: Payment channel operations...');
    await paymentChannelExample(agentId, peerId);

    // Step 4: Create backup
    logger.info('Step 4: Creating wallet backup...');
    await backupExample();

    logger.info('=== Complete Agent Lifecycle Example Finished Successfully ===');
  } catch (error) {
    logger.error('Lifecycle example failed', { error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * Example 6: Error Handling Patterns
 */
async function errorHandlingExample(agentId: string): Promise<unknown> {
  const lifecycle = new AgentWalletLifecycle();

  try {
    // Attempt to create wallet
    const wallet = await lifecycle.createAgentWallet(agentId);
    logger.info('Wallet created', { agentId });
    return wallet;
  } catch (error) {
    // Handle specific error types
    if (error.message.includes('already exists')) {
      logger.warn('Wallet already exists, retrieving existing wallet', { agentId });
      return await lifecycle.getAgentWallet(agentId);
    } else if (error.message.includes('rate limit')) {
      logger.error('Rate limit exceeded', { agentId });
      // Implement exponential backoff
      await new Promise((resolve) => setTimeout(resolve, 60000));
      throw error;
    } else if (error.message.includes('master-seed not found')) {
      logger.error('Master seed not initialized', { agentId });
      throw new Error('System configuration error - contact administrator');
    } else {
      logger.error('Unknown wallet error', { agentId, error: error.message });
      throw error;
    }
  }
}

/**
 * Example 7: Batch Wallet Creation
 */
async function batchWalletExample(): Promise<unknown> {
  const lifecycle = new AgentWalletLifecycle();
  const agentIds = ['agent-batch-001', 'agent-batch-002', 'agent-batch-003'];

  try {
    logger.info('Creating multiple wallets in parallel...', { count: agentIds.length });

    // Create all wallets in parallel
    const wallets = await Promise.all(agentIds.map((id) => lifecycle.createAgentWallet(id)));

    logger.info('Batch wallet creation complete', {
      count: wallets.length,
      wallets: wallets.map((w) => ({
        agentId: w.agentId,
        evmAddress: w.evmAddress,
        xrpAddress: w.xrpAddress,
      })),
    });

    return wallets;
  } catch (error) {
    logger.error('Batch wallet creation failed', { error: error.message });
    throw error;
  }
}

/**
 * Utility: Format balance for human-readable output
 */
function formatBalance(balance: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const whole = balance / divisor;
  const fraction = balance % divisor;
  return `${whole}.${fraction.toString().padStart(decimals, '0')}`;
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  try {
    // Run complete lifecycle example
    await completeLifecycleExample();

    // Run additional examples
    await errorHandlingExample('agent-error-001');
    await batchWalletExample();

    logger.info('All examples completed successfully');
  } catch (error) {
    logger.error('Example execution failed', { error: error.message });
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

// Export functions for use in other modules
export {
  createWalletExample,
  checkBalancesExample,
  paymentChannelExample,
  backupExample,
  completeLifecycleExample,
  errorHandlingExample,
  batchWalletExample,
  formatBalance,
};
