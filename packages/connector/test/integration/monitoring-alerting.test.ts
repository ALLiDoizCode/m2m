/**
 * Monitoring and Alerting Integration Tests
 * @remarks
 * Tests for production monitoring infrastructure including Prometheus metrics,
 * health endpoints, OpenTelemetry tracing, and alert verification.
 *
 * These tests verify AC 10 of Story 12.6.
 */

import { Logger } from 'pino';
// Express import removed - not needed in tests
import { PrometheusExporter } from '../../src/observability/prometheus-exporter';
import { OpenTelemetryTracer } from '../../src/observability/otel-tracer';
import { HealthServer } from '../../src/http/health-server';
import { HealthStatusExtended } from '../../src/http/types';

describe('Monitoring and Alerting Integration', () => {
  let mockLogger: Logger;
  let prometheusExporter: PrometheusExporter;
  let otelTracer: OpenTelemetryTracer;
  let healthServer: HealthServer;
  const testPort = 18080;

  beforeAll(async () => {
    // Create mock logger
    mockLogger = {
      child: jest.fn().mockReturnThis(),
      info: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    // Initialize PrometheusExporter
    prometheusExporter = new PrometheusExporter(mockLogger, {
      enabled: true,
      includeDefaultMetrics: false, // Disable default metrics in tests
      labels: { environment: 'test', nodeId: 'test-connector' },
    });

    // Initialize OpenTelemetryTracer (disabled to prevent actual trace export)
    otelTracer = new OpenTelemetryTracer(mockLogger, {
      enabled: false, // Disable actual tracing in integration tests
    });

    // Create health status provider
    const healthStatusProvider = {
      getHealthStatus: () => ({
        status: 'healthy' as const,
        uptime: process.uptime(),
        peersConnected: 2,
        totalPeers: 3,
        timestamp: new Date().toISOString(),
        nodeId: 'test-connector',
        version: '1.0.0',
      }),
    };

    // Initialize HealthServer with metrics middleware
    healthServer = new HealthServer(mockLogger, healthStatusProvider, {
      metricsMiddleware: prometheusExporter.getMetricsMiddleware(),
    });

    // Start the server
    await healthServer.start(testPort);

    // Wait for server to be fully ready
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterAll(async () => {
    // Cleanup
    await healthServer.stop();
    await otelTracer.shutdown();
    jest.clearAllMocks();
  });

  describe('Prometheus Metrics Endpoint', () => {
    it('should return valid Prometheus metrics format', async () => {
      // Record some test metrics
      prometheusExporter.recordPacket({
        type: 'prepare',
        status: 'success',
        latencyMs: 5,
        destination: 'g.test',
      });

      prometheusExporter.recordSettlement({
        method: 'xrp',
        status: 'success',
        latencyMs: 100,
        amount: 1000000n,
        tokenId: 'XRP',
      });

      // Fetch metrics endpoint
      const response = await fetch(`http://localhost:${testPort}/metrics`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');

      const metrics = await response.text();

      // Verify metrics format
      expect(metrics).toContain('# HELP');
      expect(metrics).toContain('# TYPE');

      // Verify expected metrics are present
      expect(metrics).toContain('ilp_packets_processed_total');
      expect(metrics).toContain('ilp_packet_latency_seconds');
      expect(metrics).toContain('settlements_executed_total');
    });

    it('should include labels in metrics', async () => {
      prometheusExporter.recordPacket({
        type: 'prepare',
        status: 'rejected',
        latencyMs: 2,
        destination: 'g.example',
      });

      const response = await fetch(`http://localhost:${testPort}/metrics`);
      const metrics = await response.text();

      // Verify labels are present
      expect(metrics).toMatch(/ilp_packets_processed_total\{.*type="prepare".*\}/);
      expect(metrics).toMatch(/ilp_packets_processed_total\{.*status="rejected".*\}/);
    });

    it('should track histogram buckets correctly', async () => {
      // Record packets with different latencies
      for (let i = 0; i < 10; i++) {
        prometheusExporter.recordPacket({
          type: 'prepare',
          status: 'success',
          latencyMs: i * 10, // 0, 10, 20, ... 90ms
          destination: 'g.bucket.test',
        });
      }

      const response = await fetch(`http://localhost:${testPort}/metrics`);
      const metrics = await response.text();

      // Verify histogram buckets
      expect(metrics).toContain('ilp_packet_latency_seconds_bucket');
      expect(metrics).toContain('ilp_packet_latency_seconds_sum');
      expect(metrics).toContain('ilp_packet_latency_seconds_count');
    });
  });

  describe('Health Check Endpoints', () => {
    it('should return health status on /health', async () => {
      const response = await fetch(`http://localhost:${testPort}/health`);

      expect(response.status).toBe(200);

      const health = await response.json();

      expect(health).toHaveProperty('status');
      expect(health).toHaveProperty('uptime');
      expect(health).toHaveProperty('peersConnected');
      expect(health).toHaveProperty('totalPeers');
      expect(health).toHaveProperty('timestamp');
    });

    it('should return 200 on /health/live', async () => {
      const response = await fetch(`http://localhost:${testPort}/health/live`);

      expect(response.status).toBe(200);

      const body = (await response.json()) as { status: string };
      expect(body.status).toBe('alive');
    });

    it('should return 200 on /health/ready when healthy', async () => {
      const response = await fetch(`http://localhost:${testPort}/health/ready`);

      expect(response.status).toBe(200);

      const body = (await response.json()) as { status: string };
      expect(body.status).toBe('ready');
    });
  });

  describe('Extended Health Status with SLA', () => {
    let extendedHealthServer: HealthServer;
    const extendedPort = 18081;

    beforeAll(async () => {
      // Create extended status provider (implements both methods)
      const extendedStatusProvider = {
        getHealthStatus: () => ({
          status: 'healthy' as const,
          uptime: process.uptime(),
          peersConnected: 2,
          totalPeers: 3,
          timestamp: new Date().toISOString(),
        }),
        getHealthStatusExtended: (): HealthStatusExtended => {
          const slaMetrics = prometheusExporter.getSLAMetrics();
          return {
            status: slaMetrics.packetSuccessRate >= 0.999 ? 'healthy' : 'degraded',
            uptime: process.uptime(),
            peersConnected: 2,
            totalPeers: 3,
            timestamp: new Date().toISOString(),
            nodeId: 'test-connector',
            version: '1.0.0',
            dependencies: {
              tigerbeetle: { status: 'up', latencyMs: 2 },
            },
            sla: {
              packetSuccessRate: slaMetrics.packetSuccessRate,
              settlementSuccessRate: slaMetrics.settlementSuccessRate,
              p99LatencyMs: slaMetrics.p99LatencyMs,
            },
          };
        },
      };

      extendedHealthServer = new HealthServer(mockLogger, extendedStatusProvider, {
        extendedProvider: extendedStatusProvider,
      });

      await extendedHealthServer.start(extendedPort);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    afterAll(async () => {
      await extendedHealthServer.stop();
    });

    it('should include dependency status in extended health', async () => {
      const response = await fetch(`http://localhost:${extendedPort}/health`);

      expect(response.status).toBe(200);

      const health = (await response.json()) as HealthStatusExtended;

      expect(health.dependencies).toBeDefined();
      expect(health.dependencies.tigerbeetle).toBeDefined();
      expect(health.dependencies.tigerbeetle.status).toBe('up');
    });

    it('should include SLA metrics in extended health', async () => {
      const response = await fetch(`http://localhost:${extendedPort}/health`);

      expect(response.status).toBe(200);

      const health = (await response.json()) as HealthStatusExtended;

      expect(health.sla).toBeDefined();
      expect(typeof health.sla.packetSuccessRate).toBe('number');
      expect(typeof health.sla.settlementSuccessRate).toBe('number');
      expect(typeof health.sla.p99LatencyMs).toBe('number');
    });
  });

  describe('Metrics Recording', () => {
    it('should record packet metrics correctly', async () => {
      // Record test packets
      prometheusExporter.recordPacket({
        type: 'prepare',
        status: 'success',
        latencyMs: 5,
        destination: 'g.integration.test',
      });

      prometheusExporter.recordPacket({
        type: 'prepare',
        status: 'rejected',
        latencyMs: 2,
        destination: 'g.integration.test',
      });

      const metrics = await prometheusExporter.getMetrics();

      // Verify counters incremented
      expect(metrics).toContain('ilp_packets_processed_total');
      expect(metrics).toMatch(/ilp_packets_processed_total\{.*status="success".*\}/);
      expect(metrics).toMatch(/ilp_packets_processed_total\{.*status="rejected".*\}/);
    });

    it('should record settlement metrics correctly', async () => {
      prometheusExporter.recordSettlement({
        method: 'evm',
        status: 'success',
        latencyMs: 500,
        amount: 1000000000n,
        tokenId: 'USDC',
      });

      prometheusExporter.recordSettlement({
        method: 'evm',
        status: 'failure',
        latencyMs: 1000,
        amount: 500000000n,
        tokenId: 'USDC',
      });

      const metrics = await prometheusExporter.getMetrics();

      expect(metrics).toContain('settlements_executed_total');
      expect(metrics).toMatch(/settlements_executed_total\{.*method="evm".*\}/);
      expect(metrics).toMatch(/settlements_executed_total\{.*status="success".*\}/);
      expect(metrics).toMatch(/settlements_executed_total\{.*status="failure".*\}/);
    });

    it('should update account balance gauges', async () => {
      prometheusExporter.updateAccountBalance('peer-a', 'ILP', 1000000n);
      prometheusExporter.updateAccountBalance('peer-b', 'ILP', 2000000n);

      const metrics = await prometheusExporter.getMetrics();

      expect(metrics).toContain('account_balance_units');
      expect(metrics).toMatch(/account_balance_units\{.*peer_id="peer-a".*\}/);
      expect(metrics).toMatch(/account_balance_units\{.*peer_id="peer-b".*\}/);
    });

    it('should record channel events', async () => {
      prometheusExporter.recordChannelEvent({
        method: 'xrp',
        event: 'funded',
      });

      prometheusExporter.recordChannelEvent({
        method: 'evm',
        event: 'closed',
        reason: 'cooperative',
      });

      prometheusExporter.recordChannelEvent({
        method: 'xrp',
        event: 'disputed',
      });

      const metrics = await prometheusExporter.getMetrics();

      expect(metrics).toContain('payment_channels_funded_total');
      expect(metrics).toContain('payment_channels_closed_total');
      expect(metrics).toContain('payment_channels_disputes_total');
    });

    it('should record errors with type and severity', async () => {
      prometheusExporter.recordError({
        type: 'settlement',
        severity: 'critical',
      });

      prometheusExporter.recordError({
        type: 'routing',
        severity: 'medium',
      });

      const metrics = await prometheusExporter.getMetrics();

      expect(metrics).toContain('connector_errors_total');
      expect(metrics).toMatch(/connector_errors_total\{.*type="settlement".*\}/);
      expect(metrics).toMatch(/connector_errors_total\{.*severity="critical".*\}/);
    });
  });

  describe('SLA Metrics Calculation', () => {
    let slaExporter: PrometheusExporter;

    beforeEach(() => {
      // Create fresh exporter for SLA tests
      slaExporter = new PrometheusExporter(mockLogger, {
        enabled: true,
        includeDefaultMetrics: false,
        labels: { environment: 'sla-test' },
      });
    });

    it('should calculate packet success rate', () => {
      // Record 9 successful and 1 failed
      for (let i = 0; i < 9; i++) {
        slaExporter.recordPacket({
          type: 'prepare',
          status: 'success',
          latencyMs: 5,
          destination: 'g.sla.test',
        });
      }
      slaExporter.recordPacket({
        type: 'prepare',
        status: 'rejected',
        latencyMs: 2,
        destination: 'g.sla.test',
      });

      const slaMetrics = slaExporter.getSLAMetrics();

      // 9/10 = 0.9
      expect(slaMetrics.packetSuccessRate).toBeCloseTo(0.9, 2);
    });

    it('should calculate settlement success rate', () => {
      // Record 8 successful and 2 failed
      for (let i = 0; i < 8; i++) {
        slaExporter.recordSettlement({
          method: 'xrp',
          status: 'success',
          latencyMs: 100,
          amount: 1000n,
          tokenId: 'XRP',
        });
      }
      for (let i = 0; i < 2; i++) {
        slaExporter.recordSettlement({
          method: 'xrp',
          status: 'failure',
          latencyMs: 500,
          amount: 1000n,
          tokenId: 'XRP',
        });
      }

      const slaMetrics = slaExporter.getSLAMetrics();

      // 8/10 = 0.8
      expect(slaMetrics.settlementSuccessRate).toBeCloseTo(0.8, 2);
    });

    it('should track p99 latency', () => {
      // Record packets with varying latencies
      const latencies = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]; // 100ms is the p99

      latencies.forEach((latency) => {
        slaExporter.recordPacket({
          type: 'prepare',
          status: 'success',
          latencyMs: latency,
          destination: 'g.latency.test',
        });
      });

      const slaMetrics = slaExporter.getSLAMetrics();

      // p99 should be close to 100ms (the outlier)
      expect(slaMetrics.p99LatencyMs).toBeGreaterThan(50);
    });

    it('should return safe defaults when no data', () => {
      const emptyExporter = new PrometheusExporter(mockLogger, {
        enabled: true,
        includeDefaultMetrics: false,
      });

      const slaMetrics = emptyExporter.getSLAMetrics();

      // Should return 1.0 (100%) when no data (optimistic default)
      expect(slaMetrics.packetSuccessRate).toBe(1);
      expect(slaMetrics.settlementSuccessRate).toBe(1);
      expect(slaMetrics.p99LatencyMs).toBe(0);
    });
  });

  describe('OpenTelemetry Tracing', () => {
    let enabledTracer: OpenTelemetryTracer;

    beforeAll(async () => {
      enabledTracer = new OpenTelemetryTracer(mockLogger, {
        enabled: true,
        serviceName: 'test-connector',
      });
      await enabledTracer.initialize();
    });

    afterAll(async () => {
      await enabledTracer.shutdown();
    });

    it('should create spans when enabled', () => {
      const span = enabledTracer.startSpan('test.operation', {
        'ilp.destination': 'g.test',
        'ilp.amount': '1000',
      });

      expect(span).toBeDefined();

      // End span properly
      enabledTracer.endSpan(span, 'ok');
    });

    it('should inject trace context into headers', () => {
      const headers: Record<string, string> = {};

      const result = enabledTracer.injectContext(headers);

      expect(result).toBeDefined();
      // Trace context should be injected (traceparent header)
    });

    it('should extract trace context from headers', () => {
      const headers = {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      };

      const context = enabledTracer.extractContext(headers);

      expect(context).toBeDefined();
    });

    it('should record span events', () => {
      const span = enabledTracer.startSpan('test.events');

      enabledTracer.recordSpanEvent(span, 'packet.forwarded', {
        peerId: 'peer-a',
      });

      enabledTracer.endSpan(span, 'ok');
    });

    it('should handle error spans', () => {
      const span = enabledTracer.startSpan('test.error');

      enabledTracer.endSpan(span, 'error', 'Test error message');
    });

    it('should run function within span context', () => {
      const span = enabledTracer.startSpan('test.context');
      let executed = false;

      const result = enabledTracer.withSpan(span, () => {
        executed = true;
        return 'test-result';
      });

      expect(executed).toBe(true);
      expect(result).toBe('test-result');

      enabledTracer.endSpan(span, 'ok');
    });
  });

  describe('Alert Rule Verification', () => {
    /**
     * These tests verify that the metrics would trigger alerts
     * based on the alert rules defined in connector-alerts.yml
     */

    it('should have error rate metric for HighPacketErrorRate alert', async () => {
      // Record high error rate scenario
      for (let i = 0; i < 10; i++) {
        prometheusExporter.recordPacket({
          type: 'prepare',
          status: 'rejected',
          latencyMs: 5,
          destination: 'g.alert.test',
        });
      }

      const metrics = await prometheusExporter.getMetrics();

      // Verify error metric exists for alert
      expect(metrics).toContain('ilp_packets_processed_total');
      expect(metrics).toMatch(/status="rejected"/);
    });

    it('should have settlement failure metric for SettlementFailures alert', async () => {
      prometheusExporter.recordSettlement({
        method: 'xrp',
        status: 'failure',
        latencyMs: 1000,
        amount: 1000000n,
        tokenId: 'XRP',
      });

      const metrics = await prometheusExporter.getMetrics();

      expect(metrics).toContain('settlements_executed_total');
      expect(metrics).toMatch(/status="failure"/);
    });

    it('should have dispute metric for ChannelDispute alert', async () => {
      prometheusExporter.recordChannelEvent({
        method: 'xrp',
        event: 'disputed',
      });

      prometheusExporter.updateActiveChannels('xrp', 'disputed', 1);

      const metrics = await prometheusExporter.getMetrics();

      expect(metrics).toContain('payment_channels_disputes_total');
      expect(metrics).toContain('payment_channels_active');
    });

    it('should have latency histogram for HighP99Latency alert', async () => {
      // Record high latency packets
      for (let i = 0; i < 10; i++) {
        prometheusExporter.recordPacket({
          type: 'prepare',
          status: 'success',
          latencyMs: 50, // 50ms - above 10ms threshold
          destination: 'g.latency.alert',
        });
      }

      const metrics = await prometheusExporter.getMetrics();

      expect(metrics).toContain('ilp_packet_latency_seconds_bucket');
      expect(metrics).toContain('ilp_packet_latency_seconds_sum');
    });

    it('should have error counter for CriticalErrorSpike alert', async () => {
      // Record multiple critical errors
      for (let i = 0; i < 15; i++) {
        prometheusExporter.recordError({
          type: 'settlement',
          severity: 'critical',
        });
      }

      const metrics = await prometheusExporter.getMetrics();

      expect(metrics).toContain('connector_errors_total');
      expect(metrics).toMatch(/severity="critical"/);
    });
  });
});
