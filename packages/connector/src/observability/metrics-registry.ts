/**
 * ILP Observability Registry (Story 37.2 — Epic 37)
 *
 * Wires `prom-client` into the connector so the long-standing `HealthServer.metricsMiddleware`
 * slot at `health-server.ts:131-134` actually receives a middleware. Exposes per-peer ILP
 * counters consumed by:
 *
 *   - the existing (previously non-functional) GET /metrics Prometheus scrape endpoint
 *   - the JSON projection at GET /admin/metrics.json (Story 37.3)
 *
 * The registry is **scoped per instance**, not using prom-client's global `register`. This
 * keeps tests isolated (multiple ConnectorNode instances in one Jest worker don't collide
 * on label state) and mirrors how the rest of the connector handles shared state (see
 * e.g. MetricsCollector in settlement/).
 *
 * Cross-team decision log: docs/stories/connector-admin-api-dashboard-response-2026-04-21.md
 * Shape lock: §9.4 of that doc. Semantics: §9.2 Q1/Q2 (≤10 peers, either-direction lastPacketAt).
 */
import { collectDefaultMetrics, Counter, Gauge, Registry, type Metric } from 'prom-client';
import type { Request, RequestHandler, Response } from 'express';

/**
 * Reason labels for pre-routing rejection counters.
 *
 * Pre-routing rejects happen BEFORE a next-hop peer is resolved, so they cannot be
 * attributed to a specific outgoing peer. Keeping them in a separate counter family
 * preserves the per-peer semantic of the main `toon_packets_rejected_total` counter
 * while still giving operators visibility into internal reject causes.
 */
export type PreRoutingRejectReason =
  | 'validation_failed'
  | 'no_route'
  | 'expiry_too_short'
  | 'credit_limit_exceeded'
  | 'claim_generation_failed'
  | 'settlement_recording_failed';

export interface IlpMetricsRegistryOptions {
  /**
   * Whether to register process-default metrics (CPU, heap, event loop lag, etc.) on
   * the same registry. Defaults to true in production; tests may pass false to keep
   * the registry output focused on the toon_* family.
   */
  collectDefaults?: boolean;
}

/**
 * Per-instance Prometheus registry for ILP observability.
 *
 * Counter / gauge semantics:
 *
 * | Metric                                      | Label      | When                                                          |
 * | ------------------------------------------- | ---------- | ------------------------------------------------------------- |
 * | `toon_packets_forwarded_total`              | `{peer}`   | FULFILL received from next-hop peer (peer = nextHop).         |
 * | `toon_packets_rejected_total`               | `{peer}`   | REJECT received from next-hop peer, OR connector generated    |
 * |                                             |            | REJECT after attempting forward (peer = nextHop).             |
 * | `toon_bytes_sent_total`                     | `{peer}`   | Every outbound forward attempt (peer = nextHop).              |
 * | `toon_bytes_received_total`                 | `{peer}`   | Every PREPARE received (peer = fromPeerId, skipped if         |
 * |                                             |            | 'unknown').                                                   |
 * | `toon_last_packet_timestamp_seconds`        | `{peer}`   | Either direction — updated on inbound receive AND on outbound |
 * |                                             |            | forward. Unix seconds.                                        |
 * | `toon_packets_rejected_pre_routing_total`   | `{reason}` | REJECT generated before next-hop was resolved. Aggregate-only.|
 * | `toon_packets_locally_delivered_total`      | `{peer}`   | FULFILL produced by the local-delivery branch (self-route).   |
 * |                                             |            | peer = inbound source peer (sourcePeerId).                    |
 */
export class IlpMetricsRegistry {
  public readonly register: Registry;

  public readonly packetsForwardedTotal: Counter<'peer'>;
  public readonly packetsRejectedTotal: Counter<'peer'>;
  public readonly bytesSentTotal: Counter<'peer'>;
  public readonly bytesReceivedTotal: Counter<'peer'>;
  public readonly lastPacketTimestampSeconds: Gauge<'peer'>;
  public readonly packetsRejectedPreRoutingTotal: Counter<'reason'>;
  public readonly packetsLocallyDeliveredTotal: Counter<'peer'>;
  public readonly discoveredNodesGauge: Gauge;
  public readonly discoveredNodesFundedGauge: Gauge;

