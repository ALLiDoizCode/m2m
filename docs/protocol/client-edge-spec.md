# Client edge specification

**Status:** Normative. Version 1 documents current, shipped behavior; §3 defines how a future
version is introduced per [ADR 0003](../adr/0003-clean-room-peer-wire-versioned-client-edge.md).
**Consumers:** `toon-client` and any other app that pays this connector directly — installed on
machines this repository's operators do not control.
**Vocabulary:** [`CONTEXT.md`](../../CONTEXT.md). The key words MUST, MUST NOT, SHOULD and MAY
are per RFC 2119.

The **client edge** is the protocol a client speaks to the connector it attaches to
(`CONTEXT.md`). Unlike the peer wire, it is versioned rather than redesigned: its far end is
software this repository does not ship and cannot flag-day, so an old version keeps working
after a new one exists ([ADR 0003](../adr/0003-clean-room-peer-wire-versioned-client-edge.md),
[ADR 0001](../adr/0001-rust-workspace-library-first.md) — `connector-client-edge` is exposed as
an HTTP router).

## Scoping note

Today's TypeScript connector accepts client traffic over two transports: the duplex,
session-stateful BTP WebSocket (RFC-0023) that also carries peer-to-peer traffic, and the
one-shot ILP-over-HTTP binding (RFC-0035) at `POST /ilp`, which the code documents as "the edge
transport for one-shot, stateless purchases — a buyer, a NAT'd client, a browser, or an agent
that only consumes" (`packages/connector/src/http/ilp-http-adapter.ts`). That BTP does double
duty is exactly the conflation [ADR 0003](../adr/0003-clean-room-peer-wire-versioned-client-edge.md)
retires: the peer wire (`docs/protocol/peer-wire-spec.md`) is redesigned freely because both its
ends are operator-controlled, which is never true of a client. This document therefore specifies
the client edge as **ILP-over-HTTP** — `POST /ilp` — since that is the transport whose far end is
genuinely uncontrolled and whose shape carries forward as "version 1" of the versioned scheme. A
client that today reaches this connector over BTP is, for the purposes of this spec, using the
peer wire's current (pre-rewrite) transport as a transitional convenience, not the client edge;
it is out of scope here and is not preserved by the redesigned peer wire.

`POST /admin/ilp/send` (`packages/connector/src/http/ilp-send-handler.ts`) is a distinct,
operator-surface-adjacent interface an app behind this connector uses to ask its _own_ connector
to originate a packet outward. It is not the client edge either — the caller there is the
connector's own app, not an unaffiliated payer — and is out of scope for this document.

## 1. Version 1 (current)

### 1.1 Transport and framing

- **Method/path:** `POST /ilp`.
- **Request body:** an ILPv4 PREPARE packet (RFC-0027), OER-encoded (RFC-0030),
  `Content-Type: application/octet-stream`.
- **Response:** `200 OK` with an OER-encoded FULFILL or REJECT body, `Content-Type:
application/octet-stream`. An ILP-level outcome — fulfilled or rejected — is always HTTP 200;
  a non-2xx status is reserved for a transport-level failure and never carries an OER body:

  | Status | Meaning                                                                         |
  | ------ | ------------------------------------------------------------------------------- |
  | `400`  | Malformed request: not a PREPARE, undecodable OER, oversized body.              |
  | `401`  | An `ILP-Peer-Id` was presented but authentication failed.                       |
  | `402`  | x402 v2 payment-required greeting (§1.4) — a JSON body, not OER.                |
  | `413`  | Request body exceeds the configured maximum (default 5 MiB).                    |
  | `500`  | Reserved by this spec for transport failure only; an unexpected                 |
  |        | internal error during routing is surfaced as a `200` + `T00` REJECT, not a 500. |

### 1.2 Identity

A request identifies its sender in one of two ways:

