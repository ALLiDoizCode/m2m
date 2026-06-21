/**
 * Shared peer-secret authentication policy.
 *
 * The connector authenticates peers the same way regardless of transport: a
 * peer presents an id + secret, and the secret is checked against the
 * `BTP_PEER_<ID>_SECRET` environment variable, with an empty secret meaning
 * "no-auth" when `BTP_ALLOW_NOAUTH` is not explicitly disabled.
 *
 * BTP carries the id/secret in its in-band `auth` frame; ILP-over-HTTP carries
 * them in the `ILP-Peer-Id` header + `Authorization: Bearer <secret>`. Both
 * resolve through {@link evaluatePeerSecret} so the two transports share one
 * identity/permission model.
 *
 * NOTE: `btp/btp-server.ts#authenticatePeer` implements this exact policy inline
 * (it needs branch-specific structured logging that existing tests assert). Keep
 * the two in sync — this module is the canonical statement of the policy and the
 * one the HTTP path uses.
 *
 * @module auth/peer-secret-resolver
 * @see RFC-0023 - Bilateral Transfer Protocol (BTP)
 */

/**
 * Outcome of evaluating a peer's presented secret against connector policy.
 */
export interface PeerSecretDecision {
  /** Whether authentication succeeded. */
  ok: boolean;
  /** Which policy branch applied. */
  mode: 'no-auth' | 'secret';
  /** Human-readable failure reason (only set when `ok` is false). */
  reason?: string;
}

/**
 * Derive the environment variable holding a peer's shared secret.
 * Mirrors `btp/btp-server.ts`: uppercase, hyphens → underscores.
 */
export function peerSecretEnvKey(peerId: string): string {
  return `BTP_PEER_${peerId.toUpperCase().replace(/-/g, '_')}_SECRET`;
}

/**
 * Returns true when permissionless (no-auth) connections are allowed.
 * Default is allowed unless `BTP_ALLOW_NOAUTH` is explicitly `'false'`.
 */
export function noAuthAllowed(): boolean {
  return process.env['BTP_ALLOW_NOAUTH'] !== 'false';
}

/**
 * Evaluate a presented `(peerId, secret)` against connector auth policy.
 *
 * - `peerId` missing → reject.
 * - `secret` undefined (field absent) → reject. An empty string is a valid
 *   no-auth request and is distinct from undefined.
 * - `secret === ''` → no-auth: accepted iff {@link noAuthAllowed}.
 * - non-empty secret → must equal the configured `BTP_PEER_<ID>_SECRET`.
 */
export function evaluatePeerSecret(
  peerId: string | undefined,
  secret: string | undefined
): PeerSecretDecision {
  if (!peerId) {
    return { ok: false, mode: 'secret', reason: 'missing peerId' };
  }
  if (secret === undefined) {
    return { ok: false, mode: 'secret', reason: 'secret field missing' };
  }
  if (secret === '') {
    return noAuthAllowed()
      ? { ok: true, mode: 'no-auth' }
      : { ok: false, mode: 'no-auth', reason: 'no-auth mode disabled' };
  }
  const expectedSecret = process.env[peerSecretEnvKey(peerId)];
  if (!expectedSecret) {
    return { ok: false, mode: 'secret', reason: 'peer not configured' };
  }
  if (secret !== expectedSecret) {
    return { ok: false, mode: 'secret', reason: 'invalid secret' };
  }
  return { ok: true, mode: 'secret' };
}
