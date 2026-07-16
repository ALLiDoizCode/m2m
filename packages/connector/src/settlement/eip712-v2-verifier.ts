/**
 * v2 EIP-712 Claim Verification Helper — RollingSwapChannel domain
 *
 * NON-BREAKING Phase 4a of connector#329 (refs #328). This module proves the v2
 * balance-proof verify algorithm against golden vectors WITHOUT wiring it into
 * the live inbound claim path. The production verifier
 * (`InboundClaimValidator.verifyEVMClaim`) is intentionally byte-unchanged in
 * this PR — this helper is dead/uncalled and exists only so the algorithm can be
 * pinned and reviewed before the hot path is flipped in a later (breaking) phase.
 *
 * All cryptography is delegated to the published, dependency-light
 * `@toon-protocol/settlement-digest` leaf (Phase 1). That leaf exposes a
 * noble-type-free API boundary (bytes / hex / plain objects only), so it can
 * install its own `@noble/* ^2` nested while the connector keeps `@noble/* ^1`.
 * This module therefore imports NOTHING from `@noble/*` directly.
 *
 * v2 domain: `EIP712Domain(name="RollingSwapChannel", version="2", chainId,
 * verifyingContract)`; struct
 * `ClaimBalanceProof(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce,address recipient)`.
 * Unlike v1, v2 REQUIRES `chainId` + `verifyingContract` — a signature is valid
 * on exactly one (chain, contract) pair.
 *
 * @module eip712-v2-verifier
 */

import {
  recoverEvmClaimSigner,
  verifyEvmClaimSignature,
  hexToBytes,
  type EvmClaimDigestParams,
} from '@toon-protocol/settlement-digest';

/**
 * Plain, dependency-free params for a v2 EVM balance-proof claim. Structurally
 * the leaf's {@link EvmClaimDigestParams}; re-exported here so connector callers
 * need not reach into the leaf's type namespace.
 */
export type EVMClaimV2Params = EvmClaimDigestParams;

/**
 * Result of a v2 claim verification: whether the recovered signer matches the
 * expected address, plus the recovered lowercase `0x` address for logging.
 */
export interface EVMClaimV2VerifyResult {
  valid: boolean;
  /** Lowercase `0x`-prefixed recovered signer address. */
  recovered: string;
}

/**
 * Normalize an EVM claim signature to the 65-byte `r||s||v` form the leaf's
 * recover/verify helpers require.
 *
 * Accepts either a hex string (with or without a `0x` prefix) or a raw
 * `Uint8Array`. Throws a plain `Error` if the decoded signature is not exactly
 * 65 bytes — matching the leaf's own boundary contract (it never sees a
 * malformed length).
 */
export function normalizeSignature65(signature: string | Uint8Array): Uint8Array {
  const bytes =
    typeof signature === 'string'
      ? hexToBytes(
          signature.startsWith('0x') || signature.startsWith('0X') ? signature.slice(2) : signature
        )
      : signature;
  if (bytes.length !== 65) {
    throw new Error(
      `Invalid EVM signature length: expected 65 bytes (r||s||v), got ${bytes.length}`
    );
  }
  return bytes;
}

/**
 * Recover the EVM signer of a v2 balance-proof claim.
 *
 * Reconstructs the v2 EIP-712 digest from `claim` (channelId, cumulativeAmount,
 * nonce, recipient, chainId, verifyingContract) and recovers the secp256k1
 * signer from `signature`. Returns a lowercase `0x`-prefixed address.
 *
 * Throws a plain `Error` on malformed field lengths or an invalid signature.
 */
export function recoverEVMClaimV2Signer(
  claim: EVMClaimV2Params,
  signature: string | Uint8Array
): string {
  return recoverEvmClaimSigner(claim, normalizeSignature65(signature));
}

/**
 * Verify a v2 balance-proof claim signature against an expected signer.
 *
 * Recovers the signer from `claim` + `signature` and compares
 * (case-insensitively) to `expectedSigner`. Returns `{ valid, recovered }`.
 *
 * @param claim - v2 claim params (REQUIRES chainId + verifyingContract).
 * @param signature - 65-byte `r||s||v` signature as hex string or bytes.
 * @param expectedSigner - the `0x` address the claim must be signed by.
 */
export function verifyEVMClaimV2(
  claim: EVMClaimV2Params,
  signature: string | Uint8Array,
  expectedSigner: string
): EVMClaimV2VerifyResult {
  return verifyEvmClaimSignature(claim, normalizeSignature65(signature), expectedSigner);
}
