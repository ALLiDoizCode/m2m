/**
 * x402 v2 "402 Payment Required" greeting builder (issue #217).
 *
 * Greets an UNPAID HTTP request to a locally-terminated route with an
 * x402 **v2** `402 Payment Required` advertising BOTH:
 *
 *  1. a vanilla on-chain `exact` option (one `accepts[]` entry per x402-defined
 *     chain the route accepts), so an off-the-shelf x402 v2 client degrades
 *     gracefully (issue AC3); and
 *  2. the `toon-channel` upgrade — our own non-standard scheme whose `extra`
 *     carries the FULL multi-chain payload (including Mina, which x402 has no
 *     network id for) so TOON-aware agents upgrade onto a payment channel.
 *
 * Wire shape is pinned against the authoritative x402 v2 spec:
 *   - core: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md (§5.1)
 *   - http transport: https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md
 *
 * v2 `PaymentRequired` (§5.1.2):
 *   { x402Version: 2, error?, resource{ url, description?, mimeType? },
 *     accepts: PaymentRequirements[], extensions? }
 * v2 `PaymentRequirements` (each `accepts[]` entry):
 *   { scheme, network (CAIP-2), amount (atomic string), asset, payTo,
 *     maxTimeoutSeconds, extra? }
 *
 * NOTE: v2 renamed v1's `X-PAYMENT` request header to `PAYMENT-SIGNATURE`, and
 * carries the requirements object in a base64 `PAYMENT-REQUIRED` response header.
 *
 * @module http/x402-greeting
 */

import type { RouteTermination, TerminationChain } from '../config/types';

/** x402 protocol version this greeting speaks. MUST be 2 (v2 wire shape). */
export const X402_VERSION = 2 as const;

/** The v1→v2 request payment header name (was `X-PAYMENT` in v1). */
export const X402_PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE';

/** The v2 response header carrying the base64 `PaymentRequired` object. */
export const X402_PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';

/** Our non-standard upgrade scheme advertised alongside vanilla `exact`. */
export const TOON_CHANNEL_SCHEME = 'toon-channel';

/** The connector's ILP-over-HTTP endpoint a `toon-channel` upgrade pays over. */
export const TOON_CHANNEL_ENDPOINT = '/ilp';

/**
 * Default `maxTimeoutSeconds` advertised on each vanilla `exact` entry — the
 * window an x402 client has to complete the on-chain payment.
 */
export const X402_DEFAULT_MAX_TIMEOUT_SECONDS = 60;

/**
 * A single x402 v2 `PaymentRequirements` entry in the `accepts[]` array.
 * Field names are byte-exact to the v2 spec (§5.1.2).
 */
export interface X402PaymentRequirements {
  /** Payment scheme identifier (e.g. `"exact"`, or our `"toon-channel"`). */
  scheme: string;
  /** Blockchain network in CAIP-2 form (e.g. `"eip155:8453"`, `"solana:<genesis>"`). */
  network: string;
  /** Required payment amount in atomic token units (decimal string). */
  amount: string;
  /** Token contract address (or ISO-4217 code for fiat). Optional for non-`exact` schemes. */
  asset?: string;
  /** Recipient settlement address. */
  payTo: string;
  /** Maximum time allowed for payment completion (seconds). */
  maxTimeoutSeconds: number;
  /** Scheme-specific additional info. */
  extra?: Record<string, unknown>;
}

/** ResourceInfo object describing the protected resource (v2 §5.1.2). */
export interface X402ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

/** Top-level x402 v2 `PaymentRequired` response body (v2 §5.1.1). */
export interface X402PaymentRequired {
  /** Protocol version identifier — MUST be 2. */
  x402Version: typeof X402_VERSION;
  /** Human-readable reason payment is required. */
  error?: string;
  /** ResourceInfo describing the protected resource. */
  resource: X402ResourceInfo;
  /** Acceptable payment methods. */
  accepts: X402PaymentRequirements[];
  /** Protocol extensions data. */
  extensions?: Record<string, unknown>;
}

/**
 * The `extra` payload carried by the `toon-channel` upgrade entry. Holds the
 * FULL multi-chain termination config (including Mina) sourced verbatim from
 * the route's {@link RouteTermination}, so a TOON-aware agent can open/settle a
 * payment channel on any supported chain — including ones x402 cannot name.
 */
export interface ToonChannelExtra {
  /** Connector's advertised ILP address to pay. */
  ilpAddress: string;
  /** ILP-over-HTTP endpoint a channel claim is POSTed to. */
  endpoint: typeof TOON_CHANNEL_ENDPOINT;
  /** Price (atomic nano-USDC decimal string), byte-identical to the route config. */
  price: string;
  /** All settlement chains the route accepts (INCLUDING mina). */
  chains: TerminationChain[];
  /** Chain → payTo settlement address (INCLUDING mina). */
  settlementAddresses: Partial<Record<TerminationChain, string>>;
}

/**
 * Map an internal {@link TerminationChain} (+ the connector's namespaced chainId
 * strings) to an x402 CAIP-2 `network` id, or `null` when x402 defines no
 * network for that chain (i.e. `mina`).
 *
 * - `evm`    → `eip155:<chainId>` — the connector stores EVM chainIds as the
 *   namespaced `evm:<chainId>` string; we re-namespace the numeric suffix to
 *   CAIP-2's `eip155`.
 * - `solana` → `solana:<reference>` — already CAIP-2-shaped (the connector's
 *   `solana:<cluster|genesis>` chainId is passed through verbatim).
 * - `mina`   → `null` — x402 has NO Mina network id; mina rides toon-channel only.
 */
