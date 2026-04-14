/**
 * `.anon` address redaction helper (Epic 35 / Story 35.4).
 *
 * ATOR/Tor hidden-service addresses end in `.anon` and are privacy-sensitive.
 * Structured log fields at INFO/WARN/ERROR/FATAL levels must never leak them.
 * This helper is applied at BTP-layer log sites that emit peer URLs.
 *
 * Story 35.2 already redacts `.anon` inside the SocksTransportProvider, and
 * Story 35.3 redacts it in config validation errors. This module extends the
 * convention to the BTP layer (btp-client, btp-client-manager).
 *
 * @module utils/redact
 */

/** The redaction sentinel used in place of any URL containing `.anon`. */
const REDACTION_SENTINEL = '<redacted-anon>';

/**
 * Redact a peer URL if it contains `.anon` (case-insensitive).
 *
 * - Returns the sentinel `<redacted-anon>` when the URL matches.
 * - Returns the URL unchanged otherwise.
 * - Empty strings pass through unchanged.
 *
 * Match is intentionally conservative: any substring `.anon` anywhere in the
 * URL (scheme, host, path, query) triggers redaction. This is defense-in-depth
 * against future URL shapes and typos.
 *
 * @param url - Peer URL to inspect for `.anon` content.
 * @returns The sentinel if `.anon` is present, otherwise the original URL.
 */
export function redactPeerUrl(url: string): string {
  if (!url) return url;
  if (url.toLowerCase().includes('.anon')) {
    return REDACTION_SENTINEL;
  }
  return url;
}

/**
 * Redact `.anon` tokens embedded inside arbitrary error messages / strings.
 *
 * Network-layer errors emitted by `ws`, Node's DNS resolver, or `net` modules
 * routinely embed the target host/URL in the error message (e.g.,
 * `getaddrinfo ENOTFOUND xyz.anon`, `connect ECONNREFUSED ... wss://xyz.anon/btp`).
 * Passing such messages straight to INFO/WARN/ERROR logs would leak `.anon`
 * addresses — violating the Story 35.4 AC #7 log audit.
 *
 * This helper scrubs every `.anon`-bearing word (whitespace-delimited token) in
 * the input and replaces it with `<redacted-anon>`. Non-matching text is
 * preserved verbatim so operational errors remain diagnosable.
 *
 * - Empty / non-string inputs pass through unchanged.
 * - Match is case-insensitive on the `.anon` substring.
 * - Whole whitespace-delimited tokens containing `.anon` are replaced
 *   (keeps the replacement targeted — we don't nuke the whole message).
 *
 * @param message - Arbitrary error/log string that may embed a `.anon` host.
 * @returns The message with any `.anon`-bearing tokens replaced by the sentinel.
 */
export function redactAnonInMessage(message: string): string {
  if (!message) return message;
  if (!message.toLowerCase().includes('.anon')) return message;
  return message.replace(/\S*\.anon\S*/gi, REDACTION_SENTINEL);
}
