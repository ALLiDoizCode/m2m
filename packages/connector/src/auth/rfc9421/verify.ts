/**
 * RFC 9421 verifier — claim↔request binding (MVP subset, issue #220).
 *
 * Framework-agnostic entry point {@link verify}. It takes a lower-cased header
 * map, the raw request body bytes, and verification options, then:
 *
 *   1. Parses the `Signature` / `Signature-Input` header pair.
 *   2. Enforces the MVP covered-component set (`@method`, `@path`,
 *      `content-digest`, `toon-price`) and `alg="ed25519"`.
 *   3. Verifies the `content-digest` against the raw body (RFC 9530).
 *   4. Rebuilds the §2.3 signature base from THIS request and verifies the
 *      ed25519 signature using the keyid (the signer's own pubkey in MVP).
 *   5. Enforces that the signed `toon-price` equals the caller-supplied
 *      `expectedPrice` — the core anti-replay binding (cheap claim cannot pay
 *      for an expensive route).
 *
 * It returns a structured result so the future adapter wiring (deferred to the
 * project lead at merge time, gated on #218) can map each failure to an ILP
 * reject. This module is intentionally NOT Hono middleware: the real ingress is
 * raw Node http.
 *
 * SCOPE: this stops cross-route / cross-price replay only. Same-request /
 * same-route replay (a replay cache) is explicitly DEFERRED to #224, as is
 * `expires` enforcement and JWKS keyid resolution.
 *
 * @packageDocumentation
 */

import { ed25519 } from '@noble/curves/ed25519';
import { verifyContentDigest } from './content-digest';
import {
  buildSignatureBase,
  SignatureBaseError,
  COVERED_COMPONENTS,
  PRICE_HEADER,
  SIGNATURE_ALG,
  type RequestContext,
  type SignatureParams,
} from './signature-base';

/** Structured failure codes. Stable strings — the adapter maps these to rejects. */
export type VerifyFailureCode =
  | 'missing_signature' // Signature or Signature-Input header absent
  | 'malformed_signature' // headers present but unparseable
  | 'unsupported_alg' // alg != ed25519
  | 'covered_components_mismatch' // signed component set != required MVP set
  | 'missing_component' // a covered component is absent on the request
  | 'digest_mismatch' // content-digest does not match the raw body
  | 'price_mismatch' // signed price != expected price (core AC)
  | 'keyid_mismatch' // keyid does not match the verifying key
  | 'signature_invalid'; // ed25519 verification failed

/** The result of {@link verify}. */
export type VerifyResult =
  | { ok: true; keyid: string; price: string; created: number }
  | { ok: false; code: VerifyFailureCode; detail?: string };

/** Options passed to {@link verify} by the caller (the future adapter). */
export interface VerifyOptions {
  /**
   * The HTTP method of THIS request (e.g. `POST`). Required: the verifier binds
   * `@method`, so the caller must supply the request line facts that are not in
   * the header map.
   */
  method: string;
  /** The absolute request path of THIS request (e.g. `/ilp/expensive`). */
  path: string;
  /**
   * The price the terminator expects for THIS route (recomputed from #218 route
   * config by the caller). The signed `toon-price` MUST equal this string, else
   * `price_mismatch`. Compared as an exact ASCII string; the verifier does not
   * interpret numeric semantics.
   */
  expectedPrice: string;
  /**
   * Optional signature label to verify (e.g. `sig1`). If omitted, the single
   * signature present is used; if multiple are present and no label is given,
   * the result is `malformed_signature` (ambiguous).
   */
  label?: string;
}

/** Parsed `@signature-params` for one labelled signature. */
interface ParsedSignatureInput {
  label: string;
  components: string[];
  params: SignatureParams;
  /** The verbatim serialized params value (for byte-exact base reconstruction). */
  raw: string;
}

/**
 * Parse a `Signature-Input` header into its labelled entries. The grammar is
 * the RFC 8941 Dictionary `label=(...);params`. This MVP parser handles the
 * subset our signer emits: quoted inner-list members and the parameters
 * `created`, `expires` (integers), `keyid`, `alg` (strings).
 */
function parseSignatureInput(value: string): Map<string, ParsedSignatureInput> | undefined {
  const out = new Map<string, ParsedSignatureInput>();
  // Split top-level dictionary members on commas that are not inside ( ) or " ".
  for (const member of splitTopLevel(value, ',')) {
    const eq = member.indexOf('=');
    if (eq < 0) return undefined;
    const label = member.slice(0, eq).trim();
    const rest = member.slice(eq + 1).trim();
    if (!label || rest[0] !== '(') return undefined;

    const close = rest.indexOf(')');
    if (close < 0) return undefined;
    const inner = rest.slice(1, close).trim();
    const components: string[] = [];
    if (inner.length > 0) {
      for (const tok of inner.split(/\s+/)) {
        const m = /^"([^"]*)"$/.exec(tok);
        if (!m || m[1] === undefined) return undefined;
        components.push(m[1]);
      }
    }

    // Parameters follow the closing paren, each prefixed with ';'.
    const paramStr = rest.slice(close + 1);
    let created: number | undefined;
    let expires: number | undefined;
    let keyid: string | undefined;
    let alg: string | undefined;
    for (const p of paramStr.split(';')) {
      const t = p.trim();
      if (!t) continue;
      const pe = t.indexOf('=');
      if (pe < 0) return undefined;
      const k = t.slice(0, pe).trim();
      const v = t.slice(pe + 1).trim();
      switch (k) {
        case 'created':
          created = Number(v);
          if (!Number.isInteger(created)) return undefined;
          break;
        case 'expires':
          expires = Number(v);
          if (!Number.isInteger(expires)) return undefined;
          break;
        case 'keyid':
          keyid = stripQuotes(v);
          break;
        case 'alg':
          alg = stripQuotes(v);
          break;
        default:
          // Unknown parameter — ignore (forward-compatible), but keep it byte
          // exact via `raw` so base reconstruction still matches.
          break;
      }
    }
    if (created === undefined || keyid === undefined) return undefined;

    out.set(label, {
      label,
      components,
      params: { created, expires, keyid, alg },
      raw: rest,
    });
  }
  return out.size > 0 ? out : undefined;
}