export function chainToCaip2(
  chain: TerminationChain,
  chainIds: Partial<Record<TerminationChain, string>>
): string | null {
  if (chain === 'mina') return null;
  const internal = chainIds[chain];
  if (chain === 'evm') {
    // internal is like `evm:8453` → `eip155:8453`. If only a bare numeric id is
    // supplied, prefix it. Without any id we cannot name the network → skip.
    if (!internal) return null;
    const ref = internal.startsWith('evm:') ? internal.slice('evm:'.length) : internal;
    return ref ? `eip155:${ref}` : null;
  }
  // solana: the connector's chainId (`solana:<cluster|genesis>`) is already a
  // valid CAIP-2 `solana:` network id; pass through. Without one we cannot name it.
  return internal && internal.startsWith('solana:') ? internal : null;
}

/** Inputs needed to build the greeting beyond the route's own termination config. */
export interface X402GreetingContext {
  /**
   * Internal namespaced chainId per chain, e.g. `{ evm: 'evm:8453', solana:
   * 'solana:devnet' }`, sourced from the connector's chainProviders/EVM config.
   * Used to derive each vanilla `exact` entry's CAIP-2 `network`.
   */
  chainIds: Partial<Record<TerminationChain, string>>;
  /** Resource URL to advertise (the terminated route's public URL). */
  resourceUrl: string;
  /** Optional resource description / mimeType for ResourceInfo. */
  resourceDescription?: string;
  resourceMimeType?: string;
  /** Optional `error` string explaining why payment is required. */
  error?: string;
  /**
   * Full absolute URL of the connector's `POST /ilp` endpoint (e.g.
   * `https://proxy.example.com/ilp`). When provided, emitted as `httpEndpoint`
   * on the top-level `toon-channel` accepts entry so TOON-aware clients can
   * locate the payment endpoint without parsing `extra`.
   */
  httpEndpoint?: string;
}

/**
 * Build the x402 v2 `PaymentRequired` body for a locally-terminated route.
 *
 * Emits, sourced entirely from the {@link RouteTermination} (no hardcoding):
 *  - one vanilla `exact` `accepts[]` entry per x402-nameable chain the route
 *    accepts that ALSO has a settlement `payTo` (skips a chain otherwise, never
 *    advertising an unpayable address); and
 *  - exactly one `toon-channel` entry whose `extra` carries the full multi-chain
 *    payload (incl. mina) verbatim from the route config.
 *
 * The `amount`/`price` is advertised byte-for-byte as `termination.price` so it
 * compares exact-string-equal to #220's signed `TOON-Price` header.
 */
export function buildX402Greeting(
  termination: RouteTermination,
  ctx: X402GreetingContext
): X402PaymentRequired {
  const accepts: X402PaymentRequirements[] = [];

  // --- Vanilla on-chain `exact` entries (x402-nameable chains only) ---
  for (const chain of termination.chains) {
    const network = chainToCaip2(chain, ctx.chainIds);
    if (network === null) continue; // mina (or an un-named evm/solana) → upgrade-only
    const payTo = termination.settlementAddresses[chain];
    if (!payTo) continue; // never advertise an unpayable payTo
    const entry: X402PaymentRequirements = {
      scheme: 'exact',
      network,
      amount: termination.price,
      payTo,
      maxTimeoutSeconds: X402_DEFAULT_MAX_TIMEOUT_SECONDS,
    };
    const asset = termination.asset?.[chain];
    if (asset) entry.asset = asset;
    accepts.push(entry);
  }

  // --- toon-channel upgrade (#217): full multi-chain payload incl. mina ---
  const toonExtra: ToonChannelExtra = {
    ilpAddress: termination.ilpAddress,
    endpoint: TOON_CHANNEL_ENDPOINT,
    price: termination.price,
    chains: termination.chains,
    settlementAddresses: termination.settlementAddresses,
  };
  const toonEntry: X402PaymentRequirements & { httpEndpoint?: string } = {
    scheme: TOON_CHANNEL_SCHEME,
    // The upgrade is multi-chain and not bound to a single CAIP-2 network; we
    // surface the connector's ILP address here so the entry is self-describing.
    network: termination.ilpAddress,
    amount: termination.price,
    payTo: termination.ilpAddress,
    maxTimeoutSeconds: X402_DEFAULT_MAX_TIMEOUT_SECONDS,
    extra: toonExtra as unknown as Record<string, unknown>,
  };
  // Hoist the POST /ilp URL to the top level so clients can read it without
  // traversing `extra` (which is a connector-specific extension object).
  if (ctx.httpEndpoint) toonEntry.httpEndpoint = ctx.httpEndpoint;
  accepts.push(toonEntry);

  const resource: X402ResourceInfo = { url: ctx.resourceUrl };
  if (ctx.resourceDescription) resource.description = ctx.resourceDescription;
  if (ctx.resourceMimeType) resource.mimeType = ctx.resourceMimeType;

  const body: X402PaymentRequired = {
    x402Version: X402_VERSION,
    resource,
    accepts,
  };
  if (ctx.error) body.error = ctx.error;
  return body;
}
