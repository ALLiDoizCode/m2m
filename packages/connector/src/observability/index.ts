/**
 * Observability Module - Production monitoring, metrics, and tracing
 * @packageDocumentation
 * @remarks
 * Exports observability components for production connector monitoring.
 * Includes Prometheus metrics, OpenTelemetry tracing, and health extensions.
 */

export { PrometheusExporter } from './prometheus-exporter';
export { OpenTelemetryTracer } from './otel-tracer';
export type { PacketSpanAttributes, SettlementSpanAttributes, SpanStatus } from './otel-tracer';
export * from './types';
