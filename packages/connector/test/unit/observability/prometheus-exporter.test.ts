/**
 * PrometheusExporter Unit Tests
 * @remarks
 * Tests for Prometheus metrics collection and export functionality.
 * Validates metric registration, recording, and Prometheus format export.
 */

import { Logger } from 'pino';
import { Request, Response } from 'express';
import { PrometheusExporter } from '../../../src/observability/prometheus-exporter';
import {
  PrometheusMetricsConfig,
  PacketMetricsOptions,
  SettlementMetricsOptions,
  ChannelMetricsOptions,
  ErrorMetricsOptions,
} from '../../../src/observability/types';

describe('PrometheusExporter', () => {
  let mockLogger: Logger;
  let exporter: PrometheusExporter;

  beforeEach(() => {
    // Create mock logger
    mockLogger = {
      child: jest.fn().mockReturnThis(),
      info: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;
  });

  afterEach(() => {
    // Clean up exporter registry to prevent metric registration conflicts
    if (exporter) {
      exporter.shutdown();
    }
  });

  describe('constructor', () => {
    it('should initialize with default configuration', () => {
      exporter = new PrometheusExporter(mockLogger);

      expect(mockLogger.child).toHaveBeenCalledWith({ component: 'prometheus-exporter' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ config: expect.any(Object) }),
        'PrometheusExporter initialized'
      );
    });

    it('should accept custom configuration', () => {
      const config: Partial<PrometheusMetricsConfig> = {
        enabled: true,
        metricsPath: '/custom-metrics',
        includeDefaultMetrics: false,
        labels: { environment: 'test', nodeId: 'node-1' },
      };

      exporter = new PrometheusExporter(mockLogger, config);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            metricsPath: '/custom-metrics',
            includeDefaultMetrics: false,
          }),
        }),
        'PrometheusExporter initialized'
      );
    });

    it('should create a custom registry', () => {
      exporter = new PrometheusExporter(mockLogger);
      const registry = exporter.getRegistry();

      expect(registry).toBeDefined();
      expect(typeof registry.metrics).toBe('function');
    });
  });

  describe('recordPacket', () => {
    beforeEach(() => {
      exporter = new PrometheusExporter(mockLogger, { includeDefaultMetrics: false });
    });

    it('should record successful packet', async () => {
      const options: PacketMetricsOptions = {
        type: 'prepare',
        status: 'success',
        latencyMs: 5,
      };

      exporter.recordPacket(options);

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('ilp_packets_processed_total');
      expect(metrics).toContain('type="prepare"');
      expect(metrics).toContain('status="success"');
    });

    it('should record failed packet', async () => {
      const options: PacketMetricsOptions = {
        type: 'prepare',
        status: 'error',
        latencyMs: 10,
      };

      exporter.recordPacket(options);

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('status="error"');
    });

    it('should record packet latency histogram', async () => {
      exporter.recordPacket({
        type: 'fulfill',
        status: 'success',
        latencyMs: 50,
      });

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('ilp_packet_latency_seconds');
      expect(metrics).toContain('type="fulfill"');
    });

    it('should track SLA metrics for packets', () => {
      exporter.recordPacket({ type: 'prepare', status: 'success', latencyMs: 5 });
      exporter.recordPacket({ type: 'prepare', status: 'success', latencyMs: 10 });
      exporter.recordPacket({ type: 'prepare', status: 'error', latencyMs: 15 });

      const slaMetrics = exporter.getSLAMetrics();

      expect(slaMetrics.packetSuccessRate).toBeCloseTo(2 / 3, 2);
    });

    it('should limit latency samples to prevent memory bloat', () => {
      // Record more than 10000 packets
      for (let i = 0; i < 10050; i++) {
        exporter.recordPacket({
          type: 'prepare',
          status: 'success',
          latencyMs: i,
        });
      }

      const slaMetrics = exporter.getSLAMetrics();
      // p99 should be based on last 10000 samples
      expect(slaMetrics.p99LatencyMs).toBeDefined();
    });
  });

  describe('packets in flight', () => {
    beforeEach(() => {
      exporter = new PrometheusExporter(mockLogger, { includeDefaultMetrics: false });
    });

    it('should increment packets in flight', async () => {
      exporter.incrementPacketsInFlight();
      exporter.incrementPacketsInFlight();

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('ilp_packets_in_flight 2');
    });

    it('should decrement packets in flight', async () => {
      exporter.incrementPacketsInFlight();
      exporter.incrementPacketsInFlight();
      exporter.decrementPacketsInFlight();

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('ilp_packets_in_flight 1');
    });
  });

  describe('recordSettlement', () => {
    beforeEach(() => {
      exporter = new PrometheusExporter(mockLogger, { includeDefaultMetrics: false });
    });

    it('should record successful settlement', async () => {
      const options: SettlementMetricsOptions = {
        method: 'xrp',
        status: 'success',
        latencyMs: 3000,
        amount: BigInt(1000000),
        tokenId: 'XRP',
      };

      exporter.recordSettlement(options);

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('settlements_executed_total');
      expect(metrics).toContain('method="xrp"');
      expect(metrics).toContain('status="success"');
    });

    it('should record settlement latency', async () => {
      exporter.recordSettlement({
        method: 'evm',
        status: 'success',
        latencyMs: 5000,
      });

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('settlement_latency_seconds');
      expect(metrics).toContain('method="evm"');
    });

    it('should record settlement amount', async () => {
      exporter.recordSettlement({
        method: 'xrp',
        status: 'success',
        latencyMs: 2000,
        amount: BigInt(5000000),
        tokenId: 'XRP',
      });

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('settlement_amount_total');
      expect(metrics).toContain('token="XRP"');
    });

    it('should track SLA metrics for settlements', () => {
      exporter.recordSettlement({ method: 'xrp', status: 'success', latencyMs: 1000 });
      exporter.recordSettlement({ method: 'xrp', status: 'success', latencyMs: 2000 });
      exporter.recordSettlement({ method: 'xrp', status: 'failure', latencyMs: 3000 });

      const slaMetrics = exporter.getSLAMetrics();

      expect(slaMetrics.settlementSuccessRate).toBeCloseTo(2 / 3, 2);
    });
  });

  describe('account metrics', () => {
    beforeEach(() => {
      exporter = new PrometheusExporter(mockLogger, { includeDefaultMetrics: false });
    });

    it('should update account balance', async () => {
      exporter.updateAccountBalance('peer-1', 'XRP', BigInt(1000000));

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('account_balance_units');
      expect(metrics).toContain('peer_id="peer-1"');
      expect(metrics).toContain('token_id="XRP"');
    });

    it('should record account credits', async () => {
      exporter.recordAccountCredit('peer-1', BigInt(500000));

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('account_credits_total');
    });

    it('should record account debits', async () => {
      exporter.recordAccountDebit('peer-1', BigInt(250000));

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('account_debits_total');
    });
  });

  describe('channel metrics', () => {
    beforeEach(() => {
      exporter = new PrometheusExporter(mockLogger, { includeDefaultMetrics: false });
    });

    it('should update active channels count', async () => {
      exporter.updateActiveChannels('xrp', 'open', 5);

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('payment_channels_active');
      expect(metrics).toContain('method="xrp"');
      expect(metrics).toContain('status="open"');
    });

    it('should record channel funded event', async () => {
      const options: ChannelMetricsOptions = {
        method: 'xrp',
        event: 'funded',
      };

      exporter.recordChannelEvent(options);

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('payment_channels_funded_total');
    });

    it('should record channel closed event with reason', async () => {
      const options: ChannelMetricsOptions = {
        method: 'evm',
        event: 'closed',
        reason: 'expired',
      };

      exporter.recordChannelEvent(options);

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('payment_channels_closed_total');
      expect(metrics).toContain('reason="expired"');
    });

    it('should record channel dispute event', async () => {
      const options: ChannelMetricsOptions = {
        method: 'xrp',
        event: 'disputed',
      };

      exporter.recordChannelEvent(options);

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('payment_channels_disputes_total');
    });
  });

  describe('error metrics', () => {
    beforeEach(() => {
      exporter = new PrometheusExporter(mockLogger, { includeDefaultMetrics: false });
    });

    it('should record error', async () => {
      const options: ErrorMetricsOptions = {
        type: 'settlement',
        severity: 'high',
      };

      exporter.recordError(options);

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('connector_errors_total');
      expect(metrics).toContain('type="settlement"');
      expect(metrics).toContain('severity="high"');
    });

    it('should update last error timestamp', async () => {
      const beforeRecord = Date.now() / 1000;

      exporter.recordError({
        type: 'connection',
        severity: 'critical',
      });

      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('connector_last_error_timestamp');

      // The timestamp should be recent
      const match = metrics.match(/connector_last_error_timestamp\s+(\d+\.?\d*)/);
      expect(match).toBeDefined();
      expect(match).not.toBeNull();
      const timestamp = parseFloat(match![1] as string);
      expect(timestamp).toBeGreaterThanOrEqual(beforeRecord);
    });
  });

  describe('SLA metrics', () => {
    beforeEach(() => {
      exporter = new PrometheusExporter(mockLogger, { includeDefaultMetrics: false });
    });

    it('should return perfect SLA metrics when no data', () => {
      const slaMetrics = exporter.getSLAMetrics();

      expect(slaMetrics.packetSuccessRate).toBe(1.0);
      expect(slaMetrics.settlementSuccessRate).toBe(1.0);
      expect(slaMetrics.p99LatencyMs).toBe(0);
    });

    it('should calculate correct p99 latency', () => {
      // Record 100 packets with increasing latency
      for (let i = 1; i <= 100; i++) {
        exporter.recordPacket({
          type: 'prepare',
          status: 'success',
          latencyMs: i,
        });
      }

      const slaMetrics = exporter.getSLAMetrics();

      // p99 of 1-100: index = floor(100 * 0.99) = 99, value at index 99 is 100
      expect(slaMetrics.p99LatencyMs).toBe(100);
    });
  });

  describe('getMetrics', () => {
    beforeEach(() => {
      exporter = new PrometheusExporter(mockLogger, { includeDefaultMetrics: false });
    });

    it('should return Prometheus-formatted metrics', async () => {
      exporter.recordPacket({ type: 'prepare', status: 'success', latencyMs: 5 });

      const metrics = await exporter.getMetrics();

      // Check for standard Prometheus format elements
      expect(metrics).toContain('# HELP');
      expect(metrics).toContain('# TYPE');
    });

    it('should return correct content type', () => {
      const contentType = exporter.getContentType();

      expect(contentType).toContain('text/plain');
    });
  });

  describe('getMetricsMiddleware', () => {
    beforeEach(() => {
      exporter = new PrometheusExporter(mockLogger, { includeDefaultMetrics: false });
    });

    it('should return Express middleware function', () => {
      const middleware = exporter.getMetricsMiddleware();

      expect(typeof middleware).toBe('function');
    });

    it('should respond with metrics on successful call', async () => {
      exporter.recordPacket({ type: 'prepare', status: 'success', latencyMs: 5 });

      const middleware = exporter.getMetricsMiddleware();
      const mockReq = {} as Request;
      const mockRes = {
        set: jest.fn(),
        send: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await middleware(mockReq, mockRes, jest.fn());

      expect(mockRes.set).toHaveBeenCalledWith('Content-Type', expect.any(String));
      expect(mockRes.send).toHaveBeenCalledWith(
        expect.stringContaining('ilp_packets_processed_total')
      );
    });
  });

  describe('reset', () => {
    beforeEach(() => {
      exporter = new PrometheusExporter(mockLogger, { includeDefaultMetrics: false });
    });

    it('should reset all metrics', async () => {
      // Record some metrics
      exporter.recordPacket({ type: 'prepare', status: 'success', latencyMs: 5 });
      exporter.recordSettlement({ method: 'xrp', status: 'success', latencyMs: 1000 });

      // Reset
      exporter.reset();

      // SLA metrics should be reset
      const slaMetrics = exporter.getSLAMetrics();
      expect(slaMetrics.packetSuccessRate).toBe(1.0);
      expect(slaMetrics.settlementSuccessRate).toBe(1.0);
      expect(slaMetrics.p99LatencyMs).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('should clear registry on shutdown', () => {
      exporter = new PrometheusExporter(mockLogger, { includeDefaultMetrics: false });

      exporter.shutdown();

      expect(mockLogger.info).toHaveBeenCalledWith('PrometheusExporter shutdown complete');
    });
  });
});