/** Parse a `Signature` header (`label=:base64:`) into label→bytes. */
function parseSignature(value: string): Map<string, Uint8Array> | undefined {
  const out = new Map<string, Uint8Array>();
  for (const member of splitTopLevel(value, ',')) {
    const eq = member.indexOf('=');
    if (eq < 0) return undefined;
    const label = member.slice(0, eq).trim();
    const rest = member.slice(eq + 1).trim();
    const m = /^:([A-Za-z0-9+/]+={0,2}):$/.exec(rest);
    if (!label || !m || m[1] === undefined) return undefined;
    out.set(label, new Uint8Array(Buffer.from(m[1], 'base64')));
  }
  return out.size > 0 ? out : undefined;
}

/** Split `s` on `sep` at top level (ignoring separators inside () or ""). */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === '(') depth++;
    else if (!inQuote && ch === ')') depth--;
    else if (!inQuote && depth === 0 && ch === sep) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function stripQuotes(v: string): string {
  const m = /^"([\s\S]*)"$/.exec(v);
  return m && m[1] !== undefined ? m[1] : v;
}

/** True iff the two component lists are equal as ordered sets. */
function sameComponents(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Verify an RFC 9421 signed request against THIS request and the expected price.
 *
 * @param headers - Lower-cased header map of the inbound request.
 * @param rawBody - Raw request body bytes (drives `content-digest`).
 * @param opts - Method/path/expectedPrice of THIS request (+ optional label).
 * @returns A structured {@link VerifyResult}.
 */
export function verify(
  headers: Record<string, string>,
  rawBody: Uint8Array,
  opts: VerifyOptions
): VerifyResult {
  const sigInputHeader = headers['signature-input'];
  const sigHeader = headers['signature'];
  if (!sigInputHeader || !sigHeader) {
    return { ok: false, code: 'missing_signature' };
  }

  const inputs = parseSignatureInput(sigInputHeader);
  const sigs = parseSignature(sigHeader);
  if (!inputs || !sigs) {
    return { ok: false, code: 'malformed_signature' };
  }

  // Resolve which labelled signature to verify.
  let label = opts.label;
  if (!label) {
    if (inputs.size !== 1) {
      return { ok: false, code: 'malformed_signature', detail: 'ambiguous signature label' };
    }
    [label] = inputs.keys();
  }
  if (label === undefined) {
    return { ok: false, code: 'malformed_signature', detail: 'no signature label' };
  }
  const input = inputs.get(label);
  const sigBytes = sigs.get(label);
  if (!input || !sigBytes) {
    return { ok: false, code: 'malformed_signature', detail: `no signature for label ${label}` };
  }

  // Enforce alg.
  const alg = input.params.alg ?? SIGNATURE_ALG;
  if (alg !== SIGNATURE_ALG) {
    return { ok: false, code: 'unsupported_alg', detail: alg };
  }

  // Enforce the exact MVP covered-component set (order-independent).
  if (!sameComponents(input.components, COVERED_COMPONENTS)) {
    return { ok: false, code: 'covered_components_mismatch' };
  }

  // Verify the content-digest against the raw body BEFORE trusting the body.
  const digestResult = verifyContentDigest(headers['content-digest'], rawBody);
  if (!digestResult.ok) {
    return { ok: false, code: 'digest_mismatch', detail: digestResult.reason };
  }

  // Enforce the price binding (core AC). The signed price lives in the covered
  // `toon-price` header; it MUST equal the caller's expected price.
  const signedPrice = headers[PRICE_HEADER];
  if (signedPrice === undefined) {
    return { ok: false, code: 'missing_component', detail: PRICE_HEADER };
  }
  if (signedPrice !== opts.expectedPrice) {
    return { ok: false, code: 'price_mismatch', detail: `signed=${signedPrice}` };
  }

  // Reconstruct the signature base from THIS request. We re-serialize using the
  // parsed components and params so the base reflects the actual request facts;
  // any divergence (method/path/digest/price) yields a verification failure.
  const req: RequestContext = {
    method: opts.method,
    path: opts.path,
    headers,
  };

  let base: string;
  try {
    base = buildSignatureBase(req, input.params, input.components);
  } catch (err) {
    if (err instanceof SignatureBaseError) {
      return { ok: false, code: 'missing_component', detail: err.message };
    }
    throw err;
  }

  // Decode the keyid (MVP: hex-encoded ed25519 public key).
  const keyid = input.params.keyid;
  let publicKey: Uint8Array;
  try {
    publicKey = hexToBytesStrict(keyid);
    if (publicKey.length !== 32) {
      return { ok: false, code: 'keyid_mismatch', detail: 'keyid is not a 32-byte ed25519 pubkey' };
    }
  } catch {
    return { ok: false, code: 'keyid_mismatch', detail: 'keyid is not valid hex' };
  }

  let valid = false;
  try {
    valid = ed25519.verify(sigBytes, new TextEncoder().encode(base), publicKey);
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, code: 'signature_invalid' };
  }

  return { ok: true, keyid, price: signedPrice, created: input.params.created };
}

/** Strict hex decode (even length, hex chars only); throws otherwise. */
function hexToBytesStrict(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('invalid hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
