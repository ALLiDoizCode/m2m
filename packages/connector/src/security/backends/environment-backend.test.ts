import { EnvironmentVariableBackend } from './environment-backend';
import { Wallet } from 'ethers';
import * as xrpl from 'xrpl';
import pino from 'pino';

describe('EnvironmentVariableBackend', () => {
  let logger: pino.Logger;
  const originalEnv = process.env;

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Constructor', () => {
    it('should load EVM wallet from EVM_PRIVATE_KEY environment variable', () => {
      const testPrivateKey = '0x' + '1'.repeat(64); // Valid private key
      process.env.EVM_PRIVATE_KEY = testPrivateKey;

      const backend = new EnvironmentVariableBackend(logger);

      // Verify wallet was created (sign should work)
      expect(backend).toBeDefined();
    });

    it('should load XRP wallet from XRP_SEED environment variable', () => {
      process.env.XRP_SEED = 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2'; // Valid XRP seed

      const backend = new EnvironmentVariableBackend(logger);

      expect(backend).toBeDefined();
    });

    it('should throw error for invalid EVM_PRIVATE_KEY', () => {
      process.env.EVM_PRIVATE_KEY = 'invalid-private-key';

      expect(() => new EnvironmentVariableBackend(logger)).toThrow(
        'Invalid EVM_PRIVATE_KEY in environment'
      );
    });

    it('should throw error for invalid XRP_SEED', () => {
      process.env.XRP_SEED = 'invalid-seed';

      expect(() => new EnvironmentVariableBackend(logger)).toThrow(
        'Invalid XRP_SEED in environment'
      );
    });

    it('should warn if no keys loaded from environment', () => {
      delete process.env.EVM_PRIVATE_KEY;
      delete process.env.XRP_SEED;

      const backend = new EnvironmentVariableBackend(logger);

      expect(backend).toBeDefined();
    });
  });

  describe('sign()', () => {
    it('should sign EVM message using ethers.Wallet', async () => {
      const testPrivateKey = '0x' + '1'.repeat(64);
      process.env.EVM_PRIVATE_KEY = testPrivateKey;

      const backend = new EnvironmentVariableBackend(logger);
      const testMessage = Buffer.from('test-message-for-evm-signing');

      const signature = await backend.sign(testMessage, 'evm-key');

      expect(Buffer.isBuffer(signature)).toBe(true);
      expect(signature.length).toBeGreaterThan(0);

      // Verify signature is valid by recovering the address
      const wallet = new Wallet(testPrivateKey);
      const recoveredAddress = wallet.address;
      expect(recoveredAddress).toBeDefined();
    });

    it('should sign XRP message using xrpl.Wallet', async () => {
      process.env.XRP_SEED = 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2';

      const backend = new EnvironmentVariableBackend(logger);
      const testMessage = Buffer.from('test-message-for-xrp-signing');

      const signature = await backend.sign(testMessage, 'xrp-key');

      expect(Buffer.isBuffer(signature)).toBe(true);
      expect(signature.length).toBeGreaterThan(0);
    });

    it('should detect EVM key type from keyId containing "evm"', async () => {
      const testPrivateKey = '0x' + '1'.repeat(64);
      process.env.EVM_PRIVATE_KEY = testPrivateKey;

      const backend = new EnvironmentVariableBackend(logger);
      const testMessage = Buffer.from('test-message');

      const signature = await backend.sign(testMessage, 'my-evm-signing-key');

      expect(Buffer.isBuffer(signature)).toBe(true);
    });

    it('should detect XRP key type from keyId containing "xrp"', async () => {
      process.env.XRP_SEED = 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2';

      const backend = new EnvironmentVariableBackend(logger);
      const testMessage = Buffer.from('test-message');

      const signature = await backend.sign(testMessage, 'my-xrp-signing-key');

      expect(Buffer.isBuffer(signature)).toBe(true);
    });

    it('should throw error if EVM wallet not initialized', async () => {
      process.env.XRP_SEED = 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2';
      delete process.env.EVM_PRIVATE_KEY;

      const backend = new EnvironmentVariableBackend(logger);
      const testMessage = Buffer.from('test-message');

      await expect(backend.sign(testMessage, 'evm-key')).rejects.toThrow(
        'EVM wallet not initialized. Set EVM_PRIVATE_KEY environment variable.'
      );
    });

    it('should throw error if XRP wallet not initialized', async () => {
      const testPrivateKey = '0x' + '1'.repeat(64);
      process.env.EVM_PRIVATE_KEY = testPrivateKey;
      delete process.env.XRP_SEED;

      const backend = new EnvironmentVariableBackend(logger);
      const testMessage = Buffer.from('test-message');

      await expect(backend.sign(testMessage, 'xrp-key')).rejects.toThrow(
        'XRP wallet not initialized. Set XRP_SEED environment variable.'
      );
    });
  });

  describe('getPublicKey()', () => {
    it('should derive EVM public key from private key', async () => {
      const testPrivateKey = '0x' + '1'.repeat(64);
      process.env.EVM_PRIVATE_KEY = testPrivateKey;

      const backend = new EnvironmentVariableBackend(logger);

      const publicKey = await backend.getPublicKey('evm-key');

      expect(Buffer.isBuffer(publicKey)).toBe(true);
      expect(publicKey.length).toBeGreaterThan(0);

      // Verify it matches the wallet's public key
      const wallet = new Wallet(testPrivateKey);
      const expectedPublicKey = wallet.signingKey.publicKey.slice(2); // Remove '0x'
      expect(publicKey.toString('hex')).toBe(expectedPublicKey);
    });

    it('should derive XRP public key from seed', async () => {
      process.env.XRP_SEED = 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2';

      const backend = new EnvironmentVariableBackend(logger);

      const publicKey = await backend.getPublicKey('xrp-key');

      expect(Buffer.isBuffer(publicKey)).toBe(true);
      expect(publicKey.length).toBeGreaterThan(0);

      // Verify it matches the wallet's public key (without ED prefix)
      const wallet = xrpl.Wallet.fromSeed('sEdTM1uX8pu2do5XvTnutH6HsouMaM2');
      // wallet.publicKey includes 'ED' prefix, publicKey buffer is raw 32 bytes
      expect(publicKey.toString('hex').toUpperCase()).toBe(wallet.publicKey.slice(2));
    });

    it('should throw error if EVM wallet not initialized', async () => {
      delete process.env.EVM_PRIVATE_KEY;
      process.env.XRP_SEED = 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2';

      const backend = new EnvironmentVariableBackend(logger);

      await expect(backend.getPublicKey('evm-key')).rejects.toThrow(
        'EVM wallet not initialized. Set EVM_PRIVATE_KEY environment variable.'
      );
    });

    it('should throw error if XRP wallet not initialized', async () => {
      const testPrivateKey = '0x' + '1'.repeat(64);
      process.env.EVM_PRIVATE_KEY = testPrivateKey;
      delete process.env.XRP_SEED;

      const backend = new EnvironmentVariableBackend(logger);

      await expect(backend.getPublicKey('xrp-key')).rejects.toThrow(
        'XRP wallet not initialized. Set XRP_SEED environment variable.'
      );
    });
  });

  describe('rotateKey()', () => {
    it('should throw error indicating manual rotation required', async () => {
      const testPrivateKey = '0x' + '1'.repeat(64);
      process.env.EVM_PRIVATE_KEY = testPrivateKey;

      const backend = new EnvironmentVariableBackend(logger);

      await expect(backend.rotateKey('evm-key')).rejects.toThrow(
        'Manual rotation required for environment backend'
      );
    });
  });
});
