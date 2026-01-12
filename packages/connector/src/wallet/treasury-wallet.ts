import { ethers } from 'ethers';
import { Client as XRPLClient, Wallet as XRPLWallet, Payment } from 'xrpl';
import pino from 'pino';

const logger = pino({ name: 'treasury-wallet' });

/**
 * ERC20 ABI for transfer function only
 */
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
];

/**
 * Transaction result interface
 */
export interface Transaction {
  hash: string;
  to: string;
  value?: string;
}

/**
 * TreasuryWallet manages the platform's treasury for funding agent wallets.
 *
 * Handles:
 * - ETH transfers for EVM gas
 * - ERC20 token transfers for platform tokens
 * - XRP transfers for XRP Ledger accounts
 *
 * Security: Private keys loaded from environment variables only.
 * NEVER stores or logs private keys.
 */
export class TreasuryWallet {
  private evmWallet: ethers.Wallet;
  private xrpWallet: XRPLWallet;
  private evmProvider: ethers.Provider;
  private xrplClient: XRPLClient;
  public readonly evmAddress: string;
  public readonly xrpAddress: string;

  /**
   * Creates a new TreasuryWallet instance
   *
   * @param evmPrivateKey - EVM private key (hex string with 0x prefix)
   * @param xrpPrivateKey - XRP private key (secret string starting with 's')
   * @param evmProvider - Ethers provider for EVM blockchain
   * @param xrplClient - XRPL client for XRP Ledger
   */
  constructor(
    evmPrivateKey: string,
    xrpPrivateKey: string,
    evmProvider: ethers.Provider,
    xrplClient: XRPLClient
  ) {
    // Validate private keys are present
    if (!evmPrivateKey || !xrpPrivateKey) {
      throw new Error('Treasury private keys are required');
    }

    try {
      // Initialize EVM wallet
      this.evmProvider = evmProvider;
      this.evmWallet = new ethers.Wallet(evmPrivateKey, evmProvider);
      this.evmAddress = this.evmWallet.address;

      // Initialize XRP wallet
      this.xrplClient = xrplClient;
      this.xrpWallet = XRPLWallet.fromSecret(xrpPrivateKey);
      this.xrpAddress = this.xrpWallet.address;

      logger.info('Treasury wallet initialized', {
        evmAddress: this.evmAddress,
        xrpAddress: this.xrpAddress,
      });
    } catch (error) {
      // CRITICAL: Never log private keys in error messages
      logger.error('Failed to initialize treasury wallet', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Failed to initialize treasury wallet');
    }
  }

  /**
   * Sends ETH from treasury to recipient address
   *
   * @param to - Recipient EVM address
   * @param amount - Amount in wei (bigint)
   * @returns Transaction object with hash
   */
  async sendETH(to: string, amount: bigint): Promise<Transaction> {
    try {
      // Validate recipient address
      if (!ethers.isAddress(to)) {
        throw new Error(`Invalid EVM address: ${to}`);
      }

      // Get current fee data for gas pricing
      const feeData = await this.evmProvider.getFeeData();

      // Create transaction
      const tx = await this.evmWallet.sendTransaction({
        to,
        value: amount,
        gasLimit: 21000, // Standard ETH transfer gas limit
        maxFeePerGas: feeData.maxFeePerGas ?? undefined,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
      });

      logger.info('ETH sent', {
        to,
        amount: amount.toString(),
        txHash: tx.hash,
      });

      return {
        hash: tx.hash,
        to: tx.to ?? to,
        value: amount.toString(),
      };
    } catch (error) {
      logger.error('Failed to send ETH', {
        to,
        amount: amount.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Sends ERC20 tokens from treasury to recipient address
   *
   * @param to - Recipient EVM address
   * @param tokenAddress - ERC20 token contract address
   * @param amount - Amount in token's smallest unit (bigint)
   * @returns Transaction object with hash
   */
  async sendERC20(to: string, tokenAddress: string, amount: bigint): Promise<Transaction> {
    try {
      // Validate addresses
      if (!ethers.isAddress(to)) {
        throw new Error(`Invalid recipient address: ${to}`);
      }
      if (!ethers.isAddress(tokenAddress)) {
        throw new Error(`Invalid token address: ${tokenAddress}`);
      }

      // Create ERC20 contract instance
      const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.evmWallet);

      // Send tokens
      const tx = await tokenContract.transfer!(to, amount);

      logger.info('ERC20 sent', {
        to,
        tokenAddress,
        amount: amount.toString(),
        txHash: tx.hash,
      });

      return {
        hash: tx.hash,
        to,
      };
    } catch (error) {
      logger.error('Failed to send ERC20', {
        to,
        tokenAddress,
        amount: amount.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Sends XRP from treasury to recipient address
   *
   * Note: XRP requires 10 XRP minimum account reserve.
   * This method should be called with at least 15 XRP for new accounts.
   *
   * @param to - Recipient XRP address
   * @param amount - Amount in drops (bigint, 1 XRP = 1,000,000 drops)
   * @returns Transaction object with hash
   */
  async sendXRP(to: string, amount: bigint): Promise<Transaction> {
    try {
      // Create XRP payment transaction
      const payment: Payment = {
        TransactionType: 'Payment',
        Account: this.xrpWallet.address,
        Destination: to,
        Amount: amount.toString(), // XRPL expects string for Amount
      };

      // Submit and wait for transaction result
      const result = await this.xrplClient.submitAndWait(payment, {
        wallet: this.xrpWallet,
      });

      // Extract transaction hash
      const txHash =
        typeof result.result.hash === 'string'
          ? result.result.hash
          : ((result.result.tx_json?.hash as string | undefined) ?? 'unknown');

      logger.info('XRP sent', {
        to,
        amount: amount.toString(),
        txHash,
      });

      return {
        hash: txHash,
        to,
        value: amount.toString(),
      };
    } catch (error) {
      logger.error('Failed to send XRP', {
        to,
        amount: amount.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Gets current balance of treasury wallet
   *
   * @param chain - Blockchain ('evm' or 'xrp')
   * @param token - Token identifier ('ETH', '0xTokenAddress', or 'XRP')
   * @returns Balance as bigint
   */
  async getBalance(chain: 'evm' | 'xrp', token: string): Promise<bigint> {
    try {
      if (chain === 'evm') {
        if (token === 'ETH' || token.toLowerCase() === 'eth') {
          // Get ETH balance
          const balance = await this.evmProvider.getBalance(this.evmAddress);
          return balance;
        } else {
          // Get ERC20 balance
          if (!ethers.isAddress(token)) {
            throw new Error(`Invalid token address: ${token}`);
          }
          const tokenContract = new ethers.Contract(token, ERC20_ABI, this.evmProvider);
          const balance = await tokenContract.balanceOf!(this.evmAddress);
          return balance;
        }
      } else {
        // Get XRP balance
        const accountInfo = await this.xrplClient.request({
          command: 'account_info',
          account: this.xrpAddress,
        });
        const balance = BigInt(accountInfo.result.account_data.Balance);
        return balance;
      }
    } catch (error) {
      logger.error('Failed to get balance', {
        chain,
        token,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
