import pino from 'pino';
import { AgentWalletDerivation, WalletNotFoundError } from './agent-wallet-derivation';
import { TreasuryWallet } from './treasury-wallet';
import { TelemetryEmitter } from '../telemetry/telemetry-emitter';
import {
  FundingTransaction,
  AgentWalletFundedEvent,
  FundingRateLimitExceededEvent,
  FundingTransactionConfirmedEvent,
  FundingTransactionFailedEvent,
} from '@m2m/shared';
import { ethers } from 'ethers';
import { Client as XRPLClient } from 'xrpl';

const logger = pino({ name: 'agent-wallet-funder' });

/**
 * Funding Configuration Interface
 */
export interface FundingConfig {
  evm: {
    initialETH: bigint; // e.g., 10000000000000000n (0.01 ETH)
    initialTokens: {
      [tokenAddress: string]: bigint; // e.g., { '0xUSDC': 100000000n (100 USDC) }
    };
  };
  xrp: {
    initialXRP: bigint; // e.g., 15000000n (15 XRP in drops, 1 XRP = 1,000,000 drops)
  };
  rateLimits: {
    maxFundingsPerHour: number; // e.g., 100
    maxFundingsPerAgent: number; // e.g., 5
  };
  strategy: 'fixed' | 'proportional'; // MVP: only 'fixed' implemented
}

/**
 * Funding Result Interface
 */
export interface FundingResult {
  agentId: string;
  transactions: FundingTransaction[];
  timestamp: number;
}

/**
 * Funding Record Interface (for rate limiting history)
 */
interface FundingRecord {
  timestamp: number;
  transactions: FundingTransaction[];
}

/**
 * Custom error for rate limit exceeded
 */
export class RateLimitExceededError extends Error {
  constructor(agentId: string, violatedLimit: 'per_agent' | 'per_hour') {
    super(
      `Rate limit exceeded for agent ${agentId}: ${violatedLimit === 'per_agent' ? 'max fundings per agent' : 'max fundings per hour'}`
    );
    this.name = 'RateLimitExceededError';
  }
}

/**
 * AgentWalletFunder - Automated funding for new agent wallets
 *
 * Provides initial cryptocurrency funding (ETH, ERC20 tokens, XRP) to new agent wallets
 * to enable immediate transaction capability. Implements rate limiting to prevent abuse.
 *
 * Features:
 * - Multi-chain funding (EVM + XRP)
 * - ERC20 token support
 * - Rate limiting (per-agent and per-hour)
 * - Transaction tracking and confirmation
 * - Telemetry integration
 */
export class AgentWalletFunder {
  private config: FundingConfig;
  private walletDerivation: AgentWalletDerivation;
  private treasuryWallet: TreasuryWallet;
  private telemetryEmitter: TelemetryEmitter;
  private fundingHistory: Map<string, FundingRecord[]>;
  private evmProvider: ethers.Provider;
  private xrplClient: XRPLClient;

  constructor(
    config: FundingConfig,
    walletDerivation: AgentWalletDerivation,
    treasuryWallet: TreasuryWallet,
    telemetryEmitter: TelemetryEmitter,
    evmProvider: ethers.Provider,
    xrplClient: XRPLClient
  ) {
    this.config = config;
    this.walletDerivation = walletDerivation;
    this.treasuryWallet = treasuryWallet;
    this.telemetryEmitter = telemetryEmitter;
    this.fundingHistory = new Map();
    this.evmProvider = evmProvider;
    this.xrplClient = xrplClient;

    logger.info('AgentWalletFunder initialized', {
      evmInitialETH: config.evm.initialETH.toString(),
      xrpInitialXRP: config.xrp.initialXRP.toString(),
      maxFundingsPerAgent: config.rateLimits.maxFundingsPerAgent,
      maxFundingsPerHour: config.rateLimits.maxFundingsPerHour,
    });
  }