  /**
   * Read-time source for the discovered-vs-funded gauges (toon-meta#153).
   * Sampled by the gauges' `collect()` on every scrape; when unset (route
   * learning disabled, or before wiring) both gauges report 0.
   */
  private _discoveredNodeCountsProvider: (() => { discovered: number; funded: number }) | null =
    null;

  /**
   * Tracks peers that have been explicitly registered via `registerPeer()`. Used so that
   * idle peers still appear in the JSON projection (Story 37.3 AC 3) even before their
   * first packet. Separate from the counter label state because prom-client does not
   * initialise a label set to 0 until the first `inc()` call.
   */
  private readonly knownPeers = new Set<string>();

  constructor(options: IlpMetricsRegistryOptions = {}) {
    this.register = new Registry();

    this.packetsForwardedTotal = new Counter({
      name: 'toon_packets_forwarded_total',
      help: 'Count of ILP PREPARE packets successfully forwarded to a next-hop peer (peer returned FULFILL).',
      labelNames: ['peer'] as const,
      registers: [this.register],
    });

    this.packetsRejectedTotal = new Counter({
      name: 'toon_packets_rejected_total',
      help: 'Count of ILP PREPARE packets that resulted in a REJECT after a next-hop peer was attempted (from peer or connector-generated post-routing).',
      labelNames: ['peer'] as const,
      registers: [this.register],
    });

    this.bytesSentTotal = new Counter({
      name: 'toon_bytes_sent_total',
      help: 'Total bytes sent toward a peer (measured by ILP packet payload length of outbound PREPAREs).',
      labelNames: ['peer'] as const,
      registers: [this.register],
    });

    this.bytesReceivedTotal = new Counter({
      name: 'toon_bytes_received_total',
      help: 'Total bytes received from a peer (measured by ILP packet payload length of inbound PREPAREs).',
      labelNames: ['peer'] as const,
      registers: [this.register],
    });

    this.lastPacketTimestampSeconds = new Gauge({
      name: 'toon_last_packet_timestamp_seconds',
      help: 'Unix timestamp (seconds) of the most recent packet seen for this peer in either direction. 0 if never seen.',
      labelNames: ['peer'] as const,
      registers: [this.register],
    });

    this.packetsRejectedPreRoutingTotal = new Counter({
      name: 'toon_packets_rejected_pre_routing_total',
      help: 'Count of ILP PREPARE packets rejected by the connector before a next-hop peer was resolved. Aggregate only — not attributable to a specific outgoing peer.',
      labelNames: ['reason'] as const,
      registers: [this.register],
    });

    this.packetsLocallyDeliveredTotal = new Counter({
      name: 'toon_packets_locally_delivered_total',
      help: 'Count of ILP PREPARE packets fulfilled via the local-delivery branch (self-route, nextHop === nodeId). peer = inbound source peer.',
      labelNames: ['peer'] as const,
      registers: [this.register],
    });

    // Discovered-vs-peered gauges (toon-meta#153): the free, unbounded
    // "discovered" set vs its funded subset. Sampled at scrape time from the
    // provider so the gauges never hold a stale copy of registry state.
    this.discoveredNodesGauge = new Gauge({
      name: 'toon_discovered_nodes',
      help: 'Nodes currently known from kind:10032 relay ingest (the discovered set, funded or not). 0 when route learning is disabled.',
      registers: [this.register],
      collect: () => {
        const counts = this._discoveredNodeCountsProvider?.();
        this.discoveredNodesGauge.set(counts?.discovered ?? 0);
      },
    });

    this.discoveredNodesFundedGauge = new Gauge({
      name: 'toon_discovered_nodes_funded',
      help: 'Discovered nodes to which a live registered peer currently maps (the funded subset of toon_discovered_nodes).',
      registers: [this.register],
      collect: () => {
        const counts = this._discoveredNodeCountsProvider?.();
        this.discoveredNodesFundedGauge.set(counts?.funded ?? 0);
      },
    });

    if (options.collectDefaults !== false) {
      collectDefaultMetrics({ register: this.register });
    }
  }

