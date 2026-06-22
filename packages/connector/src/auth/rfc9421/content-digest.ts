/**
 * RFC 9530 Content-Digest helpers (MVP subset for issue #220).
 *
 * Produces and verifies the `Content-Digest` HTTP field over the RAW request
 * body bytes using the `sha-256` algorithm:
 *
 *     Content-Digest: sha-256=:<base64(sha-256(body))>:
 *
 * The value is an RFC 8941 Structured-Fields Dictionary whose member key is the
 * algorithm (`sha-256`) and whose value is a Byte Sequence (base64 wrapped in
 * `:...:`). In this MVP we hash the body bytes EXACTLY as received — there is no
 * JCS / canonicalisation step. That matches the #216 envelope contract, which
 * carries the literal, byte-faithful HTTP message; the digest must therefore be
 * computed over those same bytes for the binding to hold end to end.
 *
 * Only `sha-256` is supported in this MVP. Other algorithms (`sha-512`, `id-*`)
 * are out of scope.
 *
 * @packageDocumentation
 */

import { sha256 } from '@noble/hashes/sha2';

/** The single digest algorithm supported in this MVP. */
export const CONTENT_DIGEST_ALG = 'sha-256';

/** The canonical HTTP field name (lower-cased for header-map lookups). */
export const CONTENT_DIGEST_HEADER = 'content-digest';

/**
 * Compute the RFC 9530 `Content-Digest` field value for the given raw body
 * bytes, e.g. `sha-256=:<base64>:`.
 *
 * @param rawBody - The raw request body bytes, exactly as received on the wire.
 * @returns The full structured-field value (algorithm + wrapped byte sequence).
 */
export function computeContentDigest(rawBody: Uint8Array): string {
  const hash = sha256(rawBody);
  const b64 = Buffer.from(hash).toString('base64');
  return `${CONTENT_DIGEST_ALG}=:${b64}:`;
}

/** Result of parsing a `Content-Digest` field value. */
export interface ParsedContentDigest {
  /** The algorithm token (always lower-cased), e.g. `sha-256`. */
  alg: string;
  /** The raw base64 payload, WITHOUT the surrounding `:` colons. */
  base64: string;
}

/**
 * Parse a single-member `Content-Digest` field value of the form
 * `sha-256=:<base64>:`. Returns `undefined` if the value is malformed or does
 * not carry exactly one recognisable `alg=:bytes:` member.
 *
 * This is intentionally strict and minimal: it does NOT implement the full
 * RFC 8941 dictionary grammar (multiple members, parameters, etc.). The MVP
 * emits and expects a single `sha-256` member.
 */
export function parseContentDigest(value: string): ParsedContentDigest | undefined {
  // Grammar (MVP subset): token "=" ":" base64 ":"
  const match = /^\s*([A-Za-z0-9-]+)\s*=\s*:([A-Za-z0-9+/]+={0,2}):\s*$/.exec(value);
  if (!match || match[1] === undefined || match[2] === undefined) return undefined;
  return { alg: match[1].toLowerCase(), base64: match[2] };
}

/** Structured result of a Content-Digest verification. */
export type ContentDigestVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'malformed' | 'unsupported_alg' | 'mismatch' };

/**
 * Verify that `headerValue` is a well-formed `sha-256` `Content-Digest` that
 * matches the digest of `rawBody`. Constant-time comparison is not required
 * here: the digest is not a secret and an attacker who can compute the hash can
 * also supply the matching body.
 *
 * @param headerValue - The received `Content-Digest` field value (or undefined).
 * @param rawBody - The raw request body bytes to hash and compare against.
 */
export function verifyContentDigest(
  headerValue: string | undefined,
  rawBody: Uint8Array
): ContentDigestVerifyResult {
  if (headerValue === undefined || headerValue.length === 0) {
    return { ok: false, reason: 'missing' };
  }
  const parsed = parseContentDigest(headerValue);
  if (!parsed) return { ok: false, reason: 'malformed' };
  if (parsed.alg !== CONTENT_DIGEST_ALG) return { ok: false, reason: 'unsupported_alg' };

  const expected = Buffer.from(sha256(rawBody)).toString('base64');
  if (parsed.base64 !== expected) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}