- **Configured peer:** `ILP-Peer-Id: <id>` plus `Authorization: Bearer <secret>` (an empty
  bearer, i.e. `Authorization` absent with `ILP-Peer-Id` present, is accepted on a
  permissionless-configured identity — mirrors BTP's `secret: ''` auth frame). Failure to
  authenticate a presented `ILP-Peer-Id` is `401`.
- **Anonymous:** no `ILP-Peer-Id`. The connector derives an ephemeral peer id from the plaintext
  `ILP-Payment-Channel-Claim` header's signer (`http:<signerAddress-or-signerPublicKey>`), or
  `http:anon` if that header is absent — including when only the wrapped
  `ILP-Payment-Channel-Claim-Wrapped` header is present, since deriving an identity from it would
  require unwrapping before the identity used to authenticate the request is known. This is the
  path an unaffiliated buyer uses — no prior registration with the connector's operator is
  required to pay for a terminated route.

### 1.3 Payment claim

A request pays with a claim header, in the same JSON shape and version (`version: '1.0'`,
discriminated by `blockchain: 'evm' | 'solana' | 'mina'`) the peer wire's predecessor (BTP)
protocol carried, defined in `packages/connector/src/btp/btp-claim-types.ts`:

| Header                              | Content                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| `ILP-Payment-Channel-Claim`         | `base64(JSON.stringify(claim))`, plaintext.                  |
| `ILP-Payment-Channel-Claim-Wrapped` | `base64(NIP-59-wrapped claim)`, for a privacy-wrapped claim. |

Required fields on every claim, regardless of chain: `version` (`'1.0'`), `blockchain`,
`messageId` (idempotency), `timestamp` (ISO 8601), `senderId`. Chain-specific fields:

- **evm**: `channelId` (bytes32 hex), `nonce` (uint), `transferredAmount` (decimal string,
  cumulative), `lockedAmount`/`locksRoot` (present on the wire today for backward compatibility
  but always zero — see [ADR 0004](../adr/0004-value-moves-on-fulfilment.md) — and dropped
  entirely once a client edge version built against the rewritten balance proof ships),
  `signature` (EIP-712), `signerAddress`; optional `chainId`, `tokenNetworkAddress`,
  `tokenAddress` for dynamic on-chain verification of an unregistered channel.
- **solana**: `programId`, `channelAccount` (both base58), `nonce`, `transferredAmount` (lamports,
  decimal string), `signature` (base64 Ed25519), `signerPublicKey` (base58); optional `cluster`.
- **mina**: `zkAppAddress` (B62), `tokenId`, `balanceCommitment` (Poseidon hash), `nonce`, `proof`
  (base64 zk-SNARK), `salt`; optional dual-party fields `transferredAmount`, `balanceB`,
  `signatureB`, and self-describing `signerPublicKey`, `network`.

A present claim is validated by the same gate the peer wire uses (the inbound claim validator)
before the PREPARE is routed, in this order — deliberately freshness-and-value before
cryptography, so a replay or an underpayment never pays the cost of a signature or zk-SNARK
verification and never reaches the terminating app:

1. **Structural validation** — required/optional fields per chain, formats (hex length, base58
   alphabet, B62 prefix) as enumerated above; a structurally invalid claim is rejected.
2. **Freshness** — the claim's nonce MUST strictly advance this connector's last-verified
   watermark for the (peer, blockchain, channel) tuple; a non-advancing nonce is rejected without
   spending a cryptographic verification on it.
3. **Value binding** (for a locally-terminated, priced route) — the claim's cumulative amount
   MUST advance by at least the route's configured flat price, so a minimal fresh claim cannot pay
   for an expensive route. For EVM and Solana this compares the claim's plaintext
   `transferredAmount` directly. For Mina, whose commitment is opaque, this check opens the
   Poseidon commitment against a plaintext preimage carried alongside it (`transferredAmount`,
   `balanceB`, `salt`) when present, rejecting a claim whose preimage does not open its own signed
   commitment; a claim with no preimage skips value binding unless the connector's
   `minaValueBindingStrict` setting requires one, in which case an absent preimage is also
   rejected. This is a migration allowance for pre-preimage Mina clients, not a permanent
   EVM/Solana-only carve-out.
4. **Cryptographic verification** — signature (EVM/Solana) or zk-SNARK proof (Mina) recovers to
   the channel's counterparty.

A claim that fails any check is a validation failure and the PREPARE is rejected before it
reaches the terminating app or advances any watermark.

### 1.4 x402 v2 greeting

An **unpaid** request (no claim header of either kind, and no `PAYMENT-SIGNATURE` header) to a
destination this connector terminates locally (a `RouteTermination`, i.e. the connector acting as
a paid reverse proxy in front of an app) receives an early `402 Payment Required` before any
claim validation runs:

- **Response headers:** `Content-Type: application/json`; `PAYMENT-REQUIRED:
base64(JSON.stringify(body))`.
- **Body** (`X402PaymentRequired`, x402 v2 §5.1.1/§5.1.2):
  ```json
  {
    "x402Version": 2,
    "resource": { "url": "<the terminated route's ILP address>" },
    "accepts": [
      {
        "scheme": "exact",
        "network": "<CAIP-2, e.g. eip155:8453>",
        "amount": "<price>",
        "asset": "<token address>",
        "payTo": "<settlement address>",
        "maxTimeoutSeconds": 60
      },
      {
        "scheme": "toon-channel",
        "network": "<ilp address>",
        "amount": "<price>",
        "payTo": "<ilp address>",
        "maxTimeoutSeconds": 60,
        "httpEndpoint": "https://.../ilp",
        "extra": {
          "ilpAddress": "...",
          "endpoint": "/ilp",
          "price": "...",
          "chains": ["evm", "solana", "mina"],
          "settlementAddresses": { "evm": "0x...", "solana": "...", "mina": "..." }
        }
      }
    ]
  }
  ```
  One `exact` entry is emitted per chain the route accepts that x402 can name (EVM → `eip155:*`,
  Solana → `solana:*`) and for which a settlement address is configured; Mina has no x402 network
  id and is offered only inside the `toon-channel` entry's `extra`, which always carries the full
  multi-chain payload so a TOON-aware client can open a channel on any supported chain, including
  ones a vanilla x402 v2 client cannot name.
- A present claim header OR a `PAYMENT-SIGNATURE` header suppresses the greeting; the request then
  flows through §1.3's validation unchanged. The greeting itself performs no claim validation.

### 1.5 Request-request binding (RFC 9421)

For a locally-terminated route configured with `requireRequestBinding: true`, the connector binds
the _inner_ HTTP request it will proxy to the app (the literal HTTP envelope carried verbatim in
the PREPARE's `data` field, whose wire format §1.7 defines) to the claim that pays for it, using
an RFC 9421 HTTP Message
Signature over that inner request with an RFC 9530 `Content-Digest`, plus a `TOON-Price` header
compared byte-exact against the route's configured price:

- **Signature present** (on the inner envelope's `signature`/`signature-input` headers) — ALWAYS
  verified, regardless of the route's enforcement setting. Verification failure rejects the
  PREPARE (never proxies it) with `F01_INVALID_PACKET` for a structural/cryptographic failure or
  `F03_INVALID_AMOUNT` for a price mismatch; the underlying RFC 9421 failure code rides in the
  reject `message` for debuggability.
- **Signature absent** — rejected (`F01`) only when the route's `requireRequestBinding` is `true`;
  otherwise the request proceeds unchanged (do-no-harm default, preserving the claim-only flow for
  routes that have not opted in).
- A route with no `RouteTermination` (an ordinary forwarding destination) never performs this
  check.

This binds a captured claim to the specific request it paid for — a replay of the same claim
against a different request or a different route's price fails the digest/price check.

### 1.6 Probing for cost

This subsection is forward-looking, unlike the rest of §1: today's shipped connector charges a
percentage spread with no per-hop fee accumulation, so there is nothing yet for a REJECT to
report. It specifies what v1's unchanged request/response shape carries once the connector
originating a client's PREPARE speaks the redesigned peer wire
(`docs/protocol/peer-wire-spec.md` §5.2, [ADR 0011](../adr/0011-rejects-accumulate-fees-and-probes-discover-cost.md)) —
version 1 does not change to gain this; only the connector's backend does.

A client MAY send an ordinary PREPARE it expects to be rejected (a probe, `CONTEXT.md` "Probe")
to learn a path's cost. RFC-0027's REJECT `data` is reserved for an application-level reject's own
diagnostic payload (an `F99`/`T99`/`R99` from the terminating app), so `accumulatedFee` MUST NOT be
packed into it; instead the connector returns it as a response header, `TOON-Accumulated-Fee`
(decimal string, `uint64`), alongside the unchanged OER REJECT body — the client-edge equivalent
of the peer wire carrying the field at the frame level, beside the packet, rather than inside it.
The header is present on every REJECT response, `0` when the packet never left this connector.
Because probing traverses the network for free, this connector accepts one only from a sender
authenticated as a configured peer holding an open payment channel with it (§1.2; the anonymous
path is not eligible, since rate-limiting an identity requires one to persist across requests) and
rate-limits probes per that identity. A sender with no channel, or one over its probe rate limit,
is rejected at ingress with `403` (a status this subsection adds to §1.1's table, distinct from
`401`: the peer authenticated successfully, but is not authorized to probe) without being
forwarded.

### 1.7 The envelope

For a locally-terminated route (a `RouteTermination`, per `CONTEXT.md`), the PREPARE's `data`
field carries a literal HTTP/1.1 request — method, target, headers, body — that this connector
extracts and makes to the app; the app's HTTP response travels back the same way, carried in the
FULFILL's `data` field. This subsection is the wire format for both directions, stated normatively
and self-contained: it is recovered from a hand-rolled parser (issue #216) whose TypeScript source
no longer exists in this repository (deleted by #465), not derived from it by reference. It is
deliberately not a conventional HTTP/1.1 message parser — every quirk in §1.7.2 is a place an
RFC 7230-conformant parser would disagree with this connector, and each has a reason.

#### 1.7.1 Wire format

A request envelope is:

```
request-line CRLF
*( header-field CRLF )
CRLF
body
```

where `request-line = method SP target SP http-version` (e.g. `POST /greet HTTP/1.1`) and
`header-field = field-name ":" OWS field-value` (e.g. `Content-Type: application/json`). A
response envelope is the same shape with a status-line in place of the request-line:
`http-version SP status-code SP reason-phrase` (e.g. `HTTP/1.1 200 OK`).

`CRLF` is exactly the two bytes `0x0D 0x0A`, `SP` is exactly `0x20`. The grammar above is
otherwise exactly what is written to the wire — this is a serialization, not an abstraction over
one.

#### 1.7.2 Quirks

Each of these is a place a conventional HTTP/1.1 parser diverges from this connector; recovering
them is this subsection's reason to exist.

- **The head is decoded as Latin-1** (ISO-8859-1), not UTF-8 or US-ASCII. Latin-1 maps every byte
  `0x00`-`0xFF` to its own code point one-to-one, so decoding then re-encoding is lossless for any
  byte sequence — including one that is not valid UTF-8 — because the head is never assumed to be
  text in a particular charset, only octets that happen to fit the request/status-line and
  header-field grammar above.
- **The body is everything after the first blank line, with no length or transfer-encoding
  interpretation whatsoever.** There is no `Content-Length` or `Transfer-Encoding` framing in this
  format — those exist in HTTP/1.1 so one connection can carry more than one message end-to-end,
  and an envelope never does; it is exactly one request or one response. The body is simply "the
  rest of the buffer": binary-safe, and exactly as long as what remains once the head is removed.
- **A payload with no blank line is all head and an empty body.** The blank-line search can find
  nothing (a request with a request-line and headers but no trailing blank line); rather than
  treat that as malformed, the whole payload is treated as the head and the body is empty. This
  tolerates a minimal, bodyless envelope (e.g. a `GET`) that omits the final blank line.
- **Header name casing is preserved, not normalized.** A conventional HTTP stack lower-cases or
  title-cases header names on the way in, because HTTP header names are case-insensitive; this
  format keeps the bytes the sender wrote. This matters because §1.5's request-request binding
  signs the envelope as sent — normalizing a name before verifying a signature computed over the
  original casing would make every signed request fail to verify.
- **Duplicate headers are preserved as an ordered list, not folded.** A map keyed by header name
  can hold only one value per name, silently dropping or concatenating repeats; this format keeps
  every header field as its own entry, in wire order, so a caller that sent two headers of the
  same name gets both back, and a signature computed over the repeated field is preserved intact.
- **Only leading optional whitespace after the colon is stripped; internal spacing is kept.** RFC
  7230's `OWS` production allows (but does not require) whitespace immediately after a
  field-name's colon; this format strips exactly that and nothing else — a value's internal or
  trailing whitespace is significant to whatever reads it next (e.g. a signature base string) and
  is never trimmed.

#### 1.7.3 Reject codes

Decoding the request envelope, or reaching the app to deliver it, can fail before the PREPARE is
ever fulfilled; each failure is a distinct, fixed reject code:

| Condition                                                                                  | Reject code              | Reason                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data` is malformed — a missing or malformed request-line, or a header field with no colon | `F01_INVALID_PACKET`     | The envelope cannot be parsed at all; this is the same code the client edge already uses for any other malformed PREPARE.                                              |
| `data` is empty (zero bytes)                                                               | `F06_UNEXPECTED_PAYMENT` | There is no request to make on the app's behalf — this connector was paid for a delivery it has nothing to deliver.                                                    |
| The app could not be reached at all (the connection could not be established)              | `T01_PEER_UNREACHABLE`   | Retryable: nothing about the request itself was rejected, the app simply could not be reached.                                                                         |
| The request to the app timed out awaiting a response                                       | `T00_INTERNAL_ERROR`     | Retryable, distinct from `T01`: the app was reachable but did not respond in time, which is this connector's own timeout expiring, not a confirmed connection failure. |

A malformed request-line and a header field with no colon are both `F01_INVALID_PACKET` at the
protocol level, but are distinguishable failures in the codec itself (distinct error values, each
carrying the offending line) — an operator debugging a client's envelope needs to know which half
of the head was wrong, even though a client only ever sees the one reject code either way.

#### 1.7.4 Codec

`connector_domain::envelope` implements this subsection: `decode_request`/`encode_request` for the
request direction, and `encode_response` for the response direction. The request codec is
byte-faithful and round-trips: `encode_request(decode_request(bytes)?) == bytes` for every
well-formed `bytes`, including one carrying a binary body. There is no `decode_response`, because
this connector only ever produces a response envelope; it never decodes one.

## 2. What version 1 does not do

Version 1 has no field or header identifying its own version. That is the gap §3 closes: version
1 is the version a client speaks when it addresses `POST /ilp` with none of the version-selection
mechanism below, and is preserved exactly as specified above for as long as any client depends on
it — per [ADR 0013](../adr/0013-cut-over-through-a-parallel-address-space.md), the old fleet stays
up until nothing addresses its prefix.

## 3. Introducing a new version

A new client edge version is additive, never a breaking change to an existing one — the
mechanism below exists specifically so `toon-client` (and any other installed client) keeps
working, unmigrated, indefinitely.

### 3.1 Version-qualified paths

Each supported version is served at its own path: `POST /ilp/v{N}`. The unversioned `POST /ilp`
path (§1) is kept forever as a permanent alias for `v1` — a client that never adopts versioning
is a `v1` client by definition and is never asked to change. Introducing version `N+1` means
adding a new `POST /ilp/v{N+1}` handler beside the existing ones; it MUST NOT alter the behavior
of any lower-numbered path.

### 3.2 Discovering what a connector supports

`GET /ilp/versions` is unauthenticated (client-edge-facing, like the greeting in §1.4) and returns:

```json
{ "supported": [1, 2], "default": 1 }
```

`default` is the version `POST /ilp` (unversioned) currently serves — always `1`, per §3.1's
permanence guarantee; the field exists so a client can assert its assumption rather than infer it.
A client SHOULD call this once (and MAY cache the result) before deciding whether to address a
version-qualified path, but is never required to — addressing `/ilp` directly always works.

### 3.3 Agreement

A client and this connector agree on which version is in use by the path the client chooses to
address: `POST /ilp` (or `/ilp/v1`) is a version-1 exchange end to end; `POST /ilp/v2` is a
version-2 exchange end to end. There is no per-request negotiation or content-type haggling — the
path is the entire agreement, which keeps the client edge as small as the two-repository
implementation cost in [ADR 0003](../adr/0003-clean-room-peer-wire-versioned-client-edge.md)
demands (implemented once in Rust, once in TypeScript for `toon-client`, and complexity here is
paid twice on those grounds alone). A connector that does not implement a version a client
requests returns `404` on that version's path, distinguishable from every in-spec response
defined above.

### 3.4 Retirement

This spec defines only how a version is _introduced_ alongside an existing one. Retiring a
version — ceasing to serve a version-qualified path — is a separate operational decision outside
this document's scope, gated on nothing addressing that version's prefix, mirroring
[ADR 0013](../adr/0013-cut-over-through-a-parallel-address-space.md)'s treatment of the peer-wire
cutover.

## 4. Consistency

This specification uses exactly the vocabulary of `CONTEXT.md` (connector, app, handler, packet,
route, route termination, client edge, payment channel, claim, nonce, watermark, fee, price,
probe) and implements [ADR 0001](../adr/0001-rust-workspace-library-first.md) and
[ADR 0003](../adr/0003-clean-room-peer-wire-versioned-client-edge.md). It does not use
"terminator", "BLS"/"Business Logic Server", or "agent runtime" (all deprecated); it uses "app"
and "handler" for the payment-oblivious service behind a terminated route.
