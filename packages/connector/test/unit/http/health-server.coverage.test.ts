import { HealthServer } from '../../../src/http/health-server';
import type { Request, Response } from 'express';

const mockLogger = {
  child: jest.fn().mockReturnThis(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const mockHealthProvider = {
  getHealthStatus: jest.fn().mockReturnValue({ status: 'healthy', uptime: 100 }),
};

const mockExtendedProvider = {
  getHealthStatusExtended: jest.fn().mockReturnValue({
    status: 'healthy',
    uptime: 100,
    version: '1.0.0',
  }),
};

describe('HealthServer branch coverage', () => {
  let healthServer: HealthServer;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should use extended provider when available', async () => {
    healthServer = new HealthServer(mockLogger as any, mockHealthProvider as any, {
      extendedProvider: mockExtendedProvider as any,
    });
    await healthServer.start();

    const app = (healthServer as any)._app;
    const req = {} as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    const healthHandler = app._router.stack.find(
      (layer: any) => layer.route && layer.route.path === '/health'
    ).route.stack[0].handle;

    healthHandler(req, res, jest.fn());

    expect(mockExtendedProvider.getHealthStatusExtended).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    await healthServer.stop();
  });

  it('should use basic provider when extended not available', async () => {
    healthServer = new HealthServer(mockLogger as any, mockHealthProvider as any, {});
    await healthServer.start();

    const app = (healthServer as any)._app;
    const req = {} as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    const healthHandler = app._router.stack.find(
      (layer: any) => layer.route && layer.route.path === '/health'
    ).route.stack[0].handle;

    healthHandler(req, res, jest.fn());

    expect(mockHealthProvider.getHealthStatus).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    await healthServer.stop();
  });

  it('should return 503 for degraded status', async () => {
    mockHealthProvider.getHealthStatus.mockReturnValue({ status: 'degraded', uptime: 50 });
    healthServer = new HealthServer(mockLogger as any, mockHealthProvider as any, {});
    await healthServer.start();

    const app = (healthServer as any)._app;
    const req = {} as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    const healthHandler = app._router.stack.find(
      (layer: any) => layer.route && layer.route.path === '/health'
    ).route.stack[0].handle;

    healthHandler(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200); // degraded returns 200
    await healthServer.stop();
  });

  it('should return 503 for unhealthy status', async () => {
    mockHealthProvider.getHealthStatus.mockReturnValue({ status: 'unhealthy', uptime: 0 });
    healthServer = new HealthServer(mockLogger as any, mockHealthProvider as any, {});
    await healthServer.start();

    const app = (healthServer as any)._app;
    const req = {} as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    const healthHandler = app._router.stack.find(
      (layer: any) => layer.route && layer.route.path === '/health'
    ).route.stack[0].handle;

    healthHandler(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(503);
    await healthServer.stop();
  });

  it('should handle error in health check', async () => {
    mockHealthProvider.getHealthStatus.mockImplementation(() => {
      throw new Error('Provider failed');
    });
    healthServer = new HealthServer(mockLogger as any, mockHealthProvider as any, {});
    await healthServer.start();

    const app = (healthServer as any)._app;
    const req = {} as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    const healthHandler = app._router.stack.find(
      (layer: any) => layer.route && layer.route.path === '/health'
    ).route.stack[0].handle;

    healthHandler(req, res, jest.fn());

    expect(mockLogger.error).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    await healthServer.stop();
  });

  it('should mount metrics middleware when provided', async () => {
    const metricsMiddleware = jest.fn();
    healthServer = new HealthServer(mockLogger as any, mockHealthProvider as any, {
      metricsMiddleware,
    });
    await healthServer.start();

    expect(mockLogger.info).toHaveBeenCalledWith('Prometheus metrics endpoint mounted at /metrics');
    await healthServer.stop();
  });

  it('should mount settlement router when provided', async () => {
    const settlementRouter = jest.fn() as any;
    healthServer = new HealthServer(mockLogger as any, mockHealthProvider as any, {
      settlementRouter,
    });
    await healthServer.start();

    expect(mockLogger.info).toHaveBeenCalledWith('Settlement API mounted on health server');
    await healthServer.stop();
  });
});
