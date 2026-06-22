/**
 * RFC 9421 claim↔request binding (MVP subset, issue #220).
 *
 * Public surface for the net-new verifier/signer modules. The verifier
 * ({@link verify}) is the framework-agnostic entry point the future
 * ilp-http-adapter wiring (gated on #218) will call; {@link signRequest} is a
 * reference signer for tests/fixtures (production signing is the client's job).
 *
 * @packageDocumentation
 */

export {
  computeContentDigest,
  verifyContentDigest,
  parseContentDigest,
  CONTENT_DIGEST_ALG,
  CONTENT_DIGEST_HEADER,
} from './content-digest';
export type { ParsedContentDigest, ContentDigestVerifyResult } from './content-digest';

export {
  buildSignatureBase,
  serializeSignatureParams,
  SignatureBaseError,
  COVERED_COMPONENTS,
  PRICE_HEADER,
  PRICE_HEADER_WIRE,
  SIGNATURE_ALG,
} from './signature-base';
export type { RequestContext, SignatureParams } from './signature-base';

export { verify } from './verify';
export type { VerifyResult, VerifyOptions, VerifyFailureCode } from './verify';

export { signRequest, publicKeyToKeyid, DEFAULT_SIGNATURE_LABEL } from './sign';
export type { SignRequestInput, SignedHeaders } from './sign';
