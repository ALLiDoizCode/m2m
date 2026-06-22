/**
 * Unit tests for the RFC 9421 claim↔request binding verifier (issue #220).
 *
 * Per repo policy: NEVER mock. These tests use real ed25519 keypairs, a real
 * signature base, and real sha-256 content digests end to end. The reference
 * signer ({@link signRequest}) produces the headers; the verifier
 * ({@link verify}) consumes them and must reject any cross-request /
 * cross-price tampering.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { signRequest, publicKeyToKeyid } from './sign';
import { verify } from './verify';
import { computeContentDigest, PRICE_HEADER } from './index';

/** Generate a real ed25519 keypair (32-byte seed + 32-byte pubkey). */
function keypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = ed25519.utils.randomPrivateKey();
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
}

const BODY = new TextEncoder().encode('{"q":"weather in SF"}');
const PRICE = '1000';
const PATH = '/ilp/expensive';
const METHOD = 'POST';

describe('RFC 9421 verify() — claim↔request binding (MVP)', () => {
  it('ACCEPT: correctly-signed request with matching method/path/digest/price', () => {
    const kp = keypair();
    const { headers } = signRequest({
      privateKey: kp.privateKey,
      method: METHOD,
      path: PATH,
      body: BODY,
      price: PRICE,
    });

    const result = verify(headers, BODY, {
      method: METHOD,
      path: PATH,
      expectedPrice: PRICE,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keyid).toBe(publicKeyToKeyid(kp.publicKey));
      expect(result.price).toBe(PRICE);
      expect(typeof result.created).toBe('number');
    }
  });

  it('REJECT different @path: signed for /ilp/cheap, presented as /ilp/expensive', () => {
    const kp = keypair();
    const { headers } = signRequest({
      privateKey: kp.privateKey,
      method: METHOD,
      path: '/ilp/cheap',
      body: BODY,
      price: PRICE,
    });

    const result = verify(headers, BODY, {
      method: METHOD,
      path: '/ilp/expensive',
      expectedPrice: PRICE,
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'signature_invalid' }));
  });

  it('REJECT different @method: signed POST, presented GET', () => {
    const kp = keypair();
    const { headers } = signRequest({
      privateKey: kp.privateKey,
      method: 'POST',
      path: PATH,
      body: BODY,
      price: PRICE,
    });

    const result = verify(headers, BODY, {
      method: 'GET',
      path: PATH,
      expectedPrice: PRICE,
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'signature_invalid' }));
  });

  it('REJECT different body: content-digest mismatch', () => {
    const kp = keypair();
    const { headers } = signRequest({
      privateKey: kp.privateKey,
      method: METHOD,
      path: PATH,
      body: BODY,
      price: PRICE,
    });

    const tamperedBody = new TextEncoder().encode('{"q":"expensive query"}');
    const result = verify(headers, tamperedBody, {
      method: METHOD,
      path: PATH,
      expectedPrice: PRICE,
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'digest_mismatch' }));
  });

  it('REJECT different price: signed price ≠ expected price (core AC)', () => {
    const kp = keypair();
    const { headers } = signRequest({
      privateKey: kp.privateKey,
      method: METHOD,
      path: PATH,
      body: BODY,
      price: '1', // cheap claim
    });

    const result = verify(headers, BODY, {
      method: METHOD,
      path: PATH,
      expectedPrice: '1000', // expensive route
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'price_mismatch' }));
  });

  it('REJECT tampered signature byte', () => {
    const kp = keypair();
    const { headers, label } = signRequest({
      privateKey: kp.privateKey,
      method: METHOD,
      path: PATH,
      body: BODY,
      price: PRICE,
    });

    // Flip a byte inside the base64 signature payload.
    const sig = headers['signature']!;
    const m = /^(.*=:)([A-Za-z0-9+/]+={0,2})(:)$/.exec(sig);
    if (!m) throw new Error('signature header did not match expected shape');
    const raw = Buffer.from(m[2]!, 'base64');
    raw[0]! ^= 0xff;
    headers['signature'] = `${m[1]}${raw.toString('base64')}${m[3]}`;
    expect(label).toBeTruthy();

    const result = verify(headers, BODY, {
      method: METHOD,
      path: PATH,
      expectedPrice: PRICE,
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'signature_invalid' }));
  });

  it('REJECT wrong keyid: signed by K1, keyid claims K2', () => {
    const k1 = keypair();
    const k2 = keypair();
    const { headers } = signRequest({
      privateKey: k1.privateKey,
      method: METHOD,
      path: PATH,
      body: BODY,
      price: PRICE,
      keyid: publicKeyToKeyid(k2.publicKey), // forge: claim K2's identity
    });

    const result = verify(headers, BODY, {
      method: METHOD,
      path: PATH,
      expectedPrice: PRICE,
    });

    // The base is verified against K2's pubkey but signed by K1 → invalid.
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'signature_invalid' }));
  });

  it('REJECT missing Signature / Signature-Input headers', () => {
    const result = verify({ 'content-digest': computeContentDigest(BODY) }, BODY, {
      method: METHOD,
      path: PATH,
      expectedPrice: PRICE,
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'missing_signature' }));
  });

  it('REJECT missing content-digest header', () => {
    const kp = keypair();
    const { headers } = signRequest({
      privateKey: kp.privateKey,
      method: METHOD,
      path: PATH,
      body: BODY,
      price: PRICE,
    });
    delete headers['content-digest'];

    const result = verify(headers, BODY, {
      method: METHOD,
      path: PATH,
      expectedPrice: PRICE,
    });
    // Missing covered component is surfaced via the digest gate.
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'digest_mismatch' }));
  });

  it('price binding header is TOON-Price (canonical toon-price)', () => {
    const kp = keypair();
    const { headers } = signRequest({
      privateKey: kp.privateKey,
      method: METHOD,
      path: PATH,
      body: BODY,
      price: PRICE,
    });
    expect(headers[PRICE_HEADER]).toBe(PRICE);
    expect(PRICE_HEADER).toBe('toon-price');
  });
});
