/**
 * Tests for the self-announce publish PLAN (relay#37 / store#22).
 *
 * The plan is the local-free vs remote-paid decision. `amount` is the single
 * thing that distinguishes a free local delivery from a paid forward: the
 * connector's `PacketHandler` attaches a per-packet settlement claim iff a
 * value-bearing forward has `amount > 0n`. So these tests assert payment IS
 * attached on the remote branch (amount > 0) and is NOT on the local branch
 * (amount 0) — exactly the property the coordinator asked to pin down — plus
 * that the inner `POST /write` envelope carries the signed event.
 *
 * @module discovery/self-announce-publish.test
 */

import { generateSecretKey } from 'nostr-tools';
import { decodeHttpRequest } from '../core/handlers/http-proxy-handler';
import { buildIlpPeerInfoEvent } from './ilp-peer-info-event';
import {
  planAnnouncePublish,
  encodeWriteEnvelope,
  DEFAULT_ANNOUNCE_PRICE,
} from './self-announce-publish';

const sk = generateSecretKey();
const event = buildIlpPeerInfoEvent(
  { ilpAddress: 'g.proxy.store', btpEndpoint: '', assetCode: 'USDC', assetScale: 6 },
  sk
);

describe('encodeWriteEnvelope', () => {
  it('encodes a byte-faithful POST /write carrying { event }', () => {
    const env = decodeHttpRequest(encodeWriteEnvelope(event));
    expect(env.method).toBe('POST');
    expect(env.target).toBe('/write');
    const headerNames = env.headers.map(([n]) => n.toLowerCase());
    expect(headerNames).toContain('content-type');
    const body = JSON.parse(env.body.toString('utf8')) as { event: { id: string; sig: string } };
    expect(body.event.id).toBe(event.id);
    expect(body.event.sig).toBe(event.sig);
  });
});

describe('planAnnouncePublish — local terminate (apex) = FREE', () => {
  it('plans amount 0 (no claim attached) when announceTo is locally terminated', () => {
    const plan = planAnnouncePublish({
      announceTo: 'g.proxy.relay',
      event,
      isLocallyTerminated: true,
      remotePriceAtomic: '1000',
    });
    expect(plan.mode).toBe('local-free');
    expect(plan.destination).toBe('g.proxy.relay');
    // amount 0n ⇒ PacketHandler attaches NO per-packet claim ⇒ free.
    expect(plan.amount).toBe(0n);
  });
});

describe('planAnnouncePublish — remote forward (store box) = PAID', () => {
  it('plans amount = announcePrice (> 0, claim attached) when remote', () => {
    const plan = planAnnouncePublish({
      announceTo: 'g.proxy.relay',
      event,
      isLocallyTerminated: false,
      remotePriceAtomic: '1000',
    });
    expect(plan.mode).toBe('remote-paid');
    expect(plan.destination).toBe('g.proxy.relay');
    // amount > 0n ⇒ value-bearing forward ⇒ per-packet claim funded from the
    // connector's own channel ⇒ the connector pays for its own write.
    expect(plan.amount).toBe(1000n);
    expect(plan.amount).toBeGreaterThan(0n);
  });

  it('defaults the remote price when none is configured', () => {
    const plan = planAnnouncePublish({
      announceTo: 'g.proxy.relay',
      event,
      isLocallyTerminated: false,
    });
    expect(plan.amount).toBe(BigInt(DEFAULT_ANNOUNCE_PRICE));
    expect(plan.amount).toBeGreaterThan(0n);
  });
});

describe('planAnnouncePublish — local vs remote payment contrast', () => {
  it('attaches payment on the remote branch and NOT on the local branch', () => {
    const local = planAnnouncePublish({
      announceTo: 'g.proxy.relay',
      event,
      isLocallyTerminated: true,
    });
    const remote = planAnnouncePublish({
      announceTo: 'g.proxy.relay',
      event,
      isLocallyTerminated: false,
    });
    expect(local.amount).toBe(0n); // free
    expect(remote.amount).toBeGreaterThan(0n); // paid
  });
});
