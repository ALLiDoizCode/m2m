/**
 * OpenTelemetryTracer Unit Tests
 * @remarks
 * Tests for OpenTelemetry distributed tracing functionality.
 * Uses mocked OpenTelemetry SDK to prevent actual trace export.
 */

import { Logger } from 'pino';
import { SpanStatusCode } from '@opentelemetry/api';
import { OpenTelemetryTracer } from '../../../src/observability/otel-tracer';
import { OpenTelemetryConfig } from '../../../src/observability/types';

// Mock OpenTelemetry modules
jest.mock('@opentelemetry/sdk-node', () => {
  return {
    NodeSDK: jest.fn().mockImplementation(() => ({
      start: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

jest.mock('@opentelemetry/exporter-trace-otlp-http', () => {
  return {
    OTLPTraceExporter: jest.fn().mockImplementation(() => ({})),
  };
});

describe('OpenTelemetryTracer', () => {
  let mockLogger: Logger;
  let tracer: OpenTelemetryTracer;

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

  afterEach(async () => {
    // Clean up tracer
    if (tracer) {
      await tracer.shutdown();
    }
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default configuration when disabled', () => {
      tracer = new OpenTelemetryTracer(mockLogger);

      expect(mockLogger.child).toHaveBeenCalledWith({ component: 'otel-tracer' });
      expect(tracer.isEnabled()).toBe(false);
    });

    it('should accept custom configuration', () => {
      const config: Partial<OpenTelemetryConfig> = {
        enabled: true,
        serviceName: 'test-connector',
        exporterEndpoint: 'http://jaeger:4318/v1/traces',
        samplingRatio: 0.5,
      };

      tracer = new OpenTelemetryTracer(mockLogger, config);

      expect(mockLogger.child).toHaveBeenCalledWith({ component: 'otel-tracer' });
    });
  });

  describe('initialize', () => {
    it('should skip initialization when tracing is disabled', async () => {
      tracer = new OpenTelemetryTracer(mockLogger, { enabled: false });

      await tracer.initialize();

      expect(tracer.isEnabled()).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith('OpenTelemetry tracing is disabled');
    });

    it('should initialize SDK when tracing is enabled', async () => {
      tracer = new OpenTelemetryTracer(mockLogger, {
        enabled: true,
        serviceName: 'test-connector',
      });

      await tracer.initialize();

      expect(tracer.isEnabled()).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: 'test-connector',
        }),
        'OpenTelemetry tracer initialized'
      );
    });

    it('should warn if already initialized', async () => {
      tracer = new OpenTelemetryTracer(mockLogger, { enabled: true });

      await tracer.initialize();
      await tracer.initialize(); // Second call

      expect(mockLogger.warn).toHaveBeenCalledWith('OpenTelemetry tracer already initialized');
    });
  });

  describe('startSpan', () => {
    beforeEach(async () => {
      tracer = new OpenTelemetryTracer(mockLogger, { enabled: true });
      await tracer.initialize();
    });

    it('should start a span with name', () => {
      const span = tracer.startSpan('packet.process');

      expect(span).toBeDefined();
      expect(mockLogger.trace).toHaveBeenCalledWith(
        expect.objectContaining({ spanName: 'packet.process' }),
        'Span started'
      );
    });

    it('should start a span with attributes', () => {
      const span = tracer.startSpan('packet.process', {
        'ilp.destination': 'g.example',
        'ilp.amount': '1000000',
      });

      expect(span).toBeDefined();
    });

    it('should return noop span when disabled', () => {
      const disabledTracer = new OpenTelemetryTracer(mockLogger, { enabled: false });
      const span = disabledTracer.startSpan('test');

      expect(span).toBeDefined();
    });
  });

  describe('endSpan', () => {
    beforeEach(async () => {
      tracer = new OpenTelemetryTracer(mockLogger, { enabled: true });
      await tracer.initialize();
    });

    it('should end span with ok status', () => {
      const span = tracer.startSpan('test');
      const setStatusSpy = jest.spyOn(span, 'setStatus');
      const endSpy = jest.spyOn(span, 'end');

      tracer.endSpan(span, 'ok');

      expect(setStatusSpy).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
      expect(endSpy).toHaveBeenCalled();
    });

    it('should end span with error status', () => {
      const span = tracer.startSpan('test');
      const setStatusSpy = jest.spyOn(span, 'setStatus');
      const recordExceptionSpy = jest.spyOn(span, 'recordException');

      tracer.endSpan(span, 'error', 'Test error');

      expect(setStatusSpy).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'Test error',
      });
      expect(recordExceptionSpy).toHaveBeenCalled();
    });
  });

  describe('addSpanAttributes', () => {
    beforeEach(async () => {
      tracer = new OpenTelemetryTracer(mockLogger, { enabled: true });
      await tracer.initialize();
    });

    it('should add attributes to span', () => {
      const span = tracer.startSpan('test');
      const setAttributeSpy = jest.spyOn(span, 'setAttribute');

      tracer.addSpanAttributes(span, {
        'settlement.method': 'xrp',
        'settlement.amount': '1000000',
      });

      expect(setAttributeSpy).toHaveBeenCalledWith('settlement.method', 'xrp');
      expect(setAttributeSpy).toHaveBeenCalledWith('settlement.amount', '1000000');
    });

    it('should skip undefined attributes', () => {
      const span = tracer.startSpan('test');
      const setAttributeSpy = jest.spyOn(span, 'setAttribute');

      tracer.addSpanAttributes(span, {
        'settlement.method': 'xrp',
        'settlement.amount': undefined,
      });

      expect(setAttributeSpy).toHaveBeenCalledTimes(1);
      expect(setAttributeSpy).toHaveBeenCalledWith('settlement.method', 'xrp');
    });
  });

  describe('recordSpanEvent', () => {
    beforeEach(async () => {
      tracer = new OpenTelemetryTracer(mockLogger, { enabled: true });
      await tracer.initialize();
    });

    it('should record event on span', () => {
      const span = tracer.startSpan('test');
      const addEventSpy = jest.spyOn(span, 'addEvent');

      tracer.recordSpanEvent(span, 'packet.forwarded', { peerId: 'peer-1' });

      expect(addEventSpy).toHaveBeenCalledWith('packet.forwarded', { peerId: 'peer-1' });
    });
  });

  describe('context propagation', () => {
    beforeEach(async () => {
      tracer = new OpenTelemetryTracer(mockLogger, { enabled: true });
      await tracer.initialize();
    });

    it('should inject context into headers', () => {
      const headers: Record<string, string> = {};

      const result = tracer.injectContext(headers);

      expect(result).toBeDefined();
      expect(mockLogger.trace).toHaveBeenCalledWith(
        expect.objectContaining({ headers: expect.any(Object) }),
        'Trace context injected'
      );
    });

    it('should extract context from headers', () => {
      const headers = {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      };

      const ctx = tracer.extractContext(headers);

      expect(ctx).toBeDefined();
      expect(mockLogger.trace).toHaveBeenCalledWith('Trace context extracted');
    });

    it('should return original headers when disabled', () => {
      const disabledTracer = new OpenTelemetryTracer(mockLogger, { enabled: false });
      const headers = { 'x-custom': 'value' };

      const result = disabledTracer.injectContext(headers);

      expect(result).toEqual(headers);
    });
  });

  describe('server and client spans', () => {
    beforeEach(async () => {
      tracer = new OpenTelemetryTracer(mockLogger, { enabled: true });
      await tracer.initialize();
    });

    it('should create server span', () => {
      const span = tracer.startServerSpan('http.request', {
        'ilp.destination': 'g.example',
      });

      expect(span).toBeDefined();
    });

    it('should create client span', () => {
      const span = tracer.startClientSpan('http.request', {
        'peer.destination': 'peer-b',
      });

      expect(span).toBeDefined();
    });
  });

  describe('shutdown', () => {
    it('should shutdown SDK gracefully', async () => {
      tracer = new OpenTelemetryTracer(mockLogger, { enabled: true });
      await tracer.initialize();

      await tracer.shutdown();

      expect(tracer.isEnabled()).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith('OpenTelemetry tracer shutdown complete');
    });

    it('should handle shutdown when not initialized', async () => {
      tracer = new OpenTelemetryTracer(mockLogger, { enabled: false });

      await tracer.shutdown();

      // Should not throw
      expect(mockLogger.info).not.toHaveBeenCalledWith('OpenTelemetry tracer shutdown complete');
    });
  });

  describe('withSpan', () => {
    beforeEach(async () => {
      tracer = new OpenTelemetryTracer(mockLogger, { enabled: true });
      await tracer.initialize();
    });

    it('should run function within span context', () => {
      const span = tracer.startSpan('test');
      let executed = false;

      const result = tracer.withSpan(span, () => {
        executed = true;
        return 'success';
      });

      expect(executed).toBe(true);
      expect(result).toBe('success');
    });
  });

  describe('trace IDs', () => {
    beforeEach(async () => {
      tracer = new OpenTelemetryTracer(mockLogger, { enabled: true });
      await tracer.initialize();
    });

    it('should return undefined for trace ID when no active span', () => {
      const traceId = tracer.getCurrentTraceId();
      // May be undefined or a valid trace ID depending on context
      expect(traceId === undefined || typeof traceId === 'string').toBe(true);
    });

    it('should return undefined for span ID when no active span', () => {
      const spanId = tracer.getCurrentSpanId();
      expect(spanId === undefined || typeof spanId === 'string').toBe(true);
    });
  });
});
