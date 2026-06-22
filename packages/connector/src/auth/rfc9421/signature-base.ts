/**
 * RFC 9421 §2.3 signature-base builder (MVP covered set for issue #220).
 *
 * The MVP binds a prepaid claim to THIS request by covering exactly four
 * components, in this fixed order:
 *
 *   1. `@method`          — the HTTP method (derived component, RFC 9421 §2.2.1)
 *   2. `@path`            — the absolute path of the request target (§2.2.5)
 *   3. `content-digest`   — the RFC 9530 digest of the raw body (§2.1)
 *   4. `toon-price`       — the signed price for this request (HTTP field, §2.1)
 *
 * PRICE HEADER DECISION (#220): the price is bound via a dedicated request
 * header `TOON-Price` (canonical lower-case field name `toon-price`). We use a
 * dedicated header rather than reusing `X-TOON-Amount` because `X-TOON-Amount`
 * is injected by the connector *toward the upstream* (#216 HttpProxyHandler) and
 * is not part of the inbound, client-signed surface. `TOON-Price` is set and
 * signed by the client and carries the price the claim is paying for; the
 * terminator later recomputes the expected price from #218 route config and
 * rejects on mismatch (`price_mismatch`). The value is an opaque ASCII string
 * (e.g. a decimal amount); this module does not interpret it.
 *
 * The trailing line is the `@signature-params` component (§2.3), whose value is
 * the serialised covered-component list plus parameters `created`, `keyid`, and
 * `alg`. `alg` is always `"ed25519"` in this MVP.
 *
 * This is a deliberately minimal subset of RFC 9421:
 *   - Component identifiers carry NO parameters (no `;sf`, `;bs`, `;tr`, etc.).
 *   - Field values are taken verbatim (single header line, OWS-trimmed); we do
 *     NOT implement field-value canonicalisation for multi-line / multi-value
 *     fields. Callers control the covered fields, so this is sufficient.
 *
 * @packageDocumentation
 */

import { CONTENT_DIGEST_HEADER } from './content-digest';

/** Canonical (lower-case) field name of the signed price header. */
export const PRICE_HEADER = 'toon-price';

/** Display/wire casing of the price header for clients setting it. */
export const PRICE_HEADER_WIRE = 'TOON-Price';

/** The signature algorithm token used in `@signature-params`. */
export const SIGNATURE_ALG = 'ed25519';

/**
 * The fixed, ordered list of covered component identifiers for the MVP.
 * Derived components are prefixed with `@`; the rest are HTTP field names.
 */
export const COVERED_COMPONENTS: readonly string[] = [
  '@method',
  '@path',
  CONTENT_DIGEST_HEADER,
  PRICE_HEADER,
] as const;

/** The request facts needed to derive the covered components. */
export interface RequestContext {
  /** HTTP method, e.g. `POST`. Case is normalised to upper-case per §2.2.1. */
  method: string;
  /** Absolute request path (no query), e.g. `/ilp/expensive`. */
  path: string;
  /** Lower-cased header map. Values are the verbatim single-line field values. */
  headers: Record<string, string>;
}

/** Parameters carried by `@signature-params`. */
export interface SignatureParams {
  /** Unix seconds when the signature was created (§2.3 `created`). */
  created: number;
  /** The signer's key identifier. In MVP this is the signer's ed25519 pubkey. */
  keyid: string;
  /** Signature algorithm token. Always `ed25519` in this MVP. */
  alg?: string;
  /**
   * Optional Unix-seconds expiry (§2.3 `expires`). The MVP does NOT enforce
   * expiry (see verify.ts); it is included in the base verbatim if present so
   * that signer and verifier agree byte-for-byte. Expiry enforcement is
   * deferred (tracked with the replay cache in #224).
   */
  expires?: number;
}

/**
 * Render the value side of a single covered component (the part after the
 * quoted identifier and the colon). Throws if a required component is absent —
 * a missing covered component means the signature cannot be reconstructed and
 * MUST be treated as a verification failure by the caller.
 */
function componentValue(id: string, req: RequestContext): string {
  switch (id) {
    case '@method':
      return req.method.toUpperCase();
    case '@path':
      return req.path;
    default: {
      // HTTP field component (e.g. content-digest, toon-price).
      const v = req.headers[id];
      if (v === undefined) {
        throw new SignatureBaseError(`missing covered component: ${id}`);
      }
      // OWS-trim per RFC 9421 field-value handling (§2.1).
      return v.trim();
    }
  }
}

/** Thrown when the signature base cannot be constructed for THIS request. */
export class SignatureBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureBaseError';
  }
}

/**
 * Serialise the `@signature-params` inner-list value (the value that is signed
 * AND that appears verbatim in the `Signature-Input` header), e.g.:
 *
 *   ("@method" "@path" "content-digest" "toon-price");created=123;keyid="…";alg="ed25519"
 *
 * @param components - The ordered covered-component identifiers.
 * @param params - The signature parameters.
 */
export function serializeSignatureParams(
  components: readonly string[],
  params: SignatureParams
): string {
  const inner = components.map((c) => `"${c}"`).join(' ');
  let out = `(${inner})`;
  out += `;created=${params.created}`;
  if (params.expires !== undefined) out += `;expires=${params.expires}`;
  out += `;keyid="${params.keyid}"`;
  out += `;alg="${params.alg ?? SIGNATURE_ALG}"`;
  return out;
}

/**
 * Build the RFC 9421 §2.3 canonical signature-base string for the MVP covered
 * set. The returned string is the exact byte sequence to be signed/verified.
 *
 * Each line is `"<component-id>": <value>` followed by a newline; the final
 * line is `"@signature-params": <serialized-params>` with NO trailing newline.
 *
 * @param req - The request facts (method, path, headers).
 * @param params - The signature parameters (`created`, `keyid`, `alg`, …).
 * @param components - Covered components; defaults to {@link COVERED_COMPONENTS}.
 * @throws {SignatureBaseError} if a covered component is absent on the request.
 */
export function buildSignatureBase(
  req: RequestContext,
  params: SignatureParams,
  components: readonly string[] = COVERED_COMPONENTS
): string {
  const lines: string[] = [];
  for (const id of components) {
    lines.push(`"${id}": ${componentValue(id, req)}`);
  }
  const paramsValue = serializeSignatureParams(components, params);
  lines.push(`"@signature-params": ${paramsValue}`);
  return lines.join('\n');
}
