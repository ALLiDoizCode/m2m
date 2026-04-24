/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

import { EnvironmentVariableBackend } from '../../../../src/security/backends/environment-backend';

const mockLogger = {
  child: jest.fn().mockReturnThis(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

describe('EnvironmentVariableBackend', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.EVM_PRIVATE_KEY;
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load key from options.evmPrivateKey', () => {
    new EnvironmentVariableBackend(mockLogger as any, {
      evmPrivateKey: '0x' + 'a'.repeat(64),
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      'EVM private key found in environment (wallet initialization deferred)'
    );
  });

  it('should load key from process.env.EVM_PRIVATE_KEY', () => {
    process.env.EVM_PRIVATE_KEY = '0x' + 'b'.repeat(64);
    new EnvironmentVariableBackend(mockLogger as any);
    expect(mockLogger.info).toHaveBeenCalled();
  });

  it('should warn when no key is available', () => {
    new EnvironmentVariableBackend(mockLogger as any);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'No EVM private key loaded from environment (EVM_PRIVATE_KEY)'
    );
  });

  it('should prefer options over env var', () => {
    process.env.EVM_PRIVATE_KEY = '0x' + 'b'.repeat(64);
    new EnvironmentVariableBackend(mockLogger as any, {
      evmPrivateKey: '0x' + 'a'.repeat(64),
    });
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
  });

  it('should throw on sign without key', async () => {
    const backend = new EnvironmentVariableBackend(mockLogger as any);
    await expect(backend.sign(Buffer.from('test'), 'key1')).rejects.toThrow(
      'EVM wallet not initialized. Set EVM_PRIVATE_KEY environment variable.'
    );
  });

  it('should throw on getPublicKey without key', async () => {
    const backend = new EnvironmentVariableBackend(mockLogger as any);
    await expect(backend.getPublicKey('key1')).rejects.toThrow(
      'EVM wallet not initialized. Set EVM_PRIVATE_KEY environment variable.'
    );
  });

  it('should rotateKey throw unsupported', async () => {
    const backend = new EnvironmentVariableBackend(mockLogger as any);
    await expect(backend.rotateKey('key1')).rejects.toThrow(
      'Manual rotation required for environment backend'
    );
  });

  it('should handle invalid EVM_PRIVATE_KEY', async () => {
    process.env.EVM_PRIVATE_KEY = 'invalid-key';
    const backend = new EnvironmentVariableBackend(mockLogger as any);
    await expect(backend.sign(Buffer.from('test'), 'key1')).rejects.toThrow();
  });
});
