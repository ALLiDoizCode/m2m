/**
 * Unit tests for redactPeerUrl (Epic 35 / Story 35.4).
 *
 * Traceability:
 *   AC #7 (.anon addresses never logged at INFO+ during wiring)
 *   T-35.6-SEC-05, R-05 (log leakage risk)
 */

import { redactPeerUrl, redactAnonInMessage } from './redact';

describe('redactPeerUrl (Story 35.4, AC #7)', () => {
  it('returns the redaction sentinel when the URL contains ".anon" in the host', () => {
    expect(redactPeerUrl('wss://abc123.anon/btp')).toBe('<redacted-anon>');
  });

  it('redacts uppercase and mixed-case ".anon" (defense-in-depth)', () => {
    // Hidden-service addresses are canonically lowercase, but .anon substring
    // match must be case-insensitive so a typo or future variant cannot leak.
    expect(redactPeerUrl('wss://ABC123.ANON/btp')).toBe('<redacted-anon>');
    expect(redactPeerUrl('wss://abc123.Anon/btp')).toBe('<redacted-anon>');
  });

  it('redacts when ".anon" appears anywhere in the URL (conservative)', () => {
    expect(redactPeerUrl('wss://foo.example/.anon/path')).toBe('<redacted-anon>');
    expect(redactPeerUrl('wss://hidden.anon:8080/btp?x=1')).toBe('<redacted-anon>');
  });

  it('returns the URL unchanged for non-.anon addresses', () => {
    expect(redactPeerUrl('wss://peer.example.com/btp')).toBe('wss://peer.example.com/btp');
    expect(redactPeerUrl('ws://localhost:3000')).toBe('ws://localhost:3000');
  });

  it('handles empty string without throwing', () => {
    expect(redactPeerUrl('')).toBe('');
  });

  it('is idempotent on the sentinel value', () => {
    expect(redactPeerUrl('<redacted-anon>')).toBe('<redacted-anon>');
  });
});

describe('redactAnonInMessage (Story 35.4 review fix, AC #7)', () => {
  it('scrubs a .anon host embedded in a DNS error string', () => {
    const msg = 'getaddrinfo ENOTFOUND abcdef.anon';
    expect(redactAnonInMessage(msg)).toBe('getaddrinfo ENOTFOUND <redacted-anon>');
  });

  it('scrubs a wss://<hs>.anon URL embedded in a network error', () => {
    const msg = 'connect ECONNREFUSED wss://xyz.anon/btp';
    expect(redactAnonInMessage(msg)).toBe('connect ECONNREFUSED <redacted-anon>');
  });

  it('redacts every .anon-bearing token when multiple are present', () => {
    const msg = 'retry peer1.anon failed after wss://peer2.anon/btp timed out';
    expect(redactAnonInMessage(msg)).toBe(
      'retry <redacted-anon> failed after <redacted-anon> timed out'
    );
  });

  it('is case-insensitive on the .anon match', () => {
    expect(redactAnonInMessage('ENOTFOUND ABCDEF.ANON')).toBe('ENOTFOUND <redacted-anon>');
  });

  it('returns non-.anon messages unchanged', () => {
    const msg = 'connect ECONNREFUSED 127.0.0.1:9050';
    expect(redactAnonInMessage(msg)).toBe(msg);
  });

  it('handles empty string without throwing', () => {
    expect(redactAnonInMessage('')).toBe('');
  });
});