  /**
   * Wire the discovered-node registry's counts into the
   * `toon_discovered_nodes` / `toon_discovered_nodes_funded` gauges
   * (toon-meta#153). Called by the connector when route learning starts;
   * safe to call again (last provider wins).
   */
  setDiscoveredNodeCountsProvider(provider: () => { discovered: number; funded: number }): void {
    this._discoveredNodeCountsProvider = provider;
  }

  /**
   * Declare that a peer exists, so its labels appear in the JSON projection even with
   * zero activity (Story 37.3 AC 3). Safe to call multiple times.
   *
   * Also primes the zero value on every counter/gauge so the Prometheus scrape output
   * includes the peer immediately rather than waiting for the first sample.
   */
  registerPeer(peerId: string): void {
    if (this.knownPeers.has(peerId)) return;
    this.knownPeers.add(peerId);
    // Priming labels with inc(0) is the prom-client idiom for "ensure this label set
    // is emitted even with zero samples". Gauges do not need it because .get() returns
    // 0 for uninitialised labels, but counters would otherwise be absent from /metrics.
    this.packetsForwardedTotal.inc({ peer: peerId }, 0);
    this.packetsRejectedTotal.inc({ peer: peerId }, 0);
    this.bytesSentTotal.inc({ peer: peerId }, 0);
    this.bytesReceivedTotal.inc({ peer: peerId }, 0);
    this.lastPacketTimestampSeconds.set({ peer: peerId }, 0);
    this.packetsLocallyDeliveredTotal.inc({ peer: peerId }, 0);
  }

  /**
   * Remove a peer from the known set. Does NOT reset the counter values — historical
   * totals are preserved for post-hoc analysis. The peer simply stops being treated as
   * "currently registered" for JSON projection purposes.
   */
  unregisterPeer(peerId: string): void {
    this.knownPeers.delete(peerId);
  }

  getKnownPeers(): string[] {
    return Array.from(this.knownPeers);
  }

  /**
   * Record an inbound PREPARE packet. No-op when peerId is 'unknown' (matches the
   * PacketHandler convention where anonymous inbound sources are not attributable).
   */
  recordInbound(peerId: string, bytes: number): void {
    if (!peerId || peerId === 'unknown') return;
    this.bytesReceivedTotal.inc({ peer: peerId }, bytes);
    this.lastPacketTimestampSeconds.set({ peer: peerId }, Date.now() / 1000);
  }

  /**
   * Record an outbound forward attempt that resulted in FULFILL (successful routing).
   */
  recordForwardFulfill(peerId: string, bytes: number): void {
    this.packetsForwardedTotal.inc({ peer: peerId }, 1);
    this.bytesSentTotal.inc({ peer: peerId }, bytes);
    this.lastPacketTimestampSeconds.set({ peer: peerId }, Date.now() / 1000);
  }

  /**
   * Record an outbound forward attempt that resulted in REJECT. Bytes still count —
   * the packet was serialised and sent (or attempted). This matches Town's "is this
   * peer erroring?" dashboard question (§5.1 of requirements doc).
   */
  recordForwardReject(peerId: string, bytes: number): void {
    this.packetsRejectedTotal.inc({ peer: peerId }, 1);
    this.bytesSentTotal.inc({ peer: peerId }, bytes);
    this.lastPacketTimestampSeconds.set({ peer: peerId }, Date.now() / 1000);
  }

  /**
   * Record a REJECT that happened before next-hop resolution (validation, no-route,
   * expiry-too-short, credit-limit, claim-gen-failure, settlement-record-failure).
   * Not attributable to a specific outgoing peer; kept as a separate reason-labelled
   * counter family.
   */
  recordPreRoutingReject(reason: PreRoutingRejectReason): void {
    this.packetsRejectedPreRoutingTotal.inc({ reason }, 1);
  }

