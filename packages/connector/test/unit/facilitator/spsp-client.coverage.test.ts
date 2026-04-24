/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

import { SPSPClient, SPSPError } from '../../../src/facilitator/spsp-client';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
};

describe('SPSPClient branch coverage', () => {
  let client: SPSPClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new SPSPClient(mockLogger as any, 1000);
  });

  it('should throw on invalid payment pointer format', async () => {
    await expect(client.resolvePaymentPointer('invalid')).rejects.toThrow(SPSPError);
  });

  it('should throw SPSPError for non-404 HTTP errors', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: jest.fn(),
    });

    await expect(client.resolvePaymentPointer('$example.com/user')).rejects.toThrow(
      'SPSP handshake failed: 500'
    );
  });

  it('should throw for invalid SPSP response missing fields', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ destination_account: 'test' }),
    });

    await expect(client.resolvePaymentPointer('$example.com/user')).rejects.toThrow(
      'Invalid SPSP response'
    );
  });

  it('should throw for DNS errors', async () => {
    global.fetch = jest.fn().mockRejectedValue({ code: 'ENOTFOUND' });

    await expect(client.resolvePaymentPointer('$example.com/user')).rejects.toThrow(
      'Peer unreachable'
    );
  });

  it('should retry on timeout and eventually fail', async () => {
    const abortError = new Error('Timeout');
    abortError.name = 'AbortError';
    global.fetch = jest.fn().mockRejectedValue(abortError);

    await expect(client.resolvePaymentPointer('$example.com/user')).rejects.toThrow('SPSP timeout');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1 }),
      'SPSP timeout, retrying'
    );
  });

  it('should retry on generic network errors and eventually fail', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network down'));

    await expect(client.resolvePaymentPointer('$example.com/user')).rejects.toThrow(
      'SPSP handshake failed: Network down'
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1 }),
      'SPSP error, retrying'
    );
  });

  it('should throw for unknown errors with no message', async () => {
    global.fetch = jest.fn().mockRejectedValue({});

    await expect(client.resolvePaymentPointer('$example.com/user')).rejects.toThrow(
      'SPSP handshake failed: Unknown error'
    );
  });

  it('should resolve successfully on first attempt', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        destination_account: 'test.account',
        shared_secret: 'c2VjcmV0', // base64 for 'secret'
      }),
    });

    const result = await client.resolvePaymentPointer('$example.com/user');
    expect(result.destination_account).toBe('test.account');
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ paymentPointer: '$example.com/user' }),
      'SPSP handshake complete'
    );
  });

  it('should resolve successfully on retry', async () => {
    const abortError = new Error('Timeout');
    abortError.name = 'AbortError';
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          destination_account: 'test.account',
          shared_secret: 'c2VjcmV0',
        }),
      });

    const result = await client.resolvePaymentPointer('$example.com/user');
    expect(result.destination_account).toBe('test.account');
  });
});
