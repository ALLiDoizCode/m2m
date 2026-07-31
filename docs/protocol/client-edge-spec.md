# Client edge specification

**Status:** Non-normative. [ADR 0021](../adr/0021-vectors-are-normative-prose-is-not.md) makes the
Rust implementation (`crates/connector-client-edge`) the definition of this wire, and the committed
vector set (`vectors/wire-vectors.json`, issue #527) — fixed literal fixtures pushed through the
real implementation and self-verified against the same functions the invariants listed in
[`docs/protocol/wire-vectors.md`](wire-vectors.md) hold open, not values literally emitted by a
property-test run — the cross-repo contract `toon-client`, `rig` and `swap` are actually held to.
This document remains prose describing that
wire for a human reader: useful as orientation, evidence of intent, and a map of what's shipped
versus what isn't, but it is not itself something to conform to, and a disagreement between this
text and the code is a bug in this text. Where this document and an ADR disagree, the ADR wins —
this document is reconciled to match, not the other way around. Version 1 below is organized by
section number so `crates/connector-client-edge`'s own doc comments can cite it; §3 sketches how a
future version would be introduced, per
[ADR 0003](../adr/0003-clean-room-peer-wire-versioned-client-edge.md).
**Consumers:** `toon-client` and any other app that pays this connector directly — installed on
machines this repository's operators do not control.
**Vocabulary:** [`CONTEXT.md`](../../CONTEXT.md).

The **client edge** is the protocol a client speaks to the connector it attaches to
(`CONTEXT.md`). Unlike the peer wire, it is versioned rather than redesigned: its far end is
software this repository does not ship and cannot flag-day, so an old version keeps working
after a new one exists ([ADR 0003](../adr/0003-clean-room-peer-wire-versioned-client-edge.md),
[ADR 0001](../adr/0001-rust-workspace-library-first.md) — `connector-client-edge` is exposed as
an HTTP router).

## Scoping note

The TypeScript connector's now-removed embedded node (gone as of v4.0.0, [issue
#465](https://github.com/toon-protocol/connector/issues/465)) accepted client traffic over two
transports: the duplex, session-stateful BTP WebSocket (RFC-0023) that also carries peer-to-peer
traffic, and the one-shot ILP-over-HTTP binding (RFC-0035) at `POST /ilp` — its own documentation
described this as the edge transport for one-shot, stateless purchases: a buyer, a NAT'd client, a
browser, or an agent that only consumes. That source no longer exists in this repository but is
recoverable from git history prior to #465. That BTP did double duty is exactly the conflation
[ADR 0003](../adr/0003-clean-room-peer-wire-versioned-client-edge.md) retires: the peer wire
(`docs/protocol/peer-wire-spec.md`) is redesigned freely because both its ends are
operator-controlled, which is never true of a client. This document therefore specifies the
client edge as **ILP-over-HTTP** — `POST /ilp` — since that is the transport whose far end is
genuinely uncontrolled and whose shape carries forward as "version 1" of the versioned scheme. A
client that reached the old embedded node over BTP was, for the purposes of this spec, using the
peer wire's pre-rewrite transport as a transitional convenience, not the client edge; it is out of
scope here and is not preserved by the redesigned peer wire.

`POST /admin/ilp/send` was a distinct, operator-surface-adjacent interface the same removed
embedded node exposed so an app behind this connector could ask its _own_ connector to originate a
packet outward — also recoverable from git history prior to #465, not present in this repository.
It was not the client edge either — the caller there is the
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
  | `401`  | An `ILP-Peer-Id` was presented but authentication failed (§1.2 — not yet        |
  |        | implemented; no request is refused on this ground today).                       |
  | `402`  | Unpaid request to a route this connector terminates and prices: x402 v2         |
  |        | payment-required terms, JSON body (not OER). See §1.4.                          |
  | `403`  | A probe (`POST /ilp/probe`) from a sender not authorized to probe: no           |
  |        | payment channel this connector recognizes, or over its rate limit. See §1.6.    |
  | `413`  | Request body too large. There is no config field for this: the limit is         |
  |        | axum's own `DefaultBodyLimit` (2 MiB), which this router does not override.     |
  | `500`  | Reserved by this spec for transport failure only; an unexpected                 |
  |        | internal error during routing is surfaced as a `200` + `T00` REJECT, not a 500. |

### 1.2 Identity

**Not yet implemented.** No code in `crates/connector-client-edge` reads `ILP-Peer-Id` or
`Authorization` today; every request is handled identically regardless of what it presents on
either header, and the `401` this section describes is never returned. `GET /ilp/identity` (§1.7)
answers a different question — the connector's own key, not who is asking — and ships today. This
section specifies the intended design for the rest:

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

A request pays with a claim header. The claim is a JSON object, `version: '1.0'`, discriminated
by `blockchain: 'evm' | 'solana'` — the shape below is this document's own definition, not a
pointer to source; the peer wire's predecessor (BTP protocol) carried the same shape, but that
code no longer exists in this repository. `blockchain: 'mina'` is a distinct, invalid value here:
see the note at the end of this section.

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
  `tokenAddress`. `signerAddress` and the optional domain fields ride the wire but carry no
  authority — step 4 below reads both the signer and the signing domain from the connector's own
  per-channel record instead.
- **solana**: `programId`, `channelAccount` (both base58), `nonce`, `transferredAmount` (lamports,
  decimal string), `signature` (base64 Ed25519), `signerPublicKey` (base58); optional `cluster`.

A present claim is validated by the same gate the peer wire uses (the inbound claim validator)
before the PREPARE is routed, in this order — deliberately freshness-and-value before
cryptography, so a replay or an underpayment never pays the cost of a signature verification and
never reaches the terminating app:

1. **Structural validation** — required/optional fields per chain, formats (hex length, base58
   alphabet) as enumerated above; a structurally invalid claim is rejected. `blockchain: 'mina'`
   fails here unconditionally — see the note below.
2. **Freshness** — the claim's nonce MUST strictly advance this connector's last-verified
   watermark for the (peer, blockchain, channel) tuple; a non-advancing nonce is rejected without
   spending a cryptographic verification on it.

   The **channel** in that tuple is the channel, not the text the claim spelled it with ([issue
   #643](https://github.com/toon-protocol/connector/issues/643)). A connector MUST identify a
   channel's watermark by a canonical form of the id, applied before the watermark is written or
   read. For `evm` that form is exactly `0x` followed by the `channelId`'s 32 bytes as 64
   **lower-case** hex characters — one spelling, not a family of accepted ones, since a canonical
   form that admitted alternatives would be the same ambiguity again. For `solana` it is the
   `channelAccount` as it arrives: base58 of an exact 32-byte decode already has only one
   spelling, and base58 is case-_sensitive_, so normalising it would merge distinct accounts.
   Hex is case-insensitive and everything else about a claim already treats
   the spellings as one channel — the counterparty record is looked up by the decoded bytes, and
   the EIP-712 digest is computed over them — so a connector that keyed a watermark by the literal
   text would grant a fresh, empty watermark per spelling, and `None` accepts every nonce: one
   signed claim would buy a write once per casing it was retyped in.

3. **Value binding** (for a locally-terminated, priced route) — the claim's cumulative amount
   MUST advance by at least the route's configured flat price, so a minimal fresh claim cannot pay
   for an expensive route. This compares the claim's plaintext `transferredAmount` directly.
4. **Cryptographic verification** — the signature (EIP-712 for EVM, Ed25519 for Solana) MUST
   recover to **the counterparty recorded for the channel the claim names**
   ([issue #558](https://github.com/toon-protocol/connector/issues/558)). A claim's own
   `signerAddress`/`signerPublicKey` is not consulted, and neither is the EIP-712 domain
   (`chainId`/`tokenNetworkAddress`) it declares for itself: both come from the connector's
   per-channel record, so a claim has no say in what it is checked against. A forger who signs
   correctly with a key of their own and declares themselves the payer is refused here, because
   that key is not the channel's counterparty.

   A claim naming a channel the connector has **no record of** is refused with its own reason,
   distinguishable from a bad signature and from an underpayment — there is nothing to verify it
   against, and unverifiable is never accepted. A node that can vouch for no channel therefore
   accepts no claim at all; that is the intended failure mode, since the only alternative is
   trusting what a claim says about itself.

   Where the record comes from is a deployment question rather than a wire one, and there are two
   sources ([issue #556](https://github.com/toon-protocol/connector/issues/556)). A node declares
   channels in its `[[client_channels]]` config section, whose entries carry the counterparty and
   the signing domain per channel; and a node with a `[settlement]` section **resolves any other
   channel from the chain that section already names**, reading the counterparty and the EIP-712
   domain off the deployed `TokenNetwork` itself. The second is what makes §1.2's anonymous path
   real: an unaffiliated buyer registers on chain, which the connector can read, rather than with
   the operator. A declared channel is authoritative and is never resolved, so a node with no
   settlement backend — or one whose chain endpoint is unreachable — still accepts claims on
   exactly the channels it wrote down.

   A resolution that **fails** — an unreachable endpoint rather than an absent channel — refuses
   the claim under a third, separate reason. It never degrades to accepting the claim, and it is
   never reported as "no such channel": an operator has to be able to tell an outage from a sender
   naming channels at random, and a legitimate payer has to be told to retry rather than told they
   do not exist. A resolution the connector **declined to perform**, because its budget for lookups
   that do not resolve is spent, is a fourth reason again — see "A lookup that resolves nothing must
   be bounded too" below.

5. **Collateral binding** — the claim's cumulative `transferredAmount` MUST NOT exceed the
   **on-chain deposit of the channel's counterparty**
   ([issue #646](https://github.com/toon-protocol/connector/issues/646)). This is not a credit
   policy a connector invents: both settlement contracts already refuse an over-deposit claim at
   redemption (`TokenNetwork.claimFromChannel` reverts `InsufficientChannelBalance`;
   `packages/solana-program`'s claim handler returns `TransferredAmountExceedsDeposit`), so a claim
   above the deposit is not value at risk — it is provably unredeemable, and serving it is work the
   operator can never be paid for. Evaluating it here makes the accept rule agree with the redeem
   rule. It is checked **after** cryptographic verification, so only a claim that is already fresh,
   value-covering and correctly signed can provoke the chain read it may need.

   The refusal is its own reason, distinguishable from an underpayment: this claim _does_ cover the
   route's price, and it consumes nothing — no watermark advances and nothing is recorded — so the
   remedy is the one both contracts already document: **deposit more and resubmit the same claim,
   at the same nonce**.

   Deposits are monotonically non-decreasing while a channel is open or closed on both chains
   (`setTotalDeposit` reverts on a decrease; the Solana `Deposit` handler only `checked_add`s), so a
   deposit a connector read earlier is a permanent _lower bound_. A connector MAY therefore cache it
   and compare against the cached value, provided a claim that breaches it triggers a fresh read
   before being refused — the bound can only ever produce a false refusal, never a false accept, and
   one re-read repairs it.

   **The exemption is deliberate.** A `[[client_channels]]` record declares a counterparty and a
   signing domain and never an amount, and a node with no settlement backend has no chain to ask, so
   a declared channel is not subject to this step. An operator hand-declaring a channel _is_ the
   credit decision, correctly located in config and theirs to make; an anonymous buyer resolved from
   chain (§1.2) never made any such deal, and gets the check.

A claim that fails any check is a validation failure and the PREPARE is rejected before it
reaches the terminating app or advances any watermark.

**A resolved channel's mutable facts expire.** The counterparty and signing domain a resolution
reports are immutable on chain, but the same resolution also asserts two things that are not — that
the channel has not `Settled`, and that its token/mint is the one this node settles in
([issue #649](https://github.com/toon-protocol/connector/issues/649)). A connector that memoises a
resolution therefore MUST re-verify it periodically, or a channel resolved while open and settled
afterwards keeps buying writes for the life of the process, with the settled-channel refusal
(step 4) silently bypassed. Re-verification and the deposit re-read above are one mechanism: a
refresh reports liveness and deposit together.

A **declared** channel is outside this too, and for the same reason it is outside the cap: config,
not the chain, is its authority, and a node with no settlement backend has no chain to ask. The
consequence is worth stating plainly rather than leaving to be discovered — an operator who both
runs a settlement backend **and** hand-declares a channel in `[[client_channels]]` gets a channel
that is exempt from the deposit cap _and_ never re-verified, so it keeps being paid on after it
settles on chain. That is the same credit decision the exemption above describes, extended in time:
declaring a channel says "I vouch for this one", and a connector cannot both take that at its word
and second-guess it. An operator who wants the chain consulted should not declare the channel — a
node with a settlement backend resolves it anyway (§1.2), which is the path both this step and the
cap apply to.

**Re-verification must not become a per-packet read.** The expiry above is a bound on staleness, and
a connector that implements it naively converts it into a bound on nothing: if a re-verification
that _fails_ leaves the entry expired and refuses the claim, then every subsequent packet on that
channel retries the same failing read, so an unreachable or rate-limited endpoint turns one read per
interval into one read per packet — a load pattern that sustains its own failure, on the endpoint
already failing. A connector MUST therefore bound the work as well as the staleness: it SHOULD serve
the last successfully-read resolution while a re-verification is failing, up to a hard staleness
ceiling past which it refuses, and it MUST NOT allow one channel to provoke unbounded lookups —
neither by arrival rate (many packets, one aged-out entry) nor by concurrency (many packets at once)
nor by resubmission (one undercollateralized claim, re-presented, which by design consumes nothing).
Serving a stale resolution is a deliberate, logged degradation, and it is bounded: it is strictly
better than refusing a paying client because a third party's endpoint is down, and the ceiling keeps
it far inside the close-challenge-settle window the expiry defends against.

The bound on work MUST hold **past the staleness ceiling too**, and this is the part that is easy to
get wrong in the direction of good intentions. Past the ceiling there is nothing left to serve, so it
reads as the moment to try hardest — but reaching it means the chain has already been failing for the
entire stale window, and a connector that waives its own rate limit there reinstates exactly the
per-packet storm described above, merely later, against an endpoint that has by then been failing for
the whole window. The claim is refused either way once nothing can be served; the only question is
whether each refusal also costs a chain read, and it must not. A connector that has to refuse SHOULD
say which refusal it is — "the chain answered and said no" is an operator's problem to fix, "I am
backing off from asking" is the same operator's endpoint already being known-bad — since the two lead
to different actions.

The three durations this implies (when a reading stops being believed, how long past that it may
still be served, and how often one channel may provoke a lookup) are a **deployment** choice, not a
protocol constant: a node on a metered or rate-limited endpoint needs them longer, and a node that
wants a settled channel noticed sooner needs the first shorter. A connector SHOULD make them
configurable and SHOULD refuse, at load, values that read as strictness but behave as a per-packet
read — a zero re-verification interval, or a zero floor on lookups per channel.

**A lookup that resolves nothing must be bounded too, and none of the above bounds it.**
Every bound in the paragraphs above is keyed to a channel the connector has resolved at least once —
it is an interval on _that entry_, a stale window measured from _that reading_. A channel that never
resolves has no entry, so a sender naming a fresh nonexistent channel id on every request provokes
one chain read per request, indefinitely
([issue #613](https://github.com/toon-protocol/connector/issues/613)). Every one of those claims is
refused, nothing is paid and nothing is delivered — which is what makes it worth doing: the sender
spends a packet, and the connector spends a unit of its own metered settlement-RPC budget, on an
anonymous request's say-so. A connector MUST therefore bound how many lookups that do not resolve it
will perform.

The bound MUST NOT be a negative cache, and this is the whole difficulty. Remembering "no such
channel" for a while is the obvious answer and it breaks the exact buyer §1.2's registration-free
path exists for — the one who opens a channel and writes a second later, whose own first attempt
would then poison the next N seconds of their own attempts. A connector MUST NOT memoise a negative
answer; the thing that is metered is the _asking_, not the answer. Three properties follow, and each
of them is a way of keeping the intended user working:

- **A lookup that resolves the channel MUST NOT count against the bound.** Otherwise a node
  onboarding real anonymous buyers throttles itself for doing the thing the path is for. Charging
  before the chain is read (which is necessary — the point is to prevent the read, not to notice
  it afterwards) and giving the charge back on a resolution satisfies this.
- **A lookup that _fails_ MAY count**, since the request was spent either way and an endpoint that
  is down must not keep being paid to say so. It MUST still be reported as an outage while there is
  allowance to discover one: the refusals a genuine outage produces are lookup failures naming the
  endpoint's own error, and only once the allowance is gone does the refusal become the budget's.
- **Exhaustion MUST be its own refusal**, distinct from both "no such channel" and "the lookup
  failed", and it SHOULD be **temporary** rather than final — nothing is wrong with the claim, and a
  sender told otherwise would stop rather than wait out the window. The three lead an operator to
  three different actions (nothing; fix the endpoint; look at who is spending the window), and a
  sender to two (this channel is wrong; retry shortly), so reporting any of them as another sends
  somebody to fix the wrong thing.

**What identity such a budget is keyed to is genuinely hard, and a connector SHOULD be honest about
what it buys.** A probe (§1.6) is budgeted per recognized channel; a lookup that does not resolve has
no recognized channel by definition. The transport source address is the obvious fallback and is
worth little: a connector deployed behind a reverse proxy sees the proxy's address, so every
anonymous buyer shares one bucket with the attacker, and the remedy — trusting a forwarded-for header
— is trusting attacker-supplied text. The claim's own declared signer is available before any lookup
and costs nothing to read, but it is **not a credential**: for EVM the EIP-712 digest needs the
channel's own domain, which is precisely what has not been resolved yet, so nothing about the
declared signer can be verified at this point without either trusting the claim's self-declared
domain (which proves only that the sender can run one `ecrecover`) or spending elliptic-curve work on
every anonymous request — trading an RPC-spend amplifier for a CPU-spend one.

A connector that budgets per declared signer therefore MUST NOT present it as a bound: a keypair is
free, so an adaptive sender declares a fresh one per request. Such a connector MUST also keep a
**node-wide** ceiling, which is the only part an adaptive sender cannot route around, and SHOULD
accept its consequence plainly — while that ceiling is spent, a genuinely new anonymous buyer's first
resolution is refused too. That consequence is bounded to _first_ resolutions: a declared channel is
never resolved and an already-resolved one is served from the memo, so nobody already paying is
affected.

One further hazard follows from the identity being unverified, and a connector SHOULD design it out
rather than document it: because anyone may declare anyone's address, a per-signer allowance enforced
unconditionally is a cheap targeted denial of service against a _known_ buyer — spend their allowance
with a handful of nonsense ids and their genuine first write is refused. That is the negative
cache's failure mode reached by another road. Enforcing the per-signer allowance only once the
node-wide window is already contended removes the aim: below contention nobody is refused for their
identity at all, and above it capacity is genuinely scarce, somebody must be refused, and the
identity that has taken the most of the window is the right one.

The allowances and their window are a **deployment** choice for the same reason the three durations
above are — what a node can afford to spend discovering channels that do not exist depends on the
settlement endpoint it pays for. A connector SHOULD make them configurable and SHOULD refuse, at
load, a zero allowance (which switches §1.2's registration-free path off entirely, silently, under a
number that reads as a tightening) and a zero window (which restarts on every request, so every
allowance is spendable in full by every request and the budget bounds nothing while appearing to be
configured).

**A watermark outlives the process.** Freshness (step 2) is only a replay defence if the watermark
it compares against survives a restart: a connector that forgets a channel's watermark compares
against nothing, and `None` accepts every nonce, so every claim the client already spent becomes
free service again ([issue
#605](https://github.com/toon-protocol/connector/issues/605)). A connector therefore MUST record
each accepted claim durably before treating it as accepted, and MUST rebuild its watermarks from
that record before serving. Two consequences follow, and both are refusals rather than degradations:
a claim whose acceptance cannot be made durable is refused (as a **temporary** error — the claim
itself is fine), and a record that cannot be read back, or that carries an entry the connector
cannot decode, stops the connector starting rather than letting it start at no watermarks. Where
the record lives is a deployment question rather than a wire one: today it is the `state_dir`
config field, and a config that configures `[[client_channels]]` without one does not load.

**Mina is not a supported chain.** [ADR 0002](../adr/0002-drop-mina-from-the-rust-connector.md)
drops Mina from the Rust connector: a Mina claim's on-chain lifecycle (open, deposit, close,
settle) has no Rust implementation and none is planned, so a connector that accepted a Mina claim
would be accepting value it can never settle. `blockchain: 'mina'` is therefore refused as a
structural validation failure (step 1 above) rather than parsed or cryptographically checked — the
zkApp-specific fields the peer wire's predecessor once carried for it (`zkAppAddress`, `tokenId`,
`balanceCommitment`, `proof`, `salt`, and the dual-party `balanceB`/`signatureB` extension) are not
part of this connector's claim shape and are not documented here. A Mina client's claim is rejected
clearly and immediately; it is not owed a code path, only an unambiguous refusal.

### 1.4 Answering an unpaid request: x402 v2 terms

An unpaid request — no claim header of either kind — addressing a route this connector both
terminates and prices is answered `402` with that route's terms instead of being routed at all
([issue #526](https://github.com/toon-protocol/connector/issues/526), [ADR
0022](../adr/0022-a-connector-answers-it-does-not-announce.md)): the app behind a priced route is
never asked to do free work for an anonymous, unpaying caller. A present claim header (valid or
not) suppresses this response unconditionally — its validation is §1.3's job, not this section's
— and an unpaid request to an unpriced or unmatched destination falls through unchanged, exactly
as it always has.

This is **answering, not announcing** ([ADR 0022](../adr/0022-a-connector-answers-it-does-not-announce.md)):
a reply to the request that asked, changing no state and reaching nobody who did not ask. [ADR
0006](../adr/0006-the-connector-is-mechanism-not-policy.md) rules out the connector pushing facts
about itself into a network unprompted — a genuine greeting, sent before anyone asked — which is
not what this is; an earlier draft of this section described the same status code as exactly that
unprompted greeting, and _that_ stays removed. [ADR
0011](../adr/0011-rejects-accumulate-fees-and-probes-discover-cost.md)'s "neither is reinstated"
was written against that same earlier, unprompted shape.

The body is an x402 v2 `PaymentRequired` document — `Content-Type: application/json` — repeated
byte-for-byte, base64-encoded, in a `Payment-Required` response header:

```json
{
  "x402Version": 2,
  "resource": { "url": "g.example.app" },
  "accepts": [
    {
      "scheme": "toon-channel",
      "network": "g.example.app",
      "amount": "100",
      "payTo": "g.example.app",
      "maxTimeoutSeconds": 60,
      "httpEndpoint": "/ilp",
      "extra": { "ilpAddress": "g.example.app", "endpoint": "/ilp", "price": "100" }
    }
  ]
}
```

`accepts` is a list — ADR 0022 notes terms are plural — but exactly one entry exists today, for
the one payment method this client edge's own claim gate (§1.3) actually understands: a TOON
payment channel claim, presented back over this same `POST /ilp`. There is no per-chain `exact`
scheme entry naming a settlement `asset`/`payTo` address, for EVM, Solana or any other chain,
because no settlement address is configured anywhere in this connector yet — answering terms
(issue #526) is a smaller, different thing from adding that configuration. `extra` is limited to
what the code actually sets — `ilpAddress`, `endpoint`, `price` — and carries nothing else.

`price` (both the top-level `amount` and `extra.price`, always equal) is read from the same
longest-prefix route lookup that §1.3's value binding and §1.7's `GET /ilp/routes/price` charge
and answer against, so this response never states a price a real request wouldn't also be charged.

### 1.5 Request-request binding (RFC 9421)

**Not yet implemented.** No `requireRequestBinding` config field, `RouteTermination` type or RFC
9421 verification exists anywhere in `crates/`; this section specifies the intended design, not
current behavior. This subsection describes what the route-**termination** feature — see
`CLAUDE.md`'s terminology note on `RouteTermination`/`checkRequestBinding` — does once it exists in
the Rust connector.

For a locally-terminated route configured with `requireRequestBinding: true`, the connector binds
the _inner_ HTTP request it will proxy to the app (the literal HTTP envelope carried verbatim in
the PREPARE's `data` field) to the claim that pays for it, using an RFC 9421 HTTP Message
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

Implemented as of [issue #548](https://github.com/toon-protocol/connector/issues/548). The
connector no longer "charges a percentage spread with no per-hop fee accumulation" — there is no
percentage anywhere ([ADR 0010](../adr/0010-flat-per-packet-fee-and-minimum-delivery.md)), and a
REJECT genuinely does accumulate cost: `connector_domain::Reject` carries an `accumulated_cost`
field that sums every hop's flat fee and adds a terminated route's price
(`docs/protocol/peer-wire-spec.md` §5.2, issues #523/#545/#584). That field is **not** part of the
RFC-0027 OER encoding — it rides beside the packet — so this edge reports it in a header. Version 1
does not change to gain it: the request/response shape below is unchanged.

**The header.** A client MAY send an ordinary PREPARE it expects to be rejected (a probe,
`CONTEXT.md` "Probe") to learn a path's cost. RFC-0027's REJECT `data` is reserved for an
application-level reject's own diagnostic payload (an `F99`/`T99`/`R99` from the terminating app),
so `accumulatedCost` MUST NOT be packed into it; instead the connector returns it as a response
header, `TOON-Accumulated-Cost` (decimal string, `uint64`), alongside the unchanged OER REJECT body
— the client-edge equivalent of the peer wire carrying the field at the frame level, beside the
packet, rather than inside it. The header is present on every REJECT response this edge answers
with, from `POST /ilp` and `POST /ilp/probe` alike, and is absent from a FULFILL. It is `0` when
nothing was traversed and nothing terminated — no route matched, or a claim was refused as
malformed, stale or unverifiable — and otherwise reports one figure: the flat fee of every hop the
packet actually reached, plus the price of the route it terminated at. Never a breakdown, and never
a fee-versus-price split; ADR 0011's "returning a sum leaks nothing" is a property of the sum
alone.

A claim refused for **underpayment** is the one refusal that reports a non-zero figure: the route's
price. That refusal's whole subject is a figure the sender did not cover, and before #548 the only
channel through which a price was ever disclosed was that reject's human-readable `message` — so a
client learned a price by underpaying first, which is precisely what cost discovery exists to
prevent.

**The probe ingress: `POST /ilp/probe`.** Same request body and same response framing as `POST
/ilp` (§1.1); what differs is the gate in front of it, and that nothing is charged. Because probing
traverses the network for free, a probe is accepted only from a sender identified by a payment
channel claim on a channel this connector recognizes, and only within a rate limit per that channel
(ADR 0011's two conditions). A sender with no such channel, or one over its probe rate limit, is
rejected at ingress with `403` (a status this subsection adds to §1.1's table, distinct from `401`:
the sender may be perfectly well authenticated and is simply not authorized to probe) without being
forwarded. A `403` carries no OER body, per §1.1's rule that a non-2xx status never does.

The claim on a probe **identifies rather than pays**: it is validated in full (§1.3's five steps)
against a price of `0`, so possession of the channel is proven and a replay is still refused, but
no value need advance — a sender probes by reissuing at the same cumulative amount with a fresh
nonce. A connector recognizes a channel once a claim on it has cleared §1.3's gate at this edge.
It necessarily already holds that channel's counterparty, whether declared or resolved from chain
— step 4 above verifies against it, so without one no claim on the channel could clear the gate at
all — but holding a counterparty says only
_whose signature is accepted here_, never that anyone has turned up and paid; no chain indexes
that, so a cleared claim is the only evidence a connector ever gets of it. This is what makes the
probe gate satisfiable by a deployed node: a sender able to pay is, by the same record, a sender
able to probe, and a gate no deployed node could pass would not be a gate.

A probe is never **delivered** to a route this connector terminates. Free traversal is the whole of
what ADR 0011 grants a probe; it does not also buy the work behind a priced route, which is what
delivering would hand over. A destination that terminates here is answered `F03` with that route's
price as `TOON-Accumulated-Cost` — the same figure a real request would be charged, and the whole
path cost, since no hop was traversed to reach it. A destination beyond this connector is routed
by the ordinary routing table, exactly as ADR 0011 requires: a probe is not a distinct packet type
and fee accumulation is not a special mode for it.

A probe reaching a **remote** termination learns that termination's price from the reject the
remote connector raises there — a terminating connector adds its route's price to the running total
([ADR 0020](../adr/0020-a-price-is-flat-and-attaches-to-a-handler.md) — a price accumulates into a
reject's running total; issues #545/#584) — with each hop on the way back adding its own fee, so
what arrives is one figure covering both. Note that this is the ordinary packet path: a probe is
gated at the client edge it enters, and the peer wire carries no probe frame, so a remote
connector cannot tell a probe from any other packet and the "never delivered to a termination"
rule above applies only to the connector the probe was submitted to.

### 1.7 Answering: identity and route price

A sender must hold the terminating connector's public key before it can seal a packet to it (§1
above; [ADR 0018](../adr/0018-a-payload-is-sealed-to-the-terminating-connector.md)), and must know a
route's price before it can construct a claim that pays for it. Both are answered directly by the
connector that terminates the route, over the same client edge a payer already speaks to it on
([ADR 0022](../adr/0022-a-connector-answers-it-does-not-announce.md)) — **answering, not announcing**: each
of the following is a reply to a request that reached this connector's own client edge, changes no
state, and is never pushed into a network unprompted.

- **`GET /ilp/identity`** — unauthenticated, no request body. Returns the uncompressed secp256k1
  public key a sender must seal a packet's payload to, plus the key id identifying it:
  ```json
  { "keyId": "...", "publicKey": "0x04..." }
  ```
  Mounted under `/ilp` rather than at the bare `/identity` because the operator surface already
  serves its own bearer-gated `GET /identity` (issue #420) for a different audience — a different
  operator-authenticated caller asking a different question — and the two routers are merged onto
  one port whenever the operator surface is enabled.
- **`GET /ilp/routes/price?destination=<ILP address>`** — unauthenticated. Returns `200` with the
  price of the locally-terminated route `destination` would match, reading the same
  longest-prefix lookup the x402 terms (§1.4) and claim value binding (§1.3) charge against, so
  this never states a price a real request wouldn't also be charged:
  ```json
  { "destination": "g.example.app", "price": 100 }
  ```
  `404` when no locally-terminated route matches `destination` — this endpoint never fabricates a
  price for a route it does not serve.

### 1.8 Sealing (issue #524)

`Prepare.data` is a gift wrap (`connector_signer::giftwrap`), not a plaintext envelope: a sender
seals a structured request envelope, plus a freshly generated shared secret, to the public key
`GET /ilp/identity` (§1.7) reports — only the connector holding the matching private key can open
it, so a forwarding hop sees opaque bytes rather than the method, target, headers or size of what
crossed it ([ADR 0018](../adr/0018-a-payload-is-sealed-to-the-terminating-connector.md)). The
terminating connector seals its answer back with that same shared secret — no second exchange — on
both `Fulfill.data` and a `Reject.data` raised at the termination; a reject raised short of the
termination (no route, expiry, a ceiling) shares no secret with the sender and stays plaintext with
empty `data`, which is how a sender tells the two apart. `accumulated_cost` is unaffected: it never
rode inside `data` to begin with (§1.6), so nothing here changes how it travels. The fulfilment a
terminating connector derives from that shared secret (ADR 0019) is likewise part of this wire.
`vectors/wire-vectors.json`'s `envelope`, `giftwrap` and `fulfilment` sections are the reproducible
bytes for all of the above — this paragraph is orientation, not the thing to conform to.

The envelope's `target` is resolved strictly _beneath_ the terminated route's own configured
handler path, never in place of it
([ADR 0025](../adr/0025-an-envelope-target-is-confined-beneath-the-handler-path.md), issue #596):
`""` and `"/"` both address the handler's own path, and any other value naming an absolute path, a
`..`/`.` segment, a scheme, an authority, or a percent-encoded equivalent of any of those is refused
(`F00`) before the app is ever called, rather than delivered. This is what keeps ADR 0020's "one
handler, one price" true in the presence of a sender-chosen `target` — a route's configured handler
is the one thing a sender's own envelope can never override.

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

`GET /ilp/versions` is unauthenticated (client-edge-facing, requiring no identity or claim) and
returns:

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