  /**
   * Record a packet fulfilled via the local-delivery branch (self-route). No-op when
   * peerId is 'unknown'.
   */
  recordLocalDeliver(peerId: string): void {
    if (!peerId || peerId === 'unknown') return;
    this.packetsLocallyDeliveredTotal.inc({ peer: peerId }, 1);
  }

  /**
   * Express middleware for GET /metrics — OpenMetrics text format.
   *
   * This is the value that `HealthServer.metricsMiddleware` has been silently missing
   * in every deployment since Story 12.6 defined the slot. See response doc §3.1 / §10.1.
   */
  createMetricsMiddleware(): RequestHandler {
    return async (_req: Request, res: Response): Promise<void> => {
      try {
        const body = await this.register.metrics();
        res.set('Content-Type', this.register.contentType);
        res.status(200).send(body);
      } catch (error) {
        // Defensive — prom-client .metrics() can only throw on truly broken state (e.g.
        // a Gauge collect function that rejects). Surface as 500 so ops see it.
        res.status(500).json({
          error: 'Internal error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }

  /**
   * Snapshot per-peer metric values for the JSON projection (Story 37.3). Reads the
   * current counter/gauge values for each known peer AND for every peer seen in label
   * state (defensive, in case a peer was removed after counters accumulated).
   */
  async snapshotPeers(): Promise<
    Array<{
      peerId: string;
      packetsForwarded: number;
      packetsRejected: number;
      bytesSent: number;
      bytesReceived: number;
      lastPacketAtUnixSeconds: number;
      packetsLocallyDelivered: number;
    }>
  > {
    const peerIds = new Set<string>(this.knownPeers);
    // Union with any peers that have labelled samples (counter label state persists
    // even after unregisterPeer — we don't want to drop historical data in the JSON).
    for (const metric of [
      this.packetsForwardedTotal,
      this.packetsRejectedTotal,
      this.bytesSentTotal,
      this.bytesReceivedTotal,
      this.packetsLocallyDeliveredTotal,
    ] as Array<Metric>) {
      const snapshot = await metric.get();
      for (const value of snapshot.values) {
        const peer = value.labels?.peer;
        if (typeof peer === 'string' && peer.length > 0) peerIds.add(peer);
      }
    }

    const forwarded = await this.packetsForwardedTotal.get();
    const rejected = await this.packetsRejectedTotal.get();
    const sent = await this.bytesSentTotal.get();
    const received = await this.bytesReceivedTotal.get();
    const last = await this.lastPacketTimestampSeconds.get();
    const locallyDelivered = await this.packetsLocallyDeliveredTotal.get();

    const readPeer = (snapshot: Awaited<ReturnType<Counter['get']>>, peerId: string): number => {
      const entry = snapshot.values.find((v) => v.labels?.peer === peerId);
      return entry?.value ?? 0;
    };

    return Array.from(peerIds)
      .sort()
      .map((peerId) => ({
        peerId,
        packetsForwarded: readPeer(forwarded, peerId),
        packetsRejected: readPeer(rejected, peerId),
        bytesSent: readPeer(sent, peerId),
        bytesReceived: readPeer(received, peerId),
        lastPacketAtUnixSeconds: readPeer(last, peerId),
        packetsLocallyDelivered: readPeer(locallyDelivered, peerId),
      }));
  }

  /**
   * Aggregate rollup across all peers for the JSON projection's top-level fields.
   */
  async snapshotAggregate(): Promise<{
    packetsForwarded: number;
    packetsRejected: number;
    bytesSent: number;
    packetsLocallyDelivered: number;
  }> {
    const peers = await this.snapshotPeers();
    return peers.reduce(
      (acc, p) => ({
        packetsForwarded: acc.packetsForwarded + p.packetsForwarded,
        packetsRejected: acc.packetsRejected + p.packetsRejected,
        bytesSent: acc.bytesSent + p.bytesSent,
        packetsLocallyDelivered: acc.packetsLocallyDelivered + p.packetsLocallyDelivered,
      }),
      { packetsForwarded: 0, packetsRejected: 0, bytesSent: 0, packetsLocallyDelivered: 0 }
    );
  }
}
