/**
 * Unit tests for IlpMetricsRegistry (Story 37.2 — Epic 37).
 *
 * Focus: counter/gauge semantics, /metrics middleware output shape, JSON snapshot shape
 * used by Story 37.3. Integration with PacketHandler / HealthServer is covered by the
 * respective integration tests in those modules.
 */
import express, { type Express } from 'express';
import request from 'supertest';
import { IlpMetricsRegistry } from './metrics-registry';

describe('IlpMetricsRegistry (Story 37.2)', () => {
  let metrics: IlpMetricsRegistry;

  beforeEach(() => {
    // collectDefaults: false keeps test assertions focused on toon_* family only.
    metrics = new IlpMetricsRegistry({ collectDefaults: false });
  });

  describe('registerPeer / getKnownPeers', () => {
    it('declares a peer and primes all counter labels to zero', async () => {
      metrics.registerPeer('town');

      expect(metrics.getKnownPeers()).toEqual(['town']);
      const text = await metrics.register.metrics();
      expect(text).toContain('toon_packets_forwarded_total{peer="town"} 0');
      expect(text).toContain('toon_packets_rejected_total{peer="town"} 0');
      expect(text).toContain('toon_bytes_sent_total{peer="town"} 0');
      expect(text).toContain('toon_bytes_received_total{peer="town"} 0');
      expect(text).toContain('toon_last_packet_timestamp_seconds{peer="town"} 0');
    });

    it('is idempotent — calling twice does not double-prime counters', async () => {
      metrics.registerPeer('mill');
      metrics.registerPeer('mill');
      metrics.recordForwardFulfill('mill', 100);

      const snapshot = await metrics.snapshotPeers();
      const mill = snapshot.find((p) => p.peerId === 'mill')!;
      expect(mill.packetsForwarded).toBe(1); // not 0+1+1=2
    });

    it('unregisterPeer removes from known set but preserves historical counters', async () => {
      metrics.registerPeer('dvm');
      metrics.recordForwardFulfill('dvm', 42);
      metrics.unregisterPeer('dvm');

      expect(metrics.getKnownPeers()).toEqual([]);
      // Snapshot still includes dvm because counter label state persists.
      const snapshot = await metrics.snapshotPeers();
      expect(snapshot.find((p) => p.peerId === 'dvm')?.packetsForwarded).toBe(1);
    });
  });

  describe('recordInbound', () => {
    it('increments bytes_received and updates lastPacketAt', async () => {
      const before = Date.now() / 1000;
      metrics.recordInbound('town', 250);
      const after = Date.now() / 1000;

      const snapshot = await metrics.snapshotPeers();
      const town = snapshot[0];
      expect(town).toBeDefined();
      expect(town!.peerId).toBe('town');
      expect(town!.bytesReceived).toBe(250);
      expect(town!.lastPacketAtUnixSeconds).toBeGreaterThanOrEqual(before);
      expect(town!.lastPacketAtUnixSeconds).toBeLessThanOrEqual(after);
    });

    it('is a no-op for peerId "unknown" (matches PacketHandler convention)', async () => {
      metrics.recordInbound('unknown', 999);
      const snapshot = await metrics.snapshotPeers();
      expect(snapshot).toEqual([]);
    });

    it('is a no-op for empty peerId', async () => {
      metrics.recordInbound('', 1);
      expect(await metrics.snapshotPeers()).toEqual([]);
    });
  });

  describe('recordForwardFulfill', () => {
    it('increments packetsForwarded, bytes_sent, and updates lastPacketAt', async () => {
      metrics.recordForwardFulfill('mill', 512);
      metrics.recordForwardFulfill('mill', 256);

      const snapshot = await metrics.snapshotPeers();
      const mill = snapshot[0];
      expect(mill).toMatchObject({
        peerId: 'mill',
        packetsForwarded: 2,
        packetsRejected: 0,
        bytesSent: 768,
        bytesReceived: 0,
      });
      expect(mill!.lastPacketAtUnixSeconds).toBeGreaterThan(0);
    });
  });

  describe('recordForwardReject', () => {
    it('increments packetsRejected and bytes_sent (bytes count even on reject)', async () => {
      metrics.recordForwardReject('mill', 128);

      const snapshot = await metrics.snapshotPeers();
      const mill = snapshot[0];
      expect(mill).toMatchObject({
        peerId: 'mill',
        packetsForwarded: 0,
        packetsRejected: 1,
        bytesSent: 128,
      });
    });
  });

  describe('recordPreRoutingReject', () => {
    it('increments the reason-labelled counter, NOT the per-peer rejected counter', async () => {
      metrics.recordPreRoutingReject('no_route');
      metrics.recordPreRoutingReject('no_route');
      metrics.recordPreRoutingReject('validation_failed');

      const text = await metrics.register.metrics();
      expect(text).toContain('toon_packets_rejected_pre_routing_total{reason="no_route"} 2');
      expect(text).toContain(
        'toon_packets_rejected_pre_routing_total{reason="validation_failed"} 1'
      );

      // Per-peer counter untouched — no peers ever registered, no samples.
      const aggregate = await metrics.snapshotAggregate();
      expect(aggregate.packetsRejected).toBe(0);
    });
  });

  describe('snapshotPeers', () => {
    it('returns peers sorted alphabetically', async () => {
      metrics.registerPeer('mill');
      metrics.registerPeer('town');
      metrics.registerPeer('dvm');

      const snapshot = await metrics.snapshotPeers();
      expect(snapshot.map((p) => p.peerId)).toEqual(['dvm', 'mill', 'town']);
    });

    it('unions known peers with peers seen via counter activity', async () => {
      metrics.registerPeer('town');
      metrics.recordForwardFulfill('mill', 100); // mill never explicitly registered
      const snapshot = await metrics.snapshotPeers();
      expect(snapshot.map((p) => p.peerId).sort()).toEqual(['mill', 'town']);
    });
  });

  describe('snapshotAggregate', () => {
    it('sums counters across all peers', async () => {
      metrics.recordForwardFulfill('town', 100);
      metrics.recordForwardFulfill('mill', 200);
      metrics.recordForwardReject('mill', 50);
      metrics.recordInbound('town', 75); // bytesReceived — not in aggregate

      expect(await metrics.snapshotAggregate()).toEqual({
        packetsForwarded: 2,
        packetsRejected: 1,
        bytesSent: 350,
        packetsLocallyDelivered: 0,
      });
    });
  });

  describe('createMetricsMiddleware', () => {
    let app: Express;

    beforeEach(() => {
      app = express();
      app.get('/metrics', metrics.createMetricsMiddleware());
    });

    it('serves 200 with Prometheus text content-type', async () => {
      metrics.registerPeer('town');
      metrics.recordForwardFulfill('town', 42);

      const res = await request(app).get('/metrics');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.headers['content-type']).toMatch(/version=0\.0\.4/);
      expect(res.text).toContain('toon_packets_forwarded_total{peer="town"} 1');
      expect(res.text).toContain('toon_bytes_sent_total{peer="town"} 42');
    });

    it('emits HELP and TYPE comment lines per OpenMetrics', async () => {
      const res = await request(app).get('/metrics');
      expect(res.text).toMatch(/^# HELP toon_packets_forwarded_total /m);
      expect(res.text).toMatch(/^# TYPE toon_packets_forwarded_total counter/m);
      expect(res.text).toMatch(/^# TYPE toon_last_packet_timestamp_seconds gauge/m);
    });

    it('does NOT require authentication (scraper convention, §10.2 of response doc)', async () => {
      // No X-Api-Key set, no middleware blocking the route.
      const res = await request(app).get('/metrics').set('X-Api-Key', 'wrong-but-irrelevant');
      expect(res.status).toBe(200);
    });
  });

  describe('collectDefaults option', () => {
    it('includes process_* default metrics when enabled', async () => {
      const withDefaults = new IlpMetricsRegistry({ collectDefaults: true });
      const text = await withDefaults.register.metrics();
      expect(text).toMatch(/^# TYPE process_cpu_user_seconds_total counter/m);
    });

    it('excludes process_* when disabled', async () => {
      const text = await metrics.register.metrics();
      expect(text).not.toMatch(/^process_/m);
    });
  });
});
