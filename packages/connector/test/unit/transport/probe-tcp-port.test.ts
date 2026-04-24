/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type, @typescript-eslint/ban-types, no-console */

import net from 'net';
import { probeTcpPort, waitForTcpPort } from '../../../src/transport/probe-tcp-port';

jest.mock('net');

describe('probeTcpPort', () => {
  let mockSocket: any;
  let createConnectionSpy: jest.SpyInstance;

  beforeEach(() => {
    mockSocket = {
      setTimeout: jest.fn(),
      removeAllListeners: jest.fn(),
      destroy: jest.fn(),
      once: jest.fn(),
    };
    createConnectionSpy = jest.spyOn(net, 'createConnection').mockReturnValue(mockSocket);
  });

  afterEach(() => {
    createConnectionSpy.mockRestore();
  });

  it('should resolve on successful connection', async () => {
    mockSocket.once.mockImplementation((event: string, handler: Function) => {
      if (event === 'connect') {
        setImmediate(() => handler());
      }
    });

    await expect(probeTcpPort('127.0.0.1', 9050, 1000)).resolves.toBeUndefined();
    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  it('should reject on timeout', async () => {
    mockSocket.once.mockImplementation((event: string, handler: Function) => {
      if (event === 'timeout') {
        setImmediate(() => handler());
      }
    });

    await expect(probeTcpPort('127.0.0.1', 9050, 500)).rejects.toThrow(
      'probe timed out after 500ms'
    );
    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  it('should reject on error', async () => {
    const testError = new Error('ECONNREFUSED');
    mockSocket.once.mockImplementation((event: string, handler: Function) => {
      if (event === 'error') {
        setImmediate(() => handler(testError));
      }
    });

    await expect(probeTcpPort('127.0.0.1', 9050, 500)).rejects.toThrow('ECONNREFUSED');
    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  it('should ignore late events after connect', async () => {
    let connectHandler: Function;
    let errorHandler: Function;
    mockSocket.once.mockImplementation((event: string, handler: Function) => {
      if (event === 'connect') connectHandler = handler;
      if (event === 'error') errorHandler = handler;
    });

    const promise = probeTcpPort('127.0.0.1', 9050, 500);
    setImmediate(() => connectHandler());
    setImmediate(() => errorHandler(new Error('late')));

    await expect(promise).resolves.toBeUndefined();
  });

  it('should ignore late events after timeout', async () => {
    let timeoutHandler: Function;
    let connectHandler: Function;
    mockSocket.once.mockImplementation((event: string, handler: Function) => {
      if (event === 'timeout') timeoutHandler = handler;
      if (event === 'connect') connectHandler = handler;
    });

    const promise = probeTcpPort('127.0.0.1', 9050, 500);
    setImmediate(() => timeoutHandler());
    setImmediate(() => connectHandler());

    await expect(promise).rejects.toThrow('probe timed out');
  });

  it('should set socket timeout correctly', async () => {
    mockSocket.once.mockImplementation((event: string, handler: Function) => {
      if (event === 'connect') setImmediate(() => handler());
    });

    await probeTcpPort('127.0.0.1', 9050, 1000);
    expect(mockSocket.setTimeout).toHaveBeenCalledWith(1000);
  });

  it('should pass correct host and port to createConnection', async () => {
    mockSocket.once.mockImplementation((event: string, handler: Function) => {
      if (event === 'connect') setImmediate(() => handler());
    });

    await probeTcpPort('example.com', 8080, 500);
    expect(net.createConnection).toHaveBeenCalledWith({ host: 'example.com', port: 8080 });
  });
});

describe('waitForTcpPort', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should resolve immediately on first success', async () => {
    let connectHandler: Function | undefined;
    const mockSocket = {
      setTimeout: jest.fn(),
      removeAllListeners: jest.fn(),
      destroy: jest.fn(),
      once: jest.fn().mockImplementation((event: string, handler: Function) => {
        if (event === 'connect') connectHandler = handler;
      }),
    };
    jest.spyOn(net, 'createConnection').mockReturnValue(mockSocket as any);

    const promise = waitForTcpPort('127.0.0.1', 9050, 5000);
    jest.advanceTimersByTime(1);
    connectHandler!();

    await expect(promise).resolves.toBeUndefined();
  });

  it('should reject when overall timeout expires', async () => {
    const mockSocket = {
      setTimeout: jest.fn(),
      removeAllListeners: jest.fn(),
      destroy: jest.fn(),
      once: jest.fn().mockImplementation((event: string, handler: Function) => {
        if (event === 'timeout') {
          setTimeout(() => handler(), 10);
        }
      }),
    };
    jest.spyOn(net, 'createConnection').mockReturnValue(mockSocket as any);

    const promise = waitForTcpPort('127.0.0.1', 9050, 200);
    jest.advanceTimersByTime(300);

    await expect(promise).rejects.toThrow('did not become ready within 200ms timeout');
  });

  it('should include last error in rejection message', async () => {
    const testError = new Error('connection refused');
    const mockSocket = {
      setTimeout: jest.fn(),
      removeAllListeners: jest.fn(),
      destroy: jest.fn(),
      once: jest.fn().mockImplementation((event: string, handler: Function) => {
        if (event === 'error') {
          setTimeout(() => handler(testError), 10);
        }
      }),
    };
    jest.spyOn(net, 'createConnection').mockReturnValue(mockSocket as any);

    const promise = waitForTcpPort('127.0.0.1', 9050, 200, 50, 50);
    jest.advanceTimersByTime(300);

    await expect(promise).rejects.toThrow('connection refused');
  });

  it('should use default probe and poll intervals', async () => {
    let connectHandler: Function | undefined;
    const mockSocket = {
      setTimeout: jest.fn(),
      removeAllListeners: jest.fn(),
      destroy: jest.fn(),
      once: jest.fn().mockImplementation((event: string, handler: Function) => {
        if (event === 'connect') connectHandler = handler;
      }),
    };
    jest.spyOn(net, 'createConnection').mockReturnValue(mockSocket as any);

    const promise = waitForTcpPort('127.0.0.1', 9050, 5000);
    jest.advanceTimersByTime(300);
    connectHandler!();

    await expect(promise).resolves.toBeUndefined();
  });

  it('should break early when deadline is near', async () => {
    const mockSocket = {
      setTimeout: jest.fn(),
      removeAllListeners: jest.fn(),
      destroy: jest.fn(),
      once: jest.fn().mockImplementation((event: string, handler: Function) => {
        if (event === 'timeout') {
          setTimeout(() => handler(), 10);
        }
      }),
    };
    jest.spyOn(net, 'createConnection').mockReturnValue(mockSocket as any);

    const promise = waitForTcpPort('127.0.0.1', 9050, 150, 100, 200);
    jest.advanceTimersByTime(300);

    await expect(promise).rejects.toThrow('did not become ready');
  });

  it('should adjust probe timeout based on remaining time', async () => {
    const mockSocket = {
      setTimeout: jest.fn(),
      removeAllListeners: jest.fn(),
      destroy: jest.fn(),
      once: jest.fn().mockImplementation((event: string, handler: Function) => {
        if (event === 'connect') {
          setTimeout(() => handler(), 10);
        }
      }),
    };
    jest.spyOn(net, 'createConnection').mockReturnValue(mockSocket as any);

    const promise = waitForTcpPort('127.0.0.1', 9050, 5000, 300, 100);
    jest.advanceTimersByTime(200);

    await expect(promise).resolves.toBeUndefined();
  });
});