  /**
   * Funds agent wallet with initial ETH, ERC20 tokens, and XRP
   *
   * @param agentId - Agent identifier
   * @returns FundingResult with transaction details
   * @throws RateLimitExceededError if rate limit exceeded
   * @throws WalletNotFoundError if wallet does not exist
   */
  async fundAgentWallet(agentId: string): Promise<FundingResult> {
    // Check rate limits
    if (!this.checkRateLimit(agentId)) {
      const violatedLimit = this.determineViolatedLimit(agentId);
      this.emitRateLimitExceeded(agentId, violatedLimit);
      throw new RateLimitExceededError(agentId, violatedLimit);
    }

    // Get agent wallet
    const wallet = await this.walletDerivation.getAgentWallet(agentId);
    if (!wallet) {
      throw new WalletNotFoundError(agentId);
    }

    // Create funding result
    const result: FundingResult = {
      agentId,
      transactions: [],
      timestamp: Date.now(),
    };

    // Fund EVM wallet with ETH
    try {
      const ethTx = await this.fundEVMWallet(wallet.evmAddress, this.config.evm.initialETH);
      result.transactions.push(ethTx);
    } catch (error) {
      logger.error('Failed to fund EVM wallet with ETH', {
        agentId,
        evmAddress: wallet.evmAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue with other funding operations
    }

    // Fund EVM wallet with ERC20 tokens
    for (const [tokenAddress, amount] of Object.entries(this.config.evm.initialTokens)) {
      try {
        const tokenTx = await this.fundERC20Token(wallet.evmAddress, tokenAddress, amount);
        result.transactions.push(tokenTx);
      } catch (error) {
        logger.error('Failed to fund EVM wallet with ERC20', {
          agentId,
          evmAddress: wallet.evmAddress,
          tokenAddress,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue with other funding operations
      }
    }

    // Fund XRP wallet
    try {
      const xrpTx = await this.fundXRPWallet(wallet.xrpAddress, this.config.xrp.initialXRP);
      result.transactions.push(xrpTx);
    } catch (error) {
      logger.error('Failed to fund XRP wallet', {
        agentId,
        xrpAddress: wallet.xrpAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue (already at end)
    }

    // Record funding
    this.recordFunding(agentId, result);

    // Emit telemetry event
    this.emitWalletFunded(agentId, wallet.evmAddress, wallet.xrpAddress, result.transactions);

    logger.info('Agent wallet funded', {
      agentId,
      transactionCount: result.transactions.length,
    });

    return result;
  }

  /**
   * Funds EVM wallet with ETH
   * @private
   */
  private async fundEVMWallet(address: string, amount: bigint): Promise<FundingTransaction> {
    const tx = await this.treasuryWallet.sendETH(address, amount);
    return {
      chain: 'evm',
      token: 'ETH',
      to: address,
      amount: amount.toString(),
      txHash: tx.hash,
      status: 'pending',
    };
  }

  /**
   * Funds EVM wallet with ERC20 tokens
   * @private
   */
  private async fundERC20Token(
    address: string,
    tokenAddress: string,
    amount: bigint
  ): Promise<FundingTransaction> {
    const tx = await this.treasuryWallet.sendERC20(address, tokenAddress, amount);
    return {
      chain: 'evm',
      token: tokenAddress,
      to: address,
      amount: amount.toString(),
      txHash: tx.hash,
      status: 'pending',
    };
  }

  /**
   * Funds XRP wallet
   * @private
   */
  private async fundXRPWallet(address: string, amount: bigint): Promise<FundingTransaction> {
    const tx = await this.treasuryWallet.sendXRP(address, amount);
    return {
      chain: 'xrp',
      token: 'XRP',
      to: address,
      amount: amount.toString(),
      txHash: tx.hash,
      status: 'pending',
    };
  }

  /**
   * Checks if funding is allowed based on rate limits
   * @private
   */
  private checkRateLimit(agentId: string): boolean {
    const history = this.fundingHistory.get(agentId) || [];

    // Check per-agent limit
    if (history.length >= this.config.rateLimits.maxFundingsPerAgent) {
      return false;
    }

    // Check per-hour limit (for all agents)
    const oneHourAgo = Date.now() - 3600000;
    let recentFundingsCount = 0;
    for (const records of this.fundingHistory.values()) {
      recentFundingsCount += records.filter((r) => r.timestamp > oneHourAgo).length;
    }
    if (recentFundingsCount >= this.config.rateLimits.maxFundingsPerHour) {
      return false;
    }

    return true;
  }

  /**
   * Determines which rate limit was violated
   * @private
   */
  private determineViolatedLimit(agentId: string): 'per_agent' | 'per_hour' {
    const history = this.fundingHistory.get(agentId) || [];
    if (history.length >= this.config.rateLimits.maxFundingsPerAgent) {
      return 'per_agent';
    }
    return 'per_hour';
  }

  /**
   * Records funding operation in history
   * @private
   */
  private recordFunding(agentId: string, result: FundingResult): void {
    const history = this.fundingHistory.get(agentId) || [];
    history.push({
      timestamp: result.timestamp,
      transactions: result.transactions,
    });
    this.fundingHistory.set(agentId, history);
  }

  /**
   * Tracks funding transaction confirmation on-chain
   *
   * @param agentId - Agent identifier
   * @param transaction - Funding transaction to track
   */
  async trackFundingTransaction(agentId: string, transaction: FundingTransaction): Promise<void> {
    try {
      if (transaction.chain === 'evm') {
        // Wait for EVM transaction confirmation (1 confirmation)
        const receipt = await this.evmProvider.waitForTransaction(transaction.txHash, 1);
        if (receipt && receipt.status === 1) {
          transaction.status = 'confirmed';
          this.emitTransactionConfirmed(agentId, transaction.txHash, 'evm');
          logger.info('EVM funding transaction confirmed', {
            agentId,
            txHash: transaction.txHash,
          });
        } else {
          transaction.status = 'failed';
          this.emitTransactionFailed(agentId, transaction.txHash, 'evm', 'Transaction reverted');
          logger.error('EVM funding transaction failed', {
            agentId,
            txHash: transaction.txHash,
          });
        }
      } else {
        // Poll XRP transaction until validated
        const txResult = await this.xrplClient.request({
          command: 'tx',
          transaction: transaction.txHash,
        });
        if (txResult.result.validated) {
          transaction.status = 'confirmed';
          this.emitTransactionConfirmed(agentId, transaction.txHash, 'xrp');
          logger.info('XRP funding transaction confirmed', {
            agentId,
            txHash: transaction.txHash,
          });
        } else {
          transaction.status = 'failed';
          this.emitTransactionFailed(
            agentId,
            transaction.txHash,
            'xrp',
            'Transaction not validated'
          );
          logger.error('XRP funding transaction not validated', {
            agentId,
            txHash: transaction.txHash,
          });
        }
      }
    } catch (error) {
      transaction.status = 'failed';
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emitTransactionFailed(agentId, transaction.txHash, transaction.chain, errorMessage);
      logger.error('Failed to track funding transaction', {
        agentId,
        txHash: transaction.txHash,
        error: errorMessage,
      });
    }
  }

  /**
   * Gets funding history for agent
   *
   * @param agentId - Agent identifier
   * @returns Array of funding records
   */
  getFundingHistory(agentId: string): FundingRecord[] {
    return this.fundingHistory.get(agentId) || [];
  }

  /**
   * Emits wallet funded telemetry event
   * @private
   */
  private emitWalletFunded(
    agentId: string,
    evmAddress: string,
    xrpAddress: string,
    transactions: FundingTransaction[]
  ): void {
    try {
      const event: AgentWalletFundedEvent = {
        type: 'AGENT_WALLET_FUNDED',
        agentId,
        evmAddress,
        xrpAddress,
        transactions,
        timestamp: new Date().toISOString(),
      };
      this.telemetryEmitter.emit(event);
    } catch (error) {
      // Non-blocking telemetry
      logger.warn('Failed to emit wallet funded telemetry', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Emits rate limit exceeded telemetry event
   * @private
   */
  private emitRateLimitExceeded(agentId: string, violatedLimit: 'per_agent' | 'per_hour'): void {
    try {
      const event: FundingRateLimitExceededEvent = {
        type: 'FUNDING_RATE_LIMIT_EXCEEDED',
        agentId,
        violatedLimit,
        timestamp: new Date().toISOString(),
      };
      this.telemetryEmitter.emit(event);
    } catch (error) {
      // Non-blocking telemetry
      logger.warn('Failed to emit rate limit telemetry', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Emits transaction confirmed telemetry event
   * @private
   */
  private emitTransactionConfirmed(agentId: string, txHash: string, chain: string): void {
    try {
      const event: FundingTransactionConfirmedEvent = {
        type: 'FUNDING_TRANSACTION_CONFIRMED',
        agentId,
        txHash,
        chain,
        status: 'confirmed',
        timestamp: new Date().toISOString(),
      };
      this.telemetryEmitter.emit(event);
    } catch (error) {
      // Non-blocking telemetry
      logger.warn('Failed to emit transaction confirmed telemetry', {
        agentId,
        txHash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Emits transaction failed telemetry event
   * @private
   */
  private emitTransactionFailed(
    agentId: string,
    txHash: string,
    chain: string,
    errorMessage: string
  ): void {
    try {
      const event: FundingTransactionFailedEvent = {
        type: 'FUNDING_TRANSACTION_FAILED',
        agentId,
        txHash,
        chain,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      };
      this.telemetryEmitter.emit(event);
    } catch (error) {
      // Non-blocking telemetry
      logger.warn('Failed to emit transaction failed telemetry', {
        agentId,
        txHash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
