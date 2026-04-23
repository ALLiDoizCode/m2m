/**
 * OnboardingWizard Comprehensive Branch-Coverage Unit Tests
 *
 * Covers all branches in onboarding-wizard.ts including:
 * - Validation logic (Ethereum addresses, ports, node IDs)
 * - Wizard prompt flows and defaults
 * - .env generation for all key backends and monitoring flags
 * - File write operations and error handling
 * - Overwrite confirmations and cancellation paths
 */

import {
  validateEthereumAddress,
  generateEnvFile,
  writeEnvFile,
  runOnboarding,
  runOnboardingWizard,
} from '../../../src/cli/onboarding-wizard';
import inquirer from 'inquirer';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { OnboardingConfig } from '../../../src/cli/types';

jest.mock('inquirer', () => ({
  prompt: jest.fn(),
}));

jest.mock('fs/promises', () => ({
  access: jest.fn(),
  mkdir: jest.fn(),
  writeFile: jest.fn(),
}));

jest.mock('path', () => ({
  resolve: jest.fn((_p: string) => `/resolved/${_p}`),
  dirname: jest.fn(() => `/resolved/dir`),
  join: jest.fn((...args: string[]) => args.join('/')),
}));

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedPath = path as jest.Mocked<typeof path>;

describe('OnboardingWizard Branch Coverage', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(process, 'cwd').mockReturnValue('/mocked/cwd');
    jest.clearAllMocks();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    jest.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // 1. Constructor / helpers
  // --------------------------------------------------------------------------

  describe('validateEthereumAddress', () => {
    it('should accept a valid mixed-case address', () => {
      expect(validateEthereumAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f12AB3')).toBe(true);
    });

    it('should reject an address without 0x prefix', () => {
      expect(validateEthereumAddress('742d35Cc6634C0532925a3b844Bc9e7595f12AB3')).toBe(false);
    });

    it('should reject an address that is too short', () => {
      expect(validateEthereumAddress('0x742d35Cc6634C0532925a3b844Bc9e759')).toBe(false);
    });

    it('should reject an address that is too long', () => {
      expect(validateEthereumAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f12AB3aa')).toBe(false);
    });

    it('should reject an address with invalid characters', () => {
      expect(validateEthereumAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f12ZZZ')).toBe(false);
    });

    it('should reject an empty string', () => {
      expect(validateEthereumAddress('')).toBe(false);
    });

    it('should reject an address containing spaces', () => {
      expect(validateEthereumAddress('0x742d35Cc6634C0532925a3b844Bc 9e7595f12AB3')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 2. runOnboardingWizard() flow
  // --------------------------------------------------------------------------

  describe('runOnboardingWizard', () => {
    const setupPromptSequence = (overrides?: Partial<OnboardingConfig>) => {
      const base: OnboardingConfig = {
        nodeId: 'my-node',
        settlementPreference: 'evm',
        evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f12AB3',
        keyBackend: 'env',
        enableMonitoring: true,
        btpPort: 4000,
        healthCheckPort: 8080,
        logLevel: 'info',
        ...overrides,
      };

      (inquirer.prompt as jest.Mock)
        .mockResolvedValueOnce({
          nodeId: base.nodeId,
          settlementPreference: base.settlementPreference,
        })
        .mockResolvedValueOnce({ evmAddress: base.evmAddress })
        .mockResolvedValueOnce({ keyBackend: base.keyBackend })
        .mockResolvedValueOnce({
          enableMonitoring: base.enableMonitoring,
          btpPort: base.btpPort,
          healthCheckPort: base.healthCheckPort,
          logLevel: base.logLevel,
        });
    };

    it('should return a complete config object after all prompts', async () => {
      setupPromptSequence();

      const config = await runOnboardingWizard();

      expect(config).toEqual({
        nodeId: 'my-node',
        settlementPreference: 'evm',
        evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f12AB3',
        keyBackend: 'env',
        enableMonitoring: true,
        btpPort: 4000,
        healthCheckPort: 8080,
        logLevel: 'info',
      });
      expect(inquirer.prompt).toHaveBeenCalledTimes(4);
    });

    it('should print the welcome banner on startup', async () => {
      setupPromptSequence();
      await runOnboardingWizard();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('M2M Connector Onboarding Wizard')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('This wizard will guide you')
      );
    });

    it('should default nodeId to connector-{hex} pattern', async () => {
      setupPromptSequence();
      await runOnboardingWizard();

      const firstPrompt = (inquirer.prompt as jest.Mock).mock.calls[0][0];
      const defaultValue = firstPrompt[0].default;

      expect(defaultValue).toMatch(/^connector-[a-f0-9]{8}$/);
    });

    describe('prompt validators', () => {
      it('should validate nodeId (empty, invalid chars, valid)', async () => {
        setupPromptSequence();
        await runOnboardingWizard();

        const firstPrompt = (inquirer.prompt as jest.Mock).mock.calls[0][0];
        const validate = firstPrompt[0].validate;

        expect(validate('')).toBe('Node ID cannot be empty');
        expect(validate('   ')).toBe('Node ID cannot be empty');
        expect(validate('bad chars!')).toBe(
          'Node ID can only contain letters, numbers, hyphens, and underscores'
        );
        expect(validate('valid-node_123')).toBe(true);
      });

      it('should validate evmAddress (empty, invalid format, valid)', async () => {
        setupPromptSequence();
        await runOnboardingWizard();

        const secondPrompt = (inquirer.prompt as jest.Mock).mock.calls[1][0];
        const validate = secondPrompt[0].validate;

        expect(validate('')).toBe('Ethereum address is required for EVM settlement');
        expect(validate('0x123')).toBe(
          'Invalid Ethereum address format. Must be 0x followed by 40 hex characters.'
        );
        expect(validate('not-an-address')).toBe(
          'Invalid Ethereum address format. Must be 0x followed by 40 hex characters.'
        );
        expect(validate('0x742d35Cc6634C0532925a3b844Bc9e7595f12AB3')).toBe(true);
      });

      it('should validate btpPort (out of range, non-integer, valid)', async () => {
        setupPromptSequence();
        await runOnboardingWizard();

        const fourthPrompt = (inquirer.prompt as jest.Mock).mock.calls[3][0];
        const validate = fourthPrompt[1].validate;

        expect(validate(0)).toBe('Port must be a valid number between 1 and 65535');
        expect(validate(70000)).toBe('Port must be a valid number between 1 and 65535');
        expect(validate(1.5)).toBe('Port must be a valid number between 1 and 65535');
        expect(validate(-1)).toBe('Port must be a valid number between 1 and 65535');
        expect(validate(4000)).toBe(true);
      });

      it('should validate healthCheckPort (out of range, valid)', async () => {
        setupPromptSequence();
        await runOnboardingWizard();

        const fourthPrompt = (inquirer.prompt as jest.Mock).mock.calls[3][0];
        const validate = fourthPrompt[2].validate;

        expect(validate(0)).toBe('Port must be a valid number between 1 and 65535');
        expect(validate(70000)).toBe('Port must be a valid number between 1 and 65535');
        expect(validate(8080)).toBe(true);
      });
    });
  });

  // --------------------------------------------------------------------------
  // 3. generateEnvFile() branches
  // --------------------------------------------------------------------------

  describe('generateEnvFile', () => {
    const baseConfig: OnboardingConfig = {
      nodeId: 'test-node',
      settlementPreference: 'evm',
      evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f12AB3',
      keyBackend: 'env',
      enableMonitoring: true,
      btpPort: 4000,
      healthCheckPort: 8080,
      logLevel: 'info',
    };

    it('should include common configuration lines', () => {
      const env = generateEnvFile(baseConfig);
      expect(env).toContain('NODE_ID=test-node');
      expect(env).toContain('SETTLEMENT_PREFERENCE=evm');
      expect(env).toContain('BASE_RPC_URL=https://mainnet.base.org');
      expect(env).toContain('BTP_PORT=4000');
      expect(env).toContain('HEALTH_CHECK_PORT=8080');
      expect(env).toContain('LOG_LEVEL=info');
      expect(env).toContain('PROMETHEUS_ENABLED=true');
      expect(env).toContain('TIGERBEETLE_CLUSTER_ID=0');
      expect(env).toContain('PEER_DISCOVERY_ENABLED=false');
    });

    it('should include env backend warning and private-key comment', () => {
      const env = generateEnvFile({ ...baseConfig, keyBackend: 'env' });
      expect(env).toContain('KEY_BACKEND=env');
      expect(env).toContain('WARNING: env backend is for development only!');
      expect(env).toContain('# EVM_PRIVATE_KEY=0x...');
    });

    it('should include AWS KMS config when aws-kms backend selected', () => {
      const env = generateEnvFile({ ...baseConfig, keyBackend: 'aws-kms' });
      expect(env).toContain('KEY_BACKEND=aws-kms');
      expect(env).toContain('AWS_REGION=us-east-1');
      expect(env).toContain('# AWS_KMS_EVM_KEY_ID=arn:aws:kms:...');
    });

    it('should include GCP KMS config when gcp-kms backend selected', () => {
      const env = generateEnvFile({ ...baseConfig, keyBackend: 'gcp-kms' });
      expect(env).toContain('KEY_BACKEND=gcp-kms');
      expect(env).toContain('GCP_LOCATION_ID=us-east1');
      expect(env).toContain('GCP_KEY_RING_ID=connector-keyring');
      expect(env).toContain('# GCP_KMS_EVM_KEY_ID=evm-signing-key');
    });

    it('should include Azure Key Vault config when azure-kv backend selected', () => {
      const env = generateEnvFile({ ...baseConfig, keyBackend: 'azure-kv' });
      expect(env).toContain('KEY_BACKEND=azure-kv');
      expect(env).toContain('AZURE_EVM_KEY_NAME=evm-signing-key');
      expect(env).toContain('# AZURE_VAULT_URL=https://my-vault.vault.azure.net');
    });

    it('should include Grafana password when monitoring is enabled', () => {
      const env = generateEnvFile({ ...baseConfig, enableMonitoring: true });
      expect(env).toContain('GRAFANA_PASSWORD=admin');
    });

    it('should omit Grafana password when monitoring is disabled', () => {
      const env = generateEnvFile({ ...baseConfig, enableMonitoring: false });
      expect(env).not.toContain('GRAFANA_PASSWORD');
      expect(env).toContain('PROMETHEUS_ENABLED=false');
    });

    it('should handle missing evmAddress by writing an empty value', () => {
      const env = generateEnvFile({ ...baseConfig, evmAddress: undefined });
      expect(env).toContain('EVM_ADDRESS=');
      expect(env).not.toContain('EVM_ADDRESS=0x');
    });
  });

  // --------------------------------------------------------------------------
  // 4. writeEnvFile() branches
  // --------------------------------------------------------------------------

  describe('writeEnvFile', () => {
    it('should resolve path, create directory, and write file', async () => {
      mockedPath.resolve.mockReturnValue('/resolved/.env');
      mockedPath.dirname.mockReturnValue('/resolved');
      mockedFs.mkdir.mockResolvedValue(undefined);
      mockedFs.writeFile.mockResolvedValue(undefined);

      await writeEnvFile('NODE_ID=test', '.env');

      expect(mockedPath.resolve).toHaveBeenCalledWith('.env');
      expect(mockedPath.dirname).toHaveBeenCalledWith('/resolved/.env');
      expect(mockedFs.mkdir).toHaveBeenCalledWith('/resolved', { recursive: true });
      expect(mockedFs.writeFile).toHaveBeenCalledWith('/resolved/.env', 'NODE_ID=test', 'utf8');
    });

    it('should throw if directory creation fails', async () => {
      mockedFs.mkdir.mockRejectedValue(new Error('mkdir failed'));
      await expect(writeEnvFile('content', '.env')).rejects.toThrow('mkdir failed');
    });

    it('should throw if file write fails', async () => {
      mockedFs.mkdir.mockResolvedValue(undefined);
      mockedFs.writeFile.mockRejectedValue(new Error('writeFile failed'));
      await expect(writeEnvFile('content', '.env')).rejects.toThrow('writeFile failed');
    });
  });

  // --------------------------------------------------------------------------
  // 5. runOnboarding() flow
  // --------------------------------------------------------------------------

  describe('runOnboarding', () => {
    const setupWizardSequence = (overrides?: Partial<OnboardingConfig>) => {
      const base: OnboardingConfig = {
        nodeId: 'run-node',
        settlementPreference: 'evm',
        evmAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f12AB3',
        keyBackend: 'env',
        enableMonitoring: true,
        btpPort: 4000,
        healthCheckPort: 8080,
        logLevel: 'info',
        ...overrides,
      };

      (inquirer.prompt as jest.Mock)
        .mockResolvedValueOnce({
          nodeId: base.nodeId,
          settlementPreference: base.settlementPreference,
        })
        .mockResolvedValueOnce({ evmAddress: base.evmAddress })
        .mockResolvedValueOnce({ keyBackend: base.keyBackend })
        .mockResolvedValueOnce({
          enableMonitoring: base.enableMonitoring,
          btpPort: base.btpPort,
          healthCheckPort: base.healthCheckPort,
          logLevel: base.logLevel,
        });
    };

    it('should write .env when target file does not exist', async () => {
      mockedFs.access.mockRejectedValue(new Error('ENOENT'));
      mockedFs.mkdir.mockResolvedValue(undefined);
      mockedFs.writeFile.mockResolvedValue(undefined);
      setupWizardSequence();

      await runOnboarding('/output/.env');

      expect(mockedFs.access).toHaveBeenCalledWith('/output/.env');
      expect(mockedFs.writeFile).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Configuration Complete!'));
    });

    it('should overwrite existing file when user confirms', async () => {
      mockedFs.access.mockResolvedValue(undefined);
      mockedFs.mkdir.mockResolvedValue(undefined);
      mockedFs.writeFile.mockResolvedValue(undefined);
      setupWizardSequence();
      (inquirer.prompt as jest.Mock).mockResolvedValueOnce({ overwrite: true });

      await runOnboarding('/output/.env');

      expect(mockedFs.writeFile).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Configuration Complete!'));
    });

    it('should cancel and preserve existing file when user declines overwrite', async () => {
      mockedFs.access.mockResolvedValue(undefined);
      setupWizardSequence();
      (inquirer.prompt as jest.Mock).mockResolvedValueOnce({ overwrite: false });

      await runOnboarding('/output/.env');

      expect(mockedFs.writeFile).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Onboarding cancelled. Existing .env file preserved.')
      );
    });

    it('should default to cwd/.env when no outputPath is provided', async () => {
      mockedFs.access.mockRejectedValue(new Error('ENOENT'));
      mockedFs.mkdir.mockResolvedValue(undefined);
      mockedFs.writeFile.mockResolvedValue(undefined);
      setupWizardSequence();

      await runOnboarding();

      expect(mockedPath.join).toHaveBeenCalledWith('/mocked/cwd', '.env');
      expect(mockedFs.writeFile).toHaveBeenCalled();
    });

    it('should print env-backend-specific next steps', async () => {
      mockedFs.access.mockRejectedValue(new Error('ENOENT'));
      mockedFs.mkdir.mockResolvedValue(undefined);
      mockedFs.writeFile.mockResolvedValue(undefined);
      setupWizardSequence({ keyBackend: 'env' });

      await runOnboarding('/output/.env');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Add your private keys to the .env file')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('WARNING: Use KMS in production!')
      );
    });

    it('should print KMS-backend-specific next steps', async () => {
      mockedFs.access.mockRejectedValue(new Error('ENOENT'));
      mockedFs.mkdir.mockResolvedValue(undefined);
      mockedFs.writeFile.mockResolvedValue(undefined);
      setupWizardSequence({ keyBackend: 'aws-kms' });

      await runOnboarding('/output/.env');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Configure your aws-kms credentials')
      );
    });

    it('should handle user cancellation (Ctrl+C / force closed)', async () => {
      mockedFs.access.mockRejectedValue(new Error('ENOENT'));
      (inquirer.prompt as jest.Mock).mockImplementation(() => {
        return Promise.reject(new Error('User force closed the prompt'));
      });

      await runOnboarding('/output/.env');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Onboarding cancelled by user.')
      );
      expect(mockedFs.writeFile).not.toHaveBeenCalled();
    });

    it('should re-throw non-cancellation errors from the wizard', async () => {
      mockedFs.access.mockRejectedValue(new Error('ENOENT'));
      (inquirer.prompt as jest.Mock).mockImplementation(() => {
        return Promise.reject(new Error('Unexpected wizard failure'));
      });

      await expect(runOnboarding('/output/.env')).rejects.toThrow('Unexpected wizard failure');
    });

    it('should re-throw errors from writeEnvFile', async () => {
      mockedFs.access.mockRejectedValue(new Error('ENOENT'));
      mockedFs.mkdir.mockRejectedValue(new Error('disk full'));
      setupWizardSequence();

      await expect(runOnboarding('/output/.env')).rejects.toThrow('disk full');
    });
  });
});
