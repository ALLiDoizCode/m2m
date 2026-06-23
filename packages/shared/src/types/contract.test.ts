/**
 * Wire-contract canary. Asserts the runtime validators accept canonical payloads
 * and reject malformed ones, so drift on either side of the wire is caught here.
 */
import {
  PaymentRequestSchema,
  PaymentResponseSchema,
  PeerRegistrationRequestSchema,
} from '../index';

describe('localDelivery contract (PaymentRequest)', () => {
  it('accepts a canonical request', () => {
    const ok = PaymentRequestSchema.safeParse({
      paymentId: 'abc',
      destination: 'g.connector.relay',
      amount: '1000',
      expiresAt: '2026-06-17T00:00:00.000Z',
      data: 'YQ==',
      isTransit: false,
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a request missing expiresAt', () => {
    const bad = PaymentRequestSchema.safeParse({
      paymentId: 'abc',
      destination: 'g.connector.relay',
      amount: '1000',
    });
    expect(bad.success).toBe(false);
  });
});

describe('localDelivery contract (PaymentResponse)', () => {
  it('accepts accept + nested rejectReason', () => {
    expect(PaymentResponseSchema.safeParse({ accept: true }).success).toBe(true);
    expect(
      PaymentResponseSchema.safeParse({
        accept: false,
        rejectReason: { code: 'insufficient_funds', message: 'no' },
      }).success
    ).toBe(true);
  });

  it('rejects a flat code/message response (the old sdk-bridge shape is NOT the wire shape)', () => {
    const bad = PaymentResponseSchema.safeParse({
      accept: false,
      code: 'T00',
      message: 'x',
      rejectReason: 'not-an-object',
    });
    expect(bad.success).toBe(false);
  });
});

describe('admin contract (PeerRegistrationRequest)', () => {
  it('accepts a child peer registration', () => {
    const ok = PeerRegistrationRequestSchema.safeParse({
      id: 'relay-01',
      url: 'ws://relay:3000',
      authToken: '',
      relation: 'child',
      routes: [{ prefix: 'g.connector.relay' }],
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an invalid relation', () => {
    const bad = PeerRegistrationRequestSchema.safeParse({
      id: 'x',
      url: 'ws://x:3000',
      authToken: '',
      relation: 'sibling',
    });
    expect(bad.success).toBe(false);
  });
});
