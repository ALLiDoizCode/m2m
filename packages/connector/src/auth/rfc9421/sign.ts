/**
 * RFC 9421 reference signer (test/fixture use only) — issue #220.
 *
 * Production request signing is the CLIENT's responsibility; the connector only
 * verifies. This module exists to produce valid `Signature` / `Signature-Input`
 * header pairs over the MVP covered set so tests and fixtures can exercise the
 * verifier with real ed25519 signatures (no mocks, per repo policy).
 *
 * Signature scheme (MVP):
 *   - label: a single signature labelled `sig1`.
 *   - alg: ed25519 over the §2.3 signature base.
 *   - keyid: the signer's ed25519 public key, hex-encoded (no JWKS in MVP).
 *   - Signature header value: `sig1=:<base64(sig)>:` (RFC 8941 byte sequence).
 *   - Signature-Input header value: `sig1=<serialized @signature-params>`.
 *
 * @packageDocumentation
 */

import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import { computeContentDigest } from './content-digest';
import {
  buildSignatureBase,
  serializeSignatureParams,
  COVERED_COMPONENTS,
  PRICE_HEADER,
  SIGNATURE_ALG,
  type RequestContext,
  type SignatureParams,
} from './signature-base';

/** The default signature label used by the reference signer. */
export const DEFAULT_SIGNATURE_LABEL = 'sig1';

/** Inputs to {@link signRequest}. */
export interface SignRequestInput {
  /** Ed25519 private key (32-byte seed). */
  privateKey: Uint8Array;
  /** HTTP method, e.g. `POST`. */
  method: string;
  /** Absolute request path (no query), e.g. `/ilp/expensive`. */
  path: string;
  /** Raw request body bytes (drives the `content-digest` component). */
  body: Uint8Array;
  /** The price string to sign into the `TOON-Price` header. */
  price: string;
  /** Unix seconds `created`. Defaults to now. */
  created?: number;
  /** Optional Unix-seconds `expires` (informational in MVP; see signature-base). */
  expires?: number;
  /**
   * Override the keyid. Defaults to the hex-encoded ed25519 public key derived
   * from `privateKey` (the MVP "keyid = signer pubkey" rule). Tests use this to
   * forge a keyid mismatch.
   */
  keyid?: string;
  /** Signature label. Defaults to {@link DEFAULT_SIGNATURE_LABEL}. */
  label?: string;
}

/** The header set produced by {@link signRequest}. */
export interface SignedHeaders {
  /** Lower-cased header map ready to merge into a request. */
  headers: Record<string, string>;
  /** The signature label used (e.g. `sig1`). */
  label: string;
  /** The hex keyid embedded in `Signature-Input`. */
  keyid: string;
}

/** Hex-encode an ed25519 public key for use as an MVP keyid. */
export function publicKeyToKeyid(publicKey: Uint8Array): string {
  return bytesToHex(publicKey);
}

/**
 * Produce a `Content-Digest`, `TOON-Price`, `Signature-Input`, and `Signature`
 * header set that the MVP verifier will accept for the given request facts.
 *
 * The returned `headers` map is lower-cased so it can be merged directly into
 * the verifier's expected header shape.
 */
export function signRequest(input: SignRequestInput): SignedHeaders {
  const label = input.label ?? DEFAULT_SIGNATURE_LABEL;
  const created = input.created ?? Math.floor(Date.now() / 1000);
  const publicKey = ed25519.getPublicKey(input.privateKey);
  const keyid = input.keyid ?? publicKeyToKeyid(publicKey);

  const contentDigest = computeContentDigest(input.body);

  const headers: Record<string, string> = {
    'content-digest': contentDigest,
    [PRICE_HEADER]: input.price,
  };

  const req: RequestContext = {
    method: input.method,
    path: input.path,
    headers,
  };

  const params: SignatureParams = {
    created,
    keyid,
    alg: SIGNATURE_ALG,
    expires: input.expires,
  };

  const base = buildSignatureBase(req, params, COVERED_COMPONENTS);
  const signature = ed25519.sign(new TextEncoder().encode(base), input.privateKey);
  const sigB64 = Buffer.from(signature).toString('base64');

  const sigParamsValue = serializeSignatureParams(COVERED_COMPONENTS, params);

  headers['signature-input'] = `${label}=${sigParamsValue}`;
  headers['signature'] = `${label}=:${sigB64}:`;

  return { headers, label, keyid };
}
